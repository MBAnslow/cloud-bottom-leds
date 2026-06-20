import * as THREE from "three";
import { defaultConfig, type Config } from "./config";
import { LedField } from "./ledField";
import { renderPattern } from "./patterns";
import { fragmentShader, vertexShader } from "./cloudShader";
import { Streamer, type StreamStatus } from "./streamer";
import { buildGui } from "./gui";
import { getLedType } from "./ledTypes";
import { applyBreathing, renderPartitionSolo, partitionCount } from "./breathing";
import { BreatheViz } from "./breatheViz";
import { MaskOverlay } from "./maskOverlay";

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

// --- GUI ---
buildGui(cfg, {
  onLayoutChange: () => {
    ledField.resize(cfg);
    uniforms.uLeds.value = ledField.texture;
    uniforms.uCols.value = cfg.cols;
    uniforms.uRows.value = cfg.rows;
    if (cfg.streamEnabled) streamer.reconfigure(cfg, ledField.count);
  },
  onStreamToggle: applyStreaming,
  onStreamReconfigure: () => streamer.reconfigure(cfg, ledField.count),
});

// --- Resize ---
// The cloud canvas fills its (#app) container, which is inset from the side
// menus and the bottom oscilloscope, so the cloud stays centred and clear of
// the UI. Size the renderer to the container, not the whole window.
function onResize() {
  const w = Math.max(1, container.clientWidth);
  const h = Math.max(1, container.clientHeight);
  renderer.setSize(w, h, false);
  (uniforms.uResolution.value as THREE.Vector2).set(
    w * renderer.getPixelRatio(),
    h * renderer.getPixelRatio()
  );
}
window.addEventListener("resize", onResize);
// Track container size changes (e.g. the bottom inset is a vh value).
new ResizeObserver(onResize).observe(container);
onResize();

// --- Breathing oscilloscope (bottom-centre panel) ---
const breathePanel = document.getElementById("breathe-panel")!;
const vizCanvas = document.getElementById("breathe-viz") as HTMLCanvasElement;
const breatheViz = new BreatheViz(vizCanvas);

// Partition count + per-partition colours live in the oscilloscope panel.
const partsVal = document.getElementById("breathe-parts-val")!;
const swatches = document.getElementById("breathe-swatches")!;

function rebuildSwatches() {
  const parts = partitionCount(cfg);
  partsVal.textContent = String(parts);
  swatches.replaceChildren();
  for (let p = 0; p < parts; p++) {
    const input = document.createElement("input");
    input.type = "color";
    input.value = cfg.breatheColors[p] ?? "#ffffff";
    input.title = `partition ${p + 1}`;
    input.addEventListener("input", () => {
      cfg.breatheColors[p] = input.value;
    });
    swatches.appendChild(input);
  }
}
function stepPartitions(delta: number) {
  cfg.partitions = Math.max(2, Math.min(6, partitionCount(cfg) + delta));
  rebuildSwatches();
}
document.getElementById("breathe-parts-dec")!.addEventListener("click", () => stepPartitions(-1));
document.getElementById("breathe-parts-inc")!.addEventListener("click", () => stepPartitions(1));
rebuildSwatches();

// Mask-layout overlay: superimposes each partition's mask over its position,
// aligned to the (inset) cloud canvas.
const maskOverlay = new MaskOverlay(renderer.domElement);

// --- Solo preview (hover an oscilloscope lane to isolate that partition) ---
let hoverPartition: number | null = null;
let wasPreviewing = false;

vizCanvas.addEventListener("mousemove", (e) => {
  hoverPartition = cfg.breatheEnabled ? breatheViz.hitLane(e.offsetY, cfg) : null;
});
vizCanvas.addEventListener("mouseleave", () => {
  hoverPartition = null;
});

/**
 * Render the base buffer: the pattern layer (or black when the pattern is
 * toggled off) with the breathing layer composited on top.
 */
function renderBase(step: number) {
  if (cfg.patternEnabled) {
    renderPattern(ledField.colors, patternTime, step, cfg);
  } else {
    ledField.colors.fill(0);
  }
  applyBreathing(ledField.colors, patternTime, cfg);
}

/** Recompute the normal pattern+breathing buffer once (used when leaving a preview). */
function refreshBuffer() {
  const step = 1 / Math.max(1, cfg.patternFps);
  renderBase(step);
  dirty = true;
}

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
    // Render the pattern (or black if disabled) and bake the per-partition
    // breathing pulse onto the same buffer, so the visual and the streamed
    // hardware frames stay identical.
    renderBase(step);
    dirty = true;
    steps++;
  }

  // 1b) solo preview: hovering a lane shows just that partition's breathing
  // (pattern off, all others off). Done every frame so it updates immediately.
  if (hoverPartition !== null) {
    renderPartitionSolo(ledField.colors, patternTime, cfg, hoverPartition);
    dirty = true;
    wasPreviewing = true;
  } else if (wasPreviewing) {
    // Just left the solo preview -> restore the real pattern immediately.
    refreshBuffer();
    wasPreviewing = false;
  }

  // 2) feed the visualizer (rendered every frame for a smooth, static diffuser)
  if (dirty) ledField.uploadToTexture();
  const led = getLedType(cfg.ledType);
  uniforms.uTime.value = patternTime;
  uniforms.uCloudAspect.value = cfg.cloudWidthMm / Math.max(1, cfg.cloudHeightMm);
  computeSigma(uniforms.uSigma.value as THREE.Vector2);
  uniforms.uLedGain.value = cfg.ledBrightness * led.relBrightness;
  uniforms.uWhiteMix.value = led.rgbw ? 0.35 : 0;
  uniforms.uTransmission.value = 1 - cfg.opacity / 100;
  uniforms.uBumpHeight.value = cfg.bumpHeight;
  uniforms.uBumpScale.value = cfg.bumpScale;
  uniforms.uBumpDetail.value = cfg.bumpDetail;
  uniforms.uAmbient.value = cfg.ambient;
  uniforms.uBackground.value = cfg.backgroundTint;
  renderer.render(scene, camera);

  // breathing readout on the left (highlight the soloed lane)
  breathePanel.classList.toggle("hidden", !cfg.breatheEnabled);
  if (cfg.breatheEnabled) breatheViz.draw(cfg, patternTime, hoverPartition);

  // mask-layout overlay (superimposed mask shapes over their positions)
  maskOverlay.draw(cfg);

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
