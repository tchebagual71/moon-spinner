import * as THREE from 'three';
import { MOON_RADIUS_KM } from '../types';
import type { IMoonView, LatLon, LightingMode, Manifest, Marker, QualityTier, ViewState } from '../types';
import { CONFIDENCE_HATCH_BELOW, confidenceRampRgb } from './confidenceRamp';
import { GlobeControls, vecToLatLon } from './controls';
import { MarkerLayer } from './markers';
import { FRAGMENT, RAMP_SIZE, STAR_FRAGMENT, STAR_VERTEX, VERTEX, phaseFunction } from './shaders';
import { latLonToVec, subSolarPoint } from './sun';
import { detectCaps, loadEquirectTexture, loadHeightField, maxBaseWidth, pickTier, sampleHeightKm, solidTexture } from './textures';
import type { DeviceCaps, HeightField } from './textures';
import { TileManager } from './tiles';

export { CONFIDENCE_RAMP, CONFIDENCE_HATCH_BELOW, confidenceGradientCss } from './confidenceRamp';
export { subSolarPoint, subEarthPoint } from './sun';

interface QualityProfile {
  pixelRatio: number;
  /** Upper bound on drawing-buffer pixels. */
  pixelBudget: number;
  gridW: number;
  gridH: number;
  tileGrid: number;
  shadowSteps: number;
  heightWidth: number;
  anisotropy: number;
  stars: number;
  markers: number;
}

const PROFILES: Record<QualityTier, QualityProfile> = {
  low: { pixelRatio: 1.5, pixelBudget: 2.2e6, gridW: 256, gridH: 128, tileGrid: 16, shadowSteps: 0, heightWidth: 1024, anisotropy: 4, stars: 1400, markers: 36 },
  medium: { pixelRatio: 2, pixelBudget: 5.5e6, gridW: 384, gridH: 192, tileGrid: 32, shadowSteps: 12, heightWidth: 2048, anisotropy: 8, stars: 2600, markers: 60 },
  high: { pixelRatio: 2.5, pixelBudget: 9.5e6, gridW: 512, gridH: 256, tileGrid: 32, shadowSteps: 20, heightWidth: 4096, anisotropy: 16, stars: 3600, markers: 90 },
};

/**
 * Grey-level mapping from the WAC mosaic to the base map's linear luminance, (gain, gamma):
 * baseLum ~= gain * tile^gamma, least-squares fit over twelve level-3 tiles against color_2k.
 */
const TILE_TONE = new THREE.Vector2(2.28, 1.835);

function makeGrid(nx: number, ny: number): THREE.BufferGeometry {
  const pos = new Float32Array((nx + 1) * (ny + 1) * 3);
  let p = 0;
  for (let j = 0; j <= ny; j++) {
    for (let i = 0; i <= nx; i++) {
      pos[p++] = i / nx;
      pos[p++] = j / ny;
      pos[p++] = 0;
    }
  }
  const count = (nx + 1) * (ny + 1);
  const idx = count > 65535 ? new Uint32Array(nx * ny * 6) : new Uint16Array(nx * ny * 6);
  let k = 0;
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      const a = j * (nx + 1) + i;
      const b = a + 1;
      const c = a + nx + 1;
      const d = c + 1;
      // u = east, v = north: counter-clockwise when seen from outside the sphere
      idx[k++] = a;
      idx[k++] = b;
      idx[k++] = c;
      idx[k++] = b;
      idx[k++] = d;
      idx[k++] = c;
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setIndex(new THREE.BufferAttribute(idx, 1));
  g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1.1);
  return g;
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const _v = new THREE.Vector3();
const _w = new THREE.Vector3();
const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();

export default class MoonView implements IMoonView {
  readonly ready: Promise<void>;

  private readonly canvas: HTMLCanvasElement;
  private readonly manifest: Manifest;
  private readonly quality: QualityTier;
  private readonly profile: QualityProfile;
  private readonly renderer: THREE.WebGLRenderer;
  private readonly caps: DeviceCaps;
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.PerspectiveCamera(24, 1, 0.1, 10);
  private readonly controls: GlobeControls;
  private readonly markers: MarkerLayer;
  private readonly tiles: TileManager;
  private readonly tileGroup = new THREE.Group();
  private readonly frustum = new THREE.Frustum();
  private readonly uniforms: Record<string, THREE.IUniform>;
  private readonly globeMaterial: THREE.ShaderMaterial;
  private readonly tileGeometry: THREE.BufferGeometry;
  private readonly globeGeometry: THREE.BufferGeometry;
  private readonly stars: THREE.Points<THREE.BufferGeometry, THREE.ShaderMaterial>;
  private readonly placeholders: THREE.Texture[] = [];

