import * as THREE from 'three';
import type { Marker } from '../types';

/**
 * Labelled markers as absolutely positioned DOM nodes in an overlay that sits exactly on top of
 * the canvas (crisp text at any DPR). The overlay never receives pointer events itself — taps are
 * hit-tested by the renderer against the marker boxes, so drags and pinches that start on a label
 * still move the globe.
 */

const CSS = `
.mv-overlay{position:absolute;overflow:hidden;pointer-events:none;contain:strict;z-index:1;
  font:500 12px/1.2 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;-webkit-user-select:none;user-select:none}
.mv-marker{position:absolute;left:0;top:0;display:flex;align-items:center;gap:6px;height:40px;margin:-20px 0 0 -20px;
  padding:0 0 0 14px;box-sizing:border-box;white-space:nowrap;color:#f4f1ea;opacity:0;visibility:hidden;
  transition:opacity .18s ease,visibility 0s linear .18s;will-change:transform}
.mv-marker.mv-on{opacity:var(--mv-o,1);visibility:visible;transition:opacity .18s ease}
.mv-dot{flex:none;width:8px;height:8px;margin:0 2px;border-radius:50%;background:#f4f1ea;border:1.5px solid rgba(8,10,14,.85);
  box-shadow:0 0 0 1px rgba(255,255,255,.25)}
.mv-label{padding:2px 6px;border-radius:4px;background:rgba(8,10,14,.55);text-shadow:0 1px 2px rgba(0,0,0,.9);
  letter-spacing:.01em}
.mv-marker--feature .mv-dot{width:6px;height:6px;margin:0 3px;background:rgba(244,241,234,.9)}
.mv-marker--site .mv-dot{background:#ffcf5c;border-radius:2px;transform:rotate(45deg)}
.mv-marker--site .mv-label{color:#ffe3a1}
.mv-marker--selection .mv-dot{background:#ffdb6b;box-shadow:0 0 0 2px rgba(255,219,107,.35)}
.mv-marker--selection .mv-label{background:rgba(8,10,14,.78);font-weight:600;color:#fff}
.mv-marker.mv-nolabel .mv-label{display:none}
.mv-marker.mv-flip{flex-direction:row-reverse;padding:0 14px 0 0;margin-left:0}
`;

let cssInjected = false;
function injectCss(): void {
  if (cssInjected || document.getElementById('mv-style')) return;
  cssInjected = true;
  const s = document.createElement('style');
  s.id = 'mv-style';
  s.textContent = CSS;
  document.head.appendChild(s);
}

interface Item {
  marker: Marker;
  dir: THREE.Vector3;
  /** Height above the sphere in radii at true scale. */
  h: number;
  el: HTMLDivElement | null;
  labelW: number;
  shown: boolean;
  x: number;
  y: number;
  labelShown: boolean;
  flip: boolean;
  lastShownFrame: number;
}

export interface MarkerView {
  camera: THREE.PerspectiveCamera;
  width: number;
  height: number;
  relief: number;
}

const _p = new THREE.Vector3();
const KIND_RANK: Record<Marker['kind'], number> = { selection: 0, site: 1, feature: 2 };

export class MarkerLayer {
  readonly overlay: HTMLDivElement;
  private items: Item[] = [];
  private readonly els = new Map<string, HTMLDivElement>();
  private readonly canvas: HTMLCanvasElement;
  private readonly maxVisible: number;
  private frame = 0;
  private heightAt: (lat: number, lon: number) => number;

  constructor(canvas: HTMLCanvasElement, maxVisible: number, heightAt: (lat: number, lon: number) => number) {
    injectCss();
    this.canvas = canvas;
    this.maxVisible = maxVisible;
    this.heightAt = heightAt;
    this.overlay = document.createElement('div');
    this.overlay.className = 'mv-overlay';
    this.overlay.setAttribute('aria-hidden', 'true');
    canvas.insertAdjacentElement('afterend', this.overlay);
    this.layout();
  }

