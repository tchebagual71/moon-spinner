import * as THREE from 'three';
import { MOON_RADIUS_KM } from '../types';
import type { LatLon } from '../types';

/**
 * Camera + input for the globe.
 *
 * The Moon is fixed in world space; the camera orbits it, always looking at the centre.
 * State: orientation quaternion `q` (camera position = q * (0,0,dist), camera up = q * +Y) and the
 * altitude above the unit sphere. Dragging is a true trackball: the surface point grabbed stays
 * under the pointer (pin constraint), at every zoom level. Roll is continuously relaxed towards
 * north-up with a weight that vanishes near the poles, so the view can travel straight over a pole
 * and then swings gently back to north-up.
 */

export interface ControlsHost {
  /** Something changed, a frame is needed. */
  invalidate(): void;
  /** A tap / click that was not a drag or pinch. Coordinates in CSS px relative to the canvas. */
  onTap(x: number, y: number): void;
  onDoubleTap(x: number, y: number): void;
  /** Pointer hover (mouse only) — return a CSS cursor or null for the default. */
  onHover(x: number, y: number): string | null;
  /** Smallest allowed altitude in sphere radii (keeps the camera above exaggerated terrain). */
  minAltitudeFloor(): number;
}

const D2R = Math.PI / 180;
const TAN_MIN = Math.tan(12 * D2R); // half field of view across the smaller viewport dimension
const DISC_FILL = 0.8; // full-disc view: Moon radius as a fraction of the smaller half-viewport
const MIN_METERS_PER_PX = 90;
const VIRTUAL_RHO = 0.8;

const _v1 = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _v3 = new THREE.Vector3();
const _q1 = new THREE.Quaternion();
const _q2 = new THREE.Quaternion();
const X_AXIS = new THREE.Vector3(1, 0, 0);
const Y_AXIS = new THREE.Vector3(0, 1, 0);
const Z_AXIS = new THREE.Vector3(0, 0, 1);

export function northUpQuaternion(lat: number, lon: number, out = new THREE.Quaternion()): THREE.Quaternion {
  out.setFromAxisAngle(Y_AXIS, lon * D2R);
  _q2.setFromAxisAngle(X_AXIS, -lat * D2R);
  return out.multiply(_q2);
}

export function vecToLatLon(v: THREE.Vector3): LatLon {
  const len = v.length() || 1;
  return {
    lat: Math.asin(Math.max(-1, Math.min(1, v.y / len))) / D2R,
    lon: Math.atan2(v.x, v.z) / D2R,
  };
}

interface Fly {
  q0: THREE.Quaternion;
  q1: THREE.Quaternion;
  la0: number;
  la1: number;
  hop: number;
  t: number;
  dur: number;
  resolve: () => void;
}

export class GlobeControls {
  readonly q = new THREE.Quaternion();
  /** Altitude above the mean sphere, in sphere radii. */
  alt = 5;
  width = 1;
  height = 1;
  tanV = TAN_MIN;
  tanH = TAN_MIN;
  maxAlt = 5;
  minAlt = 0.05;
  /** True while the user is touching / dragging. */
  dragging = false;

  private readonly canvas: HTMLCanvasElement;
  private readonly host: ControlsHost;
  private readonly pointers = new Map<number, { x: number; y: number; type: string }>();
  private grab: THREE.Vector3 | null = null;
  private grabX = 0;
  private grabY = 0;
  private pinchDist = 0;
  private gesture = { moved: false, multi: false, x0: 0, y0: 0, t0: 0 };
  private lastTap: { t: number; x: number; y: number } | null = null;
  private readonly omega = new THREE.Vector3();
  private lastMoveTime = 0;
  private inertia = false;
  private zoomTarget: number | null = null;
  private zoomAnchor: { x: number; y: number; world: THREE.Vector3 | null } | null = null;
  private fly: Fly | null = null;
  private readonly keys = new Set<string>();
  private autoRotate = false;
  private autoSpeed = 0;
  private lastInteraction = -1e9;
  private gestureAlt = 0;
  private readonly listeners: [EventTarget, string, EventListener, AddEventListenerOptions | undefined][] = [];

