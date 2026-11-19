/**
 * Sub-solar / sub-Earth points on the Moon in selenographic (mean-Earth / polar-axis) coordinates.
 *
 * Derivation
 * ----------
 * 1. `RotationAxis(Body.Moon, t)` (astronomy-engine, IAU WGCCRE model including the periodic
 *    E1..E13 libration terms) gives, in the J2000 equatorial frame (EQJ):
 *      - the unit vector n of the lunar north pole (RA a0, Dec d0), and
 *      - W ("spin"): the angle, measured eastward along the Moon's equator, from the node
 *        Q = ascending node of the lunar equator on the J2000 equator (at RA a0 + 90 deg) to the
 *        prime meridian.
 * 2. Body-fixed axes expressed in EQJ:
 *        Q  = (-sin a0, cos a0, 0)
 *        Xb = Q cos W + (n x Q) sin W      (lat 0, lon 0)
 *        Yb = n x Xb                       (lat 0, lon +90 E)
 *        Zb = n                            (north pole)
 * 3. The Sun as seen from the Moon is  s = -HelioVector(Moon)  (EQJ, heliocentric position of the
 *    Moon's centre; light-time (~8 min -> 0.004 deg of lunar rotation) is neglected).
 * 4. Sub-solar point:  lon = atan2(s.Yb, s.Xb),  lat = asin(s.Zb / |s|).
 *
 * Validation (see the renderer report): the same construction applied to the Earth direction
 * (-GeoMoon) reproduces astronomy-engine's independent `Libration()` sub-Earth lat/lon (Meeus
 * ch. 53) to a few hundredths of a degree, and at full / new moon the sub-solar longitude equals
 * the sub-Earth longitude / its antipode (i.e. ~0 / ~180 deg, +- libration).
 */
import { Body, GeoMoon, HelioVector, RotationAxis } from 'astronomy-engine';
import type { LatLon } from '../types';

const D2R = Math.PI / 180;

type V3 = [number, number, number];

function bodyCoords(date: Date, s: V3): LatLon {
  const axis = RotationAxis(Body.Moon, date);
  const n: V3 = [axis.north.x, axis.north.y, axis.north.z];
  const a0 = axis.ra * 15 * D2R;
  const w = axis.spin * D2R;
  const q: V3 = [-Math.sin(a0), Math.cos(a0), 0];
  // m = n x q
  const m: V3 = [n[1] * q[2] - n[2] * q[1], n[2] * q[0] - n[0] * q[2], n[0] * q[1] - n[1] * q[0]];
  const cw = Math.cos(w);
  const sw = Math.sin(w);
  const xb: V3 = [q[0] * cw + m[0] * sw, q[1] * cw + m[1] * sw, q[2] * cw + m[2] * sw];
  const yb: V3 = [n[1] * xb[2] - n[2] * xb[1], n[2] * xb[0] - n[0] * xb[2], n[0] * xb[1] - n[1] * xb[0]];
  const len = Math.hypot(s[0], s[1], s[2]);
  const x = (s[0] * xb[0] + s[1] * xb[1] + s[2] * xb[2]) / len;
  const y = (s[0] * yb[0] + s[1] * yb[1] + s[2] * yb[2]) / len;
  const z = (s[0] * n[0] + s[1] * n[1] + s[2] * n[2]) / len;
  return { lat: Math.asin(Math.max(-1, Math.min(1, z))) / D2R, lon: Math.atan2(y, x) / D2R };
}

/** Selenographic lat/lon (degrees) of the point where the Sun is at the zenith. */
export function subSolarPoint(date: Date): LatLon {
  const h = HelioVector(Body.Moon, date);
  return bodyCoords(date, [-h.x, -h.y, -h.z]);
}

/** Selenographic lat/lon (degrees) of the point where the Earth is at the zenith (optical libration). */
export function subEarthPoint(date: Date): LatLon {
  const g = GeoMoon(date);
  return bodyCoords(date, [-g.x, -g.y, -g.z]);
}

/** Unit vector in renderer world space (see types.ts) for a selenographic lat/lon in degrees. */
export function latLonToVec(lat: number, lon: number): V3 {
  const la = lat * D2R;
  const lo = lon * D2R;
  return [Math.cos(la) * Math.sin(lo), Math.sin(la), Math.cos(la) * Math.cos(lo)];
}
