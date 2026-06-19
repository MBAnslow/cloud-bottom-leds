import * as THREE from "three";
import { defaultConfig, type Config } from "./config";
import { LedField } from "./ledField";
import { renderPattern } from "./patterns";
import { fragmentShader, vertexShader } from "./cloudShader";
import { Streamer, type StreamStatus } from "./streamer";
import { buildGui, type BuildEstimate } from "./gui";
import { getLedType, maxGrid } from "./ledTypes";
import { applyBreathing } from "./breathing";
import { BreatheViz } from "./breatheViz";

const cfg: Config = { ...defaultConfig };

// --- Three.js setup ---
const container = document.getElementById("app")!;
const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: "high-performance" });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
container.appendChild(renderer.domElement);

const scene = new THREE.Scene();
const camera = new THREE.Camera();

const ledField = new LedField(cfg);

/** LEDs spread evenly over the cloud, so pitch is derived from size / count. */
function pitchXmm(): number {
  return cfg.cloudWidthMm / Math.max(1, cfg.cols);
}
function pitchYmm(): number {
  return cfg.cloudHeightMm / Math.max(1, cfg.rows);
}

/**
 * Convert the physical build parameters into the light-spread std-dev that the
 * shader uses, expressed in LED-pitch (cell) units, per axis.
 *
 *   sigma_mm = sqrt( (distance * spreadCoeff)^2 + haze^2 )
 *
 * spreadCoeff (from the LED type, ~0.5 = effective ~27deg half-angle) is the
 * geometric spread of the cone of light between the LED and the diffuser; the
 * diffuser's own haze adds in quadrature (gaussian convolution). Dividing by
 * the per-axis pitch gives the overlap with neighbours, which governs uniformity.
 */
// Max per-axis sigma in cell units. Must satisfy 3.3 * SIGMA_MAX <= shader R
// so the gaussian window never truncates the spot (which would make it oval).
const SIGMA_MAX = 3.0;
function computeSigma(out: THREE.Vector2) {
  const led = getLedType(cfg.ledType);
  // Light spread is isotropic in millimetres. The spot can't be smaller than the
  // LED's own emitting die, so floor the spread as a single SCALAR in mm. Doing
  // the floor here (not per-axis on sx/sy) is critical: flooring sx and sy
  // independently would lift only the small-sigma axis at low haze and stretch
  // the spot into an oval. A scalar floor keeps it perfectly round.
  const minSigmaMm = Math.max(0.5, led.ledSizeMm * 0.25);
  const sigmaMm = Math.max(
    minSigmaMm,
    Math.hypot(cfg.ledDistanceMm * led.spreadCoeff, cfg.diffuserScatterMm)
  );
  // Per-axis cell sigma differs only because the pitch differs; on the
  // correctly-proportioned panel the spot still renders round.
  let sx = sigmaMm / pitchXmm();
  let sy = sigmaMm / pitchYmm();
  // Clamp both axes by the SAME factor so the rendered blob never stretches
  // (scaling both equally preserves the round shape in screen space).
  const peak = Math.max(sx, sy);
  if (peak > SIGMA_MAX) {
    const s = SIGMA_MAX / peak;
    sx *= s;
    sy *= s;
  }
  out.set(sx, sy);
}

const uniforms: Record<string, THREE.IUniform> = {
  uResolution: { value: new THREE.Vector2(1, 1) },
  uTime: { value: 0 },
  uLeds: { value: ledField.texture },
  uCols: { value: cfg.cols },
  uRows: { value: cfg.rows },
  uCloudAspect: { value: cfg.cloudWidthMm / cfg.cloudHeightMm },
  uSigma: { value: new THREE.Vector2(1, 1) },
  uLedGain: { value: cfg.ledBrightness },
  uWhiteMix: { value: 0 },
  uTransmission: { value: 1 - cfg.opacity / 100 },
  uBumpHeight: { value: cfg.bumpHeight },
  uBumpScale: { value: cfg.bumpScale },
  uBumpDetail: { value: cfg.bumpDetail },
  uAmbient: { value: cfg.ambient },
  uBackground: { value: cfg.backgroundTint },
};
computeSigma(uniforms.uSigma.value as THREE.Vector2);

