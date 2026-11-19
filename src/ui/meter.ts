/**
 * Data-support panel: compact chip (mini gauge + readout) that expands into the full meter,
 * breakdown and readout. Bottom sheet on phones, side card on larger screens (CSS decides).
 */
import type { LatLon, ViewState } from '../types';
import type { Confidence } from '../data/rasters';
import type { NearestFeature } from '../data/places';
import { featureTypeLabel } from '../data/places';
import { formatAltitude, formatDistanceKm, formatElevation, formatInt, formatLat, formatLon, formatResolution } from '../data/geo';
import { h, nextId, setText } from './dom';
import { icon } from './icons';
import { LOW_SUPPORT, gradeFor, type Ramp } from './ramp';

export interface PointInfo {
  source: 'selection' | 'center';
  /** Place name when a named feature / landing site is selected. */
  name?: string;
  detail?: string;
  pos: LatLon;
  elevation: number | null;
  conf: Confidence | null;
  /** LOLA shots in the raster cell under the point. */
  shots: number | null;
  cellKm: number;
  nearest: NearestFeature | null;
  /** 'loading' until the measurement rasters have been decoded. */
  data: 'loading' | 'ready' | 'unavailable';
}

export interface MeterCallbacks {
  onOverlay(on: boolean): void;
  onClearSelection(): void;
  onAbout(): void;
  onGoToNearest(f: NearestFeature): void;
}

const SVG = 'http://www.w3.org/2000/svg';
const SEGMENTS = 44;
const SWEEP = 220;
const START = -20;

function svgEl<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number>): SVGElementTagNameMap[K] {
  const el = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
  return el;
}

function arcPoint(cx: number, cy: number, r: number, deg: number): [number, number] {
  const a = (deg * Math.PI) / 180;
  return [cx - r * Math.cos(a), cy - r * Math.sin(a)];
}

function arcPath(cx: number, cy: number, r: number, a0: number, a1: number): string {
  const [x0, y0] = arcPoint(cx, cy, r, a0);
  const [x1, y1] = arcPoint(cx, cy, r, a1);
  return `M${x0.toFixed(2)} ${y0.toFixed(2)}A${r} ${r} 0 ${a1 - a0 > 180 ? 1 : 0} 1 ${x1.toFixed(2)} ${y1.toFixed(2)}`;
}

class Gauge {
  readonly el: HTMLElement;
  private readonly segs: SVGPathElement[] = [];
  private readonly num: HTMLElement;
  private readonly grade: HTMLElement;
  private readonly gradeText: HTMLElement;
  private readonly gradeIcon: HTMLElement;
  private readonly needle: SVGPathElement;
  private lastIcon = '';

  constructor(private readonly ramp: Ramp) {
    const cx = 100;
    const cy = 92;
    const r = 80;
    const svg = svgEl('svg', { viewBox: '0 0 200 126', class: 'gauge-svg', 'aria-hidden': 'true' });
    const step = SWEEP / SEGMENTS;
    for (let i = 0; i < SEGMENTS; i++) {
      const p = svgEl('path', { d: arcPath(cx, cy, r, START + i * step + 0.75, START + (i + 1) * step - 0.75), class: 'gauge-seg' });
      this.segs.push(p);
      svg.append(p);
    }
    // Threshold tick + scale labels.
    const tickA = START + (LOW_SUPPORT / 100) * SWEEP;
    const [tx0, ty0] = arcPoint(cx, cy, r + 8, tickA);
    const [tx1, ty1] = arcPoint(cx, cy, r + 13, tickA);
    svg.append(svgEl('path', { d: `M${tx0} ${ty0}L${tx1} ${ty1}`, class: 'gauge-tick' }));
    const label = (deg: number, text: string, rr: number, anchor: string) => {
      const [x, y] = arcPoint(cx, cy, rr, deg);
      const t = svgEl('text', { x: x.toFixed(1), y: y.toFixed(1), class: 'gauge-label', 'text-anchor': anchor });
      t.textContent = text;
      svg.append(t);
    };
    label(START, '0', r - 14, 'middle');
    label(START + SWEEP, '100', r - 16, 'middle');
    label(tickA, String(LOW_SUPPORT), r + 21, 'middle');
    this.needle = svgEl('path', { class: 'gauge-needle', d: '' });
    svg.append(this.needle);

    this.num = h('span', { class: 'gauge-num mono' }, '–');
    this.gradeIcon = h('span', { class: 'grade-icon' });
    this.gradeText = h('span', null, '');
    this.grade = h('div', { class: 'gauge-grade' }, this.gradeIcon, this.gradeText);
    this.el = h(
      'div',
      { class: 'gauge' },
      svg,
      h('div', { class: 'gauge-center' }, h('div', { class: 'gauge-score' }, this.num, h('span', { class: 'gauge-of' }, '/100')), this.grade),
    );
  }

