// Standalone end-to-end check: WS client -> bridge -> UDP listener.
// Run the bridge first (npm run server), then: node server/test-bridge.mjs
import dgram from "node:dgram";
import { WebSocket } from "ws";

const UDP_PORT = 21399;
const BRIDGE = "ws://localhost:8081";

const udp = dgram.createSocket("udp4");
udp.on("message", (msg) => {
  console.log(
    `UDP received ${msg.length} bytes; header=[${msg[0]},${msg[1]},${msg[2]},${msg[3]}] firstLED=(${msg[4]},${msg[5]},${msg[6]})`
  );
  console.log(msg[0] === 4 ? "PASS: DNRGB packet relayed correctly" : "FAIL: unexpected protocol byte");
  udp.close();
  process.exit(0);
});
udp.bind(UDP_PORT, "127.0.0.1", () => {
  const ws = new WebSocket(BRIDGE);
  ws.binaryType = "arraybuffer";
  ws.on("open", () => {
    ws.send(JSON.stringify({ type: "config", host: "127.0.0.1", port: UDP_PORT, count: 3 }));
    const frame = new Uint8Array([255, 0, 0, 0, 255, 0, 0, 0, 255]); // R, G, B
    setTimeout(() => ws.send(frame.buffer), 100);
  });
  ws.on("error", (e) => {
    console.error("WS error (is the bridge running?):", e.message);
    process.exit(1);
  });
});

setTimeout(() => {
  console.error("FAIL: no UDP packet received within 3s");
  process.exit(1);
}, 3000);
