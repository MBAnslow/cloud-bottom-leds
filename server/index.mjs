import { createServer } from "node:http";
import dgram from "node:dgram";
import express from "express";
import { WebSocketServer } from "ws";

/**
 * Bridge server: accepts LED frames from the browser over WebSocket and relays
 * them to a WLED controller using DDP over UDP.
 *
 * Why this exists: browsers cannot send raw UDP. The simulator computes frames
 * and this process forwards the exact same bytes to the physical strips.
 *
 * DDP packet (10-byte header + RGB payload):
 *   [0] flags1 (version=1 in bits 7..6, PUSH bit in bit0)
 *   [1] flags2 (unused)
 *   [2] data type (1 = RGB data)
 *   [3] destination id (1)
 *   [4..7] data offset (bytes, big-endian)
 *   [8..9] data length (bytes, big-endian)
 *   [10..] RGB data bytes
 */

const HTTP_PORT = Number(process.env.PORT ?? 8081);
const DDP_PORT = 4048;
const DDP_TYPE_DATA = 0x01;
const DDP_DEST_ID = 0x01;
const DDP_FLAGS_VERSION_1 = 0x40;
const DDP_FLAGS_PUSH = 0x01;
// Keep payload under common Ethernet MTU once UDP/IP headers are added.
const MAX_DDP_PAYLOAD_BYTES = 1440;

const app = express();
app.use(express.static("dist")); // serves a production build if present
app.get("/health", (_req, res) => res.json({ ok: true }));

const server = createServer(app);
const wss = new WebSocketServer({ server });
const udp = dgram.createSocket("udp4");

wss.on("connection", (ws, req) => {
  const peer = req.socket.remoteAddress;
  let target = { host: null, port: DDP_PORT, count: 0 };
  let frames = 0;
  let latestFrame = null;
  let frameDirty = false;
  console.log(`[ws] client connected from ${peer}`);

  // Low-latency relay: always send only the newest frame.
  const tick = setInterval(() => {
    if (!target.host || !frameDirty || !latestFrame) return;
    sendToWledDdp(latestFrame, target);
    frameDirty = false;
    frames++;
    if (frames % 200 === 0) console.log(`[ddp] sent ${frames} frames to ${target.host}`);
  }, 1000 / 60);

  ws.on("message", (data, isBinary) => {
    if (!isBinary) {
      try {
        const msg = JSON.parse(data.toString());
        if (msg.type === "config") {
          target = {
            host: msg.host,
            port: Number(msg.port) || DDP_PORT,
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
    // Overwrite any unsent frame so stale frames cannot queue up.
    latestFrame = Buffer.from(data);
    frameDirty = true;
  });

  ws.on("close", () => {
    clearInterval(tick);
    console.log(`[ws] client ${peer} disconnected`);
  });
  ws.on("error", (err) => console.warn(`[ws] error: ${err.message}`));
});

function sendToWledDdp(rgb, target) {
  const total = rgb.length;
  for (let start = 0; start < total; start += MAX_DDP_PAYLOAD_BYTES) {
    const chunkLen = Math.min(MAX_DDP_PAYLOAD_BYTES, total - start);
    const isLast = start + chunkLen >= total;
    const packet = Buffer.allocUnsafe(10 + chunkLen);
    packet[0] = DDP_FLAGS_VERSION_1 | (isLast ? DDP_FLAGS_PUSH : 0);
    packet[1] = 0x00;
    packet[2] = DDP_TYPE_DATA;
    packet[3] = DDP_DEST_ID;
    packet.writeUInt32BE(start, 4);
    packet.writeUInt16BE(chunkLen, 8);
    rgb.copy(packet, 10, start, start + chunkLen);
    udp.send(packet, target.port, target.host, (err) => {
      if (err) console.warn(`[ddp] send error: ${err.message}`);
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
