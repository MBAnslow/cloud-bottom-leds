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
 * Post layer applied AFTER pattern + breathing.
 * Multiplies each LED by an animated 2D noise field to create a subtle,
 * cloud-like ripple/flow illusion.
 */
export function applyCloudDynamics(out: Float32Array, t: number, cfg: Config): void {
  if (!cfg.cloudDynamicsEnabled) return;

  const rows = cfg.rows;
  const cols = cfg.cols;
  const scale = Math.max(0.15, cfg.cloudDynamicsScale);
  const speed = cfg.cloudDynamicsSpeed;
  const amount = clamp01(cfg.cloudDynamicsAmount);
  const contrast = Math.max(0.2, cfg.cloudDynamicsContrast);

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

      const o = (r * cols + c) * 3;
      out[o] *= mod;
      out[o + 1] *= mod;
      out[o + 2] *= mod;
    }
  }
}
