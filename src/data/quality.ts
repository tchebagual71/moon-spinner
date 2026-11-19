import type { QualityTier } from '../types';

const KEY = 'moon-spinner.quality';
const TIERS: QualityTier[] = ['low', 'medium', 'high'];

function isTier(v: unknown): v is QualityTier {
  return typeof v === 'string' && (TIERS as string[]).includes(v);
}

/** Heuristic tier from device capabilities. */
export function detectQuality(): QualityTier {
  const nav = navigator as Navigator & { deviceMemory?: number };
  const ua = nav.userAgent || '';
  const mobile = /Android|iPhone|iPad|iPod|Mobile/i.test(ua) || (nav.maxTouchPoints > 1 && /Macintosh/.test(ua));
  const mem = nav.deviceMemory;
  const cores = nav.hardwareConcurrency || 4;
  const dpr = Math.min(window.devicePixelRatio || 1, 3);
  const longSide = Math.max(screen.width, screen.height) * dpr;

  if ((mem !== undefined && mem <= 2) || cores <= 2) return 'low';
  if (mobile) {
    if (mem !== undefined && mem <= 3) return 'low';
    return 'medium';
  }
  if ((mem === undefined || mem >= 8) && cores >= 8 && longSide >= 1800) return 'high';
  return 'medium';
}

export interface QualityChoice {
  tier: QualityTier;
  auto: QualityTier;
  /** Where the active tier came from. */
  source: 'url' | 'saved' | 'auto';
}

export function resolveQuality(): QualityChoice {
  const auto = detectQuality();
  const q = new URLSearchParams(location.search).get('q');
  if (isTier(q)) return { tier: q, auto, source: 'url' };
  try {
    const saved = localStorage.getItem(KEY);
    if (isTier(saved)) return { tier: saved, auto, source: 'saved' };
  } catch {
    /* storage blocked */
  }
  return { tier: auto, auto, source: 'auto' };
}

/** Persist an explicit choice (or clear it with null to return to automatic). */
export function saveQuality(tier: QualityTier | null): void {
  try {
    if (tier) localStorage.setItem(KEY, tier);
    else localStorage.removeItem(KEY);
  } catch {
    /* storage blocked */
  }
  const url = new URL(location.href);
  if (url.searchParams.has('q')) {
    if (tier) url.searchParams.set('q', tier);
    else url.searchParams.delete('q');
    history.replaceState(null, '', url);
  }
}
