/** UI orchestrator: owns all chrome and talks to the renderer only through IMoonView. */
import { MOON_RADIUS_KM, type IMoonView, type LatLon, type Manifest, type Marker, type QualityTier, type ViewState } from '../types';
import type { Rasters } from '../data/rasters';
import { Places, altitudeForDiameter, type NearestFeature, type Place } from '../data/places';
import type { QualityChoice } from '../data/quality';
import { writeHash, type HashState } from '../data/urlState';
import { clamp, formatAltitude, formatLatLon, niceScale, wrapLon } from '../data/geo';
import { h, prefersReducedMotion, setText, store } from './dom';
import { icon } from './icons';
import { LOW_SUPPORT, gradeFor, type Ramp } from './ramp';
import { MeterPanel, buildLegend, type PointInfo } from './meter';
import { LightingControl } from './lighting';
import { SearchBox, placeDetail, type QuickPlace } from './search';
import { SettingsPanel, tilesLabel, type SettingsState } from './settings';
import { AboutDialog } from './about';

export interface AppOptions {
  /** Overlay layer that receives all UI chrome. */
  root: HTMLElement;
  canvas: HTMLCanvasElement;
  view: IMoonView;
  manifest: Manifest;
  places: Places;
  ramp: Ramp;
  quality: QualityChoice;
  initial: HashState;
  onQuality(tier: QualityTier | null): void;
}

interface Selection extends LatLon {
  id?: string;
  name?: string;
  detail?: string;
}

const OVERLAY_OPACITY = 0.85;
const HINT_KEY = 'moon-spinner.hint-dismissed';
const PHONE_QUERY = '(max-width: 719px)';

const QUICK: QuickPlace[] = [
  { label: 'Tycho', resolve: (p) => feature(p, 'Tycho', -43.2958, -11.2153, 85) },
  { label: 'Copernicus', resolve: (p) => feature(p, 'Copernicus', 9.6209, -20.0786, 96) },
  {
    label: 'Apollo 11',
    resolve: (p) => {
      const place = p.findSite('Apollo 11') ?? undefined;
      return { place, lat: place?.lat ?? 0.6742, lon: place?.lon ?? 23.4731, altitudeKm: 180, name: place?.name ?? 'Apollo 11', detail: 'Mare Tranquillitatis · NASA 1969' };
    },
  },
  { label: 'South Pole–Aitken', resolve: () => ({ lat: -53, lon: -169, altitudeKm: 4200, name: 'South Pole–Aitken basin', detail: 'Impact basin · about 2,500 km' }) },
  { label: 'Orientale', resolve: (p) => ({ ...feature(p, 'Mare Orientale', -19.8655, -94.6703, 294), altitudeKm: 2200 }) },
  { label: 'Shackleton · south pole', resolve: (p) => ({ ...feature(p, 'Shackleton', -89.67, 129.78, 21), altitudeKm: 260 }) },
  { label: 'Far side', resolve: () => ({ lat: 0, lon: 180, altitudeKm: 5200, name: 'Far side centre', detail: 'Never visible from Earth' }) },
];

function feature(p: Places, name: string, lat: number, lon: number, diameterKm: number): ReturnType<QuickPlace['resolve']> {
  const place = p.findFeature(name) ?? undefined;
  const d = place?.kind === 'feature' ? place.feature.diameterKm : diameterKm;
  return { place, lat: place?.lat ?? lat, lon: place?.lon ?? lon, altitudeKm: altitudeForDiameter(d), name, detail: place ? placeDetail(place) : undefined };
}

export class App {
  private readonly view: IMoonView;
  private readonly places: Places;
  private readonly root: HTMLElement;
  private readonly panel: MeterPanel;
  private readonly lighting: LightingControl;
  private readonly search: SearchBox;
  private readonly settings: SettingsPanel;
  private readonly about: AboutDialog;
  private readonly overlayBtn: HTMLButtonElement;
  private readonly scaleBar: HTMLElement;
  private readonly scaleLabel: HTMLElement;
  private readonly altLabel: HTMLElement;
  private readonly tilesChip: HTMLElement;
  private readonly tilesText: HTMLElement;
  private readonly stripLegend: HTMLElement;
  private readonly live: HTMLElement;
  private readonly hint: HTMLElement;
  private readonly phoneMq = window.matchMedia(PHONE_QUERY);
  private readonly disposers: (() => void)[] = [];

