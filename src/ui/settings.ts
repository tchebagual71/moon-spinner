import type { QualityTier, ViewState } from '../types';
import type { QualityChoice } from '../data/quality';
import { h, nextId, setText } from './dom';
import { icon } from './icons';

export interface SettingsState {
  labels: boolean;
  sites: boolean;
  autoRotate: boolean;
  overlay: boolean;
  relief: number;
}

export interface SettingsCallbacks {
  onChange<K extends keyof SettingsState>(key: K, value: SettingsState[K]): void;
  onResetView(): void;
  onQuality(tier: QualityTier | null): void;
  onAbout(): void;
}

const TILE_TEXT: Record<ViewState['tiles'], string> = {
  off: 'standing by — zoom in to stream',
  loading: 'loading…',
  active: 'active',
  unavailable: 'unavailable — showing global mosaic',
};

export function tilesLabel(t: ViewState['tiles']): string {
  return `NASA 100 m imagery: ${TILE_TEXT[t]}`;
}

function reliefLabel(v: number): string {
  return v <= 1 ? 'True scale' : `${v % 1 ? v.toFixed(1) : v}× exaggerated`;
}

export class SettingsPanel {
  readonly el: HTMLElement;
  readonly button: HTMLButtonElement;
  private readonly switches = new Map<string, HTMLButtonElement>();
  private readonly relief: HTMLInputElement;
  private readonly reliefOut: HTMLElement;
  private readonly tiles: HTMLElement;
  private readonly fsBtn: HTMLButtonElement;
  private isOpen = false;

  constructor(state: SettingsState, quality: QualityChoice, private readonly cb: SettingsCallbacks) {
    const id = nextId('settings');
    this.button = h('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Settings', title: 'Settings', 'aria-expanded': 'false', 'aria-controls': id, onclick: () => this.toggle() }, icon('sliders'));

    const sw = (key: 'labels' | 'sites' | 'autoRotate' | 'overlay', label: string, ic: string): HTMLButtonElement => {
      const b = h(
        'button',
        { type: 'button', class: 'switch-row', role: 'switch', 'aria-checked': String(state[key]), onclick: () => this.cb.onChange(key, b.getAttribute('aria-checked') !== 'true') },
        h('span', { class: 'switch-label' }, icon(ic, 18), label),
        h('span', { class: 'switch', 'aria-hidden': 'true' }, h('i')),
      );
      this.switches.set(key, b);
      return b;
    };

    this.reliefOut = h('output', { class: 'mono' }, reliefLabel(state.relief));
    this.relief = h('input', { type: 'range', class: 'range', min: 1, max: 10, step: 0.5, value: state.relief, 'aria-label': 'Relief exaggeration' });
    this.relief.addEventListener('input', () => {
      const v = Number(this.relief.value);
      this.syncRelief(v);
      this.cb.onChange('relief', v);
    });

    const qSeg = h('div', { class: 'seg seg-small', role: 'radiogroup', 'aria-label': 'Rendering quality' });
    const tiers: [QualityTier | null, string][] = [[null, 'Auto'], ['low', 'Low'], ['medium', 'Medium'], ['high', 'High']];
    for (const [tier, label] of tiers) {
      const on = tier === null ? quality.source === 'auto' : quality.source !== 'auto' && quality.tier === tier;
      qSeg.append(
        h('button', { type: 'button', class: 'seg-btn', role: 'radio', 'aria-checked': String(on), title: tier === null ? `Automatic (${quality.auto} on this device)` : `${label} detail`, onclick: () => { if (!on) this.cb.onQuality(tier); } }, label),
      );
    }

    this.tiles = h('p', { class: 'tiles-line' }, '');
    const canFs = !!document.documentElement.requestFullscreen && document.fullscreenEnabled !== false;
    this.fsBtn = h('button', { type: 'button', class: 'btn', hidden: !canFs, onclick: () => this.fullscreen() }, icon('expand', 16), 'Fullscreen');
    document.addEventListener('fullscreenchange', () => setText(this.fsBtn.lastChild as unknown as Element, document.fullscreenElement ? 'Exit fullscreen' : 'Fullscreen'));

    this.el = h(
      'div',
      { class: 'popover settings', id, hidden: true, role: 'dialog', 'aria-label': 'Settings' },
      h('div', { class: 'pop-scroll' },
        h('h2', { class: 'section-label' }, 'Display'),
        sw('labels', 'Feature labels', 'pin'),
        sw('sites', 'Landing sites', 'flag'),
        sw('overlay', 'Data support on globe', 'layers'),
        sw('autoRotate', 'Auto-rotate', 'reset'),
        h('h2', { class: 'section-label' }, 'Relief'),
        h('div', { class: 'range-row range-labelled' }, this.relief, this.reliefOut),
        h('p', { class: 'fine' }, 'Lunar relief is subtle at true scale; exaggeration multiplies real elevations.'),
        h('h2', { class: 'section-label' }, 'Quality'),
        qSeg,
        h('p', { class: 'fine' }, `Currently ${quality.tier}${quality.source === 'auto' ? ' (auto-detected)' : ''}. Changing it reloads the view.`),
        this.tiles,
        h('div', { class: 'btn-row' },
          h('button', { type: 'button', class: 'btn', onclick: () => this.cb.onResetView() }, icon('reset', 16), 'Reset view'),
          this.fsBtn,
        ),
        h('button', { type: 'button', class: 'text-btn', onclick: () => { this.close(); this.cb.onAbout(); } }, icon('info', 16), 'About the data'),
      ),
    );
    this.syncRelief(state.relief);

    document.addEventListener('pointerdown', (e) => {
      if (!this.isOpen) return;
      const t = e.target as Node;
      if (!this.el.contains(t) && !this.button.contains(t)) this.close();
    });
    this.el.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        this.close();
        this.button.focus();
      }
    });
  }

  get opened(): boolean {
    return this.isOpen;
  }

  private syncRelief(v: number): void {
    setText(this.reliefOut, reliefLabel(v));
    this.relief.setAttribute('aria-valuetext', reliefLabel(v));
    this.relief.style.setProperty('--a', '0%');
    this.relief.style.setProperty('--b', `${((v - 1) / 9) * 100}%`);
  }

  private fullscreen(): void {
    if (document.fullscreenElement) void document.exitFullscreen();
    else void document.documentElement.requestFullscreen().catch(() => undefined);
  }

  set<K extends keyof SettingsState>(key: K, value: SettingsState[K]): void {
    if (key === 'relief') {
      this.relief.value = String(value);
      this.syncRelief(value as number);
    } else this.switches.get(key)?.setAttribute('aria-checked', String(value));
  }

  setTiles(t: ViewState['tiles']): void {
    setText(this.tiles, tilesLabel(t));
    this.tiles.dataset.state = t;
  }

  toggle(): void {
    if (this.isOpen) this.close();
    else this.open();
  }

  open(): void {
    this.isOpen = true;
    this.el.hidden = false;
    this.button.setAttribute('aria-expanded', 'true');
    (this.el.querySelector('button, input') as HTMLElement | null)?.focus({ preventScroll: true });
  }

  close(): void {
    this.isOpen = false;
    this.el.hidden = true;
    this.button.setAttribute('aria-expanded', 'false');
  }
}
