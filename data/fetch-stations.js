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
import { fetchWikipediaLines } from './wikipedia-lines.js';

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
// the through-running lines; outer termini + junctions catch peripheral ones.
// A line is only discovered if it passes one of these stops during the
// departure window, so this list deliberately covers every branch junction —
// if a line ever goes missing, add the stop where it diverges from a trunk.
const HUB_NAMES = [
  // Radial Berlin hubs
  'Berlin Hauptbahnhof', 'Berlin Ostkreuz', 'Berlin Gesundbrunnen',
  'Berlin Südkreuz', 'Berlin-Lichtenberg', 'Berlin-Spandau',
  'Berlin Friedrichstraße', 'Berlin Wannsee', 'Berlin Ostbahnhof',
  'Flughafen BER Terminal 1-2',
  // Outer termini + junctions
  'Potsdam Hauptbahnhof', 'Königs Wusterhausen', 'Cottbus, Hauptbahnhof',
  'Frankfurt (Oder)', 'Eberswalde, Hauptbahnhof', 'Oranienburg',
  'Nauen', 'Brandenburg, Hauptbahnhof', 'Jüterbog', 'Angermünde',
  'Löwenberg (Mark)', 'Senftenberg', 'Wittenberge', 'Templin Stadt',
  'Wünsdorf-Waldstadt', 'Fürstenwalde (Spree)', 'Bad Saarow Pieskow',
  'Kremmen', 'Hennigsdorf', 'Beelitz Stadt', 'Werneuchen', 'Wriezen',
  'Beeskow', 'Rathenow', 'Rheinsberg (Mark)', 'Schwedt (Oder)',
  'Prenzlau', 'Neuruppin', 'Falkenberg (Elster)', 'Elsterwerda',
  'Lübbenau (Spreewald)', 'Luckenwalde',
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

// Resolve station names to VBB stops, skipping any whose ID is already known.
async function resolveHubs(names, seenIds) {
  const hubs = [];
  for (const name of names) {
    const hub = await resolveHub(name);
    if (hub && !seenIds.has(hub.id)) {
      seenIds.add(hub.id);
      hubs.push(hub);
    }
  }
  return hubs;
}

// Harvest departures at the given hubs into the candidate map.
// Keyed by the network-stable line.id (not the displayed ref) so two lines
// sharing a number across networks — a Brandenburg RB33 and a Saxony-Anhalt
// RB33 — don't get merged.  lineId → { ref, byDir: Map(direction → Set(tripId)) }
async function harvestInto(candidates, hubs, restrictRefs = null) {
  for (const hub of hubs) {
    const departures = await harvestDepartures(hub.id);
    for (const dep of departures) {
      const ref = normRef(dep.line?.name);
      if (!ref || !LINE_REF_RE.test(ref) || EXCLUDE_LINES.has(ref)) continue;
      // During self-heal we harvest far termini, which also serve foreign
      // lines — only pick up the specific lines we're trying to recover.
      if (restrictRefs && !restrictRefs.has(ref)) continue;
      if (!dep.tripId) continue;
      const lineId = dep.line?.id || ref;
      const dir = dep.direction || dep.destination?.name || 'unknown';
      if (!candidates.has(lineId)) candidates.set(lineId, { ref, byDir: new Map() });
      const byDir = candidates.get(lineId).byDir;
      if (!byDir.has(dir)) byDir.set(dir, new Set());
      byDir.get(dir).add(dep.tripId);
    }
  }
}

const refsOf = candidates => new Set([...candidates.values()].map(c => c.ref));

// Compare the built lines against Wikipedia's canonical BB line list and write
// data/qa-report.json (no timestamp, so it only changes when findings change).
function writeQaReport(lines, wiki, selfHealed) {
  const builtRefs = new Set(lines.map(l => l.ref));
  const missing = [...wiki.expected].filter(r => !builtRefs.has(r)).sort();
  const unexpected = lines
    .filter(l => /^(RE|RB)\d+$/.test(l.ref) && !wiki.expected.has(l.ref))
    .map(l => ({ ref: l.ref, name: l.name, note: wiki.foreignRefs.has(l.ref) ? 'listed only as out-of-state on Wikipedia' : 'not on the Berlin-Brandenburg list' }))
    .sort((a, b) => a.ref.localeCompare(b.ref, undefined, { numeric: true }));
  const uncolored = lines.filter(l => l.color === DEFAULT_COLOR).map(l => l.ref).sort();

  const report = {
    expectedBerlinBrandenburg: wiki.expected.size,
    built: lines.length,
    selfHealed: selfHealed.sort(),
    missing,
    unexpected,
    uncolored,
  };
  fs.writeFileSync(path.join(__dirname, 'qa-report.json'), JSON.stringify(report, null, 2) + '\n');

  console.log('\n📋 QA vs Wikipedia:');
  console.log(`   missing (expected but absent): ${missing.length ? missing.join(', ') : 'none'}`);
  console.log(`   unexpected (foreign/unknown):  ${unexpected.length ? unexpected.map(u => u.ref).join(', ') : 'none'}`);
  console.log(`   uncoloured:                    ${uncolored.length ? uncolored.join(', ') : 'none'}`);
  if (missing.length) console.log('   ↳ "missing" lines are likely construction-suspended (verify against VBB if unexpected).');
}

// --- Main ---
async function main() {
  console.log('🚆 Building lines.json from the VBB HAFAS API…');

  // 1. Resolve curated hubs
  console.log(`🔎 Resolving ${HUB_NAMES.length} hub stations…`);
  const harvestedIds = new Set();
  const hubs = await resolveHubs(HUB_NAMES, harvestedIds);
  console.log(`   Resolved ${hubs.length} hubs.`);

  // 2. Harvest departures → candidate trips per line
  const candidates = new Map();
  console.log('🛰  Harvesting departures…');
  await harvestInto(candidates, hubs);
  console.log(`   Found ${candidates.size} candidate lines (${refsOf(candidates).size} refs).`);

  // 2b. QA against Wikipedia + self-heal discovery gaps (best-effort).
  let wiki = null;
  const selfHealed = [];
  try {
    console.log('📖 Fetching Wikipedia line list for QA…');
    wiki = await fetchWikipediaLines(UA);
    console.log(`   Wikipedia lists ${wiki.expected.size} Berlin-Brandenburg RE/RB lines.`);
  } catch (err) {
    console.warn(`   ⚠️  Wikipedia QA unavailable: ${err.message} — proceeding without self-heal.`);
  }
  if (wiki) {
    const seen = refsOf(candidates);
    const missing = [...wiki.expected].filter(r => !seen.has(r));
    if (missing.length) {
      console.log(`🩹 Self-heal: ${missing.length} expected line(s) not yet seen: ${missing.join(', ')}`);
      const names = new Set();
      for (const ref of missing) (wiki.termini.get(ref) || []).forEach(n => names.add(n));
      const healHubs = await resolveHubs([...names], harvestedIds);
      console.log(`   Harvesting ${healHubs.length} extra hub(s) from missing-line routes…`);
      await harvestInto(candidates, healHubs, new Set(missing));
      const after = refsOf(candidates);
      for (const ref of missing) if (after.has(ref)) selfHealed.push(ref);
      console.log(`   ✓ Recovered: ${selfHealed.length ? selfHealed.join(', ') : 'none'}`);
    }
  }

  // 3. For each line, fetch chosen trips and union stops + geometry
  const builtLines = [];
  const entries = [...candidates.entries()].sort((a, b) =>
    a[1].ref.localeCompare(b[1].ref, undefined, { numeric: true })
  );
  for (const [, { ref, byDir }] of entries) {
    const tripIds = pickTrips(byDir);
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

    builtLines.push({
      id: ref,
      ref,
      type,
      name: `${ref}: ${endpoints}`,
      color,
      stations: optimizeStations(stationList),
      geometry: optimizeGeometry(geometry),
      _minDist: Math.min(...stationList.map(s => haversineKm(ALEX, s))),
    });

    const known = LINE_COLORS[ref] ? '' : ' (no colour — add to LINE_COLORS)';
    console.log(`  ✓ ${ref} — ${endpoints} (${stationList.length} stations, max ${maxDist.toFixed(0)} km)${known}`);
  }

  // Collapse any ref still served by network-distinct lines (cross-network
  // number collisions): keep the variant whose nearest stop is closest to
  // Berlin — that's the one relevant to this tool.
  const byRef = new Map();
  for (const line of builtLines) {
    const prev = byRef.get(line.ref);
    if (!prev) { byRef.set(line.ref, line); continue; }
    const keep = line._minDist < prev._minDist ? line : prev;
    const drop = keep === line ? prev : line;
    byRef.set(line.ref, keep);
    console.log(`   ↺ ${line.ref}: collision — kept Berlin-closest variant, dropped "${drop.name}"`);
  }
  const lines = [...byRef.values()];
  lines.forEach(l => { delete l._minDist; });

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

  if (wiki) writeQaReport(lines, wiki, selfHealed);
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
