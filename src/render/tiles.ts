import * as THREE from 'three';
import type { QualityTier, ViewState } from '../types';

/**
 * Streamed close-up imagery: NASA Moon Trek "LRO WAC Mosaic Global 303ppd v02" WMTS layer.
 *
 * Tile matrix set `default028mm` (from WMTSCapabilities.xml): equirectangular, top-left corner at
 * (lon -180, lat +90), 256 px tiles, level z has 2^(z+1) columns x 2^z rows (2x1 root), z = 0..8.
 * Row 0 is the northernmost row, column 0 starts at lon -180. Level 8 is ~83 m/px at the equator.
 */
export const TILE_MAX_LEVEL = 8;
export const TILE_SIZE = 256;
const DIRECT_BASE = 'https://trek.nasa.gov/tiles/Moon/EQ/LRO_WAC_Mosaic_Global_303ppd_v02/1.0.0/default/default028mm';
const PROXY_BASE = '/tiles';

const D2R = Math.PI / 180;
const FADE_MS = 280;

type TileState = 'queued' | 'loading' | 'ready' | 'failed';

interface Tile {
  key: string;
  z: number;
  row: number;
  col: number;
  state: TileState;
  texture: THREE.Texture | null;
  wantedFrame: number;
  usedFrame: number;
  readyAt: number;
  retryAt: number;
  priority: number;
  abort: AbortController | null;
}

export interface TileView {
  camPos: THREE.Vector3;
  /** Distance of the camera from the Moon centre (radii). */
  dist: number;
  frustum: THREE.Frustum;
  /** Focal length in device pixels (viewport height / (2 tan(fov/2))). */
  focalPx: number;
  /** Width in pixels of the base colour texture currently on the globe. */
  baseWidth: number;
}

export interface TileHost {
  createMesh(): THREE.Mesh<THREE.BufferGeometry, THREE.ShaderMaterial>;
  renderer: THREE.WebGLRenderer;
  invalidate(): void;
}

const _c = new THREE.Vector3();
const _sphere = new THREE.Sphere();

function fetchWithTimeout(url: string, signal: AbortSignal, ms: number): Promise<Response> {
  const ac = new AbortController();
  const onAbort = (): void => ac.abort();
  signal.addEventListener('abort', onAbort, { once: true });
  const timer = setTimeout(() => ac.abort(), ms);
  return fetch(url, { signal: ac.signal, mode: 'cors', credentials: 'omit' }).finally(() => {
    clearTimeout(timer);
    signal.removeEventListener('abort', onAbort);
  });
}

async function fetchImageBlob(url: string, signal: AbortSignal): Promise<Blob> {
  const res = await fetchWithTimeout(url, signal, 15000);
  const type = res.headers.get('content-type') || '';
  if (!res.ok || !type.startsWith('image/')) throw new Error(`tile HTTP ${res.status}`);
  return res.blob();
}

export class TileManager {
  status: ViewState['tiles'] = 'off';

  private readonly host: TileHost;
  private readonly group: THREE.Group;
  private readonly tiles = new Map<string, Tile>();
  private readonly meshes: THREE.Mesh<THREE.BufferGeometry, THREE.ShaderMaterial>[] = [];
  private readonly maxLevel: number;
  private readonly maxLeaves: number;
  private readonly cacheSize: number;
  private readonly concurrency: number;
  private readonly anisotropy: number;
  private frame = 0;
  private loading = 0;
  private disposed = false;

  /** 'unknown' until the first request tells us whether the same-origin proxy exists. */
  private proxy: 'unknown' | 'probing' | 'ok' | 'dead' = 'unknown';
  private proxyFails = 0;
  private directFails = 0;
  private unavailableUntil = 0;
  private everLoaded = false;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(host: TileHost, group: THREE.Group, quality: QualityTier, maxAnisotropy: number) {
    this.host = host;
    this.group = group;
    // 'low' stops one level short of the mosaic's native resolution and keeps far fewer tiles.
    this.maxLevel = quality === 'low' ? 7 : TILE_MAX_LEVEL;
    this.maxLeaves = quality === 'low' ? 28 : quality === 'medium' ? 64 : 120;
    this.cacheSize = quality === 'low' ? 56 : quality === 'medium' ? 140 : 280;
    this.concurrency = quality === 'low' ? 4 : 6;
    this.anisotropy = Math.min(maxAnisotropy, quality === 'low' ? 2 : 4);
  }

