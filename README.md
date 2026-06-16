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
- Station & line geometry from the [Overpass API](https://overpass-api.de/), train
  connections via the VBB transit API

## Development

```bash
npm install
npm run dev      # start the dev server at http://localhost:5173
npm run build    # build to dist/
npm run preview  # preview the production build
```

### Data

```bash
npm run fetch-data   # fetch fresh station/line geometry (data/fetch-stations.js)
```

Station data lives in `data/` (`lines.json`, `station_mappings.json`). It is refreshed
automatically every day at 03:00 UTC by the
[Update Station Data](.github/workflows/update-data.yml) workflow, which fetches geometry
from Overpass, maps new stations to VBB stop IDs, and commits any changes.

## Deployment

Pushes to `main` (and successful data-update runs) trigger the
[Deploy to GitHub Pages](.github/workflows/deploy.yml) workflow, which builds and
publishes `dist/` to GitHub Pages.

## Project layout

```
src/
  app.js            # main controller: geolocation, map, search, results
  algorithm/        # station finding, route service, GPX export
  ui/               # map renderer, controls, route list, mobile sheet
  styles/
data/               # station/line data + fetch scripts
scripts/            # VBB stop-ID mapping
.github/workflows/  # deploy + daily data update
```
