import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const LINES_PATH = path.join(__dirname, '../data/lines.json');
const MAPPING_PATH = path.join(__dirname, '../data/station_mappings.json');

async function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function main() {
  console.log('Starting VBB Station ID mapping...');

  // 1. Load lines data
  if (!fs.existsSync(LINES_PATH)) {
    console.error(`Error: lines.json not found at ${LINES_PATH}`);
    process.exit(1);
  }
  const linesData = JSON.parse(fs.readFileSync(LINES_PATH, 'utf8'));

  // 2. Extract unique stations
  const uniqueStations = new Map();
  linesData.lines.forEach(line => {
    line.stations.forEach(station => {
      uniqueStations.set(station.id, station);
    });
  });
  console.log(`Found ${uniqueStations.size} unique stations to map.`);

  // 3. Load existing mappings for resumption
  let mappings = {};
  if (fs.existsSync(MAPPING_PATH)) {
    try {
      mappings = JSON.parse(fs.readFileSync(MAPPING_PATH, 'utf8'));
      console.log(`Loaded ${Object.keys(mappings).length} existing mappings from ${MAPPING_PATH}.`);
    } catch (err) {
      console.warn('Could not parse existing station_mappings.json, starting fresh.', err.message);
    }
  }

  const stationsToMap = Array.from(uniqueStations.values()).filter(s => !mappings[s.id]);
  console.log(`${stationsToMap.length} stations left to map.`);

  if (stationsToMap.length === 0) {
    console.log('All stations already mapped!');
    return;
  }

  // 4. Map remaining stations with rate-limiting
  let successCount = 0;
  let failCount = 0;

  for (let i = 0; i < stationsToMap.length; i++) {
    const station = stationsToMap[i];
    const progress = `[${i + 1}/${stationsToMap.length}]`;

    let attempt = 0;
    let resolvedId = null;

    while (attempt < 3 && !resolvedId) {
      try {
        const url = `https://v6.vbb.transport.rest/locations/nearby?latitude=${station.lat}&longitude=${station.lon}&results=1`;
        const response = await fetch(url, {
          headers: { 'User-Agent': 'TrainBikeRoutePlanner-StationMapper' }
        });

        if (response.status === 429) {
          console.warn(`${progress} Rate limited. Sleeping 5 seconds...`);
          await sleep(5000);
          attempt++;
          continue;
        }

        if (!response.ok) {
          throw new Error(`HTTP error ${response.status}`);
        }

        const data = await response.json();
        if (data && data[0] && data[0].id) {
          resolvedId = data[0].id;
        } else {
          throw new Error('No nearby station found in response');
        }
      } catch (err) {
        attempt++;
        console.warn(`${progress} Attempt ${attempt} failed for ${station.name}:`, err.message);
        if (attempt < 3) {
          await sleep(2000);
        }
      }
    }

    if (resolvedId) {
      mappings[station.id] = resolvedId;
      successCount++;
      console.log(`${progress} Mapped: "${station.name}" -> ${resolvedId}`);
    } else {
      failCount++;
      console.error(`${progress} Failed to map: "${station.name}"`);
    }

    // Save progressively every 10 stations
    if ((successCount + failCount) % 10 === 0) {
      fs.writeFileSync(MAPPING_PATH, JSON.stringify(mappings, null, 2), 'utf8');
      console.log(`Saved progress: ${Object.keys(mappings).length} total mapped stations.`);
    }

    // Rate limiting delay (approx. 85 reqs/min)
    await sleep(700);
  }

  // Final save
  fs.writeFileSync(MAPPING_PATH, JSON.stringify(mappings, null, 2), 'utf8');
  console.log(`Mapping finished! Success: ${successCount}, Failed: ${failCount}. Total mapped: ${Object.keys(mappings).length}`);
}

main().catch(err => {
  console.error('Unhandled script error:', err);
  process.exit(1);
});