  constructor(canvas: HTMLCanvasElement, host: ControlsHost) {
    this.canvas = canvas;
    this.host = host;
    canvas.style.touchAction = 'none';
    canvas.style.userSelect = 'none';
    canvas.style.setProperty('-webkit-user-select', 'none');
    canvas.style.setProperty('-webkit-touch-callout', 'none');
    canvas.style.setProperty('-webkit-tap-highlight-color', 'transparent');
    if (!canvas.hasAttribute('tabindex')) canvas.tabIndex = 0;
    canvas.style.cursor = 'grab';

    const on = <K extends keyof HTMLElementEventMap>(
      type: K | string,
      fn: (e: never) => void,
      opts?: AddEventListenerOptions,
      target: EventTarget = canvas,
    ) => {
      target.addEventListener(type, fn as EventListener, opts);
      this.listeners.push([target, type, fn as EventListener, opts]);
    };
    on('pointerdown', this.onDown);
    on('pointermove', this.onMove);
    on('pointerup', this.onUp);
    on('pointercancel', this.onCancel);
    on('lostpointercapture', this.onCancel);
    on('wheel', this.onWheel, { passive: false });
    on('keydown', this.onKeyDown);
    on('keyup', this.onKeyUp);
    on('blur', this.onBlur);
    on('dblclick', (e: Event) => e.preventDefault());
    on('gesturestart', this.onGestureStart, { passive: false });
    on('gesturechange', this.onGestureChange, { passive: false });
    on('gestureend', (e: Event) => e.preventDefault(), { passive: false });
  }

  dispose(): void {
    for (const [t, type, fn, opts] of this.listeners) t.removeEventListener(type, fn, opts);
    this.listeners.length = 0;
    this.cancelFly();
  }

  // ------------------------------------------------------------------ geometry

  get dist(): number {
    return 1 + this.alt;
  }

  resize(w: number, h: number): void {
    const first = this.width <= 1;
    const wasFull = this.alt >= this.maxAlt * 0.999;
    this.width = Math.max(1, w);
    this.height = Math.max(1, h);
    const aspect = this.width / this.height;
    if (aspect >= 1) {
      this.tanV = TAN_MIN;
      this.tanH = TAN_MIN * aspect;
    } else {
      this.tanH = TAN_MIN;
      this.tanV = TAN_MIN / aspect;
    }
    // full disc: tan(angular radius of the limb) = DISC_FILL * TAN_MIN
    const psi = Math.atan(DISC_FILL * TAN_MIN);
    this.maxAlt = 1 / Math.sin(psi) - 1;
    this.updateMinAlt();
    if (first || wasFull) this.alt = this.maxAlt;
    this.alt = this.clampAlt(this.alt);
  }

  updateMinAlt(): void {
    const minDim = Math.min(this.width, this.height);
    const a = (MIN_METERS_PER_PX * minDim) / (2 * TAN_MIN) / (MOON_RADIUS_KM * 1000);
    this.minAlt = Math.min(this.maxAlt, Math.max(a, this.host.minAltitudeFloor()));
    this.alt = this.clampAlt(this.alt);
  }

  private clampAlt(a: number): number {
    return Math.min(this.maxAlt, Math.max(this.minAlt, a));
  }

  /** Metres of ground per CSS pixel at the view centre. */
  metersPerPixel(alt = this.alt): number {
    return ((2 * alt * TAN_MIN) / Math.min(this.width, this.height)) * MOON_RADIUS_KM * 1000;
  }

  altitudeForMetersPerPixel(mpp: number): number {
    return (mpp * Math.min(this.width, this.height)) / (2 * TAN_MIN) / (MOON_RADIUS_KM * 1000);
  }

  /** Unit vector from the Moon centre towards the camera (= sub-camera point). */
  centerDir(out: THREE.Vector3): THREE.Vector3 {
    return out.copy(Z_AXIS).applyQuaternion(this.q);
  }

  applyTo(camera: THREE.PerspectiveCamera, reliefMax: number): void {
    const d = this.dist;
    camera.quaternion.copy(this.q);
    camera.position.set(0, 0, d).applyQuaternion(this.q);
    camera.fov = (2 * Math.atan(this.tanV)) / D2R;
    camera.aspect = this.width / this.height;
    camera.near = Math.max(1e-4, (this.alt - reliefMax) * 0.5);
    camera.far = d + 1.2;
    camera.updateProjectionMatrix();
    camera.updateMatrixWorld(true);
  }

