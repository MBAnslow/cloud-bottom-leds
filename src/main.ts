import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { defaultConfig, type CloudSkyPreset, type Config } from "./config";
import { LedField } from "./ledField";
import { renderPattern } from "./patterns";
import { applyCloudDynamics } from "./cloudDynamics";
import { fragmentShader, vertexShader } from "./cloudShader";
import {
  fullscreenVertexShader,
  emissionFragmentShader,
  volumeFragmentShader,
} from "./cloudVolumeShader";
import { Streamer, type StreamStatus } from "./streamer";
import { buildGui, type GuiHandle } from "./gui";
import { getLedType, maxGrid } from "./ledTypes";
import { applyBreathing, renderPartitionSolo, partitionCount } from "./breathing";
import { BreatheViz } from "./breatheViz";
import { MaskOverlay } from "./maskOverlay";
import { CentroidOverlay } from "./centroidOverlay";
import { applyTimelineTint, advanceTimelineTint, tintColorAt } from "./timelineTint";
import { TimelineWidget } from "./timelineWidget";

const DEFAULT_CONFIG_STORAGE_KEY = "cloud-bottom-leds.default-config.v1";

function cloneConfig(src: Config): Config {
  return {
    ...src,
    breatheColors: [...src.breatheColors],
    patternPalettes: { ...src.patternPalettes },
    tintSwatches: src.tintSwatches.map((s) => ({ time: s.time, color: s.color })),
  };
}

function applyConfig(target: Config, source: Partial<Config>) {
  for (const key of Object.keys(defaultConfig) as Array<keyof Config>) {
    if (!(key in source)) continue;
    const next = source[key];
    if (next === undefined) continue;
    if (key === "breatheColors" && Array.isArray(next)) {
      target.breatheColors = (next as unknown[]).filter(
        (v): v is string => typeof v === "string",
      );
      continue;
    }
    if (key === "patternPalettes" && typeof next === "object" && next) {
      target.patternPalettes = {
        ...defaultConfig.patternPalettes,
        ...(next as Config["patternPalettes"]),
      };
      continue;
    }
    if (key === "tintSwatches" && Array.isArray(next)) {
      // Defensive parse so a malformed localStorage entry can't crash boot.
      target.tintSwatches = (next as unknown[])
        .filter(
          (s): s is { time: number; color: string } =>
            !!s &&
            typeof s === "object" &&
            typeof (s as { time?: unknown }).time === "number" &&
            typeof (s as { color?: unknown }).color === "string",
        )
        .map((s) => ({ time: s.time, color: s.color }));
      continue;
    }
    if (key === "partitionBlend" && next === "average") {
      target.partitionBlend = "normal";
      continue;
    }
    if (key === "fps") {
      if (typeof next === "number" && Number.isFinite(next)) {
        target.fps = Math.max(1, Math.min(60, next));
      }
      continue;
    }
    (target[key] as Config[keyof Config]) = next as Config[keyof Config];
  }
  // Back-compat: if unified fps is absent, fold legacy fps fields into it.
  if (typeof source.fps !== "number") {
    const legacyFps =
      typeof source.streamFps === "number"
        ? source.streamFps
        : typeof source.patternFps === "number"
          ? source.patternFps
          : undefined;
    if (typeof legacyFps === "number" && Number.isFinite(legacyFps)) {
      target.fps = Math.max(1, Math.min(60, legacyFps));
    }
  }
  // Back-compat: before DDP, the default WLED realtime UDP port was 21324.
  // If a saved config still has that legacy default, migrate to DDP default.
  if (source.wledPort === 21324) {
    target.wledPort = 4048;
  }
}

