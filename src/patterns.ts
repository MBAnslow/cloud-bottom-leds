import type { Config, PaletteName, PatternName } from "./config";

/**
 * Pattern engine. Fills `out` with linear RGB (0..1) for every LED, row-major:
 *   index = (row * cols + col) * 3
 * This buffer is the single source of truth: it drives both the on-screen
 * cloud visual and the bytes streamed to the physical strips.
 */

function hsv2rgb(h: number, s: number, v: number, out: number[], o: number) {
  h = ((h % 1) + 1) % 1;
  const i = Math.floor(h * 6);
  const f = h * 6 - i;
  const p = v * (1 - s);
  const q = v * (1 - f * s);
  const t = v * (1 - (1 - f) * s);
  let r = 0,
    g = 0,
    b = 0;
  switch (i % 6) {
    case 0: r = v; g = t; b = p; break;
    case 1: r = q; g = v; b = p; break;
    case 2: r = p; g = v; b = t; break;
    case 3: r = p; g = q; b = v; break;
    case 4: r = t; g = p; b = v; break;
    case 5: r = v; g = p; b = q; break;
  }
  out[o] = r;
  out[o + 1] = g;
  out[o + 2] = b;
}

type Rgb = [number, number, number];

const PALETTE_RAMPS: Record<Exclude<PaletteName, "rainbow" | "greyscale">, Rgb[]> = {
  sunset: [
    [0.16, 0.06, 0.34],
    [0.56, 0.16, 0.56],
    [0.96, 0.36, 0.35],
    [1.0, 0.74, 0.34],
  ],
  ocean: [
    [0.04, 0.10, 0.22],
    [0.08, 0.34, 0.56],
    [0.14, 0.62, 0.72],
    [0.55, 0.90, 0.95],
  ],
  forest: [
    [0.03, 0.12, 0.08],
    [0.10, 0.32, 0.12],
    [0.24, 0.58, 0.21],
    [0.74, 0.85, 0.42],
  ],
  violet: [
    [0.10, 0.06, 0.18],
    [0.30, 0.14, 0.48],
    [0.62, 0.32, 0.80],
    [0.92, 0.66, 1.00],
  ],
  ember: [
    [0.10, 0.03, 0.01],
    [0.55, 0.08, 0.02],
    [0.90, 0.26, 0.05],
    [1.00, 0.76, 0.18],
  ],
};

function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

function frac(x: number): number {
  return x - Math.floor(x);
}

function sampleRamp(palette: Exclude<PaletteName, "rainbow" | "greyscale">, t: number, out: number[]) {
  const ramp = PALETTE_RAMPS[palette];
  const n = ramp.length;
  if (n === 0) {
    out[0] = 1;
    out[1] = 1;
    out[2] = 1;
    return;
  }
  const x = frac(t) * (n - 1);
  const i = Math.floor(x);
  const j = Math.min(n - 1, i + 1);
  const f = x - i;
  out[0] = ramp[i][0] + (ramp[j][0] - ramp[i][0]) * f;
  out[1] = ramp[i][1] + (ramp[j][1] - ramp[i][1]) * f;
  out[2] = ramp[i][2] + (ramp[j][2] - ramp[i][2]) * f;
}

const baseCol: number[] = [0, 0, 0];
function paletteHSV(palette: PaletteName, h: number, s: number, v: number, out: number[]) {
  const val = clamp01(v);
  if (palette === "greyscale") {
    out[0] = val;
    out[1] = val;
    out[2] = val;
    return;
  }
  if (palette === "rainbow") {
    hsv2rgb(h, clamp01(s), val, out, 0);
    return;
  }

  sampleRamp(palette, h, baseCol);
  const sat = clamp01(s);
  const lum = baseCol[0] * 0.2126 + baseCol[1] * 0.7152 + baseCol[2] * 0.0722;
  const r = lum + (baseCol[0] - lum) * sat;
  const g = lum + (baseCol[1] - lum) * sat;
  const b = lum + (baseCol[2] - lum) * sat;
  out[0] = r * val;
  out[1] = g * val;
  out[2] = b * val;
}

// --- cheap, deterministic value noise (no deps) ---
function hash(x: number, y: number): number {
  const s = Math.sin(x * 127.1 + y * 311.7) * 43758.5453;
  return s - Math.floor(s);
}
function smooth(t: number): number {
  return t * t * (3 - 2 * t);
}
function valueNoise(x: number, y: number): number {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const xf = x - xi;
  const yf = y - yi;
  const a = hash(xi, yi);
  const b = hash(xi + 1, yi);
  const c = hash(xi, yi + 1);
  const d = hash(xi + 1, yi + 1);
  const u = smooth(xf);
  const v = smooth(yf);
  return a * (1 - u) * (1 - v) + b * u * (1 - v) + c * (1 - u) * v + d * u * v;
}
function fbm(x: number, y: number, octaves = 4): number {
  let amp = 0.5;
  let freq = 1;
  let sum = 0;
  for (let i = 0; i < octaves; i++) {
    sum += amp * valueNoise(x * freq, y * freq);
    freq *= 2;
    amp *= 0.5;
  }
  return sum;
}