const material = new THREE.ShaderMaterial({
  uniforms,
  vertexShader,
  fragmentShader,
  depthTest: false,
  depthWrite: false,
});
const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), material);
quad.frustumCulled = false;
scene.add(quad);

// --- Streaming ---
const streamer = new Streamer();
const streamDot = document.getElementById("hud-stream-dot")!;
const streamLabel = document.getElementById("hud-stream")!;
streamer.onStatus = (s: StreamStatus, detail?: string) => {
  streamDot.className = "dot" + (s === "on" ? " on" : s === "error" ? " err" : "");
  const text = s === "on" ? `streaming -> ${cfg.wledHost}` : s === "connecting" ? "connecting..." : s === "error" ? `error: ${detail ?? ""}` : "off";
  streamLabel.textContent = "stream: " + text;
};

function applyStreaming() {
  if (cfg.streamEnabled) {
    streamer.connect(cfg, ledField.count);
  } else {
    streamer.disconnect();
  }
}

// --- Build estimate (what to buy) ---
const estimate: BuildEstimate = {
  size: "",
  totalLeds: "",
  pitch: "",
  rowDensity: "",
  amount: "",
  fit: "",
  capacity: "",
};

function updateEstimate() {
  const led = getLedType(cfg.ledType);
  const count = cfg.rows * cfg.cols;
  const px = pitchXmm();
  const py = pitchYmm();
  const neededDensity = 1000 / px; // LEDs per metre along a row
  const stripLenM = (cfg.rows * cfg.cloudWidthMm) / 1000;

  estimate.size = `${(cfg.cloudWidthMm / 10).toFixed(0)} × ${(cfg.cloudHeightMm / 10).toFixed(0)} cm`;
  estimate.totalLeds = `${count}  (${cfg.cols} × ${cfg.rows})`;
  estimate.pitch = `${px.toFixed(1)} × ${py.toFixed(1)} mm`;
  estimate.rowDensity = `${neededDensity.toFixed(1)} LED/m along rows`;
  estimate.amount =
    led.form === "strip"
      ? `${stripLenM.toFixed(2)} m of strip (${cfg.rows} × ${(cfg.cloudWidthMm / 1000).toFixed(2)} m)`
      : `${count} pixel nodes on wire`;

  if (led.form === "node") {
    estimate.fit = "OK — nodes mount at any spacing";
  } else if (neededDensity > led.maxDensityPerM + 0.5) {
    estimate.fit = `too dense: needs ${neededDensity.toFixed(0)}/m > ${led.maxDensityPerM}/m max`;
  } else {
    estimate.fit = `OK on a ${led.maxDensityPerM}/m strip (use every Nth LED)`;
  }

  const { maxCols, maxRows } = maxGrid(cfg.ledType, cfg.cloudWidthMm, cfg.cloudHeightMm);
  const atCap = cfg.cols >= maxCols || cfg.rows >= maxRows;
  estimate.capacity = `${maxCols} × ${maxRows} max${atCap ? "  (at physical limit)" : ""}`;
}
updateEstimate();

// --- GUI ---
buildGui(cfg, estimate, {
  onLayoutChange: () => {
    ledField.resize(cfg);
    uniforms.uLeds.value = ledField.texture;
    uniforms.uCols.value = cfg.cols;
    uniforms.uRows.value = cfg.rows;
    updateEstimate();
    if (cfg.streamEnabled) streamer.reconfigure(cfg, ledField.count);
  },
  onStreamToggle: applyStreaming,
  onStreamReconfigure: () => streamer.reconfigure(cfg, ledField.count),
});

// --- Resize ---
function onResize() {
  const w = window.innerWidth;
  const h = window.innerHeight;
  renderer.setSize(w, h, false);
  (uniforms.uResolution.value as THREE.Vector2).set(
    w * renderer.getPixelRatio(),
    h * renderer.getPixelRatio()
  );
}
window.addEventListener("resize", onResize);
onResize();

// --- Breathing oscilloscope (left panel) ---
const breathePanel = document.getElementById("breathe-panel")!;
const breatheViz = new BreatheViz(
  document.getElementById("breathe-viz") as HTMLCanvasElement
);

// --- HUD ---
const hudGrid = document.getElementById("hud-grid")!;
const hudFps = document.getElementById("hud-fps")!;
let fpsAccum = 0;
let fpsFrames = 0;
let fpsTimer = 0;