function readStoredDefaultConfig(): Partial<Config> | null {
  try {
    const raw = localStorage.getItem(DEFAULT_CONFIG_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object") return null;
    return parsed as Partial<Config>;
  } catch {
    return null;
  }
}

function saveDefaultConfig(cfg: Config) {
  localStorage.setItem(DEFAULT_CONFIG_STORAGE_KEY, JSON.stringify(cloneConfig(cfg)));
}

const cfg = cloneConfig(defaultConfig);
const savedDefault = readStoredDefaultConfig();
if (savedDefault) applyConfig(cfg, savedDefault);
{
  const { maxCols, maxRows } = maxGrid(cfg.ledType, cfg.cloudWidthMm, cfg.cloudHeightMm);
  cfg.cols = Math.max(1, Math.min(cfg.cols, maxCols));
  cfg.rows = Math.max(1, Math.min(cfg.rows, maxRows));
}

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
  uLedGain: { value: 1 },
  uWhiteMix: { value: 0 },
  uTransmission: { value: 1 - cfg.opacity / 100 },
  uAmbient: { value: cfg.ambient },
  uBackground: { value: cfg.backgroundTint },
  uTint: { value: new THREE.Vector3(1, 1, 1) },
  uViewMode: { value: cfg.view === "cloud" ? 1 : 0 },
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

// =====================================================================
// 3D VOLUMETRIC VIEW — the real build: LEDs embedded in the cloud base
// throwing light up into a ray-marched cloud volume, orbited with a camera.
// =====================================================================

// Pass 1 target: the LED glow leaving the base plane (footprint UV space).
const EMIT_RES = 384;
const emissionRT = new THREE.WebGLRenderTarget(EMIT_RES, EMIT_RES, {
  type: THREE.FloatType,
  minFilter: THREE.LinearFilter,
  magFilter: THREE.LinearFilter,
  wrapS: THREE.ClampToEdgeWrapping,
  wrapT: THREE.ClampToEdgeWrapping,
  depthBuffer: false,
  stencilBuffer: false,
});
const emissionUniforms: Record<string, THREE.IUniform> = {
  uLeds: { value: ledField.texture },
  uCols: { value: cfg.cols },
  uRows: { value: cfg.rows },
  uSigma: { value: uniforms.uSigma.value },
  uLedGain: { value: 1 },
  uWhiteMix: { value: 0 },
};
const emissionScene = new THREE.Scene();
emissionScene.add(
  Object.assign(
    new THREE.Mesh(
      new THREE.PlaneGeometry(2, 2),
      new THREE.ShaderMaterial({
        uniforms: emissionUniforms,
        vertexShader: fullscreenVertexShader,
        fragmentShader: emissionFragmentShader,
        depthTest: false,
        depthWrite: false,
      })
    ),
    { frustumCulled: false }
  )
);

// Pass 2: the volume ray-march (full-screen; rays reconstructed from the
// perspective camera's matrices, which OrbitControls drives).
const volUniforms: Record<string, THREE.IUniform> = {
  uResolution: { value: new THREE.Vector2(1, 1) },
  uInvViewProj: { value: new THREE.Matrix4() },
  uCamPos: { value: new THREE.Vector3() },
  uEmission: { value: emissionRT.texture },
  uBoxHalf: { value: new THREE.Vector3(0.5, 0.4, 0.5) },
  uCloudDensity: { value: cfg.cloudDensity },
  uAmbient: { value: cfg.ambient },
  uTransmission: { value: 1 - cfg.opacity / 100 },
  uLightReach: { value: 0.5 },
  uSkyBottom: { value: new THREE.Vector3(0.016, 0.02, 0.032) },
  uSkyTop: { value: new THREE.Vector3(0.05, 0.06, 0.085) },
  uTint: { value: new THREE.Vector3(1, 1, 1) },
};
const volScene = new THREE.Scene();
volScene.add(
  Object.assign(
    new THREE.Mesh(
      new THREE.PlaneGeometry(2, 2),
      new THREE.ShaderMaterial({
        uniforms: volUniforms,
        vertexShader: fullscreenVertexShader,
        fragmentShader: volumeFragmentShader,
        depthTest: false,
        depthWrite: false,
      })
    ),
    { frustumCulled: false }
  )
);

// Perspective camera + orbit controls (active only in the cloud view). The
// default angle looks up at the cloud from slightly below and to the side, so
// the lit underside (where the LEDs live) reads immediately.
const orbitCam = new THREE.PerspectiveCamera(45, 1, 0.01, 100);
orbitCam.position.set(0.7, -0.12, 1.55);
const controls = new OrbitControls(orbitCam, renderer.domElement);
controls.enableDamping = true;
controls.dampingFactor = 0.08;
controls.minDistance = 0.4;
controls.maxDistance = 6;
controls.target.set(0, 0.16, 0);
controls.enabled = false;
controls.update();

const _view = new THREE.Matrix4();
const _vp = new THREE.Matrix4();

const CLOUD_SKIES: Record<CloudSkyPreset, { bottom: [number, number, number]; top: [number, number, number] }> = {
  night: { bottom: [0.0025, 0.0035, 0.006], top: [0.012, 0.016, 0.026] },
  dawn: { bottom: [0.18, 0.14, 0.18], top: [0.56, 0.44, 0.42] },
  daylight: { bottom: [0.50, 0.62, 0.84], top: [0.78, 0.88, 1.0] },
  dusk: { bottom: [0.14, 0.11, 0.16], top: [0.40, 0.30, 0.40] },
};

/** Box half-extents in normalised world units (longest footprint axis = 1). */
function cloudBoxHalf(out: THREE.Vector3) {
  const w = cfg.cloudWidthMm;
  const d = cfg.cloudHeightMm; // the other footprint dimension
  const maxDim = Math.max(w, d);
  const hx = 0.5 * (w / maxDim);
  const hz = 0.5 * (d / maxDim);
  const hy = Math.max(0.05, cfg.cloudThicknessMm / maxDim);
  out.set(hx, hy, hz);
}

/** Render the 3D volumetric cloud view (emission pass -> ray-march pass). */
function renderCloudVolume(w: number, h: number) {
  // Pass 1: LED emission into the offscreen target.
  emissionUniforms.uLeds.value = ledField.texture;
  emissionUniforms.uCols.value = cfg.cols;
  emissionUniforms.uRows.value = cfg.rows;
  emissionUniforms.uSigma.value = uniforms.uSigma.value;
  const led = getLedType(cfg.ledType);
  emissionUniforms.uLedGain.value = 1;
  emissionUniforms.uWhiteMix.value = led.rgbw ? 0.35 : 0;
  renderer.setRenderTarget(emissionRT);
  renderer.render(emissionScene, camera);
  renderer.setRenderTarget(null);

  // Camera matrices for ray reconstruction.
  orbitCam.aspect = w / Math.max(1, h);
  orbitCam.updateProjectionMatrix();
  orbitCam.updateMatrixWorld(true);
  _view.copy(orbitCam.matrixWorld).invert();
  _vp.multiplyMatrices(orbitCam.projectionMatrix, _view);
  (volUniforms.uInvViewProj.value as THREE.Matrix4).copy(_vp).invert();
  (volUniforms.uCamPos.value as THREE.Vector3).copy(orbitCam.position);
  (volUniforms.uResolution.value as THREE.Vector2).set(w, h);
  cloudBoxHalf(volUniforms.uBoxHalf.value as THREE.Vector3);
  volUniforms.uCloudDensity.value = cfg.cloudDensity;
  volUniforms.uAmbient.value = cfg.ambient;
  volUniforms.uTransmission.value = 1 - cfg.opacity / 100;
  const sky = CLOUD_SKIES[cfg.cloudSky];
  let nightScale = 1;
  if (cfg.cloudSky === "night") {
    // 0 = preset values, 1 = much darker night.
    nightScale = 1 - cfg.cloudNightDarkness * 0.92;
  }
  (volUniforms.uSkyBottom.value as THREE.Vector3).set(
    sky.bottom[0] * nightScale,
    sky.bottom[1] * nightScale,
    sky.bottom[2] * nightScale
  );
  (volUniforms.uSkyTop.value as THREE.Vector3).set(
    sky.top[0] * nightScale,
    sky.top[1] * nightScale,
    sky.top[2] * nightScale
  );
  renderer.render(volScene, camera);
}

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

function onLayoutChange() {
  ledField.resize(cfg);
  uniforms.uLeds.value = ledField.texture;
  uniforms.uCols.value = cfg.cols;
  uniforms.uRows.value = cfg.rows;
  if (cfg.streamEnabled) streamer.reconfigure(cfg, ledField.count);
}

function loadDefaultConfigIntoSession() {
  const saved = readStoredDefaultConfig();
  if (saved) {
    applyConfig(cfg, saved);
  } else {
    applyConfig(cfg, defaultConfig);
  }
  const { maxCols, maxRows } = maxGrid(cfg.ledType, cfg.cloudWidthMm, cfg.cloudHeightMm);
  cfg.cols = Math.max(1, Math.min(cfg.cols, maxCols));
  cfg.rows = Math.max(1, Math.min(cfg.rows, maxRows));
  onLayoutChange();
  rebuildSwatches();
  refreshBuffer();
  applyStreaming();
  guiHandle?.refreshFromConfig();
}

// --- GUI ---
let guiHandle: GuiHandle | null = null;
guiHandle = buildGui(cfg, {
  onLayoutChange,
  onStreamToggle: applyStreaming,
  onStreamReconfigure: () => streamer.reconfigure(cfg, ledField.count),
});

const saveDefaultBtn = document.getElementById("cfg-save");
const loadDefaultBtn = document.getElementById("cfg-load");
saveDefaultBtn?.addEventListener("click", () => saveDefaultConfig(cfg));
loadDefaultBtn?.addEventListener("click", loadDefaultConfigIntoSession);

// --- Resize ---
// The cloud canvas fills the middle display region (#app), with breathing above
// and the two menu columns below, so size from the container not the window.
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
  cfg.partitions = Math.max(1, Math.min(6, partitionCount(cfg) + delta));
  rebuildSwatches();
}
document.getElementById("breathe-parts-dec")!.addEventListener("click", () => stepPartitions(-1));
document.getElementById("breathe-parts-inc")!.addEventListener("click", () => stepPartitions(1));
rebuildSwatches();