  /**
   * Camera-frame unit vector of the sphere point under a screen position.
   * With `virtual`, positions beyond 80 % of the disc radius are mapped onto a smooth
   * continuation of the sphere so dragging near / outside the limb stays well-conditioned.
   */
  private screenToCam(x: number, y: number, virtual: boolean, out: THREE.Vector3): boolean {
    const rx = ((2 * x) / this.width - 1) * this.tanH;
    const ry = (1 - (2 * y) / this.height) * this.tanV;
    const d = this.dist;
    const lat2 = rx * rx + ry * ry;
    const tanLimb2 = 1 / (d * d - 1);
    const rho = Math.sqrt(lat2 / tanLimb2);
    if (rho <= (virtual ? VIRTUAL_RHO : 0.9999)) {
      const len = Math.sqrt(lat2 + 1);
      const b = -d / len;
      const disc = Math.max(0, b * b - (d * d - 1));
      const t = -b - Math.sqrt(disc);
      out.set((rx * t) / len, (ry * t) / len, d - t / len).normalize();
      return true;
    }
    if (!virtual) return false;
    const gamma = (r: number): number => {
      const l2 = r * r * tanLimb2;
      const len = Math.sqrt(l2 + 1);
      const b = -d / len;
      const t = -b - Math.sqrt(Math.max(0, b * b - (d * d - 1)));
      return Math.acos(Math.max(-1, Math.min(1, d - t / len)));
    };
    const g0 = gamma(VIRTUAL_RHO);
    const slope = (g0 - gamma(VIRTUAL_RHO - 0.01)) / 0.01;
    const g = Math.min(g0 + slope * (rho - VIRTUAL_RHO), 2.6);
    const inv = 1 / Math.sqrt(lat2);
    out.set(rx * inv * Math.sin(g), ry * inv * Math.sin(g), Math.cos(g));
    return true;
  }

  /** World-space unit vector under a screen position, or false if it misses the sphere. */
  screenToWorld(x: number, y: number, out: THREE.Vector3): boolean {
    if (!this.screenToCam(x, y, false, out)) return false;
    out.applyQuaternion(this.q);
    return true;
  }

  /** Rotate the camera so that the world point `p` appears at screen position (x, y). */
  private pin(p: THREE.Vector3, x: number, y: number, virtual: boolean): boolean {
    if (!this.screenToCam(x, y, virtual, _v1)) return false;
    _q1.copy(this.q).invert();
    _v2.copy(p).applyQuaternion(_q1);
    _q2.setFromUnitVectors(_v1, _v2);
    this.q.multiply(_q2).normalize();
    return true;
  }

  /** Roll (rad) of the projected north direction relative to screen-up, and its weight 0..1. */
  private rollState(): { roll: number; weight: number } {
    _q1.copy(this.q).invert();
    _v1.copy(Y_AXIS).applyQuaternion(_q1);
    const m = _v1.x * _v1.x + _v1.y * _v1.y;
    const t = Math.min(1, Math.max(0, (m - 0.005) / 0.2));
    return { roll: Math.atan2(_v1.x, _v1.y), weight: t * t * (3 - 2 * t) };
  }

  private relaxRoll(dt: number): boolean {
    const { roll, weight } = this.rollState();
    if (weight <= 0 || Math.abs(roll) < 1e-5) return false;
    // While a finger is down only correct small drift. After travelling over a pole the view is
    // upside-down; turning it during the drag would swing the surface around the finger, so that
    // (large) correction waits until the drag is released.
    if (this.dragging && Math.abs(roll) > 1.05) return false;
    const frac = 1 - Math.exp(-dt * 9 * weight);
    // cap the swing rate so the turn back to north-up after crossing a pole is gentle
    const step = Math.sign(roll) * Math.min(Math.abs(roll) * frac, 2.5 * dt + 1e-4);
    _q2.setFromAxisAngle(Z_AXIS, -step);
    this.q.multiply(_q2).normalize();
    return Math.abs(roll) > 2e-4;
  }

  // ------------------------------------------------------------------ programmatic motion

  jumpTo(lat: number, lon: number, alt?: number): void {
    this.cancelFly();
    this.stopMotion();
    northUpQuaternion(lat, lon, this.q);
    if (alt !== undefined) this.alt = this.clampAlt(alt);
    this.host.invalidate();
  }

