#!/usr/bin/env node
/**
 * fetch-stations.js
 *
 * Fetches Berlin/Brandenburg train line + station data from the VBB HAFAS
 * REST API (https://v6.vbb.transport.rest) and produces lines.json.
 *
 * Why VBB instead of OpenStreetMap: the VBB API reflects the live timetable,
 * so construction reroutes and line renumberings show up immediately. OSM
 * relations can lag weeks/months (e.g. RE8 was mapped terminating at Elstal
 * long after it actually ran to Wittenberge via Nauen).
 *
 * Approach:
 *  1. Resolve a set of hub stations to VBB stop IDs.
 *  2. Harvest regional/suburban departures at those hubs to discover, per
 *     line, a set of candidate trips (covering both directions + branches).
 *  3. For each line, fetch those trips with stopovers + polyline, then UNION
 *     the stops (full coverage incl. short-turns and Y-branches) and keep the
 *     longest polyline per direction as the drawn geometry.
 *
 * Output:
 *  - data/lines.json            (stations carry their VBB stop ID natively)
 *  - data/station_mappings.json (identity map id->id, kept for the frontend's
 *    existing station→VBB-ID lookup; no separate mapping step is needed)
 *
 * Run: node data/fetch-stations.js
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { optimizeGeometry, optimizeStations } from './geometry-utils.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// --- Config ---
const API = 'https://v6.vbb.transport.rest';
const UA = 'TrainBikePlanner/1.0 (personal project; radius.kettner.berlin)';
const ALEX = { lat: 52.5219, lon: 13.4132 };
const MIN_REACH_KM = 15;

// Pacing + retries for the rate-limited community API (~85 req/min like the
// old mapping step).
const REQUEST_GAP_MS = 350;
const MAX_RETRIES = 4;

// Per line, bound how many trips we fetch. Trips are unioned, so a handful
// across distinct directions already covers the full extent and any branches.
const MAX_TRIPS_PER_LINE = 8;

// Departures lookahead — wide enough to catch even 120-min-interval lines.
const DEPARTURE_WINDOW_MIN = 720;

// Refuse to overwrite lines.json if the API gave us implausibly little data.
const MIN_EXPECTED_LINES = 20;

// Hub stations (by name) whose departures we harvest. Radial Berlin hubs catch
// the through-running lines; outer termini catch peripheral ones.
const HUB_NAMES = [
  'Berlin Hauptbahnhof', 'Berlin Ostkreuz', 'Berlin Gesundbrunnen',
  'Berlin Südkreuz', 'Berlin-Lichtenberg', 'Berlin-Spandau',
  'Berlin Friedrichstraße', 'Berlin Wannsee', 'Berlin Ostbahnhof',
  'Potsdam Hauptbahnhof', 'Königs Wusterhausen', 'Cottbus, Hauptbahnhof',
  'Frankfurt (Oder)', 'Eberswalde, Hauptbahnhof', 'Oranienburg',
  'Nauen', 'Brandenburg, Hauptbahnhof', 'Jüterbog', 'Angermünde',
  'Löwenberg (Mark)', 'Senftenberg', 'Wittenberge', 'Templin Stadt',
  'Wünsdorf-Waldstadt',
];

// Official VBB line colors (used when known; unknown in-scope lines get grey
// so newly-introduced lines still appear and can be coloured later).
const LINE_COLORS = {
  S1:'#DD6CA2', S2:'#007734', S25:'#007734', S26:'#007734', S3:'#0066b3',
  S5:'#e46a1a', S7:'#7B6A9D', S8:'#55a822', S9:'#8B3A8B', S46:'#3bbbd4', S85:'#3bbbd4',
  RE1:'#e5001c', RE2:'#bc0053', RE3:'#6e1985', RE4:'#6e1985', RE5:'#0066b3',
  RE6:'#007a4d', RE7:'#007a4d', RE8:'#e5001c', RE10:'#e5001c', RE11:'#e5001c',
  RE13:'#bc0053', RE15:'#e5001c', RE18:'#0066b3', RE20:'#bc0053', RE30:'#007a4d',
  RB10:'#e5001c', RB12:'#e5001c', RB14:'#e5001c', RB20:'#7B6A9D', RB21:'#7B6A9D',
  RB22:'#3bbbd4', RB23:'#3bbbd4', RB24:'#55a822', RB25:'#e5001c', RB26:'#e5001c',
  RB31:'#0066b3', RB32:'#55a822', RB33:'#007a4d', RB35:'#007a4d', RB36:'#007a4d',
  RB43:'#e46a1a', RB49:'#0066b3', RB54:'#0066b3', RB55:'#007a4d', RB60:'#007a4d',
  RB63:'#007a4d', RB66:'#007a4d', FEX:'#e5001c',
};
const DEFAULT_COLOR = '#888888';

// Ring lines, U-Bahn, and short stubs we never want.
const EXCLUDE_LINES = new Set(['S41', 'S42', 'S45', 'S47', 'S75', 'S15']);

// In-scope line refs: airport express, S-Bahn, regional.
const LINE_REF_RE = /^(FEX|S\d+|RE\d+|RB\d+)$/;

// --- helpers ---
const sleep = ms => new Promise(r => setTimeout(r, ms));
const toRad = d => (d * Math.PI) / 180;

function haversineKm(a, b) {
  const R = 6371;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const s = Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

const normRef = name => (name || '').replace(/\s+/g, '');

// VBB station names are verbose ("S+U Berlin Hauptbahnhof [Gleis 1-8]",
// "S Spandau Bhf (Berlin)"). Trim the transit-product noise for display.
function cleanStationName(name) {
  const cleaned = (name || '')
    .replace(/\s*\[[^\]]*\]\s*/g, ' ')   // "[Gleis 1-8]"
    .replace(/^(S\+U|U\+S|S|U)\s+/, '')  // leading product marker
    .replace(/,?\s*Bahnhof$/, '')        // trailing ", Bahnhof"
    .replace(/\s+Bhf\b/g, '')            // " Bhf"
    .replace(/\s*\(Berlin\)\s*$/, '')    // trailing " (Berlin)"
    .replace(/\s{2,}/g, ' ')
    .trim();
  return cleaned || (name || '').trim();
}

