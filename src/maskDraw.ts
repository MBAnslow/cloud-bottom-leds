import { setMaskData } from "./mask";

/**
 * A small paint grid for drawing your own mask. Left-drag paints "on" (white),
 * erase mode (or Shift / right button) paints "off". Every stroke pushes the
 * grid straight into the live mask via setMaskData, so the mask layout updates
 * as you draw. The drawn grid is binary; the "overlap (soft edges)" control
 * feathers the edges when it is sampled.
 */
export class MaskDraw {
  private grid: Float32Array;
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private painting = false;
  private erase = false;

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

    const clearBtn = document.createElement("button");
    clearBtn.type = "button";
    clearBtn.textContent = "clear";
    clearBtn.style.cssText = eraseBtn.style.cssText;
    clearBtn.addEventListener("click", () => {
      this.grid.fill(0);
      this.render();
      this.commit();
    });

    head.append(label, eraseBtn, clearBtn);

    this.canvas = document.createElement("canvas");
    this.canvas.width = 256;
    this.canvas.height = 256;
    this.canvas.style.cssText =
      "width:100%;aspect-ratio:1;display:block;border-radius:8px;border:1px solid rgba(255,255,255,0.12);background:#0a0c14;cursor:crosshair;touch-action:none;";
    this.ctx = this.canvas.getContext("2d")!;

    this.canvas.addEventListener("contextmenu", (e) => e.preventDefault());
    this.canvas.addEventListener("pointerdown", (e) => {
      this.painting = true;
      this.canvas.setPointerCapture(e.pointerId);
      this.paintAt(e, e.button === 2 || e.shiftKey);
    });
    this.canvas.addEventListener("pointermove", (e) => {
      if (this.painting) this.paintAt(e, e.button === 2 || e.shiftKey);
    });
    const stop = () => {
      if (this.painting) {
        this.painting = false;
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
    const cx = Math.floor(((e.clientX - r.left) / r.width) * this.n);
    const cy = Math.floor(((e.clientY - r.top) / r.height) * this.n);
    const on = !(this.erase || forceErase);
    // small 2x2 brush for nicer strokes
    for (let dy = 0; dy <= 1; dy++) {
      for (let dx = 0; dx <= 1; dx++) {
        const x = cx + dx;
        const y = cy + dy;
        if (x >= 0 && x < this.n && y >= 0 && y < this.n) {
          this.grid[y * this.n + x] = on ? 1 : 0;
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
          ctx.fillStyle = "#e8edff";
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