  flyTo(lat: number, lon: number, alt?: number, duration?: number): Promise<void> {
    this.cancelFly();
    this.stopMotion();
    const q1 = northUpQuaternion(lat, lon);
    const q0 = this.q.clone();
    const a1 = this.clampAlt(alt ?? this.alt);
    const la0 = Math.log(this.alt);
    const la1 = Math.log(a1);
    const theta = this.centerDir(_v1).angleTo(_v2.set(0, 0, 1).applyQuaternion(q1));
    // zoom out mid-flight when the destination is far outside the current view
    const midAlt = Math.min(this.maxAlt, (theta * 0.7) / TAN_MIN);
    const hop = Math.max(0, Math.log(midAlt) - Math.max(la0, la1));
    const dur = duration ?? Math.min(2.6, 0.55 + 0.45 * Math.min(theta, 2.5) + 0.12 * Math.abs(la1 - la0) + 0.15 * hop);
    if (theta < 1e-5 && Math.abs(la1 - la0) < 1e-4 && q0.angleTo(q1) < 1e-4) return Promise.resolve();
    return new Promise<void>((resolve) => {
      this.fly = { q0, q1, la0, la1, hop, t: 0, dur: Math.max(0.05, dur), resolve };
      this.host.invalidate();
    });
  }

  cancelFly(): void {
    const f = this.fly;
    if (f) {
      this.fly = null;
      f.resolve();
    }
  }

  private stopMotion(): void {
    this.inertia = false;
    this.omega.set(0, 0, 0);
    this.zoomTarget = null;
    this.zoomAnchor = null;
  }

  setAutoRotate(on: boolean): void {
    this.autoRotate = on;
    if (on) this.lastInteraction = -1e9;
    this.host.invalidate();
  }

  /** Smoothly zoom by a factor (>1 zooms in) about a screen point (defaults to the centre). */
  zoomBy(factor: number, x = this.width / 2, y = this.height / 2): void {
    const base = this.zoomTarget ?? Math.log(this.alt);
    this.zoomTarget = Math.log(this.clampAlt(Math.exp(base) / factor));
    const world = new THREE.Vector3();
    this.zoomAnchor = { x, y, world: this.screenToWorld(x, y, world) ? world : null };
    this.host.invalidate();
  }

  private interacted(): void {
    this.lastInteraction = performance.now();
    this.autoSpeed = 0;
    this.cancelFly();
  }

  // ------------------------------------------------------------------ per-frame update

  /** Advance animations. Returns true while more frames are needed. */
  update(dt: number, now: number, realDt = dt): boolean {
    let active = false;
    const f = this.fly;
    if (f) {
      f.t = Math.min(1, f.t + Math.max(dt, Math.min(realDt, 0.3)) / f.dur);
      const e = f.t < 0.5 ? 4 * f.t * f.t * f.t : 1 - Math.pow(-2 * f.t + 2, 3) / 2;
      this.q.slerpQuaternions(f.q0, f.q1, e);
      this.alt = this.clampAlt(Math.exp(f.la0 + (f.la1 - f.la0) * e + f.hop * 4 * e * (1 - e)));
      if (f.t >= 1) {
        this.fly = null;
        f.resolve();
      } else active = true;
      return active;
    }

    // keyboard
    if (this.keys.size) {
      const rate = Math.min(1.2, this.alt * TAN_MIN * 1.6 + 0.004) * dt;
      let yaw = 0;
      let pitch = 0;
      if (this.keys.has('ArrowLeft')) yaw -= rate;
      if (this.keys.has('ArrowRight')) yaw += rate;
      if (this.keys.has('ArrowUp')) pitch -= rate;
      if (this.keys.has('ArrowDown')) pitch += rate;
      if (yaw) this.q.multiply(_q2.setFromAxisAngle(Y_AXIS, yaw));
      if (pitch) this.q.multiply(_q2.setFromAxisAngle(X_AXIS, pitch));
      let z = 0;
      if (this.keys.has('+')) z -= 1;
      if (this.keys.has('-')) z += 1;
      if (z) {
        this.alt = this.clampAlt(this.alt * Math.exp(z * 1.6 * dt));
        this.zoomTarget = null;
      }
      this.q.normalize();
      this.lastInteraction = now;
      active = true;
    }

    // smooth wheel zoom towards the anchor point
    if (this.zoomTarget !== null) {
      const la = Math.log(this.alt);
      const diff = this.zoomTarget - la;
      if (Math.abs(diff) < 2e-4) {
        this.alt = this.clampAlt(Math.exp(this.zoomTarget));
        this.zoomTarget = null;
      } else {
        this.alt = this.clampAlt(Math.exp(la + diff * (1 - Math.exp(-dt * 13))));
        active = true;
      }
    }

    // inertia after a flick
    if (this.inertia && !this.dragging) {
      const w = this.omega.length();
      if (w < 2e-4 + this.alt * 0.004) {
        this.inertia = false;
      } else {
        _q2.setFromAxisAngle(_v3.copy(this.omega).divideScalar(w), w * dt);
        this.q.premultiply(_q2).normalize();
        this.omega.multiplyScalar(Math.exp(-dt / 0.3));
        active = true;
      }
    }

    // auto-rotation (about the Moon's axis), paused for a while after any interaction
    if (this.autoRotate && !this.dragging && now - this.lastInteraction > 2500) {
      this.autoSpeed = Math.min(1, this.autoSpeed + dt / 1.2);
      const s = this.autoSpeed * this.autoSpeed * (3 - 2 * this.autoSpeed);
      this.q.premultiply(_q2.setFromAxisAngle(Y_AXIS, 0.06 * s * dt)).normalize();
      active = true;
    } else if (this.autoRotate) {
      active = true; // keep ticking so rotation resumes
    }

    const rolling = this.relaxRoll(dt);
    if (rolling) active = true;
    // Re-apply the pin constraint last, so removing roll never slides the surface under the pointer.
    if (this.dragging) {
      if (this.grab && (this.gesture.moved || this.gesture.multi)) this.pin(this.grab, this.grabX, this.grabY, true);
    } else if (this.zoomAnchor) {
      const a = this.zoomAnchor;
      if (a.world && !this.inertia && !this.keys.size) this.pin(a.world, a.x, a.y, false);
      if (this.zoomTarget === null && !rolling) this.zoomAnchor = null;
    }
    return active;
  }