// Per-LED transient state for stateful patterns (twinkle, rain).
let twinkleSeed: Float32Array | null = null;
let rainDrops: Float32Array | null = null;

function ensureState(n: number) {
  if (!twinkleSeed || twinkleSeed.length !== n) {
    twinkleSeed = new Float32Array(n);
    for (let i = 0; i < n; i++) twinkleSeed[i] = Math.random();
  }
  if (!rainDrops || rainDrops.length !== n) {
    rainDrops = new Float32Array(n);
  }
}

const rgb: number[] = [0, 0, 0];
const AURORA_NOISE_SCALE = 2.4;

/**
 * Compute one frame of LED colors.
 * @param out   Float32Array of length rows*cols*3 (linear RGB, 0..1)
 * @param t     time in seconds
 * @param dt    delta seconds since last frame
 * @param cfg   current configuration
 */
export function renderPattern(
  out: Float32Array,
  t: number,
  dt: number,
  cfg: Config
) {
  const { rows, cols } = cfg;
  const n = rows * cols;
  ensureState(n);
  const tt = t * cfg.speed;
  const hue = cfg.hueShift / 360; // palette phase offset
  const fn = PATTERNS[cfg.pattern] ?? PATTERNS.plasma;
  const palette = cfg.patternPalettes[cfg.pattern] ?? "rainbow";

  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const i = r * cols + c;
      const u = cols > 1 ? c / (cols - 1) : 0.5;
      const v = rows > 1 ? r / (rows - 1) : 0.5;
      fn(u, v, tt, dt, i, hue, palette, cfg, rgb);
      const o = i * 3;
      out[o] = rgb[0] * cfg.brightness;
      out[o + 1] = rgb[1] * cfg.brightness;
      out[o + 2] = rgb[2] * cfg.brightness;
    }
  }
}

type PatternFn = (
  u: number,
  v: number,
  t: number,
  dt: number,
  i: number,
  hue: number,
  palette: PaletteName,
  cfg: Config,
  out: number[]
) => void;

const PATTERNS: Record<PatternName, PatternFn> = {
  plasma(u, v, t, _dt, _i, hue, palette, _cfg, out) {
    const x = u * 6;
    const y = v * 6;
    let val = Math.sin(x + t);
    val += Math.sin(y * 0.8 + t * 1.3);
    val += Math.sin((x + y) * 0.5 + t * 0.7);
    val += Math.sin(Math.hypot(x - 3, y - 3) + t);
    val = val / 4; // -1..1
    paletteHSV(palette, hue + 0.6 + val * 0.4, 0.85, 0.5 + 0.5 * val, out);
  },

  rainbowWaves(u, _v, t, _dt, _i, hue, palette, _cfg, out) {
    paletteHSV(palette, hue + u + t * 0.1, 0.9, 1.0, out);
  },

  twinkle(_u, _v, t, _dt, i, hue, palette, _cfg, out) {
    const seed = twinkleSeed![i];
    // slow base + sparkle
    const phase = (t * (0.4 + seed) + seed * 6.28) % 6.28;
    const sparkle = Math.max(0, Math.sin(phase));
    const v = 0.08 + Math.pow(sparkle, 4) * 0.92;
    paletteHSV(palette, hue + 0.55 + seed * 0.15, 0.5, v, out);
  },

  fire(u, v, t, _dt, _i, hue, palette, _cfg, out) {
    // hotter toward the bottom (v near 1)
    const n = fbm(u * 3, v * 3 - t * 1.5, 4);
    let heat = (1 - v) * 0.4 + n * 0.9;
    heat = Math.min(1, Math.max(0, heat));
    // Heat drives value; hue tracks warm end by default but remains palette-aware.
    paletteHSV(palette, hue + 0.02 + heat * 0.12, 1.0, heat, out);
  },

  auroraDrift(u, v, t, _dt, _i, hue, palette, _cfg, out) {
    const n = fbm(u * AURORA_NOISE_SCALE + t * 0.15, v * AURORA_NOISE_SCALE - t * 0.1, 4);
    const band = Math.sin(v * 3.0 + n * 3.0 + t * 0.5) * 0.5 + 0.5;
    const h = hue + 0.45 + n * 0.35; // greens -> teals -> violets
    paletteHSV(palette, h, 0.8, 0.15 + band * band * 0.85, out);
  },

  breathe(_u, _v, t, _dt, _i, hue, palette, _cfg, out) {
    const b = 0.2 + 0.8 * (0.5 + 0.5 * Math.sin(t * 0.8));
    paletteHSV(palette, hue + 0.08 + 0.05 * Math.sin(t * 0.2), 0.6, b, out);
  },

  rain(_u, _v, _t, dt, i, hue, palette, cfg, out) {
    const drops = rainDrops!;
    // randomly ignite drops, then decay
    if (drops[i] <= 0.001 && Math.random() < 0.004 * cfg.speed) {
      drops[i] = 1;
    }
    drops[i] *= Math.max(0, 1 - dt * 2.2 * cfg.speed);
    const v = drops[i];
    paletteHSV(palette, hue + 0.58, 0.55, v, out);
  },

  solid(_u, _v, _t, _dt, _i, hue, palette, _cfg, out) {
    paletteHSV(palette, hue + 0.08, 0.5, 1.0, out);
  },
};
