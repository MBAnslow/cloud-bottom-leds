import type { Config, PartitionLayout } from "./config";
import { getMask, sampleMask, maskVersion } from "./mask";

/**
 * Breathing layer: the cloud is split into partitions, each with its own slow
 * "breathe" pulse and base colour. The pulse is an underlying layer that mixes
 * with whatever pattern is running and is baked into the LED colour buffer, so
 * the on-screen cloud and the streamed hardware frames stay identical.
 *
 * Partitioning is soft: every LED carries a *weight* for each partition. For
 * most layouts the weights sum to 1 (full coverage). Hard layouts use one-hot
 * weights (crisp borders); soft / overlapping layouts spread the weight so
 * partitions blend smoothly. Several spatial layouts are available (columns,
 * rows, diagonal, rings, voronoi cells, gaussian blobs).
 *
 * The "mask" layout is different: an uploaded image is placed (scaled) at a
 * different centre for each partition. The image's brightness *is* that
 * partition's weight — bright = this colour here, dark = absent, with soft
 * falloff between. Weights are NOT renormalised, so where no mask covers an LED
 * it simply doesn't breathe (the plain pattern shows through).
 */

export const MAX_PARTITIONS = 6;
export const MIN_PARTITIONS = 2;

/** Clamp the configured partition count to the supported range. */
export function partitionCount(cfg: Config): number {
  return Math.max(MIN_PARTITIONS, Math.min(MAX_PARTITIONS, Math.round(cfg.partitions)));
}

/**
 * Raw breathing waveform for a partition at time `t`, normalised to 0..1.
 * Partitions are phase-staggered so they pulse in sequence.
 */
export function breatheWave(p: number, parts: number, t: number, cfg: Config): number {
  const cyclesPerSec = cfg.breatheRate / 60;
  const phase = 2 * Math.PI * (t * cyclesPerSec - cfg.breatheStagger * (p / parts));
  return 0.5 + 0.5 * Math.sin(phase);
}

/** Brightness multiplier for a partition: in [1 - depth, 1]. */
export function breatheEnvelope(p: number, parts: number, t: number, cfg: Config): number {
  return 1 - cfg.breatheDepth + cfg.breatheDepth * breatheWave(p, parts, t, cfg);
}

