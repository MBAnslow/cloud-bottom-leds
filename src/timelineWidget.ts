import type { Config } from "./config";
import { tintColorAt } from "./timelineTint";

/**
 * Interactive 24h tint timeline:
 *   - shows a smooth gradient of the interpolated tint colour across the day
 *   - draggable swatch markers (time + colour) above the strip
 *   - clear playhead with live HH:MM readout
 *   - drag the strip to scrub time; double-click to add a swatch
 *   - click a marker to recolour it; alt-click / right-click to delete it
 *   - play/pause button + cycle speed control are owned by the parent GUI
 *
 * Mutates `cfg.tintSwatches` / `cfg.tintTime` in place; the parent's render
 * loop applies them via `applyTimelineTint`.
 */
export class TimelineWidget {
  private cfg: Config;
  private onChange: () => void;
  private root: HTMLDivElement;
  private playBtn: HTMLButtonElement;
  private timeLabel: HTMLSpanElement;
  private strip: HTMLCanvasElement;
  private picker: HTMLInputElement;
  private stripCtx: CanvasRenderingContext2D | null;
  private dragging: { kind: "swatch"; index: number } | { kind: "scrub" } | null = null;
  private pickingIndex: number | null = null;
  private dpr = 1;

  constructor(cfg: Config, parent: HTMLElement, onChange: () => void = () => {}) {
    this.cfg = cfg;
    this.onChange = onChange;
    this.root = document.createElement("div");
    this.root.id = "tint-timeline";
    this.root.innerHTML = `
      <div class="tt-head">
        <span class="tt-title">tint timeline</span>
        <button class="tt-play" type="button" title="play/pause">▶</button>
        <span class="tt-time">00:00</span>
        <span class="tt-hint">drag swatch · double-click strip = add · alt/right-click swatch = delete</span>
      </div>
      <canvas class="tt-strip"></canvas>
      <input type="color" class="tt-picker" />
    `;
    parent.appendChild(this.root);

    this.playBtn = this.root.querySelector(".tt-play") as HTMLButtonElement;
    this.timeLabel = this.root.querySelector(".tt-time") as HTMLSpanElement;
    this.strip = this.root.querySelector(".tt-strip") as HTMLCanvasElement;
    this.picker = this.root.querySelector(".tt-picker") as HTMLInputElement;
    this.stripCtx = this.strip.getContext("2d");

    this.playBtn.addEventListener("click", () => {
      this.cfg.tintPlaying = !this.cfg.tintPlaying;
      this.updatePlayLabel();
      this.onChange();
    });
    this.updatePlayLabel();

    this.strip.addEventListener("pointerdown", (e) => this.onPointerDown(e));
    this.strip.addEventListener("pointermove", (e) => this.onPointerMove(e));
    this.strip.addEventListener("pointerup", (e) => this.onPointerUp(e));
    this.strip.addEventListener("pointercancel", () => (this.dragging = null));
    this.strip.addEventListener("dblclick", (e) => this.onDoubleClick(e));
    // Right-click delete on a marker.
    this.strip.addEventListener("contextmenu", (e) => {
      const idx = this.hitSwatch(e.offsetX, e.offsetY);
      if (idx !== null) {
        e.preventDefault();
        this.removeSwatch(idx);
      }
    });

    this.picker.addEventListener("input", () => {
      if (this.pickingIndex === null) return;
      const i = this.pickingIndex;
      if (i >= 0 && i < this.cfg.tintSwatches.length) {
        this.cfg.tintSwatches[i].color = this.picker.value;
        this.onChange();
      }
    });
    this.picker.addEventListener("change", () => (this.pickingIndex = null));

    new ResizeObserver(() => this.resizeCanvas()).observe(this.strip);
    this.resizeCanvas();
  }

  /** Push the latest play/pause + time readout + strip render to the DOM. */
  draw(): void {
    this.updatePlayLabel();
    this.timeLabel.textContent = formatTime(this.cfg.tintTime);
    this.renderStrip();
  }

