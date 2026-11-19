import * as THREE from 'three';
(globalThis as any).document = { activeElement: null };
import { GlobeControls, vecToLatLon } from '../controls';
const handlers: Record<string, Function> = {};
const canvas: any = { style: { setProperty() {} }, hasAttribute: () => true, addEventListener: (t: string, f: Function) => (handlers[t] = f), removeEventListener() {}, getBoundingClientRect: () => ({ left: 0, top: 0 }), setPointerCapture() {}, releasePointerCapture() {}, focus() {} };
const c: any = new GlobeControls(canvas, { invalidate() {}, onTap() {}, onDoubleTap() {}, onHover: () => null, minAltitudeFloor: () => 0.01 });
c.resize(600, 500);
c.jumpTo(70, 0, 4.6);
let t = 1000;
const ev = (type: string, x: number, y: number) => handlers[type]({ pointerId: 1, pointerType: 'mouse', button: 0, clientX: x, clientY: y, timeStamp: t, preventDefault() {} });
const st = () => { const r = c.rollState(); const ll = vecToLatLon(c.centerDir(new THREE.Vector3())); return `lat ${ll.lat.toFixed(2)} lon ${ll.lon.toFixed(2)} roll ${(r.roll * 57.3).toFixed(1)} w ${r.weight.toFixed(2)}`; };
for (let k = 0; k < 3; k++) {
  ev('pointerdown', 300, 200);
  for (let i = 1; i <= 8; i++) { t += 16; ev('pointermove', 300, 200 + i * 12.5); c.update(0.016, t); }
  t += 150; for (let i = 0; i < 9; i++) c.update(0.016, t);
  console.log('drag', k, 'before up', st());
  ev('pointerup', 300, 300);
  for (let i = 0; i < 100; i++) { t += 16; const a = c.update(0.016, t); if (i % 20 === 0) console.log('   ', i, st(), 'active', a); }
}