  private colorTex: THREE.Texture | null = null;
  private normalTex: THREE.Texture | null = null;
  private confTex: THREE.Texture | null = null;
  private confLoading = false;
  private heightField: HeightField | null = null;
  private cpuHeights: HeightField | null = null;
  private baseWidth = 2048;
  private loadGeneration = 0;
  private loadAbort: AbortController | null = null;

  private mode: LightingMode = 'realtime';
  private realtimeDate: Date | null = null;
  private readonly sunTarget = new THREE.Vector3(0, 0, 1);
  private readonly sunDir = new THREE.Vector3(0, 0, 1);
  private sunInitialised = false;
  private fullMix = 0;
  private relief = 1;
  private confOpacity = 0;
  private confTarget = 0;
  private selection: LatLon | null = null;

  private raf = 0;
  private lastTime = 0;
  private wasAnimating = false;
  private needsRender = true;
  private baseReady = false;
  private firstFrameDone = false;
  private resolveReady!: () => void;
  private rejectReady!: (e: unknown) => void;
  private contextLost = false;
  private disposed = false;
  private pixelRatio = 1;
  private width = 0;
  private height = 0;

  private pickCb: ((p: LatLon) => void) | null = null;
  private markerCb: ((id: string) => void) | null = null;
  private viewCb: ((v: ViewState) => void) | null = null;
  private lastEmit = 0;
  private emitTimer: ReturnType<typeof setTimeout> | null = null;
  private lastState = '';
  private sunTimer: ReturnType<typeof setInterval> | null = null;
  private resizeObserver: ResizeObserver | null = null;

