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
export const MIN_PARTITIONS = 1;

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

type Center = { x: number; y: number };

// Per-layout user overrides for centroid positions (persist while app is open).
const manualCenters: Partial<Record<PartitionLayout, Center[]>> = {};

function defaultCenters(
  layout: PartitionLayout,
  parts: number,
  seed: number,
  aspect: number
): Center[] {
  if (layout === "voronoi" || layout === "gaussian" || layout === "mask") {
    return makeSeeds(parts, seed, aspect);
  }
  const out: Center[] = [];
  for (let p = 0; p < parts; p++) {
    const t = (p + 0.5) / parts;
    switch (layout) {
      case "columns":
        out.push({ x: t, y: 0.5 });
        break;
      case "rows":
        out.push({ x: 0.5, y: t });
        break;
      case "diagonal":
        out.push({ x: t, y: t });
        break;
      case "rings":
        out.push({ x: 0.5 + t * 0.5, y: 0.5 });
        break;
      default:
        out.push({ x: 0.5, y: 0.5 });
        break;
    }
  }
  return out;
}

function effectiveCenters(cfg: Config): Center[] {
  const parts = partitionCount(cfg);
  const layout = cfg.partitionLayout;
  const aspect = cfg.cloudWidthMm / Math.max(1, cfg.cloudHeightMm);
  const base = defaultCenters(layout, parts, cfg.partitionSeed, aspect);
  const manual = manualCenters[layout];
  if (!manual || manual.length === 0) return base;
  const out: Center[] = new Array(parts);
  for (let p = 0; p < parts; p++) {
    const m = manual[p];
    const b = base[p];
    out[p] = {
      x: clamp01(m?.x ?? b.x),
      y: clamp01(m?.y ?? b.y),
    };
  }
  return out;
}

/** Distance to a partition centre for the band-style layouts. */
function bandDistance(layout: PartitionLayout, u: number, v: number, c: Center): number {
  switch (layout) {
    case "columns":
      return Math.abs(u - c.x);
    case "rows":
      return Math.abs(v - c.y);
    case "diagonal":
      return Math.abs((u + v) * 0.5 - (c.x + c.y) * 0.5);
    case "rings": {
      const ru = Math.min(1, Math.hypot((u - 0.5) * 2, (v - 0.5) * 2));
      const rc = Math.min(1, Math.hypot((c.x - 0.5) * 2, (c.y - 0.5) * 2));
      return Math.abs(ru - rc);
    }
    default:
      return Infinity;
  }
}

/** Move one partition centroid in the current layout (normalised 0..1). */
export function setPartitionCenter(cfg: Config, index: number, x: number, y: number): void {
  const parts = partitionCount(cfg);
  if (index < 0 || index >= parts) return;
  const layout = cfg.partitionLayout;
  const pts = effectiveCenters(cfg);
  pts[index] = { x: clamp01(x), y: clamp01(y) };
  manualCenters[layout] = pts;
  // Invalidate cached per-LED weights immediately.
  weightCache = null;
  cacheKey = "";
}

/** Clear user centroid overrides (current layout or all layouts). */
export function clearPartitionCenters(layout?: PartitionLayout): void {
  if (layout) {
    delete manualCenters[layout];
  } else {
    for (const k of Object.keys(manualCenters) as PartitionLayout[]) delete manualCenters[k];
  }
  weightCache = null;
  cacheKey = "";
}

function maskRotationOffsets(cfg: Config): number[] {
  const parts = partitionCount(cfg);
  // Stable pseudo-random offsets derived from the partition seed, so "reshuffle"
  // gives new starts while a fixed seed/layout stays repeatable.
  const rng = mulberry32((cfg.partitionSeed ^ 0x9e3779b9) + parts * 131);
  const out = new Array<number>(parts);
  for (let p = 0; p < parts; p++) out[p] = rng() * Math.PI * 2;
  return out;
}

