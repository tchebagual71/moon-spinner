import type { Manifest } from '../types';
import { h } from './dom';
import { icon } from './icons';
import { buildLegend } from './meter';
import type { Ramp } from './ramp';

function safeUrl(url: string): string | null {
  try {
    const u = new URL(url, location.href);
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.href : null;
  } catch {
    return null;
  }
}

const CREDITS = [
  'NASA / GSFC / Arizona State University — Lunar Reconnaissance Orbiter Camera (LROC)',
  'NASA Scientific Visualization Studio (SVS)',
  'LOLA Science Team, NASA GSFC — Lunar Orbiter Laser Altimeter',
  'NASA Moon Trek / JPL — streamed high-resolution imagery',
  'IAU / USGS Gazetteer of Planetary Nomenclature — feature names',
];

export class AboutDialog {
  readonly el: HTMLDialogElement;

  constructor(manifest: Manifest, ramp: Ramp) {
    const m = manifest.confidenceMethod;
    const generated = manifest.generated ? new Date(manifest.generated) : null;
    const sources = (manifest.sources ?? []).map((s) => {
      const href = safeUrl(s.url);
      return h(
        'li',
        { class: 'source' },
        h('div', { class: 'source-provider' }, s.provider),
        href
          ? h('a', { class: 'source-title', href, target: '_blank', rel: 'noopener noreferrer' }, s.title, icon('external', 14))
          : h('span', { class: 'source-title' }, s.title),
        s.note ? h('p', { class: 'source-note' }, s.note) : null,
      );
    });

    const close = h('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Close', onclick: () => this.el.close() }, icon('close'));
    this.el = h(
      'dialog',
      { class: 'about', 'aria-labelledby': 'about-title' },
      h('header', { class: 'about-head' }, h('h1', { id: 'about-title' }, 'About the data'), close),
      h(
        'div',
        { class: 'about-body' },
        h('p', { class: 'lede' }, 'Everything you see is built from real spacecraft measurements of the Moon — mostly from NASA’s Lunar Reconnaissance Orbiter. Nothing is painted in or invented; where measurements are thin, this app tells you.'),

        h('h2', { class: 'section-label' }, 'The data-support score'),
        h(
          'div',
          { class: 'callout' },
          icon('info', 18),
          h('p', null, h('strong', null, 'This is not an official NASA metric.'), ' The 0–100 data-support score is an index computed by this app from real coverage products, to show how directly each place has been measured. Treat it as a guide, not a certified uncertainty.'),
        ),
        m
          ? h(
              'dl',
              { class: 'method' },
              h('div', null, h('dt', null, icon('laser', 16), 'Altimetry'), h('dd', null, m.altimetry)),
              h('div', null, h('dt', null, icon('camera', 16), 'Imagery'), h('dd', null, m.imagery)),
              h('div', null, h('dt', null, icon('layers', 16), 'Combined'), h('dd', null, m.combined)),
            )
          : null,
        buildLegend(ramp),
        h('ul', { class: 'grades' },
          h('li', null, h('b', { class: 'mono' }, '80–100'), 'Well measured'),
          h('li', null, h('b', { class: 'mono' }, '60–79'), 'Mostly measured'),
          h('li', null, h('b', { class: 'mono' }, '40–59'), 'Partly interpolated'),
          h('li', null, h('b', { class: 'mono' }, '0–39'), 'Sparse / inferred (hatched on the globe)'),
        ),

        h('h2', { class: 'section-label' }, 'Sources'),
        sources.length ? h('ul', { class: 'sources' }, ...sources) : h('p', { class: 'fine' }, 'Source list unavailable.'),

        h('h2', { class: 'section-label' }, 'Notes'),
        h('ul', { class: 'notes' },
          h('li', null, 'Coordinates are selenographic (mean-Earth / polar-axis frame), east-positive. Elevation is relative to a 1,737.4 km sphere.'),
          h('li', null, 'Elevation readouts are sampled from a reduced-resolution copy of the LOLA elevation model, so small craters may be smoothed.'),
          h('li', null, '“Now” lighting uses the real Sun direction for the chosen date; phase name and illuminated fraction are computed in your browser.'),
        ),

        h('h2', { class: 'section-label' }, 'Credits'),
        h('ul', { class: 'credits' }, ...CREDITS.map((c) => h('li', null, c))),
        generated && !isNaN(generated.getTime()) ? h('p', { class: 'fine' }, `Data package generated ${generated.toISOString().slice(0, 10)}.`) : null,
      ),
    );
    // Click on the backdrop closes.
    this.el.addEventListener('click', (e) => {
      if (e.target === this.el) this.el.close();
    });
  }

  open(): void {
    if (!this.el.open) this.el.showModal();
    this.el.querySelector('.about-body')?.scrollTo(0, 0);
  }
}
