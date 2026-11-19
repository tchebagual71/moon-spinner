/** Gazetteer index: search, nearest-feature lookup and zoom-dependent label selection. */
import { MOON_RADIUS_KM, type LandingSite, type LatLon, type LunarFeature, type Marker } from '../types';
import { clamp, toVec } from './geo';

export type Place =
  | { kind: 'feature'; id: string; name: string; lat: number; lon: number; feature: LunarFeature }
  | { kind: 'site'; id: string; name: string; lat: number; lon: number; site: LandingSite };

export interface NearestFeature {
  feature: LunarFeature;
  /** Distance from the point to the feature centre. */
  centerKm: number;
  /** True when the point lies within the feature's nominal diameter. */
  inside: boolean;
}

export function normalize(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[‐-―]/g, '-')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

export function featureTypeLabel(f: LunarFeature): string {
  return f.type === 'Satellite Feature' ? 'Satellite crater' : f.type;
}

export function siteKindLabel(s: LandingSite): string {
  switch (s.kind) {
    case 'crewed': return 'Crewed landing';
    case 'lander': return 'Lander';
    case 'rover': return 'Rover';
    case 'sample-return': return 'Sample return';
    case 'impact': return 'Impact site';
  }
}

/** Camera altitude that frames a feature of the given size comfortably. */
export function altitudeForDiameter(diameterKm: number): number {
  return clamp(diameterKm * 2.6, 60, 5200);
}

async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return (await res.json()) as T;
}

export class Places {
  readonly features: LunarFeature[];
  readonly sites: LandingSite[];
  private readonly vec: Float32Array;
  private readonly radius: Float32Array; // angular radius, radians
  private readonly names: string[];
  private readonly siteNames: string[];

  constructor(features: LunarFeature[], sites: LandingSite[]) {
    this.features = features;
    this.sites = sites;
    this.vec = new Float32Array(features.length * 3);
    this.radius = new Float32Array(features.length);
    this.names = new Array<string>(features.length);
    features.forEach((f, i) => {
      const v = toVec(f.lat, f.lon);
      this.vec.set(v, i * 3);
      this.radius[i] = (f.diameterKm || 0) / 2 / MOON_RADIUS_KM;
      this.names[i] = normalize(f.name);
    });
    this.siteNames = sites.map((s) => normalize(`${s.name} ${s.agency}`));
  }

  /** Loads both gazetteer files; either may fail independently (the app still works). */
  static async load(featuresUrl = '/data/features.json', sitesUrl = '/data/sites.json'): Promise<Places> {
    const [f, s] = await Promise.all([
      fetchJson<LunarFeature[]>(featuresUrl).catch((e) => {
        console.warn('[places] features unavailable', e);
        return [] as LunarFeature[];
      }),
      fetchJson<LandingSite[]>(sitesUrl).catch((e) => {
        console.warn('[places] landing sites unavailable', e);
        return [] as LandingSite[];
      }),
    ]);
    return new Places(Array.isArray(f) ? f : [], Array.isArray(s) ? s : []);
  }

  featurePlace(i: number): Place {
    const f = this.features[i];
    return { kind: 'feature', id: `f:${i}`, name: f.name, lat: f.lat, lon: f.lon, feature: f };
  }

  sitePlace(i: number): Place {
    const s = this.sites[i];
    return { kind: 'site', id: `s:${i}`, name: s.name, lat: s.lat, lon: s.lon, site: s };
  }

  byId(id: string): Place | null {
    const i = Number(id.slice(2));
    if (!Number.isInteger(i) || i < 0) return null;
    if (id.startsWith('f:') && i < this.features.length) return this.featurePlace(i);
    if (id.startsWith('s:') && i < this.sites.length) return this.sitePlace(i);
    return null;
  }

  findFeature(name: string): Place | null {
    const n = normalize(name);
    const i = this.names.indexOf(n);
    return i >= 0 ? this.featurePlace(i) : null;
  }

  findSite(prefix: string): Place | null {
    const n = normalize(prefix);
    const i = this.siteNames.findIndex((s) => s.startsWith(n));
    return i >= 0 ? this.sitePlace(i) : null;
  }

  /**
   * Named feature that best describes a point: the smallest feature that contains it, otherwise
   * the one whose rim is closest.
   */
  nearest(p: LatLon): NearestFeature | null {
    const n = this.features.length;
    if (!n) return null;
    const [x, y, z] = toVec(p.lat, p.lon);
    const v = this.vec;
    let bestIn = -1;
    let bestInR = Infinity;
    let bestOut = -1;
    let bestOutEdge = Infinity;
    let bestOutAng = 0;
    let bestInAng = 0;
    for (let i = 0, j = 0; i < n; i++, j += 3) {
      const dot = v[j] * x + v[j + 1] * y + v[j + 2] * z;
      const r = this.radius[i];
      // Cheap reject: more than ~23° beyond anything useful.
      if (dot < 0.92 && r < 0.4) continue;
      const ang = Math.acos(dot > 1 ? 1 : dot < -1 ? -1 : dot);
      if (ang <= r) {
        if (r < bestInR) {
          bestInR = r;
          bestIn = i;
          bestInAng = ang;
        }
      } else if (ang - r < bestOutEdge) {
        bestOutEdge = ang - r;
        bestOut = i;
        bestOutAng = ang;
      }
    }
    // Prefer a small nearby feature over a vast containing one (e.g. a crater 5 km away vs "Mare Imbrium").
    if (bestIn >= 0) {
      const containingKm = bestInR * 2 * MOON_RADIUS_KM;
      const outKm = bestOutAng * MOON_RADIUS_KM;
      if (bestOut >= 0 && containingKm > 300 && outKm < 40) {
        return { feature: this.features[bestOut], centerKm: outKm, inside: false };
      }
      return { feature: this.features[bestIn], centerKm: bestInAng * MOON_RADIUS_KM, inside: true };
    }
    if (bestOut >= 0) return { feature: this.features[bestOut], centerKm: bestOutAng * MOON_RADIUS_KM, inside: false };
    return null;
  }

