import * as THREE from "three";
import type { Config, WiringOrder, StreamChannelOrder } from "./config";

/**
 * Default highlight-rolloff exposure used when packing hardware bytes. The
 * rolloff is a Reinhard curve `(x*e)/(1 + x*e)` which, unlike `1 - exp(-x*e)`,
 * keeps responding across the whole exposure range instead of saturating once
 * `x*e` passes ~1 (the LED gain is baked into the buffer, so x is often > 1).
 */
const STREAM_EXPOSURE = 1.25;

interface StreamCalibration {
  saturation?: number;
  redGain?: number;
  greenGain?: number;
  blueGain?: number;
}

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
  private packFrame = 0;

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
  toBytes(
    wiring: WiringOrder,
    channelOrder: StreamChannelOrder = "RGB",
    gamma = 1,
    exposure = STREAM_EXPOSURE,
    calibration: StreamCalibration = {}
  ): Uint8Array {
    const out = new Uint8Array(this.count * 3);
    const inv = 1 / gamma;
    const exp = Math.max(0, exposure);
    const phase = this.packFrame++ & 1;
    const sat = calibration.saturation ?? 1;
    const gR = calibration.redGain ?? 1;
    const gG = calibration.greenGain ?? 1;
    const gB = calibration.blueGain ?? 1;
    const rowSerp = wiring === "serpentine";
    const colMajor = wiring === "column-major" || wiring === "column-serpentine";
    const colSerp = wiring === "column-serpentine";
    let dst = 0;
    const encode = (linear: number, dither: number) => {
      const lit = Math.max(0, linear) * exp;
      const mapped = lit / (1 + lit);
      // Temporal +/-0.5 LSB dithering reduces visible stepping at slow fades
      // (especially around dark values) without changing average brightness.
      return clamp255(Math.pow(mapped, inv) * 255 + dither);
    };
    const pushPixel = (r: number, c: number) => {
      const src = (r * this.cols + c) * 3;
      const pix = r * this.cols + c;
      let pr = Math.max(0, this.colors[src]);
      let pg = Math.max(0, this.colors[src + 1]);
      let pb = Math.max(0, this.colors[src + 2]);
      // Saturation in linear space so it behaves predictably for LED emitters.
      const luma = pr * 0.2126 + pg * 0.7152 + pb * 0.0722;
      pr = luma + (pr - luma) * sat;
      pg = luma + (pg - luma) * sat;
      pb = luma + (pb - luma) * sat;
      // Per-channel calibration trims (white balance / spectral compensation).
      pr *= gR;
      pg *= gG;
      pb *= gB;
      const dR = ((pix + phase + 0) & 1) === 0 ? -0.5 : 0.5;
      const dG = ((pix + phase + 1) & 1) === 0 ? -0.5 : 0.5;
      const dB = ((pix + phase + 2) & 1) === 0 ? -0.5 : 0.5;
      const er = encode(pr, dR);
      const eg = encode(pg, dG);
      const eb = encode(pb, dB);
      switch (channelOrder) {
        case "RBG":
          out[dst++] = er;
          out[dst++] = eb;
          out[dst++] = eg;
          break;
        case "GRB":
          out[dst++] = eg;
          out[dst++] = er;
          out[dst++] = eb;
          break;
        case "GBR":
          out[dst++] = eg;
          out[dst++] = eb;
          out[dst++] = er;
          break;
        case "BRG":
          out[dst++] = eb;
          out[dst++] = er;
          out[dst++] = eg;
          break;
        case "BGR":
          out[dst++] = eb;
          out[dst++] = eg;
          out[dst++] = er;
          break;
        default:
          out[dst++] = er;
          out[dst++] = eg;
          out[dst++] = eb;
          break;
      }
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