let lastReq = 0;
async function api(pathname) {
  let lastErr = null;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    const gap = REQUEST_GAP_MS - (Date.now() - lastReq);
    if (gap > 0) await sleep(gap);
    lastReq = Date.now();
    try {
      const res = await fetch(`${API}${pathname}`, { headers: { 'User-Agent': UA } });
      if (res.status === 429) { await sleep(2000 * attempt); continue; }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (err) {
      lastErr = err;
      if (attempt < MAX_RETRIES) await sleep(1000 * attempt);
    }
  }
  throw lastErr || new Error('request failed');
}

async function resolveHub(name) {
  try {
    const data = await api(`/locations?query=${encodeURIComponent(name)}&results=1&poi=false&addresses=false`);
    if (Array.isArray(data) && data[0]?.id) return { id: data[0].id, name: data[0].name };
  } catch (err) {
    console.warn(`   ⚠️  Could not resolve hub "${name}": ${err.message}`);
  }
  return null;
}

async function harvestDepartures(hubId) {
  const params =
    `duration=${DEPARTURE_WINDOW_MIN}&results=500` +
    '&express=false&national=false&nationalExpress=false' +
    '&regional=true&regionalExpress=true&suburban=true' +
    '&subway=false&tram=false&bus=false&ferry=false&taxi=false';
  try {
    const data = await api(`/stops/${hubId}/departures?${params}`);
    return data.departures || (Array.isArray(data) ? data : []);
  } catch (err) {
    console.warn(`   ⚠️  Departures failed for hub ${hubId}: ${err.message}`);
    return [];
  }
}

async function fetchTrip(tripId) {
  const data = await api(`/trips/${encodeURIComponent(tripId)}?stopovers=true&polyline=true`);
  return data.trip || data;
}

// Pick candidate trip IDs for a line, diversified across directions so the
// union spans both terminals and any branches.
function pickTrips(tripsByDirection) {
  const lists = [...tripsByDirection.values()].map(set => [...set]);
  const chosen = [];
  let i = 0;
  while (chosen.length < MAX_TRIPS_PER_LINE && lists.some(l => l.length)) {
    const list = lists[i % lists.length];
    if (list.length) chosen.push(list.shift());
    i++;
  }
  return chosen;
}

