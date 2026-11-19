/**
 * CPU-side copies of the measurement rasters (elevation, data support, LOLA shot counts) so the UI
 * can report real values under the cursor. Everything is decoded once into compact typed arrays;
 * interpolation always happens on DECODED values (never on the packed PNG bytes).
 */
import { MOON_RADIUS_KM, type Manifest, type RasterTier } from '../types';

export interface Confidence {
  /** 0..100 */
  altimetry: number;
  imagery: number;
  combined: number;
}

interface Grid<T extends ArrayLike<number>> {
  w: number;
  h: number;
  ch: number;
  data: T;
}

export type ProgressFn = (fraction: number) => void;

async function fetchBlob(url: string, onProgress?: ProgressFn): Promise<Blob> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  const total = Number(res.headers.get('content-length')) || 0;
  if (!res.body || !total || !onProgress) {
    const b = await res.blob();
    onProgress?.(1);
    return b;
  }
  const reader = res.body.getReader();
  const chunks: BlobPart[] = [];
  let got = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    got += value.byteLength;
    onProgress(Math.min(1, got / total));
  }
  onProgress(1);
  return new Blob(chunks, { type: res.headers.get('content-type') ?? 'image/png' });
}

type StripFn = (px: Uint8ClampedArray, firstPixel: number, pixelCount: number) => void;

/**
 * Decode a PNG without colour management or alpha premultiplication and hand its raw RGBA to
 * `onStrip` in horizontal bands, so a 5760x2880 raster never needs a full-size RGBA copy.
 */
async function readPixels(url: string, onProgress: ProgressFn | undefined, init: (w: number, h: number) => StripFn): Promise<void> {
  const blob = await fetchBlob(url, onProgress);
  let bmp: ImageBitmap;
  try {
    bmp = await createImageBitmap(blob, { colorSpaceConversion: 'none', premultiplyAlpha: 'none' });
  } catch {
    bmp = await createImageBitmap(blob);
  }
  const { width, height } = bmp;
  const band = Math.max(1, Math.min(height, Math.floor((4 * 1024 * 1024) / width)));
  let ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null;
  if (typeof OffscreenCanvas !== 'undefined') {
    ctx = new OffscreenCanvas(width, band).getContext('2d', { willReadFrequently: true });
  } else {
    const c = document.createElement('canvas');
    c.width = width;
    c.height = band;
    ctx = c.getContext('2d', { willReadFrequently: true });
  }
  if (!ctx) throw new Error('2D canvas unavailable');
  ctx.imageSmoothingEnabled = false;
  ctx.globalCompositeOperation = 'copy';
  const onStrip = init(width, height);
  for (let y = 0; y < height; y += band) {
    const rows = Math.min(band, height - y);
    ctx.drawImage(bmp, 0, y, width, rows, 0, 0, width, rows);
    onStrip(ctx.getImageData(0, 0, width, rows).data, y * width, rows * width);
    // Yield between bands so decoding never blocks interaction for long.
    await new Promise<void>((r) => setTimeout(r, 0));
  }
  bmp.close();
}

/**
 * Bilinear sample of an equirectangular grid (row 0 = +90° lat, column 0 = −180° lon, pixel centres
 * at half-integer positions). Wraps in longitude, clamps at the poles.
 */
function bilinear(g: Grid<ArrayLike<number>>, lat: number, lon: number, c: number, decode?: (v: number) => number): number {
  const fx = ((lon + 180) / 360) * g.w - 0.5;
  const fy = Math.min(g.h - 1, Math.max(0, ((90 - lat) / 180) * g.h - 0.5));
  const x0f = Math.floor(fx);
  const y0 = Math.floor(fy);
  const tx = fx - x0f;
  const ty = fy - y0;
  const x0 = ((x0f % g.w) + g.w) % g.w;
  const x1 = (x0 + 1) % g.w;
  const y1 = Math.min(g.h - 1, y0 + 1);
  const d = g.data;
  const ch = g.ch;
  let a = d[(y0 * g.w + x0) * ch + c];
  let b = d[(y0 * g.w + x1) * ch + c];
  let e = d[(y1 * g.w + x0) * ch + c];
  let f = d[(y1 * g.w + x1) * ch + c];
  if (decode) {
    a = decode(a);
    b = decode(b);
    e = decode(e);
    f = decode(f);
  }
  return (a * (1 - tx) + b * tx) * (1 - ty) + (e * (1 - tx) + f * tx) * ty;
}

function nearest(g: Grid<ArrayLike<number>>, lat: number, lon: number, c: number): number {
  const x = Math.floor(((((lon + 180) / 360) % 1) + 1) % 1 * g.w) % g.w;
  const y = Math.min(g.h - 1, Math.max(0, Math.floor(((90 - lat) / 180) * g.h)));
  return g.data[(y * g.w + x) * g.ch + c];
}

function pickTier(tiers: RasterTier[], maxWidth: number): RasterTier | undefined {
  const sorted = [...tiers].sort((a, b) => a.width - b.width);
  let best = sorted[0];
  for (const t of sorted) if (t.width <= maxWidth) best = t;
  return best;
}