  dispose(): void {
    this.disposed = true;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.clear();
    for (const m of this.meshes) {
      this.group.remove(m);
      m.material.dispose();
    }
    this.meshes.length = 0;
  }

  /** Drop every tile (used after a WebGL context loss). */
  clear(): void {
    for (const t of this.tiles.values()) {
      t.abort?.abort();
      t.texture?.dispose();
    }
    this.tiles.clear();
    this.loading = 0;
    for (const m of this.meshes) m.visible = false;
  }

  /** Lowest tile level that carries more detail than a base texture of the given width. */
  private static minLevelFor(baseWidth: number): number {
    // level z spans 256 * 2^(z+1) px over 360 deg
    return Math.max(0, Math.ceil(Math.log2(baseWidth / (TILE_SIZE * 2)) + 0.999));
  }

  update(view: TileView, now: number): void {
    if (this.disposed) return;
    this.frame++;
    const minLevel = TileManager.minLevelFor(view.baseWidth);
    const leaves: Tile[] = [];
    let threshold = 1.2;
    for (let attempt = 0; attempt < 6; attempt++) {
      leaves.length = 0;
      const ok = this.select(view, 0, 0, 0, threshold, minLevel, leaves) && this.select(view, 0, 0, 1, threshold, minLevel, leaves);
      if (ok) break;
      threshold *= 1.6;
    }

    if (leaves.length === 0) {
      this.cancelUnwanted();
      for (const m of this.meshes) m.visible = false;
      this.setStatus('off');
      return;
    }

    const blocked = now < this.unavailableUntil;
    let pending = 0;
    const draw = new Map<string, Tile>();
    for (const t of leaves) {
      t.wantedFrame = this.frame;
      if (t.state === 'ready') {
        draw.set(t.key, t);
        if (now - t.readyAt >= FADE_MS) continue;
      } else {
        if (t.state === 'failed' && now >= t.retryAt && !blocked) t.state = 'queued';
        if (t.state !== 'failed') pending++;
      }
      // not (fully) there yet: show the nearest loaded ancestor underneath
      let z = t.z;
      let row = t.row;
      let col = t.col;
      while (z > minLevel) {
        z--;
        row >>= 1;
        col >>= 1;
        const a = this.tiles.get(`${z}/${row}/${col}`);
        if (a && a.state === 'ready') {
          draw.set(a.key, a);
          break;
        }
      }
    }

    this.cancelUnwanted();
    if (!blocked) this.pump(leaves);

    // draw list, coarse to fine so finer tiles cover their ancestors
    const list = [...draw.values()].sort((a, b) => a.z - b.z);
    let fading = false;
    for (let i = 0; i < list.length; i++) {
      const t = list[i];
      t.usedFrame = this.frame;
      let mesh = this.meshes[i];
      if (!mesh) {
        mesh = this.host.createMesh();
        mesh.frustumCulled = false;
        this.meshes.push(mesh);
        this.group.add(mesh);
      }
      const u = mesh.material.uniforms;
      const nCols = 2 ** (t.z + 1);
      const nRows = 2 ** t.z;
      (u.uRect.value as THREE.Vector4).set(t.col / nCols, 1 - (t.row + 1) / nRows, (t.col + 1) / nCols, 1 - t.row / nRows);
      u.uTile.value = t.texture;
      const a = Math.min(1, (now - t.readyAt) / FADE_MS);
      if (a < 1) fading = true;
      u.uTileAlpha.value = a * a * (3 - 2 * a);
      mesh.renderOrder = 10 + t.z;
      mesh.visible = true;
    }
    for (let i = list.length; i < this.meshes.length; i++) this.meshes[i].visible = false;
    if (fading) this.host.invalidate();

    this.evict();
    if (blocked && !this.everLoaded) this.setStatus('unavailable');
    else if (blocked) this.setStatus(pending > 0 ? 'unavailable' : 'active');
    else this.setStatus(pending > 0 ? 'loading' : 'active');
  }

