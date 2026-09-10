# Radius — Berlin Train + Bike

Plan combined train + bike tours starting from Berlin.

**Live: [radius.kettner.berlin](https://radius.kettner.berlin/)**

Instead of cycling loops out and back every time, Radius helps you find rides that
*start* at a train station outside the city so you can cycle home. You set your home
location, a target cycling distance, and a route profile — the app finds train
connections to the stations that put you the right distance away, then routes you back.

## How it works

1. Pick your home location on the map (defaults to Alexanderplatz).
2. Set your desired cycling distance and route preferences.
3. Radius finds regional/S-Bahn stations roughly that distance away, looks up live
   train connections, and draws bike routes back home.
4. Export any route as GPX for your bike computer.

## Tech

- Vanilla JS + [Vite](https://vitejs.dev/)
- [Leaflet](https://leafletjs.com/) + [MapLibre GL](https://maplibre.org/) for the map
- Bike routing, elevation, and GPX tracks via [BRouter](https://brouter.de/)
- Line routes, stations, and geometry from the [VBB transit API](https://v6.vbb.transport.rest/),
  which also powers the live train connections. Sourcing from VBB keeps the map in
  step with the live timetable (construction reroutes, line renumberings) instead of
  lagging behind OpenStreetMap.

## Development

```bash
npm install
npm run dev      # start the dev server at http://localhost:5173
npm run build    # build to dist/
npm run preview  # preview the production build
```

### Configuration

The dark basemap comes from [CARTO](https://carto.com/basemaps/apikey/), which now
requires an API key — without one every tile is stamped "API KEY REQUIRED". Keys are
free and need no approval.

```bash
cp .env.example .env.local   # then paste your key into VITE_CARTO_API_KEY
```

`.env.local` is gitignored. Vite inlines the value at build time, so a client-side
basemap key is public in the shipped bundle by design; restrict it to your domain in
the [CARTO basemaps dashboard](https://dashboard.basemaps.carto.com) rather than
relying on it staying secret. The free tier allows 5M tile requests per calendar month.

A missing key is not fatal: the map still renders (watermarked) and logs a warning, so
a fresh clone works without any setup. The light basemap is OpenFreeMap and needs no key.

### Data

```bash
npm run fetch-data   # fetch fresh station/line geometry (data/fetch-stations.js)
```

Station data lives in `data/` (`lines.json`, `station_mappings.json`). It is refreshed
automatically every day at 03:00 UTC by the
[Update Station Data](.github/workflows/update-data.yml) workflow, which rebuilds the
line/station data from the VBB API and commits any changes. (`station_mappings.json` is
now an identity map — stations carry their VBB stop ID natively — kept for the
frontend's existing lookup.)

The build cross-checks itself against the German Wikipedia [list of Berlin-Brandenburg
rail lines](https://de.wikipedia.org/wiki/Liste_der_Eisenbahnlinien_in_Brandenburg_und_Berlin):
lines that the page lists but the VBB hubs didn't surface are self-healed by harvesting
their route's termini, and out-of-state lines caught at border hubs are filtered out.
The leftovers (`missing` / `filtered`) are written to `data/qa-report.json` for review —
"missing" lines are usually construction-suspended, and the VBB API stays the source of
truth for what's actually running.

Train lines are drawn in two muted overlay colors (S-Bahn green, all other trains blue)
to stay readable once bike routes are layered on top.

## Deployment

Pushes to `main` (and successful data-update runs) trigger the
[Deploy to GitHub Pages](.github/workflows/deploy.yml) workflow, which builds and
publishes `dist/` to GitHub Pages.

The build reads the CARTO key from a repository secret named `CARTO_API_KEY`
(Settings → Secrets and variables → Actions). Without it the deploy still succeeds,
but the live dark basemap will be watermarked.

## Project layout

```
src/
  app.js            # main controller: geolocation, map, search, results
  algorithm/        # station finding, route service, GPX export
  ui/               # map renderer, controls, route list, mobile sheet
  styles/
data/               # station/line data + VBB fetch script
.github/workflows/  # deploy + daily data update
```