  set(score: number | null, placeholder: string): void {
    const cx = 100;
    const cy = 92;
    const r = 80;
    const lit = score === null ? -1 : (score / 100) * SEGMENTS;
    this.segs.forEach((p, i) => {
      const on = i + 0.5 <= lit || (i === 0 && lit > 0);
      const segScore = ((i + 0.5) / SEGMENTS) * 100;
      p.style.stroke = on ? this.ramp.color(segScore) : '';
      p.classList.toggle('on', on);
      p.classList.toggle('hatch', on && segScore < LOW_SUPPORT);
    });
    if (score === null) {
      this.needle.setAttribute('d', '');
      setText(this.num, '–');
      setText(this.gradeText, placeholder);
      this.gradeIcon.replaceChildren();
      this.lastIcon = '';
      this.grade.dataset.grade = 'none';
      return;
    }
    const a = START + (score / 100) * SWEEP;
    const [x0, y0] = arcPoint(cx, cy, r - 8, a);
    const [x1, y1] = arcPoint(cx, cy, r + 8, a);
    this.needle.setAttribute('d', `M${x0.toFixed(2)} ${y0.toFixed(2)}L${x1.toFixed(2)} ${y1.toFixed(2)}`);
    setText(this.num, String(Math.round(score)));
    const g = gradeFor(score);
    setText(this.gradeText, g.label);
    if (this.lastIcon !== g.icon) {
      this.gradeIcon.replaceChildren(icon(g.icon, 16));
      this.lastIcon = g.icon;
    }
    this.grade.dataset.grade = g.key;
    this.gradeIcon.style.color = this.ramp.color(score);
  }
}

class MiniGauge {
  readonly el: HTMLElement;
  private readonly arc: SVGCircleElement;
  private readonly num: HTMLElement;
  private readonly C: number;

  constructor(private readonly ramp: Ramp) {
    const r = 18;
    this.C = 2 * Math.PI * r;
    const svg = svgEl('svg', { viewBox: '0 0 44 44', 'aria-hidden': 'true' });
    const track = svgEl('circle', { cx: 22, cy: 22, r, class: 'mini-track' });
    track.style.strokeDasharray = `${this.C * 0.75} ${this.C}`;
    this.arc = svgEl('circle', { cx: 22, cy: 22, r, class: 'mini-arc' });
    svg.append(track, this.arc);
    this.num = h('span', { class: 'mini-num mono' }, '–');
    this.el = h('div', { class: 'mini' }, svg, this.num, h('span', { class: 'mini-warn' }, icon('warn', 13)));
  }

  set(score: number | null): void {
    if (score === null) {
      this.arc.style.strokeDasharray = `0 ${this.C}`;
      setText(this.num, '–');
      return;
    }
    this.arc.style.strokeDasharray = `${Math.max(0.02, score / 100) * this.C * 0.75} ${this.C}`;
    this.arc.style.stroke = this.ramp.color(score);
    setText(this.num, String(Math.round(score)));
  }
}

class SubBar {
  readonly el: HTMLElement;
  private readonly val: HTMLElement;
  private readonly fill: HTMLElement;
  private readonly note: HTMLElement;
  private readonly bar: HTMLElement;

  constructor(private readonly ramp: Ramp, name: string, iconName: string, hint: string) {
    this.val = h('span', { class: 'sub-val mono' }, '–');
    this.fill = h('div', { class: 'bar-fill' });
    this.bar = h('div', { class: 'bar', role: 'img' }, this.fill, h('i', { class: 'bar-tick', style: `left:${LOW_SUPPORT}%` }));
    this.note = h('p', { class: 'sub-note' });
    this.el = h(
      'div',
      { class: 'sub' },
      h('div', { class: 'sub-top' }, h('span', { class: 'sub-name' }, icon(iconName, 16), name, h('span', { class: 'sub-hint' }, hint)), this.val),
      this.bar,
      this.note,
    );
  }

  set(score: number | null, strong: string, rest: string, label: string): void {
    if (score === null) {
      setText(this.val, '–');
      this.fill.style.width = '0%';
      this.el.classList.remove('low');
    } else {
      setText(this.val, String(Math.round(score)));
      this.fill.style.width = `${Math.max(1.5, score)}%`;
      this.fill.style.setProperty('--c', this.ramp.color(score));
      this.el.classList.toggle('low', score < LOW_SUPPORT);
    }
    this.bar.setAttribute('aria-label', label);
    this.note.replaceChildren(...(strong ? [h('strong', null, strong), rest ? ' · ' + rest : ''] : [rest]));
  }
}