  private setStatus(s: ViewState['tiles']): void {
    this.status = s;
  }

  /**
   * Quadtree descent. Returns false when the leaf budget is exceeded (the caller retries with a
   * coarser threshold).
   */
  private select(view: TileView, z: number, row: number, col: number, threshold: number, minLevel: number, out: Tile[]): boolean {
    const size = 180 / 2 ** z; // tile span in degrees (lat and lon)
    const lon0 = -180 + col * size;
    const lat1 = 90 - row * size;
    const latC = (lat1 - size / 2) * D2R;
    const lonC = (lon0 + size / 2) * D2R;
    _c.set(Math.cos(latC) * Math.sin(lonC), Math.sin(latC), Math.cos(latC) * Math.cos(lonC));
    // angular radius of the tile's bounding cap: furthest corner from the centre direction
    const half = (size / 2) * D2R;
    const latFar = Math.abs(latC) - half; // corner row nearest the equator is the widest
    const cosCorner =
      Math.sin(latC) * Math.sin(Math.sign(latC || 1) * latFar) + Math.cos(latC) * Math.cos(latFar) * Math.cos(half);
    const rho = Math.max(half, Math.acos(Math.max(-1, Math.min(1, cosCorner))));

    const d = view.dist;
    const cosG = Math.max(-1, Math.min(1, _c.dot(view.camPos) / d));
    const gammaC = Math.acos(cosG);
    const horizon = Math.acos(1 / d);
    if (gammaC - rho > horizon + 0.01) return true; // entirely beyond the limb
    _sphere.center.copy(_c);
    _sphere.radius = 2 * Math.sin(Math.min(rho, Math.PI / 2) / 2) + 0.012;
    if (!view.frustum.intersectsSphere(_sphere)) return true;

    // on-screen size of one tile texel at the point of the tile nearest to the sub-camera point
    const gamma = Math.max(0, gammaC - rho);
    const cg = Math.cos(gamma);
    const D = Math.sqrt(d * d + 1 - 2 * d * cg);
    const cosEmis = Math.max(0, (d * cg - 1) / D);
    const texel = (size / TILE_SIZE) * D2R;
    const latNear = Math.max(0, Math.abs(latC) - half);
    if (latNear > 88 * D2R) return true; // the shader hands the polar caps back to the base map
    const polar = Math.sqrt(Math.min(1, Math.cos(latNear) / 0.5)); // equirect tiles get very thin near the poles
    const px = ((texel * view.focalPx) / D) * Math.sqrt(Math.max(cosEmis, 0.2)) * polar;

    if (z < this.maxLevel && (px > threshold || z < minLevel)) {
      // below minLevel only descend if the finest useful level would actually be wanted
      if (z < minLevel && px / 2 ** (minLevel - 1 - z) <= threshold) return true;
      const r = row * 2;
      const c = col * 2;
      return (
        this.select(view, z + 1, r, c, threshold, minLevel, out) &&
        this.select(view, z + 1, r, c + 1, threshold, minLevel, out) &&
        this.select(view, z + 1, r + 1, c, threshold, minLevel, out) &&
        this.select(view, z + 1, r + 1, c + 1, threshold, minLevel, out)
      );
    }
    if (z < minLevel || (z === minLevel && px * 2 <= threshold)) return true; // base texture is enough here
    if (out.length >= this.maxLeaves) return false;
    const key = `${z}/${row}/${col}`;
    let t = this.tiles.get(key);
    if (!t) {
      t = { key, z, row, col, state: 'queued', texture: null, wantedFrame: 0, usedFrame: 0, readyAt: 0, retryAt: 0, priority: 0, abort: null };
      this.tiles.set(key, t);
    }
    t.priority = gammaC + z * 1e-3;
    out.push(t);
    return true;
  }