  /**
   * Zoom-dependent label set: biggest features when zoomed out, more detail as the view narrows,
   * limited to the neighbourhood of the view centre and decluttered.
   */
  labels(center: LatLon, altitudeKm: number, spanKm: number, cap: number): Marker[] {
    const n = this.features.length;
    if (!n || cap <= 0) return [];
    const horizon = Math.acos(MOON_RADIUS_KM / (MOON_RADIUS_KM + Math.max(1, altitudeKm)));
    const reach = Math.min(horizon * 0.92, (spanKm * 0.75) / MOON_RADIUS_KM);
    const minDot = Math.cos(reach);
    const minDiam = spanKm * 0.035;
    const maxDiam = spanKm * 1.6;
    const allowSatellites = spanKm < 500;
    const sep = (spanKm * 0.085) / MOON_RADIUS_KM;
    const sepDot = Math.cos(sep);
    const [x, y, z] = toVec(center.lat, center.lon);
    const v = this.vec;
    const out: Marker[] = [];
    const chosen: number[] = [];
    for (let i = 0, j = 0; i < n && out.length < cap; i++, j += 3) {
      const f = this.features[i];
      if (f.diameterKm < minDiam) break; // sorted by descending diameter
      if (f.diameterKm > maxDiam) continue;
      if (!allowSatellites && f.type === 'Satellite Feature') continue;
      if (v[j] * x + v[j + 1] * y + v[j + 2] * z < minDot) continue;
      let clash = false;
      for (const c of chosen) {
        if (v[j] * v[c] + v[j + 1] * v[c + 1] + v[j + 2] * v[c + 2] > sepDot) {
          clash = true;
          break;
        }
      }
      if (clash) continue;
      chosen.push(j);
      out.push({ id: `f:${i}`, lat: f.lat, lon: f.lon, label: f.name, kind: 'feature' });
    }
    return out;
  }

  siteMarkers(): Marker[] {
    return this.sites.map((s, i) => ({ id: `s:${i}`, lat: s.lat, lon: s.lon, label: s.name, kind: 'site' as const }));
  }

  /** Instant fuzzy search across features and landing sites. */
  search(query: string, limit = 8): Place[] {
    const q = normalize(query);
    if (!q) return [];
    const scored: { score: number; place: () => Place; order: number }[] = [];
    const score = (name: string): number => {
      if (name === q) return 1000;
      if (name.startsWith(q)) return 800 - Math.min(100, name.length - q.length);
      const wi = name.indexOf(' ' + q);
      if (wi >= 0) return 620 - Math.min(100, wi);
      const si = name.indexOf(q);
      if (si >= 0) return 480 - Math.min(100, si);
      // Every query token must prefix some word ("mare tranq", "apollo 11").
      const tokens = q.split(' ');
      if (tokens.length > 1) {
        const words = name.split(' ');
        if (tokens.every((t) => words.some((w) => w.startsWith(t)))) return 560;
      }
      return q.length >= 3 ? subsequence(q, name) : 0;
    };
    this.siteNames.forEach((name, i) => {
      const s = score(name);
      if (s > 0) scored.push({ score: s + 15, place: () => this.sitePlace(i), order: i });
    });
    const names = this.names;
    for (let i = 0; i < names.length; i++) {
      const s = score(names[i]);
      // Features are sorted by size; use rank as a gentle tie-break so "Tycho" beats "Tycho A".
      if (s > 0) scored.push({ score: s - i / names.length, place: () => this.featurePlace(i), order: i });
    }
    scored.sort((a, b) => b.score - a.score || a.order - b.order);
    return scored.slice(0, limit).map((s) => s.place());
  }
}

/** Typo-tolerant fallback: in-order character match, rewarded for contiguity and early position. */
function subsequence(q: string, name: string): number {
  let qi = 0;
  let run = 0;
  let bonus = 0;
  let first = -1;
  for (let i = 0; i < name.length && qi < q.length; i++) {
    if (name[i] === q[qi]) {
      if (first < 0) first = i;
      run++;
      bonus += run;
      qi++;
    } else {
      run = 0;
    }
  }
  if (qi < q.length) return 0;
  const density = bonus / ((q.length * (q.length + 1)) / 2);
  if (density < 0.45) return 0;
  return 120 + density * 200 - Math.min(60, first * 6) - Math.min(40, name.length - q.length);
}
