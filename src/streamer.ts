import type { Config } from "./config";

export type StreamStatus = "off" | "connecting" | "on" | "error";

/**
 * Normalise a user-entered WLED address to a bare host for UDP. Accepts pasted
 * values like `http://10.0.4.54/` or `10.0.4.54:80` and returns `10.0.4.54`,
 * since UDP `getaddrinfo` needs a hostname/IP, not a URL.
 */
export function cleanHost(raw: string): string {
  let h = (raw || "").trim();
  h = h.replace(/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//, ""); // strip scheme (http://)
  h = h.replace(/\/.*$/, ""); // strip any path
  h = h.replace(/:\d+$/, ""); // strip port (UDP port is a separate field)
  return h;
}

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
  private shouldConnect = false;
  private targetCfg: Config | null = null;
  private targetCount = 0;
  private reconnectTimer: number | null = null;
  private reconnectDelayMs = 1000;
  onStatus: (s: StreamStatus, detail?: string) => void = () => {};

  get isOpen(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  connect(cfg: Config, count: number) {
    this.shouldConnect = true;
    this.targetCfg = cfg;
    this.targetCount = count;
    this.clearReconnectTimer();
    this.closeSocket();
    this.setStatus("connecting", "opening bridge socket");
    this.openSocket();
  }

  private openSocket() {
    if (!this.shouldConnect || !this.targetCfg) return;
    try {
      const ws = new WebSocket(this.targetCfg.bridgeUrl);
      ws.binaryType = "arraybuffer";
      this.ws = ws;

      ws.onopen = () => {
        ws.send(
          JSON.stringify({
            type: "config",
            host: cleanHost(this.targetCfg!.wledHost),
            port: this.targetCfg!.wledPort,
            count: this.targetCount,
          })
        );
        this.setStatus("on");
      };
      ws.onclose = () => {
        this.ws = null;
        if (!this.shouldConnect) {
          if (this.status !== "off") this.setStatus("off");
          return;
        }
        this.setStatus("connecting", "bridge disconnected, retrying…");
        this.scheduleReconnect();
      };
      ws.onerror = () => this.setStatus("error", "cannot reach bridge");
    } catch (e) {
      this.setStatus("error", String(e));
      this.scheduleReconnect();
    }
  }

  /** Re-send the target config (e.g. WLED host changed) without reconnecting. */
  reconfigure(cfg: Config, count: number) {
    this.targetCfg = cfg;
    this.targetCount = count;
    if (!this.isOpen) return;
    this.ws!.send(
      JSON.stringify({
        type: "config",
        host: cleanHost(cfg.wledHost),
        port: cfg.wledPort,
        count,
      })
    );
  }

  /** Throttled binary frame send. */
  sendFrame(bytes: Uint8Array, fps: number, now: number) {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    // Real-time priority: if the socket already has queued bytes, skip this
    // frame so we don't accumulate seconds of stale frames.
    if (ws.bufferedAmount > bytes.length) return;
    const interval = 1000 / Math.max(1, fps);
    if (now - this.lastSend < interval) return;
    // copy out of the shared buffer before handing to the socket
    ws.send(bytes.slice().buffer);
    this.lastSend = now;
  }

  disconnect() {
    this.shouldConnect = false;
    this.clearReconnectTimer();
    this.closeSocket();
    this.setStatus("off");
  }

  private closeSocket() {
    if (!this.ws) return;
    try {
      this.ws.close();
    } catch {
      /* ignore */
    }
    this.ws = null;
  }

  private scheduleReconnect() {
    if (!this.shouldConnect || this.reconnectTimer !== null) return;
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = null;
      if (!this.shouldConnect) return;
      this.openSocket();
    }, this.reconnectDelayMs);
  }

  private clearReconnectTimer() {
    if (this.reconnectTimer === null) return;
    window.clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
  }

  private setStatus(s: StreamStatus, detail?: string) {
    this.status = s;
    this.onStatus(s, detail);
  }
}
