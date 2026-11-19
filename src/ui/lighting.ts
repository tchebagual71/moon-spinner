import type { LightingMode } from '../types';
import { phaseAt, type PhaseInfo } from '../data/phase';
import { formatLat, formatLon } from '../data/geo';
import { h, nextId, setText } from './dom';
import { icon } from './icons';

export type LightingHandler = (mode: LightingMode, opts?: { date?: Date; sunLon?: number; sunLat?: number }) => void;

const HOUR = 3600_000;
const RANGE_HOURS = 15 * 24;

const dateFmt = new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });

function offsetLabel(hours: number): string {
  if (hours === 0) return 'Live';
  const sign = hours < 0 ? '−' : '+';
  const a = Math.abs(hours);
  const d = Math.floor(a / 24);
  const hr = a % 24;
  return `${sign}${d ? d + ' d' : ''}${d && hr ? ' ' : ''}${hr || !d ? hr + ' h' : ''}`;
}

/** Small disc showing the lit portion as seen from Earth (north up). */
function phaseGlyph(): { el: SVGSVGElement; set(p: PhaseInfo): void } {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', '22');
  svg.setAttribute('height', '22');
  svg.setAttribute('aria-hidden', 'true');
  svg.classList.add('phase-glyph');
  const disc = document.createElementNS(ns, 'circle');
  disc.setAttribute('cx', '12');
  disc.setAttribute('cy', '12');
  disc.setAttribute('r', '9');
  disc.setAttribute('class', 'phase-dark');
  const lit = document.createElementNS(ns, 'path');
  lit.setAttribute('class', 'phase-lit');
  svg.append(disc, lit);
  return {
    el: svg,
    set(p) {
      const r = 9;
      const waxing = p.elongation < 180;
      // Terminator is a half-ellipse whose x-radius follows the illuminated fraction.
      const k = Math.cos((p.elongation * Math.PI) / 180); // +1 new .. -1 full
      const rx = Math.abs(k) * r;
      const limbSweep = waxing ? 1 : 0;
      const termSweep = k > 0 ? (waxing ? 0 : 1) : waxing ? 1 : 0;
      lit.setAttribute('d', `M12 3A${r} ${r} 0 0 ${limbSweep} 12 21A${rx.toFixed(2)} ${r} 0 0 ${termSweep} 12 3Z`);
    },
  };
}

export class LightingControl {
  readonly el: HTMLElement;
  private mode: LightingMode = 'realtime';
  private offsetHours = 0;
  private sunLon = 0;
  private sunLat = 0;
  private sunTouched = false;
  private readonly radios = new Map<LightingMode, HTMLButtonElement>();
  private readonly panes = new Map<LightingMode, HTMLElement>();
  private readonly phaseName: HTMLElement;
  private readonly phaseDate: HTMLElement;
  private readonly timeSlider: HTMLInputElement;
  private readonly nowBtn: HTMLButtonElement;
  private readonly glyph = phaseGlyph();
  private readonly lonSlider: HTMLInputElement;
  private readonly latSlider: HTMLInputElement;
  private readonly lonOut: HTMLElement;
  private readonly latOut: HTMLElement;
  private timer = 0;

