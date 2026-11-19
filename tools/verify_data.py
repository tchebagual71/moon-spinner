#!/usr/bin/env python3
"""Registration / sanity checks for public/data (run after build_data.py).

    python3 tools/verify_data.py [crop_output_dir]

Checks that known features land where they should in every raster and that the normal-map
channel signs are R=+east, G=+north.  Optionally writes PNG crops for visual inspection.
"""
import json, sys
from pathlib import Path
import numpy as np
from PIL import Image
Image.MAX_IMAGE_PIXELS = None
ROOT = Path(__file__).resolve().parent.parent
D = ROOT / "public" / "data"
M = json.loads((D / "manifest.json").read_text())
crop_dir = Path(sys.argv[1]) if len(sys.argv) > 1 else None
fails = []

def load(t): return np.asarray(Image.open(ROOT / "public" / t["url"].lstrip("/")))
def px(a, lat, lon):
    h, w = a.shape[:2]
    return min(h - 1, int((90 - lat) / 180 * h)), int((lon + 180) / 360 * w) % w
def at(a, lat, lon): return a[px(a, lat, lon)]
def box(a, lat, lon, rdeg):
    h, w = a.shape[:2]; r, c = px(a, lat, lon); k = max(1, int(rdeg / 180 * h))
    return a[max(0, r - k):r + k + 1, np.arange(c - k, c + k + 1) % w]
def check(name, ok, detail):
    print(("PASS " if ok else "FAIL ") + name + ": " + detail)
    if not ok: fails.append(name)
def height_m(t):
    a = load(t).astype(np.float64); hr = M["heightRange"]
    return hr["minMeters"] + (a[..., 0] * 256 + a[..., 1]) / 65535 * (hr["maxMeters"] - hr["minMeters"])

TY = (-43.31, -11.36)
for t in M["height"]:
    hm = height_m(t); n = t["url"]
    floor = np.median(box(hm, TY[0], TY[1] + 0.5, 0.3)); rim = max(at(hm, TY[0], TY[1] + d) for d in (-2.0, 2.0, -1.9, 1.9, -1.8, 1.8))
    check(f"{n} Tycho depth", 3500 < rim - floor < 5500, f"rim {rim:.0f} m, floor {floor:.0f} m, depth {rim - floor:.0f} m")
    cr = np.median(box(hm, 17, 59, 3)); check(f"{n} Mare Crisium low", -4500 < cr < -3000, f"{cr:.0f} m")
    wrong = np.median(box(hm, 17, -59, 3)); check(f"{n} not mirrored", wrong > cr + 1000, f"lon -59 gives {wrong:.0f} m")
    ori = np.median(box(hm, -19.4, -92.8, 2)); orim = np.median(box(hm, -19.4, -80.5, 1))
    check(f"{n} Orientale basin", orim - ori > 2500, f"centre {ori:.0f} m, Cordillera ring (lon -80.5) {orim:.0f} m")
    spa = np.median(box(hm, -53, -169, 8)); fhl = np.median(box(hm, 5, -155, 8))
    check(f"{n} SPA low / farside highlands high", spa < -3500 and fhl > 3000, f"SPA {spa:.0f} m, highlands(5N,155W) {fhl:.0f} m")
    olym = hm.min(), hm.max(); print(f"     range {olym[0]:.0f} .. {olym[1]:.0f} m")

for t in M["color"]:
    c = load(t).astype(np.float64).mean(axis=2); n = t["url"]
    check(f"{n} Tycho bright vs Mare Nubium", np.mean(box(c, *TY, 0.8)) > np.mean(box(c, -21, -17, 3)) + 25, f"{np.mean(box(c, *TY, 0.8)):.0f} vs {np.mean(box(c, -21, -17, 3)):.0f}")
    check(f"{n} Crisium dark vs lon -59", np.mean(box(c, 17, 59, 3)) + 20 < np.mean(box(c, 17, -59 - 20, 3)), f"{np.mean(box(c, 17, 59, 3)):.0f} vs {np.mean(box(c, 17, -79, 3)):.0f}")
    check(f"{n} Tsiolkovskiy dark floor (20.4S,129.1E)", np.mean(box(c, -20.9, 128.2, 0.6)) + 30 < np.mean(box(c, -20.4, 124, 1)), f"{np.mean(box(c, -20.9, 128.2, 0.6)):.0f} vs {np.mean(box(c, -20.4, 124, 1)):.0f}")

g = M.get("normalGain", 1)
for t in M["normal"]:
    a = load(t).astype(np.float64); n = t["url"]
    nx, ny = (a[..., 0] / 127.5 - 1) / g, (a[..., 1] / 127.5 - 1) / g
    w_, e_ = np.mean(box(nx, TY[0], TY[1] - 1.45, 0.25)), np.mean(box(nx, TY[0], TY[1] + 1.45, 0.25))
    n_, s_ = np.mean(box(ny, TY[0] + 1.05, TY[1], 0.25)), np.mean(box(ny, TY[0] - 1.05, TY[1], 0.25))
    check(f"{n} R=+east (Tycho W wall faces east, E wall faces west)", w_ > 0.1 and e_ < -0.1, f"nx W {w_:+.2f}, E {e_:+.2f}")
    check(f"{n} G=+north (Tycho N wall faces south, S wall faces north)", n_ < -0.1 and s_ > 0.1, f"ny N {n_:+.2f}, S {s_:+.2f}")
    # consistency with the height map: normals recomputed from the matching/lower height tier
    nz = a[..., 2] / 127.5 - 1
    check(f"{n} unit length after un-gaining", abs(np.median(nx**2 + ny**2 + nz**2) - 1) < 0.03, f"median |n|^2 {np.median(nx**2 + ny**2 + nz**2):.3f}")
    pole = np.abs(nx[:3]).max(), np.abs(nx[-3:]).max(); print(f"     max |nx| in 3 pole rows N {pole[0]:.2f} S {pole[1]:.2f}; flat fraction |n.xy|<0.02: {np.mean(np.hypot(nx, ny) < 0.02):.2f}")

