#!/usr/bin/env python3
"""Build public/data/features.json from the IAU/USGS Gazetteer of Planetary Nomenclature.

Source (official USGS Astrogeology bulk export, regenerated regularly, linked from
https://planetarynames.wr.usgs.gov/GIS_Downloads):

    https://asc-planetarynames-data.s3.us-west-2.amazonaws.com/MOON_nomenclature_center_pts.kmz

The KML inside carries one Placemark per named feature with `center_lat`, `center_lon`
(planetocentric, 0..360, EAST positive), `diameter` (km), `type` ("Crater, craters"),
and `approval` ("Adopted by IAU" for approved names).

Output: compact JSON array of LunarFeature {name,type,lat,lon,diameterKm} (see src/types.ts),
lon normalised to [-180, 180] east positive, sorted by descending diameter.

Usage:  python3 tools/build_gazetteer.py [--refresh]
Only the Python 3 standard library is required (requests is used if installed).
"""
from __future__ import annotations

import io
import json
import os
import sys
import urllib.request
import xml.etree.ElementTree as ET
import zipfile

SOURCE_URL = (
    "https://asc-planetarynames-data.s3.us-west-2.amazonaws.com/"
    "MOON_nomenclature_center_pts.kmz"
)
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CACHE_DIR = os.path.join(ROOT, "tools", "cache")
CACHE_FILE = os.path.join(CACHE_DIR, "MOON_nomenclature_center_pts.kmz")
OUT_FILE = os.path.join(ROOT, "public", "data", "features.json")
KML_NS = "{http://www.opengis.net/kml/2.2}"
APPROVED = "adopted by iau"

# Gazetteer "singular, plural" -> label used by the app. English descriptor terms are
# kept in singular English; Latin IAU descriptor terms are kept as the Latin singular.
TYPE_OVERRIDES = {
    "Landing site name": "Landing site name",
    "Statio": "Landing site name",  # the export labels the IAU "Landing site name" type as "Statio"
    "Satellite Feature": "Satellite Feature",
    "Astronaut-named features": "Astronaut-named feature",
    "Albedo Feature": "Albedo feature",
}

# (name, lat, lon east-positive, tolerance in degrees): sign/convention sanity checks, not
# precision checks (the gazetteer centre of Mare Orientale is 19.87S 94.67W).
CHECKS = [
    ("Tycho", -43.31, -11.36, 0.3),
    ("Mare Crisium", 17.0, 59.1, 1.0),
    ("Mare Orientale", -19.4, -92.8, 2.5),
    ("Tsiolkovskiy", -20.4, 129.1, 0.5),
    ("Shackleton", -89.67, None, 0.3),
    ("Copernicus", 9.62, -20.08, 0.3),
]


def download(refresh: bool) -> bytes:
    if os.path.exists(CACHE_FILE) and not refresh:
        with open(CACHE_FILE, "rb") as fh:
            return fh.read()
    print(f"downloading {SOURCE_URL}", file=sys.stderr)
    try:
        import requests  # type: ignore

        resp = requests.get(SOURCE_URL, timeout=180)
        resp.raise_for_status()
        data = resp.content
    except ImportError:
        req = urllib.request.Request(SOURCE_URL, headers={"User-Agent": "gazetteer-build/1.0"})
        with urllib.request.urlopen(req, timeout=180) as resp:
            data = resp.read()
    os.makedirs(CACHE_DIR, exist_ok=True)
    tmp = CACHE_FILE + ".part"
    with open(tmp, "wb") as fh:
        fh.write(data)
    os.replace(tmp, CACHE_FILE)
    return data


def singular_type(raw: str) -> str:
    raw = (raw or "").strip()
    if raw in TYPE_OVERRIDES:
        return TYPE_OVERRIDES[raw]
    return raw.split(",")[0].strip() or "Unknown"


def norm_lon(lon: float) -> float:
    lon = (lon + 180.0) % 360.0 - 180.0
    return lon


def num(value: float, digits: int):
    """Round and drop a trailing .0 so the JSON stays small."""
    r = round(value, digits)
    if r == int(r):
        return int(r)
    return r


