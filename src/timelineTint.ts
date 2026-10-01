import type { Config, TintSwatch } from "./config";

/**
 * Timeline tint: a 24h colour progression that is multiplied over the final LED
 * signal. Users add colour swatches along a midnight->midnight timeline; this
 * module owns the colour interpolation and the per-LED apply step. The widget
 * (drag swatches, playhead, scrub, play/pause) lives in `timelineWidget.ts`.
 */

function hexToRgb01(hex: string): [number, number, number] {
  const h = hex.replace("#", "").trim();
  const v =
    h.length === 3
      ? h
          .split("")
          .map((c) => c + c)
          .join("")
      : h.padEnd(6, "0");
  const r = parseInt(v.slice(0, 2), 16) / 255;
  const g = parseInt(v.slice(2, 4), 16) / 255;
  const b = parseInt(v.slice(4, 6), 16) / 255;
  return [isFinite(r) ? r : 1, isFinite(g) ? g : 1, isFinite(b) ? b : 1];
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function smooth(t: number): number {
  return t * t * (3 - 2 * t);
}

function wrap01(t: number): number {
  return t - Math.floor(t);
}

/**
 * Linearly interpolate the swatch list (sorted by time) at `t` (0..1), wrapping
 * around so the last swatch interpolates back to the first across midnight.
 * Uses smoothstep on the segment for a gentle, day-cycle feel.
 */
export function tintColorAt(swatches: TintSwatch[], t: number): [number, number, number] {
  if (!swatches.length) return [1, 1, 1];
  const sorted = [...swatches].sort((a, b) => a.time - b.time);
  const tt = wrap01(t);
  // Find the segment [a, b] such that a.time <= tt < b.time, wrapping at the end.
  let aIdx = -1;
  for (let i = 0; i < sorted.length; i++) {
    if (sorted[i].time <= tt) aIdx = i;
  }
  let a: TintSwatch;
  let b: TintSwatch;
  let segStart: number;
  let segEnd: number;
  if (aIdx === -1) {
    // tt is before the first swatch -> wrap: from last (time-1) to first.
    a = sorted[sorted.length - 1];
    b = sorted[0];
    segStart = a.time - 1;
    segEnd = b.time;
  } else if (aIdx === sorted.length - 1) {
    // tt is at/after the last swatch -> wrap: last to first (time+1).
    a = sorted[aIdx];
    b = sorted[0];
    segStart = a.time;
    segEnd = b.time + 1;
  } else {
    a = sorted[aIdx];
    b = sorted[aIdx + 1];
    segStart = a.time;
    segEnd = b.time;
  }
  const span = Math.max(1e-6, segEnd - segStart);
  const tRel = smooth((tt - segStart) / span);
  const [ar, ag, ab] = hexToRgb01(a.color);
  const [br, bg, bb] = hexToRgb01(b.color);
  return [lerp(ar, br, tRel), lerp(ag, bg, tRel), lerp(ab, bb, tRel)];
}

/** Multiply the timeline tint colour onto every LED in `out` (linear RGB). */
export function applyTimelineTint(out: Float32Array, cfg: Config): void {
  if (!cfg.tintEnabled) return;
  const [tr, tg, tb] = tintColorAt(cfg.tintSwatches, cfg.tintTime);
  // Pure white = identity, so an empty/all-white timeline is a no-op.
  if (Math.abs(tr - 1) < 1e-4 && Math.abs(tg - 1) < 1e-4 && Math.abs(tb - 1) < 1e-4) return;
  for (let i = 0; i + 2 < out.length; i += 3) {
    out[i] *= tr;
    out[i + 1] *= tg;
    out[i + 2] *= tb;
  }
}

/** Advance `cfg.tintTime` by `dt` seconds along the cycle, wrapping at 1.0. */
export function advanceTimelineTint(cfg: Config, dt: number): void {
  if (!cfg.tintPlaying) return;
  const cycle = Math.max(0.5, cfg.tintCycleSeconds);
  const step = dt / cycle;
  cfg.tintTime = wrap01(cfg.tintTime + step);
}
