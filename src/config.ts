export type WiringOrder = "row-major" | "serpentine" | "column-major" | "column-serpentine";
export type StreamChannelOrder = "RGB" | "RBG" | "GRB" | "GBR" | "BRG" | "BGR";

/** One colour stop along the 24h timeline tint. `time` is normalised 0..1 (00:00..24:00). */
export interface TintSwatch {
  time: number;
  color: string;
}

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
  /** Deprecated: UI removed, emitter gain is fixed (kept for saved-config compatibility). */
  ledBrightness: number;
  /** Shared simulation + stream frame rate target (fps). */
  fps: number;
  /** Deprecated: use `fps` (kept for saved-config compatibility). */
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
  /** Number of partitions (1..6). */
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
  /** Minimum brightness factor at breathing trough (0 = black, 1 = no dim). */
  breatheMinBrightness: number;
  /** Minimum chroma amount at breathing trough (0 = no breath colour, 1 = full colour). */
  breatheMinColor: number;
  /** Deprecated: breathing opacity is fixed at 1 (kept for saved-config compatibility). */
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

  // --- Timeline tint (24h color progression multiplied over the final signal) ---
  /** Master on/off for the timeline tint layer. */
  tintEnabled: boolean;
  /** Whether the timeline is currently advancing. */
  tintPlaying: boolean;
  /** Current normalised position 0..1 along a midnight->midnight cycle. */
  tintTime: number;
  /** Real seconds for a full 24h cycle (lower = faster preview). */
  tintCycleSeconds: number;
  /** Colour stops along the day. Each `{ time: 0..1, color: '#hex' }`. */
  tintSwatches: TintSwatch[];

  // --- Streaming to real hardware ---
  streamEnabled: boolean;
  /** WebSocket URL of the local bridge server. */
  bridgeUrl: string;
  /** Target WLED controller IP. */
  wledHost: string;
  /** WLED DDP UDP port (default 4048). */
  wledPort: number;
  /** Physical strip wiring order so the visual maps correctly to hardware. */
  wiring: WiringOrder;
  /** Highlight-rolloff exposure for the stream (matches the on-screen tone map). Lower = dimmer/more rolloff. */
  streamExposure: number;
  /** Encoding gamma for the streamed bytes. 1 = linear (raw WS2812B / SPI controllers); raise if the controller applies its own gamma decode. */
  streamGamma: number;
  /** Byte order of color channels expected by the hardware/controller. */
  streamChannelOrder: StreamChannelOrder;
  /** Stream colour saturation in linear space: 1 = neutral, >1 richer colour, <1 washed out. */
  streamSaturation: number;
  /** Per-channel stream gain trim for calibrating LED white balance (red). */
  streamRedGain: number;
  /** Per-channel stream gain trim for calibrating LED white balance (green). */
  streamGreenGain: number;
  /** Per-channel stream gain trim for calibrating LED white balance (blue). */
  streamBlueGain: number;
  /** Deprecated: use `fps` (kept for saved-config compatibility). */
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
 * Photoshop.
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
 * (before it is blended with the pattern). `normal` is a weighted mean (the
 * natural blend); `additive` sums them so overlaps get brighter; `lighten`
 * keeps the brightest; `screen` is a softer brighten. Extra modes (`multiply`,
 * `darken`, `difference`) are available for more stylised interactions.
 */
export type OscBlend =
  | "normal"
  // Back-compat alias for older saved configs.
  | "average"
  | "additive"
  | "lighten"
  | "screen"
  | "multiply"
  | "darken"
  | "difference";

export const OSC_BLENDS: OscBlend[] = [
  "normal",
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
  cols: 32,
  ledType: "ws2812b-60",

  ledBrightness: 1.0,
  fps: 60,
  patternFps: 60,

  ledDistanceMm: 40,
  diffuserScatterMm: 6,
  opacity: 35,

  cloudThicknessMm: 450,
  cloudDensity: 0.85,
  cloudSky: "night",
  cloudNightDarkness: 0.45,

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
  partitionBlend: "normal",
  partitionSeed: 1,
  breatheRate: 7,
  breatheDepth: 0.7,
  breatheMinBrightness: 0.0,
  breatheMinColor: 0.0,
  breatheMix: 1.0,
  breatheBlend: "normal",
  breatheStagger: 0.25,
  breatheColors: ["#3aa0ff", "#ff5d8f", "#ffd166", "#06d6a0", "#b08cff", "#ff8c42"],
  maskInvert: false,
  maskScale: 0.6,
  maskShowOverlay: false,
  maskRotate: false,
  maskRotateDegPerMin: 30,

  tintEnabled: false,
  tintPlaying: false,
  tintTime: 0.5,
  tintCycleSeconds: 60,
  tintSwatches: [
    { time: 0.0, color: "#0a1a3a" }, // midnight: deep blue
    { time: 0.25, color: "#ff8a3d" }, // 06:00: sunrise warm
    { time: 0.5, color: "#ffffff" }, // noon: neutral white
    { time: 0.75, color: "#ff5d2e" }, // 18:00: sunset
  ],

  streamEnabled: false,
  bridgeUrl: "ws://localhost:8081",
  wledHost: "10.0.4.54",
  wledPort: 4048,
  wiring: "serpentine",
  streamExposure: 1.25,
  streamGamma: 1.0,
  streamChannelOrder: "RGB",
  streamSaturation: 1.0,
  streamRedGain: 1.0,
  streamGreenGain: 1.0,
  streamBlueGain: 1.0,
  streamFps: 60,
};