export function buildLegend(ramp: Ramp, compact = false): HTMLElement {
  return h(
    'div',
    { class: 'legend' + (compact ? ' legend-compact' : ''), role: 'img', 'aria-label': `Data support colour scale from 0 (sparse) to 100 (well measured); areas below ${LOW_SUPPORT} are hatched` },
    h(
      'div',
      { class: 'legend-ramp' },
      h('div', { class: 'legend-grad', style: `background:${ramp.gradient()}` }),
      h('div', { class: 'legend-hatch', style: `width:${LOW_SUPPORT}%` }),
    ),
    h('div', { class: 'legend-scale mono' }, h('span', null, '0'), h('span', { style: `left:${LOW_SUPPORT}%` }, String(LOW_SUPPORT)), h('span', null, '100')),
    h('div', { class: 'legend-key' }, h('i', { class: 'swatch-hatch', style: `--c:${ramp.color(LOW_SUPPORT / 2)}` }), `Hatched: below ${LOW_SUPPORT} — sparse / inferred`),
  );
}

export class MeterPanel {
  readonly el: HTMLElement;
  /** Slot where the lighting control is docked on phones. */
  readonly lightingSlot: HTMLElement;
  private readonly gauge: Gauge;
  private readonly mini: MiniGauge;
  private readonly alt: SubBar;
  private readonly img: SubBar;
  private readonly toggle: HTMLButtonElement;
  private readonly clearBtn: HTMLButtonElement;
  private readonly kicker: HTMLElement;
  private readonly coords: HTMLElement;
  private readonly elev: HTMLElement;
  private readonly status: HTMLElement;
  private readonly statusIcon: HTMLElement;
  private readonly statusText: HTMLElement;
  private readonly overlaySwitch: HTMLButtonElement;
  private readonly legendWrap: HTMLElement;
  private readonly body: HTMLElement;
  private readonly vLat: HTMLElement;
  private readonly vLon: HTMLElement;
  private readonly vElev: HTMLElement;
  private readonly vNear: HTMLButtonElement;
  private readonly vAlt: HTMLElement;
  private readonly vRes: HTMLElement;
  private readonly scopeNote: HTMLElement;
  private open = false;
  private nearest: NearestFeature | null = null;
  private lastStatusIcon = '';

