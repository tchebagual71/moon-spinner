import * as THREE from 'three';
import type { QualityTier, RasterTier } from '../types';

export interface DeviceCaps {
  maxTextureSize: number;
  maxAnisotropy: number;
  mobile: boolean;
  /** navigator.deviceMemory in GB (8 when the browser does not report it). */
  memoryGB: number;
}

export function detectCaps(renderer: THREE.WebGLRenderer): DeviceCaps {
  const nav = navigator as Navigator & { deviceMemory?: number };
  const ua = nav.userAgent || '';
  const mobile = /Android|iPhone|iPad|iPod|Mobile/i.test(ua) || (nav.maxTouchPoints > 1 && /Macintosh/.test(ua));
  return {
    maxTextureSize: renderer.capabilities.maxTextureSize,
    maxAnisotropy: renderer.capabilities.getMaxAnisotropy(),
    mobile,
    memoryGB: nav.deviceMemory ?? (mobile ? 4 : 8),
  };
}

/** Largest texture width allowed for the colour / normal maps on this device at this quality. */
export function maxBaseWidth(quality: QualityTier, caps: DeviceCaps): number {
  let w = quality === 'high' ? 8192 : quality === 'medium' ? 4096 : 2048;
  if (caps.mobile || caps.memoryGB <= 4) w = Math.min(w, 4096);
  if (caps.memoryGB <= 2) w = Math.min(w, 2048);
  return Math.min(w, caps.maxTextureSize);
}

/** Index of the best tier not wider than maxWidth (tiers are ascending); 0 if none fits. */
export function pickTier(tiers: RasterTier[], maxWidth: number): number {
  let best = 0;
  for (let i = 0; i < tiers.length; i++) if (tiers[i].width <= maxWidth) best = i;
  return best;
}

async function fetchBlob(url: string, signal?: AbortSignal): Promise<Blob> {
  const res = await fetch(url, { signal });
  if (!res.ok) throw new Error(`Failed to load ${url} (HTTP ${res.status})`);
  return res.blob();
}

interface Decoded {
  source: ImageBitmap | HTMLImageElement;
  /** True when the pixel rows are already bottom-up (v = 0 at the south edge). */
  flipped: boolean;
  width: number;
  height: number;
}

async function decode(blob: Blob, flipY: boolean, maxWidth?: number): Promise<Decoded> {
  if (typeof createImageBitmap === 'function') {
    try {
      const opts: ImageBitmapOptions = {
        premultiplyAlpha: 'none',
        colorSpaceConversion: 'none',
        imageOrientation: flipY ? 'flipY' : 'from-image',
      };
      let bmp = await createImageBitmap(blob, opts);
      if (maxWidth && bmp.width > maxWidth) {
        const h = Math.max(1, Math.round((bmp.height * maxWidth) / bmp.width));
        bmp.close();
        bmp = await createImageBitmap(blob, { ...opts, resizeWidth: maxWidth, resizeHeight: h, resizeQuality: 'high' });
      }
      return { source: bmp, flipped: flipY, width: bmp.width, height: bmp.height };
    } catch {
      /* fall through to <img> decoding (old Safari without createImageBitmap options) */
    }
  }
  const url = URL.createObjectURL(blob);
  try {
    const img = new Image();
    img.decoding = 'async';
    img.src = url;
    await img.decode();
    return { source: img, flipped: false, width: img.naturalWidth, height: img.naturalHeight };
  } finally {
    URL.revokeObjectURL(url);
  }
}

export interface ImageTextureOptions {
  srgb: boolean;
  anisotropy: number;
  maxWidth: number;
  signal?: AbortSignal;
}

/**
 * Load an equirectangular raster as a mip-mapped texture: wraps in longitude, clamps in latitude,
 * v = 0 at the south edge. The decoded bitmap is released once it is on the GPU.
 */
export async function loadEquirectTexture(
  renderer: THREE.WebGLRenderer,
  url: string,
  o: ImageTextureOptions,
): Promise<THREE.Texture> {
  const blob = await fetchBlob(url, o.signal);
  const d = await decode(blob, true, o.maxWidth);
  const tex = new THREE.Texture(d.source as unknown as HTMLImageElement);
  tex.flipY = !d.flipped;
  tex.premultiplyAlpha = false;
  tex.colorSpace = o.srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.generateMipmaps = true;
  tex.anisotropy = o.anisotropy;
  tex.needsUpdate = true;
  renderer.initTexture(tex);
  if ('close' in d.source) d.source.close();
  tex.userData.width = d.width;
  tex.userData.height = d.height;
  return tex;
}

export interface HeightField {
  texture: THREE.DataTexture;
  /** Elevation in km, row 0 = south, kept on the CPU for picking / marker placement. */
  km: Float32Array;
  width: number;
  height: number;
}