  /** Keep the overlay exactly on top of the canvas. */
  layout(): void {
    const c = this.canvas;
    const s = this.overlay.style;
    s.left = `${c.offsetLeft}px`;
    s.top = `${c.offsetTop}px`;
    s.width = `${c.clientWidth}px`;
    s.height = `${c.clientHeight}px`;
  }

  dispose(): void {
    this.overlay.remove();
    this.items = [];
    this.els.clear();
  }

  refreshHeights(): void {
    for (const it of this.items) it.h = this.heightAt(it.marker.lat, it.marker.lon);
  }

  set(markers: Marker[]): void {
    const keep = new Set<string>();
    const old = new Map(this.items.map((i) => [i.marker.id, i]));
    const d2r = Math.PI / 180;
    // stable priority: selection, then sites, then features, each in the order given
    const sorted = markers
      .map((m, i) => ({ m, i }))
      .sort((a, b) => KIND_RANK[a.m.kind] - KIND_RANK[b.m.kind] || a.i - b.i)
      .map((x) => x.m);
    this.items = sorted.map((m) => {
      keep.add(m.id);
      const prev = old.get(m.id);
      const la = m.lat * d2r;
      const lo = m.lon * d2r;
      const dir = new THREE.Vector3(Math.cos(la) * Math.sin(lo), Math.sin(la), Math.cos(la) * Math.cos(lo));
      let el = prev?.el ?? null;
      let labelW = prev?.labelW ?? 0;
      if (el && prev && (prev.marker.label !== m.label || prev.marker.kind !== m.kind)) {
        el.remove();
        this.els.delete(m.id);
        el = null;
        labelW = 0;
      }
      return { marker: m, dir, h: this.heightAt(m.lat, m.lon), el, labelW, shown: false, x: 0, y: 0, labelShown: false, flip: false, lastShownFrame: prev?.lastShownFrame ?? -1 };
    });
    for (const [id, el] of this.els) {
      if (!keep.has(id)) {
        el.remove();
        this.els.delete(id);
      }
    }
  }

  private ensureEl(it: Item): HTMLDivElement {
    if (it.el) return it.el;
    const el = document.createElement('div');
    el.className = `mv-marker mv-marker--${it.marker.kind}`;
    el.dataset.id = it.marker.id;
    const dot = document.createElement('span');
    dot.className = 'mv-dot';
    const label = document.createElement('span');
    label.className = 'mv-label';
    label.textContent = it.marker.label;
    el.append(dot, label);
    this.overlay.appendChild(el);
    this.els.set(it.marker.id, el);
    it.el = el;
    it.labelW = it.marker.label ? label.offsetWidth : 0;
    return el;
  }

  /** Estimated label width before the element exists (avoids creating DOM for hidden markers). */
  private static estimateWidth(label: string): number {
    return label ? label.length * 6.6 + 14 : 0;
  }