// --- Render loop ---
const clock = new THREE.Clock();
// The pattern advances on its own fixed-rate clock so we can simulate the real
// controller's animation refresh (e.g. choppy at 15 fps, smooth at 60).
let patternTime = 0;
let patternAccum = 0;
let dirty = true; // LED colors changed -> re-upload + (maybe) stream

// Cap rendering at 60fps; there's nothing to gain past it (the diffuser is
// static and the pattern has its own update rate), so skip extra frames on
// high-refresh displays. The tolerance keeps a true 60Hz display from
// occasionally dropping to 30fps due to scheduling jitter.
const RENDER_INTERVAL_MS = 1000 / 60;
const RENDER_TOLERANCE_MS = 3;
let lastRenderMs = -Infinity;

function frame() {
  const now = performance.now();
  if (now - lastRenderMs < RENDER_INTERVAL_MS - RENDER_TOLERANCE_MS) {
    requestAnimationFrame(frame);
    return;
  }
  lastRenderMs = now;

  const dt = Math.min(clock.getDelta(), 0.05);

  // 1) advance the pattern only at the configured update rate (source of truth)
  const step = 1 / Math.max(1, cfg.patternFps);
  patternAccum += dt;
  let steps = 0;
  while (patternAccum >= step && steps < 8) {
    patternTime += step;
    patternAccum -= step;
    renderPattern(ledField.colors, patternTime, step, cfg);
    // Bake the per-partition breathing pulse onto the same buffer, so the
    // visual and the streamed hardware frames stay identical.
    applyBreathing(ledField.colors, patternTime, cfg);
    dirty = true;
    steps++;
  }

  // 2) feed the visualizer (rendered every frame for a smooth, static diffuser)
  if (dirty) ledField.uploadToTexture();
  const led = getLedType(cfg.ledType);
  uniforms.uTime.value = patternTime;
  uniforms.uCloudAspect.value = cfg.cloudWidthMm / Math.max(1, cfg.cloudHeightMm);
  computeSigma(uniforms.uSigma.value as THREE.Vector2);
  updateEstimate();
  uniforms.uLedGain.value = cfg.ledBrightness * led.relBrightness;
  uniforms.uWhiteMix.value = led.rgbw ? 0.35 : 0;
  uniforms.uTransmission.value = 1 - cfg.opacity / 100;
  uniforms.uBumpHeight.value = cfg.bumpHeight;
  uniforms.uBumpScale.value = cfg.bumpScale;
  uniforms.uBumpDetail.value = cfg.bumpDetail;
  uniforms.uAmbient.value = cfg.ambient;
  uniforms.uBackground.value = cfg.backgroundTint;
  renderer.render(scene, camera);

  // breathing readout on the left
  breathePanel.classList.toggle("hidden", !cfg.breatheEnabled);
  if (cfg.breatheEnabled) breatheViz.draw(cfg, patternTime);

  // 3) stream to hardware at the configured data rate
  if (cfg.streamEnabled && streamer.isOpen && dirty) {
    streamer.sendFrame(ledField.toBytes(cfg.wiring), cfg.streamFps, now);
  }
  dirty = false;

  // HUD
  fpsAccum += dt;
  fpsFrames++;
  fpsTimer += dt;
  if (fpsTimer >= 0.5) {
    const fps = fpsFrames / fpsAccum;
    const sig = uniforms.uSigma.value as THREE.Vector2;
    const wCm = cfg.cloudWidthMm / 10;
    const hCm = cfg.cloudHeightMm / 10;
    hudFps.textContent = `${fps.toFixed(0)} fps render · ${cfg.patternFps} fps pattern · ${ledField.count} LEDs`;
    const evenness = sig.x >= 1.0 ? "even" : sig.x >= 0.6 ? "soft dots" : "hotspots";
    hudGrid.textContent =
      `${cfg.cols}×${cfg.rows} · ${wCm.toFixed(0)}×${hCm.toFixed(0)} cm · ` +
      `spread ${sig.x.toFixed(2)} pitch (${evenness}) · ${cfg.pattern}`;
    fpsAccum = 0;
    fpsFrames = 0;
    fpsTimer = 0;
  }

  requestAnimationFrame(frame);
}
frame();
