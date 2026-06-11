/**
 * Mobile screenshot test for Train+Bike planner.
 * Runs the real production code flow with offline network interception.
 * Run with: node screenshot-test.mjs
 * Requires dev server running on localhost:5173 (or 5174)
 */
import { chromium, devices } from 'playwright';
import { readFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';

const OUT = './screenshot-test-output';
if (!existsSync(OUT)) mkdirSync(OUT, { recursive: true });

// Auto-detect dev server port
const BASE_URL = await (async () => {
  for (const port of [5173, 5174, 5175]) {
    try { await fetch(`http://localhost:${port}/`); return `http://localhost:${port}/`; } catch {}
  }
  throw new Error('Dev server not found on ports 5173-5175');
})();
console.log(`  🌐 Using ${BASE_URL}`);

const iPhone = devices['iPhone 13'];

// Load mock journey transit JSON data (Alexanderplatz -> Wannsee)
const MOCK_JOURNEY = JSON.parse(
  readFileSync('./scratch/journey_test.json', 'utf8')
);

async function shot(page, name) {
  const path = join(OUT, `${name}.png`);
  await page.screenshot({ path, fullPage: false });
  console.log(`  📸 ${name}.png`);
  return path;
}

(async () => {
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({
    ...iPhone,
    locale: 'en-DE',
    timezoneId: 'Europe/Berlin',
    geolocation: { latitude: 52.5219, longitude: 13.4132 }, // Alexanderplatz
    permissions: ['geolocation'],
  });
  const page = await ctx.newPage();

  // Listen for console logs
  page.on('console', msg => console.log('BROWSER LOG:', msg.text()));
  page.on('pageerror', err => console.error('BROWSER ERROR:', err.message));

  console.log('\n🔍 Train+Bike Mobile Layout Test (Network Interception Mode)\n');

  // Intercept Nominatim reverse geocode
  await page.route('**/reverse?*', async (route) => {
    console.log(`  ✈️ Intercepted Nominatim geocode`);
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      headers: { 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify({
        address: {
          road: "Alexanderplatz",
          city: "Berlin"
        }
      })
    });
  });

  // Intercept lines data query to return only 1 line (makes tests run super fast)
  await page.route('**/data/lines.json', async (route) => {
    console.log(`  ✈️ Intercepted lines.json query`);
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      headers: { 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify({
        generated: "2026-06-11T08:07:03.542Z",
        center: { lat: 52.5219, lon: 13.4132 },
        lines: [
          {
            id: "S7",
            ref: "S7",
            type: "s-bahn",
            name: "S7: Ahrensfelde => Wannsee",
            color: "#6d61f2",
            stations: [
              {
                id: "900100003",
                name: "S+U Alexanderplatz Bhf (Berlin)",
                lat: 52.521508,
                lon: 13.411267
              },
              {
                id: "900053301",
                name: "S Wannsee Bhf (Berlin)",
                lat: 52.421125,
                lon: 13.179226
              }
            ],
            geometry: [
              [
                [13.411267, 52.521508],
                [13.179226, 52.421125]
              ]
            ]
          }
        ]
      })
    });
  });

  // Intercept station mappings query
  await page.route('**/data/station_mappings.json', async (route) => {
    console.log(`  ✈️ Intercepted station_mappings.json query`);
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      headers: { 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify({
        "900053301": "900053301",
        "900100003": "900100003"
      })
    });
  });

  // Intercept nearby locations query (Home location lookup)
  await page.route('**/locations/nearby?*', async (route) => {
    console.log(`  ✈️ Intercepted VBB nearby check: ${route.request().url()}`);
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      headers: { 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify([
        {
          type: 'stop',
          id: '900100003',
          name: 'S+U Alexanderplatz Bhf (Berlin)',
          location: {
            type: 'location',
            id: '900100003',
            latitude: 52.521508,
            longitude: 13.411267
          }
        }
      ])
    });
  });

  // Intercept journeys query (Transit connections calculation)
  await page.route('**/journeys?*', async (route) => {
    console.log(`  ✈️ Intercepted VBB journeys query: ${route.request().url()}`);
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      headers: { 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify(MOCK_JOURNEY)
    });
  });

  // Intercept BRouter queries (Bike routes calculation)
  await page.route('**/brouter?*', async (route) => {
    console.log(`  ✈️ Intercepted BRouter query: ${route.request().url()}`);
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      headers: { 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify({
        type: 'FeatureCollection',
        features: [
          {
            type: 'Feature',
            properties: {
              'track-length': '52000',
              'total-time': '9360'
            },
            geometry: {
              type: 'LineString',
              coordinates: [
                [13.411267, 52.521508, 35],
                [13.178932, 52.421728, 45]
              ]
            }
          }
        ]
      })
    });
  });

  // ── 1. Initial load ──────────────────────────────────────────────────────
  await page.goto(BASE_URL, { waitUntil: 'networkidle' });
  await page.waitForTimeout(1000);
  await shot(page, '01-initial-peek');

  // ── 2. Expand settings programmatically ──────────────────────────────────
  await page.evaluate(() => {
    if (window.__mobileSheet) {
      window.__mobileSheet.expand();
    } else {
      console.error('window.__mobileSheet not found');
    }
  });
  await page.waitForTimeout(600);
  await shot(page, '02-settings-expanded');

  // ── 3. Scroll settings to show Find Routes button ───────────────────────
  await page.evaluate(() => {
    const el = document.querySelector('#mobile-settings-view .mobile-sheet-scroll');
    if (el) el.scrollTop = el.scrollHeight;
  });
  await page.waitForTimeout(200);
  await shot(page, '03-settings-find-routes-button');

  // ── 4. Click Find Routes and wait for search to complete ─────────────────
  console.log('  Calculating routes (using mock intercepted API)...');
  await page.click('#calculate-btn');
  
  // Wait for search progress pill to hide, indicating search completed
  await page.waitForSelector('#mobile-progress-pill', { state: 'hidden', timeout: 35000 });
  await page.waitForTimeout(1000);
  await shot(page, '04-routes-list');

  // ── 5. Select first route card to show details ───────────────────────────
  console.log('  Selecting first route card...');
  await page.click('.route-card:first-child');
  await page.waitForTimeout(800);
  await shot(page, '05-route-details');

  // Scroll to bottom of details
  await page.evaluate(() => {
    const el = document.querySelector('#mobile-details-view .mobile-sheet-scroll');
    if (el) el.scrollTop = el.scrollHeight;
  });
  await page.waitForTimeout(400);
  await shot(page, '06-route-details-scrolled');

  // ── 6. Computed style audit ──────────────────────────────────────────────
  const styles = await page.evaluate(() => {
    const info = (sel, ...props) => {
      const el = document.querySelector(sel);
      if (!el) return `NOT FOUND`;
      const cs = getComputedStyle(el);
      const r = el.getBoundingClientRect();
      const propStr = props.map(p => `${p}:${cs[p]}`).join(' | ');
      return `${propStr} [${r.width.toFixed(0)}×${r.height.toFixed(0)}]`;
    };
    return {
      'details-layout':       info('.details-layout',       'flexDirection', 'width'),
      'details-timeline-col': info('.details-timeline-col', 'width', 'flex'),
      'details-frequency-col':info('.details-frequency-col','width', 'display'),
      'train-details-column': info('#train-details-column', 'width', 'flex'),
      'details-legs-list':    info('.details-legs-list',    'maxHeight', 'overflowY'),
      'dashboard-body':       info('.dashboard-body',       'flexDirection'),
      'route-details-panel':  info('#route-details-panel',  'padding', 'overflowY'),
      'first-timeline-leg':   info('.timeline-leg',         'width', 'padding'),
      'stop-name-element':    info('.leg-stop-name',        'width', 'display', 'color'),
    };
  });

  console.log('\n  📐 Computed styles audit:');
  for (const [k, v] of Object.entries(styles)) {
    console.log(`     ${k.padEnd(22)}: ${v}`);
  }

  await browser.close();
  console.log(`\n✅ Done. Screenshots in ${OUT}/\n`);
})();
