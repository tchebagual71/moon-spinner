# Moon Spinner

An interactive, photo-realistic 3D Moon for the browser. Spin and zoom a globe built from real
Lunar Reconnaissance Orbiter data, with true-scale relief, real-time or manual sunlight, 9,000+
IAU-named features, spacecraft landing and impact sites, streamed 100 m/pixel imagery when you
zoom in, and a "data support" overlay showing how well each part of the surface is actually
measured.

Vite + TypeScript + three.js, built to a static site (`dist/`) and deployed on Cloudflare Pages.

## Data sources and credits

| Layer | Source | Credit |
| --- | --- | --- |
| Global colour (albedo) | [CGI Moon Kit](https://svs.gsfc.nasa.gov/4720) — LROC WAC Hapke-normalised colour mosaic | NASA's Scientific Visualization Studio; LROC WAC: NASA / GSFC / Arizona State University |
| Elevation, normals | [LOLA Gridded Data Records](https://imbrium.mit.edu/DATA/LOLA_GDR/CYLINDRICAL/IMG/) `LDEM_64` / `LDEM_16` | NASA / GSFC / MIT — Lunar Orbiter Laser Altimeter team, PDS Geosciences Node |
| Altimetry coverage | LOLA `LDEC_64` / `LDEC_16` laser shot counts per pixel (same archive) | NASA / GSFC / MIT — LOLA team |
| Polar shadow / illumination | [LOLA polar illumination products](https://imbrium.mit.edu/EXTRAS/ILLUMINATION/) (permanently shadowed regions, average solar visibility) | NASA / GSFC LOLA team (Mazarico et al. 2011, *Icarus* 211) |
| Zoom-in imagery | [NASA Moon Trek](https://trek.nasa.gov/moon/) WMTS layer `LRO_WAC_Mosaic_Global_303ppd_v02` (LROC WAC global mosaic, ~100 m/px) | NASA / JPL Solar System Treks; NASA / GSFC / Arizona State University |
| Feature names | [Gazetteer of Planetary Nomenclature](https://planetarynames.wr.usgs.gov/) (IAU-approved lunar names) | IAU Working Group for Planetary System Nomenclature; USGS Astrogeology Science Center |
| Landing / impact sites | [LROC anthropogenic-objects table](https://data.lroc.im-ldi.com/lroc/view_rdr/SHAPEFILE_ANTHROPOGENIC_OBJECTS) (Wagner et al. 2017, *Icarus* 283, 92–103, and later LROC updates); NSSDC for sites never located in imagery | NASA / GSFC / Arizona State University; NASA NSSDCA |
| Sun position | [astronomy-engine](https://github.com/cosinekitty/astronomy) | Don Cross |

Exact product names, URLs and processing notes for the rasters are recorded in
`public/data/manifest.json` (`sources`) and shown in the app's "About the data" panel.

Coordinates everywhere are selenographic latitude/longitude in the mean-Earth / polar-axis frame,
longitude in [-180, 180], east positive (see `src/types.ts`).

## The data-support score

The overlay answers "how much real measurement is behind what I am looking at here?" It combines

- an **altimetry** score, driven by how many LOLA laser shots actually fell in each map cell
  (cells with no shots are interpolated in the elevation model), and
- an **imagery** score, reflecting whether sunlit orbital photography of that spot exists at all
  (permanently shadowed and poorly lit polar terrain, and areas where the colour mosaic is
  filled in rather than photographed, score low),

into a **combined** 0–100 % value (currently a plain average of the two). The precise formulas live in the data pipeline and are written
out in plain language to `manifest.json` → `confidenceMethod` (`altimetry`, `imagery`, `combined`),
which is the source of truth and is what the app displays.

This score is an **app-derived index for visualisation only. It is not an official NASA, LRO or
LOLA data-quality metric** and should not be used for science or mission planning.

## Local development

```sh
npm install
npm run dev        # Vite dev server
npm run build      # type-check + production build into dist/
npm run preview    # serve the production build locally
```

In plain `vite dev` / `vite preview` there is no `/tiles/*` function; the client falls back to
loading tiles directly from `trek.nasa.gov`. To exercise the function locally, run
`npm run build && npx wrangler pages dev dist`.

## Rebuilding the data

Generated files live in `public/data/`. Downloads are cached in `tools/cache/` (git-ignored).

```sh
python3 tools/build_data.py        # rasters + manifest.json (colour, normals, height, data support)
python3 tools/build_gazetteer.py   # features.json from the IAU/USGS gazetteer (add --refresh to re-download)
```

`build_gazetteer.py` needs only the Python 3 standard library. It downloads the USGS bulk export
`MOON_nomenclature_center_pts.kmz`, keeps IAU-adopted names, converts longitudes from 0–360 °E to
[-180, 180], checks a handful of well-known features (Tycho, Mare Crisium, Tsiolkovskiy,
Shackleton, ...) and writes a compact array sorted by descending diameter.
`public/data/sites.json` is curated by hand; each entry's `note` states where its position comes from.

## Deploying to Cloudflare Pages

**Git integration:** create a Pages project from the repository with

- Build command: `npm run build`
- Build output directory: `dist`

**Direct upload:**

```sh
npm run build
npx wrangler pages deploy dist     # project name / output dir come from wrangler.toml
```

Either way, Pages picks up `functions/` automatically:

- `functions/tiles/[[path]].ts` serves `/tiles/{z}/{row}/{col}.jpg` as a same-origin, edge-cached
  proxy for the Moon Trek WMTS tiles (levels 0–8, `2^(z+1)` × `2^z` tiles of 256 px, row 0 at the
  north pole). It only forwards valid in-range tile addresses, so it is not an open proxy.
- If `/tiles/*` is unavailable, the client falls back to fetching tiles directly from NASA.
- `public/_headers` sets caching for `/assets/*` and `/data/*` plus basic security headers.

## Licence and attribution

NASA imagery and data are generally not copyrighted; please keep the credits above when reusing
them. IAU nomenclature is provided by the USGS Astrogeology Science Center. This project is not
affiliated with or endorsed by NASA, the IAU or the USGS.
