#!/usr/bin/env node
/**
 * fetch-stations.js
 *
 * One-time script to fetch Berlin train line and station data from
 * the OpenStreetMap Overpass API and produce lines.json.
 *
 * Run: node data/fetch-stations.js
 * Output: data/lines.json
 *
 * Fetches:
 *  - S-Bahn lines (route=light_rail, operator=S-Bahn Berlin GmbH)
 *  - Regional trains RE/RB (route=train, network~VBB)
 * within a ~105km bounding box around Alexanderplatz.
 *
 * Deduplication: bidirectional routes (A→B and B→A) are merged into
 * a single line entry with the canonical station order.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import https from 'https';
import { optimizeGeometry, optimizeStations } from './geometry-utils.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// --- Config ---

// Bounding box: ~105km radius around Alexanderplatz (52.5219, 13.4132)
const BBOX = '51.57,11.97,53.47,14.87';

// Official VBB S-Bahn line colors
const SBAHN_COLORS = {
  'S1':  '#DD6CA2',
  'S2':  '#007734',
  'S25': '#007734',
  'S26': '#007734',
  'S3':  '#0066b3',
  'S5':  '#e46a1a',
  'S7':  '#7B6A9D',
  'S8':  '#55a822',
  'S9':  '#8B3A8B',
  'S46': '#3bbbd4',
  'S85': '#3bbbd4',
};

// RE/RB lines to include with their colors
const REGIONAL_LINES = {
  'RE1':  '#e5001c',
  'RE2':  '#bc0053',
  'RE3':  '#6e1985',
  'RE4':  '#6e1985',
  'RE5':  '#0066b3',
  'RE6':  '#007a4d',
  'RE7':  '#007a4d',
  'RE8':  '#e5001c',
  'RE10': '#e5001c',
  'RE11': '#e5001c',
  'RE13': '#bc0053',
  'RE15': '#e5001c',
  'RE18': '#0066b3',
  'RE20': '#bc0053',
  'RE30': '#007a4d',
  'RB10': '#e5001c',
  'RB12': '#e5001c',
  'RB14': '#e5001c',
  'RB20': '#7B6A9D',
  'RB21': '#7B6A9D',
  'RB22': '#3bbbd4',
  'RB23': '#3bbbd4',
  'RB24': '#55a822',
  'RB25': '#e5001c',
  'RB26': '#e5001c',
  'RB31': '#0066b3',
  'RB32': '#55a822',
  'RB33': '#007a4d',
  'RB35': '#007a4d',
  'RB36': '#007a4d',
  'RB43': '#e46a1a',
  'RB49': '#0066b3',
  'RB54': '#0066b3',
  'RB55': '#007a4d',
  'RB60': '#007a4d',
  'RB63': '#007a4d',
  'RB66': '#007a4d',
};

// Exclude ring lines, short stubs, and U-Bahn
const EXCLUDE_LINES = new Set([
  'S41', 'S42', 'S45', 'S47', 'S75',
  'U1', 'U2', 'U3', 'U4', 'U5', 'U6', 'U7', 'U8', 'U9'
]);

const MIN_REACH_KM = 15;
const ALEX = { lat: 52.5219, lon: 13.4132 };

// --- Two relation queries: S-Bahn and Regional train relations ---
// Using exact match values to allow indexed search (avoiding slow case-insensitive regexes)
const sbahnQuery = `
[out:json][timeout:60];
(
  relation["route"="light_rail"]["operator"="S-Bahn Berlin GmbH"](${BBOX});
  relation["route"="light_rail"]["operator"="S-Bahn Berlin"](${BBOX});
);
out geom;
`;

const regionalQuery = `
[out:json][timeout:90];
(
  relation["route"="train"]["network"="VBB"](${BBOX});
  relation["route"="train"]["network"="Verkehrsverbund Berlin-Brandenburg"](${BBOX});
);
out geom;
`;

// --- Overpass Servers & Fallback ---
const SERVERS = [
  'https://overpass-api.de/api/interpreter',
  'https://lz4.overpass-api.de/api/interpreter',
  'https://z.overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter'
];

async function runQueryWithFallback(query) {
  for (const server of SERVERS) {
    try {
      console.log(`   Trying ${new URL(server).hostname}…`);
      const data = await overpassQuery(query, server);
      return data;
    } catch (err) {
      console.warn(`   ⚠️  Failed on ${new URL(server).hostname}: ${err.message}`);
    }
  }
  throw new Error('All Overpass servers failed.');
}

// --- Main ---

async function main() {
  console.log('🚆 Fetching S-Bahn relations from Overpass API…');
  let sbahnData = { elements: [] };
  try {
    sbahnData = await runQueryWithFallback(sbahnQuery);
    console.log(`   Got S-Bahn relations (${sbahnData.elements.length} elements)`);
  } catch (err) {
    console.error('❌ S-Bahn query failed on all servers:', err.message);
  }

  console.log('🚆 Fetching Regional train relations from Overpass API…');
  let regionalData = { elements: [] };
  try {
    regionalData = await runQueryWithFallback(regionalQuery);
    console.log(`   Got regional relations (${regionalData.elements.length} elements)`);
  } catch (err) {
    console.error('❌ Regional query failed on all servers:', err.message);
  }

  const allElements = [
    ...sbahnData.elements.map(e => ({ ...e, _queryType: 's-bahn' })),
    ...regionalData.elements.map(e => ({ ...e, _queryType: 'regional' })),
  ];

  // Group relations and collect all unique station node refs
  const byRef = new Map(); // ref → array of relation objects
  const stationNodeIdsSet = new Set();

  for (const relation of allElements) {
    if (relation.type !== 'relation') continue;
    const ref = relation.tags?.ref;
    if (!ref) continue;
    if (EXCLUDE_LINES.has(ref)) continue;

    const lineType = relation._queryType;
    if (lineType === 'regional' && !REGIONAL_LINES[ref]) continue;
    if (lineType === 's-bahn' && !SBAHN_COLORS[ref] && !ref.startsWith('S')) continue;

    if (!byRef.has(ref)) byRef.set(ref, []);
    byRef.get(ref).push({ relation, lineType });

    // Collect station node IDs from members list
    for (const member of relation.members || []) {
      if (
        member.type === 'node' &&
        member.lat && member.lon &&
        (member.role === 'stop' || member.role === 'stop_entry_only' || member.role === 'stop_exit_only' || member.role === '')
      ) {
        stationNodeIdsSet.add(member.ref);
      }
    }
  }

  const stationNodeIds = Array.from(stationNodeIdsSet);
  console.log(`🚆 Found ${stationNodeIds.length} station node IDs. Fetching names…`);
  const nodeNames = await fetchNodeNames(stationNodeIds);

  const lines = [];

  for (const [ref, variants] of byRef) {
    // Pick the best variant: prefer the one whose first station is farthest from home
    // (that's the "outbound" direction, i.e., away from Berlin)
    // We want stations ordered: far end → Berlin end, so the first stations are
    // the ones the user would board at (far from home) and we route back from them.

    // Actually: for the algorithm, station ORDER doesn't matter much — we pick by
    // crow-flies distance. So we just need UNIQUE stations across all variants.

    const allStations = new Map(); // osm id → station object
    let bestName = variants[0].relation.tags?.name || ref;
    const lineType = variants[0].lineType;
    let totalGeometry = [];

    for (const { relation } of variants) {
      // Collect station nodes
      for (const member of relation.members || []) {
        if (
          member.type === 'node' &&
          member.lat && member.lon &&
          (member.role === 'stop' || member.role === 'stop_entry_only' || member.role === 'stop_exit_only' || member.role === '')
        ) {
          const id = `osm:${member.ref}`;
          if (!allStations.has(id)) {
            const name = nodeNames.get(member.ref) || member.tags?.name || `Station ${member.ref}`;
            allStations.set(id, {
              id,
              name,
              lat: member.lat,
              lon: member.lon,
            });
          }
        }
      }

      // Collect geometry (all ways, both directions)
      for (const member of relation.members || []) {
        if (member.type === 'way' && member.geometry && member.geometry.length > 0) {
          totalGeometry.push(member.geometry.map(p => [p.lon, p.lat]));
        }
      }

      // Use the longer name as canonical
      const n = relation.tags?.name || '';
      if (n.length > bestName.length) bestName = n;
    }

    const stations = Array.from(allStations.values());
    if (stations.length === 0) continue;

    // Check reach
    const maxDist = Math.max(...stations.map(s => haversineKm(ALEX, s)));
    if (maxDist < MIN_REACH_KM) {
      console.log(`  ⏭ Skipping ${ref} — max reach ${maxDist.toFixed(1)} km`);
      continue;
    }

    const color = SBAHN_COLORS[ref] || REGIONAL_LINES[ref] || '#888888';

    // Build a friendly display name
    // e.g. "RE1: Magdeburg → Eisenhüttenstadt" → "RE1"
    const displayName = bestName.replace(/^(S|RE|RB)\d+[a-z]?\s*:?\s*/i, '').trim() || bestName;

    lines.push({
      id: ref,
      ref,
      type: lineType,
      name: `${ref}: ${displayName}`,
      color,
      stations: optimizeStations(stations),
      geometry: optimizeGeometry(totalGeometry),
    });

    console.log(`  ✓ ${ref} — ${displayName} (${stations.length} unique stations, max ${maxDist.toFixed(0)} km)`);
  }

  // Sort: S-Bahn first, then regional, then by ref
  lines.sort((a, b) => {
    if (a.type !== b.type) return a.type === 's-bahn' ? -1 : 1;
    return a.ref.localeCompare(b.ref, undefined, { numeric: true });
  });

  // Safety guard: if Overpass returned implausibly little data (all servers
  // failed, partial responses, broken OSM relations), fail the run instead of
  // overwriting lines.json — the daily workflow would otherwise commit and
  // deploy a gutted rail network.
  const MIN_EXPECTED_LINES = 20;
  if (lines.length < MIN_EXPECTED_LINES) {
    console.error(`❌ Only ${lines.length} lines fetched (expected ≥ ${MIN_EXPECTED_LINES}). Refusing to overwrite lines.json.`);
    process.exit(1);
  }

  const output = {
    generated: new Date().toISOString(),
    center: ALEX,
    lines,
  };

  const outPath = path.join(__dirname, 'lines.json');
  // Minified — this file ships to every visitor's browser
  fs.writeFileSync(outPath, JSON.stringify(output));
  console.log(`\n✅ Wrote ${lines.length} lines to ${outPath}`);
  console.log(`   S-Bahn: ${lines.filter(l => l.type === 's-bahn').length}`);
  console.log(`   Regional: ${lines.filter(l => l.type === 'regional').length}`);
  console.log(`   Total stations: ${lines.reduce((n, l) => n + l.stations.length, 0)}`);
}

