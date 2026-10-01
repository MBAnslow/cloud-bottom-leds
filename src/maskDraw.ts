import { setMaskData } from "./mask";

/**
 * A small paint grid for drawing your own mask. Left-drag paints "on" (white),
 * erase mode (or Shift / right button) paints "off". Every stroke pushes the
 * grid straight into the live mask via setMaskData, so the mask layout updates
 * as you draw. The grid stores luminance (0..1), so soft brushes can paint
 * feathered mask values directly.
 */
export class MaskDraw {
  private grid: Float32Array;
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private painting = false;
  private erase = false;
  private strokeErase = false;
  private softBrush = true;
  private brushRadius = 2.25; // in grid cells
  // Low-flow brush so intensity builds gradually over multiple passes.
  private softFlow = 0.07; // per dab in soft mode
  private hardFlow = 0.18; // per dab in hard mode

  constructor(
    parent: HTMLElement,
    private onPaint: () => void,
    private n = 32
  ) {
    this.grid = new Float32Array(this.n * this.n);

    const wrap = document.createElement("div");
    wrap.style.padding = "4px 6px 8px";

    const head = document.createElement("div");
    head.style.cssText =
      "display:flex;align-items:center;gap:8px;margin-bottom:6px;font-size:11px;color:#8b93a7;";
    const label = document.createElement("span");
    label.textContent = "draw mask";
    label.style.cssText = "text-transform:uppercase;letter-spacing:0.06em;";

    const eraseBtn = document.createElement("button");
    eraseBtn.type = "button";
    eraseBtn.textContent = "draw";
    eraseBtn.style.cssText =
      "border:1px solid rgba(255,255,255,0.15);background:rgba(255,255,255,0.06);color:#cfd6e6;border-radius:6px;padding:2px 8px;cursor:pointer;font-size:11px;";
    eraseBtn.addEventListener("click", () => {
      this.erase = !this.erase;
      eraseBtn.textContent = this.erase ? "erase" : "draw";
    });

    const softBtn = document.createElement("button");
    softBtn.type = "button";
    softBtn.style.cssText = eraseBtn.style.cssText;
    const syncSoftBtn = () => {
      softBtn.textContent = this.softBrush ? "soft" : "hard";
      softBtn.style.background = this.softBrush
        ? "rgba(160,220,255,0.2)"
        : "rgba(255,255,255,0.06)";
    };
    syncSoftBtn();
    softBtn.addEventListener("click", () => {
      this.softBrush = !this.softBrush;
      syncSoftBtn();
    });

    const sizeWrap = document.createElement("label");
    sizeWrap.style.cssText =
      "display:flex;align-items:center;gap:6px;color:#8b93a7;font-size:10px;letter-spacing:0.05em;text-transform:uppercase;";
    sizeWrap.textContent = "size";
    const sizeInput = document.createElement("input");
    sizeInput.type = "range";
    sizeInput.min = "1";
    sizeInput.max = "6";
    sizeInput.step = "0.25";
    sizeInput.value = String(this.brushRadius);
    sizeInput.style.width = "70px";
    sizeInput.addEventListener("input", () => {
      this.brushRadius = Math.max(0.5, Number(sizeInput.value) || 2.25);
    });
    sizeWrap.appendChild(sizeInput);

    const clearBtn = document.createElement("button");
    clearBtn.type = "button";
    clearBtn.textContent = "clear";
    clearBtn.style.cssText = eraseBtn.style.cssText;
    clearBtn.addEventListener("click", () => {
      this.grid.fill(0);
      this.render();
      this.commit();
    });

    head.append(label, eraseBtn, softBtn, sizeWrap, clearBtn);

    this.canvas = document.createElement("canvas");
    this.canvas.width = 256;
    this.canvas.height = 256;
    this.canvas.style.cssText =
      "width:100%;aspect-ratio:1;display:block;border-radius:8px;border:1px solid rgba(255,255,255,0.12);background:#0a0c14;cursor:crosshair;touch-action:none;";
    this.ctx = this.canvas.getContext("2d")!;

    this.canvas.addEventListener("contextmenu", (e) => e.preventDefault());
    this.canvas.addEventListener("pointerdown", (e) => {
      this.painting = true;
      this.strokeErase = this.erase || e.button === 2 || e.shiftKey;
      this.canvas.setPointerCapture(e.pointerId);
      this.paintAt(e, this.strokeErase);
    });
    this.canvas.addEventListener("pointermove", (e) => {
      if (!this.painting) return;
      const shiftErase = e.shiftKey;
      const rightErase = (e.buttons & 2) !== 0;
      this.paintAt(e, this.strokeErase || shiftErase || rightErase);
    });
    const stop = () => {
      if (this.painting) {
        this.painting = false;
        this.strokeErase = false;
        this.commit();
      }
    };
    this.canvas.addEventListener("pointerup", stop);
    this.canvas.addEventListener("pointercancel", stop);
    this.canvas.addEventListener("pointerleave", stop);

    wrap.append(head, this.canvas);
    parent.appendChild(wrap);
    this.render();
  }

