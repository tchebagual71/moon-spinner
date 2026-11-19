import { Body, Illumination, MoonPhase } from 'astronomy-engine';

export interface PhaseInfo {
  name: string;
  /** Illuminated fraction of the disc as seen from Earth, 0..1. */
  fraction: number;
  /** Sun–Moon ecliptic elongation, 0 = new, 90 = first quarter, 180 = full, 270 = last quarter. */
  elongation: number;
  /** Approximate sub-solar selenographic longitude (ignores libration). */
  sunLon: number;
}

function phaseName(e: number): string {
  if (e < 7 || e >= 353) return 'New Moon';
  if (e < 83) return 'Waxing crescent';
  if (e < 97) return 'First quarter';
  if (e < 173) return 'Waxing gibbous';
  if (e < 187) return 'Full Moon';
  if (e < 263) return 'Waning gibbous';
  if (e < 277) return 'Last quarter';
  return 'Waning crescent';
}

export function phaseAt(date: Date): PhaseInfo {
  const elongation = MoonPhase(date);
  const fraction = Illumination(Body.Moon, date).phase_fraction;
  let sunLon = 180 - elongation;
  if (sunLon < -180) sunLon += 360;
  return { name: phaseName(elongation), fraction, elongation, sunLon };
}