  constructor(private readonly ramp: Ramp, private readonly cb: MeterCallbacks) {
    this.gauge = new Gauge(ramp);
    this.mini = new MiniGauge(ramp);
    this.alt = new SubBar(ramp, 'Altimetry', 'laser', 'LOLA laser shots');
    this.img = new SubBar(ramp, 'Imagery', 'camera', 'sunlit optical coverage');

    const bodyId = nextId('meter-body');
    this.kicker = h('span', { class: 'kicker' }, 'View centre');
    this.coords = h('span', { class: 'head-coords mono' }, '—');
    this.elev = h('span', { class: 'head-elev mono' }, '');
    this.statusIcon = h('span', { class: 'status-icon' });
    this.statusText = h('span', null, 'Loading measurements…');
    this.status = h('span', { class: 'head-status' }, this.statusIcon, this.statusText);

    this.toggle = h(
      'button',
      { class: 'head-toggle', type: 'button', 'aria-expanded': 'false', 'aria-controls': bodyId },
      this.mini.el,
      h('span', { class: 'head-text' }, this.kicker, h('span', { class: 'head-line' }, this.coords, this.elev), this.status),
      h('span', { class: 'head-chevron' }, icon('chevron', 18)),
    );
    this.clearBtn = h('button', { class: 'icon-btn head-clear', type: 'button', 'aria-label': 'Clear selection', title: 'Clear selection', hidden: true, onclick: () => this.cb.onClearSelection() }, icon('close', 16));

    const handle = h('div', { class: 'sheet-handle', 'aria-hidden': 'true' }, h('i'));
    const head = h('div', { class: 'panel-head' }, this.toggle, this.clearBtn);

    this.overlaySwitch = h(
      'button',
      { class: 'switch-row', type: 'button', role: 'switch', 'aria-checked': 'false', onclick: () => this.cb.onOverlay(this.overlaySwitch.getAttribute('aria-checked') !== 'true') },
      h('span', { class: 'switch-label' }, icon('layers', 18), 'Show data support on globe'),
      h('span', { class: 'switch', 'aria-hidden': 'true' }, h('i')),
    );
    this.legendWrap = h('div', { class: 'legend-wrap', hidden: true }, buildLegend(ramp));

    this.vLat = h('dd', { class: 'mono' }, '—');
    this.vLon = h('dd', { class: 'mono' }, '—');
    this.vElev = h('dd', { class: 'mono' }, '—');
    this.vAlt = h('dd', { class: 'mono' }, '—');
    this.vRes = h('dd', { class: 'mono' }, '—');
    this.vNear = h('button', { class: 'link-btn', type: 'button', onclick: () => this.nearest && this.cb.onGoToNearest(this.nearest) }, '—');
    this.scopeNote = h('p', { class: 'scope-note' }, '');

    this.body = h(
      'div',
      { class: 'panel-body', id: bodyId },
      h(
        'div',
        { class: 'panel-body-inner' },
        h('div', { class: 'panel-scroll' },
          h('h2', { class: 'section-label' }, 'Data support'),
          this.gauge.el,
          this.scopeNote,
          h('div', { class: 'subs' }, this.alt.el, this.img.el),
          this.overlaySwitch,
          this.legendWrap,
          h('h2', { class: 'section-label' }, 'Readout'),
          h(
            'dl',
            { class: 'readout' },
            h('div', null, h('dt', null, 'Latitude'), this.vLat),
            h('div', null, h('dt', null, 'Longitude'), this.vLon),
            h('div', null, h('dt', null, 'Elevation'), this.vElev),
            h('div', null, h('dt', null, 'Camera altitude'), this.vAlt),
            h('div', { class: 'wide' }, h('dt', null, 'Nearest named feature'), h('dd', null, this.vNear)),
            h('div', { class: 'wide' }, h('dt', null, 'Ground resolution'), this.vRes),
          ),
          h('button', { class: 'text-btn', type: 'button', onclick: () => this.cb.onAbout() }, icon('info', 16), 'How this score is calculated'),
        ),
      ),
    );

    this.lightingSlot = h('div', { class: 'lighting-slot' });
    this.el = h('aside', { class: 'panel', 'aria-label': 'Data support and position readout' }, handle, head, this.body, this.lightingSlot);

    this.toggle.addEventListener('click', () => {
      if (this.suppressClick) {
        this.suppressClick = false;
        return;
      }
      this.setOpen(!this.open);
    });
    this.bindDrag(handle);
    this.bindDrag(head);
  }

  private suppressClick = false;

  /** Swipe up / down on the handle or header to open / close (phones). */
  private bindDrag(target: HTMLElement): void {
    let startY = 0;
    let active = false;
    target.addEventListener('pointerdown', (e) => {
      if (e.pointerType === 'mouse') return;
      active = true;
      startY = e.clientY;
    });
    target.addEventListener('pointermove', (e) => {
      if (!active) return;
      const dy = e.clientY - startY;
      if (Math.abs(dy) > 28) {
        active = false;
        this.suppressClick = true;
        window.setTimeout(() => (this.suppressClick = false), 350);
        this.setOpen(dy < 0);
      }
    });
    const end = () => (active = false);
    target.addEventListener('pointerup', end);
    target.addEventListener('pointercancel', end);
    if (target.classList.contains('sheet-handle')) target.addEventListener('click', () => this.setOpen(!this.open));
  }

  get isOpen(): boolean {
    return this.open;
  }

  setOpen(open: boolean): void {
    this.open = open;
    this.el.classList.toggle('open', open);
    this.toggle.setAttribute('aria-expanded', String(open));
    this.body.toggleAttribute('inert', !open);
  }

  setOverlay(on: boolean): void {
    this.overlaySwitch.setAttribute('aria-checked', String(on));
    this.legendWrap.hidden = !on;
  }

  updateView(v: ViewState): void {
    setText(this.vAlt, formatAltitude(v.altitudeKm));
    setText(this.vRes, formatResolution(v.metersPerPixel));
  }