// Mask-layout overlay: superimposes each partition's mask over its position,
// aligned to the (inset) cloud canvas.
const maskOverlay = new MaskOverlay(renderer.domElement);
// Draggable centroids for partition layouts (panel view).
const centroidOverlay = new CentroidOverlay(renderer.domElement);

// 24h timeline tint widget (gradient strip with draggable swatches + playhead).
const tintMount = document.getElementById("tint-timeline-mount")!;
// Forward-declared so the widget's callback can poke the render pipeline as
// soon as the user scrubs/edits a swatch (instead of waiting for the next
// pattern step). The real `refreshBuffer` is defined a bit further down.
const onTintInteract = () => refreshBuffer();
const timelineWidget = new TimelineWidget(cfg, tintMount, () => onTintInteract());

let dragPointerId: number | null = null;
renderer.domElement.addEventListener("pointerdown", (e) => {
  if (!centroidOverlay.beginDrag(cfg, e.clientX, e.clientY)) return;
  dragPointerId = e.pointerId;
  renderer.domElement.setPointerCapture(e.pointerId);
  refreshBuffer();
  e.preventDefault();
});
renderer.domElement.addEventListener("pointermove", (e) => {
  if (centroidOverlay.isDragging) {
    if (dragPointerId !== null && e.pointerId !== dragPointerId) return;
    if (centroidOverlay.dragTo(cfg, e.clientX, e.clientY)) refreshBuffer();
    e.preventDefault();
    return;
  }
  centroidOverlay.hoverAt(cfg, e.clientX, e.clientY);
});
renderer.domElement.addEventListener("pointerup", (e) => {
  if (dragPointerId !== null && e.pointerId === dragPointerId) {
    dragPointerId = null;
    centroidOverlay.endDrag();
    renderer.domElement.releasePointerCapture(e.pointerId);
    refreshBuffer();
  }
});
renderer.domElement.addEventListener("pointercancel", (e) => {
  if (dragPointerId !== null && e.pointerId === dragPointerId) {
    dragPointerId = null;
    centroidOverlay.endDrag();
    refreshBuffer();
  }
});
renderer.domElement.addEventListener("pointerleave", () => {
  centroidOverlay.clearHover();
});

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
 * Fixed pipeline:
 *   pattern -> breathing mix -> cloud dynamics modulation.
 * User only chooses how breathing mixes with pattern (`breatheBlend`).
 * Dynamics is applied to the composite so the cloud ripple remains visible even
 * when breathing colour is dominant.
 */
