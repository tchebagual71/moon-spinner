#!/usr/bin/env python3
"""
moon-spinner data pipeline.

Downloads real lunar data products into tools/cache/ (git-ignored) and bakes the web assets
in public/data/ described by the `Manifest` interface in src/types.ts.

    python3 tools/build_data.py            # everything (low-res tiers first, then high-res)
    python3 tools/build_data.py --quick    # only the low-res tiers from the small sources
    python3 tools/build_data.py --force    # rebuild outputs that already exist

Requirements: numpy, Pillow, tifffile (+ imagecodecs for LZW TIFFs).  No GDAL.

RASTER CONVENTION (all outputs): equirectangular, pixel registered, left edge lon = -180,
centre lon = 0, right edge lon = +180, top row lat = +90.

SOURCES
  * NASA SVS "CGI Moon Kit" (https://svs.gsfc.nasa.gov/4720/): lroc_color_poles_*.tif — the 2019
    natural-colour map adapted from the LROC WAC Hapke-normalised mosaic (643/566/415 nm).  The WAC
    mosaic only covers 70S..70N; poleward of that SVS filled the map with the (monochrome, lower
    resolution) LOLA 1064 nm laser albedo map LDAM.  Centred on lon 0.
  * LOLA GDR (https://imbrium.mit.edu/DATA/LOLA_GDR/CYLINDRICAL/IMG/): LDEM_16/LDEM_64 elevation
    (int16, metres = DN * 0.5, relative to 1737.4 km) and LDEC_16/LDEC_64 COUNTS (number of LOLA
    shots per pixel).  These span lon 0..360 with the left edge at lon 0, so they are rolled by
    half a width to our convention.
  * LOLA polar illumination products (https://imbrium.mit.edu/EXTRAS/ILLUMINATION/, Mazarico et
    al. 2011, 2016 release): LPSR_65{N,S}_240M (binary permanent-shadow mask) and
    AVGVISIB_65{N,S}_240M (average solar visibility), polar stereographic, 240 m/px.

See confidence_layers() for the exact data-support formulas (also written to manifest.json).
"""
from __future__ import annotations

import argparse
import json
import math
import os
import re
import sys
import time
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
from PIL import Image

Image.MAX_IMAGE_PIXELS = None

ROOT = Path(__file__).resolve().parent.parent
CACHE = ROOT / "tools" / "cache"
OUT = ROOT / "public" / "data"

R_M = 1737400.0  # reference sphere radius, metres

SVS = "https://svs.gsfc.nasa.gov/vis/a000000/a004700/a004720/"
LOLA = "https://imbrium.mit.edu/DATA/LOLA_GDR/CYLINDRICAL/IMG/"
ILLUM = "https://imbrium.mit.edu/EXTRAS/ILLUMINATION/IMG/"

# ---- encoding constants (mirrored in manifest.json) -------------------------------------------
HEIGHT_MIN_M = -9200.0  # LDEM_64 spans about -9130 .. +10790 m
HEIGHT_MAX_M = 10800.0
NORMAL_GAIN = 2.0  # encoded xy = clip(n.xy * NORMAL_GAIN, -1, 1); see normal_map()
COUNTS_LOG_SCALE = 22.0  # value = round(log2(1 + count) * 22); max count 2928 -> 253
MAX_FILE_BYTES = 20 * 1024 * 1024

# ---- confidence constants ---------------------------------------------------------------------
CONF_W, CONF_H = 2048, 1024
ALT_W_FILL = 0.7  # weight of "fraction of ground cells with >=1 shot"
ALT_W_DENS = 0.3  # weight of the saturating shot-density term
ALT_DENS_SCALE = 100.0  # shots per km^2 (one per 100 m x 100 m) at which the density term reaches 1 - 1/e
IMG_FULL_ELEV_DEG = 30.0  # noon Sun elevation above which the latitude term is 1
SUN_TILT_DEG = 1.54  # lunar obliquity to the ecliptic
WAC_LAT_LIMIT = 70.0  # colour mosaic is laser-albedo fill poleward of this
FILL_FACTOR = 0.75  # imagery score multiplier where the base colour is laser-albedo fill
ILLUM_LAT = 65.0  # illumination products have complete coverage poleward of this
ILLUM_BLEND_DEG = 2.0  # blend-in width for the illumination term (65..67 deg)
AVGVIS_FLAT = 0.5  # fraction of time the Sun is up over unobstructed terrain
AVGVIS_FULL = 0.25  # sunlit at least this fraction of the time (half of flat ground) => no penalty
COMB_W_ALT = 0.5
COMB_W_IMG = 0.5


def log(msg: str) -> None:
    print(f"[{time.strftime('%H:%M:%S')}] {msg}", flush=True)


