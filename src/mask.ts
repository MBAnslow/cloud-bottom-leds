/**
 * Breathing mask: an uploaded greyscale image that gates *how much* of the
 * breathing layer shows at each point on the cloud. Light areas breathe fully,
 * dark areas breathe little or not at all (the plain pattern shows through).
 *
 * The image is reduced to a per-pixel luminance field in [0,1]; LEDs sample it
 * bilinearly by their normalised (u,v) position, so the mask is independent of
 * the partition layout — it just modulates intensity on top.
 */

export interface MaskData {
  /** Working sample width/height (downscaled). */
  w: number;
  h: number;
  /** Luminance 0..1 per sample pixel, row-major (alpha pre-multiplied). */
  lum: Float32Array;
}

const SAMPLE_MAX = 160;

let current: MaskData | null = null;
let version = 0;

export function getMask(): MaskData | null {
  return current;
}
export function maskVersion(): number {
  return version;
}
export function clearMask(): void {
  current = null;
  version++;
}

/** Set the mask directly from a luminance grid (used by the draw-your-own grid). */
export function setMaskData(lum: Float32Array, w: number, h: number): void {
  current = { w, h, lum: lum.slice() };
  version++;
}

/** Bilinearly sample the mask at normalised (u,v) in [0,1]. Returns 0..1. */
export function sampleMask(m: MaskData, u: number, v: number): number {
  const fx = Math.min(1, Math.max(0, u)) * (m.w - 1);
  const fy = Math.min(1, Math.max(0, v)) * (m.h - 1);
  const x0 = Math.floor(fx);
  const y0 = Math.floor(fy);
  const x1 = Math.min(m.w - 1, x0 + 1);
  const y1 = Math.min(m.h - 1, y0 + 1);
  const tx = fx - x0;
  const ty = fy - y0;
  const a = m.lum[y0 * m.w + x0];
  const b = m.lum[y0 * m.w + x1];
  const c = m.lum[y1 * m.w + x0];
  const d = m.lum[y1 * m.w + x1];
  const top = a + (b - a) * tx;
  const bot = c + (d - c) * tx;
  return top + (bot - top) * ty;
}

function processImage(src: CanvasImageSource, sw: number, sh: number): MaskData {
  const scale = Math.min(1, SAMPLE_MAX / Math.max(sw, sh));
  const w = Math.max(1, Math.round(sw * scale));
  const h = Math.max(1, Math.round(sh * scale));
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
  ctx.drawImage(src, 0, 0, w, h);
  const data = ctx.getImageData(0, 0, w, h).data;

  const lum = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) {
    const r = data[i * 4];
    const g = data[i * 4 + 1];
    const b = data[i * 4 + 2];
    const a = data[i * 4 + 3] / 255;
    // Rec.709 luma; transparent pixels read as "dark" (no breathing).
    lum[i] = ((0.2126 * r + 0.7152 * g + 0.0722 * b) / 255) * a;
  }
  return { w, h, lum };
}

/** Load a mask from an <input type=file> selection. */
export async function loadMaskFile(file: File): Promise<void> {
  const url = URL.createObjectURL(file);
  try {
    await loadMaskURL(url);
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** Load a mask from any image URL (or data URL). */
export function loadMaskURL(url: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => {
      try {
        current = processImage(img, img.naturalWidth, img.naturalHeight);
        version++;
        resolve();
      } catch (e) {
        reject(e);
      }
    };
    img.onerror = () => reject(new Error("could not load mask image"));
    img.src = url;
  });
}
