/**
 * Boot sequence:
 *   1. resolve quality tier + URL state, show the loading veil
 *   2. check WebGL 2, fetch /data/manifest.json                       (fatal on failure)
 *   3. in parallel: gazetteer JSON, measurement rasters (both non-fatal), renderer chunk
 *   4. construct the renderer, await its first frame                  (fatal on failure)
 *   5. mount the UI, restore the view from the URL hash, lift the veil
 *   6. hand the decoded rasters to the UI when they arrive
 * `boot()` is re-entrant: Retry and quality changes tear everything down and run it again.
 */
import './styles/app.css';
import type { IMoonView, Manifest, QualityTier } from './types';
import { Rasters } from './data/rasters';
import { Places } from './data/places';
import { resolveQuality, saveQuality } from './data/quality';
import { readHash } from './data/urlState';
import { App } from './ui/app';
import { BootScreen } from './ui/boot';
import { Ramp, FALLBACK_RAMP, type RampStops } from './ui/ramp';

type MoonViewCtor = new (canvas: HTMLCanvasElement, manifest: Manifest, quality: QualityTier) => IMoonView;

class BootError extends Error {
  constructor(readonly title: string, message: string, readonly detail = '') {
    super(message);
  }
}

const stage = document.getElementById('stage') as HTMLElement;
const uiRoot = document.getElementById('ui') as HTMLElement;
const bootScreen = new BootScreen();
document.getElementById('app')?.append(bootScreen.el);

let generation = 0;
let current: { view: IMoonView | null; app: App | null } = { view: null, app: null };

function teardown(): void {
  current.app?.destroy();
  try {
    current.view?.dispose();
  } catch (e) {
    console.warn('[boot] renderer dispose failed', e);
  }
  current = { view: null, app: null };
  stage.replaceChildren();
  uiRoot.replaceChildren();
}

function hasWebGL2(): boolean {
  try {
    const c = document.createElement('canvas');
    const gl = c.getContext('webgl2');
    gl?.getExtension('WEBGL_lose_context')?.loseContext();
    return !!gl;
  } catch {
    return false;
  }
}

async function loadManifest(): Promise<Manifest> {
  let res: Response;
  try {
    res = await fetch('/data/manifest.json', { cache: 'no-cache' });
  } catch (e) {
    throw new BootError('Can’t reach the lunar data', 'Check your connection and try again.', String(e));
  }
  if (!res.ok) throw new BootError('Lunar data is unavailable', 'The data package could not be loaded from the server.', `manifest.json: HTTP ${res.status}`);
  try {
    const m = (await res.json()) as Manifest;
    if (!m || !Array.isArray(m.color) || !Array.isArray(m.height)) throw new Error('unexpected manifest shape');
    return m;
  } catch (e) {
    throw new BootError('Lunar data is unavailable', 'The data package is incomplete or damaged.', String(e));
  }
}

async function loadRenderer(): Promise<MoonViewCtor> {
  return (await import('./render/MoonView')).default;
}

async function loadRamp(): Promise<Ramp> {
  let stops: RampStops = FALLBACK_RAMP;
  try {
    stops = (await import('./render/confidenceRamp')).CONFIDENCE_RAMP;
  } catch (e) {
    console.warn('[boot] confidence ramp unavailable, using fallback colours', e);
  }
  return new Ramp(stops);
}

async function boot(): Promise<void> {
  const gen = ++generation;
  const stale = () => gen !== generation;
  teardown();
  bootScreen.showLoading();

  const quality = resolveQuality();
  const initial = readHash();

  try {
    if (!hasWebGL2()) {
      throw new BootError('WebGL isn’t available', 'This browser or device can’t create the 3D graphics context the Moon needs. Try another browser, or enable hardware acceleration.');
    }

    bootScreen.setProgress(0.05, 'Loading lunar data…');
    const manifest = await loadManifest();
    if (stale()) return;
    bootScreen.setProgress(0.12, 'Loading surface maps…');

    let rasterFrac = 0;
    let creep = 0;
    const paint = () => bootScreen.setProgress(0.12 + rasterFrac * 0.28 + creep * 0.58);
    const creepTimer = window.setInterval(() => {
      creep += (0.94 - creep) * 0.035;
      paint();
    }, 120);
    const slowTimer = window.setTimeout(() => bootScreen.setProgress(0, 'Still loading — the surface maps are large…'), 15000);

    const placesP = Places.load();
    const rastersP = Rasters.load(manifest, {
      maxHeightWidth: quality.tier === 'low' ? 1024 : quality.tier === 'medium' ? 2048 : 4096,
      onProgress: (f) => {
        rasterFrac = f;
        if (!stale()) paint();
      },
    }).catch((e) => {
      console.warn('[boot] measurement rasters unavailable', e);
      return null;
    });

    let view: IMoonView;
    let ramp: Ramp;
    let places: Places;
    const canvas = document.createElement('canvas');
    canvas.className = 'moon-canvas';
    canvas.tabIndex = 0;
    canvas.setAttribute('role', 'application');
    canvas.setAttribute('aria-label', 'Interactive Moon globe. Drag to rotate, pinch or scroll to zoom, tap for data. Arrow keys rotate, plus and minus zoom, Enter inspects the view centre.');
    stage.append(canvas);
    try {
      const [Ctor, r] = await Promise.all([loadRenderer(), loadRamp()]);
      if (stale()) return;
      ramp = r;
      view = new Ctor(canvas, manifest, quality.tier);
      current.view = view;
      bootScreen.setProgress(0, 'Preparing the surface…');
      [places] = await Promise.all([placesP, view.ready]);
    } catch (e) {
      if (e instanceof BootError) throw e;
      console.error('[boot] renderer failed', e);
      throw new BootError('The Moon couldn’t be drawn', 'Something went wrong while starting the 3D view. Trying again often helps; a lower quality setting may too.', e instanceof Error ? e.message : String(e));
    } finally {
      window.clearInterval(creepTimer);
      window.clearTimeout(slowTimer);
    }
    if (stale()) return;

    canvas.addEventListener('webglcontextlost', () => {
      if (stale() || current.view !== view) return;
      window.setTimeout(() => {
        const gl = canvas.getContext('webgl2');
        if (stale() || (gl && !gl.isContextLost())) return;
        teardown();
        bootScreen.showError('The 3D view was interrupted', 'The graphics context was lost (this can happen when the device is low on memory).', '', () => void boot());
      }, 2500);
    });

    const app = new App({
      root: uiRoot,
      canvas,
      view,
      manifest,
      places,
      ramp,
      quality,
      initial,
      onQuality: (tier) => {
        saveQuality(tier);
        void boot();
      },
    });
    current.app = app;
    bootScreen.hide();

    void rastersP.then((r) => {
      if (!stale()) app.setRasters(r);
    });
  } catch (e) {
    if (stale()) return;
    teardown();
    const be = e instanceof BootError ? e : new BootError('Something went wrong', 'The app failed to start.', e instanceof Error ? e.message : String(e));
    console.error('[boot]', e);
    bootScreen.showError(be.title, be.message, be.detail, () => void boot());
  }
}

void boot();