// --- Main ---
async function main() {
  console.log('🚆 Building lines.json from the VBB HAFAS API…');

  // 1. Resolve hubs
  console.log(`🔎 Resolving ${HUB_NAMES.length} hub stations…`);
  const hubs = [];
  for (const name of HUB_NAMES) {
    const hub = await resolveHub(name);
    if (hub) hubs.push(hub);
  }
  console.log(`   Resolved ${hubs.length}/${HUB_NAMES.length} hubs.`);

  // 2. Harvest departures → candidate trips per line ref
  //    ref → Map(direction → Set(tripId))
  const candidates = new Map();
  console.log('🛰  Harvesting departures…');
  for (const hub of hubs) {
    const departures = await harvestDepartures(hub.id);
    for (const dep of departures) {
      const ref = normRef(dep.line?.name);
      if (!ref || !LINE_REF_RE.test(ref) || EXCLUDE_LINES.has(ref)) continue;
      if (!dep.tripId) continue;
      const dir = dep.direction || dep.destination?.name || 'unknown';
      if (!candidates.has(ref)) candidates.set(ref, new Map());
      const byDir = candidates.get(ref);
      if (!byDir.has(dir)) byDir.set(dir, new Set());
      byDir.get(dir).add(dep.tripId);
    }
  }
  console.log(`   Found ${candidates.size} candidate lines: ${[...candidates.keys()].sort().join(', ')}`);

  // 3. For each line, fetch chosen trips and union stops + geometry
  const lines = [];
  for (const ref of [...candidates.keys()].sort()) {
    const tripIds = pickTrips(candidates.get(ref));
    const stations = new Map();          // vbb id → station
    const geomByDirection = new Map();   // direction → longest [ [lon,lat], ... ]
    let longestTrip = null;              // for the display name

    for (const tripId of tripIds) {
      let trip;
      try {
        trip = await fetchTrip(tripId);
      } catch (err) {
        console.warn(`   ⚠️  ${ref}: trip fetch failed (${err.message})`);
        continue;
      }
      const stopovers = (trip?.stopovers || []).filter(
        s => s.stop?.id && s.stop?.location?.latitude && s.stop?.location?.longitude
      );
      if (stopovers.length === 0) continue;

      for (const so of stopovers) {
        const id = so.stop.id;
        if (!stations.has(id)) {
          stations.set(id, {
            id,
            name: cleanStationName(so.stop.name),
            lat: so.stop.location.latitude,
            lon: so.stop.location.longitude,
          });
        }
      }

      if (!longestTrip || stopovers.length > longestTrip.count) {
        longestTrip = { count: stopovers.length, first: stopovers[0].stop.name, last: stopovers[stopovers.length - 1].stop.name };
      }

      const coords = (trip.polyline?.features || [])
        .map(f => f.geometry?.coordinates)
        .filter(c => Array.isArray(c) && c.length === 2);
      if (coords.length >= 2) {
        const dir = trip.direction || 'unknown';
        const prev = geomByDirection.get(dir);
        if (!prev || coords.length > prev.length) geomByDirection.set(dir, coords);
      }
    }

    if (stations.size === 0) {
      console.warn(`   ⚠️  ${ref}: no usable trips, skipping.`);
      continue;
    }

    const stationList = [...stations.values()];
    const maxDist = Math.max(...stationList.map(s => haversineKm(ALEX, s)));
    if (maxDist < MIN_REACH_KM) {
      console.log(`   ⏭ Skipping ${ref} — max reach ${maxDist.toFixed(1)} km`);
      continue;
    }

    const type = ref.startsWith('S') ? 's-bahn' : 'regional';
    const color = LINE_COLORS[ref] || DEFAULT_COLOR;
    const endpoints = longestTrip
      ? `${cleanStationName(longestTrip.first)} → ${cleanStationName(longestTrip.last)}`
      : ref;

    // Stable ordering so the daily job doesn't churn lines.json just because a
    // different (equivalent) set of trips was caught: sort stations by ID and
    // geometry segments by their starting coordinate.
    stationList.sort((a, b) => a.id.localeCompare(b.id));
    const geometry = [...geomByDirection.values()].sort((a, b) =>
      (a[0][0] - b[0][0]) || (a[0][1] - b[0][1])
    );

    lines.push({
      id: ref,
      ref,
      type,
      name: `${ref}: ${endpoints}`,
      color,
      stations: optimizeStations(stationList),
      geometry: optimizeGeometry(geometry),
    });

    const known = LINE_COLORS[ref] ? '' : ' (no colour — add to LINE_COLORS)';
    console.log(`  ✓ ${ref} — ${endpoints} (${stationList.length} stations, max ${maxDist.toFixed(0)} km)${known}`);
  }

  // Sort: S-Bahn first, then regional, then by ref (numeric-aware)
  lines.sort((a, b) => {
    if (a.type !== b.type) return a.type === 's-bahn' ? -1 : 1;
    return a.ref.localeCompare(b.ref, undefined, { numeric: true });
  });

  // Safety guard: never overwrite with a gutted network if the API misbehaved.
  if (lines.length < MIN_EXPECTED_LINES) {
    console.error(`❌ Only ${lines.length} lines built (expected ≥ ${MIN_EXPECTED_LINES}). Refusing to overwrite lines.json.`);
    process.exit(1);
  }

  // Stations now carry their VBB stop ID, so the frontend's id→VBB-ID lookup
  // is an identity map. Emit it (sorted) so the existing loader keeps working
  // without any runtime nearby-resolution calls.
  const mapping = {};
  for (const line of lines) {
    for (const s of line.stations) mapping[s.id] = s.id;
  }
  const sortedMapping = {};
  for (const k of Object.keys(mapping).sort()) sortedMapping[k] = mapping[k];

  const output = { generated: new Date().toISOString(), center: ALEX, lines };

  fs.writeFileSync(path.join(__dirname, 'lines.json'), JSON.stringify(output));
  fs.writeFileSync(path.join(__dirname, 'station_mappings.json'), JSON.stringify(sortedMapping));

  console.log(`\n✅ Wrote ${lines.length} lines`);
  console.log(`   S-Bahn:   ${lines.filter(l => l.type === 's-bahn').length}`);
  console.log(`   Regional: ${lines.filter(l => l.type === 'regional').length}`);
  console.log(`   Stations: ${lines.reduce((n, l) => n + l.stations.length, 0)} (${Object.keys(mapping).length} unique)`);
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