lc = load(M["lolaCounts"]); cnt = np.rint(2 ** (lc / M["lolaCounts"]["countsLogScale"]) - 1)
_ppd = M["lolaCounts"]["sourcePixelsPerDegree"]; _km = np.pi / 180 * 1737.4 / _ppd
_d = lambda la: cnt[int((90 - la) * _ppd)].mean() / (_km * _km * np.cos(np.radians(la)))
check("lola_counts density polar >> equatorial", _d(88) > 5 * _d(0.5), f"shots/km^2 at 88N: {_d(88):.0f}, 60N: {_d(60):.0f}, equator: {_d(0.5):.0f}")
cf = load(M["confidence"]).astype(np.float64) / 255
lat = 90 - (np.arange(cf.shape[0]) + .5) * 180 / cf.shape[0]
for nm, ch in (("altimetry", 0), ("imagery", 1), ("combined", 2)):
    print(f"     {nm} zonal mean % at lat 0,30,60,68,72,80,85,89 N: " + " ".join(f"{cf[px(cf, la, 0)[0], :, ch].mean() * 100:.0f}" for la in (0, 30, 60, 68, 72, 80, 85, 89)))
check("altimetry: equator < poles", cf[500:524, :, 0].mean() + .15 < cf[:30, :, 0].mean(), f"{cf[500:524, :, 0].mean():.2f} vs {cf[:30, :, 0].mean():.2f}")
for nm, la, lo in (("Shackleton", -89.67, 129.2), ("Haworth", -87.45, -5.2), ("Shoemaker", -88.1, 45.3), ("Faustini", -87.2, 84.3), ("Cabeus", -85.3, -42.1), ("Hermite A", 87.8, -47.1)):
    v = box(cf[..., 1], la, lo, 0.25).min(); check(f"imagery ~0 in PSR crater {nm}", v < 0.12, f"min imagery {v * 100:.0f}%")
# illumination orientation: sunlit-availability must correlate with equator-facing slope
n2 = load(M["normal"][0]).astype(np.float64); ny = n2[..., 1] / 127.5 - 1
im = cf[..., 1]
for nm, rows, sgn in (("north", slice(15, 110), -1), ("south", slice(-110, -15), 1)):
    base = im[rows] / np.maximum(im[rows].mean(axis=1, keepdims=True), 1e-6); sl = sgn * ny[rows]
    r0 = np.corrcoef(base.ravel(), sl.ravel())[0, 1]
    alt = {"lon-mirrored": np.corrcoef(base[:, ::-1].ravel(), sl.ravel())[0, 1], "rolled 180": np.corrcoef(np.roll(base, base.shape[1] // 2, 1).ravel(), sl.ravel())[0, 1],
           "mirrored+rolled": np.corrcoef(np.roll(base[:, ::-1], base.shape[1] // 2, 1).ravel(), sl.ravel())[0, 1]}
    check(f"illumination registration {nm}", r0 > 0.3 and r0 > 3 * max(abs(v) for v in alt.values()), f"corr(imagery, equator-facing slope) {r0:.2f}; wrong orientations: " + ", ".join(f"{k} {v:.2f}" for k, v in alt.items()))

if crop_dir:
    crop_dir.mkdir(parents=True, exist_ok=True)
    def crop(t, lat, lon, half, name, size=384):
        a = load(t); h, w = a.shape[:2]; r, c = px(a, lat, lon); k = int(half / 180 * h)
        Image.fromarray(a[max(0, r - k):r + k, np.arange(c - k, c + k) % w]).resize((size, size), Image.LANCZOS if k > size // 2 else Image.NEAREST).save(crop_dir / name)
    crop(M["color"][-1], *TY, 5, "tycho_color.png"); crop(M["normal"][-1], *TY, 5, "tycho_normal.png")
    hm = height_m(M["height"][-1]); r, c = px(hm, *TY); k = int(5 / 180 * hm.shape[0]); sub = hm[r - k:r + k, c - k:c + k]
    Image.fromarray(np.uint8(255 * (sub - sub.min()) / np.ptp(sub))).resize((384, 384)).save(crop_dir / "tycho_height.png")
    for t, nm in ((M["color"][0], "global_color.png"), (M["normal"][0], "global_normal.png"), (M["confidence"], "global_conf.png"), (M["lolaCounts"], "global_counts.png")):
        Image.open(ROOT / "public" / t["url"].lstrip("/")).resize((1024, 512), Image.LANCZOS).save(crop_dir / nm)
    h1 = height_m(M["height"][0]); Image.fromarray(np.uint8(255 * (h1 - h1.min()) / np.ptp(h1))).save(crop_dir / "global_height.png")
    c = load(M["confidence"]); Image.fromarray(c[-140:, :, :]).save(crop_dir / "conf_south.png"); Image.fromarray(c[430:600, 900:1150]).resize((750, 510), Image.NEAREST).save(crop_dir / "conf_equator.png")
print("\n%d failure(s)" % len(fails)); sys.exit(1 if fails else 0)
