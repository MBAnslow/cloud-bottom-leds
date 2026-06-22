export type WiringOrder = "row-major" | "serpentine";

/**
 * Which preview to render: the flat build panel (true to the physical rect, for
 * dialing in pitch/spread) or a representational lit cloud silhouette (to judge
 * how the underside of a real cloud would look).
 */
export type ViewMode = "panel" | "cloud";
export const VIEW_MODES: ViewMode[] = ["panel", "cloud"];

export type CloudSkyPreset = "night" | "dawn" | "daylight" | "dusk";
export const CLOUD_SKY_PRESETS: CloudSkyPreset[] = ["night", "dawn", "daylight", "dusk"];

export interface Config {
  /** Which preview is shown on the main canvas. */
  view: ViewMode;

  // --- Cloud dimensions (physical) ---
  /** Overall width of the cloud surface, in millimetres. */
  cloudWidthMm: number;
  /** Overall height of the cloud surface, in millimetres. */
  cloudHeightMm: number;

  // --- LED grid ---
  /** Number of LED rows (strips), spread evenly over the height. */
  rows: number;
  /** Number of LEDs per row, spread evenly over the width. */
  cols: number;
  /** Selected LED product id (see ledTypes.ts). */
  ledType: string;

  // --- Emitter (physical) ---
  /** Relative luminous output / drive level of each LED (1 = nominal). Higher = brighter, can blow out to white hotspots. */
  ledBrightness: number;
  /** How many times per second the lighting pattern actually updates (controller refresh of the animation). */
  patternFps: number;

  // --- Diffuser (physical) ---
  /** Distance from the LEDs to the back of the diffuser, in millimetres. Larger = softer, more even, dimmer hotspots. */
  ledDistanceMm: number;
  /** Intrinsic blur of the diffuser material itself (haze), in millimetres, independent of distance. */
  diffuserScatterMm: number;
  /** Diffuser opacity as a percentage of light blocked (0 = clear, 100 = opaque). Transmittance = 1 - opacity. */
  opacity: number;

  // --- Cloud shape (3D volumetric view) ---
  /** Vertical thickness of the cloud volume above the LED plane, in millimetres. */
  cloudThicknessMm: number;
  /** Overall optical density of the cloud volume (how thick/opaque it looks). */
  cloudDensity: number;
  /** Background sky preset for cloud view. */
  cloudSky: CloudSkyPreset;
  /** Extra darkening applied when `cloudSky` is `night` (0..1). */
  cloudNightDarkness: number;

  // --- Cloud surface shape ---
  /** Height/strength of the cloud bumps (also modulates local thickness/transmission). */
  bumpHeight: number;
  /** Spatial frequency of the bumps (bigger = smaller, denser bumps). */
  bumpScale: number;
  /** Octaves of fbm noise used for the cloud shape. */
  bumpDetail: number;

  // --- Pattern ---
  /** Master on/off for the animated pattern layer (off = breathing only). */
  patternEnabled: boolean;
  pattern: PatternName;
  /** Animation speed multiplier. */
  speed: number;
  /** Pattern content level 0..1 (the color values, applied to both visual + hardware output). */
  brightness: number;
  /** Color/palette phase offset in degrees. */
  hueShift: number;
  /** Palette selection per pattern (so each pattern can use a different palette). */
  patternPalettes: Record<PatternName, PaletteName>;
  /** Post effect: add cloud-like motion after pattern + breathing. */
  cloudDynamicsEnabled: boolean;
  /** Noise style for cloud dynamics. */
  cloudDynamicsType: CloudDynamicsNoise;
  /** Strength of the dynamics modulation. */
  cloudDynamicsAmount: number;
  /** Spatial scale/frequency of the dynamics noise. */
  cloudDynamicsScale: number;
  /** Animation speed of the dynamics noise flow. */
  cloudDynamicsSpeed: number;
  /** Contrast/definition of the dynamics noise. */
  cloudDynamicsContrast: number;
  /** Cloud tint mix for dynamics: 0 = pure white cloud, 1 = full signal colour. */
  cloudDynamicsWhiteMix: number;

