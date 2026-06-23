import * as THREE from "three";
import type { Config, WiringOrder } from "./config";

/**
 * Default highlight-rolloff exposure used when packing hardware bytes. The
 * rolloff is a Reinhard curve `(x*e)/(1 + x*e)` which, unlike `1 - exp(-x*e)`,
 * keeps responding across the whole exposure range instead of saturating once
 * `x*e` passes ~1 (the LED gain is baked into the buffer, so x is often > 1).
 */
const STREAM_EXPOSURE = 1.25;

/**
 * Owns the per-LED color buffer (row-major linear RGB) and mirrors it into a
 * GPU DataTexture for the shader. Also produces the byte stream for hardware.
 */
export class LedField {
  rows: number;
  cols: number;
  /** linear RGB, length rows*cols*3 */
  colors: Float32Array;
  /** RGBA float, cols x rows, uploaded to the shader */
  texture: THREE.DataTexture;
  private texData: Float32Array<ArrayBuffer>;

  constructor(cfg: Config) {
    this.rows = cfg.rows;
    this.cols = cfg.cols;
    this.colors = new Float32Array(this.rows * this.cols * 3);
    this.texData = new Float32Array(this.rows * this.cols * 4);
    this.texture = this.makeTexture();
  }

  private makeTexture(): THREE.DataTexture {
    const tex = new THREE.DataTexture(
      this.texData,
      this.cols,
      this.rows,
      THREE.RGBAFormat,
      THREE.FloatType
    );
    tex.magFilter = THREE.NearestFilter;
    tex.minFilter = THREE.NearestFilter;
    tex.generateMipmaps = false;
    tex.needsUpdate = true;
    return tex;
  }

  get count(): number {
    return this.rows * this.cols;
  }

  /** Recreate buffers when the grid dimensions change. */
  resize(cfg: Config) {
    if (cfg.rows === this.rows && cfg.cols === this.cols) return;
    this.rows = cfg.rows;
    this.cols = cfg.cols;
    this.colors = new Float32Array(this.rows * this.cols * 3);
    this.texData = new Float32Array(this.rows * this.cols * 4);
    this.texture.dispose();
    this.texture = this.makeTexture();
  }

  /** Copy the current color buffer into the GPU texture. */
  uploadToTexture() {
    const c = this.colors;
    const t = this.texData;
    for (let i = 0, j = 0, k = 0; i < this.count; i++, j += 3, k += 4) {
      t[k] = c[j];
      t[k + 1] = c[j + 1];
      t[k + 2] = c[j + 2];
      t[k + 3] = 1.0;
    }
    this.texture.needsUpdate = true;
  }

  /**
   * Pack colors into an 8-bit RGB byte stream for the strips:
   *
   *   lit    = linear * exposure
   *   mapped = lit / (1 + lit)          // Reinhard rolloff (no hard clipping)
   *   out    = pow(mapped, 1 / gamma)   // encoding
   *
   * `gamma = 1` sends LINEAR bytes, which is correct for raw WS2812B pixels and
   * SPI controllers (K-1000C, SP107E, WLED with gamma off): their PWM duty is
   * ~linear with the byte, so emitted light tracks `mapped` and therefore the
   * on-screen brightness. Display-style gamma encoding (1/2.2) here would lift
   * the mids so the whole top half of the range looks equally bright. Raise
   * `gamma` only if the controller applies its own gamma decode. The Reinhard
   * rolloff keeps the `exposure` slider responsive end to end. Honors wiring
   * order so the visual top-left maps to LED index 0 correctly.
   */
  toBytes(wiring: WiringOrder, gamma = 1, exposure = STREAM_EXPOSURE): Uint8Array {
    const out = new Uint8Array(this.count * 3);
    const inv = 1 / gamma;
    const exp = Math.max(0, exposure);
    const rowSerp = wiring === "serpentine";
    const colMajor = wiring === "column-major" || wiring === "column-serpentine";
    const colSerp = wiring === "column-serpentine";
    let dst = 0;
    const encode = (linear: number) => {
      const lit = Math.max(0, linear) * exp;
      const mapped = lit / (1 + lit);
      return clamp255(Math.pow(mapped, inv) * 255);
    };
    const pushPixel = (r: number, c: number) => {
      const src = (r * this.cols + c) * 3;
      out[dst++] = encode(this.colors[src]);
      out[dst++] = encode(this.colors[src + 1]);
      out[dst++] = encode(this.colors[src + 2]);
    };
    if (colMajor) {
      for (let c = 0; c < this.cols; c++) {
        const reversed = colSerp && c % 2 === 1;
        for (let rr = 0; rr < this.rows; rr++) {
          const r = reversed ? this.rows - 1 - rr : rr;
          pushPixel(r, c);
        }
      }
    } else {
      for (let r = 0; r < this.rows; r++) {
        const reversed = rowSerp && r % 2 === 1;
        for (let cc = 0; cc < this.cols; cc++) {
          const c = reversed ? this.cols - 1 - cc : cc;
          pushPixel(r, c);
        }
      }
    }
    return out;
  }
}

function clamp255(v: number): number {
  return v < 0 ? 0 : v > 255 ? 255 : Math.round(v);
}
