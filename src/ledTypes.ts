/**
 * Selectable LED products, chosen so the simulation can reasonably represent
 * each one. The properties that actually change the look:
 *   - spreadCoeff: how wide the emitter throws light toward the diffuser
 *     (beam/package geometry). Bare wide-angle SMD ~0.5; lensed bullet nodes
 *     are narrower; tiny 3535 packages a touch wider relative to pitch.
 *   - relBrightness: relative luminous output at nominal drive.
 *   - rgbw: has a dedicated white die -> cleaner, brighter, less-saturated whites.
 *   - maxDensityPerM: the densest this product is sold at (for the buy estimate
 *     and feasibility check). Node strings can be placed at any spacing.
 */
export interface LedType {
  id: string;
  label: string;
  form: "strip" | "node";
  maxDensityPerM: number;
  voltage: number;
  spreadCoeff: number;
  relBrightness: number;
  rgbw: boolean;
  /** Physical LED package footprint (mm). Sets the minimum pitch ALONG a row —
   *  LEDs can't be placed closer than this without physically overlapping. */
  ledSizeMm: number;
  /** Physical strip/node width (mm). Sets the minimum pitch BETWEEN rows. */
  stripWidthMm: number;
  note: string;
}

export const LED_TYPES: LedType[] = [
  {
    id: "ws2812b-30",
    label: "WS2812B 30/m (5V, 5050 RGB)",
    form: "strip",
    maxDensityPerM: 30,
    voltage: 5,
    spreadCoeff: 0.5,
    relBrightness: 1.0,
    rgbw: false,
    ledSizeMm: 5,
    stripWidthMm: 10,
    note: "Most common addressable strip. Wide Lambertian emitter.",
  },
  {
    id: "ws2812b-60",
    label: "WS2812B 60/m (5V, 5050 RGB)",
    form: "strip",
    maxDensityPerM: 60,
    voltage: 5,
    spreadCoeff: 0.5,
    relBrightness: 1.0,
    rgbw: false,
    ledSizeMm: 5,
    stripWidthMm: 10,
    note: "Denser WS2812B. Watch 5V voltage drop on long runs.",
  },
  {
    id: "ws2812b-144",
    label: "WS2812B 144/m (5V, 3535 RGB)",
    form: "strip",
    maxDensityPerM: 144,
    voltage: 5,
    spreadCoeff: 0.55,
    relBrightness: 0.7,
    rgbw: false,
    ledSizeMm: 3.5,
    stripWidthMm: 8,
    note: "Tiny 3535 LEDs, lower per-LED output, heavy current draw.",
  },
  {
    id: "ws2815-30",
    label: "WS2815 30/m (12V RGB)",
    form: "strip",
    maxDensityPerM: 60,
    voltage: 12,
    spreadCoeff: 0.5,
    relBrightness: 1.1,
    rgbw: false,
    ledSizeMm: 5,
    stripWidthMm: 11,
    note: "12V with backup data line; less voltage drop over distance.",
  },
  {
    id: "sk6812-rgbw-60",
    label: "SK6812 RGBW 60/m (5V)",
    form: "strip",
    maxDensityPerM: 60,
    voltage: 5,
    spreadCoeff: 0.5,
    relBrightness: 1.2,
    rgbw: true,
    ledSizeMm: 5,
    stripWidthMm: 10,
    note: "Dedicated white die: cleaner whites/pastels, great for clouds.",
  },
  {
    id: "apa102-60",
    label: "APA102 / HD107s 60/m (5V)",
    form: "strip",
    maxDensityPerM: 60,
    voltage: 5,
    spreadCoeff: 0.5,
    relBrightness: 1.2,
    rgbw: false,
    ledSizeMm: 5,
    stripWidthMm: 10,
    note: "Separate clock line, very high PWM rate (flicker-free on camera).",
  },
  {
    id: "ws2811-node-12mm",
    label: "WS2811 12mm bullet nodes (5V/12V)",
    form: "node",
    maxDensityPerM: 60,
    voltage: 12,
    spreadCoeff: 0.7,
    relBrightness: 1.0,
    rgbw: false,
    ledSizeMm: 12,
    stripWidthMm: 12,
    note: "Pixels on wire — place at any spacing. Diffused bullet caps.",
  },
];

export function getLedType(id: string): LedType {
  return LED_TYPES.find((t) => t.id === id) ?? LED_TYPES[0];
}

/**
 * Maximum LEDs that physically fit in a cloud of the given size for a given LED
 * type, before the LED packages / strips would overlap. This is a hard physical
 * limit and is independent of how much the *light* overlaps through the diffuser.
 */
export function maxGrid(
  ledTypeId: string,
  cloudWidthMm: number,
  cloudHeightMm: number
): { maxCols: number; maxRows: number } {
  const led = getLedType(ledTypeId);
  return {
    maxCols: Math.max(1, Math.floor(cloudWidthMm / led.ledSizeMm)),
    maxRows: Math.max(1, Math.floor(cloudHeightMm / led.stripWidthMm)),
  };
}
