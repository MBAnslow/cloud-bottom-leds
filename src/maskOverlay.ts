import type { Config } from "./config";
import { partitionCount, partitionCenters, maskRotationRad } from "./breathing";
import { getMask, maskVersion } from "./mask";

/**
 * Visualises the "mask" layout by superimposing each partition's mask over its
 * position in the scene, scaled to match `computeWeights`. Each mask is tinted
 * with that partition's base colour and drawn additively so overlaps read.
 *
 * Draws onto its own full-window canvas layered above the 3D scene but below the
 * control panels; it accounts for the scene's "contain" letterboxing so the
 * blobs line up with the rendered cloud.
 */
export class MaskOverlay {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private dpr = Math.min(window.devicePixelRatio || 1, 2);

  // Cached tinted sprites (one per partition), rebuilt when the inputs change.
  private sprites: HTMLCanvasElement[] = [];
  private spriteKey = "";

  constructor(private cloudCanvas: HTMLElement) {
    const c = document.createElement("canvas");
    c.style.position = "fixed";
    c.style.inset = "0";
    c.style.width = "100%";
    c.style.height = "100%";
    c.style.pointerEvents = "none";
    c.style.zIndex = "5";
    c.style.display = "none";
    document.body.appendChild(c);
    this.canvas = c;
    this.ctx = c.getContext("2d")!;
  }

  /** Centred rect of the cloud in CSS px (matches the shader's contain fit). */
  private sceneRect(cfg: Config) {
    // Contain-fit the cloud aspect within the cloud canvas's on-screen box, so
    // the overlay lines up with the (inset) rendered cloud.
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

  private ensureSprites(cfg: Config, parts: number) {
    const mask = getMask();
    const key = `${maskVersion()}|${cfg.maskInvert}|${parts}|${cfg.breatheColors
      .slice(0, parts)
      .join(",")}`;
    if (key === this.spriteKey && this.sprites.length === parts) return;
    this.spriteKey = key;
    this.sprites = [];
    if (!mask) return;

    for (let p = 0; p < parts; p++) {
      const spr = document.createElement("canvas");
      spr.width = mask.w;
      spr.height = mask.h;
      const sctx = spr.getContext("2d")!;
      const img = sctx.createImageData(mask.w, mask.h);
      const [cr, cg, cb] = hexToRgb(cfg.breatheColors[p] ?? "#ffffff");
      for (let i = 0; i < mask.w * mask.h; i++) {
        let a = mask.lum[i];
        if (cfg.maskInvert) a = 1 - a;
        img.data[i * 4] = cr;
        img.data[i * 4 + 1] = cg;
        img.data[i * 4 + 2] = cb;
        img.data[i * 4 + 3] = Math.round(a * 255);
      }
      sctx.putImageData(img, 0, 0);
      this.sprites.push(spr);
    }
  }

  draw(cfg: Config, t: number = 0) {
    const show = cfg.maskShowOverlay && cfg.partitionLayout === "mask";
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
    const scale = Math.max(0.01, cfg.maskScale);
    // Match computeWeights: height = scale * scene height, width preserves the
    // mask's own aspect ratio (so a round mask stays round).
    const mask = getMask();
    const maskAspect = mask ? mask.w / Math.max(1, mask.h) : 1;
    const boxH = scale * rect.h;
    const boxW = boxH * maskAspect;

    this.ensureSprites(cfg, parts);
    const haveSprites = this.sprites.length === parts;

    ctx.save();
    // clip to the scene so blobs don't bleed into the letterbox bars
    ctx.beginPath();
    ctx.rect(rect.x, rect.y, rect.w, rect.h);
    ctx.clip();
    ctx.imageSmoothingEnabled = true;

    for (let p = 0; p < parts; p++) {
      const angle = maskRotationRad(cfg, t, p);
      const cx = rect.x + centers[p].x * rect.w;
      const cy = rect.y + centers[p].y * rect.h;

      if (haveSprites) {
        ctx.globalCompositeOperation = "lighter";
        ctx.globalAlpha = 0.7;
        ctx.save();
        ctx.translate(cx, cy);
        if (angle !== 0) ctx.rotate(angle);
        ctx.drawImage(this.sprites[p], -boxW / 2, -boxH / 2, boxW, boxH);
        ctx.restore();
      } else {
        // no image loaded: just show the placement box outline
        ctx.globalCompositeOperation = "source-over";
        ctx.globalAlpha = 0.5;
        ctx.strokeStyle = cfg.breatheColors[p] ?? "#ffffff";
        ctx.lineWidth = 1.5;
        ctx.save();
        ctx.translate(cx, cy);
        if (angle !== 0) ctx.rotate(angle);
        ctx.strokeRect(-boxW / 2, -boxH / 2, boxW, boxH);
        ctx.restore();
      }
    }

    // centre markers + labels on top
    ctx.globalCompositeOperation = "source-over";
    for (let p = 0; p < parts; p++) {
      const cx = rect.x + centers[p].x * rect.w;
      const cy = rect.y + centers[p].y * rect.h;
      ctx.globalAlpha = 1;
      ctx.fillStyle = cfg.breatheColors[p] ?? "#ffffff";
      ctx.beginPath();
      ctx.arc(cx, cy, 3, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = "rgba(0,0,0,0.6)";
      ctx.lineWidth = 1;
      ctx.stroke();
      ctx.fillStyle = "rgba(255,255,255,0.9)";
      ctx.font = "11px ui-sans-serif, system-ui, sans-serif";
      ctx.fillText(`P${p + 1}`, cx + 6, cy - 6);
    }
    ctx.restore();
  }
}

function hexToRgb(hex: string): [number, number, number] {
  const h = (hex || "#ffffff").replace("#", "");
  return [
    parseInt(h.slice(0, 2), 16) || 0,
    parseInt(h.slice(2, 4), 16) || 0,
    parseInt(h.slice(4, 6), 16) || 0,
  ];
}