  constructor(canvas: HTMLCanvasElement, manifest: Manifest, quality: QualityTier) {
    this.canvas = canvas;
    this.manifest = manifest;
    this.quality = quality;
    this.profile = PROFILES[quality] ?? PROFILES.medium;

    const attrs: WebGLContextAttributes = {
      alpha: false,
      antialias: true,
      depth: true,
      stencil: false,
      powerPreference: 'high-performance',
      premultipliedAlpha: true,
      preserveDrawingBuffer: false,
    };
    let gl: WebGL2RenderingContext | null = null;
    try {
      gl = canvas.getContext('webgl2', attrs) as WebGL2RenderingContext | null;
    } catch {
      gl = null;
    }
    if (!gl) {
      throw new Error(
        'WebGL 2 is not available in this browser or is disabled, so the 3D Moon cannot be drawn. ' +
          'Try enabling hardware acceleration or use a recent version of Chrome, Firefox, Safari or Edge.',
      );
    }
    try {
      this.renderer = new THREE.WebGLRenderer({ canvas, context: gl, ...attrs });
    } catch (err) {
      throw new Error(`WebGL 2 could not be initialised: ${err instanceof Error ? err.message : String(err)}`);
    }
    this.renderer.setClearColor(0x000000, 1);
    this.renderer.toneMapping = THREE.NoToneMapping;
    this.renderer.sortObjects = true;
    this.caps = detectCaps(this.renderer);

    // ---- uniforms shared by the globe and every tile patch
    const grey = solidTexture(0, 0, 0);
    const flatNormal = solidTexture(128, 128, 255);
    const zero = solidTexture(0, 0, 0);
    this.placeholders.push(grey, flatNormal, zero);
    const ramp = confidenceRampRgb();
    while (ramp.length < RAMP_SIZE) ramp.push([...ramp[ramp.length - 1]] as [number, number, number, number]);
    const gain = (manifest as Manifest & { normalGain?: number }).normalGain;
    this.normalGain = typeof gain === 'number' && gain > 0 ? gain : 1;
    this.uniforms = {
      uColor: { value: grey },
      uNormal: { value: flatNormal },
      uHeight: { value: zero },
      uConf: { value: zero },
      uColorSize: { value: new THREE.Vector2(2048, 1024) },
      uNormalScale: { value: 1 / this.normalGain },
      uHScale: { value: 1 / MOON_RADIUS_KM },
      uHMax: { value: manifest.heightRange.maxMeters / 1000 / MOON_RADIUS_KM },
      uSunDir: { value: this.sunDir },
      uViewDir: { value: new THREE.Vector3(0, 0, 1) },
      uFullMix: { value: 0 },
      uExposure: { value: 1 },
      uEarthshine: { value: 0 },
      uConfOpacity: { value: 0 },
      uHatchPx: { value: 9 },
      uHatchBelow: { value: CONFIDENCE_HATCH_BELOW },
      uRamp: { value: ramp.slice(0, RAMP_SIZE).map((s) => new THREE.Vector3(s[1], s[2], s[3])) },
      uRampStops: { value: ramp.slice(0, RAMP_SIZE).map((s) => s[0]) },
      uSelDir: { value: new THREE.Vector3(0, 0, 1) },
      uSel: { value: new THREE.Vector3(0.05, 0.005, 0) },
      uTileTone: { value: TILE_TONE },
    };

    const defines = { SHADOW_STEPS: this.profile.shadowSteps };
    this.globeGeometry = makeGrid(this.profile.gridW, this.profile.gridH);
    this.globeMaterial = new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3,
      vertexShader: VERTEX,
      fragmentShader: FRAGMENT,
      defines,
      uniforms: {
        ...this.uniforms,
        uRect: { value: new THREE.Vector4(0, 0, 1, 1) },
        uGridN: { value: this.profile.gridW },
      },
    });
    const globe = new THREE.Mesh(this.globeGeometry, this.globeMaterial);
    globe.frustumCulled = false;
    globe.renderOrder = 1;
    this.scene.add(globe);
    this.tileGroup.renderOrder = 2;
    this.scene.add(this.tileGroup);
    this.tileGeometry = makeGrid(this.profile.tileGrid, this.profile.tileGrid);

    this.stars = this.makeStars();
    this.scene.add(this.stars);

    this.controls = new GlobeControls(canvas, {
      invalidate: () => this.invalidate(),
      onTap: (x, y) => this.handleTap(x, y),
      onDoubleTap: (x, y) => this.handleDoubleTap(x, y),
      onHover: (x, y) => (this.markers.hitTest(x, y) ? 'pointer' : null),
      minAltitudeFloor: () => (this.uniforms.uHMax.value as number) * 1.4 + 0.004,
    });
    this.markers = new MarkerLayer(canvas, this.profile.markers, (lat, lon) => sampleHeightKm(this.cpuHeights, lat, lon) / MOON_RADIUS_KM);
    this.tiles = new TileManager(
      {
        renderer: this.renderer,
        invalidate: () => this.invalidate(),
        createMesh: () => this.createTileMesh(defines),
      },
      this.tileGroup,
      quality,
      this.caps.maxAnisotropy,
    );

    canvas.addEventListener('webglcontextlost', this.onContextLost);
    canvas.addEventListener('webglcontextrestored', this.onContextRestored);
    window.addEventListener('resize', this.onWindowResize);
    window.addEventListener('orientationchange', this.onWindowResize);
    document.addEventListener('visibilitychange', this.onVisibility);
    if (typeof ResizeObserver !== 'undefined') {
      this.resizeObserver = new ResizeObserver(() => this.resize());
      this.resizeObserver.observe(canvas);
    }
    this.resize();

    this.ready = new Promise<void>((resolve, reject) => {
      this.resolveReady = resolve;
      this.rejectReady = reject;
    });
    this.ready.catch(() => undefined);

    this.setLighting('realtime');
    void this.loadBase();
    this.invalidate();
  }

  private readonly normalGain: number;

  // ====================================================================== IMoonView

  setLighting(mode: LightingMode, opts?: { date?: Date; sunLon?: number; sunLat?: number }): void {
    this.mode = mode;
    if (this.sunTimer) {
      clearInterval(this.sunTimer);
      this.sunTimer = null;
    }
    if (mode === 'realtime') {
      this.realtimeDate = opts?.date ?? null;
      this.updateRealtimeSun();
      // follow the real Sun (it moves ~0.5 deg per hour over the surface)
      if (!this.realtimeDate) this.sunTimer = setInterval(() => this.updateRealtimeSun(), 30000);
    } else if (mode === 'manual') {
      const [x, y, z] = latLonToVec(opts?.sunLat ?? 0, opts?.sunLon ?? 0);
      this.sunTarget.set(x, y, z);
    }
    if (!this.sunInitialised) {
      this.sunInitialised = true;
      this.sunDir.copy(this.sunTarget);
      this.fullMix = mode === 'full' ? 1 : 0;
    }
    this.invalidate();
  }

  setConfidenceOverlay(opacity: number): void {
    this.confTarget = Math.min(1, Math.max(0, Number.isFinite(opacity) ? opacity : 0));
    if (this.confTarget > 0 && !this.confTex && !this.confLoading) void this.loadConfidence();
    this.invalidate();
  }

  setReliefScale(scale: number): void {
    this.relief = Math.min(30, Math.max(0, Number.isFinite(scale) ? scale : 1));
    this.uniforms.uHScale.value = this.relief / MOON_RADIUS_KM;
    this.uniforms.uNormalScale.value = this.relief / this.normalGain;
    this.uniforms.uHMax.value = (this.manifest.heightRange.maxMeters / 1000 / MOON_RADIUS_KM) * Math.max(this.relief, 0.001);
    this.controls.updateMinAlt();
    this.invalidate();
  }

  flyTo(target: LatLon, altitudeKm?: number): Promise<void> {
    const alt = altitudeKm !== undefined && Number.isFinite(altitudeKm) ? altitudeKm / MOON_RADIUS_KM : undefined;
    return this.controls.flyTo(Math.max(-90, Math.min(90, target.lat)), target.lon, alt);
  }

  setMarkers(markers: Marker[]): void {
    this.markers.set(markers);
    this.invalidate();
  }

  setSelection(p: LatLon | null): void {
    this.selection = p ? { lat: p.lat, lon: p.lon } : null;
    if (p) {
      const [x, y, z] = latLonToVec(p.lat, p.lon);
      (this.uniforms.uSelDir.value as THREE.Vector3).set(x, y, z);
    }
    (this.uniforms.uSel.value as THREE.Vector3).z = p ? 1 : 0;
    this.invalidate();
  }

  onPick(cb: (p: LatLon) => void): void {
    this.pickCb = cb;
  }

  onMarkerClick(cb: (id: string) => void): void {
    this.markerCb = cb;
  }

  onViewChange(cb: (v: ViewState) => void): void {
    this.viewCb = cb;
  }

  getViewState(): ViewState {
    const c = vecToLatLon(this.controls.centerDir(_v));
    return {
      center: c,
      altitudeKm: this.controls.alt * MOON_RADIUS_KM,
      metersPerPixel: this.controls.metersPerPixel(),
      tiles: this.tiles.status,
    };
  }

  setAutoRotate(on: boolean): void {
    this.controls.setAutoRotate(on);
  }

  resetView(): void {
    void this.controls.flyTo(0, 0, this.controls.maxAlt);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    cancelAnimationFrame(this.raf);
    if (this.sunTimer) clearInterval(this.sunTimer);
    if (this.emitTimer) clearTimeout(this.emitTimer);
    this.loadAbort?.abort();
    this.resizeObserver?.disconnect();
    this.canvas.removeEventListener('webglcontextlost', this.onContextLost);
    this.canvas.removeEventListener('webglcontextrestored', this.onContextRestored);
    window.removeEventListener('resize', this.onWindowResize);
    window.removeEventListener('orientationchange', this.onWindowResize);
    document.removeEventListener('visibilitychange', this.onVisibility);
    this.controls.dispose();
    this.markers.dispose();
    this.tiles.dispose();
    this.colorTex?.dispose();
    this.normalTex?.dispose();
    this.confTex?.dispose();
    this.heightField?.texture.dispose();
    for (const t of this.placeholders) t.dispose();
    this.globeGeometry.dispose();
    this.tileGeometry.dispose();
    this.globeMaterial.dispose();
    this.stars.geometry.dispose();
    this.stars.material.dispose();
    this.renderer.dispose();
    this.pickCb = this.markerCb = this.viewCb = null;
  }

  // ====================================================================== extras (beyond IMoonView)

  /** Instantly centre the view (no animation). */
  jumpTo(target: LatLon, altitudeKm?: number): void {
    this.controls.jumpTo(target.lat, target.lon, altitudeKm !== undefined ? altitudeKm / MOON_RADIUS_KM : undefined);
  }

  /** Smooth zoom by a factor (> 1 zooms in) about the view centre — for on-screen +/- buttons. */
  zoomBy(factor: number): void {
    this.controls.zoomBy(factor);
  }

  /** Current sub-solar point used for shading (degrees), or null in 'full' mode. */
  getSunPosition(): LatLon | null {
    return this.mode === 'full' ? null : vecToLatLon(this.sunTarget);
  }

  /** Screen position (CSS px, relative to the canvas) of a surface point, or null when hidden. */
  project(p: LatLon): { x: number; y: number } | null {
    const [x, y, z] = latLonToVec(p.lat, p.lon);
    _v.set(x, y, z);
    if (_v.dot(this.camera.position) <= 1) return null;
    _v.project(this.camera);
    return { x: (_v.x * 0.5 + 0.5) * this.width, y: (0.5 - _v.y * 0.5) * this.height };
  }

  /** Force a re-layout (normally automatic through ResizeObserver). */
  resize(): void {
    if (this.disposed) return;
    const w = this.canvas.clientWidth;
    const h = this.canvas.clientHeight;
    if (w < 1 || h < 1) return;
    let pr = Math.min(window.devicePixelRatio || 1, this.profile.pixelRatio);
    const px = w * h * pr * pr;
    if (px > this.profile.pixelBudget) pr *= Math.sqrt(this.profile.pixelBudget / px);
    pr = Math.max(0.75, pr);
    if (w === this.width && h === this.height && Math.abs(pr - this.pixelRatio) < 1e-3) return;
    this.width = w;
    this.height = h;
    this.pixelRatio = pr;
    this.renderer.setPixelRatio(pr);
    this.renderer.setSize(w, h, false);
    this.controls.resize(w, h);
    this.markers.layout();
    this.uniforms.uHatchPx.value = 9 * pr;
    this.stars.material.uniforms.uPixelRatio.value = pr;
    this.invalidate();
  }

  // ====================================================================== internals

  private makeStars(): THREE.Points<THREE.BufferGeometry, THREE.ShaderMaterial> {
    const n = this.profile.stars;
    const rnd = mulberry32(0x5eed1e);
    const pos = new Float32Array(n * 3);
    const col = new Float32Array(n * 3);
    const size = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const z = rnd() * 2 - 1;
      const a = rnd() * Math.PI * 2;
      const r = Math.sqrt(1 - z * z);
      pos[i * 3] = r * Math.cos(a);
      pos[i * 3 + 1] = z;
      pos[i * 3 + 2] = r * Math.sin(a);
      // many faint stars, few bright ones
      const m = Math.pow(rnd(), 5);
      const b = 0.26 + 0.74 * m;
      const t = rnd();
      // colour temperature: blue-white .. warm white
      const cr = 0.82 + 0.18 * t;
      const cb = 1.0 - 0.28 * t;
      col[i * 3] = b * cr;
      col[i * 3 + 1] = b * (0.9 + 0.05 * t);
      col[i * 3 + 2] = b * cb;
      size[i] = 1.25 + 1.5 * m + 0.35 * rnd();
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('aColor', new THREE.BufferAttribute(col, 3));
    g.setAttribute('aSize', new THREE.BufferAttribute(size, 1));
    const mat = new THREE.ShaderMaterial({
      vertexShader: STAR_VERTEX,
      fragmentShader: STAR_FRAGMENT,
      uniforms: { uPixelRatio: { value: 1 }, uOpacity: { value: 1 } },
      depthTest: false,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    const pts = new THREE.Points(g, mat);
    pts.frustumCulled = false;
    pts.renderOrder = 0;
    return pts;
  }

  private createTileMesh(defines: Record<string, string | number>): THREE.Mesh<THREE.BufferGeometry, THREE.ShaderMaterial> {
    const mat = new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3,
      vertexShader: VERTEX,
      fragmentShader: FRAGMENT,
      defines: { ...defines, TILE: 1 },
      uniforms: {
        ...this.uniforms,
        uRect: { value: new THREE.Vector4(0, 0, 1, 1) },
        uGridN: { value: this.profile.tileGrid },
        uTile: { value: null },
        uTileAlpha: { value: 1 },
      },
      transparent: true,
      depthTest: false,
      depthWrite: false,
    });
    return new THREE.Mesh(this.tileGeometry, mat);
  }

  private updateRealtimeSun(): void {
    if (this.mode !== 'realtime') return;
    let p: LatLon;
    try {
      p = subSolarPoint(this.realtimeDate ?? new Date());
    } catch {
      p = { lat: 0, lon: 0 };
    }
    const [x, y, z] = latLonToVec(p.lat, p.lon);
    this.sunTarget.set(x, y, z);
    this.invalidate();
  }

  // ---------------------------------------------------------------------- textures

  private async loadBase(): Promise<void> {
    const gen = ++this.loadGeneration;
    this.loadAbort?.abort();
    const ac = new AbortController();
    this.loadAbort = ac;
    const m = this.manifest;
    const maxW = maxBaseWidth(this.quality, this.caps);
    const aniso = Math.min(this.caps.maxAnisotropy, this.profile.anisotropy);
    const stale = (): boolean => gen !== this.loadGeneration || this.disposed;
    const loadColor = (i: number) => loadEquirectTexture(this.renderer, m.color[i].url, { srgb: true, anisotropy: aniso, maxWidth: maxW, signal: ac.signal });
    const loadNormal = (i: number) => loadEquirectTexture(this.renderer, m.normal[i].url, { srgb: false, anisotropy: aniso, maxWidth: maxW, signal: ac.signal });
    const setColor = (t: THREE.Texture): void => {
      this.colorTex?.dispose();
      this.colorTex = t;
      this.uniforms.uColor.value = t;
      this.baseWidth = t.userData.width as number;
      (this.uniforms.uColorSize.value as THREE.Vector2).set(t.userData.width as number, t.userData.height as number);
    };
    const setNormal = (t: THREE.Texture): void => {
      this.normalTex?.dispose();
      this.normalTex = t;
      this.uniforms.uNormal.value = t;
    };
    const setHeight = (h: HeightField, keepCpu: boolean): void => {
      this.heightField?.texture.dispose();
      this.heightField = h;
      this.uniforms.uHeight.value = h.texture;
      if (keepCpu || !this.cpuHeights) {
        this.cpuHeights = h;
        this.markers.refreshHeights();
      }
    };

    try {
      // 1) lowest tier of everything -> first frame
      const hLow = pickTier(m.height, 1024);
      const [c0, n0, h0] = await Promise.all([loadColor(0), loadNormal(0), loadHeightField(m.height[hLow].url, m.heightRange, ac.signal)]);
      if (stale()) {
        c0.dispose();
        n0.dispose();
        h0.texture.dispose();
        return;
      }
      setColor(c0);
      setNormal(n0);
      setHeight(h0, true);
      this.baseReady = true;
      this.invalidate();

      // 2) progressive upgrade to the tier this device can afford
      const cT = pickTier(m.color, maxW);
      const nT = pickTier(m.normal, maxW);
      const hT = pickTier(m.height, Math.min(this.profile.heightWidth, this.caps.maxTextureSize));
      const setColorIfFresh = (t: THREE.Texture): void => (stale() ? t.dispose() : setColor(t));
      const setNormalIfFresh = (t: THREE.Texture): void => (stale() ? t.dispose() : setNormal(t));
      const steps: (() => Promise<void>)[] = [];
      // medium/high go through the 4k tier first when the target is 8k so detail arrives sooner
      const colorSteps = cT > 1 ? [1, cT] : cT > 0 ? [cT] : [];
      const normalSteps = nT > 1 ? [1, nT] : nT > 0 ? [nT] : [];
      const maxSteps = Math.max(colorSteps.length, normalSteps.length);
      for (let s = 0; s < maxSteps; s++) {
        const ci = colorSteps[s];
        const ni = normalSteps[s];
        if (ci !== undefined) steps.push(async () => setColorIfFresh(await loadColor(ci)));
        if (ni !== undefined) steps.push(async () => setNormalIfFresh(await loadNormal(ni)));
        if (s === 0 && hT !== hLow) {
          steps.push(async () => {
            const h = await loadHeightField(m.height[hT].url, m.heightRange, ac.signal);
            if (stale()) h.texture.dispose();
            else {
              // keep only the small CPU copy for picking; the big one lives on the GPU
              const cpu = this.cpuHeights;
              setHeight(h, false);
              this.cpuHeights = cpu;
              h.km = new Float32Array(0);
            }
          });
        }
      }
      for (const step of steps) {
        if (stale()) return;
        try {
          await step();
          this.invalidate();
        } catch (err) {
          if (stale()) return;
          console.warn('[MoonView] higher-resolution texture unavailable, keeping the current one.', err);
        }
      }
    } catch (err) {
      if (stale()) return;
      if (!this.firstFrameDone) this.rejectReady(err instanceof Error ? err : new Error(String(err)));
    }
  }

  private async loadConfidence(): Promise<void> {
    this.confLoading = true;
    try {
      const t = await loadEquirectTexture(this.renderer, this.manifest.confidence.url, {
        srgb: false,
        anisotropy: Math.min(4, this.caps.maxAnisotropy),
        maxWidth: Math.min(4096, this.caps.maxTextureSize),
      });
      if (this.disposed) {
        t.dispose();
        return;
      }
      this.confTex = t;
      this.uniforms.uConf.value = t;
      this.invalidate();
    } catch (err) {
      console.warn('[MoonView] confidence overlay could not be loaded.', err);
    } finally {
      this.confLoading = false;
    }
  }

  // ---------------------------------------------------------------------- picking

  /** Surface point under a screen position, refined against the terrain height. */
  private pick(x: number, y: number): LatLon | null {
    if (!this.controls.screenToWorld(x, y, _v)) return null;
    // ray through the pixel
    const o = this.camera.position;
    _w.set((2 * x) / this.width - 1, 1 - (2 * y) / this.height, 0.5).unproject(this.camera).sub(o).normalize();
    let ll = vecToLatLon(_v);
    for (let i = 0; i < 2; i++) {
      const r = 1 + (sampleHeightKm(this.cpuHeights, ll.lat, ll.lon) / MOON_RADIUS_KM) * this.relief;
      const b = o.dot(_w);
      const disc = b * b - (o.lengthSq() - r * r);
      if (disc < 0) break;
      const t = -b - Math.sqrt(disc);
      _v.copy(_w).multiplyScalar(t).add(o);
      ll = vecToLatLon(_v);
    }
    return ll;
  }

  private handleTap(x: number, y: number): void {
    const id = this.markers.hitTest(x, y);
    if (id !== null) {
      this.markerCb?.(id);
      return;
    }
    const p = this.pick(x, y);
    if (p) this.pickCb?.(p);
  }

  private handleDoubleTap(x: number, y: number): void {
    const p = this.pick(x, y);
    if (!p) return;
    const alt = Math.max(this.controls.minAlt, this.controls.alt * 0.3);
    void this.controls.flyTo(p.lat, p.lon, alt, 0.75);
  }

  // ---------------------------------------------------------------------- events

  private onContextLost = (e: Event): void => {
    e.preventDefault();
    this.contextLost = true;
    cancelAnimationFrame(this.raf);
    this.raf = 0;
  };

  private onContextRestored = (): void => {
    this.contextLost = false;
    // GPU objects are gone: three re-creates programs/buffers lazily; textures are reloaded.
    this.tiles.clear();
    this.colorTex = this.normalTex = this.confTex = null;
    this.heightField = null;
    this.uniforms.uColor.value = this.placeholders[0];
    this.uniforms.uNormal.value = this.placeholders[1];
    this.uniforms.uHeight.value = this.placeholders[2];
    this.uniforms.uConf.value = this.placeholders[2];
    void this.loadBase();
    if (this.confTarget > 0) void this.loadConfidence();
    this.invalidate();
  };

  private onWindowResize = (): void => {
    this.resize();
    // some mobile browsers report the new size a little after the event
    setTimeout(() => this.resize(), 250);
  };

  private onVisibility = (): void => {
    if (!document.hidden) this.invalidate();
  };

  // ---------------------------------------------------------------------- frame loop

  private invalidate(): void {
    this.needsRender = true;
    if (!this.raf && !this.contextLost && !this.disposed) this.raf = requestAnimationFrame(this.frame);
  }

  private frame = (time: number): void => {
    this.raf = 0;
    if (this.disposed || this.contextLost) return;
    if (this.width < 1 || this.height < 1) {
      this.resize();
      if (this.width < 1) return;
    }
    // Elapsed time: after an idle period (render-on-demand) start from a nominal frame, otherwise
    // follow the real frame time (clamped) so animations keep their speed on slow devices.
    const gap = (time - this.lastTime) / 1000;
    const continuous = this.wasAnimating && this.lastTime !== 0 && gap > 0;
    const dt = continuous ? Math.min(0.1, gap) : 1 / 60;
    const realDt = continuous ? Math.min(0.3, gap) : 1 / 60;
    this.lastTime = time;
    this.needsRender = false;
    let animating = this.controls.update(dt, time, realDt);

    // lighting transitions
    const fullTarget = this.mode === 'full' ? 1 : 0;
    if (this.fullMix !== fullTarget) {
      const step = dt / 0.35;
      this.fullMix = fullTarget > this.fullMix ? Math.min(1, this.fullMix + step) : Math.max(0, this.fullMix - step);
      animating = true;
    }
    const ang = this.sunDir.angleTo(this.sunTarget);
    if (ang > 1e-4) {
      const f = ang < 2e-3 ? 1 : 1 - Math.exp(-dt * 12);
      _q.setFromUnitVectors(this.sunDir, this.sunTarget);
      _q.slerp(_q.clone().identity(), 1 - f);
      this.sunDir.applyQuaternion(_q).normalize();
      animating = true;
    }
    if (this.confOpacity !== this.confTarget) {
      // wait for the texture before fading the overlay in
      const target = this.confTex ? this.confTarget : Math.min(this.confTarget, 0);
      const step = dt / 0.25;
      this.confOpacity = target > this.confOpacity ? Math.min(target, this.confOpacity + step) : Math.max(target, this.confOpacity - step);
      if (this.confOpacity !== target) animating = true;
    }

    // camera + uniforms
    const u = this.uniforms;
    this.controls.applyTo(this.camera, u.uHMax.value as number);
    const viewDir = this.controls.centerDir(u.uViewDir.value as THREE.Vector3);
    u.uFullMix.value = this.fullMix * this.fullMix * (3 - 2 * this.fullMix);
    u.uConfOpacity.value = this.confOpacity;
    const alpha = Math.acos(Math.max(-1, Math.min(1, viewDir.dot(this.sunDir))));
    // Auto-exposure, like a camera metering the sunlit ground in the frame: evaluate the same
    // photometric model at the brightest point of the visible cap (towards the Sun, at most 70 %
    // of the way to the edge of the view / the limb) and expose so that it lands near white.
    const thetaView = Math.min(Math.acos(1 / this.controls.dist), this.controls.alt * Math.hypot(this.controls.tanH, this.controls.tanV));
    const beta = Math.min(alpha, 0.7 * thetaView);
    const mu0 = Math.max(0, Math.cos(alpha - beta));
    const mu = Math.cos(beta);
    const deg = (alpha * 180) / Math.PI;
    const lf = Math.min(1, Math.max(0.18, 1 + deg * (-0.019 + deg * (2.42e-4 - 1.46e-6 * deg))));
    const disk = (lf * 2 * mu0) / (mu0 + mu + 1e-4) + (1 - lf) * mu0;
    const exposure = Math.min(12, Math.pow(Math.max(disk * phaseFunction(alpha), 1e-3), -0.9));
    u.uExposure.value = exposure;
    const earthPhase = 0.5 * (1 - this.sunDir.z);
    u.uEarthshine.value = 0.008 * earthPhase * earthPhase;
    const pxAngle = this.controls.metersPerPixel() / (MOON_RADIUS_KM * 1000);
    const sel = u.uSel.value as THREE.Vector3;
    sel.x = 15 * pxAngle;
    sel.y = pxAngle;
    // Stars: dimmed while a bright sunlit Moon fills the frame, clearer over the night side.
    const night = Math.min(1, Math.max(0, (alpha - 1.0) / 1.4));
    const starBase = 0.5 + 0.5 * night * night;
    this.stars.material.uniforms.uOpacity.value = starBase * (1 - 0.45 * this.fullMix);

    // tiles
    _m.multiplyMatrices(this.camera.projectionMatrix, this.camera.matrixWorldInverse);
    this.frustum.setFromProjectionMatrix(_m);
    if (this.baseReady) {
      this.tiles.update(
        {
          camPos: this.camera.position,
          dist: this.controls.dist,
          frustum: this.frustum,
          focalPx: (this.height * this.pixelRatio) / (2 * this.controls.tanV),
          baseWidth: this.baseWidth,
        },
        performance.now(),
      );
    }

    this.renderer.render(this.scene, this.camera);
    this.markers.update({ camera: this.camera, width: this.width, height: this.height, relief: this.relief });

    if (this.baseReady && !this.firstFrameDone) {
      this.firstFrameDone = true;
      this.resolveReady();
    }
    this.emitViewChange();
    this.wasAnimating = animating || this.needsRender;
    if (this.wasAnimating && !this.raf) this.raf = requestAnimationFrame(this.frame);
  };

  private emitViewChange(): void {
    if (!this.viewCb) return;
    const s = this.getViewState();
    const key = `${s.center.lat.toFixed(4)},${s.center.lon.toFixed(4)},${s.altitudeKm.toFixed(3)},${s.tiles}`;
    if (key === this.lastState) return;
    const now = performance.now();
    if (now - this.lastEmit >= 100) {
      this.lastEmit = now;
      this.lastState = key;
      this.viewCb(s);
    } else if (!this.emitTimer) {
      this.emitTimer = setTimeout(() => {
        this.emitTimer = null;
        if (!this.disposed) this.emitViewChange();
      }, 105 - (now - this.lastEmit));
    }
  }
}
