/**
 * Colour ramp for the data-support ("confidence") overlay.
 *
 * Sequential, lightness increases monotonically with the score so the order survives
 * colour-vision deficiencies and greyscale: low support = dark plum / magenta (warm),
 * high support = pale teal (cool). The shader interpolates linearly in sRGB between the stops,
 * exactly like a CSS `linear-gradient`, so a legend built from these stops matches the globe.
 */
export const CONFIDENCE_RAMP: [number, string][] = [
  [0.0, '#2a0b3d'],
  [0.15, '#5c1470'],
  [0.3, '#9c1f7f'],
  [0.45, '#d1447a'],
  [0.6, '#ee7b66'],
  [0.75, '#f5b56a'],
  [0.88, '#d6e08a'],
  [1.0, '#8ef0dc'],
];

/** Scores below this fraction (0..1) additionally get diagonal hatching on the globe. */
export const CONFIDENCE_HATCH_BELOW = 0.4;

/** CSS gradient string for legends. */
export function confidenceGradientCss(direction = 'to right'): string {
  return `linear-gradient(${direction}, ${CONFIDENCE_RAMP.map(([t, c]) => `${c} ${(t * 100).toFixed(1)}%`).join(', ')})`;
}

/** Ramp stops as [stop, r, g, b] with sRGB components in 0..1 (used by the shader). */
export function confidenceRampRgb(): [number, number, number, number][] {
  return CONFIDENCE_RAMP.map(([t, hex]) => {
    const n = parseInt(hex.slice(1), 16);
    return [t, ((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
  });
}