  // --- Look ---
  /** Ambient base glow of the surface even with LEDs dark. */
  ambient: number;
  /** Background tint behind the cloud. */
  backgroundTint: number;

  // --- Breathing (per-partition underlying pulse) ---
  /** Master on/off for the breathing layer. */
  breatheEnabled: boolean;
  /** Number of partitions (2..6). */
  partitions: number;
  /** How the space is divided into partitions. */
  partitionLayout: PartitionLayout;
  /** Edge softness / overlap between partitions: 0 = hard borders, 1 = heavy blend. */
  partitionSoftness: number;
  /** How overlapping partition oscillators combine with each other. */
  partitionBlend: OscBlend;
  /** Random seed for the scatter-based layouts (voronoi, gaussian). */
  partitionSeed: number;
  /** Breaths per minute (pulse rate). */
  breatheRate: number;
  /** Depth of the pulse 0..1 (how far it dims at the trough). */
  breatheDepth: number;
  /** Opacity of the breathing layer 0..1 (how strongly it shows over the pattern). */
  breatheMix: number;
  /** How the breathing layer blends with the current layer stack backdrop. */
  breatheBlend: BlendMode;
  /** Phase spread across partitions 0..1 (0 = all in sync, 1 = a full cycle). */
  breatheStagger: number;
  /** Base colour per partition (hex sRGB), index 0..5. */
  breatheColors: string[];
  /** For the "mask" layout: invert the image (dark = colour, light = absent). */
  maskInvert: boolean;
  /** For the "mask" layout: size of the mask over the scene (1 = fits scene). */
  maskScale: number;
  /** Superimpose the per-partition masks over their positions in the scene. */
  maskShowOverlay: boolean;
  /** For the "mask" layout: animate a slow continuous rotation of the masks. */
  maskRotate: boolean;
  /** Rotation speed in degrees per minute (negative = opposite direction). */
  maskRotateDegPerMin: number;

  // --- Streaming to real hardware ---
  streamEnabled: boolean;
  /** WebSocket URL of the local bridge server. */
  bridgeUrl: string;
  /** Target WLED controller IP. */
  wledHost: string;
  /** WLED real-time UDP port (default 21324). */
  wledPort: number;
  /** Physical strip wiring order so the visual maps correctly to hardware. */
  wiring: WiringOrder;
  /** Max frames/sec sent to hardware (visual still runs at full rate). */
  streamFps: number;
}

export type PartitionLayout =
  | "columns"
  | "rows"
  | "diagonal"
  | "rings"
  | "voronoi"
  | "gaussian"
  | "mask";

export const PARTITION_LAYOUTS: PartitionLayout[] = [
  "columns",
  "rows",
  "diagonal",
  "rings",
  "voronoi",
  "gaussian",
  "mask",
];

/**
 * How the breathing layer combines with the pattern layer underneath it, named
 * after the equivalent layer blend modes in graphics software. `normal` simply
 * overlays it; `additive` adds light (glow); `multiply` tints/pulses the
 * pattern; `screen`/`lighten` brighten; `darken`/`difference` etc. behave as in
 * Photoshop. The breathing opacity (`breatheMix`) controls how strongly it mixes.
 */
export type BlendMode =
  | "normal"
  | "additive"
  | "screen"
  | "multiply"
  | "lighten"
  | "darken"
  | "overlay"
  | "softLight"
  | "difference";

export const BLEND_MODES: BlendMode[] = [
  "normal",
  "additive",
  "screen",
  "multiply",
  "lighten",
  "darken",
  "overlay",
  "softLight",
  "difference",
];

