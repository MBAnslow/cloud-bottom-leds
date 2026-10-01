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

function smoothstep(edge0: number, edge1: number, x: number): number {
  if (edge1 <= edge0) return x >= edge1 ? 1 : 0;
  const t = clamp01((x - edge0) / (edge1 - edge0));
  return t * t * (3 - 2 * t);
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
  // Depth of the dynamics swing. 0 = no effect, 1 = full dark<->bright swing,
  // >1 pushes more of the field to pure black / pure white (harder contrast).
  const amount = Math.max(0, cfg.cloudDynamicsAmount);
  const contrast = Math.max(0.2, cfg.cloudDynamicsContrast);
  const colourMix = clamp01(cfg.cloudDynamicsWhiteMix); // 0=white, 1=full colour

  // In-place ripple phase (no net translation). We intentionally avoid adding a
  // global +t offset to x/y so the pattern does not visibly drift left/right.
  const phaseA = Math.sin(t * speed * 0.9);
  const phaseB = Math.cos(t * speed * 1.2);

  for (let r = 0; r < rows; r++) {
    const v = rows > 1 ? r / (rows - 1) : 0.5;
    for (let c = 0; c < cols; c++) {
      const u = cols > 1 ? c / (cols - 1) : 0.5;
      // Domain warp that oscillates around fixed coordinates -> subtle
      // "shimmer/ripple in place" rather than directional travel.
      const baseX = u * scale;
      const baseY = v * scale;
      const w1 = valueNoise(baseX * 0.9 + 7.13, baseY * 0.9 - 3.71) - 0.5;
      const w2 = valueNoise(baseX * 1.1 - 4.82, baseY * 1.1 + 8.44) - 0.5;
      const x = baseX + w1 * (0.22 * phaseA) + w2 * (0.14 * phaseB);
      const y = baseY + w2 * (0.22 * phaseA) - w1 * (0.14 * phaseB);
      let n = noiseValue(cfg.cloudDynamicsType, x, y); // 0..1

      // Contrast remap around 0.5.
      n = clamp01(n);
      n = Math.pow(n, contrast);
      const centered = n * 2 - 1; // -1..1
      // Brightness multiplier swung around the signal: amount=1 reaches fully
      // dark (mod 0) and double-bright; higher amount drives harder. Floored at
      // 0 so it never inverts colour.
      const mod = Math.max(0, 1 + centered * amount);

      const o = (r * cols + c) * 3;
      const sr0 = out[o];
      const sg0 = out[o + 1];
      const sb0 = out[o + 2];
      const sMax = Math.max(sr0, sg0, sb0);

      // Split the existing breathing+pattern signal into COLOUR (hue) and
      // BRIGHTNESS so the dynamics can modulate brightness without washing the
      // colour out. Cloud dynamics is a light/dark field; the colour stays.
      let hr = 1;
      let hg = 1;
      let hb = 1;
      if (sMax > 1e-4) {
        hr = sr0 / sMax;
        hg = sg0 / sMax;
        hb = sb0 / sMax;
      }
      // Cloud base chroma: pure white -> the breathing/pattern hue, by colourMix.
      // Keep chroma mix independent from instantaneous brightness so a breathing
      // trough does not visually snap toward "plain dynamics" white.
      const baseR = 1 + (hr - 1) * colourMix;
      const baseG = 1 + (hg - 1) * colourMix;
      const baseB = 1 + (hb - 1) * colourMix;

      // Where there is signal, the cloud modulates that signal's brightness.
      // A standalone cloud fallback is only allowed when BOTH pattern and
      // breathing are off; otherwise low-signal troughs can incorrectly brighten
      // toward white as the fallback takes over.
      const allowStandalone = !cfg.patternEnabled && !cfg.breatheEnabled;
      // Blend signal-driven brightness in with a smooth knee to avoid a moving
      // seam at the old hard crossover point.
      const presence = allowStandalone ? smoothstep(0.0, 0.12, sMax) : 1.0;
      const signalBright = sMax * mod;
      const cloudBright = n * amount;
      const bright = cloudBright + (signalBright - cloudBright) * presence;

      out[o] = clamp01(baseR * bright);
      out[o + 1] = clamp01(baseG * bright);
      out[o + 2] = clamp01(baseB * bright);
    }
  }
}
