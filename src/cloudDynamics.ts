import type { CloudDynamicsNoise, Config } from "./config";

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

function fbm(x: number, y: number, octaves: number): number {
  let amp = 0.5;
  let freq = 1;
  let sum = 0;
  let norm = 0;
  for (let i = 0; i < octaves; i++) {
    sum += amp * valueNoise(x * freq, y * freq);
    norm += amp;
    freq *= 2;
    amp *= 0.5;
  }
  return norm > 0 ? sum / norm : 0;
}

function noiseValue(type: CloudDynamicsNoise, x: number, y: number): number {
  if (type === "value") return valueNoise(x, y);
  if (type === "fbm") return fbm(x, y, 4);
  if (type === "billow") {
    const n = fbm(x, y, 4);
    return Math.abs(2 * n - 1); // 0..1
  }
  // ridged
  const n = fbm(x, y, 4);
  return 1 - Math.abs(2 * n - 1);
}

function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

/**
 * Apply animated 2D cloud dynamics to the current LED layer.
 * It modulates existing signal and also contributes a subtle standalone
 * greyscale cloud field, so the effect remains visible even when breathing is
 * off (or pattern is dark) and naturally mixes when colour layers are present.
 */
export function applyCloudDynamics(out: Float32Array, t: number, cfg: Config): void {
  if (!cfg.cloudDynamicsEnabled) return;

  const rows = cfg.rows;
  const cols = cfg.cols;
  const scale = Math.max(0.15, cfg.cloudDynamicsScale);
  const speed = cfg.cloudDynamicsSpeed;
  const amount = clamp01(cfg.cloudDynamicsAmount);
  const contrast = Math.max(0.2, cfg.cloudDynamicsContrast);
  const colourMix = clamp01(cfg.cloudDynamicsWhiteMix); // 0=white, 1=full colour

  // Gentle anisotropic drift keeps the field from looking static/repeating.
  const tx = t * speed * 0.21;
  const ty = -t * speed * 0.13;
  const wx = t * speed * 0.09;
  const wy = t * speed * 0.15;

  for (let r = 0; r < rows; r++) {
    const v = rows > 1 ? r / (rows - 1) : 0.5;
    for (let c = 0; c < cols; c++) {
      const u = cols > 1 ? c / (cols - 1) : 0.5;
      // Mild domain warp makes ripples feel more fluid/cloudy.
      const warp = valueNoise(u * scale * 0.7 + wx, v * scale * 0.7 + wy) - 0.5;
      const x = u * scale + tx + warp * 0.35;
      const y = v * scale + ty - warp * 0.25;
      let n = noiseValue(cfg.cloudDynamicsType, x, y); // 0..1

      // Contrast remap around 0.5.
      n = clamp01(n);
      n = Math.pow(n, contrast);
      const centered = n * 2 - 1; // -1..1
      const mod = 1 + centered * amount;
      // Standalone white cloud field when incoming signal is dark/off.
      const cloudOnly = (0.08 + 0.92 * n) * amount;

      const o = (r * cols + c) * 3;
      const sr = clamp01(out[o] * mod);
      const sg = clamp01(out[o + 1] * mod);
      const sb = clamp01(out[o + 2] * mod);

      // Presence of coloured signal: when absent, keep pure white cloud field.
      const presence = clamp01((Math.max(sr, sg, sb) - 0.01) / 0.24);
      const cr = cloudOnly + (sr - cloudOnly) * presence;
      const cg = cloudOnly + (sg - cloudOnly) * presence;
      const cb = cloudOnly + (sb - cloudOnly) * presence;

      // True white<->colour crossfade:
      //   0 => complete white cloud field
      //   1 => complete signal colour (where signal exists)
      out[o] = clamp01(cloudOnly + (cr - cloudOnly) * colourMix);
      out[o + 1] = clamp01(cloudOnly + (cg - cloudOnly) * colourMix);
      out[o + 2] = clamp01(cloudOnly + (cb - cloudOnly) * colourMix);
    }
  }
}
