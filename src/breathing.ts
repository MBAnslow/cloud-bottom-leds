import type { Config, PartitionLayout } from "./config";

/**
 * Breathing layer: the cloud is split into partitions, each with its own slow
 * "breathe" pulse and base colour. The pulse is an underlying layer that mixes
 * with whatever pattern is running and is baked into the LED colour buffer, so
 * the on-screen cloud and the streamed hardware frames stay identical.
 *
 * Partitioning is soft: every LED carries a *weight* for each partition (the
 * weights sum to 1). Hard layouts use one-hot weights (crisp borders); soft /
 * overlapping layouts spread the weight so partitions blend smoothly with no
 * hard edges. Several spatial layouts are available (columns, rows, diagonal,
 * rings, voronoi cells, gaussian blobs).
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
  const pointBased = layout === "voronoi" || layout === "gaussian";
  const seeds = pointBased ? makeSeeds(parts, cfg.partitionSeed, aspect) : [];
  const meanSpacing = Math.sqrt(aspect / parts);

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

      if (sum > 1e-9) {
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
  const key = `${cfg.partitionLayout}|${parts}|${cfg.cols}|${cfg.rows}|${cfg.partitionSoftness}|${cfg.partitionSeed}|${aspect}`;
  if (key !== cacheKey || !weightCache) {
    weightCache = computeWeights(cfg);
    cacheKey = key;
  }
  return weightCache;
}

/**
 * Apply the per-partition breathing layer onto the LED colour buffer, in place.
 * Each LED is a weighted blend of the partitions it belongs to: blend toward
 * the (weighted) base colour by `breatheMix`, then scale by the (weighted)
 * breathing envelope so it pulses. Linear RGB, row-major (row * cols + col).
 */
export function applyBreathing(out: Float32Array, t: number, cfg: Config) {
  if (!cfg.breatheEnabled) return;
  const { rows, cols } = cfg;
  const parts = partitionCount(cfg);
  const mix = cfg.breatheMix;
  const W = partitionWeights(cfg);

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

  const n = rows * cols;
  for (let i = 0; i < n; i++) {
    const wb = i * parts;
    let e = 0;
    let cr = 0;
    let cg = 0;
    let cb = 0;
    for (let p = 0; p < parts; p++) {
      const wp = W[wb + p];
      if (wp === 0) continue;
      e += wp * env[p];
      cr += wp * bR[p];
      cg += wp * bG[p];
      cb += wp * bB[p];
    }
    const o = i * 3;
    out[o] = (out[o] * (1 - mix) + cr * mix) * e;
    out[o + 1] = (out[o + 1] * (1 - mix) + cg * mix) * e;
    out[o + 2] = (out[o + 2] * (1 - mix) + cb * mix) * e;
  }
}