# ================================================================================================
# download + readers
# ================================================================================================
def fetch(base: str, name: str) -> Path:
    CACHE.mkdir(parents=True, exist_ok=True)
    dst = CACHE / name
    if dst.exists() and dst.stat().st_size > 0:
        return dst
    url = base + name
    log(f"download {url}")
    tmp = dst.with_name(dst.name + ".part")
    req = urllib.request.Request(url, headers={"User-Agent": "moon-data-build/1.0"})
    with urllib.request.urlopen(req, timeout=120) as r, open(tmp, "wb") as f:
        while True:
            chunk = r.read(1 << 22)
            if not chunk:
                break
            f.write(chunk)
    os.replace(tmp, dst)
    return dst


def parse_lbl(path: Path) -> dict:
    """Tiny PDS3 label reader: first occurrence of each KEY = value (units stripped)."""
    out: dict = {}
    for line in path.read_text(errors="replace").splitlines():
        m = re.match(r"\s*\^?([A-Z_]+)\s*=\s*(.+?)\s*$", line)
        if not m or m.group(1) in out:
            continue
        v = re.sub(r"<[^>]*>", "", m.group(2)).strip().strip('"')
        out[m.group(1)] = v
    return out


def read_pds_img(base: str, stem: str) -> tuple[np.ndarray, dict]:
    """Read a detached-label PDS3 16-bit image as a raw (unscaled) integer array."""
    lbl = parse_lbl(fetch(base, stem + ".LBL"))
    img = fetch(base, stem + ".IMG")
    lines, samples = int(lbl["LINES"]), int(lbl["LINE_SAMPLES"])
    assert int(lbl["SAMPLE_BITS"]) == 16 and lbl["SAMPLE_TYPE"] == "LSB_INTEGER", lbl
    a = np.fromfile(img, dtype="<i2")
    assert a.size == lines * samples, (a.size, lines, samples)
    return a.reshape(lines, samples), lbl