// --- Helpers ---

function haversineKm(a, b) {
  const R = 6371;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const sinDlat = Math.sin(dLat / 2);
  const sinDlon = Math.sin(dLon / 2);
  const h = sinDlat * sinDlat + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * sinDlon * sinDlon;
  return 2 * R * Math.asin(Math.sqrt(h));
}

function toRad(deg) { return deg * Math.PI / 180; }

function overpassQuery(query, serverUrl = 'https://overpass-api.de/api/interpreter') {
  return new Promise((resolve, reject) => {
    const body = 'data=' + encodeURIComponent(query);
    const url = new URL(serverUrl);
    const options = {
      hostname: url.hostname,
      path: url.pathname,
      method: 'POST',
      timeout: 90000,
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(body),
        'User-Agent': 'TrainBikePlanner/1.0 (personal project)',
      },
    };

    const req = https.request(options, res => {
      let raw = '';
      res.on('data', chunk => raw += chunk);
      res.on('end', () => {
        if (res.statusCode !== 200) {
          reject(new Error(`HTTP ${res.statusCode}: ${raw.slice(0, 300)}`));
          return;
        }
        try {
          resolve(JSON.parse(raw));
        } catch (e) {
          reject(new Error('Invalid JSON response from Overpass API'));
        }
      });
    });

    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Request timed out')); });
    req.write(body);
    req.end();
  });
}