/** Current mask rotation angle in radians for one partition. */
export function maskRotationRad(cfg: Config, t: number, partition: number = 0): number {
  if (!cfg.maskRotate) return 0;
  const parts = partitionCount(cfg);
  const p = ((Math.round(partition) % parts) + parts) % parts;
  const deg = (cfg.maskRotateDegPerMin * t) / 60;
  const base = (deg * Math.PI) / 180;
  return base + maskRotationOffsets(cfg)[p];
}

// Cache the per-LED weights; they only depend on layout/geometry, not time.
let weightCache: Float32Array | null = null;
let cacheKey = "";

function computeWeights(cfg: Config, t: number): Float32Array {
  const parts = partitionCount(cfg);
  const { rows, cols } = cfg;
  const n = rows * cols;
  const w = new Float32Array(n * parts);
  const layout = cfg.partitionLayout;
  const soft = cfg.partitionSoftness;
  const aspect = cfg.cloudWidthMm / Math.max(1, cfg.cloudHeightMm);
  const centers = effectiveCenters(cfg);
  const meanSpacing = Math.sqrt(aspect / parts);
  const mk = layout === "mask" ? getMask() : null;
  const mInvert = cfg.maskInvert;
  // Mask box size in normalised u,v. `maskScale` is the fraction of scene
  // *height* it spans; the width preserves the image's own aspect ratio so a
  // round mask stays round on the (non-square) cloud.
  const maskAspect = mk ? mk.w / Math.max(1, mk.h) : 1;
  const mScaleV = Math.max(0.01, cfg.maskScale);
  const mScaleU = (mScaleV * maskAspect) / aspect;
  const maskCos = new Array<number>(parts);
  const maskSin = new Array<number>(parts);
  for (let p = 0; p < parts; p++) {
    const a = layout === "mask" ? maskRotationRad(cfg, t, p) : 0;
    maskCos[p] = Math.cos(a);
    maskSin[p] = Math.sin(a);
  }
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
          const dx = (u - centers[p].x) * aspect;
          const dy = v - centers[p].y;
          const wp = Math.exp(-(dx * dx + dy * dy) * inv);
          w[wb + p] = wp;
          sum += wp;
        }
      } else if (layout === "voronoi") {
        if (soft <= 0.0001) {
          let bp = 0;
          let bd = Infinity;
          for (let p = 0; p < parts; p++) {
            const dx = (u - centers[p].x) * aspect;
            const dy = v - centers[p].y;
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
            const dx = (u - centers[p].x) * aspect;
            const dy = v - centers[p].y;
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
            const du = (u - centers[p].x) / mScaleU;
            const dv = (v - centers[p].y) / mScaleV;
            // Inverse-rotate the sample point to rotate the mask around its
            // partition centre in world space.
            const ru = du * maskCos[p] + dv * maskSin[p];
            const rv = -du * maskSin[p] + dv * maskCos[p];
            const mu = 0.5 + ru;
            const mv = 0.5 + rv;
            let val = 0;
            if (mu >= 0 && mu <= 1 && mv >= 0 && mv <= 1) {
              val = sampleMask(mk, mu, mv);
              if (mInvert) val = 1 - val;
              // Preserve mask luminance as a continuous signal:
              // dark = weak breathing, bright = strong breathing.
              val = clamp01(val);
            }
            w[wb + p] = val;
          }
          // sum stays 0 -> skip normalisation below (coverage is meaningful)
          sum = -1;
        }
      } else {
        // band layouts driven by distances to draggable layout centroids
        if (soft <= 0.0001) {
          let bp = 0;
          let bd = Infinity;
          for (let p = 0; p < parts; p++) {
            const d = bandDistance(layout, u, v, centers[p]);
            if (d < bd) {
              bd = d;
              bp = p;
            }
          }
          w[wb + bp] = 1;
          sum = 1;
        } else {
          const sigma = (1 / parts) * (0.25 + soft);
          const inv = 1 / (2 * sigma * sigma);
          for (let p = 0; p < parts; p++) {
            const d = bandDistance(layout, u, v, centers[p]);
            const wp = Math.exp(-d * d * inv);
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
export function partitionWeights(cfg: Config, t: number = 0): Float32Array {
  const parts = partitionCount(cfg);
  const aspect = Math.round((cfg.cloudWidthMm / Math.max(1, cfg.cloudHeightMm)) * 100);
  const ctrs = partitionCenters(cfg);
  const centerKey = ctrs.map((c) => `${c.x.toFixed(4)},${c.y.toFixed(4)}`).join(";");
  const rotKey =
    cfg.partitionLayout === "mask" && cfg.maskRotate ? maskRotationRad(cfg, t, 0).toFixed(4) : "0";
  const key =
    `${cfg.partitionLayout}|${parts}|${cfg.cols}|${cfg.rows}|${cfg.partitionSoftness}|` +
    `${cfg.partitionSeed}|${aspect}|${cfg.maskScale}|${cfg.maskInvert}|${maskVersion()}|` +
    `${centerKey}|${rotKey}`;
  if (key !== cacheKey || !weightCache) {
    weightCache = computeWeights(cfg, t);
    cacheKey = key;
  }
  return weightCache;
}

/**
 * Per-partition centres (normalised u,v) for the current layout. For scatter
 * layouts these are the cell/blob seeds; for band layouts they are the draggable
 * centroids used to place each partition's influence.
 */
export function partitionCenters(cfg: Config): Array<{ x: number; y: number }> {
  return effectiveCenters(cfg);
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
  const usePatternBase = cfg.patternEnabled;
  const parts = partitionCount(cfg);
  // Breathing opacity is fixed to 1 by design.
  const mix = 1;
  const W = partitionWeights(cfg, t);
  // If pattern is disabled, there is no meaningful backdrop layer to apply
  // blend modes against; force a normal breathing mix so min colour/brightness
  // behave as intuitive trough/peak endpoints over a white base.
  const mode = usePatternBase ? cfg.breatheBlend : "normal";
  const blend = blendFn(mode);

  const env = new Array<number>(parts);
  const wave = new Array<number>(parts);
  const bR = new Array<number>(parts);
  const bG = new Array<number>(parts);
  const bB = new Array<number>(parts);
  for (let p = 0; p < parts; p++) {
    wave[p] = breatheWave(p, parts, t, cfg);
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
    if (mode === "normal") {
      // Requested behaviour:
      // - as a partition breathes IN, shift from base -> partition chroma
      // - at full IN, return to normal brightness
      // - as it breathes OUT, reduce local brightness
      let cover = 0;
      let waveDrive = 0;
      let addR = 0;
      let addG = 0;
      let addB = 0;
      let maxR = 0;
      let maxG = 0;
      let maxB = 0;
      let scrR = 1;
      let scrG = 1;
      let scrB = 1;
      let mulR = 1;
      let mulG = 1;
      let mulB = 1;
      let minR = 1;
      let minG = 1;
      let minB = 1;
      let difR = 0;
      let difG = 0;
      let difB = 0;
      let first = true;
      let nMulR = 0;
      let nMulG = 0;
      let nMulB = 0;
      let nMinR = 0;
      let nMinG = 0;
      let nMinB = 0;
      const EPS = 1e-3;
      for (let p = 0; p < parts; p++) {
        const wp = W[wb + p];
        if (wp === 0) continue;
        cover += wp;
        const wv = wave[p];
        waveDrive += wp * wv;
        // Build the region chroma independent from the instantaneous wave, then
        // drive how much of it is applied with an explicit 0..1 amount below.
        const xr = wp * bR[p];
        const xg = wp * bG[p];
        const xb = wp * bB[p];
        addR += xr;
        addG += xg;
        addB += xb;
        if (xr > maxR) maxR = xr;
        if (xg > maxG) maxG = xg;
        if (xb > maxB) maxB = xb;
        const cr = clamp01(xr);
        const cg = clamp01(xg);
        const cb = clamp01(xb);
        scrR *= 1 - cr;
        scrG *= 1 - cg;
        scrB *= 1 - cb;
        if (cr > EPS) {
          mulR *= cr;
          nMulR++;
          if (cr < minR) minR = cr;
          nMinR++;
        }
        if (cg > EPS) {
          mulG *= cg;
          nMulG++;
          if (cg < minG) minG = cg;
          nMinG++;
        }
        if (cb > EPS) {
          mulB *= cb;
          nMulB++;
          if (cb < minB) minB = cb;
          nMinB++;
        }
        if (first) {
          difR = cr;
          difG = cg;
          difB = cb;
          first = false;
        } else {
          difR = Math.abs(difR - cr);
          difG = Math.abs(difG - cg);
          difB = Math.abs(difB - cb);
        }
      }
      if (cover <= 1e-6) continue;

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
      } else if (osc === "multiply") {
        srcR = nMulR > 0 ? Math.pow(mulR, 1 / nMulR) : 0;
        srcG = nMulG > 0 ? Math.pow(mulG, 1 / nMulG) : 0;
        srcB = nMulB > 0 ? Math.pow(mulB, 1 / nMulB) : 0;
      } else if (osc === "darken") {
        srcR = nMinR > 0 ? minR : 0;
        srcG = nMinG > 0 ? minG : 0;
        srcB = nMinB > 0 ? minB : 0;
      } else if (osc === "difference") {
        srcR = difR;
        srcG = difG;
        srcB = difB;
      } else {
        const inv = cover > 1e-6 ? 1 / cover : 0;
        srcR = addR * inv;
        srcG = addG * inv;
        srcB = addB * inv;
      }

      const waveNorm = clamp01(waveDrive / cover); // 0..1 trough->peak in this region
      const minBright = clamp01(cfg.breatheMinBrightness);
      const minColor = clamp01(cfg.breatheMinColor);
      // `breatheDepth` scales how aggressive the oscillation is, by pulling the
      // effective trough back toward the peak (1.0). depth=1 means the trough
      // sits at the user's mins; depth=0 means no oscillation at all.
      const effMinColor = 1 - cfg.breatheDepth * (1 - minColor);
      const effMinBright = 1 - cfg.breatheDepth * (1 - minBright);
      // True mix ratio of breath chroma over pattern.
      const colorAmt = effMinColor + (1 - effMinColor) * waveNorm;
      // True brightness multiplier on the mix.
      const brightAmt = effMinBright + (1 - effMinBright) * waveNorm;
      const o = i * 3;
      const pr = usePatternBase ? out[o] : 1;
      const pg = usePatternBase ? out[o + 1] : 1;
      const pb = usePatternBase ? out[o + 2] : 1;
      // Mix pattern and breath colour, then dim by brightness.
      const resR = (pr * (1 - colorAmt) + srcR * colorAmt) * brightAmt;
      const resG = (pg * (1 - colorAmt) + srcG * colorAmt) * brightAmt;
      const resB = (pb * (1 - colorAmt) + srcB * colorAmt) * brightAmt;
      // Envelope: how strongly this breathing region replaces the pattern.
      // Separate from the min sliders by design.
      const envelope = clamp01(mix * Math.min(1, cover));
      out[o] = pr + (resR - pr) * envelope;
      out[o + 1] = pg + (resG - pg) * envelope;
      out[o + 2] = pb + (resB - pb) * envelope;
      continue;
    }

    // Accumulate every partition's contribution (its base colour pulsed by its
    // own envelope, weighted by membership) under all oscillator-blend
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
    let mulR = 1;
    let mulG = 1;
    let mulB = 1; // product x*x...      (multiply)
    let minR = 1;
    let minG = 1;
    let minB = 1; // min of layers       (darken)
    let difR = 0;
    let difG = 0;
    let difB = 0; // iterative |a-b|     (difference)
    let first = true;
    let nMulR = 0;
    let nMulG = 0;
    let nMulB = 0;
    let nMinR = 0;
    let nMinG = 0;
    let nMinB = 0;
    let waveSum = 0;
    const EPS = 1e-3;
    for (let p = 0; p < parts; p++) {
      const wp = W[wb + p];
      if (wp === 0) continue;
      total += wp;
      waveSum += wp * wave[p];
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
      const cr = clamp01(xr);
      const cg = clamp01(xg);
      const cb = clamp01(xb);
      scrR *= 1 - cr;
      scrG *= 1 - cg;
      scrB *= 1 - cb;
      if (cr > EPS) {
        mulR *= cr;
        nMulR++;
        if (cr < minR) minR = cr;
        nMinR++;
      }
      if (cg > EPS) {
        mulG *= cg;
        nMulG++;
        if (cg < minG) minG = cg;
        nMinG++;
      }
      if (cb > EPS) {
        mulB *= cb;
        nMulB++;
        if (cb < minB) minB = cb;
        nMinB++;
      }
      if (first) {
        difR = cr;
        difG = cg;
        difB = cb;
        first = false;
      } else {
        difR = Math.abs(difR - cr);
        difG = Math.abs(difG - cg);
        difB = Math.abs(difB - cb);
      }
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
    } else if (osc === "multiply") {
      // Geometric mean of meaningful contributors so tiny overlap tails don't
      // collapse the result to black.
      srcR = nMulR > 0 ? Math.pow(mulR, 1 / nMulR) : 0;
      srcG = nMulG > 0 ? Math.pow(mulG, 1 / nMulG) : 0;
      srcB = nMulB > 0 ? Math.pow(mulB, 1 / nMulB) : 0;
    } else if (osc === "darken") {
      srcR = nMinR > 0 ? minR : 0;
      srcG = nMinG > 0 ? minG : 0;
      srcB = nMinB > 0 ? minB : 0;
    } else if (osc === "difference") {
      srcR = difR;
      srcG = difG;
      srcB = difB;
    } else {
      // average: weighted mean of the contributions
      const inv = 1 / total;
      srcR = addR * inv;
      srcG = addG * inv;
      srcB = addB * inv;
    }

    // Region descriptors used by colour mix and brightness floor.
    const cover = total < 1 ? total : 1;
    const waveNorm = clamp01(waveSum / total); // 0..1 trough->peak in this region
    const minColor = clamp01(cfg.breatheMinColor);
    const minBright = clamp01(cfg.breatheMinBrightness);
    // breatheDepth scales how aggressive the oscillation is (see normal path).
    const effMinColor = 1 - cfg.breatheDepth * (1 - minColor);
    const effMinBright = 1 - cfg.breatheDepth * (1 - minBright);
    const colorAmt = effMinColor + (1 - effMinColor) * waveNorm;
    const brightAmt = effMinBright + (1 - effMinBright) * waveNorm;

    const o = i * 3;
    const pr = usePatternBase ? out[o] : 1;
    const pg = usePatternBase ? out[o + 1] : 1;
    const pb = usePatternBase ? out[o + 2] : 1;
    // Target colour: pattern combined with breath chroma via the chosen blend.
    let tR: number;
    let tG: number;
    let tB: number;
    if (mode === "multiply") {
      const presence = clamp01((Math.max(pr, pg, pb) - 0.02) / 0.35);
      tR = srcR + (pr * srcR - srcR) * presence;
      tG = srcG + (pg * srcG - srcG) * presence;
      tB = srcB + (pb * srcB - srcB) * presence;
    } else {
      tR = blend(pr, srcR);
      tG = blend(pg, srcG);
      tB = blend(pb, srcB);
    }
    // True mix of pattern and target via colorAmt, then dim with brightAmt.
    const resR = (pr * (1 - colorAmt) + tR * colorAmt) * brightAmt;
    const resG = (pg * (1 - colorAmt) + tG * colorAmt) * brightAmt;
    const resB = (pb * (1 - colorAmt) + tB * colorAmt) * brightAmt;
    // Envelope = breathing layer's regional opacity (independent of mins).
    const envelope = clamp01(mix * cover);
    out[o] = pr + (resR - pr) * envelope;
    out[o + 1] = pg + (resG - pg) * envelope;
    out[o + 2] = pb + (resB - pb) * envelope;
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
  const W = partitionWeights(cfg, t);
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