  private rasters: Rasters | null = null;
  private rastersFailed = false;
  private viewState: ViewState;
  private selection: Selection | null = null;
  private state: SettingsState = { labels: true, sites: true, autoRotate: false, overlay: false, relief: 1 };
  private markerKey = '';
  private frame = 0;
  private alive = true;

  constructor(private readonly opts: AppOptions) {
    this.view = opts.view;
    this.places = opts.places;
    this.root = opts.root;
    this.viewState = this.view.getViewState();

    // --- components
    this.panel = new MeterPanel(opts.ramp, {
      onOverlay: (on) => this.setState('overlay', on),
      onClearSelection: () => this.select(null),
      onAbout: () => this.about.open(),
      onGoToNearest: (n) => this.goToNearest(n),
    });
    this.lighting = new LightingControl((mode, o) => this.view.setLighting(mode, o));
    this.search = new SearchBox(this.places, QUICK, {
      onPlace: (p) => this.goToPlace(p),
      onQuick: (q) => {
        const r = q.resolve(this.places);
        this.select({ lat: r.lat, lon: r.lon, id: r.place?.id, name: r.name, detail: r.detail });
        void this.view.flyTo({ lat: r.lat, lon: r.lon }, r.altitudeKm);
      },
    });
    this.settings = new SettingsPanel(this.state, opts.quality, {
      onChange: (k, v) => this.setState(k, v),
      onResetView: () => {
        this.select(null);
        this.view.resetView();
      },
      onQuality: (t) => opts.onQuality(t),
      onAbout: () => this.about.open(),
    });
    this.about = new AboutDialog(opts.manifest, opts.ramp);

    this.overlayBtn = h(
      'button',
      { type: 'button', class: 'icon-btn', 'aria-pressed': 'false', 'aria-label': 'Show data support on globe', title: 'Show data support on globe', onclick: () => this.setState('overlay', !this.state.overlay) },
      icon('layers'),
    );
    const aboutBtn = h('button', { type: 'button', class: 'icon-btn about-btn', 'aria-label': 'About the data', title: 'About the data', onclick: () => this.about.open() }, icon('info'));

    // --- status strip (scale bar, tiles, overlay legend)
    this.scaleBar = h('i', { class: 'scale-bar' });
    this.scaleLabel = h('span', { class: 'mono' }, '');
    this.altLabel = h('span', { class: 'scale-alt mono' }, '');
    this.tilesText = h('span', null, '');
    this.tilesChip = h('div', { class: 'tiles-chip', hidden: true }, h('i', { class: 'dot' }), this.tilesText);
    this.stripLegend = h('div', { class: 'strip-legend', hidden: true }, h('span', { class: 'section-label' }, 'Data support'), buildLegend(opts.ramp, true));
    const strip = h(
      'div',
      { class: 'strip' },
      this.stripLegend,
      this.tilesChip,
      h('div', { class: 'scale', role: 'img', 'aria-label': 'Map scale' }, h('div', { class: 'scale-text' }, this.scaleLabel, this.altLabel), this.scaleBar),
    );

    // --- first-run hint
    this.hint = h(
      'div',
      { class: 'hint', role: 'note', hidden: true },
      h('span', null, 'Drag to rotate'), h('i'), h('span', null, 'Pinch or scroll to zoom'), h('i'), h('span', null, 'Tap for data'),
      h('button', { type: 'button', class: 'icon-btn hint-close', 'aria-label': 'Dismiss hint', onclick: () => this.dismissHint(true) }, icon('close', 14)),
    );

    this.live = h('div', { class: 'sr-only', 'aria-live': 'polite', 'aria-atomic': 'true' });

    const topbar = h('header', { class: 'topbar' }, this.search.el, h('div', { class: 'actions' }, this.overlayBtn, this.settings.button, aboutBtn));
    this.root.replaceChildren(topbar, this.settings.el, this.panel.el, this.lighting.el, strip, this.hint, this.live, this.about.el);

    this.bindLayout();
    this.bindCanvas();
    this.bindGlobal();

    // --- renderer wiring
    this.view.onViewChange((v) => this.onView(v));
    this.view.onPick((p) => this.select({ lat: p.lat, lon: wrapLon(p.lon) }, true));
    this.view.onMarkerClick((id) => {
      const place = this.places.byId(id);
      if (place) this.select({ lat: place.lat, lon: place.lon, id: place.id, name: place.name, detail: placeDetail(place) }, true);
    });

    this.view.setReliefScale(this.state.relief);
    this.view.setAutoRotate(this.state.autoRotate);
    this.view.setConfidenceOverlay(0);
    this.lighting.start();

    const init = opts.initial;
    if (init.center) void this.view.flyTo(init.center, init.altitudeKm);
    if (init.selection) this.select(init.selection);
    else this.refreshPoint();
    this.onView(this.view.getViewState());

    if (!store(HINT_KEY)) {
      this.hint.hidden = false;
      const t = window.setTimeout(() => this.dismissHint(false), 14000);
      this.disposers.push(() => window.clearTimeout(t));
    }
  }