  // ---------------------------------------------------------------------------
  // Layout
  // ---------------------------------------------------------------------------
  private resizeCanvas() {
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);
    const rect = this.strip.getBoundingClientRect();
    this.strip.width = Math.max(2, Math.floor(rect.width * this.dpr));
    this.strip.height = Math.max(2, Math.floor(rect.height * this.dpr));
  }

  // ---------------------------------------------------------------------------
  // Interaction
  // ---------------------------------------------------------------------------
  private onPointerDown(e: PointerEvent) {
    const idx = this.hitSwatch(e.offsetX, e.offsetY);
    if (idx !== null) {
      if (e.altKey) {
        this.removeSwatch(idx);
        return;
      }
      this.dragging = { kind: "swatch", index: idx };
      this.strip.setPointerCapture(e.pointerId);
      // Open colour picker on simple click (handled on pointerup if no drag).
      this.pickingIndex = idx;
      return;
    }
    // Empty area -> start scrubbing playhead.
    this.dragging = { kind: "scrub" };
    this.strip.setPointerCapture(e.pointerId);
    this.scrubTo(e.offsetX);
  }

  private onPointerMove(e: PointerEvent) {
    if (!this.dragging) return;
    if (this.dragging.kind === "swatch") {
      const t = this.xToTime(e.offsetX);
      const i = this.dragging.index;
      if (i >= 0 && i < this.cfg.tintSwatches.length) {
        this.cfg.tintSwatches[i].time = clamp01(t);
        // If we actually moved, this is no longer just a click -> don't open picker.
        this.pickingIndex = null;
        this.onChange();
      }
    } else {
      this.scrubTo(e.offsetX);
    }
  }

  private onPointerUp(_e: PointerEvent) {
    const wasClickOnSwatch =
      this.dragging?.kind === "swatch" && this.pickingIndex !== null ? this.pickingIndex : null;
    this.dragging = null;
    if (wasClickOnSwatch !== null) {
      // Treat this as "open colour picker on click".
      const sw = this.cfg.tintSwatches[wasClickOnSwatch];
      if (sw) {
        this.picker.value = normaliseHex(sw.color);
        this.pickingIndex = wasClickOnSwatch;
        this.picker.click();
      }
    }
  }

  private onDoubleClick(e: MouseEvent) {
    if (this.hitSwatch(e.offsetX, e.offsetY) !== null) return;
    const t = clamp01(this.xToTime(e.offsetX));
    const color = rgb01ToHex(tintColorAt(this.cfg.tintSwatches, t));
    this.cfg.tintSwatches.push({ time: t, color });
    this.onChange();
  }

  private scrubTo(offsetX: number) {
    this.cfg.tintTime = clamp01(this.xToTime(offsetX));
    this.onChange();
  }

  private removeSwatch(i: number) {
    if (this.cfg.tintSwatches.length <= 2) return; // keep at least two
    this.cfg.tintSwatches.splice(i, 1);
    this.dragging = null;
    this.pickingIndex = null;
    this.onChange();
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------
  private cssWidth(): number {
    return this.strip.getBoundingClientRect().width || 1;
  }

  private xToTime(offsetX: number): number {
    return offsetX / this.cssWidth();
  }

  private timeToX(t: number, w: number): number {
    return t * w;
  }

  /** Returns the index of the swatch under (offsetX, offsetY), or null. */
  private hitSwatch(offsetX: number, offsetY: number): number | null {
    const w = this.cssWidth();
    const h = this.strip.getBoundingClientRect().height || 1;
    const markerY = 7; // marker centre Y (CSS px from top)
    const markerR = 6;
    // Allow generous hit area: the whole header band above the strip + a little
    // into the strip top, so markers stay easy to grab.
    if (offsetY > markerY + markerR + 6) return null;
    let best = -1;
    let bestDx = Infinity;
    for (let i = 0; i < this.cfg.tintSwatches.length; i++) {
      const x = this.timeToX(this.cfg.tintSwatches[i].time, w);
      const dx = Math.abs(x - offsetX);
      if (dx < markerR + 4 && dx < bestDx) {
        best = i;
        bestDx = dx;
      }
    }
    void h;
    return best === -1 ? null : best;
  }

  private updatePlayLabel() {
    this.playBtn.textContent = this.cfg.tintPlaying ? "❚❚" : "▶";
  }

  private renderStrip() {
    const ctx = this.stripCtx;
    if (!ctx) return;
    const dpr = this.dpr;
    const w = this.strip.width;
    const h = this.strip.height;
    ctx.save();
    ctx.scale(dpr, dpr);
    const W = w / dpr;
    const H = h / dpr;
    ctx.clearRect(0, 0, W, H);

    // Reserve room above for the swatch markers, below for the hour axis.
    const stripTop = 14;
    const stripBottom = H - 14;
    const stripH = Math.max(8, stripBottom - stripTop);

    // Background panel.
    ctx.fillStyle = "rgba(10, 12, 20, 0.6)";
    ctx.fillRect(0, 0, W, H);

    // Gradient strip: sample the interpolated tint across the day.
    const steps = Math.min(256, Math.max(64, Math.floor(W)));
    for (let i = 0; i < steps; i++) {
      const t = i / (steps - 1);
      const [r, g, b] = tintColorAt(this.cfg.tintSwatches, t);
      ctx.fillStyle = `rgb(${Math.round(r * 255)}, ${Math.round(g * 255)}, ${Math.round(b * 255)})`;
      const x0 = (i / steps) * W;
      const x1 = ((i + 1) / steps) * W;
      ctx.fillRect(x0, stripTop, x1 - x0 + 1, stripH);
    }
    // Strip border.
    ctx.strokeStyle = "rgba(255,255,255,0.18)";
    ctx.lineWidth = 1;
    ctx.strokeRect(0.5, stripTop + 0.5, W - 1, stripH - 1);

    // Hour tick marks + labels (00, 06, 12, 18, 24).
    ctx.fillStyle = "rgba(207,214,230,0.75)";
    ctx.strokeStyle = "rgba(255,255,255,0.18)";
    ctx.font = "9px ui-sans-serif, system-ui, sans-serif";
    ctx.textBaseline = "top";
    const hourLabels = [0, 3, 6, 9, 12, 15, 18, 21, 24];
    for (const hh of hourLabels) {
      const t = hh / 24;
      const x = this.timeToX(t, W);
      const isMajor = hh % 6 === 0;
      ctx.globalAlpha = isMajor ? 1 : 0.5;
      ctx.beginPath();
      ctx.moveTo(x, stripBottom);
      ctx.lineTo(x, stripBottom + (isMajor ? 5 : 3));
      ctx.stroke();
      if (isMajor) {
        const lbl = `${String(hh % 24).padStart(2, "0")}:00`;
        const tw = ctx.measureText(lbl).width;
        let lx = x - tw / 2;
        lx = Math.max(2, Math.min(W - tw - 2, lx));
        ctx.fillText(lbl, lx, stripBottom + 4);
      }
    }
    ctx.globalAlpha = 1;

    // Swatch markers — round pins planted on top of the gradient strip.
    for (let i = 0; i < this.cfg.tintSwatches.length; i++) {
      const sw = this.cfg.tintSwatches[i];
      const x = this.timeToX(sw.time, W);
      const y = 7;
      const r = 6;
      // Stem connecting the marker into the strip (so it looks anchored).
      ctx.strokeStyle = "rgba(0,0,0,0.55)";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(x, y + r);
      ctx.lineTo(x, stripTop + 2);
      ctx.stroke();
      // Body.
      ctx.fillStyle = sw.color;
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = "rgba(255,255,255,0.85)";
      ctx.lineWidth = 1.5;
      ctx.stroke();
    }

    // Playhead.
    const tx = this.timeToX(this.cfg.tintTime, W);
    ctx.strokeStyle = "#ffffff";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(tx, stripTop - 2);
    ctx.lineTo(tx, stripBottom + 2);
    ctx.stroke();
    // Playhead triangle on top.
    ctx.fillStyle = "#ffffff";
    ctx.beginPath();
    ctx.moveTo(tx - 4, stripTop - 8);
    ctx.lineTo(tx + 4, stripTop - 8);
    ctx.lineTo(tx, stripTop - 2);
    ctx.closePath();
    ctx.fill();

    ctx.restore();
  }
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

function formatTime(t: number): string {
  const tt = ((t % 1) + 1) % 1;
  const mins = Math.round(tt * 24 * 60) % (24 * 60);
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

function normaliseHex(c: string): string {
  // <input type="color"> requires a 6-digit hex.
  const h = c.replace("#", "").trim();
  if (h.length === 3) return "#" + h.split("").map((x) => x + x).join("");
  return "#" + h.padEnd(6, "0").slice(0, 6);
}

function rgb01ToHex(rgb: [number, number, number]): string {
  const to = (v: number) =>
    Math.max(0, Math.min(255, Math.round(v * 255)))
      .toString(16)
      .padStart(2, "0");
  return `#${to(rgb[0])}${to(rgb[1])}${to(rgb[2])}`;
}
