/**
 * Cloudflare Pages Function: same-origin, edge-cached proxy for NASA Moon Trek LROC WAC tiles.
 *
 *   GET /tiles/{z}/{row}/{col}.jpg
 *     -> https://trek.nasa.gov/tiles/Moon/EQ/LRO_WAC_Mosaic_Global_303ppd_v02/1.0.0/
 *        default/default028mm/{z}/{row}/{col}.jpg
 *
 * Tile matrix set "default028mm" (from the layer's WMTSCapabilities.xml):
 *   - equirectangular, top-left corner lon -180 / lat +90, so row 0 is the NORTH edge
 *   - 256 x 256 px JPEG tiles
 *   - levels 0..8; level z has 2^(z+1) columns and 2^z rows (z=0: 2x1 ... z=8: 512x256)
 *
 * Only canonical, in-range tile addresses are forwarded, so this cannot be used as an open proxy.
 * No npm dependencies: the few Workers-specific types needed are declared inline below.
 */

const UPSTREAM_BASE =
  'https://trek.nasa.gov/tiles/Moon/EQ/LRO_WAC_Mosaic_Global_303ppd_v02/1.0.0/default/default028mm';

export const MAX_ZOOM = 8;
const UPSTREAM_TIMEOUT_MS = 15_000;
const TILE_TTL_S = 60 * 60 * 24 * 30; // edge + browser lifetime of a good tile (the mosaic is static)
const NOT_FOUND_TTL_S = 300;

const CACHE_OK = `public, max-age=${TILE_TTL_S}, s-maxage=${TILE_TTL_S}, immutable`;
const CACHE_NOT_FOUND = `public, max-age=${NOT_FOUND_TTL_S}`;
const CACHE_BAD_REQUEST = 'public, max-age=3600';

// ---- minimal inline Workers / Pages typings -------------------------------------------------
interface PagesContext {
  request: Request;
  waitUntil(promise: Promise<unknown>): void;
}
interface CfRequestInit extends RequestInit {
  cf?: {
    cacheEverything?: boolean;
    cacheTtl?: number;
    cacheTtlByStatus?: Record<string, number>;
  };
}
interface EdgeCache {
  match(request: Request | string): Promise<Response | undefined>;
  put(request: Request | string, response: Response): Promise<void>;
}
// ---------------------------------------------------------------------------------------------

export interface TileAddress {
  z: number;
  row: number;
  col: number;
}

/** Canonical decimal integer: no sign, no leading zeros, at most 4 digits. */
const TILE_PATH = /^\/tiles\/(0|[1-9]\d{0,1})\/(0|[1-9]\d{0,3})\/(0|[1-9]\d{0,3})\.jpg$/;

/** Returns the tile address for a valid, in-range pathname, otherwise null. */
export function parseTilePath(pathname: string): TileAddress | null {
  const m = TILE_PATH.exec(pathname);
  if (!m) return null;
  const z = Number(m[1]);
  const row = Number(m[2]);
  const col = Number(m[3]);
  if (z > MAX_ZOOM) return null;
  const rows = 1 << z;
  const cols = 2 << z;
  if (row >= rows || col >= cols) return null;
  return { z, row, col };
}

export function upstreamUrl(t: TileAddress): string {
  return `${UPSTREAM_BASE}/${t.z}/${t.row}/${t.col}.jpg`;
}

function plain(status: number, message: string, cacheControl: string, extra?: Record<string, string>): Response {
  return new Response(message + '\n', {
    status,
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': cacheControl,
      'Access-Control-Allow-Origin': '*',
      'X-Content-Type-Options': 'nosniff',
      ...extra,
    },
  });
}

function edgeCache(): EdgeCache | null {
  try {
    const c = (globalThis as unknown as { caches?: { default?: EdgeCache } }).caches;
    return c?.default ?? null;
  } catch {
    return null;
  }
}

/** HEAD responses must not carry a body. */
function forMethod(res: Response, method: string): Response {
  return method === 'HEAD' ? new Response(null, { status: res.status, headers: res.headers }) : res;
}

export async function onRequest(context: PagesContext): Promise<Response> {
  const { request } = context;
  const method = request.method.toUpperCase();
  if (method !== 'GET' && method !== 'HEAD') {
    return plain(405, 'Method not allowed', 'no-store', { Allow: 'GET, HEAD' });
  }

  const url = new URL(request.url);
  const tile = parseTilePath(url.pathname);
  if (!tile) {
    // Out-of-range but well-formed addresses are a plain 404; everything else is a bad request.
    const wellFormed = TILE_PATH.test(url.pathname);
    return forMethod(
      wellFormed
        ? plain(404, 'Tile out of range', CACHE_BAD_REQUEST)
        : plain(400, 'Expected /tiles/{z}/{row}/{col}.jpg', CACHE_BAD_REQUEST),
      method,
    );
  }

  // Cache key: canonical URL without query string, always GET.
  const cacheKey = new Request(`${url.origin}/tiles/${tile.z}/${tile.row}/${tile.col}.jpg`, { method: 'GET' });
  const cache = edgeCache();
  if (cache) {
    try {
      const hit = await cache.match(cacheKey);
      if (hit) {
        const res = new Response(hit.body, hit);
        res.headers.set('X-Tile-Cache', 'HIT');
        return forMethod(res, method);
      }
    } catch {
      /* cache unavailable: fall through to the origin */
    }
  }

  let upstream: Response;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);
  try {
    const init: CfRequestInit = {
      method: 'GET',
      headers: { Accept: 'image/jpeg,image/*;q=0.8' },
      redirect: 'error',
      signal: controller.signal,
      cf: {
        cacheEverything: true,
        cacheTtlByStatus: { '200-299': TILE_TTL_S, '404': NOT_FOUND_TTL_S, '500-599': 0 },
      },
    };
    upstream = await fetch(upstreamUrl(tile), init);
  } catch {
    clearTimeout(timer);
    return forMethod(plain(502, 'Upstream tile server unreachable', 'no-store'), method);
  }

  try {
    if (upstream.status === 404) {
      await upstream.body?.cancel();
      const res = plain(404, 'Tile not found', CACHE_NOT_FOUND);
      if (cache) context.waitUntil(cache.put(cacheKey, res.clone()).catch(() => undefined));
      return forMethod(res, method);
    }

    const type = (upstream.headers.get('Content-Type') ?? '').toLowerCase();
    if (upstream.status !== 200 || !type.startsWith('image/')) {
      await upstream.body?.cancel();
      return forMethod(plain(502, `Upstream error (${upstream.status})`, 'no-store'), method);
    }

    // Buffer the (small, ~10-60 kB) tile so a mid-stream upstream failure cannot be cached as a 200.
    const body = await upstream.arrayBuffer();
    const headers = new Headers({
      'Content-Type': 'image/jpeg',
      'Cache-Control': CACHE_OK,
      'Access-Control-Allow-Origin': '*',
      'Cross-Origin-Resource-Policy': 'cross-origin',
      'X-Content-Type-Options': 'nosniff',
      'X-Tile-Cache': 'MISS',
    });
    for (const name of ['ETag', 'Last-Modified']) {
      const value = upstream.headers.get(name);
      if (value) headers.set(name, value);
    }
    const res = new Response(body, { status: 200, headers });
    if (cache) context.waitUntil(cache.put(cacheKey, res.clone()).catch(() => undefined));
    return forMethod(res, method);
  } catch {
    return forMethod(plain(502, 'Upstream tile transfer failed', 'no-store'), method);
  } finally {
    clearTimeout(timer);
  }
}
