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

// ── Assertion helpers ─────────────────────────────────────────────────────────
let passed = 0, failed = 0;
function assert(condition, description) {
  if (condition) {
    console.log(`  ✅ PASS: ${description}`);
    passed++;
  } else {
    console.error(`  ❌ FAIL: ${description}`);
    failed++;
  }
}

const iPhone = devices['iPhone 13'];

// Load mock journey transit JSON data (Alexanderplatz -> Wannsee)
const MOCK_JOURNEY = JSON.parse(
  readFileSync('./scratch/journey_test.json', 'utf8')
);

// Transitous/MOTIS fallback fixtures — real captured responses, so they exercise
// the quirks the normalizer handles: UTC timestamps, "RE1 (73766)" trip numbers,
// bare-hex route colors, and absent load factors.
const MOCK_MOTIS_PLAN = JSON.parse(
  readFileSync('./scratch/motis_journey_test.json', 'utf8')
);
const MOCK_MOTIS_GEOCODE = JSON.parse(
  readFileSync('./scratch/motis_reverse_geocode_test.json', 'utf8')
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


  console.log('\n🔍 Section A — Mobile layout test (Network Interception Mode)\n');

  // Apply shared network intercepts (52km bike route = strict match for 50km±5km)
  await applyNetworkIntercepts(page, '52000');



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

  await ctx.close();

  // ══════════════════════════════════════════════════════════════════════════
  // SECTION B: "Include additional routes" toggle in sidebar – MOBILE
  // ══════════════════════════════════════════════════════════════════════════
  console.log('\n🔍 Section B — "Include additional routes" sidebar toggle (mobile)\n');

  const ctxMobile = await browser.newContext({
    ...iPhone,
    locale: 'en-DE',
    timezoneId: 'Europe/Berlin',
    geolocation: { latitude: 52.5219, longitude: 13.4132 },
    permissions: ['geolocation'],
  });
  const pageMobile = await ctxMobile.newPage();
  pageMobile.on('console', msg => console.log('BROWSER LOG:', msg.text()));
  pageMobile.on('pageerror', err => console.error('BROWSER ERROR:', err.message));

  // Re-apply intercepts with 57km bike route → |57-50|=7 > tolerance 5 → isSoftMatch=true
  // (must stay ≤ soft tolerance 10km, or the route is discarded entirely)
  await applyNetworkIntercepts(pageMobile, '57000');

  await pageMobile.goto(BASE_URL, { waitUntil: 'networkidle' });
  await pageMobile.waitForTimeout(500);

  // Run a search
  await pageMobile.evaluate(() => window.__mobileSheet?.expand());
  await pageMobile.waitForTimeout(400);
  await pageMobile.evaluate(() => {
    const el = document.querySelector('#mobile-settings-view .mobile-sheet-scroll');
    if (el) el.scrollTop = el.scrollHeight;
  });
  await pageMobile.waitForTimeout(200);
  await pageMobile.click('#calculate-btn');
  await pageMobile.waitForSelector('#mobile-progress-pill', { state: 'hidden', timeout: 35000 });
  await pageMobile.waitForTimeout(800);

  // B1: sidebar toggle exists in the DOM inside the mobile routes view
  // Note: getBoundingClientRect returns 0 inside clipped scroll containers;
  // instead we check the element is present and not display:none.
  const mobileToggleVisible = await pageMobile.evaluate(() => {
    const toggle = document.querySelector('#soft-matches-toggle');
    if (!toggle) return false;
    // Walk up ancestors to verify it's inside the mobile routes view
    const inRoutesView = !!toggle.closest('#mobile-routes-view');
    const notHidden = getComputedStyle(toggle).display !== 'none';
    return inRoutesView && notHidden;
  });
  assert(mobileToggleVisible, 'Mobile: #soft-matches-toggle is present in mobile routes view');
  await shot(pageMobile, 'verify-mobile-01-results-list');

  // B2: toggle is ON by default → routes visible (mock BRouter returns 57km,
  // target is 50km, tolerance 5km → |57-50|=7 > 5 → isSoftMatch=true)
  const mobileRouteCountOn = await pageMobile.evaluate(() =>
    document.querySelectorAll('#mobile-routes-view .route-card').length
  );
  assert(mobileRouteCountOn >= 1, `Mobile: routes shown when toggle ON (got ${mobileRouteCountOn})`);

  // B3: toggle OFF → soft-match routes are hidden → 0 routes in our mock
  await pageMobile.evaluate(() => {
    const toggle = document.querySelector('#soft-matches-toggle');
    if (toggle) { toggle.checked = false; toggle.dispatchEvent(new Event('change')); }
  });
  await pageMobile.waitForTimeout(400);
  const mobileRouteCountOff = await pageMobile.evaluate(() =>
    document.querySelectorAll('#mobile-routes-view .route-card').length
  );
  assert(mobileRouteCountOff === 0, `Mobile: routes hidden when toggle OFF (got ${mobileRouteCountOff})`);
  await shot(pageMobile, 'verify-mobile-02-results-list-filtered');

  // B4: toggling back ON restores the route card
  await pageMobile.evaluate(() => {
    const toggle = document.querySelector('#soft-matches-toggle');
    if (toggle) { toggle.checked = true; toggle.dispatchEvent(new Event('change')); }
  });
  await pageMobile.waitForTimeout(400);
  const mobileRouteCountRestored = await pageMobile.evaluate(() =>
    document.querySelectorAll('#mobile-routes-view .route-card').length
  );
  assert(mobileRouteCountRestored >= 1, `Mobile: routes restored when toggle turned ON again (got ${mobileRouteCountRestored})`);

  // B5: sidebar-toggle-count badge updates when toggle is turned OFF
  const mobileBadgeOff = await pageMobile.evaluate(() => {
    const toggle = document.querySelector('#soft-matches-toggle');
    if (toggle) { toggle.checked = false; toggle.dispatchEvent(new Event('change')); }
    return new Promise(r => setTimeout(() => {
      // The count is kept in #sidebar-toggle-count (the floating button badge)
      const badge = document.querySelector('#sidebar-toggle-count');
      r(badge ? badge.textContent.trim() : null);
    }, 400));
  });
  assert(mobileBadgeOff === '0', `Mobile: #sidebar-toggle-count shows "0" when toggle is OFF (got "${mobileBadgeOff}")`);

  await ctxMobile.close();

  // ══════════════════════════════════════════════════════════════════════════
  // SECTION C: "Include additional routes" toggle in sidebar – DESKTOP
  // ══════════════════════════════════════════════════════════════════════════
  console.log('\n🔍 Section C — "Include additional routes" sidebar toggle (desktop)\n');

  const ctxDesktop = await browser.newContext({
    viewport: { width: 1280, height: 800 },
    locale: 'en-DE',
    timezoneId: 'Europe/Berlin',
    geolocation: { latitude: 52.5219, longitude: 13.4132 },
    permissions: ['geolocation'],
  });
  const pageDesktop = await ctxDesktop.newPage();
  pageDesktop.on('console', msg => console.log('BROWSER LOG:', msg.text()));
  pageDesktop.on('pageerror', err => console.error('BROWSER ERROR:', err.message));

  await applyNetworkIntercepts(pageDesktop, '57000');
  await pageDesktop.goto(BASE_URL, { waitUntil: 'networkidle' });
  await pageDesktop.waitForTimeout(500);
  await pageDesktop.click('#calculate-btn');
  await pageDesktop.waitForFunction(
    () => !document.querySelector('#route-sidebar')?.classList.contains('hidden'),
    { timeout: 35000 }
  );

  await pageDesktop.waitForTimeout(800);

  // C1: sidebar toggle is present and visible on desktop. The raw <input>
  // is a zero-size custom-switch checkbox, so measure its visible wrapper
  // (the .switch label) instead.
  const desktopToggleVisible = await pageDesktop.evaluate(() => {
    const toggle = document.querySelector('#soft-matches-toggle');
    if (!toggle) return false;
    const inSidebar = !!toggle.closest('#route-sidebar');
    const wrapper = toggle.closest('label') || toggle.parentElement;
    const rect = wrapper.getBoundingClientRect();
    return inSidebar && rect.width > 0 && rect.height > 0;
  });
  assert(desktopToggleVisible, 'Desktop: #soft-matches-toggle is visible in route sidebar');
  await shot(pageDesktop, 'verify-desktop-01-results');

  // C2: settings panel toggle is hidden on desktop (moved to sidebar)
  const desktopSettingsToggleHidden = await pageDesktop.evaluate(() => {
    const toggle = document.querySelector('#control-panel #soft-matches-toggle-settings');
    if (!toggle) return true; // not present = effectively hidden
    const rect = toggle.getBoundingClientRect();
    return rect.width === 0 || rect.height === 0 ||
           getComputedStyle(toggle.closest('.toggle-row') || toggle).display === 'none';
  });
  assert(desktopSettingsToggleHidden, 'Desktop: settings panel toggle is hidden/removed (toggle lives only in sidebar)');

  // C3: changing a setting makes the calculate button show "Update Routes" (stale state).
  // Use the tolerance slider (5 → 8): it marks settings stale but keeps the 57km mock
  // route a strict match (|57-50|=7 ≤ 8) so the C4 re-search still finds it. Changing
  // the distance instead would make the mock line ineligible (minCrowFlies pre-filter
  // in stationFinder.js) or push the route past the soft tolerance.
  await pageDesktop.evaluate(() => {
    const slider = document.querySelector('#tolerance-slider');
    if (slider) {
      slider.value = 8;
      slider.dispatchEvent(new Event('input'));
    }
  });
  await pageDesktop.waitForTimeout(400);
  const calcBtnText = await pageDesktop.evaluate(() =>
    document.querySelector('#calculate-btn')?.textContent?.trim()
  );
  assert(
    calcBtnText === 'Update Routes',
    `Desktop: calculate button shows "Update Routes" when settings are stale (got "${calcBtnText}")`
  );
  await shot(pageDesktop, 'verify-desktop-02-stale-state');

  // C4: after re-calculating, button reverts to "Find Routes"
  await pageDesktop.click('#calculate-btn');
  // Wait for route count to show a result (sidebar unhides and route-count is set)
  await pageDesktop.waitForFunction(
    () => !document.querySelector('#route-sidebar')?.classList.contains('hidden'),
    { timeout: 35000 }
  );
  await pageDesktop.waitForTimeout(800);
  const calcBtnTextAfter = await pageDesktop.evaluate(() =>
    document.querySelector('#calculate-btn')?.textContent?.trim()
  );
  assert(
    calcBtnTextAfter === 'Find Routes',
    `Desktop: calculate button reverts to "Find Routes" after re-search (got "${calcBtnTextAfter}")`
  );
  await shot(pageDesktop, 'verify-desktop-03-restored');

  await ctxDesktop.close();

  await browser.close();

  // ── Final summary ─────────────────────────────────────────────────────────
  console.log(`\n${'─'.repeat(50)}`);
  console.log(`  Results: ${passed} passed, ${failed} failed`);
  if (failed === 0) {
    console.log(`  ✅ All ${passed} assertions passed.`);
  } else {
    console.error(`  ❌ ${failed} assertion(s) FAILED.`);
    process.exit(1);
  }
  console.log(`\n📸 Screenshots in ${OUT}/\n`);
})();

