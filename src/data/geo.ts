import { MOON_RADIUS_KM, type LatLon } from '../types';

export const DEG = Math.PI / 180;

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/** Wrap a longitude into [-180, 180). */
export function wrapLon(lon: number): number {
  return ((((lon + 180) % 360) + 360) % 360) - 180;
}

const MINUS = '−';

export function formatLat(lat: number, digits = 2): string {
  return `${Math.abs(lat).toFixed(digits)}° ${lat < 0 ? 'S' : 'N'}`;
}

export function formatLon(lon: number, digits = 2): string {
  const l = wrapLon(lon);
  return `${Math.abs(l).toFixed(digits)}° ${l < 0 ? 'W' : 'E'}`;
}

export function formatLatLon(p: LatLon, digits = 2): string {
  return `${formatLat(p.lat, digits)}, ${formatLon(p.lon, digits)}`;
}

const intFmt = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });

export function formatInt(n: number): string {
  return intFmt.format(Math.round(n));
}

/** Elevation relative to the 1737.4 km reference sphere, e.g. "+1,204 m" / "−2,340 m". */
export function formatElevation(m: number): string {
  const r = Math.round(m);
  const sign = r < 0 ? MINUS : r > 0 ? '+' : '';
  return `${sign}${intFmt.format(Math.abs(r))} m`;
}

export function formatDistanceKm(km: number): string {
  if (km < 1) return `${Math.max(10, Math.round((km * 1000) / 10) * 10)} m`;
  if (km < 10) return `${km.toFixed(1)} km`;
  return `${intFmt.format(km)} km`;
}

export function formatAltitude(km: number): string {
  if (km < 10) return `${km.toFixed(1)} km`;
  return `${intFmt.format(km)} km`;
}

export function formatResolution(mpp: number): string {
  if (mpp >= 1000) return `${(mpp / 1000).toFixed(mpp >= 10000 ? 0 : 1)} km/px`;
  return `${intFmt.format(mpp)} m/px`;
}

/** Unit vector in the world frame defined in types.ts. */
export function toVec(lat: number, lon: number): [number, number, number] {
  const cl = Math.cos(lat * DEG);
  return [cl * Math.sin(lon * DEG), Math.sin(lat * DEG), cl * Math.cos(lon * DEG)];
}

/** Great-circle distance in radians. */
export function angularDistance(a: LatLon, b: LatLon): number {
  const va = toVec(a.lat, a.lon);
  const vb = toVec(b.lat, b.lon);
  return Math.acos(clamp(va[0] * vb[0] + va[1] * vb[1] + va[2] * vb[2], -1, 1));
}

export function distanceKm(a: LatLon, b: LatLon): number {
  return angularDistance(a, b) * MOON_RADIUS_KM;
}

export interface ScaleBar { px: number; label: string }

/** Pick a round distance whose on-screen length is close to (and not above) maxPx. */
export function niceScale(metersPerPixel: number, maxPx: number): ScaleBar | null {
  if (!(metersPerPixel > 0) || !isFinite(metersPerPixel)) return null;
  const maxM = metersPerPixel * maxPx;
  const pow = Math.pow(10, Math.floor(Math.log10(maxM)));
  const frac = maxM / pow;
  const step = frac >= 5 ? 5 : frac >= 2 ? 2 : 1;
  const m = step * pow;
  const label = m >= 1000 ? `${intFmt.format(m / 1000)} km` : `${intFmt.format(m)} m`;
  return { px: m / metersPerPixel, label };
}
