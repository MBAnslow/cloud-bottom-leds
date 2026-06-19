import { createServer } from "node:http";
import dgram from "node:dgram";
import express from "express";
import { WebSocketServer } from "ws";

/**
 * Bridge server: accepts LED frames from the browser over WebSocket and relays
 * them to a WLED controller using its real-time UDP protocol (DNRGB, port 21324).
 *
 * Why this exists: browsers cannot send raw UDP. The simulator computes frames
 * and this process forwards the exact same bytes to the physical strips.
 *
 *   WLED DNRGB packet:
 *     [0]=4 (DNRGB), [1]=timeout(s), [2]=startHi, [3]=startLo, then RGB...
 *   WLED applies the frame, and reverts to its normal mode after `timeout`s of
 *   no packets. We chunk at 489 LEDs/packet to stay within WLED's UDP buffer.
 */

const HTTP_PORT = Number(process.env.PORT ?? 8081);
const DNRGB = 4;
const REALTIME_TIMEOUT_S = 2;
const MAX_LEDS_PER_PACKET = 489;

const app = express();
app.use(express.static("dist")); // serves a production build if present
app.get("/health", (_req, res) => res.json({ ok: true }));

const server = createServer(app);
const wss = new WebSocketServer({ server });
const udp = dgram.createSocket("udp4");

wss.on("connection", (ws, req) => {
  const peer = req.socket.remoteAddress;
  let target = { host: null, port: 21324, count: 0 };
  let frames = 0;
  console.log(`[ws] client connected from ${peer}`);

  ws.on("message", (data, isBinary) => {
    if (!isBinary) {
      try {
        const msg = JSON.parse(data.toString());
        if (msg.type === "config") {
          target = {
            host: msg.host,
            port: Number(msg.port) || 21324,
            count: Number(msg.count) || 0,
          };
          console.log(`[ws] target -> ${target.host}:${target.port} (${target.count} LEDs)`);
        }
      } catch (err) {
        console.warn("[ws] bad JSON message:", err.message);
      }
      return;
    }

    if (!target.host) return; // not configured yet
    const rgb = Buffer.from(data);
    sendToWled(rgb, target);
    frames++;
    if (frames % 200 === 0) console.log(`[udp] sent ${frames} frames to ${target.host}`);
  });

  ws.on("close", () => console.log(`[ws] client ${peer} disconnected`));
  ws.on("error", (err) => console.warn(`[ws] error: ${err.message}`));
});

function sendToWled(rgb, target) {
  const totalLeds = Math.floor(rgb.length / 3);
  for (let start = 0; start < totalLeds; start += MAX_LEDS_PER_PACKET) {
    const ledsInPacket = Math.min(MAX_LEDS_PER_PACKET, totalLeds - start);
    const header = Buffer.from([
      DNRGB,
      REALTIME_TIMEOUT_S,
      (start >> 8) & 0xff,
      start & 0xff,
    ]);
    const body = rgb.subarray(start * 3, (start + ledsInPacket) * 3);
    const packet = Buffer.concat([header, body]);
    udp.send(packet, target.port, target.host, (err) => {
      if (err) console.warn(`[udp] send error: ${err.message}`);
    });
  }
}

server.listen(HTTP_PORT, () => {
  console.log(`Cloud Bottom LEDs bridge listening on http://localhost:${HTTP_PORT}`);
  console.log(`WebSocket endpoint: ws://localhost:${HTTP_PORT}`);
});

process.on("SIGINT", () => {
  console.log("\nshutting down bridge...");
  udp.close();
  wss.close();
  server.close(() => process.exit(0));
});
