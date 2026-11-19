import { subSolarPoint, subEarthPoint } from '../sun';
import { Libration, SearchMoonPhase, MoonPhase } from 'astronomy-engine';
const start = new Date('2026-01-01T00:00:00Z');
for (const [name, ang] of [['new',0],['first quarter',90],['full',180],['last quarter',270]] as [string,number][]) {
  const t = SearchMoonPhase(ang, start, 40)!;
  const d = t.date; const ss = subSolarPoint(d), se = subEarthPoint(d), lib = Libration(d);
  console.log(name, d.toISOString(), 'subsolar', ss.lat.toFixed(3), ss.lon.toFixed(3), 'subearth', se.lat.toFixed(3), se.lon.toFixed(3), 'Libration()', lib.elat.toFixed(3), lib.elon.toFixed(3));
}
// Apollo 11 landing 1969-07-20T20:17Z: sun elevation at Tranquility Base (0.674N, 23.473E) was ~10.8 deg
const d = new Date('1969-07-20T20:17:40Z'); const ss = subSolarPoint(d);
const D=Math.PI/180; const el = Math.asin(Math.sin(ss.lat*D)*Math.sin(0.674*D)+Math.cos(ss.lat*D)*Math.cos(0.674*D)*Math.cos((ss.lon-23.473)*D))/D;
console.log('Apollo 11 sun elevation', el.toFixed(2), 'subsolar', ss);
