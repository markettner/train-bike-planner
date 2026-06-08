#!/usr/bin/env node
/**
 * fetch-regional.js
 * Fetches only RE/RB regional train data and merges into existing lines.json.
 * Run this if fetch-stations.js timed out on regional data.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import https from 'https';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LINES_PATH = path.join(__dirname, 'lines.json');

const BBOX = '51.30,11.20,53.60,14.90';
const MIN_REACH_KM = 15;
const ALEX = { lat: 52.5219, lon: 13.4132 };

const REGIONAL_LINES = {
  'FEX':'#e5001c',
  'RE1':'#e5001c','RE2':'#bc0053','RE3':'#6e1985','RE4':'#6e1985',
  'RE5':'#0066b3','RE6':'#007a4d','RE7':'#007a4d','RE8':'#e5001c',
  'RE10':'#e5001c','RE11':'#e5001c','RE13':'#bc0053','RE15':'#e5001c',
  'RE18':'#0066b3','RE20':'#bc0053','RE30':'#007a4d',
  'RB10':'#e5001c','RB12':'#e5001c','RB14':'#e5001c','RB20':'#7B6A9D',
  'RB21':'#7B6A9D','RB22':'#3bbbd4','RB23':'#3bbbd4','RB24':'#55a822',
  'RB25':'#e5001c','RB26':'#e5001c','RB27':'#55a822','RB31':'#0066b3',
  'RB32':'#55a822','RB33':'#007a4d','RB34':'#007a4d','RB35':'#007a4d',
  'RB36':'#007a4d','RB43':'#e46a1a','RB49':'#0066b3','RB54':'#0066b3',
  'RB55':'#007a4d','RB60':'#007a4d','RB63':'#007a4d','RB66':'#007a4d',
};

const query = `
[out:json][timeout:90];
(
  relation["route"="train"]["ref"~"^(RE|RB)[0-9]+$|FEX"](${BBOX});
)->.r;
.r out geom;
node(r);
out tags;
`;

const SERVERS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
];

async function main() {
  console.log('🚆 Fetching regional train data…');

  let data = null;
  for (const server of SERVERS) {
    try {
      console.log(`   Trying ${new URL(server).hostname}…`);
      data = await overpassQuery(query, server);
      console.log(`   ✅ Got relations and nodes from ${new URL(server).hostname}`);
      break;
    } catch (err) {
      console.warn(`   ⚠️ Failed: ${err.message}`);
    }
  }

  if (!data) {
    console.error('❌ All servers failed. Try again later.');
    process.exit(1);
  }

  // Build Map of node ID -> name from separate node elements
  const nodeNames = new Map();
  for (const el of data.elements) {
    if (el.type === 'node' && el.tags?.name) {
      nodeNames.set(el.id, el.tags.name);
    }
  }

  // Group by ref, deduplicate bidirectional
  const byRef = new Map();
  for (const relation of data.elements) {
    if (relation.type !== 'relation') continue;
    const ref = relation.tags?.ref;
    if (!ref || !REGIONAL_LINES[ref]) continue;
    if (!byRef.has(ref)) byRef.set(ref, []);
    byRef.get(ref).push(relation);
  }

  const newLines = [];
  for (const [ref, variants] of byRef) {
    const allStations = new Map();
    let bestName = '';
    const geometry = [];

    for (const rel of variants) {
      for (const m of rel.members || []) {
        if (m.type === 'node' && m.lat && m.lon &&
            ['stop','stop_entry_only','stop_exit_only',''].includes(m.role)) {
          const id = `osm:${m.ref}`;
          if (!allStations.has(id)) {
            const name = nodeNames.get(m.ref) || m.tags?.name || `Station ${m.ref}`;
            allStations.set(id, { id, name, lat: m.lat, lon: m.lon });
          }
        }
        if (m.type === 'way' && m.geometry && m.geometry.length > 0) {
          geometry.push(m.geometry.map(p => [p.lon, p.lat]));
        }
      }
      const n = rel.tags?.name || '';
      if (n.length > bestName.length) bestName = n;
    }

    const stations = Array.from(allStations.values());
    if (!stations.length) continue;
    const maxDist = Math.max(...stations.map(s => haversineKm(ALEX, s)));
    if (maxDist < MIN_REACH_KM) continue;

    const displayName = bestName.replace(/^(RE|RB)\d+[a-z]?\s*:?\s*/i, '').trim() || bestName;
    newLines.push({
      id: ref, ref, type: 'regional',
      name: `${ref}: ${displayName}`,
      color: REGIONAL_LINES[ref],
      stations, geometry,
    });
    console.log(`  ✓ ${ref} — ${displayName} (${stations.length} stations, max ${maxDist.toFixed(0)} km)`);
  }

  // Merge with existing lines.json (keep S-Bahn, replace regional)
  let existing = { generated: new Date().toISOString(), center: ALEX, lines: [] };
  if (fs.existsSync(LINES_PATH)) {
    existing = JSON.parse(fs.readFileSync(LINES_PATH, 'utf8'));
  }

  const sbahnLines = existing.lines.filter(l => l.type === 's-bahn');
  const merged = [
    ...sbahnLines,
    ...newLines,
  ].sort((a, b) => {
    if (a.type !== b.type) return a.type === 's-bahn' ? -1 : 1;
    return a.ref.localeCompare(b.ref, undefined, { numeric: true });
  });

  fs.writeFileSync(LINES_PATH, JSON.stringify({ ...existing, generated: new Date().toISOString(), lines: merged }, null, 2));
  console.log(`\n✅ Merged ${sbahnLines.length} S-Bahn + ${newLines.length} regional = ${merged.length} total lines`);
  console.log(`   Total stations: ${merged.reduce((n, l) => n + l.stations.length, 0)}`);
}

function haversineKm(a, b) {
  const R = 6371, dLat = toRad(b.lat-a.lat), dLon = toRad(b.lon-a.lon);
  const h = Math.sin(dLat/2)**2 + Math.cos(toRad(a.lat))*Math.cos(toRad(b.lat))*Math.sin(dLon/2)**2;
  return 2*R*Math.asin(Math.sqrt(h));
}
function toRad(d) { return d*Math.PI/180; }

function overpassQuery(query, serverUrl) {
  return new Promise((resolve, reject) => {
    const body = 'data=' + encodeURIComponent(query);
    const url = new URL(serverUrl);
    const req = https.request({
      hostname: url.hostname, path: url.pathname, method: 'POST', timeout: 70000,
      headers: { 'Content-Type':'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(body), 'User-Agent':'TrainBikePlanner/1.0' }
    }, res => {
      let raw = '';
      res.on('data', c => raw += c);
      res.on('end', () => {
        if (res.statusCode !== 200) { reject(new Error(`HTTP ${res.statusCode}`)); return; }
        try { resolve(JSON.parse(raw)); } catch(e) { reject(new Error('Invalid JSON')); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
    req.write(body); req.end();
  });
}

main().catch(err => { console.error(err); process.exit(1); });