function srgbToLinear(c: number): number {
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

/** Smoothstep remap of x from [lo,hi] -> [0,1]; a degenerate window is a hard step. */
function featherStep(x: number, lo: number, hi: number): number {
  if (hi <= lo + 1e-6) return x >= 0.5 ? 1 : 0;
  const t = Math.min(1, Math.max(0, (x - lo) / (hi - lo)));
  return t * t * (3 - 2 * t);
}

/** Parse "#rrggbb" into a linear-RGB triplet (0..1). */
export function hexToLinear(hex: string): [number, number, number] {
  const h = (hex || "#ffffff").replace("#", "");
  const r = parseInt(h.slice(0, 2), 16) / 255;
  const g = parseInt(h.slice(2, 4), 16) / 255;
  const b = parseInt(h.slice(4, 6), 16) / 255;
  return [srgbToLinear(r || 0), srgbToLinear(g || 0), srgbToLinear(b || 0)];
}

const linCache: Array<{ hex: string; rgb: [number, number, number] } | undefined> = [];
function cachedLinear(hex: string, idx: number): [number, number, number] {
  const c = linCache[idx];
  if (c && c.hex === hex) return c.rgb;
  const rgb = hexToLinear(hex);
  linCache[idx] = { hex, rgb };
  return rgb;
}

// --- seeded PRNG (mulberry32) for stable scatter layouts ---
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Place `parts` seed points in [0,1]^2 using best-candidate sampling so they
 * spread out sensibly. Distances are measured in aspect-corrected space so the
 * cells/blobs are well proportioned on non-square clouds.
 */
function makeSeeds(parts: number, seed: number, aspect: number): Array<{ x: number; y: number }> {
  const rng = mulberry32(seed * 2654435761 + parts * 40503 + 7);
  const pts: Array<{ x: number; y: number }> = [];
  for (let i = 0; i < parts; i++) {
    let best = { x: rng(), y: rng() };
    let bestD = -1;
    const tries = i === 0 ? 1 : 16;
    for (let k = 0; k < tries; k++) {
      const cx = rng();
      const cy = rng();
      let d = Infinity;
      for (const p of pts) {
        const dx = (cx - p.x) * aspect;
        const dy = cy - p.y;
        d = Math.min(d, dx * dx + dy * dy);
      }
      if (d > bestD) {
        bestD = d;
        best = { x: cx, y: cy };
      }
    }
    pts.push(best);
  }
  return pts;
}

/** Scalar field value (0..1) for the band-style layouts; null for point-based. */
function fieldValue(layout: PartitionLayout, u: number, v: number): number | null {
  switch (layout) {
    case "columns":
      return u;
    case "rows":
      return v;
    case "diagonal":
      return (u + v) * 0.5;
    case "rings": {
      const dx = (u - 0.5) * 2;
      const dy = (v - 0.5) * 2;
      return Math.min(1, Math.hypot(dx, dy));
    }
    default:
      return null;
  }
}

// Cache the per-LED weights; they only depend on layout/geometry, not time.
let weightCache: Float32Array | null = null;
let cacheKey = "";

function computeWeights(cfg: Config): Float32Array {
  const parts = partitionCount(cfg);
  const { rows, cols } = cfg;
  const n = rows * cols;
  const w = new Float32Array(n * parts);
  const layout = cfg.partitionLayout;
  const soft = cfg.partitionSoftness;
  const aspect = cfg.cloudWidthMm / Math.max(1, cfg.cloudHeightMm);
  const pointBased = layout === "voronoi" || layout === "gaussian" || layout === "mask";
  const seeds = pointBased ? makeSeeds(parts, cfg.partitionSeed, aspect) : [];
  const meanSpacing = Math.sqrt(aspect / parts);
  const mk = layout === "mask" ? getMask() : null;
  const mInvert = cfg.maskInvert;
  // Mask box size in normalised u,v. `maskScale` is the fraction of scene
  // *height* it spans; the width preserves the image's own aspect ratio so a
  // round mask stays round on the (non-square) cloud.
  const maskAspect = mk ? mk.w / Math.max(1, mk.h) : 1;
  const mScaleV = Math.max(0.01, cfg.maskScale);
  const mScaleU = (mScaleV * maskAspect) / aspect;
  // "overlap (soft edges)" feathers the mask edge: soft 0 = hard threshold at
  // 0.5, soft 1 = the full gradient. Wider window => softer / more overlap.
  const featherLo = 0.5 - soft * 0.5;
  const featherHi = 0.5 + soft * 0.5;

  for (let r = 0; r < rows; r++) {
    const v = rows > 1 ? r / (rows - 1) : 0.5;
    for (let c = 0; c < cols; c++) {
      const u = cols > 1 ? c / (cols - 1) : 0.5;
      const wb = (r * cols + c) * parts;
      let sum = 0;

      if (layout === "gaussian") {
        // overlapping gaussian blobs — soft by nature even at softness 0
        const sigma = meanSpacing * (0.42 + 0.9 * soft);
        const inv = 1 / (2 * sigma * sigma);
        for (let p = 0; p < parts; p++) {
          const dx = (u - seeds[p].x) * aspect;
          const dy = v - seeds[p].y;
          const wp = Math.exp(-(dx * dx + dy * dy) * inv);
          w[wb + p] = wp;
          sum += wp;
        }
      } else if (layout === "voronoi") {
        if (soft <= 0.0001) {
          let bp = 0;
          let bd = Infinity;
          for (let p = 0; p < parts; p++) {
            const dx = (u - seeds[p].x) * aspect;
            const dy = v - seeds[p].y;
            const d = dx * dx + dy * dy;
            if (d < bd) {
              bd = d;
              bp = p;
            }
          }
          w[wb + bp] = 1;
          sum = 1;
        } else {
          // soft voronoi: softmax over negative distance
          const temp = meanSpacing * (0.5 * soft);
          let minD = Infinity;
          const ds: number[] = [];
          for (let p = 0; p < parts; p++) {
            const dx = (u - seeds[p].x) * aspect;
            const dy = v - seeds[p].y;
            const d = Math.sqrt(dx * dx + dy * dy);
            ds.push(d);
            if (d < minD) minD = d;
          }
          for (let p = 0; p < parts; p++) {
            const wp = Math.exp(-(ds[p] - minD) / temp);
            w[wb + p] = wp;
            sum += wp;
          }
        }
      } else if (layout === "mask") {
        // Each partition places the (scaled) mask image at its own centre; the
        // image brightness is that partition's weight. Raw, not renormalised.
        if (!mk) {
          // no image yet -> fall back to columns so it isn't blank
          const bp = Math.min(parts - 1, Math.max(0, Math.round(u * parts - 0.5)));
          w[wb + bp] = 1;
          sum = 1;
        } else {
          for (let p = 0; p < parts; p++) {
            const mu = 0.5 + (u - seeds[p].x) / mScaleU;
            const mv = 0.5 + (v - seeds[p].y) / mScaleV;
            let val = 0;
            if (mu >= 0 && mu <= 1 && mv >= 0 && mv <= 1) {
              val = sampleMask(mk, mu, mv);
              if (mInvert) val = 1 - val;
              val = featherStep(val, featherLo, featherHi);
            }
            w[wb + p] = val;
          }
          // sum stays 0 -> skip normalisation below (coverage is meaningful)
          sum = -1;
        }
      } else {
        // band layouts driven by a scalar field
        const s = fieldValue(layout, u, v) as number;
        if (soft <= 0.0001) {
          const bp = Math.min(parts - 1, Math.max(0, Math.round(s * parts - 0.5)));
          w[wb + bp] = 1;
          sum = 1;
        } else {
          const sigma = (1 / parts) * (0.25 + soft);
          const inv = 1 / (2 * sigma * sigma);
          for (let p = 0; p < parts; p++) {
            const cp = (p + 0.5) / parts;
            const dd = s - cp;
            const wp = Math.exp(-dd * dd * inv);
            w[wb + p] = wp;
            sum += wp;
          }
        }
      }

      if (sum < 0) {
        // mask layout: keep raw weights (coverage encodes "breathes or not")
      } else if (sum > 1e-9) {
        const inv = 1 / sum;
        for (let p = 0; p < parts; p++) w[wb + p] *= inv;
      } else {
        w[wb] = 1;
      }
    }
  }

  return w;
}

/** Per-LED partition weights (cached; recomputed only when the layout changes). */
export function partitionWeights(cfg: Config): Float32Array {
  const parts = partitionCount(cfg);
  const aspect = Math.round((cfg.cloudWidthMm / Math.max(1, cfg.cloudHeightMm)) * 100);
  const key =
    `${cfg.partitionLayout}|${parts}|${cfg.cols}|${cfg.rows}|${cfg.partitionSoftness}|` +
    `${cfg.partitionSeed}|${aspect}|${cfg.maskScale}|${cfg.maskInvert}|${maskVersion()}`;
  if (key !== cacheKey || !weightCache) {
    weightCache = computeWeights(cfg);
    cacheKey = key;
  }
  return weightCache;
}

/**
 * The per-partition centres (in normalised u,v) for the scatter-based layouts
 * (mask, voronoi, gaussian). Returns null for the band layouts. Used by the
 * mask overlay so it lines up with `computeWeights`.
 */
export function partitionCenters(cfg: Config): Array<{ x: number; y: number }> | null {
  const layout = cfg.partitionLayout;
  if (layout !== "mask" && layout !== "voronoi" && layout !== "gaussian") return null;
  const parts = partitionCount(cfg);
  const aspect = cfg.cloudWidthMm / Math.max(1, cfg.cloudHeightMm);
  return makeSeeds(parts, cfg.partitionSeed, aspect);
}

function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

export type BlendFn = (backdrop: number, src: number) => number;

/**
 * Per-channel blend function for a blend mode (linear RGB). The "backdrop" is
 * the pattern layer, "src" is the breathing layer. Modes mirror the standard
 * graphics-software layer blend modes.
 */
export function blendFn(mode: Config["breatheBlend"]): BlendFn {
  switch (mode) {
    case "additive":
      return (p, b) => p + b; // linear dodge — adds light, can exceed 1 (glow)
    case "multiply":
      return (p, b) => p * b;
    case "screen":
      return (p, b) => 1 - (1 - clamp01(p)) * (1 - clamp01(b));
    case "lighten":
      return (p, b) => Math.max(p, b);
    case "darken":
      return (p, b) => Math.min(p, b);
    case "overlay":
      return (p, b) => {
        const P = clamp01(p);
        const B = clamp01(b);
        return P < 0.5 ? 2 * P * B : 1 - 2 * (1 - P) * (1 - B);
      };
    case "softLight":
      return (p, b) => {
        const P = clamp01(p);
        const B = clamp01(b);
        return (1 - 2 * B) * P * P + 2 * B * P; // Pegtop
      };
    case "difference":
      return (p, b) => Math.abs(p - b);
    case "normal":
    default:
      return (_p, b) => b;
  }
}

/**
 * Composite the per-partition breathing layer onto the LED colour buffer, in
 * place. The buffer already holds the pattern (the backdrop); the breathing
 * layer is each partition's base colour scaled by its (pulsing) envelope. The
 * two are combined with `breatheBlend` (normal / additive / multiply / …) and
 * the breathing layer's opacity is `breatheMix` × coverage. Coverage is the
 * per-LED total weight: where it is < 1 (e.g. outside the masks in the mask
 * layout) the breathing fades out and the pattern shows through.
 * Linear RGB, row-major (row * cols + col).
 */
export function applyBreathing(out: Float32Array, t: number, cfg: Config) {
  if (!cfg.breatheEnabled) return;
  const { rows, cols } = cfg;
  const parts = partitionCount(cfg);
  const mix = cfg.breatheMix;
  const W = partitionWeights(cfg);
  const blend = blendFn(cfg.breatheBlend);

  const env = new Array<number>(parts);
  const bR = new Array<number>(parts);
  const bG = new Array<number>(parts);
  const bB = new Array<number>(parts);
  for (let p = 0; p < parts; p++) {
    env[p] = breatheEnvelope(p, parts, t, cfg);
    const b = cachedLinear(cfg.breatheColors[p] ?? "#ffffff", p);
    bR[p] = b[0];
    bG[p] = b[1];
    bB[p] = b[2];
  }

  const osc = cfg.partitionBlend;
  const n = rows * cols;
  for (let i = 0; i < n; i++) {
    const wb = i * parts;
    // Accumulate every partition's contribution (its base colour pulsed by its
    // own envelope, weighted by membership) under all the oscillator-blend
    // strategies at once, then pick the configured one.
    let total = 0;
    let addR = 0;
    let addG = 0;
    let addB = 0; // sum  (additive / average)
    let maxR = 0;
    let maxG = 0;
    let maxB = 0; // max  (lighten)
    let scrR = 1;
    let scrG = 1;
    let scrB = 1; // product of (1-x)  (screen)
    for (let p = 0; p < parts; p++) {
      const wp = W[wb + p];
      if (wp === 0) continue;
      total += wp;
      const ep = env[p];
      const xr = wp * bR[p] * ep;
      const xg = wp * bG[p] * ep;
      const xb = wp * bB[p] * ep;
      addR += xr;
      addG += xg;
      addB += xb;
      if (xr > maxR) maxR = xr;
      if (xg > maxG) maxG = xg;
      if (xb > maxB) maxB = xb;
      scrR *= 1 - clamp01(xr);
      scrG *= 1 - clamp01(xg);
      scrB *= 1 - clamp01(xb);
    }
    if (total <= 1e-6) continue; // no breathing here -> leave the pattern

    let srcR: number;
    let srcG: number;
    let srcB: number;
    if (osc === "additive") {
      srcR = addR;
      srcG = addG;
      srcB = addB;
    } else if (osc === "lighten") {
      srcR = maxR;
      srcG = maxG;
      srcB = maxB;
    } else if (osc === "screen") {
      srcR = 1 - scrR;
      srcG = 1 - scrG;
      srcB = 1 - scrB;
    } else {
      // average: weighted mean of the contributions
      const inv = 1 / total;
      srcR = addR * inv;
      srcG = addG * inv;
      srcB = addB * inv;
    }

    // Opacity of the whole breathing layer over the pattern (its strength ×
    // mask coverage, clamped to 1).
    const cover = total < 1 ? total : 1;
    const alpha = mix * cover;

    const o = i * 3;
    const pr = out[o];
    const pg = out[o + 1];
    const pb = out[o + 2];

    out[o] = pr + (blend(pr, srcR) - pr) * alpha;
    out[o + 1] = pg + (blend(pg, srcG) - pg) * alpha;
    out[o + 2] = pb + (blend(pb, srcB) - pb) * alpha;
  }
}

/**
 * Preview a single partition's breathing contribution in isolation: pattern off
 * and all other partitions off. Writes weight * base-colour * envelope into the
 * buffer (linear RGB), so you can see exactly where and how strongly one
 * partition breathes.
 */
export function renderPartitionSolo(out: Float32Array, t: number, cfg: Config, index: number) {
  const { rows, cols } = cfg;
  const parts = partitionCount(cfg);
  const p = Math.max(0, Math.min(parts - 1, index));
  const W = partitionWeights(cfg);
  const env = breatheEnvelope(p, parts, t, cfg);
  const [br, bg, bb] = hexToLinear(cfg.breatheColors[p] ?? "#ffffff");

  const n = rows * cols;
  for (let i = 0; i < n; i++) {
    const wp = Math.min(1, W[i * parts + p]);
    const k = wp * env;
    const o = i * 3;
    out[o] = br * k;
    out[o + 1] = bg * k;
    out[o + 2] = bb * k;
  }
}