function renderBase(step: number) {
  if (cfg.patternEnabled) {
    renderPattern(ledField.colors, patternTime, step, cfg);
  } else {
    ledField.colors.fill(0);
  }
  applyBreathing(ledField.colors, patternTime, cfg);
  applyCloudDynamics(ledField.colors, patternTime, cfg);
  // Timeline tint is the final colour wash (multiplied over the composite) so
  // every layer is uniformly tinted. Emitter drive (a flat brightness gain)
  // comes after so the tinted signal still respects the LED type / drive.
  applyTimelineTint(ledField.colors, cfg);
}

/** Recompute the normal pattern+breathing buffer once (used when leaving a preview). */
function refreshBuffer() {
  const step = 1 / Math.max(1, Math.min(60, cfg.fps));
  renderBase(step);
  dirty = true;
}

// --- HUD ---
const hudGrid = document.getElementById("hud-grid")!;
const hudFps = document.getElementById("hud-fps")!;
let fpsAccum = 0;
let fpsFrames = 0;
let fpsTimer = 0;

// --- Streamed-bytes RGB histogram (overlaid on the LED canvas) ---
const histCanvas = document.getElementById("stream-hist") as HTMLCanvasElement;
const histCtx = histCanvas.getContext("2d");
// 16 bins, each spanning 16 byte values (0..255).
const HIST_BIN_WIDTH = 16;
const HIST_BINS = 256 / HIST_BIN_WIDTH;
const histR = new Float32Array(HIST_BINS);
const histG = new Float32Array(HIST_BINS);
const histB = new Float32Array(HIST_BINS);