// ── Shared network intercept helper ──────────────────────────────────────────
const MOCK_JOURNEY_DATA = MOCK_JOURNEY; // alias so the helper can access it

/**
 * @param {string} trackLengthM  BRouter track length to report
 * @param {boolean} failHafas    503 both HAFAS mirrors so the ladder falls
 *                               through to the Transitous/MOTIS intercepts
 */
async function applyNetworkIntercepts(page, trackLengthM = '52000', failHafas = false) {
  await page.route('**/reverse?*', route => route.fulfill({
    status: 200, contentType: 'application/json',
    headers: { 'Access-Control-Allow-Origin': '*' },
    body: JSON.stringify({ address: { road: 'Alexanderplatz', city: 'Berlin' } }),
  }));
  await page.route('**/data/lines.json', route => route.fulfill({
    status: 200, contentType: 'application/json',
    headers: { 'Access-Control-Allow-Origin': '*' },
    body: JSON.stringify({
      generated: '2026-06-11T08:07:03.542Z',
      center: { lat: 52.5219, lon: 13.4132 },
      lines: [{
        id: 'S7', ref: 'S7', type: 's-bahn', name: 'S7: Ahrensfelde => Wannsee', color: '#6d61f2',
        stations: [
          { id: '900100003', name: 'S+U Alexanderplatz Bhf (Berlin)', lat: 52.521508, lon: 13.411267 },
          { id: '900053301', name: 'S Wannsee Bhf (Berlin)', lat: 52.421125, lon: 13.179226 },
        ],
        geometry: [[[13.411267, 52.521508], [13.179226, 52.421125]]],
      }],
    }),
  }));
  await page.route('**/data/station_mappings.json', route => route.fulfill({
    status: 200, contentType: 'application/json',
    headers: { 'Access-Control-Allow-Origin': '*' },
    body: JSON.stringify({ '900053301': '900053301', '900100003': '900100003' }),
  }));
  await page.route('**/locations/nearby?*', route => route.fulfill({
    status: 200, contentType: 'application/json',
    headers: { 'Access-Control-Allow-Origin': '*' },
    body: JSON.stringify([{
      type: 'stop', id: '900100003', name: 'S+U Alexanderplatz Bhf (Berlin)',
      location: { type: 'location', id: '900100003', latitude: 52.521508, longitude: 13.411267 },
    }]),
  }));
  await page.route('**/journeys?*', route => route.fulfill({
    status: 200, contentType: 'application/json',
    headers: { 'Access-Control-Allow-Origin': '*' },
    body: JSON.stringify(MOCK_JOURNEY_DATA),
  }));
  await page.route('**/brouter?*', route => route.fulfill({
    status: 200, contentType: 'application/json',
    headers: { 'Access-Control-Allow-Origin': '*' },
    body: JSON.stringify({
      type: 'FeatureCollection',
      features: [{
        type: 'Feature',
        properties: { 'track-length': trackLengthM, 'total-time': '9360' },
        geometry: { type: 'LineString', coordinates: [[13.411267, 52.521508, 35], [13.178932, 52.421728, 45]] },
      }],
    }),
  }));

  // Transitous/MOTIS backup backend. The globs above are host-agnostic, so these
  // sit alongside them rather than replacing them.
  await page.route('**/api/v1/reverse-geocode?*', route => route.fulfill({
    status: 200, contentType: 'application/json',
    headers: { 'Access-Control-Allow-Origin': '*' },
    body: JSON.stringify(MOCK_MOTIS_GEOCODE),
  }));
  await page.route('**/api/v1/plan?*', route => route.fulfill({
    status: 200, contentType: 'application/json',
    headers: { 'Access-Control-Allow-Origin': '*' },
    body: JSON.stringify(MOCK_MOTIS_PLAN),
  }));

  // Registered last so it wins over the generic globs (Playwright matches the
  // most recently added route first).
  if (failHafas) {
    for (const host of ['v6.vbb.transport.rest', 'v6.bvg.transport.rest']) {
      await page.route(`**://${host}/**`, route => route.fulfill({
        status: 503, contentType: 'application/json',
        headers: { 'Access-Control-Allow-Origin': '*' },
        body: '{"error":"simulated outage"}',
      }));
    }
  }
}