  /** Called once the measurement rasters are decoded (or have failed). */
  setRasters(r: Rasters | null): void {
    this.rasters = r;
    this.rastersFailed = !r;
    this.refreshPoint();
  }

  destroy(): void {
    this.alive = false;
    cancelAnimationFrame(this.frame);
    this.lighting.stop();
    if (this.about.el.open) this.about.el.close();
    for (const d of this.disposers) d();
    this.root.replaceChildren();
  }

  // ---------------------------------------------------------------- layout

  private bindLayout(): void {
    const place = () => {
      const phone = this.phoneMq.matches;
      this.root.classList.toggle('is-phone', phone);
      if (phone) this.panel.lightingSlot.append(this.lighting.el);
      else this.panel.el.after(this.lighting.el);
      this.panel.setOpen(!phone && window.innerHeight >= 620);
    };
    place();
    this.phoneMq.addEventListener('change', place);
    this.disposers.push(() => this.phoneMq.removeEventListener('change', place));

    if ('ResizeObserver' in window) {
      const ro = new ResizeObserver(() => {
        this.root.style.setProperty('--sheet-h', `${Math.round(this.panel.el.getBoundingClientRect().height)}px`);
      });
      ro.observe(this.panel.el);
      this.disposers.push(() => ro.disconnect());
    }
    const onResize = () => this.schedule();
    window.addEventListener('resize', onResize);
    this.disposers.push(() => window.removeEventListener('resize', onResize));
  }

  private bindCanvas(): void {
    const c = this.opts.canvas;
    const dismiss = () => this.dismissHint(true);
    c.addEventListener('pointerdown', dismiss, { passive: true });
    c.addEventListener('wheel', dismiss, { passive: true });
    c.addEventListener('pointerdown', () => {
      // Tapping the globe closes transient UI; on phones also frees the screen.
      this.search.close(false);
      if (this.settings.opened) this.settings.close();
    });
    c.addEventListener('keydown', (e) => this.onCanvasKey(e));
  }