  update(view: MarkerView): void {
    this.frame++;
    const { camera, width, height } = view;
    const cam = camera.position;
    const placedDots: number[] = [];
    const placedBoxes: number[] = [];
    let count = 0;
    for (const it of this.items) {
      let show = false;
      let labelOk = false;
      let flip = false;
      let fade = 1;
      if (count < this.maxVisible) {
        const r = 1 + it.h * view.relief;
        // horizon test against the mean sphere: visible iff p.c > 1 (for |p| = 1)
        const facing = (it.dir.dot(cam) * r - 1) / Math.max(cam.length() - 1, 1e-6);
        if (facing > 0.004) {
          _p.copy(it.dir).multiplyScalar(r).project(camera);
          const x = (_p.x * 0.5 + 0.5) * width;
          const y = (0.5 - _p.y * 0.5) * height;
          if (x > -20 && y > -20 && x < width + 20 && y < height + 20 && _p.z < 1) {
            fade = Math.min(1, facing / 0.05);
            const sel = it.marker.kind === 'selection';
            // dot clearance
            let clear = true;
            if (!sel) {
              for (let i = 0; i < placedDots.length; i += 2) {
                const dx = placedDots[i] - x;
                const dy = placedDots[i + 1] - y;
                if (dx * dx + dy * dy < 22 * 22) {
                  clear = false;
                  break;
                }
              }
              // and do not sit on top of somebody else's label
              for (let i = 0; clear && i < placedBoxes.length; i += 4) {
                if (x > placedBoxes[i] - 6 && x < placedBoxes[i + 2] + 6 && y > placedBoxes[i + 1] - 4 && y < placedBoxes[i + 3] + 4) clear = false;
              }
            }
            if (clear) {
              show = true;
              it.x = x;
              it.y = y;
              const w = it.labelW || MarkerLayer.estimateWidth(it.marker.label);
              // put the label on the left of the dot when it would run off the right edge
              flip = x + 14 + w > width - 4 && x - 14 - w > 4;
              const bx0 = flip ? x - 12 - w : x + 8;
              const by0 = y - 11;
              const bx1 = bx0 + w + 4;
              const by1 = y + 11;
              labelOk = w > 0;
              if (!sel) {
                for (let i = 0; labelOk && i < placedBoxes.length; i += 4) {
                  if (bx0 < placedBoxes[i + 2] && bx1 > placedBoxes[i] && by0 < placedBoxes[i + 3] && by1 > placedBoxes[i + 1]) labelOk = false;
                }
                for (let i = 0; labelOk && i < placedDots.length; i += 2) {
                  if (placedDots[i] > bx0 - 6 && placedDots[i] < bx1 + 6 && placedDots[i + 1] > by0 - 5 && placedDots[i + 1] < by1 + 5) labelOk = false;
                }
              }
              // a feature label that cannot be shown would just be an anonymous dot: skip it
              if (!labelOk && it.marker.kind === 'feature' && it.marker.label) show = false;
              if (show) {
                placedDots.push(x, y);
                if (labelOk) placedBoxes.push(bx0, by0, bx1, by1);
                count++;
              }
            }
          }
        }
      }
      if (show) {
        const el = this.ensureEl(it);
        // flipped markers are anchored by their right end (dot centre 20 px from the right edge)
        el.style.transform = flip && labelOk ? `translate3d(${it.x.toFixed(1)}px,${it.y.toFixed(1)}px,0) translateX(-100%) translateX(20px)` : `translate3d(${it.x.toFixed(1)}px,${it.y.toFixed(1)}px,0)`;
        if (it.flip !== (flip && labelOk) || !it.shown) el.classList.toggle('mv-flip', flip && labelOk);
        it.flip = flip && labelOk;
        el.style.setProperty('--mv-o', fade.toFixed(2));
        if (!it.shown) el.classList.add('mv-on');
        if (it.labelShown !== labelOk || !it.shown) el.classList.toggle('mv-nolabel', !labelOk);
        it.lastShownFrame = this.frame;
      } else if (it.shown && it.el) {
        it.el.classList.remove('mv-on');
      }
      it.shown = show;
      it.labelShown = labelOk;
    }
    this.prune();
  }

  /** Drop DOM nodes of markers that have been hidden for a while when there are many. */
  private prune(): void {
    if (this.els.size <= this.maxVisible * 3) return;
    for (const it of this.items) {
      if (it.el && !it.shown && this.frame - it.lastShownFrame > 30) {
        it.el.remove();
        this.els.delete(it.marker.id);
        it.el = null;
      }
    }
  }

  /** Marker under a screen position (40 px minimum target), or null. */
  hitTest(x: number, y: number): string | null {
    let best: string | null = null;
    let bestD = Infinity;
    for (const it of this.items) {
      if (!it.shown) continue;
      const dx = x - it.x;
      const dy = y - it.y;
      let d = Math.hypot(dx, dy);
      const inDot = d <= 20;
      const lx = it.flip ? -dx : dx;
      const inLabel = it.labelShown && lx >= 0 && lx <= 12 + it.labelW && Math.abs(dy) <= 20;
      if (!inDot && !inLabel) continue;
      if (!inDot) d = 20 + Math.abs(dy) * 0.1;
      if (it.marker.kind === 'selection') d += 6; // prefer real places over the selection pin
      if (d < bestD) {
        bestD = d;
        best = it.marker.id;
      }
    }
    return best;
  }
}