  private cancelUnwanted(): void {
    for (const t of this.tiles.values()) {
      if (t.wantedFrame === this.frame) continue;
      if (t.state === 'loading') {
        t.abort?.abort();
        t.abort = null;
        this.loading--;
        this.tiles.delete(t.key);
      } else if (t.state === 'queued' || t.state === 'failed') {
        this.tiles.delete(t.key);
      }
    }
  }

  private pump(leaves: Tile[]): void {
    if (this.loading >= this.concurrency) return;
    const queued = leaves.filter((t) => t.state === 'queued').sort((a, b) => a.priority - b.priority);
    for (const t of queued) {
      // while we do not know whether the proxy exists, send a single probe request
      const limit = this.proxy === 'unknown' || this.proxy === 'probing' ? 1 : this.concurrency;
      if (this.loading >= limit) break;
      void this.load(t);
    }
  }

  private async load(t: Tile): Promise<void> {
    t.state = 'loading';
    this.loading++;
    const ac = new AbortController();
    t.abort = ac;
    const path = `${t.z}/${t.row}/${t.col}.jpg`;
    try {
      let blob: Blob | null = null;
      if (this.proxy !== 'dead') {
        if (this.proxy === 'unknown') this.proxy = 'probing';
        try {
          blob = await fetchImageBlob(`${PROXY_BASE}/${path}`, ac.signal);
          this.proxy = 'ok';
          this.proxyFails = 0;
        } catch (err) {
          if (ac.signal.aborted) throw err;
          this.proxyFails++;
          if (this.proxy === 'probing' || this.proxyFails >= 3) this.proxy = 'dead';
        }
      }
      if (!blob) blob = await fetchImageBlob(`${DIRECT_BASE}/${path}`, ac.signal);
      const bmp = await createImageBitmap(blob, { imageOrientation: 'flipY', premultiplyAlpha: 'none', colorSpaceConversion: 'none' });
      if (ac.signal.aborted || this.disposed || this.tiles.get(t.key) !== t) {
        bmp.close();
        return;
      }
      const tex = new THREE.Texture(bmp as unknown as HTMLImageElement);
      tex.flipY = false;
      tex.format = THREE.RedFormat;
      tex.colorSpace = THREE.NoColorSpace;
      tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
      tex.minFilter = THREE.LinearMipmapLinearFilter;
      tex.magFilter = THREE.LinearFilter;
      tex.generateMipmaps = true;
      tex.anisotropy = this.anisotropy;
      tex.unpackAlignment = 1;
      tex.needsUpdate = true;
      this.host.renderer.initTexture(tex);
      bmp.close();
      t.texture = tex;
      t.state = 'ready';
      t.readyAt = performance.now();
      t.abort = null;
      this.loading--;
      this.directFails = 0;
      this.everLoaded = true;
      this.unavailableUntil = 0;
      this.host.invalidate();
    } catch {
      if (this.tiles.get(t.key) !== t || t.state !== 'loading') {
        if (this.proxy === 'probing') this.proxy = 'unknown';
        return; // cancelled; bookkeeping already done by cancelUnwanted()
      }
      if (this.proxy === 'probing') this.proxy = 'unknown';
      t.abort = null;
      this.loading--;
      t.state = 'failed';
      t.retryAt = performance.now() + 8000;
      this.directFails++;
      if (this.directFails >= 3) {
        // The tile service is unreachable: stop asking for a while and keep the base texture.
        this.unavailableUntil = performance.now() + 20000;
        this.directFails = 0;
        if (this.retryTimer) clearTimeout(this.retryTimer);
        this.retryTimer = setTimeout(() => this.host.invalidate(), 20500);
      }
      this.host.invalidate();
    }
  }

  private evict(): void {
    let ready = 0;
    for (const t of this.tiles.values()) if (t.state === 'ready') ready++;
    if (ready <= this.cacheSize) return;
    const idle = [...this.tiles.values()]
      .filter((t) => t.state === 'ready' && t.usedFrame !== this.frame && t.wantedFrame !== this.frame)
      .sort((a, b) => a.usedFrame - b.usedFrame);
    for (const t of idle) {
      if (ready <= this.cacheSize) break;
      t.texture?.dispose();
      this.tiles.delete(t.key);
      ready--;
    }
  }
}