// Sync the histogram bitmap to its CSS box so the bars stay crisp when the
// window is resized. (Otherwise the canvas defaults to its `width="…"` HTML
// attribute and gets visually stretched.)
function resizeHistCanvas() {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const rect = histCanvas.getBoundingClientRect();
  histCanvas.width = Math.max(2, Math.floor(rect.width * dpr));
  histCanvas.height = Math.max(2, Math.floor(rect.height * dpr));
}
new ResizeObserver(resizeHistCanvas).observe(histCanvas);
resizeHistCanvas();

/** Draw a per-channel histogram (R,G,B) of the exact bytes sent to the strips. */
function drawStreamHistogram(bytes: Uint8Array) {
  if (!histCtx) return;
  const W = histCanvas.width;
  const H = histCanvas.height;
  // Scale all geometry / fonts by dpr so the rendering stays crisp + legible
  // when the bitmap is larger than the CSS box.
  const s = Math.max(1, Math.min(2, window.devicePixelRatio || 1));
  const axisH = 12 * s; // reserved strip for the 0..255 axis labels
  const plotH = H - axisH;
  histR.fill(0);
  histG.fill(0);
  histB.fill(0);
  for (let i = 0; i + 2 < bytes.length; i += 3) {
    histR[(bytes[i] / HIST_BIN_WIDTH) | 0]++;
    histG[(bytes[i + 1] / HIST_BIN_WIDTH) | 0]++;
    histB[(bytes[i + 2] / HIST_BIN_WIDTH) | 0]++;
  }
  // Shared scale across channels so relative heights are meaningful.
  let peak = 1;
  for (let b = 0; b < HIST_BINS; b++) {
    if (histR[b] > peak) peak = histR[b];
    if (histG[b] > peak) peak = histG[b];
    if (histB[b] > peak) peak = histB[b];
  }
  const norm = plotH / (Math.log1p(peak) || 1);
  const binW = W / HIST_BINS;

  histCtx.clearRect(0, 0, W, H);

  // Per-bin grouped bars (R, G, B side by side within each bin).
  const gap = Math.max(1, binW * 0.08);
  const barW = (binW - gap * 2) / 3;
  const channels: Array<[Float32Array, string]> = [
    [histR, "rgba(255,80,80,0.95)"],
    [histG, "rgba(70,225,110,0.95)"],
    [histB, "rgba(95,155,255,0.95)"],
  ];
  for (let b = 0; b < HIST_BINS; b++) {
    const x0 = b * binW + gap;
    for (let ch = 0; ch < 3; ch++) {
      const [hist, color] = channels[ch];
      const h = Math.log1p(hist[b]) * norm;
      histCtx.fillStyle = color;
      histCtx.fillRect(x0 + ch * barW, plotH - h, barW, h);
    }
  }

  // Axis: 0 .. 255 so it's clear this is RGB byte space.
  histCtx.fillStyle = "rgba(255,255,255,0.10)";
  histCtx.fillRect(0, plotH, W, Math.max(1, s));
  histCtx.fillStyle = "rgba(207,214,230,0.8)";
  histCtx.font = `${Math.round(9 * s)}px ui-sans-serif, system-ui, sans-serif`;
  histCtx.textBaseline = "bottom";
  const ticks = [0, 64, 128, 192, 255];
  for (const t of ticks) {
    const x = (t / 255) * W;
    histCtx.textAlign = t === 0 ? "left" : t === 255 ? "right" : "center";
    histCtx.fillText(String(t), Math.min(W - 1, Math.max(1, x)), H);
  }
}