  private paintAt(e: PointerEvent, forceErase: boolean) {
    const r = this.canvas.getBoundingClientRect();
    const px = ((e.clientX - r.left) / r.width) * this.n;
    const py = ((e.clientY - r.top) / r.height) * this.n;
    const eraseNow = this.erase || forceErase;
    const radius = Math.max(0.5, this.brushRadius);
    const minX = Math.max(0, Math.floor(px - radius - 1));
    const maxX = Math.min(this.n - 1, Math.ceil(px + radius + 1));
    const minY = Math.max(0, Math.floor(py - radius - 1));
    const maxY = Math.min(this.n - 1, Math.ceil(py + radius + 1));

    for (let y = minY; y <= maxY; y++) {
      for (let x = minX; x <= maxX; x++) {
        const dx = x + 0.5 - px;
        const dy = y + 0.5 - py;
        const d = Math.hypot(dx, dy);
        if (d > radius) continue;
        let w: number;
        if (this.softBrush) {
          const t = d / radius;
          // Gentle gaussian-like falloff for very soft edges.
          w = Math.exp(-4.8 * t * t);
        } else {
          w = 1;
        }
        const flow = this.softBrush ? this.softFlow : this.hardFlow;
        const k = w * flow;
        const i = y * this.n + x;
        if (eraseNow) {
          this.grid[i] = clamp01(this.grid[i] - k);
        } else {
          this.grid[i] = clamp01(this.grid[i] + k);
        }
      }
    }
    this.render();
  }

  private render() {
    const ctx = this.ctx;
    const W = this.canvas.width;
    const cell = W / this.n;
    ctx.clearRect(0, 0, W, W);
    ctx.fillStyle = "#0a0c14";
    ctx.fillRect(0, 0, W, W);
    for (let y = 0; y < this.n; y++) {
      for (let x = 0; x < this.n; x++) {
        const v = this.grid[y * this.n + x];
        if (v > 0) {
          const alpha = Math.min(1, Math.max(0, v));
          ctx.fillStyle = `rgba(232,237,255,${alpha.toFixed(3)})`;
          ctx.fillRect(x * cell, y * cell, cell, cell);
        }
      }
    }
    // faint grid lines
    ctx.strokeStyle = "rgba(255,255,255,0.06)";
    ctx.lineWidth = 1;
    for (let i = 0; i <= this.n; i += 4) {
      ctx.beginPath();
      ctx.moveTo(i * cell, 0);
      ctx.lineTo(i * cell, W);
      ctx.moveTo(0, i * cell);
      ctx.lineTo(W, i * cell);
      ctx.stroke();
    }
  }

  private commit() {
    setMaskData(this.grid, this.n, this.n);
    this.onPaint();
  }

  /** Reset the grid (e.g. when the mask is cleared elsewhere). */
  clear() {
    this.grid.fill(0);
    this.render();
  }
}

function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}