/**
 * How overlapping partition oscillators combine into the single breathing layer
 * (before it is blended with the pattern). `average` is a weighted mean (the
 * natural blend); `additive` sums them so overlaps get brighter; `lighten`
 * keeps the brightest; `screen` is a softer brighten. Extra modes (`multiply`,
 * `darken`, `difference`) are available for more stylised interactions.
 */
export type OscBlend =
  | "average"
  | "additive"
  | "lighten"
  | "screen"
  | "multiply"
  | "darken"
  | "difference";

export const OSC_BLENDS: OscBlend[] = [
  "average",
  "additive",
  "lighten",
  "screen",
  "multiply",
  "darken",
  "difference",
];

export type CloudDynamicsNoise = "value" | "fbm" | "billow" | "ridged";
export const CLOUD_DYNAMICS_NOISES: CloudDynamicsNoise[] = [
  "value",
  "fbm",
  "billow",
  "ridged",
];

export type PaletteName =
  | "rainbow"
  | "sunset"
  | "ocean"
  | "forest"
  | "violet"
  | "ember"
  | "greyscale";

export const PALETTE_NAMES: PaletteName[] = [
  "rainbow",
  "sunset",
  "ocean",
  "forest",
  "violet",
  "ember",
  "greyscale",
];

export type PatternName =
  | "plasma"
  | "rainbowWaves"
  | "twinkle"
  | "fire"
  | "auroraDrift"
  | "breathe"
  | "rain"
  | "solid";

export const PATTERN_NAMES: PatternName[] = [
  "plasma",
  "rainbowWaves",
  "twinkle",
  "fire",
  "auroraDrift",
  "breathe",
  "rain",
  "solid",
];

export const defaultConfig: Config = {
  view: "panel",

  cloudWidthMm: 1200,
  cloudHeightMm: 600,

  rows: 8,
  cols: 16,
  ledType: "ws2812b-60",

  ledBrightness: 2.0,
  patternFps: 60,

  ledDistanceMm: 40,
  diffuserScatterMm: 6,
  opacity: 35,

  cloudThicknessMm: 450,
  cloudDensity: 0.85,
  cloudSky: "night",
  cloudNightDarkness: 0.45,

  bumpHeight: 0.55,
  bumpScale: 2.4,
  bumpDetail: 4,

  patternEnabled: true,
  pattern: "auroraDrift",
  speed: 1.0,
  brightness: 0.9,
  hueShift: 0,
  patternPalettes: {
    plasma: "rainbow",
    rainbowWaves: "rainbow",
    twinkle: "violet",
    fire: "ember",
    auroraDrift: "ocean",
    breathe: "sunset",
    rain: "ocean",
    solid: "rainbow",
  },
  cloudDynamicsEnabled: false,
  cloudDynamicsType: "fbm",
  cloudDynamicsAmount: 0.2,
  cloudDynamicsScale: 3.0,
  cloudDynamicsSpeed: 0.45,
  cloudDynamicsContrast: 1.2,
  cloudDynamicsWhiteMix: 0.35,

  ambient: 0.04,
  backgroundTint: 0.02,

  breatheEnabled: true,
  partitions: 3,
  partitionLayout: "columns",
  partitionSoftness: 0.35,
  partitionBlend: "average",
  partitionSeed: 1,
  breatheRate: 7,
  breatheDepth: 0.7,
  breatheMix: 0.5,
  breatheBlend: "normal",
  breatheStagger: 0.25,
  breatheColors: ["#3aa0ff", "#ff5d8f", "#ffd166", "#06d6a0", "#b08cff", "#ff8c42"],
  maskInvert: false,
  maskScale: 0.6,
  maskShowOverlay: false,
  maskRotate: false,
  maskRotateDegPerMin: 30,

  streamEnabled: false,
  bridgeUrl: "ws://localhost:8081",
  wledHost: "192.168.1.50",
  wledPort: 21324,
  wiring: "serpentine",
  streamFps: 40,
};
