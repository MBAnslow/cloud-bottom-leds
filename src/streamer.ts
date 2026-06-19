import type { Config } from "./config";

export type StreamStatus = "off" | "connecting" | "on" | "error";

/**
 * Sends LED frames to the local bridge server over a WebSocket. The bridge
 * relays them to a WLED controller via UDP (browsers cannot send UDP directly).
 *
 * Protocol:
 *   - first message (JSON): { type: "config", host, port, count }
 *   - subsequent messages (binary): raw RGB bytes (3 * count)
 */
export class Streamer {
  private ws: WebSocket | null = null;
  private lastSend = 0;
  private status: StreamStatus = "off";
  onStatus: (s: StreamStatus, detail?: string) => void = () => {};

  get isOpen(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  connect(cfg: Config, count: number) {
    this.disconnect();
    this.setStatus("connecting");
    try {
      const ws = new WebSocket(cfg.bridgeUrl);
      ws.binaryType = "arraybuffer";
      this.ws = ws;

      ws.onopen = () => {
        ws.send(
          JSON.stringify({
            type: "config",
            host: cfg.wledHost,
            port: cfg.wledPort,
            count,
          })
        );
        this.setStatus("on");
      };
      ws.onclose = () => {
        if (this.status !== "off") this.setStatus("off");
        this.ws = null;
      };
      ws.onerror = () => this.setStatus("error", "cannot reach bridge");
    } catch (e) {
      this.setStatus("error", String(e));
    }
  }

  /** Re-send the target config (e.g. WLED host changed) without reconnecting. */
  reconfigure(cfg: Config, count: number) {
    if (!this.isOpen) return;
    this.ws!.send(
      JSON.stringify({
        type: "config",
        host: cfg.wledHost,
        port: cfg.wledPort,
        count,
      })
    );
  }

  /** Throttled binary frame send. */
  sendFrame(bytes: Uint8Array, fps: number, now: number) {
    if (!this.isOpen) return;
    const interval = 1000 / Math.max(1, fps);
    if (now - this.lastSend < interval) return;
    this.lastSend = now;
    // copy out of the shared buffer before handing to the socket
    this.ws!.send(bytes.slice().buffer);
  }

  disconnect() {
    if (this.ws) {
      try {
        this.ws.close();
      } catch {
        /* ignore */
      }
      this.ws = null;
    }
    this.setStatus("off");
  }

  private setStatus(s: StreamStatus, detail?: string) {
    this.status = s;
    this.onStatus(s, detail);
  }
}
