/** Colour ramp shared with the globe overlay (stops come from src/render/confidenceRamp.ts). */
export type RampStops = [number, string][];

/** Used only if the renderer's ramp module cannot be loaded. */
export const FALLBACK_RAMP: RampStops = [
  [0, '#b8402f'],
  [0.4, '#e2a23b'],
  [0.7, '#c9d38a'],
  [1, '#49b9a6'],
];

/** Scores below this are treated as "sparse / inferred" and get a hatch pattern as well as colour. */
export const LOW_SUPPORT = 40;

type RGB = [number, number, number];

function parseColor(css: string): RGB {
  const c = document.createElement('canvas');
  c.width = c.height = 1;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  if (!ctx) return [128, 128, 128];
  ctx.fillStyle = '#808080';
  ctx.fillStyle = css;
  ctx.fillRect(0, 0, 1, 1);
  const d = ctx.getImageData(0, 0, 1, 1).data;
  return [d[0], d[1], d[2]];
}

export class Ramp {
  private readonly stops: { t: number; rgb: RGB; css: string }[];

  constructor(stops: RampStops) {
    const valid = (Array.isArray(stops) ? stops : []).filter((s) => Array.isArray(s) && typeof s[0] === 'number' && typeof s[1] === 'string');
    const use = valid.length >= 2 ? valid : FALLBACK_RAMP;
    this.stops = use.map(([t, css]) => ({ t, css, rgb: parseColor(css) })).sort((a, b) => a.t - b.t);
  }

  /** Colour for a 0..100 score. */
  color(score: number): string {
    const t = Math.min(1, Math.max(0, score / 100));
    const s = this.stops;
    if (t <= s[0].t) return rgb(s[0].rgb);
    for (let i = 1; i < s.length; i++) {
      if (t <= s[i].t) {
        const a = s[i - 1];
        const b = s[i];
        const k = b.t === a.t ? 0 : (t - a.t) / (b.t - a.t);
        return rgb([a.rgb[0] + (b.rgb[0] - a.rgb[0]) * k, a.rgb[1] + (b.rgb[1] - a.rgb[1]) * k, a.rgb[2] + (b.rgb[2] - a.rgb[2]) * k]);
      }
    }
    return rgb(s[s.length - 1].rgb);
  }

  gradient(direction = 'to right'): string {
    return `linear-gradient(${direction}, ${this.stops.map((s) => `${rgb(s.rgb)} ${(s.t * 100).toFixed(1)}%`).join(', ')})`;
  }
}

function rgb(c: RGB | number[]): string {
  return `rgb(${Math.round(c[0])} ${Math.round(c[1])} ${Math.round(c[2])})`;
}

export interface Grade {
  key: 'high' | 'good' | 'partial' | 'low';
  label: string;
  icon: string;
}

export function gradeFor(score: number): Grade {
  if (score >= 80) return { key: 'high', label: 'Well measured', icon: 'check' };
  if (score >= 60) return { key: 'good', label: 'Mostly measured', icon: 'check' };
  if (score >= LOW_SUPPORT) return { key: 'partial', label: 'Partly interpolated', icon: 'partial' };
  return { key: 'low', label: 'Sparse / inferred', icon: 'warn' };
}