  update(p: PointInfo): void {
    const selected = p.source === 'selection';
    this.el.classList.toggle('has-selection', selected);
    this.clearBtn.hidden = !selected;
    setText(this.kicker, selected ? (p.name ? p.name : 'Selected point') : 'View centre');
    this.kicker.title = p.detail ?? '';
    setText(this.coords, `${formatLat(p.pos.lat)}, ${formatLon(p.pos.lon)}`);
    setText(this.elev, p.elevation === null ? '' : formatElevation(p.elevation));
    setText(this.vLat, formatLat(p.pos.lat, 3));
    setText(this.vLon, formatLon(p.pos.lon, 3));
    setText(this.vElev, p.elevation === null ? (p.data === 'loading' ? 'Loading…' : 'Unavailable') : formatElevation(p.elevation));

    this.nearest = p.nearest;
    if (p.nearest) {
      const f = p.nearest.feature;
      const where = p.nearest.inside ? `Inside ${f.name}` : `${f.name}, ${formatDistanceKm(p.nearest.centerKm)} away`;
      setText(this.vNear, `${where} (${featureTypeLabel(f).toLowerCase()}, ${formatDistanceKm(f.diameterKm)} across)`);
      this.vNear.disabled = false;
    } else {
      setText(this.vNear, '—');
      this.vNear.disabled = true;
    }

    const c = p.conf;
    const score = c ? c.combined : null;
    const low = score !== null && score < LOW_SUPPORT;
    this.el.classList.toggle('is-low', low);
    this.mini.set(score);
    this.gauge.set(score, p.data === 'loading' ? 'Loading measurements…' : 'Score unavailable');
    setText(
      this.scopeNote,
      selected ? (p.name ? `${p.name}${p.detail ? ' — ' + p.detail : ''}` : 'For the selected point') : 'For the centre of the view — tap the Moon to inspect a point',
    );

    // Collapsed status line: grade + where.
    let near = '';
    if (!p.name && p.nearest) near = p.nearest.inside ? p.nearest.feature.name : `near ${p.nearest.feature.name}`;
    else if (p.name && p.detail) near = p.detail;
    if (score === null) {
      setText(this.statusText, p.data === 'loading' ? 'Loading measurements…' : near || 'Data support unavailable');
      this.statusIcon.replaceChildren();
      this.lastStatusIcon = '';
    } else {
      const g = gradeFor(score);
      setText(this.statusText, near ? `${g.label} · ${near}` : g.label);
      if (this.lastStatusIcon !== g.icon) {
        this.statusIcon.replaceChildren(icon(g.icon, 14));
        this.lastStatusIcon = g.icon;
      }
      this.statusIcon.style.color = this.ramp.color(score);
    }
    const what = selected ? (p.name ?? 'selected point') : 'view centre';
    this.toggle.setAttribute(
      'aria-label',
      `Data support for ${what}: ${score === null ? 'not available' : `${Math.round(score)} out of 100, ${gradeFor(score).label}`}. ${formatLat(p.pos.lat)}, ${formatLon(p.pos.lon)}${
        p.elevation === null ? '' : ', elevation ' + formatElevation(p.elevation)
      }. ${this.open ? 'Collapse' : 'Expand'} details.`,
    );

    // Altimetry
    if (!c) {
      this.alt.set(null, '', p.data === 'loading' ? 'Loading…' : 'Unavailable', 'Altimetry score unavailable');
      this.img.set(null, '', p.data === 'loading' ? 'Loading…' : 'Unavailable', 'Imagery score unavailable');
      return;
    }
    const cell = isFinite(p.cellKm) ? ` in this ${p.cellKm < 1 ? Math.round(p.cellKm * 1000) + ' m' : p.cellKm.toFixed(1) + ' km'} cell` : ' in this cell';
    let aStrong: string;
    let aRest: string;
    if (p.shots === null) {
      aStrong = c.altimetry >= LOW_SUPPORT ? 'Measured' : 'Interpolated between tracks';
      aRest = 'shot count unavailable';
    } else if (p.shots > 0) {
      aStrong = 'Measured';
      aRest = `${formatInt(p.shots)} LOLA laser shot${p.shots === 1 ? '' : 's'}${cell}`;
    } else {
      aStrong = 'Interpolated between tracks';
      aRest = `no LOLA shots${cell}`;
    }
    this.alt.set(c.altimetry, aStrong, aRest, `Altimetry support ${Math.round(c.altimetry)} out of 100`);

    let iStrong: string;
    let iRest: string;
    const polar = Math.abs(p.pos.lat) >= 78;
    if (c.imagery >= 80) {
      iStrong = 'Well lit';
      iRest = 'good sunlit optical coverage';
    } else if (c.imagery >= LOW_SUPPORT) {
      iStrong = polar ? 'Low sun' : 'Fair';
      iRest = polar ? 'grazing polar light, long shadows' : 'usable sunlit coverage, some shadowing';
    } else if (polar) {
      iStrong = 'Shadowed';
      iRest = 'permanently shadowed or grazing polar light — little or no sunlit imagery';
    } else {
      iStrong = 'Poor';
      iRest = 'little usable sunlit imagery here';
    }
    this.img.set(c.imagery, iStrong, iRest, `Imagery support ${Math.round(c.imagery)} out of 100`);
  }
}