export interface RasterLoadOptions {
  /** Largest elevation raster to hold in memory (pixels wide). */
  maxHeightWidth?: number;
  onProgress?: ProgressFn;
}

export class Rasters {
  private height: Grid<Uint16Array> | null = null;
  private conf: Grid<Uint8Array> | null = null;
  private counts: Grid<Uint8Array> | null = null;
  private readonly minM: number;
  private readonly spanM: number;
  private readonly logScale: number;
  /** Approximate size (km at the equator) of one LOLA count source pixel. */
  readonly countCellKm: number;
  /** Rasters that failed to load, for honest "unavailable" messaging. */
  readonly failed: string[] = [];

  private constructor(private readonly manifest: Manifest) {
    this.minM = manifest.heightRange.minMeters;
    this.spanM = manifest.heightRange.maxMeters - manifest.heightRange.minMeters;
    this.logScale = manifest.lolaCounts?.countsLogScale || 1;
    const ppd = manifest.lolaCounts?.sourcePixelsPerDegree || 0;
    this.countCellKm = ppd > 0 ? (Math.PI * MOON_RADIUS_KM) / 180 / ppd : NaN;
  }

  static async load(manifest: Manifest, opts: RasterLoadOptions = {}): Promise<Rasters> {
    const r = new Rasters(manifest);
    const parts = [0, 0, 0];
    const report = (i: number) => (f: number) => {
      parts[i] = f;
      opts.onProgress?.((parts[0] * 2 + parts[1] + parts[2]) / 4);
    };

    const heightTier = pickTier(manifest.height ?? [], opts.maxHeightWidth ?? 4096);
    const jobs: Promise<void>[] = [];

    jobs.push(
      (async () => {
        if (!heightTier) throw new Error('no height raster in manifest');
        await readPixels(heightTier.url, report(0), (w, h) => {
          const out = new Uint16Array(w * h);
          r.height = { w, h, ch: 1, data: out };
          // Decode the packed 16-bit value per pixel BEFORE any interpolation.
          return (px, first, count) => {
            for (let i = 0, j = 0; i < count; i++, j += 4) out[first + i] = (px[j] << 8) | px[j + 1];
          };
        });
      })().catch((e) => {
        console.warn('[rasters] elevation unavailable', e);
        r.height = null;
        r.failed.push('elevation');
        report(0)(1);
      }),
    );

    jobs.push(
      (async () => {
        if (!manifest.confidence) throw new Error('no confidence raster in manifest');
        await readPixels(manifest.confidence.url, report(1), (w, h) => {
          const out = new Uint8Array(w * h * 3);
          r.conf = { w, h, ch: 3, data: out };
          return (px, first, count) => {
            for (let i = 0, j = 0, k = first * 3; i < count; i++, j += 4, k += 3) {
              out[k] = px[j];
              out[k + 1] = px[j + 1];
              out[k + 2] = px[j + 2];
            }
          };
        });
      })().catch((e) => {
        console.warn('[rasters] data-support raster unavailable', e);
        r.conf = null;
        r.failed.push('confidence');
        report(1)(1);
      }),
    );

    jobs.push(
      (async () => {
        if (!manifest.lolaCounts) throw new Error('no LOLA count raster in manifest');
        await readPixels(manifest.lolaCounts.url, report(2), (w, h) => {
          const out = new Uint8Array(w * h);
          r.counts = { w, h, ch: 1, data: out };
          return (px, first, count) => {
            for (let i = 0, j = 0; i < count; i++, j += 4) out[first + i] = px[j];
          };
        });
      })().catch((e) => {
        console.warn('[rasters] LOLA counts unavailable', e);
        r.counts = null;
        r.failed.push('lolaCounts');
        report(2)(1);
      }),
    );

    await Promise.all(jobs);
    return r;
  }

  get hasElevation(): boolean { return !!this.height; }
  get hasConfidence(): boolean { return !!this.conf; }
  get hasCounts(): boolean { return !!this.counts; }

  /** Metres relative to the 1737.4 km sphere, or null if the raster is unavailable. */
  sampleElevation(lat: number, lon: number): number | null {
    if (!this.height) return null;
    const v16 = bilinear(this.height, lat, lon, 0);
    return this.minM + (v16 / 65535) * this.spanM;
  }

  /** Data-support scores, each 0..100. */
  sampleConfidence(lat: number, lon: number): Confidence | null {
    const g = this.conf;
    if (!g) return null;
    const k = 100 / 255;
    return {
      altimetry: bilinear(g, lat, lon, 0) * k,
      imagery: bilinear(g, lat, lon, 1) * k,
      combined: bilinear(g, lat, lon, 2) * k,
    };
  }

  private decodeCount = (v: number): number => Math.round(Math.pow(2, v / this.logScale) - 1);

  /** LOLA shots per source pixel, bilinearly interpolated on decoded counts. */
  sampleShotCount(lat: number, lon: number): number | null {
    if (!this.counts) return null;
    return bilinear(this.counts, lat, lon, 0, this.decodeCount);
  }

  /** LOLA shots recorded in the exact raster cell containing the point (no interpolation). */
  shotCountAt(lat: number, lon: number): number | null {
    if (!this.counts) return null;
    return this.decodeCount(nearest(this.counts, lat, lon, 0));
  }
}