def parse(kmz: bytes):
    with zipfile.ZipFile(io.BytesIO(kmz)) as zf:
        kml_name = next(n for n in zf.namelist() if n.lower().endswith(".kml"))
        kml = zf.read(kml_name)
    features = []
    skipped: dict[str, int] = {}
    seen = set()
    for _, el in ET.iterparse(io.BytesIO(kml), events=("end",)):
        if el.tag != KML_NS + "Placemark":
            continue
        rec = {sd.get("name"): (sd.text or "").strip() for sd in el.iter(KML_NS + "SimpleData")}
        name = (el.findtext(KML_NS + "name") or rec.get("clean_name") or "").strip()
        el.clear()
        approval = rec.get("approval", "")
        if approval.lower() != APPROVED:
            skipped[approval or "(blank)"] = skipped.get(approval or "(blank)", 0) + 1
            continue
        try:
            lat = float(rec["center_lat"])
            lon = norm_lon(float(rec["center_lon"]))
        except (KeyError, ValueError):
            skipped["bad coordinates"] = skipped.get("bad coordinates", 0) + 1
            continue
        if not name or not (-90.0 <= lat <= 90.0):
            skipped["bad record"] = skipped.get("bad record", 0) + 1
            continue
        try:
            diameter = max(0.0, float(rec.get("diameter") or 0.0))
        except ValueError:
            diameter = 0.0
        ftype = singular_type(rec.get("type", ""))
        key = (name, ftype, round(lat, 3), round(lon, 3))
        if key in seen:
            skipped["duplicate"] = skipped.get("duplicate", 0) + 1
            continue
        seen.add(key)
        features.append(
            {
                "name": name,
                "type": ftype,
                "lat": num(lat, 4),
                "lon": num(lon, 4),
                "diameterKm": num(diameter, 2),
            }
        )
    features.sort(key=lambda f: (-f["diameterKm"], f["name"]))
    return features, skipped


def verify(features) -> bool:
    by_name = {}
    for f in features:
        by_name.setdefault(f["name"], f)
    ok = True
    for name, lat, lon, tol in CHECKS:
        f = by_name.get(name)
        if f is None:
            print(f"  CHECK FAIL {name}: missing", file=sys.stderr)
            ok = False
            continue
        good = abs(f["lat"] - lat) <= tol and (lon is None or abs(f["lon"] - lon) <= tol)
        ok = ok and good
        print(
            f"  check {'ok  ' if good else 'FAIL'} {name}: lat {f['lat']} lon {f['lon']} "
            f"d {f['diameterKm']} km (expected {lat}, {lon})",
            file=sys.stderr,
        )
    if any(not (-180.0 <= f["lon"] <= 180.0) for f in features):
        print("  CHECK FAIL: longitude outside [-180, 180]", file=sys.stderr)
        ok = False
    return ok


def main() -> int:
    features, skipped = parse(download("--refresh" in sys.argv[1:]))
    if len(features) < 5000:
        print(f"only {len(features)} features parsed - source format changed?", file=sys.stderr)
        return 1
    if not verify(features):
        print("coordinate verification failed; not writing output", file=sys.stderr)
        return 1
    os.makedirs(os.path.dirname(OUT_FILE), exist_ok=True)
    payload = json.dumps(features, ensure_ascii=False, separators=(",", ":"))
    with open(OUT_FILE, "w", encoding="utf-8") as fh:
        fh.write(payload)
    types: dict[str, int] = {}
    for f in features:
        types[f["type"]] = types.get(f["type"], 0) + 1
    print(f"wrote {OUT_FILE}: {len(features)} features, {os.path.getsize(OUT_FILE)} bytes")
    print("types: " + ", ".join(f"{k} {v}" for k, v in sorted(types.items(), key=lambda kv: -kv[1])))
    print("skipped: " + (", ".join(f"{k} {v}" for k, v in skipped.items()) or "none"))
    return 0


if __name__ == "__main__":
    sys.exit(main())
