import type { Config } from "./config";

/**
 * Breathing layer: the cloud is split into vertical partitions, each with its
 * own slow "breathe" pulse and base colour. This pulse is an underlying layer
 * that mixes with whatever pattern is running — it is baked into the LED colour
 * buffer so the on-screen cloud and the streamed hardware frames stay identical.
 */

export const MAX_PARTITIONS = 6;
export const MIN_PARTITIONS = 2;

/** Clamp the configured partition count to the supported range. */
export function partitionCount(cfg: Config): number {
  return Math.max(MIN_PARTITIONS, Math.min(MAX_PARTITIONS, Math.round(cfg.partitions)));
}

/** Which partition (0..parts-1) a given column falls into. */
export function partitionOf(col: number, cols: number, parts: number): number {
  const f = cols > 0 ? (col + 0.5) / cols : 0;
  return Math.min(parts - 1, Math.max(0, Math.floor(f * parts)));
}

/**
 * Raw breathing waveform for a partition at time `t`, normalised to 0..1.
 * Partitions are phase-staggered so they pulse in sequence.
 */
export function breatheWave(p: number, parts: number, t: number, cfg: Config): number {
  const cyclesPerSec = cfg.breatheRate / 60;
  const phase =
    2 * Math.PI * (t * cyclesPerSec - cfg.breatheStagger * (p / parts));
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

// small cache so we don't re-parse hex strings every frame
const linCache: Array<{ hex: string; rgb: [number, number, number] } | undefined> = [];
function cachedLinear(hex: string, idx: number): [number, number, number] {
  const c = linCache[idx];
  if (c && c.hex === hex) return c.rgb;
  const rgb = hexToLinear(hex);
  linCache[idx] = { hex, rgb };
  return rgb;
}

/**
 * Apply the per-partition breathing layer onto the LED colour buffer, in place.
 * For each partition: blend the pattern colour toward the partition's base
 * colour (by `breatheMix`), then scale the whole thing by the breathing
 * envelope so it pulses. Operates on linear RGB, row-major (row * cols + col).
 */
export function applyBreathing(out: Float32Array, t: number, cfg: Config) {
  if (!cfg.breatheEnabled) return;
  const { rows, cols } = cfg;
  const parts = partitionCount(cfg);
  const mix = cfg.breatheMix;

  const env: number[] = new Array(parts);
  const base: Array<[number, number, number]> = new Array(parts);
  for (let p = 0; p < parts; p++) {
    env[p] = breatheEnvelope(p, parts, t, cfg);
    base[p] = cachedLinear(cfg.breatheColors[p] ?? "#ffffff", p);
  }

  for (let c = 0; c < cols; c++) {
    const p = partitionOf(c, cols, parts);
    const e = env[p];
    const b = base[p];
    for (let r = 0; r < rows; r++) {
      const o = (r * cols + c) * 3;
      out[o] = (out[o] * (1 - mix) + b[0] * mix) * e;
      out[o + 1] = (out[o + 1] * (1 - mix) + b[1] * mix) * e;
      out[o + 2] = (out[o + 2] * (1 - mix) + b[2] * mix) * e;
    }
  }
}
