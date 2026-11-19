import * as THREE from 'three';
(globalThis as any).performance ??= { now: () => Date.now() };
(globalThis as any).document = { activeElement: null };
import { GlobeControls, vecToLatLon } from '../controls';
const handlers: Record<string, Function> = {};
const canvas: any = { style: { setProperty() {} }, hasAttribute: () => true, addEventListener: (t: string, f: Function) => (handlers[t] = f), removeEventListener() {}, getBoundingClientRect: () => ({ left: 0, top: 0 }), setPointerCapture() {}, releasePointerCapture() {}, focus() {} };
const c = new GlobeControls(canvas, { invalidate() {}, onTap() {}, onDoubleTap() {}, onHover: () => null, minAltitudeFloor: () => 0.01 });
c.resize(600, 500);
const cam = new THREE.PerspectiveCamera();
const proj = (lat: number, lon: number) => { c.applyTo(cam, 0.006); const la = lat * Math.PI / 180, lo = lon * Math.PI / 180; const v = new THREE.Vector3(Math.cos(la) * Math.sin(lo), Math.sin(la), Math.cos(la) * Math.cos(lo)).project(cam); return [(v.x * .5 + .5) * 600, (.5 - v.y * .5) * 500].map(x => +x.toFixed(1)); };
const [x, y] = proj(20, 30);
console.log('before', x, y);
let t = 0;
for (let i = 0; i < 14; i++) {
  handlers.wheel({ preventDefault() {}, deltaY: -240, deltaMode: 0, clientX: x, clientY: y, ctrlKey: false });
  for (let k = 0; k < (i % 2); k++) { c.update(0.1, t += 100); }
  if (i % 3 === 0) console.log(i, 'alt', c.alt.toFixed(4), proj(20, 30), JSON.stringify(vecToLatLon(c.centerDir(new THREE.Vector3()))));
}
for (let k = 0; k < 200; k++) c.update(0.016, t += 16);
console.log('after', c.alt.toFixed(4), proj(20, 30), JSON.stringify(vecToLatLon(c.centerDir(new THREE.Vector3()))));
