import * as THREE from "three";
import type { Config, WiringOrder } from "./config";

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
   * Pack colors into a gamma-corrected 8-bit RGB byte stream for the strips.
   * Honors wiring order so the visual top-left maps to LED index 0 correctly.
   */
  toBytes(wiring: WiringOrder, gamma = 2.2): Uint8Array {
    const out = new Uint8Array(this.count * 3);
    const inv = 1 / gamma;
    let dst = 0;
    for (let r = 0; r < this.rows; r++) {
      const reversed = wiring === "serpentine" && r % 2 === 1;
      for (let cc = 0; cc < this.cols; cc++) {
        const c = reversed ? this.cols - 1 - cc : cc;
        const src = (r * this.cols + c) * 3;
        out[dst++] = clamp255(Math.pow(this.colors[src], inv) * 255);
        out[dst++] = clamp255(Math.pow(this.colors[src + 1], inv) * 255);
        out[dst++] = clamp255(Math.pow(this.colors[src + 2], inv) * 255);
      }
    }
    return out;
  }
}

function clamp255(v: number): number {
  return v < 0 ? 0 : v > 255 ? 255 : Math.round(v);
}
