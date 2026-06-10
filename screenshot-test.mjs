/**
 * Mobile screenshot test for Train+Bike planner.
 * Run with: node screenshot-test.mjs
 * Requires dev server running on localhost:5173 (or 5174)
 */
import { chromium, devices } from 'playwright';
import { existsSync, mkdirSync } from 'fs';
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

async function shot(page, name) {
  const path = join(OUT, `${name}.png`);
  await page.screenshot({ path, fullPage: false });
  console.log(`  📸 ${name}.png`);
  return path;
}

// Mock train stats that would come from a real API response
const MOCK_TRAIN_STATS = {
  legs: [
    { lineName: 'S9',   lineColor: { bg: '#8B1A1A', fg: '#fff' }, duration: 2,  depTime: '04:24', arrTime: '04:26', originName: 'Hackescher Markt',        destName: 'Ostbahnhof',           depPlatform: '4', arrPlatform: '6' },
    { lineName: 'Walk', lineColor: { bg: '#888',    fg: '#fff' }, duration: 0,  depTime: '04:26', arrTime: '04:26', originName: 'Ostbahnhof',               destName: 'Ostbahnhof (Ausgang)', depPlatform: null, arrPlatform: null },
    { lineName: 'S25',  lineColor: { bg: '#006D35', fg: '#fff' }, duration: 34, depTime: '04:33', arrTime: '05:07', originName: 'Ostbahnhof',               destName: 'Hennigsdorf',          depPlatform: '12', arrPlatform: '1a' },
    { lineName: 'Walk', lineColor: { bg: '#888',    fg: '#fff' }, duration: 0,  depTime: '05:07', arrTime: '05:07', originName: 'Hennigsdorf (Ausgang)',     destName: 'Hennigsdorf',          depPlatform: null, arrPlatform: null },
    { lineName: 'RB55', lineColor: { bg: '#E8840C', fg: '#fff' }, duration: 28, depTime: '05:10', arrTime: '05:38', originName: 'Hennigsdorf',              destName: 'Kremmen',              depPlatform: '2', arrPlatform: '1' },
  ],
  transfers: 2,
  occupancy: 'low',
  frequency: { label: 'Every 30 min' },
  alternatives: [
    { depTime: '05:10', lines: ['RB55'], occupancy: 'low',    cancelled: false },
    { depTime: '05:40', lines: ['RB55'], occupancy: 'medium', cancelled: false },
    { depTime: '06:10', lines: ['RB55'], occupancy: 'low',    cancelled: false },
  ],
};

// Mock route results (normally come from the algorithm)
const MOCK_RESULTS = [
  {
    id: 'mock-1',
    station: { name: 'Kremmen', id: '900310005' },
    lines: [{ id: 'RB55' }],
    bikeDistance: 52,
    totalDistance: 52,
    trainStats: MOCK_TRAIN_STATS,
    trainStatsStatus: 'success',
  },
  {
    id: 'mock-2',
    station: { name: 'Löwenberg (Mark)', id: '900310006' },
    lines: [{ id: 'RB12' }],
    bikeDistance: 65,
    totalDistance: 65,
    trainStats: { ...MOCK_TRAIN_STATS, frequency: null, alternatives: [] },
    trainStatsStatus: 'success',
  },
];

