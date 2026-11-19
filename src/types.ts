/**
 * Shared contracts between the data pipeline, renderer and UI.
 *
 * COORDINATES
 *  - Selenographic lat/lon in degrees. lat +90 = north pole. lon in [-180, 180], east positive,
 *    lon 0 / lat 0 = centre of the near side (mean-Earth / polar-axis frame, as used by LRO products).
 *  - World space: Moon is a sphere of radius 1 (= MOON_RADIUS_KM) centred at the origin.
 *      x = cos(lat) * sin(lon),  y = sin(lat),  z = cos(lat) * cos(lon)
 *    so +Y is north, +Z points at Earth, +X is lunar east (right-hand side as seen from Earth).
 *  - All global rasters in /public/data are equirectangular (simple cylindrical):
 *      left edge lon = -180, centre lon = 0, right edge lon = +180, top row lat = +90.
 *      u = (lon + 180) / 360,  v = (lat + 90) / 180  (v = 0 is the SOUTH edge, i.e. three.js flipY default).
 */
export const MOON_RADIUS_KM = 1737.4;

export interface RasterTier {
  /** URL relative to site root, e.g. "/data/color_4k.jpg" */
  url: string;
  width: number;
  height: number;
}

/** /data/manifest.json — written by tools/build_data.py */
export interface Manifest {
  generated: string;
  /** sRGB albedo, ascending resolution (2k, 4k, 8k). */
  color: RasterTier[];
  /** Tangent-space normal maps (R=+east, G=+north, B=+up, 0..255 -> -1..1), true 1x relief. */
  normal: RasterTier[];
  /** Normal-map xy were multiplied by this gain before encoding: n.xy = (rg*2-1) / normalGain. Default 1. */
  normalGain?: number;
  /**
   * Elevation, 16 bit packed in an 8-bit RGB PNG: value16 = R*256 + G.
   * metres = minMeters + value16 / 65535 * (maxMeters - minMeters), relative to the 1737.4 km sphere.
   */
  height: RasterTier[];
  heightRange: { minMeters: number; maxMeters: number };
  /**
   * Data-support raster, 8-bit RGB PNG: R = altimetry score, G = imagery score, B = combined score
   * (each 0..255 -> 0..100 %).
   */
  confidence: RasterTier;
  /**
   * Raw LOLA shot counts per source pixel, 8-bit greyscale PNG:
   * count = round(2^(value / countsLogScale) - 1).
   */
  lolaCounts: RasterTier & { countsLogScale: number; sourcePixelsPerDegree: number };
  /** Human readable provenance shown in the "About the data" panel. */
  sources: { id: string; title: string; provider: string; url: string; note: string }[];
  /** Plain-language description of how each score is computed. */
  confidenceMethod: { altimetry: string; imagery: string; combined: string };
}

/** /data/features.json — IAU nomenclature, sorted by descending diameter. */
export interface LunarFeature {
  name: string;
  /** e.g. "Crater", "Mare", "Mons", "Vallis", ... (IAU feature type, singular English form) */
  type: string;
  lat: number;
  lon: number;
  diameterKm: number;
}

/** /data/sites.json — spacecraft landing / impact sites. */
export interface LandingSite {
  name: string;
  agency: string;
  year: number;
  kind: 'crewed' | 'lander' | 'rover' | 'sample-return' | 'impact';
  lat: number;
  lon: number;
  note?: string;
}

export interface LatLon { lat: number; lon: number }

export type LightingMode = 'realtime' | 'manual' | 'full';
export type QualityTier = 'low' | 'medium' | 'high';

/** Emitted by the renderer whenever the camera settles or moves. */
export interface ViewState {
  /** Sub-camera point (centre of the view). */
  center: LatLon;
  /** Camera altitude above the mean sphere in km. */
  altitudeKm: number;
  /** Approximate ground resolution at the view centre, metres per CSS pixel. */
  metersPerPixel: number;
  /** True while streamed high-resolution tiles are in use / loading / unavailable. */
  tiles: 'off' | 'loading' | 'active' | 'unavailable';
}

export interface Marker { id: string; lat: number; lon: number; label: string; kind: 'feature' | 'site' | 'selection' }

/**
 * Implemented by src/render/MoonView.ts (default export `MoonView` class implementing this).
 * The UI layer only talks to the renderer through this interface.
 */
export interface IMoonView {
  /** Resolves when first frame with base textures has rendered. */
  ready: Promise<void>;
  setLighting(mode: LightingMode, opts?: { date?: Date; sunLon?: number; sunLat?: number }): void;
  /** Show/hide the data-support heat map overlay (0 = hidden .. 1 = full). */
  setConfidenceOverlay(opacity: number): void;
  /** Relief exaggeration for displacement + normals (1 = true scale). */
  setReliefScale(scale: number): void;
  /** Animate the camera so that lat/lon is centred. altitudeKm optional. */
  flyTo(target: LatLon, altitudeKm?: number): Promise<void>;
  /** Markers are rendered/positioned by the renderer (occluded on the far side). */
  setMarkers(markers: Marker[]): void;
  /** Selected point (shows a reticle on the surface). null clears. */
  setSelection(p: LatLon | null): void;
  /** Tap / click on the surface (not fired after a drag). */
  onPick(cb: (p: LatLon) => void): void;
  onMarkerClick(cb: (id: string) => void): void;
  /** Fired (throttled) while the view changes. */
  onViewChange(cb: (v: ViewState) => void): void;
  getViewState(): ViewState;
  setAutoRotate(on: boolean): void;
  resetView(): void;
  dispose(): void;
}
