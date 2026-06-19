import GUI from "lil-gui";
import { PATTERN_NAMES, type Config } from "./config";
import { LED_TYPES, maxGrid } from "./ledTypes";

export interface GuiHooks {
  onLayoutChange: () => void;
  onStreamToggle: () => void;
  onStreamReconfigure: () => void;
}

/** Read-only "what to buy" figures, refreshed live by main.ts. */
export interface BuildEstimate {
  size: string;
  totalLeds: string;
  pitch: string;
  rowDensity: string;
  amount: string;
  fit: string;
  capacity: string;
}

export function buildGui(cfg: Config, estimate: BuildEstimate, hooks: GuiHooks): GUI {
  const gui = new GUI({ title: "Cloud Bottom LEDs" });

  const ledTypeOptions: Record<string, string> = {};
  for (const t of LED_TYPES) ledTypeOptions[t.label] = t.id;

  const cloudSize = gui.addFolder("Cloud Dimensions");
  const widthCtrl = cloudSize.add(cfg, "cloudWidthMm", 100, 4000, 10).name("width (mm)");
  const heightCtrl = cloudSize.add(cfg, "cloudHeightMm", 100, 3000, 10).name("height (mm)");

  const layout = gui.addFolder("LED Grid");
  const ledTypeCtrl = layout.add(cfg, "ledType", ledTypeOptions).name("LED type");
  const rowsCtrl = layout.add(cfg, "rows", 1, 48, 1).name("rows (strips)");
  const colsCtrl = layout.add(cfg, "cols", 1, 96, 1).name("cols (per row)");

  // Enforce the physical limit: LEDs/strips can't be placed closer than their
  // physical footprint. Clamp the counts and the slider ranges accordingly so
  // you literally cannot add LEDs that would physically overlap.
  const forceInput = (ctrl: { $input?: HTMLInputElement }, v: number) => {
    // lil-gui won't refresh a focused input, so also set the text directly.
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

  // Dimensions / type change the capacity -> recompute limits live.
  widthCtrl.onChange(limitThenLayout);
  heightCtrl.onChange(limitThenLayout);
  ledTypeCtrl.onChange(limitThenLayout);
  // Counts: render live while dragging; clamp typed values on commit.
  rowsCtrl.onChange(hooks.onLayoutChange);
  colsCtrl.onChange(hooks.onLayoutChange);
  rowsCtrl.onFinishChange(limitThenLayout);
  colsCtrl.onFinishChange(limitThenLayout);
  recomputeLimits();

  const est = gui.addFolder("Build Estimate (what to buy)");
  est.add(estimate, "size").name("cloud size").listen().disable();
  est.add(estimate, "totalLeds").name("total LEDs").listen().disable();
  est.add(estimate, "pitch").name("LED pitch").listen().disable();
  est.add(estimate, "rowDensity").name("density").listen().disable();
  est.add(estimate, "amount").name("buy").listen().disable();
  est.add(estimate, "fit").name("feasibility").listen().disable();
  est.add(estimate, "capacity").name("phys. capacity").listen().disable();

  const emitter = gui.addFolder("LEDs (physical)");
  emitter.add(cfg, "ledBrightness", 0, 5, 0.01).name("brightness (gain)");
  emitter.add(cfg, "patternFps", 1, 120, 1).name("pattern fps");

  const diffuser = gui.addFolder("Diffuser (physical)");
  diffuser.add(cfg, "ledDistanceMm", 0, 120, 0.5).name("LED distance (mm)");
  diffuser.add(cfg, "diffuserScatterMm", 0, 40, 0.1).name("material haze (mm)");
  diffuser.add(cfg, "opacity", 0, 95, 1).name("opacity (%)");

  const cloud = gui.addFolder("Cloud Surface shape");
  cloud.add(cfg, "bumpHeight", 0, 1.5, 0.01).name("bumpiness");
  cloud.add(cfg, "bumpScale", 0.5, 8, 0.05).name("bump scale");
  cloud.add(cfg, "bumpDetail", 1, 6, 1).name("bump detail");

  const pattern = gui.addFolder("Pattern");
  pattern.add(cfg, "pattern", PATTERN_NAMES).name("pattern");
  pattern.add(cfg, "speed", 0, 4, 0.01);
  pattern.add(cfg, "brightness", 0, 1, 0.01).name("content level");
  pattern.add(cfg, "hueShift", 0, 360, 1).name("hue shift");

  const look = gui.addFolder("Look");
  look.add(cfg, "ambient", 0, 0.3, 0.005).name("ambient glow");
  look.add(cfg, "backgroundTint", 0, 0.5, 0.01).name("background");
  look.close();

  const stream = gui.addFolder("Stream to Hardware (WLED)");
  stream.add(cfg, "streamEnabled").name("enable stream").onChange(hooks.onStreamToggle);
  stream.add(cfg, "wledHost").name("WLED IP").onFinishChange(hooks.onStreamReconfigure);
  stream.add(cfg, "wledPort", 1, 65535, 1).name("UDP port").onFinishChange(hooks.onStreamReconfigure);
  stream.add(cfg, "bridgeUrl").name("bridge ws");
  stream.add(cfg, "wiring", ["row-major", "serpentine"]).name("wiring");
  stream.add(cfg, "streamFps", 1, 60, 1).name("stream fps");

  return gui;
}