  private bindGlobal(): void {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      const typing = !!t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable);
      if (e.key === '/' && !typing && !e.ctrlKey && !e.metaKey) {
        e.preventDefault();
        this.search.focus();
      } else if (e.key === 'Escape' && !e.defaultPrevented && !this.about.el.open) {
        if (this.search.opened) this.search.close(true);
        else if (this.settings.opened) this.settings.close();
        else if (this.selection) this.select(null);
      }
    };
    document.addEventListener('keydown', onKey);
    // Keep browser page-zoom gestures from firing over UI chrome.
    const onWheel = (e: WheelEvent) => {
      if (e.ctrlKey) e.preventDefault();
    };
    const onGesture = (e: Event) => e.preventDefault();
    this.root.addEventListener('wheel', onWheel, { passive: false });
    document.addEventListener('gesturestart', onGesture);
    this.disposers.push(() => {
      document.removeEventListener('keydown', onKey);
      this.root.removeEventListener('wheel', onWheel);
      document.removeEventListener('gesturestart', onGesture);
    });
  }

  /** Keyboard navigation for the globe (the renderer handles pointer input). */
  private onCanvasKey(e: KeyboardEvent): void {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const v = this.viewState;
    const step = clamp((v.altitudeKm / MOON_RADIUS_KM) * 18, 0.05, 20);
    let { lat, lon } = v.center;
    let alt = v.altitudeKm;
    switch (e.key) {
      case 'ArrowLeft': lon -= step / Math.max(0.2, Math.cos((lat * Math.PI) / 180)); break;
      case 'ArrowRight': lon += step / Math.max(0.2, Math.cos((lat * Math.PI) / 180)); break;
      case 'ArrowUp': lat += step; break;
      case 'ArrowDown': lat -= step; break;
      case '+': case '=': alt *= 0.75; break;
      case '-': case '_': alt *= 1.33; break;
      case 'Enter': case ' ':
        e.preventDefault();
        this.select({ lat: v.center.lat, lon: v.center.lon }, true);
        return;
      default: return;
    }
    e.preventDefault();
    this.dismissHint(true);
    void this.view.flyTo({ lat: clamp(lat, -89.9, 89.9), lon: wrapLon(lon) }, alt);
  }

  private dismissHint(remember: boolean): void {
    if (this.hint.hidden) return;
    if (remember) store(HINT_KEY, '1');
    this.hint.classList.add('leaving');
    window.setTimeout(() => (this.hint.hidden = true), prefersReducedMotion() ? 0 : 400);
  }

  // ---------------------------------------------------------------- state

  private setState<K extends keyof SettingsState>(key: K, value: SettingsState[K]): void {
    this.state[key] = value;
    this.settings.set(key, value);
    switch (key) {
      case 'overlay': {
        const on = value as boolean;
        this.view.setConfidenceOverlay(on ? OVERLAY_OPACITY : 0);
        this.panel.setOverlay(on);
        this.overlayBtn.setAttribute('aria-pressed', String(on));
        const label = on ? 'Hide data support on globe' : 'Show data support on globe';
        this.overlayBtn.setAttribute('aria-label', label);
        this.overlayBtn.title = label;
        this.stripLegend.hidden = !on;
        this.announce(on ? 'Data support overlay on' : 'Data support overlay off');
        break;
      }
      case 'relief': this.view.setReliefScale(value as number); break;
      case 'autoRotate': this.view.setAutoRotate(value as boolean); break;
      case 'labels':
      case 'sites': this.updateMarkers(); break;
    }
  }

  private announce(text: string): void {
    this.live.textContent = '';
    window.setTimeout(() => this.alive && (this.live.textContent = text), 40);
  }

  // ---------------------------------------------------------------- selection

  private select(sel: Selection | null, announce = false): void {
    this.selection = sel;
    this.view.setSelection(sel ? { lat: sel.lat, lon: sel.lon } : null);
    const info = this.refreshPoint();
    this.updateMarkers();
    this.pushHash();
    if (announce && sel && info) {
      const s = info.conf ? `, data support ${Math.round(info.conf.combined)} of 100, ${gradeFor(info.conf.combined).label}` : '';
      this.announce(`${sel.name ?? 'Selected'} ${formatLatLon(sel)}${s}`);
    }
  }

  private goToPlace(p: Place): void {
    this.select({ lat: p.lat, lon: p.lon, id: p.id, name: p.name, detail: placeDetail(p) }, true);
    void this.view.flyTo({ lat: p.lat, lon: p.lon }, p.kind === 'feature' ? altitudeForDiameter(p.feature.diameterKm) : 140);
  }

  private goToNearest(n: NearestFeature): void {
    const p = this.places.findFeature(n.feature.name);
    if (p) this.goToPlace(p);
  }

  /** Recompute everything shown for the active point (selection, else view centre). */
  private refreshPoint(): PointInfo | null {
    if (!this.alive) return null;
    const sel = this.selection;
    const pos: LatLon = sel ? { lat: sel.lat, lon: sel.lon } : this.viewState.center;
    const r = this.rasters;
    const info: PointInfo = {
      source: sel ? 'selection' : 'center',
      name: sel?.name,
      detail: sel?.detail,
      pos,
      elevation: r ? r.sampleElevation(pos.lat, pos.lon) : null,
      conf: r ? r.sampleConfidence(pos.lat, pos.lon) : null,
      shots: r ? r.shotCountAt(pos.lat, pos.lon) : null,
      cellKm: r ? r.countCellKm : NaN,
      nearest: this.places.nearest(pos),
      data: r ? 'ready' : this.rastersFailed ? 'unavailable' : 'loading',
    };
    this.panel.update(info);
    // Even with a selection, flag when the view itself is over thin data.
    const centre = sel && r ? r.sampleConfidence(this.viewState.center.lat, this.viewState.center.lon) : info.conf;
    this.root.classList.toggle('center-low', !!centre && centre.combined < LOW_SUPPORT);
    return info;
  }

  // ---------------------------------------------------------------- view

  private onView(v: ViewState): void {
    this.viewState = v;
    this.schedule();
  }

  private schedule(): void {
    if (this.frame || !this.alive) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      this.renderView();
    });
  }

  private renderView(): void {
    const v = this.viewState;
    this.panel.updateView(v);
    this.refreshPoint();
    this.updateMarkers();

    const s = niceScale(v.metersPerPixel, this.phoneMq.matches ? 84 : 120);
    if (s) {
      this.scaleBar.style.width = `${s.px.toFixed(1)}px`;
      setText(this.scaleLabel, s.label);
    }
    setText(this.altLabel, `alt ${formatAltitude(v.altitudeKm)}`);

    this.settings.setTiles(v.tiles);
    this.tilesChip.hidden = v.tiles === 'off';
    this.tilesChip.dataset.state = v.tiles;
    setText(this.tilesText, tilesLabel(v.tiles));
    this.pushHash();
  }

  private pushHash(): void {
    const v = this.viewState;
    writeHash({ center: v.center, altitudeKm: v.altitudeKm, selection: this.selection ? { lat: this.selection.lat, lon: this.selection.lon } : undefined });
  }

  private spanKm(): number {
    const px = Math.min(window.innerWidth, window.innerHeight);
    return Math.min((this.viewState.metersPerPixel * px) / 1000, MOON_RADIUS_KM * 2.2);
  }

  private updateMarkers(): void {
    const v = this.viewState;
    const span = this.spanKm();
    const markers: Marker[] = [];
    if (this.state.sites) {
      const horizon = Math.acos(MOON_RADIUS_KM / (MOON_RADIUS_KM + Math.max(1, v.altitudeKm)));
      const reach = Math.cos(Math.min(horizon, (span * 0.8) / MOON_RADIUS_KM));
      const cl = Math.cos((v.center.lat * Math.PI) / 180);
      const sl = Math.sin((v.center.lat * Math.PI) / 180);
      this.places.sites.forEach((s, i) => {
        // Whole-disc view: only crewed landings, so labels stay readable.
        if (span > 2600 && s.kind !== 'crewed') return;
        const la = (s.lat * Math.PI) / 180;
        const dot = sl * Math.sin(la) + cl * Math.cos(la) * Math.cos(((s.lon - v.center.lon) * Math.PI) / 180);
        if (dot < reach) return;
        markers.push({ id: `s:${i}`, lat: s.lat, lon: s.lon, label: span > 2600 ? s.name.replace(/\s*\(.*\)$/, '') : s.name, kind: 'site' });
      });
    }
    if (this.state.labels) {
      const cap = this.phoneMq.matches ? 22 : 40;
      markers.push(...this.places.labels(v.center, v.altitudeKm, span, Math.max(8, cap - markers.length)));
    }
    const sel = this.selection;
    if (sel?.name) {
      const i = sel.id ? markers.findIndex((m) => m.id === sel.id) : -1;
      if (i >= 0) markers.splice(i, 1);
      markers.push({ id: sel.id ?? 'sel', lat: sel.lat, lon: sel.lon, label: sel.name, kind: 'selection' });
    }
    const key = markers.map((m) => m.id + m.kind + m.label.length).join('|');
    if (key === this.markerKey) return;
    this.markerKey = key;
    this.view.setMarkers(markers);
  }
}