(async () => {
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({
    ...iPhone,
    locale: 'en-DE',
    timezoneId: 'Europe/Berlin',
    geolocation: { latitude: 52.5219, longitude: 13.4132 },
    permissions: ['geolocation'],
  });
  const page = await ctx.newPage();

  console.log('\n🔍 Train+Bike Mobile Layout Test\n');

  // ── 1. Initial load ──────────────────────────────────────────────────────
  await page.goto(BASE_URL, { waitUntil: 'networkidle' });
  await page.waitForTimeout(1000);
  await shot(page, '01-initial-peek');

  // ── 2. Expand settings by clicking the sheet handle ─────────────────────
  // Click the handle area (more reliable than tap in headless)
  await page.click('.mobile-sheet-handle-area');
  await page.waitForTimeout(600);
  await shot(page, '02-settings-expanded');

  // ── 3. Scroll settings to show Find Routes button ───────────────────────
  await page.evaluate(() => {
    const el = document.querySelector('#mobile-settings-view .mobile-sheet-scroll');
    if (el) el.scrollTop = el.scrollHeight;
  });
  await page.waitForTimeout(200);
  await shot(page, '03-settings-find-routes-button');

  // ── 4. Inject mock results directly and show route list ──────────────────
  await page.evaluate((mockResults) => {
    // Dispatch a custom event that app.js listens to, OR call the render function directly.
    // We'll manually fire the route-display logic by injecting into the route list.
    window.__mockResults = mockResults;

    // Try to call the internal renderResults function if exposed
    // Otherwise manually build route cards in the sheet
    const sheet = document.querySelector('#mobile-routes-view .mobile-sheet-scroll');
    if (!sheet) return;

    // Clear and inject mock route cards
    sheet.innerHTML = '';
    mockResults.forEach((r, i) => {
      const card = document.createElement('div');
      card.className = 'route-card';
      card.dataset.id = r.id;
      card.innerHTML = `
        <div class="route-card-header">
          <div class="route-card-lines">${r.lines.map(l => `<span class="route-line-badge">${l.id}</span>`).join('')}</div>
          <div class="route-card-dist">${r.bikeDistance} km</div>
        </div>
        <div class="route-card-station">${r.station.name}</div>
      `;
      sheet.appendChild(card);
    });
  }, MOCK_RESULTS);

  // Switch the sheet to routes view
  await page.evaluate(() => {
    // Update peek label
    const peekText = document.querySelector('.mobile-sheet-peek-label');
    if (peekText) peekText.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="18 15 12 9 6 15"></polyline></svg> <span class="peek-badge">20</span> routes found`;

    // Activate routes view
    document.querySelectorAll('.mobile-sheet-view').forEach(v => v.classList.remove('active'));
    const rv = document.getElementById('mobile-routes-view');
    if (rv) rv.classList.add('active');

    // Snap sheet to half height
    const sheet = document.getElementById('mobile-sheet');
    const h = window.innerHeight;
    const half = Math.round(h * 0.5);
    if (sheet) sheet.style.transform = `translateY(${h - half}px)`;
    document.documentElement.style.setProperty('--sheet-bottom', `${half}px`);
  });

  await page.waitForTimeout(400);
  await shot(page, '04-routes-list');

  // ── 5. Inject details view content and switch to details ─────────────────
  await page.evaluate((result) => {
    // Populate the details title
    const title = document.getElementById('mobile-details-title');
    if (title) title.textContent = `${result.lines.map(l => l.id).join(' / ')} · ${result.station.name}`;

    // Show details view
    document.querySelectorAll('.mobile-sheet-view').forEach(v => v.classList.remove('active'));
    const dv = document.getElementById('mobile-details-view');
    if (dv) dv.classList.add('active');

    // Expand to full height
    const sheet = document.getElementById('mobile-sheet');
    const h = window.innerHeight;
    const expand = Math.round(h * 0.92);
    if (sheet) sheet.style.transform = `translateY(${h - expand}px)`;
    document.documentElement.style.setProperty('--sheet-bottom', `${expand}px`);
  }, MOCK_RESULTS[0]);

  // Use populateTrainTimeline if accessible, otherwise call our own version
  await page.evaluate((ts) => {
    const col = document.getElementById('train-details-column');
    if (!col) return;

    const occupancyClass = ts.occupancy === 'high' ? 'occupancy-high' : ts.occupancy === 'medium' ? 'occupancy-med' : 'occupancy-low';
    const occupancyLabel = `${ts.occupancy} occupancy`;

    let html = `<div class="details-layout"><div class="details-timeline-col">`;
    html += `<div class="details-summary-header">
      <span class="details-transfers-label">${ts.transfers} transfers</span>
      <span class="details-occupancy-label ${occupancyClass}">${occupancyLabel}</span>
    </div>`;
    html += `<div class="details-legs-list">`;
    ts.legs.forEach(leg => {
      const bg = leg.lineColor?.bg || '#888';
      const fg = leg.lineColor?.fg || '#fff';
      html += `<div class="timeline-leg">
        <div class="leg-header">
          <div class="leg-header-left">
            <span class="leg-badge" style="background:${bg};color:${fg}">${leg.lineName}</span>
          </div>
          <span class="leg-duration">${leg.duration} min</span>
        </div>
        <div class="leg-stops">
          <div class="leg-stop-row">
            <span class="leg-stop-name">➔ ${leg.originName}</span>
            <span class="leg-time">${leg.depTime}${leg.depPlatform ? ` <span class="leg-platform">[Pl. ${leg.depPlatform}]</span>` : ''}</span>
          </div>
          <div class="leg-stop-row secondary">
            <span class="leg-stop-name">➔ ${leg.destName}</span>
            <span class="leg-time muted">${leg.arrTime}${leg.arrPlatform ? ` <span class="leg-platform">[Pl. ${leg.arrPlatform}]</span>` : ''}</span>
          </div>
        </div>
      </div>`;
    });
    html += `</div></div>`; // close legs-list, timeline-col

    if (ts.frequency) {
      html += `<div class="details-frequency-col"><div class="frequency-panel">
        <div class="frequency-panel-header"><span>⏱ Frequency</span><span class="frequency-label">${ts.frequency.label}</span></div>
        <div class="departures-list"><div class="departures-list-title">Next Departures:</div>`;
      ts.alternatives.forEach(a => {
        html += `<div class="departure-row"><div class="departure-row-left">
          <span class="departure-time">${a.depTime}</span>
          <span class="departure-lines">(${a.lines.join('/')})</span>
        </div><span class="departure-occ occ-${a.occupancy}">${a.occupancy}</span></div>`;
      });
      html += `</div></div></div>`;
    }

    html += `</div>`; // close details-layout
    col.innerHTML = html;
  }, MOCK_TRAIN_STATS);

  await page.waitForTimeout(400);
  await shot(page, '05-route-details');

  // Scroll to bottom of details
  await page.evaluate(() => {
    const el = document.querySelector('#mobile-details-view .mobile-sheet-scroll');
    if (el) el.scrollTop = el.scrollHeight;
  });
  await page.waitForTimeout(200);
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
      'train-legs-timeline':  info('#train-legs-timeline',  'maxHeight', 'overflowY'),
      'details-legs-list':    info('.details-legs-list',    'maxHeight', 'overflowY'),
      'dashboard-body':       info('.dashboard-body',       'flexDirection'),
      'route-details-panel':  info('#route-details-panel',  'padding', 'overflowY'),
      'first-timeline-leg':   info('.timeline-leg',         'width', 'padding'),
    };
  });

  console.log('\n  📐 Computed styles audit:');
  for (const [k, v] of Object.entries(styles)) {
    console.log(`     ${k.padEnd(22)}: ${v}`);
  }

  await browser.close();
  console.log(`\n✅ Done. Screenshots in ${OUT}/\n`);
})();
