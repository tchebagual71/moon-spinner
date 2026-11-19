import { h, setText } from './dom';
import { icon } from './icons';

/** Loading / error veil shown over the canvas during boot. */
export class BootScreen {
  readonly el: HTMLElement;
  private readonly bar: HTMLElement;
  private readonly progress: HTMLElement;
  private readonly label: HTMLElement;
  private readonly loading: HTMLElement;
  private readonly error: HTMLElement;
  private readonly errTitle: HTMLElement;
  private readonly errText: HTMLElement;
  private readonly errDetail: HTMLElement;
  private readonly retry: HTMLButtonElement;
  private shown = 0;
  private retryFn: (() => void) | null = null;

  constructor() {
    this.bar = h('i');
    this.progress = h('div', { class: 'boot-bar', role: 'progressbar', 'aria-label': 'Loading', 'aria-valuemin': 0, 'aria-valuemax': 100, 'aria-valuenow': 0 }, this.bar);
    this.label = h('p', { class: 'boot-label', 'aria-live': 'polite' }, 'Loading lunar data…');
    this.loading = h(
      'div',
      { class: 'boot-box' },
      h('div', { class: 'boot-moon', 'aria-hidden': 'true' }, h('i')),
      h('p', { class: 'boot-title' }, 'Moon Spinner'),
      this.progress,
      this.label,
    );
    this.errTitle = h('h1', null, '');
    this.errText = h('p', null, '');
    this.errDetail = h('p', { class: 'boot-detail mono' }, '');
    this.retry = h('button', { type: 'button', class: 'btn btn-primary', onclick: () => this.retryFn?.() }, icon('retry', 16), 'Try again');
    this.error = h('div', { class: 'boot-box boot-error', role: 'alert', hidden: true }, h('span', { class: 'boot-err-icon' }, icon('warn', 28)), this.errTitle, this.errText, this.errDetail, this.retry);
    this.el = h('div', { class: 'boot' }, this.loading, this.error);
  }

  showLoading(): void {
    this.shown = 0;
    this.error.hidden = true;
    this.loading.hidden = false;
    this.el.hidden = false;
    this.el.classList.remove('done');
    this.setProgress(0.02);
  }

  /** Progress never moves backwards. */
  setProgress(fraction: number, label?: string): void {
    this.shown = Math.max(this.shown, Math.min(1, fraction));
    this.bar.style.transform = `scaleX(${this.shown})`;
    this.progress.setAttribute('aria-valuenow', String(Math.round(this.shown * 100)));
    if (label) setText(this.label, label);
  }

  hide(): void {
    this.setProgress(1);
    this.el.classList.add('done');
    window.setTimeout(() => {
      if (this.el.classList.contains('done')) this.el.hidden = true;
    }, 700);
  }

  showError(title: string, text: string, detail: string, onRetry: () => void): void {
    setText(this.errTitle, title);
    setText(this.errText, text);
    setText(this.errDetail, detail);
    this.errDetail.hidden = !detail;
    this.retryFn = onRetry;
    this.loading.hidden = true;
    this.error.hidden = false;
    this.el.hidden = false;
    this.el.classList.remove('done');
    this.retry.focus();
  }
}
