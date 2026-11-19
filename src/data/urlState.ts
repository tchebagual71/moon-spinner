import type { LatLon } from '../types';
import { clamp, wrapLon } from './geo';

export interface HashState {
  center?: LatLon;
  altitudeKm?: number;
  selection?: LatLon;
}

function num(v: string | null | undefined): number | undefined {
  if (v === null || v === undefined || v === '') return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

export function readHash(): HashState {
  const out: HashState = {};
  try {
    const p = new URLSearchParams(location.hash.replace(/^#/, ''));
    const lat = num(p.get('lat'));
    const lon = num(p.get('lon'));
    if (lat !== undefined && lon !== undefined) out.center = { lat: clamp(lat, -90, 90), lon: wrapLon(lon) };
    const alt = num(p.get('alt'));
    if (alt !== undefined && alt > 0) out.altitudeKm = alt;
    const sel = p.get('sel')?.split(',');
    if (sel && sel.length === 2) {
      const sLat = num(sel[0]);
      const sLon = num(sel[1]);
      if (sLat !== undefined && sLon !== undefined) out.selection = { lat: clamp(sLat, -90, 90), lon: wrapLon(sLon) };
    }
  } catch {
    /* malformed hash: ignore */
  }
  return out;
}

let timer = 0;
let pending: HashState | null = null;

function flush(): void {
  timer = 0;
  const s = pending;
  pending = null;
  if (!s?.center) return;
  const parts = [`lat=${s.center.lat.toFixed(3)}`, `lon=${wrapLon(s.center.lon).toFixed(3)}`];
  if (s.altitudeKm !== undefined) parts.push(`alt=${s.altitudeKm < 100 ? s.altitudeKm.toFixed(1) : Math.round(s.altitudeKm)}`);
  if (s.selection) parts.push(`sel=${s.selection.lat.toFixed(4)},${wrapLon(s.selection.lon).toFixed(4)}`);
  const hash = '#' + parts.join('&');
  if (hash === location.hash) return;
  try {
    history.replaceState(null, '', location.pathname + location.search + hash);
  } catch {
    /* e.g. sandboxed iframe */
  }
}

/** Throttled write of the shareable view state to the URL hash. */
export function writeHash(state: HashState): void {
  pending = state;
  if (!timer) timer = window.setTimeout(flush, 400);
}
