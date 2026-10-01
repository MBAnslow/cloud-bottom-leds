import GUI from "lil-gui";
import {
  PATTERN_NAMES,
  PALETTE_NAMES,
  PARTITION_LAYOUTS,
  BLEND_MODES,
  CLOUD_DYNAMICS_NOISES,
  CLOUD_SKY_PRESETS,
  OSC_BLENDS,
  VIEW_MODES,
  type Config,
  type PaletteName,
} from "./config";
import { LED_TYPES, maxGrid } from "./ledTypes";
import { loadMaskFile, loadMaskURL, clearMask } from "./mask";
import { clearPartitionCenters } from "./breathing";
import { MaskDraw } from "./maskDraw";

export interface GuiHooks {
  onLayoutChange: () => void;
  onStreamToggle: () => void;
  onStreamReconfigure: () => void;
}

export interface GuiHandle {
  refreshFromConfig: () => void;
}

export function buildGui(cfg: Config, hooks: GuiHooks): GuiHandle {
  // Right-hand menu: the hardware build + the animated pattern.
  const gui = new GUI({ title: "Cloud Bottom LEDs" });
  gui.domElement.style.top = "var(--ui-menu-top)";
  gui.domElement.style.left = "auto";
  gui.domElement.style.right = "10px";
  gui.domElement.style.width = "calc((100vw - 30px) / 2)";
  gui.domElement.style.maxHeight = "var(--ui-menu-h)";
  gui.domElement.style.overflowY = "auto";

  const refreshControllers = (root: GUI) => {
    const list =
      (
        root as unknown as {
          controllersRecursive?: () => Array<{ updateDisplay: () => void }>;
        }
      ).controllersRecursive?.() ?? [];
    for (const ctrl of list) ctrl.updateDisplay();
  };

  // View selector: flat build panel vs. the 3D volumetric lit cloud (orbit by
  // click-dragging the canvas).
  gui.add(cfg, "view", VIEW_MODES).name("view");

  const cloud3d = gui.addFolder("Cloud shape (3D)");
  cloud3d.add(cfg, "cloudThicknessMm", 50, 1500, 10).name("thickness (mm)");
  cloud3d.add(cfg, "cloudDensity", 0.1, 2, 0.01).name("density");
  cloud3d.add(cfg, "cloudSky", CLOUD_SKY_PRESETS).name("sky");
  cloud3d.add(cfg, "cloudNightDarkness", 0, 1, 0.01).name("night darkness");
  cloud3d.close();

  const ledTypeOptions: Record<string, string> = {};
  for (const t of LED_TYPES) ledTypeOptions[t.label] = t.id;

  // =====================================================================
  // HARDWARE — the physical build: cloud size, LEDs, diffuser, streaming.
  // =====================================================================
  const hw = gui.addFolder("Hardware");

  const cloudSize = hw.addFolder("Cloud dimensions");
  const widthCtrl = cloudSize.add(cfg, "cloudWidthMm", 100, 4000, 10).name("width (mm)");
  const heightCtrl = cloudSize.add(cfg, "cloudHeightMm", 100, 3000, 10).name("height (mm)");

  const layout = hw.addFolder("LED grid");
  const ledTypeCtrl = layout.add(cfg, "ledType", ledTypeOptions).name("LED type");
  const rowsCtrl = layout.add(cfg, "rows", 1, 48, 1).name("rows (strips)");
  const colsCtrl = layout.add(cfg, "cols", 1, 96, 1).name("cols (per row)");

  // Enforce the physical limit: LEDs/strips can't be placed closer than their
  // physical footprint. Clamp the counts and the slider ranges accordingly so
  // you literally cannot add LEDs that would physically overlap.
  const forceInput = (ctrl: { $input?: HTMLInputElement }, v: number) => {
    if (ctrl.$input) ctrl.$input.value = String(v);
  };

  function recomputeLimits() {
    const { maxCols, maxRows } = maxGrid(cfg.ledType, cfg.cloudWidthMm, cfg.cloudHeightMm);
    colsCtrl.max(maxCols);
    rowsCtrl.max(maxRows);
    if (cfg.cols > maxCols) {
      cfg.cols = maxCols;
      colsCtrl.updateDisplay();
      forceInput(colsCtrl as unknown as { $input?: HTMLInputElement }, maxCols);
    }
    if (cfg.rows > maxRows) {
      cfg.rows = maxRows;
      rowsCtrl.updateDisplay();
      forceInput(rowsCtrl as unknown as { $input?: HTMLInputElement }, maxRows);
    }
  }

  const limitThenLayout = () => {
    recomputeLimits();
    hooks.onLayoutChange();
  };

  widthCtrl.onChange(limitThenLayout);
  heightCtrl.onChange(limitThenLayout);
  ledTypeCtrl.onChange(limitThenLayout);
  rowsCtrl.onChange(hooks.onLayoutChange);
  colsCtrl.onChange(hooks.onLayoutChange);
  rowsCtrl.onFinishChange(limitThenLayout);
  colsCtrl.onFinishChange(limitThenLayout);
  recomputeLimits();

  const diffuser = hw.addFolder("Diffuser");
  diffuser.add(cfg, "ledDistanceMm", 0, 120, 0.5).name("LED distance (mm)");
  diffuser.add(cfg, "diffuserScatterMm", 0, 40, 0.1).name("material haze (mm)");

  const stream = hw.addFolder("Stream (WLED)");
  stream.add(cfg, "streamEnabled").name("enable stream").onChange(hooks.onStreamToggle);
  stream.add(cfg, "wledHost").name("WLED IP").onFinishChange(hooks.onStreamReconfigure);
  stream.add(cfg, "wledPort", 1, 65535, 1).name("DDP port").onFinishChange(hooks.onStreamReconfigure);
  stream.add(cfg, "bridgeUrl").name("bridge ws");
  stream
    .add(cfg, "wiring", ["row-major", "serpentine", "column-major", "column-serpentine"])
    .name("wiring");
  stream
    .add(cfg, "streamChannelOrder", ["RGB", "RBG", "GRB", "GBR", "BRG", "BGR"])
    .name("channel order");
  stream.add(cfg, "streamExposure", 0.1, 4, 0.01).name("exposure");
  stream.add(cfg, "streamGamma", 0.4, 3, 0.05).name("gamma (1 = linear)");
  stream.add(cfg, "streamSaturation", 0, 2.5, 0.01).name("saturation");
  stream.add(cfg, "streamRedGain", 0.2, 2, 0.01).name("red gain");
  stream.add(cfg, "streamGreenGain", 0.2, 2, 0.01).name("green gain");
  stream.add(cfg, "streamBlueGain", 0.2, 2, 0.01).name("blue gain");
  stream.add(cfg, "fps", 1, 60, 1).name("fps (sim + stream)");
  stream.close();

  // =====================================================================
  // LEFT MENU — Pattern + Breathing, pinned to the LEFT of the screen.
  // =====================================================================
  const left = new GUI({ title: "Pattern & Breathing" });
  left.domElement.style.top = "var(--ui-menu-top)";
  left.domElement.style.left = "10px";
  left.domElement.style.right = "auto";
  left.domElement.style.width = "calc((100vw - 30px) / 2)";
  left.domElement.style.maxHeight = "var(--ui-menu-h)";
  left.domElement.style.overflowY = "auto";

  // PATTERN — the animated content + how the diffuser surface looks.
  const pat = left.addFolder("Pattern");
  pat.add(cfg, "patternEnabled").name("enable pattern");
  const patternCtrl = pat.add(cfg, "pattern", PATTERN_NAMES).name("pattern");
  const paletteState: { palette: PaletteName } = {
    palette: cfg.patternPalettes[cfg.pattern],
  };
  const paletteCtrl = pat
    .add(paletteState, "palette", PALETTE_NAMES)
    .name("palette")
    .onChange((v: string) => {
      cfg.patternPalettes[cfg.pattern] = v as PaletteName;
    });
  patternCtrl.onChange(() => {
    paletteState.palette = cfg.patternPalettes[cfg.pattern];
    paletteCtrl.updateDisplay();
  });
  pat.add(cfg, "speed", 0, 4, 0.01);
  pat.add(cfg, "brightness", 0, 1, 0.01).name("content level");
  pat.add(cfg, "hueShift", 0, 360, 1).name("palette shift");

  const dyn = pat.addFolder("Cloud dynamics");
  dyn.add(cfg, "cloudDynamicsEnabled").name("enable");
  dyn.add(cfg, "cloudDynamicsType", CLOUD_DYNAMICS_NOISES).name("noise");
  dyn.add(cfg, "cloudDynamicsAmount", 0, 2, 0.01).name("depth (dark<->bright)");
  dyn.add(cfg, "cloudDynamicsScale", 0.2, 10, 0.05).name("scale");
  dyn.add(cfg, "cloudDynamicsSpeed", 0, 2.5, 0.01).name("speed");
  dyn.add(cfg, "cloudDynamicsContrast", 0.2, 3, 0.01).name("contrast");
  dyn.add(cfg, "cloudDynamicsWhiteMix", 0, 1, 0.01).name("cloud tint (white->colour)");

  // TIMELINE TINT — 24h day-cycle colour wash multiplied over the final signal.
  // The interactive widget (with the gradient strip + draggable swatches +
  // playhead + scrubbing) lives below the LED view; this folder just exposes
  // enable / cycle speed for parity with the other layers.
  const tint = left.addFolder("Timeline tint");
  tint.add(cfg, "tintEnabled").name("enable");
  tint.add(cfg, "tintPlaying").name("play");
  // Default 60s = 24h preview. Up to 24h (=86400s) for real-time sun cycle.
  tint
    .add(cfg, "tintCycleSeconds", 5, 86400, 1)
    .name("cycle (sec = 24h)");
  const tintActions = {
    reset: () => {
      cfg.tintTime = 0.5;
    },
  };
  tint.add(tintActions, "reset").name("reset playhead to noon");

  // BREATHING — per-partition underlying pulse that mixes with the pattern.
  const br = left.addFolder("Breathing");
  br.add(cfg, "breatheEnabled").name("enable");
  const layoutCtrl = br.add(cfg, "partitionLayout", PARTITION_LAYOUTS).name("layout");
  br.add(cfg, "partitionSoftness", 0, 1, 0.01).name("overlap (soft edges)");
  const reshuffle = {
    go: () => {
      clearPartitionCenters(cfg.partitionLayout);
      cfg.partitionSeed = (Math.random() * 1e6) | 0;
    },
  };
  br.add(reshuffle, "go").name("reshuffle / move shapes");

  // "mask" layout: an uploaded image is placed (scaled) at each partition's
  // centre; its bright areas are that colour's region. Upload selects the layout.
  const mask = br.addFolder("Mask layout");
  const maskInfo = { name: "(none)" };
  const maskCtrl = mask.add(maskInfo, "name").name("image").disable();
  mask.add(cfg, "maskInvert").name("invert (dark = colour)");
  mask.add(cfg, "maskScale", 0.05, 2, 0.01).name("scale");
  mask.add(cfg, "maskShowOverlay").name("show masks");
  mask.add(cfg, "maskRotate").name("rotate masks");
  mask.add(cfg, "maskRotateDegPerMin", -360, 360, 1).name("rotation speed (deg/min)");

  const fileInput = document.createElement("input");
  fileInput.type = "file";
  fileInput.accept = "image/*";
  fileInput.style.display = "none";
  document.body.appendChild(fileInput);
  function selectMaskLayout() {
    cfg.partitionLayout = "mask";
    layoutCtrl.updateDisplay();
  }
  fileInput.addEventListener("change", async () => {
    const f = fileInput.files?.[0];
    if (!f) return;
    try {
      await loadMaskFile(f);
      maskInfo.name = f.name.length > 18 ? f.name.slice(0, 17) + "…" : f.name;
      selectMaskLayout();
    } catch {
      maskInfo.name = "load failed";
    }
    maskCtrl.updateDisplay();
    fileInput.value = "";
  });
  mask.add({ upload: () => fileInput.click() }, "upload").name("upload mask…");

  // Draw-your-own-mask grid, mounted inside the Mask folder. Painting pushes the
  // grid straight into the live mask and selects the mask layout.
  let maskDraw: MaskDraw | null = null;
  mask.add(
    {
      clear: () => {
        clearMask();
        maskDraw?.clear();
        maskInfo.name = "(none)";
        maskCtrl.updateDisplay();
      },
    },
    "clear"
  ).name("clear mask");

  const maskChildren = (mask as unknown as { $children: HTMLElement }).$children;
  maskDraw = new MaskDraw(maskChildren, () => {
    maskInfo.name = "drawn";
    selectMaskLayout();
    maskCtrl.updateDisplay();
  });

  // Test/automation hook: load a mask from a (data) URL programmatically.
  (window as unknown as { __uploadMaskURL?: (u: string) => Promise<void> }).__uploadMaskURL = async (
    url: string
  ) => {
    await loadMaskURL(url);
    maskInfo.name = "loaded (url)";
    selectMaskLayout();
    maskCtrl.updateDisplay();
  };

  br.add(cfg, "breatheRate", 1, 30, 0.5).name("rate (per min)");
  br.add(cfg, "breatheDepth", 0, 1, 0.01).name("depth");
  br.add(cfg, "breatheMinBrightness", 0, 1, 0.01).name("min brightness");
  br.add(cfg, "breatheMinColor", 0, 1, 0.01).name("min colour");
  br.add(cfg, "breatheStagger", 0, 1, 0.01).name("stagger");
  // Partition count and per-partition colours live in the bottom oscilloscope
  // panel (wired in main.ts), so they are intentionally not added here.

  // BLENDING — how the layers combine: the partition oscillators with each
  // other, and the resulting breathing layer over the pattern.
  const blend = left.addFolder("Blending");
  blend.add(cfg, "partitionBlend", OSC_BLENDS).name("oscillators with each other");
  blend.add(cfg, "breatheBlend", BLEND_MODES).name("breathing with pattern");

  return {
    refreshFromConfig: () => {
      recomputeLimits();
      paletteState.palette = cfg.patternPalettes[cfg.pattern];
      paletteCtrl.updateDisplay();
      refreshControllers(gui);
      refreshControllers(left);
    },
  };
}
