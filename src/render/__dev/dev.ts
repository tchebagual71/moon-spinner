import MoonView from '../MoonView';
import type { Manifest, QualityTier } from '../../types';
const params = new URLSearchParams(location.search);
const log: string[] = [];
(window as any).log = log;
(async () => {
  const manifest = (await (await fetch('/data/manifest.json')).json()) as Manifest;
  const view = new MoonView(document.getElementById('c') as HTMLCanvasElement, manifest, (params.get('q') as QualityTier) || 'medium');
  (window as any).view = view;
  view.onPick((p) => { log.push('pick ' + p.lat.toFixed(3) + ' ' + p.lon.toFixed(3)); (window as any).lastPick = p; });
  view.onMarkerClick((id) => { log.push('marker ' + id); (window as any).lastMarker = id; });
  view.onViewChange((v) => { (window as any).vs = v; (window as any).vsCount = ((window as any).vsCount || 0) + 1; });
  view.setLighting('manual', { sunLon: 0, sunLat: 0 });
  await view.ready;
  (window as any).ready = true;
})().catch((e) => { (window as any).err = String(e); console.error(e); });
