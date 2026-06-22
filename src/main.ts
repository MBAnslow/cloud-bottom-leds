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
import { buildGui } from "./gui";
import { getLedType } from "./ledTypes";
import { applyBreathing, renderPartitionSolo, partitionCount } from "./breathing";
import { BreatheViz } from "./breatheViz";
import { MaskOverlay } from "./maskOverlay";
import { CentroidOverlay } from "./centroidOverlay";

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
  uLedGain: { value: cfg.ledBrightness },
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
  uBumpScale: { value: cfg.bumpScale },
  uBumpHeight: { value: cfg.bumpHeight },
  uBumpDetail: { value: cfg.bumpDetail },
  uAmbient: { value: cfg.ambient },
  uTransmission: { value: 1 - cfg.opacity / 100 },
  uLightReach: { value: 0.5 },
  uSkyBottom: { value: new THREE.Vector3(0.016, 0.02, 0.032) },
  uSkyTop: { value: new THREE.Vector3(0.05, 0.06, 0.085) },
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
  emissionUniforms.uLedGain.value = cfg.ledBrightness * led.relBrightness;
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
  volUniforms.uBumpScale.value = cfg.bumpScale;
  volUniforms.uBumpHeight.value = cfg.bumpHeight;
  volUniforms.uBumpDetail.value = cfg.bumpDetail;
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
// Draggable centroids for partition layouts (panel view).
const centroidOverlay = new CentroidOverlay(renderer.domElement);

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
  applyCloudDynamics(ledField.colors, patternTime, cfg);
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
