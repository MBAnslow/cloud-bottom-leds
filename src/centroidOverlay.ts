import type { Config } from "./config";
import { partitionCenters, partitionCount, setPartitionCenter } from "./breathing";

/**
 * Draws and edits partition centroids over the flat panel view.
 * Handles are dragged in screen space and mapped to normalised cloud u,v.
 */
export class CentroidOverlay {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private dpr = Math.min(window.devicePixelRatio || 1, 2);
  private active = -1;
  private hover = -1;

  constructor(private cloudCanvas: HTMLElement) {
    const c = document.createElement("canvas");
    c.style.position = "fixed";
    c.style.inset = "0";
    c.style.width = "100%";
    c.style.height = "100%";
    c.style.pointerEvents = "none";
    c.style.zIndex = "6";
    c.style.display = "none";
    document.body.appendChild(c);
    this.canvas = c;
    this.ctx = c.getContext("2d")!;
  }

  get isDragging(): boolean {
    return this.active >= 0;
  }

  private shouldShow(cfg: Config): boolean {
    return cfg.breatheEnabled && cfg.view === "panel";
  }

  /** Centred rect of the cloud in CSS px (matches the shader's contain fit). */
  private sceneRect(cfg: Config) {
    const r = this.cloudCanvas.getBoundingClientRect();
    const a = cfg.cloudWidthMm / Math.max(1, cfg.cloudHeightMm);
    let rw: number;
    let rh: number;
    if (r.width / r.height > a) {
      rh = r.height;
      rw = rh * a;
    } else {
      rw = r.width;
      rh = rw / a;
    }
    return { x: r.left + (r.width - rw) / 2, y: r.top + (r.height - rh) / 2, w: rw, h: rh };
  }

  private hitIndex(cfg: Config, clientX: number, clientY: number): number {
    const parts = partitionCount(cfg);
    const centers = partitionCenters(cfg);
    const rect = this.sceneRect(cfg);
    let best = -1;
    let bestD2 = Infinity;
    const hitR = 10;
    const hitR2 = hitR * hitR;
    for (let p = 0; p < parts; p++) {
      const cx = rect.x + centers[p].x * rect.w;
      const cy = rect.y + centers[p].y * rect.h;
      const dx = clientX - cx;
      const dy = clientY - cy;
      const d2 = dx * dx + dy * dy;
      if (d2 <= hitR2 && d2 < bestD2) {
        bestD2 = d2;
        best = p;
      }
    }
    return best;
  }

  private updateFromPointer(cfg: Config, clientX: number, clientY: number): boolean {
    if (this.active < 0) return false;
    const rect = this.sceneRect(cfg);
    const u = clamp01((clientX - rect.x) / Math.max(1e-6, rect.w));
    const v = clamp01((clientY - rect.y) / Math.max(1e-6, rect.h));
    setPartitionCenter(cfg, this.active, u, v);
    return true;
  }

  beginDrag(cfg: Config, clientX: number, clientY: number): boolean {
    if (!this.shouldShow(cfg)) return false;
    const idx = this.hitIndex(cfg, clientX, clientY);
    if (idx < 0) return false;
    this.active = idx;
    this.hover = idx;
    this.updateFromPointer(cfg, clientX, clientY);
    return true;
  }

  dragTo(cfg: Config, clientX: number, clientY: number): boolean {
    return this.updateFromPointer(cfg, clientX, clientY);
  }

  endDrag(): void {
    this.active = -1;
  }

  hoverAt(cfg: Config, clientX: number, clientY: number): void {
    if (!this.shouldShow(cfg) || this.active >= 0) {
      this.hover = -1;
      return;
    }
    this.hover = this.hitIndex(cfg, clientX, clientY);
  }

  clearHover(): void {
    if (this.active < 0) this.hover = -1;
  }

  draw(cfg: Config): void {
    const show = this.shouldShow(cfg);
    if (!show) {
      if (this.canvas.style.display !== "none") {
        this.canvas.style.display = "none";
        this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
      }
      return;
    }
    this.canvas.style.display = "block";

    const dpr = this.dpr;
    const cw = Math.round(window.innerWidth * dpr);
    const ch = Math.round(window.innerHeight * dpr);
    if (this.canvas.width !== cw || this.canvas.height !== ch) {
      this.canvas.width = cw;
      this.canvas.height = ch;
    }
    const ctx = this.ctx;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, window.innerWidth, window.innerHeight);

    const parts = partitionCount(cfg);
    const centers = partitionCenters(cfg);
    const rect = this.sceneRect(cfg);

    // Keep visuals inside the cloud area so labels/handles don't bleed out.
    ctx.save();
    ctx.beginPath();
    ctx.rect(rect.x, rect.y, rect.w, rect.h);
    ctx.clip();
    for (let p = 0; p < parts; p++) {
      const cx = rect.x + centers[p].x * rect.w;
      const cy = rect.y + centers[p].y * rect.h;
      const active = p === this.active;
      const hover = p === this.hover;
      const r = active ? 7 : hover ? 6 : 5;
      const color = cfg.breatheColors[p] ?? "#ffffff";

      ctx.fillStyle = color;
      ctx.globalAlpha = 0.95;
      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, Math.PI * 2);
      ctx.fill();

      ctx.lineWidth = active ? 2 : 1.5;
      ctx.strokeStyle = "rgba(0,0,0,0.65)";
      ctx.stroke();

      ctx.globalAlpha = 0.95;
      ctx.fillStyle = "rgba(255,255,255,0.92)";
      ctx.font = "11px ui-sans-serif, system-ui, sans-serif";
      ctx.fillText(`P${p + 1}`, cx + 8, cy - 8);
    }
    ctx.restore();
  }
}

function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}