/**
 * Decode the packed 16-bit height PNG (value16 = R*256 + G) on the CPU and upload it as a
 * half-float texture in km with a CPU-built mip chain. Decoding on the CPU avoids every
 * filtering / colour-space artefact that sampling the packed bytes on the GPU would cause.
 */
export async function loadHeightField(
  url: string,
  range: { minMeters: number; maxMeters: number },
  signal?: AbortSignal,
): Promise<HeightField> {
  const blob = await fetchBlob(url, signal);
  const d = await decode(blob, false);
  const w = d.width;
  const h = d.height;
  const km = new Float32Array(w * h);
  const scale = (range.maxMeters - range.minMeters) / 65535 / 1000;
  const offset = range.minMeters / 1000;
  const strip = Math.min(h, 256);
  const canvas: HTMLCanvasElement | OffscreenCanvas =
    typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(w, strip) : Object.assign(document.createElement('canvas'), { width: w, height: strip });
  const ctx = canvas.getContext('2d', { willReadFrequently: true }) as CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null;
  if (!ctx) throw new Error('2D canvas unavailable for height decoding');
  for (let y0 = 0; y0 < h; y0 += strip) {
    const rows = Math.min(strip, h - y0);
    ctx.clearRect(0, 0, w, strip);
    ctx.drawImage(d.source, 0, y0, w, rows, 0, 0, w, rows);
    const px = ctx.getImageData(0, 0, w, rows).data;
    for (let r = 0; r < rows; r++) {
      // image row (y0 + r) counts from the north; store bottom-up
      let o = (h - 1 - (y0 + r)) * w;
      let i = r * w * 4;
      for (let x = 0; x < w; x++, i += 4) km[o++] = offset + (px[i] * 256 + px[i + 1]) * scale;
    }
  }
  if ('close' in d.source) d.source.close();

  // mip chain (box filter) in float, stored as half floats
  const mipmaps: { data: Uint16Array<ArrayBuffer>; width: number; height: number }[] = [];
  let cur = km;
  let cw = w;
  let ch = h;
  for (;;) {
    const half = new Uint16Array(cw * ch);
    for (let i = 0; i < half.length; i++) half[i] = THREE.DataUtils.toHalfFloat(cur[i]);
    mipmaps.push({ data: half, width: cw, height: ch });
    if (cw === 1 && ch === 1) break;
    const nw = Math.max(1, cw >> 1);
    const nh = Math.max(1, ch >> 1);
    const next = new Float32Array(nw * nh);
    for (let y = 0; y < nh; y++) {
      const ya = Math.min(ch - 1, y * 2) * cw;
      const yb = Math.min(ch - 1, y * 2 + 1) * cw;
      for (let x = 0; x < nw; x++) {
        const xa = Math.min(cw - 1, x * 2);
        const xb = Math.min(cw - 1, x * 2 + 1);
        next[y * nw + x] = 0.25 * (cur[ya + xa] + cur[ya + xb] + cur[yb + xa] + cur[yb + xb]);
      }
    }
    cur = next;
    cw = nw;
    ch = nh;
  }
  const tex = new THREE.DataTexture(mipmaps[0].data, w, h, THREE.RedFormat, THREE.HalfFloatType);
  tex.mipmaps = mipmaps as unknown as THREE.DataTexture['mipmaps'];
  tex.generateMipmaps = false;
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.colorSpace = THREE.NoColorSpace;
  tex.flipY = false;
  tex.unpackAlignment = 1;
  tex.needsUpdate = true;
  return { texture: tex, km, width: w, height: h };
}

/** Bilinear elevation lookup (km) at a selenographic position in degrees. */
export function sampleHeightKm(hf: HeightField | null, lat: number, lon: number): number {
  if (!hf) return 0;
  const { km, width: w, height: h } = hf;
  const fx = ((lon + 180) / 360) * w - 0.5;
  const fy = Math.min(h - 1, Math.max(0, ((lat + 90) / 180) * h - 0.5));
  const x0 = Math.floor(fx);
  const y0 = Math.floor(fy);
  const tx = fx - x0;
  const ty = fy - y0;
  const xa = ((x0 % w) + w) % w;
  const xb = (xa + 1) % w;
  const yb = Math.min(h - 1, y0 + 1);
  const a = km[y0 * w + xa] * (1 - tx) + km[y0 * w + xb] * tx;
  const b = km[yb * w + xa] * (1 - tx) + km[yb * w + xb] * tx;
  return a * (1 - ty) + b * ty;
}

/** 1x1 placeholder so samplers are never unbound. */
export function solidTexture(r: number, g: number, b: number): THREE.DataTexture {
  const t = new THREE.DataTexture(new Uint8Array([r, g, b, 255]), 1, 1, THREE.RGBAFormat, THREE.UnsignedByteType);
  t.needsUpdate = true;
  return t;
}
