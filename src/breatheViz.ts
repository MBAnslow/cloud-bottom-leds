import type { Config } from "./config";
import { partitionCount, breatheWave } from "./breathing";

/**
 * Oscilloscope-style readout of the per-partition breathing pulses. Each
 * partition gets a lane that plots its breathing waveform over a 2-cycle
 * window (past on the left, "now" at the right edge), drawn in that partition's
 * base colour with a live dot at the current value.
 */
export class BreatheViz {
  private ctx: CanvasRenderingContext2D;
  private dpr = Math.min(window.devicePixelRatio || 1, 2);

  constructor(private canvas: HTMLCanvasElement) {
    this.ctx = canvas.getContext("2d")!;
  }

  private resize() {
    const w = Math.max(1, Math.round(this.canvas.clientWidth * this.dpr));
    const h = Math.max(1, Math.round(this.canvas.clientHeight * this.dpr));
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
  }

  draw(cfg: Config, t: number) {
    this.resize();
    const ctx = this.ctx;
    const W = this.canvas.width;
    const H = this.canvas.height;
    ctx.clearRect(0, 0, W, H);

    const parts = partitionCount(cfg);
    const dpr = this.dpr;
    const padX = 6 * dpr;
    const padY = 4 * dpr;
    const gap = 8 * dpr;
    const laneH = (H - padY * 2 - gap * (parts - 1)) / parts;
    const left = padX;
    const right = W - padX;
    const innerW = right - left;

    const period = 60 / Math.max(0.01, cfg.breatheRate);
    const windowSec = period * 2;
    const samples = 72;

    for (let p = 0; p < parts; p++) {
      const y0 = padY + p * (laneH + gap);
      const midY = y0 + laneH / 2;
      const amp = (laneH / 2) * 0.82;
      const hex = cfg.breatheColors[p] ?? "#ffffff";

      // lane background
      ctx.fillStyle = "rgba(255,255,255,0.045)";
      roundRect(ctx, left, y0, innerW, laneH, 6 * dpr);
      ctx.fill();

      // zero line
      ctx.strokeStyle = "rgba(255,255,255,0.08)";
      ctx.lineWidth = 1 * dpr;
      ctx.beginPath();
      ctx.moveTo(left, midY);
      ctx.lineTo(right, midY);
      ctx.stroke();

      // waveform (left = oldest, right = now)
      ctx.beginPath();
      for (let s = 0; s <= samples; s++) {
        const frac = s / samples;
        const tau = t - windowSec * (1 - frac);
        const val = (breatheWave(p, parts, tau, cfg) - 0.5) * 2 * cfg.breatheDepth;
        const x = left + frac * innerW;
        const y = midY - val * amp;
        if (s === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.strokeStyle = hex;
      ctx.lineWidth = 2 * dpr;
      ctx.lineJoin = "round";
      ctx.stroke();

      // current-value dot at the right edge
      const valNow = (breatheWave(p, parts, t, cfg) - 0.5) * 2 * cfg.breatheDepth;
      const yNow = midY - valNow * amp;
      ctx.beginPath();
      ctx.arc(right, yNow, 3.2 * dpr, 0, Math.PI * 2);
      ctx.fillStyle = hex;
      ctx.fill();
      ctx.strokeStyle = "rgba(0,0,0,0.5)";
      ctx.lineWidth = 1 * dpr;
      ctx.stroke();

      // label
      ctx.fillStyle = "rgba(255,255,255,0.6)";
      ctx.font = `${10 * dpr}px ui-sans-serif, system-ui, sans-serif`;
      ctx.textBaseline = "top";
      ctx.fillText(`P${p + 1}`, left + 5 * dpr, y0 + 4 * dpr);
    }
  }
}

function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number
) {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}