  // ------------------------------------------------------------------ input

  private local(e: PointerEvent | WheelEvent | MouseEvent): { x: number; y: number } {
    const r = this.canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  private centroid(): { x: number; y: number; dist: number } {
    let x = 0;
    let y = 0;
    for (const p of this.pointers.values()) {
      x += p.x;
      y += p.y;
    }
    const n = this.pointers.size || 1;
    x /= n;
    y /= n;
    let dist = 0;
    if (this.pointers.size >= 2) {
      const [a, b] = [...this.pointers.values()];
      dist = Math.hypot(a.x - b.x, a.y - b.y);
    }
    return { x, y, dist };
  }

  private regrab(): void {
    const c = this.centroid();
    this.grabX = c.x;
    this.grabY = c.y;
    this.pinchDist = c.dist;
    const v = new THREE.Vector3();
    this.screenToCam(c.x, c.y, true, v);
    this.grab = v.applyQuaternion(this.q);
  }

  private onDown = (e: PointerEvent): void => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    try {
      this.canvas.setPointerCapture(e.pointerId);
    } catch {
      /* pointer already gone */
    }
    if (document.activeElement !== this.canvas) this.canvas.focus({ preventScroll: true });
    e.preventDefault();
    this.interacted();
    this.stopMotion();
    const p = this.local(e);
    this.pointers.set(e.pointerId, { x: p.x, y: p.y, type: e.pointerType });
    if (this.pointers.size === 1) {
      this.gesture = { moved: false, multi: false, x0: p.x, y0: p.y, t0: e.timeStamp };
    } else {
      this.gesture.multi = true;
    }
    this.dragging = true;
    this.regrab();
    this.canvas.style.cursor = 'grabbing';
    this.host.invalidate();
  };

  private onMove = (e: PointerEvent): void => {
    const p = this.local(e);
    const tracked = this.pointers.get(e.pointerId);
    if (!tracked) {
      if (e.pointerType === 'mouse' && !this.dragging) this.canvas.style.cursor = this.host.onHover(p.x, p.y) ?? 'grab';
      return;
    }
    tracked.x = p.x;
    tracked.y = p.y;
    const g = this.gesture;
    if (!g.moved && !g.multi) {
      const slop = e.pointerType === 'mouse' ? 4 : 10;
      if (Math.hypot(p.x - g.x0, p.y - g.y0) < slop) return;
      g.moved = true;
      // grab at the current position so the surface does not jump by the slop distance
      this.regrab();
      return;
    }
    const c = this.centroid();
    if (this.pointers.size >= 2 && this.pinchDist > 0 && c.dist > 0) {
      this.alt = this.clampAlt((this.alt * this.pinchDist) / c.dist);
      this.pinchDist = c.dist;
    }
    this.grabX = c.x;
    this.grabY = c.y;
    if (!this.grab) return;
    _q1.copy(this.q);
    const before = _q1.clone();
    this.pin(this.grab, c.x, c.y, true);
    // world-frame angular velocity estimate for inertia
    const dtMs = Math.max(1, e.timeStamp - this.lastMoveTime);
    this.lastMoveTime = e.timeStamp;
    const dq = this.q.clone().multiply(before.invert());
    if (dq.w < 0) dq.set(-dq.x, -dq.y, -dq.z, -dq.w);
    const s = Math.sqrt(Math.max(0, 1 - dq.w * dq.w));
    if (s > 1e-9 && dtMs < 100 && this.pointers.size === 1) {
      const ang = 2 * Math.atan2(s, dq.w);
      _v3.set(dq.x / s, dq.y / s, dq.z / s).multiplyScalar((ang / dtMs) * 1000);
      this.omega.lerp(_v3, 0.45);
    } else {
      this.omega.set(0, 0, 0);
    }
    this.lastInteraction = performance.now();
    this.host.invalidate();
  };

