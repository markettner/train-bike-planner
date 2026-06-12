#!/usr/bin/env node
/**
 * optimize-lines.js
 *
 * Re-processes an existing data/lines.json in place: simplifies geometry,
 * rounds coordinates, and writes minified JSON. The fetch scripts apply the
 * same optimization at generation time — this script exists to slim down a
 * lines.json produced before optimization, without re-querying Overpass.
 *
 * Run: node data/optimize-lines.js
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { optimizeGeometry, optimizeStations } from './geometry-utils.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LINES_PATH = path.join(__dirname, 'lines.json');

const before = fs.statSync(LINES_PATH).size;
const data = JSON.parse(fs.readFileSync(LINES_PATH, 'utf8'));

let pointsBefore = 0;
let pointsAfter = 0;

for (const line of data.lines) {
  pointsBefore += line.geometry.reduce((n, seg) => n + seg.length, 0);
  line.geometry = optimizeGeometry(line.geometry);
  line.stations = optimizeStations(line.stations);
  pointsAfter += line.geometry.reduce((n, seg) => n + seg.length, 0);
}

fs.writeFileSync(LINES_PATH, JSON.stringify(data));
const after = fs.statSync(LINES_PATH).size;

console.log(`✅ Optimized ${data.lines.length} lines`);
console.log(`   Geometry points: ${pointsBefore} → ${pointsAfter}`);
console.log(`   File size: ${(before / 1e6).toFixed(1)} MB → ${(after / 1e6).toFixed(1)} MB`);