def read_lola_cyl(stem: str) -> tuple[np.ndarray, dict]:
    """LOLA simple-cylindrical global grid -> our lon convention (roll 0..360 to -180..180)."""
    a, lbl = read_pds_img(LOLA, stem)
    assert lbl["MAP_PROJECTION_TYPE"] == "SIMPLE CYLINDRICAL"
    assert float(lbl["WESTERNMOST_LONGITUDE"]) == 0 and float(lbl["EASTERNMOST_LONGITUDE"]) == 360
    assert float(lbl["MAXIMUM_LATITUDE"]) == 90 and lbl["POSITIVE_LONGITUDE_DIRECTION"] == "EAST"
    # source column i has centre lon (i + .5)/ppd; target column j has -180 + (j + .5)/ppd
    return np.roll(a, a.shape[1] // 2, axis=1), lbl


def read_ldem_m(stem: str) -> np.ndarray:
    a, lbl = read_lola_cyl(stem)
    assert float(lbl["SCALING_FACTOR"]) == 0.5 and float(lbl["OFFSET"]) == 1737400.0
    h = a.astype(np.float32)
    h *= 0.5
    return h


def read_color(name: str) -> np.ndarray:
    import tifffile

    a = tifffile.imread(fetch(SVS, name))
    assert a.ndim == 3 and a.shape[2] >= 3 and a.dtype == np.uint8, (a.shape, a.dtype)
    return a[:, :, :3]


# ================================================================================================
# resampling helpers
# ================================================================================================
def lat_centres(h: int) -> np.ndarray:
    return 90.0 - (np.arange(h, dtype=np.float64) + 0.5) * 180.0 / h


def lon_centres(w: int) -> np.ndarray:
    return -180.0 + (np.arange(w, dtype=np.float64) + 0.5) * 360.0 / w


def resize_wrap(a: np.ndarray, w: int, h: int, resample=Image.LANCZOS, pad_out: int = 32) -> np.ndarray:
    """Antialiased resize of a float32 equirect raster with correct wrap-around in longitude."""
    sh, sw = a.shape
    if (sw, sh) == (w, h):
        return a.astype(np.float32, copy=True)
    pad_in = pad_out * sw / w
    assert abs(pad_in - round(pad_in)) < 1e-9, "padding must map to whole pixels"
    pad_in = int(round(pad_in))
    padded = np.concatenate([a[:, -pad_in:], a, a[:, :pad_in]], axis=1).astype(np.float32, copy=False)
    im = Image.fromarray(padded, mode="F").resize((w + 2 * pad_out, h), resample)
    return np.asarray(im, dtype=np.float32)[:, pad_out:-pad_out].copy()


def srgb_to_linear(u8: np.ndarray) -> np.ndarray:
    lut = np.arange(256, dtype=np.float64) / 255.0
    lut = np.where(lut <= 0.04045, lut / 12.92, ((lut + 0.055) / 1.055) ** 2.4).astype(np.float32)
    return lut[u8]


def linear_to_srgb_u8(x: np.ndarray) -> np.ndarray:
    x = np.clip(x, 0.0, 1.0)
    y = np.where(x <= 0.0031308, x * 12.92, 1.055 * np.power(x, 1 / 2.4, dtype=np.float32) - 0.055)
    return np.clip(np.rint(y * 255.0), 0, 255).astype(np.uint8)


def save_atomic(im: Image.Image, path: Path, **kw) -> None:
    tmp = path.with_name("." + path.name + ".tmp")
    im.save(tmp, format={"png": "PNG", "jpg": "JPEG"}[path.suffix[1:]], **kw)
    os.replace(tmp, path)
    size = path.stat().st_size
    log(f"  wrote {path.name}  {im.size[0]}x{im.size[1]}  {size / 1e6:.2f} MB")
    assert size < MAX_FILE_BYTES, f"{path.name} exceeds the 20 MB budget"


# ================================================================================================
# colour
# ================================================================================================
def build_color(src: np.ndarray, w: int, h: int, path: Path) -> None:
    """Downsample in linear light (Lanczos), re-encode to sRGB, progressive JPEG."""
    if src.shape[1] == w:
        rgb = src
    else:
        chans = [linear_to_srgb_u8(resize_wrap(srgb_to_linear(src[:, :, c]), w, h)) for c in range(3)]
        rgb = np.stack(chans, axis=2)
    save_atomic(Image.fromarray(rgb, "RGB"), path, quality=91, progressive=True, optimize=True, subsampling=0)


# ================================================================================================
# height + normals
# ================================================================================================
def build_height(hm: np.ndarray, path: Path) -> None:
    """16-bit elevation packed as R = high byte, G = low byte, B = 0."""
    v = np.rint((hm - HEIGHT_MIN_M) / (HEIGHT_MAX_M - HEIGHT_MIN_M) * 65535.0)
    v = np.clip(v, 0, 65535).astype(np.uint16)
    rgb = np.zeros(hm.shape + (3,), np.uint8)
    rgb[:, :, 0] = v >> 8
    rgb[:, :, 1] = v & 255
    save_atomic(Image.fromarray(rgb, "RGB"), path, optimize=True)


def normal_map(hm: np.ndarray) -> np.ndarray:
    """
    Tangent-space normals (x = +east, y = +north, z = +up) from metric gradients at true 1x relief.

      dh/dEast  = dh/dlon / (R cos(lat)),   dh/dNorth = dh/dlat / R,   n = normalize(-hE, -hN, 1)

    Near the poles the equirect grid is hugely oversampled in longitude (a pixel is only
    cos(lat) as wide on the ground), so the east-west central difference uses a baseline of
    k = round(1/cos(lat)) pixels (capped at 1/16 of the circumference) - i.e. a baseline of about
    one pixel-height on the ground at every latitude - instead of amplifying resampling noise.

    Returns uint8 RGB with R,G = clip(n.xy * NORMAL_GAIN) and B = true n.z (0..255 -> -1..1).
    """
    h, w = hm.shape
    lat = np.deg2rad(lat_centres(h))
    dlat = math.pi / h  # radians per pixel (both axes)
    # north derivative: rows go south, so north = previous row.  One-sided at the two pole rows.
    hn = np.empty_like(hm)
    hn[1:-1] = (hm[:-2] - hm[2:]) / np.float32(2 * dlat * R_M)
    hn[0] = (hm[0] - hm[1]) / np.float32(dlat * R_M)
    hn[-1] = (hm[-2] - hm[-1]) / np.float32(dlat * R_M)
    # east derivative with latitude dependent baseline
    he = np.empty_like(hm)
    k = np.clip(np.rint(1.0 / np.cos(lat)), 1, w // 16).astype(int)
    for kk in np.unique(k):
        rows = np.nonzero(k == kk)[0]
        r0, r1 = rows[0], rows[-1] + 1
        blocks = [(r0, r1)] if np.all(np.diff(rows) == 1) else [(r, r + 1) for r in rows]
        if len(blocks) > 1:  # north and south bands share the same k
            split = np.nonzero(np.diff(rows) != 1)[0]
            edges = np.concatenate([[0], split + 1, [len(rows)]])
            blocks = [(rows[edges[i]], rows[edges[i + 1] - 1] + 1) for i in range(len(edges) - 1)]
        for a, b in blocks:
            band = hm[a:b]
            d = np.roll(band, -kk, axis=1) - np.roll(band, kk, axis=1)
            scale = (2 * kk * dlat * R_M * np.cos(lat[a:b]))[:, None].astype(np.float32)
            he[a:b] = d / scale
    inv = 1.0 / np.sqrt(he * he + hn * hn + 1.0)
    out = np.empty((h, w, 3), np.uint8)
    for c, comp in enumerate((-he * inv, -hn * inv)):
        out[:, :, c] = np.clip(np.rint(np.clip(comp * NORMAL_GAIN, -1, 1) * 127.5 + 127.5), 0, 255)
    out[:, :, 2] = np.clip(np.rint(inv * 127.5 + 127.5), 0, 255)
    clip_frac = float(np.mean(np.maximum(np.abs(he), np.abs(hn)) * inv * NORMAL_GAIN > 1.0))
    log(f"  normals {w}x{h}: {clip_frac * 100:.4f}% of pixels clipped by gain {NORMAL_GAIN}")
    return out


def build_normal(hm: np.ndarray, stem: str) -> None:
    """PNG when small enough to be worth it, otherwise 4:4:4 JPEG q93."""
    n = normal_map(hm)
    im = Image.fromarray(n, "RGB")
    for old in OUT.glob(stem + ".*"):
        old.unlink()
    if hm.shape[1] <= 2048:
        save_atomic(im, OUT / (stem + ".png"), optimize=True)
    else:
        save_atomic(im, OUT / (stem + ".jpg"), quality=93, subsampling=0, optimize=True)


# ================================================================================================
# LOLA counts
# ================================================================================================
def build_counts(path: Path) -> None:
    c, lbl = read_lola_cyl("LDEC_16")
    c = c.astype(np.int32)
    assert c.min() >= 0
    v = np.clip(np.rint(np.log2(1.0 + c) * COUNTS_LOG_SCALE), 0, 255).astype(np.uint8)
    log(f"  LDEC_16 counts: max {c.max()}, zero-shot pixels {np.mean(c == 0) * 100:.2f}%")
    save_atomic(Image.fromarray(v, "L"), path, optimize=True)


# ================================================================================================
# confidence
# ================================================================================================
def altimetry_score() -> np.ndarray:
    """
    Altimetry support from LDEC_64 (number of LOLA shots that went into every LDEM_64 pixel).

    LDEM_64 pixels are 474 m tall but only 474 m * cos(lat) wide, so to compare like with like the
    pixels of every row are first grouped along longitude into round(W * cos(lat)) ground cells
    (each pixel belongs to exactly one cell; cells are ~474 m x 474 m at every latitude).
    Per ground cell:
        fill    = 1 if the cell contains >= 1 real shot else 0 (0 => LDEM value is interpolated)
        density = shots / cell area [km^-2]
    Both are area-averaged (box filter) to the 2048x1024 confidence grid, then
        A = 0.7 * mean(fill) + 0.3 * (1 - exp(-mean(density) / 100 km^-2))
    """
    c, lbl = read_lola_cyl("LDEC_64")
    assert c.min() >= 0
    h, w = c.shape
    lat = np.deg2rad(lat_centres(h))
    px = math.pi / h * R_M / 1000.0  # km per pixel in latitude
    fill = np.empty((h, w), np.float32)
    dens = np.empty((h, w), np.float32)
    centres = np.arange(w, dtype=np.float64) + 0.5
    for r in range(h):
        row = c[r].astype(np.float64)
        ncell = max(8, int(round(w * math.cos(lat[r]))))
        if ncell >= w:
            sums, per_px = row, row
            filled = row > 0
        else:
            idx = np.floor(centres * (ncell / w)).astype(np.int64)
            sums = np.bincount(idx, weights=row, minlength=ncell)
            npx = np.bincount(idx, minlength=ncell)
            filled = (sums > 0)[idx]
            per_px = (sums / npx)[idx]  # shots spread evenly over the cell's pixels
        fill[r] = filled
        dens[r] = per_px / (px * px * math.cos(lat[r]))
    del c
    fill2 = resize_wrap(fill, CONF_W, CONF_H, Image.BOX)
    dens2 = resize_wrap(dens, CONF_W, CONF_H, Image.BOX)
    for name, a in (("fill", fill2), ("density/km2", dens2)):
        prof = [float(a[int((90 - la) / 180 * CONF_H)].mean()) for la in (0, 30, 60, 75, 85, 89)]
        log(f"  altimetry {name} mean at lat 0/30/60/75/85/89: " + ", ".join(f"{p:.2f}" for p in prof))
    return np.clip(ALT_W_FILL * fill2 + ALT_W_DENS * (1.0 - np.exp(-dens2 / ALT_DENS_SCALE)), 0, 1)


def polar_to_equirect(stem: str, north: bool, w: int, h: int, max_abs_lat: float = ILLUM_LAT):
    """
    Area-average a LOLA polar-stereographic product onto our equirect grid.

    LOLA polar convention (spherical stereographic, true scale at the pole, lon 0 towards the
    bottom of the image at the north pole and towards the top at the south pole):
        r = 2 R tan((90 - |lat|) / 2)
        north: x =  r sin(lon), y = -r cos(lon);   south: x = r sin(lon), y = r cos(lon)
        sample = x / scale + S0,  line = L0 - y / scale
    Returns (values, valid) for the rows poleward of max_abs_lat; other pixels are invalid.
    """
    raw, lbl = read_pds_img(ILLUM, stem)
    assert lbl["MAP_PROJECTION_TYPE"] == "POLAR STEREOGRAPHIC"
    assert float(lbl["CENTER_LATITUDE"]) == (90 if north else -90) and float(lbl["CENTER_LONGITUDE"]) == 0
    scale = float(lbl["MAP_SCALE"])  # m/pix
    l0, s0 = float(lbl["LINE_PROJECTION_OFFSET"]), float(lbl["SAMPLE_PROJECTION_OFFSET"])
    val = raw.astype(np.float32) * np.float32(float(lbl["SCALING_FACTOR"])) + np.float32(float(lbl["OFFSET"]))
    n = raw.shape[0]
    del raw
    # ---- forward binning (area average where a target pixel holds several source pixels)
    yy, xx = np.mgrid[0:n, 0:n].astype(np.float32)
    x = (xx - s0) * scale
    y = (l0 - yy) * scale
    del xx, yy
    r = np.hypot(x, y)
    colat = np.rad2deg(2.0 * np.arctan(r / (2.0 * R_M)))
    lon = np.rad2deg(np.arctan2(x, -y if north else y))
    del x, y, r
    lat = (90.0 - colat) if north else (colat - 90.0)
    row = np.floor((90.0 - lat) / 180.0 * h).astype(np.int64)
    col = np.floor((lon + 180.0) / 360.0 * w).astype(np.int64) % w
    ok = (colat <= 90.0 - max_abs_lat + 0.5) & (row >= 0) & (row < h)
    idx = (row[ok] * w + col[ok])
    acc = np.bincount(idx, weights=val[ok].astype(np.float64), minlength=w * h).reshape(h, w)
    cnt = np.bincount(idx, minlength=w * h).reshape(h, w)
    del row, col, ok, idx, lat, lon, colat
    # ---- inverse (bilinear) sampling for target pixels smaller than a source pixel
    la = lat_centres(h)
    rows = np.nonzero((la >= max_abs_lat) if north else (la <= -max_abs_lat))[0]
    lo = np.deg2rad(lon_centres(w))[None, :]
    rr = 2.0 * R_M * np.tan(np.deg2rad(90.0 - np.abs(la[rows])) / 2.0)[:, None]
    xs = rr * np.sin(lo) / scale + s0
    ys = l0 - (rr * (-np.cos(lo) if north else np.cos(lo))) / scale
    x0 = np.clip(np.floor(xs).astype(int), 0, n - 2)
    y0 = np.clip(np.floor(ys).astype(int), 0, n - 2)
    fx, fy = np.clip(xs - x0, 0, 1), np.clip(ys - y0, 0, 1)
    bil = (val[y0, x0] * (1 - fx) * (1 - fy) + val[y0, x0 + 1] * fx * (1 - fy)
           + val[y0 + 1, x0] * (1 - fx) * fy + val[y0 + 1, x0 + 1] * fx * fy)
    out = np.zeros((h, w), np.float32)
    valid = np.zeros((h, w), bool)
    sub_cnt = cnt[rows]
    binned = acc[rows] / np.maximum(sub_cnt, 1)
    out[rows] = np.where(sub_cnt >= 4, binned, bil)
    valid[rows] = True
    return out, valid


def imagery_layers(w: int = CONF_W, h: int = CONF_H) -> dict:
    """Real polar illumination data on the confidence grid: PSR fraction and average visibility."""
    psr = np.zeros((h, w), np.float32)
    vis = np.full((h, w), AVGVIS_FLAT, np.float32)
    valid = np.zeros((h, w), bool)
    for north in (True, False):
        tag = "N" if north else "S"
        p, ok = polar_to_equirect(f"LPSR_65{tag}_240M_201608", north, w, h)
        v, _ = polar_to_equirect(f"AVGVISIB_65{tag}_240M_201608", north, w, h)
        psr[ok], vis[ok], valid[ok] = p[ok], v[ok], True
    return {"psr": np.clip(psr, 0, 1), "vis": np.clip(vis, 0, 1), "valid": valid}


def smoothstep(e0: float, e1: float, x: np.ndarray) -> np.ndarray:
    t = np.clip((x - e0) / (e1 - e0), 0, 1)
    return t * t * (3 - 2 * t)


def imagery_score(layers: dict) -> np.ndarray:
    """
    G = L(lat) * F(lat) * S

      L = sqrt(min(1, sin(e_noon) / sin(30 deg))),  e_noon = 90 - |lat| + 1.54 deg
          best-case (local noon, favourable season) Sun elevation: optical imaging is unaffected
          until the noon Sun is lower than 30 deg (|lat| > 61.5), then degrades with the cosine of
          the incidence angle (square root: SNR-like).
      F = 1 for |lat| < 70, 0.75 poleward (smoothstep 69.5..70.5): the baked colour map is real
          LROC WAC photography only between 70S and 70N; beyond that it is monochrome LOLA laser
          albedo fill (photography poleward of 70 deg exists only in the streamed WAC tiles).
      S = 1 equatorward of 65 deg.  Poleward (blended in over 65..67 deg), from the LOLA polar
          illumination products: S = (1 - PSR fraction) * min(1, AVGVISIB / 0.25), where AVGVISIB
          is the fraction of time the ground is sunlit (about 0.45 on open ground at 66 deg,
          about 0.15 at the poles): zero in permanent shadow, reduced where the ground is lit
          less than half as often as an unobstructed plain (0.5).
    """
    hgt, wid = layers["psr"].shape
    alat = np.abs(lat_centres(hgt))[:, None]
    e_noon = np.deg2rad(np.minimum(90.0, 90.0 - alat + SUN_TILT_DEG))
    L = np.sqrt(np.minimum(1.0, np.sin(e_noon) / math.sin(math.radians(IMG_FULL_ELEV_DEG))))
    F = 1.0 - (1.0 - FILL_FACTOR) * smoothstep(WAC_LAT_LIMIT - 0.5, WAC_LAT_LIMIT + 0.5, alat)
    s_polar = (1.0 - layers["psr"]) * np.minimum(1.0, layers["vis"] / AVGVIS_FULL)
    wgt = smoothstep(ILLUM_LAT, ILLUM_LAT + ILLUM_BLEND_DEG, alat) * layers["valid"]
    S = 1.0 - wgt * (1.0 - s_polar)
    return np.clip(L * F * S, 0, 1).astype(np.float32)


def build_confidence(path: Path) -> None:
    alt = altimetry_score()
    img = imagery_score(imagery_layers())
    comb = COMB_W_ALT * alt + COMB_W_IMG * img
    wts = np.cos(np.deg2rad(lat_centres(CONF_H)))[:, None] * np.ones((1, CONF_W))
    for name, a in (("altimetry", alt), ("imagery", img), ("combined", comb)):
        log(f"  {name}: area-weighted mean {np.average(a, weights=wts) * 100:.1f}%, min {a.min() * 100:.0f}%, max {a.max() * 100:.0f}%")
    rgb = np.stack([np.clip(np.rint(a * 255), 0, 255).astype(np.uint8) for a in (alt, img, comb)], axis=2)
    save_atomic(Image.fromarray(rgb, "RGB"), path, optimize=True)


# ================================================================================================
# manifest
# ================================================================================================
SOURCES = [
    {
        "id": "lroc-wac-color",
        "title": "LROC WAC natural-colour global mosaic (CGI Moon Kit, lroc_color_poles_16k.tif)",
        "provider": "NASA Scientific Visualization Studio / LROC team, Arizona State University",
        "url": "https://svs.gsfc.nasa.gov/4720/",
        "note": "Base colour. Adapted by NASA SVS (Ernie Wright, 2019) from the Hapke-normalised mosaic of >100,000 LRO Wide Angle Camera images (643/566/415 nm as R/G/B). The photographic mosaic covers 70°S–70°N; poleward of that SVS filled the map with monochrome LOLA laser-albedo data. Downsampled here from 16384×8192 in linear light.",
    },
    {
        "id": "lola-ldem",
        "title": "LOLA Gridded Data Record LDEM_64 / LDEM_16 (global elevation, 64 and 16 px/deg)",
        "provider": "NASA GSFC / MIT — Lunar Orbiter Laser Altimeter team, PDS Geosciences Node",
        "url": "https://imbrium.mit.edu/DATA/LOLA_GDR/CYLINDRICAL/IMG/",
        "note": "Elevation in metres relative to a 1737.4 km sphere (DN × 0.5 m). Source of the height maps and of the normal maps, which are computed from true metric slopes at 1× relief.",
    },
    {
        "id": "lola-ldec",
        "title": "LOLA Gridded Data Record LDEC_64 / LDEC_16 (laser shot counts per pixel)",
        "provider": "NASA GSFC / MIT — Lunar Orbiter Laser Altimeter team, PDS Geosciences Node",
        "url": "https://imbrium.mit.edu/DATA/LOLA_GDR/CYLINDRICAL/IMG/",
        "note": "Number of real altimeter measurements behind every elevation pixel (data through 2016-11-29). Pixels with zero counts were interpolated by the LOLA team. Basis of the altimetry score; LDEC_16 is shipped log-encoded as lola_counts.png.",
    },
    {
        "id": "lola-illumination",
        "title": "LOLA polar illumination products: LPSR_65N/S_240M (permanently shadowed regions) and AVGVISIB_65N/S_240M (average solar visibility), 2016-08 release",
        "provider": "NASA GSFC LOLA team (Mazarico et al. 2011, Icarus 211) — unsupported EXTRAS products",
        "url": "https://imbrium.mit.edu/EXTRAS/ILLUMINATION/",
        "note": "Computed by the LOLA team from polar topography, 240 m/px, complete poleward of 65°. Used for the imagery score near the poles: permanently shadowed ground can never appear in sunlit photographs.",
    },
    {
        "id": "trek-wac-tiles",
        "title": "LRO WAC Global Mosaic 100 m (303 px/deg) v02 — streamed tiles",
        "provider": "NASA Solar System Treks (Moon Trek), JPL / LROC team, Arizona State University",
        "url": "https://trek.nasa.gov/tiles/Moon/EQ/LRO_WAC_Mosaic_Global_303ppd_v02/",
        "note": "Monochrome 100 m/px mosaic streamed on demand for close-up views. Not baked into this site; availability depends on the NASA tile service.",
    },
    {
        "id": "iau-gazetteer",
        "title": "Gazetteer of Planetary Nomenclature (lunar feature names)",
        "provider": "International Astronomical Union (IAU) Working Group for Planetary System Nomenclature / USGS Astrogeology Science Center",
        "url": "https://planetarynames.wr.usgs.gov/",
        "note": "Official names, positions and sizes of lunar features used for labels and search.",
    },
]

CONFIDENCE_METHOD = {
    "altimetry": (
        "How much of the terrain shape was actually measured by LRO's laser altimeter (LOLA) rather than interpolated. "
        "From the LOLA shot-count grid LDEC_64 (shots per elevation pixel, 64 px/deg), counts are grouped into ground cells "
        "of about 474 m × 474 m (pixels are merged along longitude by 1/cos(latitude) so cells have the same ground size at every latitude). "
        "Score = 0.7 × (fraction of cells containing at least one real laser shot) + 0.3 × (1 − exp(−shots per km² / 100)), "
        "area-averaged over each pixel of a 2048×1024 map. LRO's polar orbit makes ground tracks converge at the poles, so coverage is "
        "densest there and thinnest in the gaps between tracks near the equator."
    ),
    "imagery": (
        "How well sunlit photography can show this place. Score = L × F × S. "
        "L = sqrt(min(1, sin(e)/sin(30°))) where e = 90° − |latitude| + 1.54° is the highest the Sun ever gets at local noon: no penalty "
        "until the noon Sun is below 30° (latitudes beyond about 61.5°), then a growing penalty for grazing light and long shadows. "
        "F = 0.75 poleward of 70° latitude (1 elsewhere) because the base colour map there is not photography: the LROC WAC colour mosaic stops at 70° "
        "and NASA SVS filled the caps with monochrome LOLA laser-albedo data. "
        "S uses the LOLA team's polar illumination maps (240 m/px) poleward of 65°, blended in between 65° and 67°: "
        "S = (1 − fraction of the pixel in permanent shadow) × min(1, fraction of time sunlit / 0.25); it is 0 in permanently shadowed "
        "craters, which have never been seen in direct sunlight, and reduced where the ground is lit less than half as often as an open plain. "
        "S = 1 at lower latitudes."
    ),
    "combined": (
        "Combined = 0.5 × altimetry + 0.5 × imagery (a plain average, so excellent laser coverage of a permanently shadowed crater still "
        "counts for half). These scores are an index computed by this app from the published coverage and illumination products listed under "
        "sources; they are not an official NASA or LRO quality metric, and they describe global-map data support, not the accuracy of any single measurement."
    ),
}


def tier(path: Path) -> dict:
    with Image.open(path) as im:
        w, h = im.size
    return {"url": f"/data/{path.name}", "width": w, "height": h}


def tiers(prefix: str) -> list[dict]:
    files = [p for p in OUT.glob(prefix + "_*k.*") if p.suffix in (".png", ".jpg") and not p.name.startswith(".")]
    return sorted((tier(p) for p in files), key=lambda t: t["width"])


def write_manifest() -> None:
    """Scan public/data and atomically (re)write manifest.json listing only tiers that exist."""
    color, normal, height = tiers("color"), tiers("normal"), tiers("height")
    conf, counts = OUT / "confidence.png", OUT / "lola_counts.png"
    if not (color and normal and height and conf.exists() and counts.exists()):
        return
    manifest = {
        "generated": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "color": color,
        "normal": normal,
        "normalGain": NORMAL_GAIN,
        "height": height,
        "heightRange": {"minMeters": HEIGHT_MIN_M, "maxMeters": HEIGHT_MAX_M},
        "confidence": tier(conf),
        "lolaCounts": {**tier(counts), "countsLogScale": COUNTS_LOG_SCALE, "sourcePixelsPerDegree": 16},
        "sources": SOURCES,
        "confidenceMethod": CONFIDENCE_METHOD,
    }
    tmp = OUT / ".manifest.json.tmp"
    tmp.write_text(json.dumps(manifest, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    os.replace(tmp, OUT / "manifest.json")
    total = sum(p.stat().st_size for p in OUT.iterdir() if p.is_file())
    log(f"manifest.json: color {len(color)}, normal {len(normal)}, height {len(height)} tiers; public/data total {total / 1e6:.1f} MB")


# ================================================================================================
# main
# ================================================================================================
def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--quick", action="store_true", help="only build the low-res tiers from the small sources")
    ap.add_argument("--force", action="store_true", help="rebuild outputs that already exist")
    args = ap.parse_args()
    OUT.mkdir(parents=True, exist_ok=True)

    def need(name: str) -> bool:
        return args.force or not (OUT / name).exists()

    def need_normal(stem: str) -> bool:
        return args.force or not list(OUT.glob(stem + ".*"))

    # ---------------- stage 1: quick low-res set from the small sources ----------------
    log("stage 1: low-res tiers (lroc_color_poles_4k, LDEM_16, LDEC_16/64)")
    if need("color_2k.jpg"):
        build_color(read_color("lroc_color_poles_4k.tif"), 2048, 1024, OUT / "color_2k.jpg")
    if need("height_1k.png") or need_normal("normal_2k"):
        dem16 = read_ldem_m("LDEM_16")
        if need("height_1k.png"):
            build_height(resize_wrap(dem16, 1024, 512), OUT / "height_1k.png")
        if need_normal("normal_2k"):
            build_normal(resize_wrap(dem16, 2048, 1024), "normal_2k")
        del dem16
    if need("lola_counts.png"):
        build_counts(OUT / "lola_counts.png")
    if need("confidence.png"):
        build_confidence(OUT / "confidence.png")
    write_manifest()
    if args.quick:
        return

    # ---------------- stage 2: high-res tiers ----------------
    log("stage 2: colour tiers from lroc_color_poles_16k")
    if args.force or need("color_4k.jpg") or need("color_8k.jpg"):
        src = read_color("lroc_color_poles_16k.tif")
        for name, w in (("color_2k.jpg", 2048), ("color_4k.jpg", 4096), ("color_8k.jpg", 8192)):
            build_color(src, w, w // 2, OUT / name)
            write_manifest()
        del src

    log("stage 2: height + normal tiers from LDEM_64")
    todo_h = [(n, w) for n, w in (("height_1k.png", 1024), ("height_2k.png", 2048), ("height_4k.png", 4096))
              if args.force or need(n) or n == "height_1k.png" and need("height_2k.png")]
    todo_n = [(s, w) for s, w in (("normal_2k", 2048), ("normal_4k", 4096), ("normal_8k", 8192))
              if args.force or need_normal(s) or s == "normal_2k" and need_normal("normal_4k")]
    if todo_h or todo_n:
        dem = read_ldem_m("LDEM_64")
        log(f"  LDEM_64 range {dem.min():.1f} .. {dem.max():.1f} m")
        assert HEIGHT_MIN_M <= dem.min() and dem.max() <= HEIGHT_MAX_M
        cache: dict[int, np.ndarray] = {}

        def at(w: int) -> np.ndarray:
            if w not in cache:
                cache[w] = resize_wrap(dem, w, w // 2)
            return cache[w]

        for name, w in todo_h:
            build_height(at(w), OUT / name)
            write_manifest()
        for stem, w in todo_n:
            build_normal(at(w), stem)
            write_manifest()
            if w > 4096:
                cache.pop(w, None)
        del dem, cache
    write_manifest()
    log("done")


if __name__ == "__main__":
    sys.exit(main())