  private release(e: PointerEvent, cancelled: boolean): void {
    const tracked = this.pointers.get(e.pointerId);
    if (!tracked) return;
    this.pointers.delete(e.pointerId);
    try {
      this.canvas.releasePointerCapture(e.pointerId);
    } catch {
      /* already released */
    }
    this.lastInteraction = performance.now();
    if (this.pointers.size > 0) {
      this.omega.set(0, 0, 0);
      this.regrab();
      return;
    }
    this.dragging = false;
    this.grab = null;
    this.canvas.style.cursor = 'grab';
    const g = this.gesture;
    if (!cancelled && !g.moved && !g.multi) {
      const quick = e.pointerType === 'mouse' || e.timeStamp - g.t0 < 700;
      if (quick) {
        const lt = this.lastTap;
        if (lt && e.timeStamp - lt.t < 330 && Math.hypot(lt.x - tracked.x, lt.y - tracked.y) < 32) {
          this.lastTap = null;
          this.host.onDoubleTap(tracked.x, tracked.y);
        } else {
          this.lastTap = { t: e.timeStamp, x: tracked.x, y: tracked.y };
          this.host.onTap(tracked.x, tracked.y);
        }
      }
    } else if (!cancelled && g.moved && !g.multi && e.timeStamp - this.lastMoveTime < 70) {
      const w = this.omega.length();
      if (w > 0.002 + this.alt * 0.02) {
        if (w > 3.2) this.omega.multiplyScalar(3.2 / w);
        this.inertia = true;
      }
    }
    this.host.invalidate();
  }

  private onUp = (e: PointerEvent): void => this.release(e, false);
  private onCancel = (e: PointerEvent): void => this.release(e, true);

  private onWheel = (e: WheelEvent): void => {
    e.preventDefault();
    this.interacted();
    this.inertia = false;
    let dy = e.deltaY;
    if (e.deltaMode === 1) dy *= 16;
    else if (e.deltaMode === 2) dy *= 400;
    let step = dy * (e.ctrlKey ? 0.012 : 0.0018);
    step = Math.max(-0.6, Math.min(0.6, step));
    const p = this.local(e);
    const base = this.zoomTarget ?? Math.log(this.alt);
    this.zoomTarget = Math.log(this.clampAlt(Math.exp(base + step)));
    const world = new THREE.Vector3();
    this.zoomAnchor = { x: p.x, y: p.y, world: this.screenToWorld(p.x, p.y, world) ? world : null };
    this.host.invalidate();
  };

  private onGestureStart = (e: Event): void => {
    e.preventDefault();
    this.gestureAlt = this.alt;
  };

  private onGestureChange = (e: Event): void => {
    e.preventDefault();
    const scale = (e as Event & { scale?: number }).scale;
    if (!scale || this.pointers.size > 0) return;
    this.interacted();
    this.zoomTarget = null;
    this.alt = this.clampAlt(this.gestureAlt / scale);
    this.host.invalidate();
  };

  private static keyName(e: KeyboardEvent): string | null {
    if (e.key.startsWith('Arrow')) return e.key;
    if (e.key === '+' || e.key === '=') return '+';
    if (e.key === '-' || e.key === '_') return '-';
    return null;
  }

  private onKeyDown = (e: KeyboardEvent): void => {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const k = GlobeControls.keyName(e);
    if (!k) return;
    e.preventDefault();
    this.interacted();
    this.inertia = false;
    this.keys.add(k);
    this.host.invalidate();
  };

  private onKeyUp = (e: KeyboardEvent): void => {
    const k = GlobeControls.keyName(e);
    if (k) this.keys.delete(k);
  };

  private onBlur = (): void => {
    this.keys.clear();
  };
}