// --- Render loop ---
const clock = new THREE.Clock();
// The pattern advances on its own fixed-rate clock so we can simulate the real
// controller's animation refresh (e.g. choppy at 15 fps, smooth at 60).
let patternTime = 0;
let patternAccum = 0;
let dirty = true; // LED colors changed -> re-upload + (maybe) stream
// Tracks the cloud aspect mirrored into the `--ui-app-aspect` CSS variable,
// so we only update the DOM when the cloud width/height actually change.
let lastAppAspect = -1;

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

  // Advance the 24h timeline tint clock (drives the playhead + colour wash).
  advanceTimelineTint(cfg, dt);

  // 1) Simulation stepping (shared with stream fps target).
  const step = 1 / Math.max(1, Math.min(60, cfg.fps));
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
  // If the timeline is playing but no pattern step fired this frame, the LED
  // buffer is stale w.r.t. the new tint time. Re-bake once so the tint wash
  // animates smoothly.
  if (steps === 0 && cfg.tintEnabled && cfg.tintPlaying) {
    renderBase(step);
    dirty = true;
  }

  // 1b) solo preview: hovering a lane shows just that partition's breathing
  // (pattern off, all others off). Done every frame so it updates immediately.
  if (hoverPartition !== null) {
    renderPartitionSolo(ledField.colors, patternTime, cfg, hoverPartition);
    applyCloudDynamics(ledField.colors, patternTime, cfg);
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
  const tintRgb = cfg.tintEnabled ? tintColorAt(cfg.tintSwatches, cfg.tintTime) : [1, 1, 1];
  (uniforms.uTint.value as THREE.Vector3).set(tintRgb[0], tintRgb[1], tintRgb[2]);
  (volUniforms.uTint.value as THREE.Vector3).set(tintRgb[0], tintRgb[1], tintRgb[2]);
  const cloudAspect = cfg.cloudWidthMm / Math.max(1, cfg.cloudHeightMm);
  uniforms.uCloudAspect.value = cloudAspect;
  // Mirror the aspect into a CSS variable so the `#app` width can clamp to
  // the cloud's natural aspect: the visualisation fills its canvas without
  // dead horizontal margins.
  if (lastAppAspect !== cloudAspect) {
    document.documentElement.style.setProperty("--ui-app-aspect", cloudAspect.toFixed(4));
    lastAppAspect = cloudAspect;
  }
  computeSigma(uniforms.uSigma.value as THREE.Vector2);
  uniforms.uLedGain.value = 1;
  uniforms.uWhiteMix.value = led.rgbw ? 0.35 : 0;
  uniforms.uTransmission.value = 1 - cfg.opacity / 100;
  uniforms.uAmbient.value = cfg.ambient;
  uniforms.uBackground.value = cfg.backgroundTint;
  uniforms.uViewMode.value = 0;

  const cloudView = cfg.view === "cloud";
  controls.enabled = cloudView;
  if (cloudView) {
    controls.update();
    const w = (uniforms.uResolution.value as THREE.Vector2).x;
    const h = (uniforms.uResolution.value as THREE.Vector2).y;
    renderCloudVolume(w, h);
  } else {
    renderer.render(scene, camera);
  }

  // breathing readout on the left (highlight the soloed lane)
  breathePanel.classList.toggle("hidden", !cfg.breatheEnabled);
  if (cfg.breatheEnabled) breatheViz.draw(cfg, patternTime, hoverPartition);

  // mask-layout overlay only makes sense over the flat panel.
  maskOverlay.draw(cloudView ? { ...cfg, maskShowOverlay: false } : cfg, now * 0.001);
  centroidOverlay.draw(cfg);

  // Always redraw the 24h tint timeline so the playhead + swatches stay live.
  timelineWidget.draw();

  // 3) stream to hardware at the configured data rate
  if (dirty) {
    const frameBytes = ledField.toBytes(
      cfg.wiring,
      cfg.streamChannelOrder,
      cfg.streamGamma,
      cfg.streamExposure,
      {
      saturation: cfg.streamSaturation,
      redGain: cfg.streamRedGain,
      greenGain: cfg.streamGreenGain,
      blueGain: cfg.streamBlueGain,
      }
    );
    // Stream the current rendered frame (no extra frame of intentional delay).
    if (cfg.streamEnabled && streamer.isOpen) {
      streamer.sendFrame(frameBytes, cfg.fps, now);
    }
    // Histogram of the exact bytes we (would) stream.
    drawStreamHistogram(frameBytes);
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
    hudFps.textContent = `${fps.toFixed(0)} fps render · ${cfg.fps.toFixed(0)} fps sim/stream · ${ledField.count} LEDs`;
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
