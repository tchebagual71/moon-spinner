import type { Places, Place } from '../data/places';
import { featureTypeLabel, siteKindLabel } from '../data/places';
import { formatDistanceKm, formatLatLon } from '../data/geo';
import { h, nextId } from './dom';
import { icon } from './icons';

export interface QuickPlace {
  label: string;
  resolve(places: Places): { place?: Place; lat: number; lon: number; altitudeKm: number; name: string; detail?: string };
}

export interface SearchCallbacks {
  onPlace(place: Place): void;
  onQuick(q: QuickPlace): void;
}

export function placeDetail(p: Place): string {
  if (p.kind === 'feature') return `${featureTypeLabel(p.feature)} · ${formatDistanceKm(p.feature.diameterKm)}`;
  return `${siteKindLabel(p.site)} · ${p.site.agency} ${p.site.year}`;
}

export class SearchBox {
  readonly el: HTMLElement;
  private readonly input: HTMLInputElement;
  private readonly list: HTMLElement;
  private readonly pop: HTMLElement;
  private readonly clearBtn: HTMLButtonElement;
  private readonly chips: HTMLElement;
  private readonly empty: HTMLElement;
  private results: Place[] = [];
  private active = -1;
  private isOpen = false;
  private readonly listId = nextId('results');

  constructor(private readonly places: Places, quick: QuickPlace[], compact: boolean, private readonly cb: SearchCallbacks) {
    const hasData = places.features.length + places.sites.length > 0;
    this.input = h('input', {
      type: 'search', class: 'search-input', placeholder: !hasData ? 'Search unavailable' : compact ? 'Search the Moon' : 'Search craters, maria, landing sites',
      autocomplete: 'off', autocorrect: 'off', autocapitalize: 'off', spellcheck: 'false', enterkeyhint: 'search',
      role: 'combobox', 'aria-expanded': 'false', 'aria-controls': this.listId, 'aria-autocomplete': 'list', 'aria-label': 'Search lunar features and landing sites',
    });
    this.clearBtn = h('button', { type: 'button', class: 'icon-btn search-clear', 'aria-label': 'Clear search', hidden: true, onclick: () => { this.input.value = ''; this.refresh(); this.input.focus(); } }, icon('close', 16));
    this.list = h('ul', { class: 'results', id: this.listId, role: 'listbox', 'aria-label': 'Search results' });
    this.empty = h('p', { class: 'results-empty', hidden: true }, 'No matching features');
    this.chips = h('div', { class: 'chips' });
    for (const q of quick) {
      this.chips.append(h('button', { type: 'button', class: 'chip', onclick: () => { this.close(true); this.cb.onQuick(q); } }, q.label));
    }
    this.pop = h('div', { class: 'search-pop', hidden: true }, h('div', { class: 'chips-wrap' }, h('h2', { class: 'section-label' }, 'Famous places'), this.chips), this.list, this.empty);
    this.el = h('div', { class: 'search', role: 'search' }, h('label', { class: 'search-field' }, h('span', { class: 'search-icon' }, icon('search', 18)), this.input, this.clearBtn), this.pop);

    this.input.addEventListener('input', () => this.refresh());
    this.input.addEventListener('focus', () => this.open());
    this.input.addEventListener('keydown', (e) => this.onKey(e));
    document.addEventListener('pointerdown', (e) => {
      if (this.isOpen && !this.el.contains(e.target as Node)) this.close(false);
    });
    this.el.addEventListener('focusout', (e) => {
      const to = (e as FocusEvent).relatedTarget as Node | null;
      if (to && !this.el.contains(to)) this.close(false);
    });
  }

  focus(): void {
    this.input.focus();
    this.input.select();
  }

  get opened(): boolean {
    return this.isOpen;
  }

  private open(): void {
    this.isOpen = true;
    this.pop.hidden = false;
    this.input.setAttribute('aria-expanded', 'true');
    this.el.classList.add('open');
    this.refresh();
  }

  close(blur: boolean): void {
    this.isOpen = false;
    this.pop.hidden = true;
    this.input.setAttribute('aria-expanded', 'false');
    this.input.removeAttribute('aria-activedescendant');
    this.el.classList.remove('open');
    if (blur) this.input.blur();
  }

  private refresh(): void {
    const q = this.input.value.trim();
    this.clearBtn.hidden = !this.input.value;
    this.results = q ? this.places.search(q, 8) : [];
    this.active = this.results.length ? 0 : -1;
    (this.chips.parentElement as HTMLElement).hidden = !!q;
    this.empty.hidden = !q || this.results.length > 0;
    this.list.hidden = !this.results.length;
    this.list.replaceChildren(
      ...this.results.map((p, i) =>
        h(
          'li',
          {
            id: `${this.listId}-${i}`, role: 'option', class: 'result', 'aria-selected': String(i === this.active),
            onpointerdown: (e: Event) => e.preventDefault(),
            onclick: () => this.choose(i),
          },
          h('span', { class: 'result-icon' }, icon(p.kind === 'site' ? 'flag' : 'pin', 16)),
          h('span', { class: 'result-main' }, h('span', { class: 'result-name' }, p.name), h('span', { class: 'result-sub' }, placeDetail(p))),
          h('span', { class: 'result-coords mono' }, formatLatLon(p, 1)),
        ),
      ),
    );
    this.syncActive();
  }

  private syncActive(): void {
    Array.from(this.list.children).forEach((li, i) => li.setAttribute('aria-selected', String(i === this.active)));
    if (this.active >= 0) {
      this.input.setAttribute('aria-activedescendant', `${this.listId}-${this.active}`);
      this.list.children[this.active]?.scrollIntoView({ block: 'nearest' });
    } else this.input.removeAttribute('aria-activedescendant');
  }

  private choose(i: number): void {
    const p = this.results[i];
    if (!p) return;
    this.input.value = p.name;
    this.clearBtn.hidden = false;
    this.close(true);
    this.cb.onPlace(p);
  }

  private onKey(e: KeyboardEvent): void {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      if (!this.isOpen) this.open();
      if (!this.results.length) return;
      e.preventDefault();
      const n = this.results.length;
      this.active = (this.active + (e.key === 'ArrowDown' ? 1 : n - 1)) % n;
      this.syncActive();
    } else if (e.key === 'Enter') {
      if (this.active >= 0) {
        e.preventDefault();
        this.choose(this.active);
      }
    } else if (e.key === 'Escape') {
      e.stopPropagation();
      if (this.input.value) {
        this.input.value = '';
        this.refresh();
      } else this.close(true);
    }
  }
}