async function fetchNodeNames(nodeIds) {
  const chunkSize = 400;
  const maxAttempts = 4; // per chunk, across all servers
  const nodeNames = new Map();

  const totalChunks = Math.ceil(nodeIds.length / chunkSize);

  for (let i = 0; i < nodeIds.length; i += chunkSize) {
    if (i > 0) {
      // Sleep to avoid rate limiting (HTTP 429/406) on the primary server
      await new Promise(resolve => setTimeout(resolve, 1500));
    }

    const chunk = nodeIds.slice(i, i + chunkSize);
    const query = `[out:json][timeout:30];node(id:${chunk.join(',')});out tags;`;
    const chunkNum = Math.floor(i / chunkSize) + 1;

    console.log(`   Fetching station names chunk ${chunkNum}/${totalChunks}…`);

    // Retry the whole chunk (each attempt itself falls back across all
    // servers). A dropped chunk used to silently turn every station in it into
    // a "Station <id>" placeholder; instead we retry with backoff and, if it
    // still fails, abort so we never commit placeholder names.
    let result = null;
    let lastErr = null;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        result = await runQueryWithFallback(query);
        break;
      } catch (err) {
        lastErr = err;
        const backoffMs = 2000 * attempt;
        console.warn(`   ⚠️  Name chunk ${chunkNum} attempt ${attempt}/${maxAttempts} failed: ${err.message}. Retrying in ${backoffMs}ms…`);
        await new Promise(resolve => setTimeout(resolve, backoffMs));
      }
    }

    if (!result) {
      throw new Error(
        `Failed to fetch station names for chunk ${chunkNum}/${totalChunks} after ${maxAttempts} attempts: ${lastErr?.message}. ` +
        `Aborting so we don't overwrite lines.json with "Station <id>" placeholders.`
      );
    }

    if (result.elements) {
      for (const el of result.elements) {
        if (el.type === 'node' && el.tags?.name) {
          nodeNames.set(el.id, el.tags.name);
        }
      }
    }
  }

  return nodeNames;
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