  constructor(private readonly apply: LightingHandler) {
    const seg = h('div', { class: 'seg', role: 'radiogroup', 'aria-label': 'Lighting mode' });
    const modes: [LightingMode, string, string][] = [
      ['realtime', 'Now', "Real Sun position for a chosen date"],
      ['manual', 'Sun', 'Place the Sun yourself'],
      ['full', 'Full light', 'Even light with no shadows'],
    ];
    for (const [mode, label, title] of modes) {
      const b = h('button', { type: 'button', role: 'radio', class: 'seg-btn', title, 'aria-checked': 'false', onclick: () => this.setMode(mode) }, label);
      this.radios.set(mode, b);
      seg.append(b);
    }
    seg.addEventListener('keydown', (e) => {
      const order: LightingMode[] = ['realtime', 'manual', 'full'];
      const i = order.indexOf(this.mode);
      let n = -1;
      if (e.key === 'ArrowRight' || e.key === 'ArrowDown') n = (i + 1) % 3;
      else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') n = (i + 2) % 3;
      if (n < 0) return;
      e.preventDefault();
      this.setMode(order[n]);
      this.radios.get(order[n])?.focus();
    });

    // --- Now
    this.phaseName = h('span', { class: 'phase-name' }, '');
    this.phaseDate = h('span', { class: 'phase-date mono' }, '');
    const timeId = nextId('time');
    this.timeSlider = h('input', {
      id: timeId, type: 'range', class: 'range', min: -RANGE_HOURS, max: RANGE_HOURS, step: 1, value: 0,
      'aria-label': 'Date and time, up to 15 days before or after now',
    });
    this.timeSlider.addEventListener('input', () => {
      this.offsetHours = Number(this.timeSlider.value);
      this.push();
    });
    this.nowBtn = h('button', { type: 'button', class: 'chip-btn', title: 'Return to the present moment', onclick: () => this.resetNow() }, icon('clock', 15), 'Now');
    const nowPane = h(
      'div',
      { class: 'light-pane' },
      h('div', { class: 'light-info' }, this.glyph.el, this.phaseName, this.phaseDate),
      h('div', { class: 'range-row' }, h('span', { class: 'range-end mono', 'aria-hidden': 'true' }, '−15 d'), this.timeSlider, h('span', { class: 'range-end mono', 'aria-hidden': 'true' }, '+15 d'), this.nowBtn),
    );

    // --- Sun
    this.lonOut = h('output', { class: 'mono' }, '');
    this.latOut = h('output', { class: 'mono' }, '');
    this.lonSlider = h('input', { type: 'range', class: 'range', min: -180, max: 180, step: 1, value: 0, 'aria-label': 'Sun longitude' });
    this.latSlider = h('input', { type: 'range', class: 'range', min: -90, max: 90, step: 1, value: 0, 'aria-label': 'Sun latitude' });
    this.lonSlider.addEventListener('input', () => {
      this.sunLon = Number(this.lonSlider.value);
      this.sunTouched = true;
      this.push();
    });
    this.latSlider.addEventListener('input', () => {
      this.sunLat = Number(this.latSlider.value);
      this.sunTouched = true;
      this.push();
    });
    const sunPane = h(
      'div',
      { class: 'light-pane' },
      h('div', { class: 'range-row' }, h('span', { class: 'range-name' }, icon('sun', 16), 'Longitude'), this.lonSlider, this.lonOut),
      h('div', { class: 'range-row sun-lat' }, h('span', { class: 'range-name' }, h('span', { class: 'range-name-pad' }), 'Latitude'), this.latSlider, this.latOut),
    );

    // --- Full
    const fullPane = h('div', { class: 'light-pane' }, h('p', { class: 'light-note' }, 'Even light, no shadows. Useful for reading albedo — not a real lighting condition.'));

    this.panes.set('realtime', nowPane);
    this.panes.set('manual', sunPane);
    this.panes.set('full', fullPane);
    this.el = h('section', { class: 'lighting', 'aria-label': 'Lighting' }, seg, nowPane, sunPane, fullPane);
    this.render();
  }

  /** Apply the current state to the renderer and start the live clock. */
  start(): void {
    this.push();
    window.clearInterval(this.timer);
    this.timer = window.setInterval(() => {
      if (this.mode === 'realtime' && !document.hidden) this.push();
    }, 60_000);
  }

  stop(): void {
    window.clearInterval(this.timer);
  }

  private date(): Date {
    return new Date(Date.now() + this.offsetHours * HOUR);
  }

  private resetNow(): void {
    this.offsetHours = 0;
    this.timeSlider.value = '0';
    this.push();
  }

  private setMode(mode: LightingMode): void {
    if (mode === 'manual' && !this.sunTouched) {
      // Start from the real Sun so switching modes is continuous.
      this.sunLon = Math.round(phaseAt(this.date()).sunLon);
      this.sunLat = 0;
    }
    this.mode = mode;
    this.push();
  }

  private push(): void {
    this.render();
    if (this.mode === 'realtime') this.apply('realtime', { date: this.date() });
    else if (this.mode === 'manual') this.apply('manual', { sunLon: this.sunLon, sunLat: this.sunLat });
    else this.apply('full');
  }

  private render(): void {
    for (const [m, b] of this.radios) {
      const on = m === this.mode;
      b.setAttribute('aria-checked', String(on));
      b.tabIndex = on ? 0 : -1;
    }
    for (const [m, p] of this.panes) p.hidden = m !== this.mode;
    this.el.dataset.mode = this.mode;
    if (this.mode === 'realtime') {
      const d = this.date();
      const p = phaseAt(d);
      this.glyph.set(p);
      setText(this.phaseName, `${p.name} · ${Math.round(p.fraction * 100)}% lit`);
      setText(this.phaseDate, dateFmt.format(d));
      const off = offsetLabel(this.offsetHours);
      this.timeSlider.setAttribute('aria-valuetext', `${dateFmt.format(d)} (${off}), ${p.name}`);
      this.nowBtn.disabled = this.offsetHours === 0;
      this.el.classList.toggle('is-live', this.offsetHours === 0);
      this.setFill(this.timeSlider);
    } else if (this.mode === 'manual') {
      this.lonSlider.value = String(this.sunLon);
      this.latSlider.value = String(this.sunLat);
      setText(this.lonOut, formatLon(this.sunLon, 0));
      setText(this.latOut, formatLat(this.sunLat, 0));
      this.lonSlider.setAttribute('aria-valuetext', `Sun overhead at ${formatLon(this.sunLon, 0)}`);
      this.latSlider.setAttribute('aria-valuetext', `Sun overhead at ${formatLat(this.sunLat, 0)}`);
      this.setFill(this.lonSlider);
      this.setFill(this.latSlider);
    }
  }

  /** Centre-origin fill for bipolar sliders. */
  private setFill(input: HTMLInputElement): void {
    const min = Number(input.min);
    const max = Number(input.max);
    const t = (Number(input.value) - min) / (max - min);
    input.style.setProperty('--a', `${Math.min(t, 0.5) * 100}%`);
    input.style.setProperty('--b', `${Math.max(t, 0.5) * 100}%`);
  }
}
