/**
 * BRouter API wrapper with rate limiting and response caching.
 *
 * Public BRouter endpoint: https://brouter.de/brouter
 * Profiles: trekking, fastbike, gravel, ...
 *
 * Request format:
 *   GET /brouter?lonlats=lon1,lat1|lon2,lat2&profile=trekking&alternativeidx=0&format=geojson
 */

const BROUTER_BASE = 'https://brouter.de/brouter';
const REQUEST_DELAY_MS = 1100; // ~1 req/sec, safely under limits
const MAX_RETRIES = 2;
const TIMEOUT_MS = 30000;

// In-memory cache keyed by "lon1,lat1|lon2,lat2|profile"
const routeCache = new Map();

let lastRequestTime = 0;

/**
 * Calculate a bike route between two coordinates.
 * Returns the full GeoJSON FeatureCollection from BRouter, or null on failure.
 *
 * @param {{lat: number, lon: number}} from
 * @param {{lat: number, lon: number}} to
 * @param {string} profile  - e.g. 'trekking', 'fastbike', 'gravel'
 * @returns {Promise<object|null>} GeoJSON FeatureCollection
 */
export async function calculateBikeRoute(from, to, profile = 'trekking') {
  const cacheKey = `${from.lon.toFixed(5)},${from.lat.toFixed(5)}|${to.lon.toFixed(5)},${to.lat.toFixed(5)}|${profile}`;

  if (routeCache.has(cacheKey)) {
    return routeCache.get(cacheKey);
  }

  // Rate limiting — enforce minimum delay between requests
  const now = Date.now();
  const elapsed = now - lastRequestTime;
  if (elapsed < REQUEST_DELAY_MS) {
    await sleep(REQUEST_DELAY_MS - elapsed);
  }

  const url = buildUrl(from, to, profile);
  let attempt = 0;

  while (attempt <= MAX_RETRIES) {
    try {
      lastRequestTime = Date.now();
      const result = await fetchWithTimeout(url, TIMEOUT_MS);
      routeCache.set(cacheKey, result);
      return result;
    } catch (err) {
      attempt++;
      if (attempt > MAX_RETRIES) {
        console.warn(`BRouter failed after ${MAX_RETRIES + 1} attempts:`, err.message);
        return null;
      }
      // Exponential backoff
      await sleep(1000 * attempt);
    }
  }

  return null;
}

/**
 * Extract distance in km from a BRouter GeoJSON response.
 */
export function extractDistance(geojson) {
  if (!geojson?.features?.[0]?.properties) return null;
  const props = geojson.features[0].properties;
  // BRouter returns 'track-length' in meters
  const meters = parseFloat(props['track-length']);
  if (isNaN(meters)) return null;
  return meters / 1000;
}

/**
 * Extract total elevation gain in meters from a BRouter GeoJSON response.
 * (Berlin's surroundings are flat, so gain is only used for the GPX description.)
 */
export function extractElevationGain(geojson) {
  const coords = geojson?.features?.[0]?.geometry?.coordinates;
  if (!coords?.length) return null;

  let gain = 0;
  let prevElev = null;
  for (const [, , elev] of coords) {
    if (elev == null) continue;
    if (prevElev != null && elev > prevElev) gain += elev - prevElev;
    prevElev = elev;
  }
  return Math.round(gain);
}

/**
 * Extract estimated time from BRouter response (in minutes).
 */
export function extractTime(geojson) {
  if (!geojson?.features?.[0]?.properties) return null;
  const props = geojson.features[0].properties;
  const seconds = parseFloat(props['total-time']);
  if (isNaN(seconds)) return null;
  return Math.round(seconds / 60);
}

// --- Helpers ---

function buildUrl(from, to, profile) {
  const lonlats = `${from.lon},${from.lat}|${to.lon},${to.lat}`;
  return `${BROUTER_BASE}?lonlats=${encodeURIComponent(lonlats)}&profile=${profile}&alternativeidx=0&format=geojson`;
}

async function fetchWithTimeout(url, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// --- VBB Transit helpers ---

let stationMappings = {};
let homeVbbId = null;
let homeVbbCoords = null;
// The stop-ID namespace homeVbbId was resolved in, so we can detect when a
// mid-search failover has left it in the wrong namespace and re-resolve it.
let homeVbbBackend = null;

// Per-endpoint timeout for transit requests. Public HAFAS mirrors degrade by
// hanging rather than erroring, so without this a stalled VBB request would
// never reject and the fallbacks below would never be reached.
const TRANSIT_TIMEOUT_MS = 8000;

// Transit backends in preference order.
//
// VBB is authoritative for the whole Berlin/Brandenburg region (S-Bahn,
// regional, U-Bahn, tram, bus). BVG is a second HAFAS mirror that speaks the
// byte-identical wire format AND shares VBB's 900xxxxxxx stop-ID namespace, so
// it costs nothing to add and station_mappings.json stays valid against it —
// but it's the same mirror ecosystem, so it covers blips, not a HAFAS sunset.
// Transitous (MOTIS) is the independent last resort: a different operator, a
// different data source (GTFS), and a different wire format, hence the
// normalizer below.
//
// The previous DB rung was removed: the upstream DB HAFAS endpoint shut down
// permanently, and v6.db.transport.rest now hangs for ~10s before returning
// 503 — it burnt the whole TRANSIT_TIMEOUT_MS on every failover and never
// served a journey.
//
// Critically, each backend has its OWN stop-ID namespace (VBB/BVG: 900xxxxxxx;
// Transitous: feed-prefixed IFOPT like de-VBB_de:11000:900100537). They are NOT
// interchangeable, so a journey query must use IDs resolved against the same
// backend serving it — see getStationVbbId / getHomeVbbId, which route through
// the active backend.
const TRANSIT_BACKENDS = [
  { kind: 'vbb',        format: 'hafas', base: 'https://v6.vbb.transport.rest' },
  { kind: 'bvg',        format: 'hafas', base: 'https://v6.bvg.transport.rest' },
  { kind: 'transitous', format: 'motis', base: 'https://api.transitous.org' },
];

// The backend serving the current search, chosen on the first successful
// transit call and reused for the rest of the search so every ID (home,
// stations, journeys) shares one namespace.
let activeBackend = null;
// Stop IDs resolved by coordinates, keyed by namespace then station.id. Kept
// per-namespace so IDs never mix. HAFAS backends instead read through the
// pre-computed stationMappings, which are already 900xxxxxxx IDs.
let stopIdCacheByNamespace = {};
// Set once any request in this search has failed, which drops activeBackend
// back to null. Without this flag a null activeBackend is ambiguous: at search
// start it means "VBB not tried yet, the pre-computed 900xxxxxxx mappings are
// the right guess", but after a failure it means "the next backend to answer
// may be Transitous, whose IDs look nothing like those". Guessing HAFAS in the
// second case hands 900xxxxxxx IDs to MOTIS, which 404s — so every station
// would report "no connection" while the fallback was actually healthy.
let backendInvalidated = false;

/**
 * Reset backend selection and per-search caches. Called at the start of each
 * search so VBB is re-preferred once it recovers from an outage.
 */
export function resetTransitBackend() {
  activeBackend = null;
  homeVbbId = null;
  homeVbbCoords = null;
  homeVbbBackend = null;
  stopIdCacheByNamespace = {};
  backendInvalidated = false;
}

/**
 * Which backend is currently serving transit requests
 * ('vbb' | 'bvg' | 'transitous' | null).
 */
export function getActiveBackendKind() {
  return activeBackend ? activeBackend.kind : null;
}

/**
 * Fetch a transit endpoint, sticking to one backend for the whole search.
 *
 * The first backend that answers becomes `activeBackend`; later calls go
 * straight to it, so all resolved IDs share a namespace. If the active backend
 * starts failing mid-search, we drop it and re-probe the preference list.
 *
 * Backends no longer share an endpoint layout (HAFAS `/journeys` vs MOTIS
 * `/api/v1/plan`), so callers pass a `buildPath(backend)` function rather than a
 * fixed path, and get back the backend that answered so they know which
 * response format to normalize.
 *
 * @param {(backend: object) => string} buildPath
 * @param {object} [options]  fetch options (e.g. headers)
 * @param {string} [label]    short name for logging
 * @returns {Promise<{backend: object, data: any}>}
 */
async function fetchFromTransitAPI(buildPath, options = {}, label = 'request') {
  // Fast path: reuse the backend already answering this search.
  if (activeBackend) {
    const backend = activeBackend;
    try {
      const res = await fetchResponseWithTimeout(backend.base + buildPath(backend), TRANSIT_TIMEOUT_MS, options);
      if (res.ok) return { backend, data: await res.json() };
      console.warn(`${backend.kind.toUpperCase()} returned ${res.status} for ${label}; re-probing backends...`);
    } catch (err) {
      console.warn(`${backend.kind.toUpperCase()} request failed for ${label} (${err.message}); re-probing backends...`);
    }
    activeBackend = null;
    backendInvalidated = true;
  }

  // Probe backends in preference order; stick to the first that answers.
  let lastErr = null;
  for (const backend of TRANSIT_BACKENDS) {
    try {
      const res = await fetchResponseWithTimeout(backend.base + buildPath(backend), TRANSIT_TIMEOUT_MS, options);
      if (res.ok) {
        activeBackend = backend;
        return { backend, data: await res.json() };
      }
      lastErr = new Error(`${backend.kind} returned status ${res.status}`);
      console.warn(`${backend.kind.toUpperCase()} API returned status ${res.status} for ${label}.`);
    } catch (err) {
      lastErr = err;
      console.warn(`${backend.kind.toUpperCase()} API request failed for ${label} (${err.message}).`);
    }
  }
  backendInvalidated = true;
  console.error(`All transit backends failed for ${label}:`, lastErr?.message);
  throw lastErr || new Error('All transit backends failed');
}

/**
 * fetch() with an abort-based timeout that returns the raw Response.
 * Merges the timeout signal with any caller-supplied options (e.g. headers).
 */
async function fetchResponseWithTimeout(url, timeoutMs, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Load pre-computed VBB station mappings.
 */
export function setStationMappings(mappings) {
  stationMappings = mappings || {};
}

/**
 * Look a stop up by coordinates against whichever backend answers.
 *
 * Both formats expose a coordinate→stop lookup that returns an array of
 * candidates with an `id`, they just live at different paths. This is also the
 * liveness probe that establishes `activeBackend` for the search, so it must
 * stay a real network call for every format.
 *
 * @returns {Promise<{backend: object, id: string}|null>}
 */
async function resolveStopByCoords(lat, lon, label) {
  const { backend, data } = await fetchFromTransitAPI(
    b => (b.format === 'motis'
      ? `/api/v1/reverse-geocode?place=${lat},${lon}&type=STOP`
      : `/locations/nearby?latitude=${lat}&longitude=${lon}&results=1`),
    {},
    label
  );
  const id = Array.isArray(data) ? data[0]?.id : null;
  return id ? { backend, id } : null;
}

/**
 * The namespace station IDs may be read from a cache for, or null when it can't
 * be assumed and must be established by a live lookup.
 *
 * A live activeBackend answers this directly. With no active backend the answer
 * depends on why: before the first request VBB leads the preference list, so the
 * pre-computed 900xxxxxxx mappings are the right assumption and cost no network
 * call. After a failure any backend may answer next, and assuming HAFAS there
 * would feed 900xxxxxxx IDs to MOTIS, which 404s on them.
 */
function assumableNamespace() {
  if (activeBackend) return namespaceOf(activeBackend);
  return backendInvalidated ? null : 'hafas';
}

/**
 * Resolve a candidate station to a stop ID in the ACTIVE backend's namespace.
 *
 * When a HAFAS backend is serving (VBB or BVG — they share the 900xxxxxxx
 * namespace), the pre-computed mappings are valid. On any other backend those
 * IDs don't resolve, so we look the stop up by coordinates and cache it under
 * that namespace. This is what makes a fallback actually return journeys
 * instead of silently empty results.
 */
export async function getStationVbbId(station) {
  if (!station) return null;

  const namespace = assumableNamespace();
  // HAFAS namespace: the pre-computed VBB IDs are valid, no request needed.
  if (namespace === 'hafas' && stationMappings[station.id]) {
    return stationMappings[station.id];
  }
  // Otherwise: reuse an ID already resolved in this namespace.
  if (namespace && stopIdCacheByNamespace[namespace]?.[station.id]) {
    return stopIdCacheByNamespace[namespace][station.id];
  }

  // Resolve live by coordinates against whichever backend answers. This doubles
  // as the probe that re-establishes activeBackend after a failover.
  try {
    const resolved = await resolveStopByCoords(station.lat, station.lon, `stop lookup for ${station.name}`);
    if (resolved) {
      const ns = namespaceOf(resolved.backend);
      if (ns === 'hafas') {
        stationMappings[station.id] = resolved.id; // shared 900xxxxxxx namespace
      } else {
        (stopIdCacheByNamespace[ns] ||= {})[station.id] = resolved.id;
      }
      return resolved.id;
    }
  } catch (err) {
    console.warn(`Failed to resolve station transit ID for ${station.name}:`, err.message);
  }
  return null;
}

/**
 * The stop-ID namespace a backend answers in. VBB and BVG share one, so failing
 * over between them needs no re-resolution; every other backend is its own.
 */
function namespaceOf(backend) {
  if (!backend) return null;
  return backend.format === 'hafas' ? 'hafas' : backend.kind;
}

/**
 * Resolve Home coordinates to a stop ID, caching the result. As the first
 * transit call of a search this also establishes the active backend, so the
 * returned ID and all later station IDs share one namespace.
 */
export async function getHomeVbbId(coords) {
  if (homeVbbId && homeVbbCoords && homeVbbCoords.lat === coords.lat && homeVbbCoords.lon === coords.lon) {
    return homeVbbId;
  }
  try {
    const resolved = await resolveStopByCoords(coords.lat, coords.lon, 'home stop lookup');
    if (resolved) {
      homeVbbId = resolved.id;
      homeVbbCoords = { lat: coords.lat, lon: coords.lon };
      homeVbbBackend = namespaceOf(resolved.backend);
      return homeVbbId;
    }
  } catch (err) {
    console.error('Failed to resolve Home stop ID:', err);
  }
  return null;
}

/**
 * Return the Home stop ID in the ACTIVE backend's namespace.
 *
 * getHomeVbbId resolves the Home ID once at search start, establishing the
 * active backend. But a later station lookup can fail that backend over to
 * another one with a different stop-ID namespace. If that happens, the cached
 * Home ID no longer matches, and pairing it with a freshly-resolved station ID
 * in one journey query would silently return nothing. Re-resolve Home against
 * whatever backend is now active so both IDs always share one namespace.
 *
 * Compared by namespace rather than by kind, so a VBB→BVG failover (same
 * 900xxxxxxx IDs) doesn't spend a request re-resolving to the same value.
 */
export async function getHomeStopIdForActiveBackend() {
  const activeNamespace = assumableNamespace();
  if (!homeVbbCoords || (homeVbbId && homeVbbBackend === activeNamespace)) {
    return homeVbbId;
  }
  try {
    const resolved = await resolveStopByCoords(homeVbbCoords.lat, homeVbbCoords.lon, 'home stop re-resolve');
    if (resolved) {
      homeVbbId = resolved.id;
      homeVbbBackend = namespaceOf(resolved.backend);
    }
  } catch (err) {
    console.warn('Failed to re-resolve Home ID for active backend:', err.message);
  }
  return homeVbbId;
}

/**
 * Query the VBB Journeys API to find the connection from Home to the candidate station.
 * Tries train-only routes first (bus=false), falling back to allowing buses but marking them as locked.
 */
export async function calculateTrainRoute(fromStopId, toStopId, date, time, timeType = 'departure') {
  try {
    let journeys = await fetchConnection(fromStopId, toStopId, date, time, timeType, true);
    let isLocked = false;
    if (!journeys || journeys.length === 0) {
      journeys = await fetchConnection(fromStopId, toStopId, date, time, timeType, false);
      isLocked = true;
    }
    
    if (journeys && journeys.length > 0) {
      // Deduplicate journeys
      const uniqueJourneys = deduplicateJourneys(journeys);
      
      // Calculate frequency
      const frequency = calculateFrequency(uniqueJourneys);
      
      // The primary journey is the first one
      const primaryJourney = uniqueJourneys[0] || journeys[0];
      if (isLocked) {
        primaryJourney.isLocked = true;
      }
      
      // Check for cancellations
      const cancellations = checkCancellations(primaryJourney, frequency);
      
      // Alternatives
      const alternatives = uniqueJourneys.slice(1, 4).map(j => {
        const firstLeg = j.legs[0];
        const lastLeg = j.legs[j.legs.length - 1];
        return {
          depTime: firstLeg ? firstLeg.depTime : '',
          arrTime: lastLeg ? lastLeg.arrTime : '',
          durationMin: j.durationMin,
          lines: j.lines,
          occupancy: j.occupancy,
          cancelled: j.legs.some(l => l.cancelled)
        };
      });
      
      return {
        ...primaryJourney,
        frequency,
        cancellations,
        alternatives
      };
    }
  } catch (err) {
    console.warn(`calculateTrainRoute failed from ${fromStopId} to ${toStopId}:`, err.message);
  }
  return null;
}

const JOURNEY_RESULTS = 8;

// MOTIS transit-mode allowlist standing in for HAFAS's `bus=false`. Keeps every
// rail product plus the local connectors (U-Bahn/tram) the app treats as
// acceptable feeder legs, and drops BUS/COACH.
const MOTIS_RAIL_MODES = [
  'HIGHSPEED_RAIL', 'LONG_DISTANCE', 'NIGHT_RAIL',
  'REGIONAL_FAST_RAIL', 'REGIONAL_RAIL',
  'METRO', 'SUBWAY', 'TRAM',
].join(',');

/**
 * Build an ISO timestamp carrying the browser's local UTC offset, e.g.
 * "2026-07-31T11:00:00+02:00". Both formats accept this: HAFAS uses it to pin
 * the local wall-clock time, and MOTIS parses the offset correctly (verified).
 */
function buildLocalIsoTimestamp(date, time) {
  const localDate = new Date(`${date}T${time}:00`);
  const offsetMin = -localDate.getTimezoneOffset();
  const sign = offsetMin >= 0 ? '+' : '-';
  const pad = num => String(Math.abs(num)).padStart(2, '0');
  const hours = pad(Math.floor(Math.abs(offsetMin) / 60));
  const mins = pad(offsetMin % 60);
  return `${date}T${time}:00${sign}${hours}:${mins}`;
}

/**
 * Build the journey-query path for one backend.
 */
function buildJourneyPath(backend, fromStopId, toStopId, dt, timeType, excludeBuses) {
  if (backend.format === 'motis') {
    const params = new URLSearchParams({
      fromPlace: fromStopId,
      toPlace: toStopId,
      numItineraries: String(JOURNEY_RESULTS),
    });
    if (excludeBuses) params.set('transitModes', MOTIS_RAIL_MODES);
    if (dt) {
      params.set('time', dt);
      if (timeType === 'arrival') params.set('arriveBy', 'true');
    }
    return `/api/v1/plan?${params.toString()}`;
  }

  let path = `/journeys?from=${encodeURIComponent(fromStopId)}&to=${encodeURIComponent(toStopId)}&results=${JOURNEY_RESULTS}`;
  if (excludeBuses) path += '&bus=false';
  if (dt) path += `&${timeType}=${encodeURIComponent(dt)}`;
  return path;
}

/**
 * Query the active backend for connections and normalize them into the app's
 * own journey shape (see normalizeHafasJourneys for the canonical fields).
 */
async function fetchConnection(fromStopId, toStopId, date, time, timeType, excludeBuses) {
  try {
    const dt = (date && time) ? buildLocalIsoTimestamp(date, time) : null;

    const { backend, data } = await fetchFromTransitAPI(
      b => buildJourneyPath(b, fromStopId, toStopId, dt, timeType, excludeBuses),
      { headers: { 'Accept-Language': 'en' } },
      `journeys ${fromStopId} -> ${toStopId}`
    );

    return backend.format === 'motis'
      ? normalizeMotisJourneys(data)
      : normalizeHafasJourneys(data);
  } catch (err) {
    console.warn(`fetchConnection failed from ${fromStopId} to ${toStopId}:`, err.message);
  }
  return null;
}

/**
 * Normalize a HAFAS `/journeys` response into the app's journey shape.
 *
 * This shape is the internal contract every downstream consumer reads —
 * deduplicateJourneys, calculateFrequency, checkCancellations, sortResults in
 * routeList.js, and populateTrainTimeline in routeDetailsPanel.js. Any new
 * backend normalizer must produce exactly these fields.
 */
function normalizeHafasJourneys(data) {
    if (data && data.journeys && data.journeys.length > 0) {
      const processedJourneys = data.journeys.map(journey => {
        const legs = journey.legs || [];
        
        // Calculate total duration in minutes
        const depVal = legs[0]?.departure || legs[0]?.plannedDeparture;
        const arrVal = legs[legs.length - 1]?.arrival || legs[legs.length - 1]?.plannedArrival;
        const depTime = depVal ? new Date(depVal) : null;
        const arrTime = arrVal ? new Date(arrVal) : null;
        const durationMin = (depTime && arrTime && !isNaN(depTime) && !isNaN(arrTime))
          ? Math.round((arrTime - depTime) / 1000 / 60)
          : null;
        
        // Gather unique line names used
        const lines = [];
        legs.forEach(leg => {
          if (leg.line && leg.line.name) {
            lines.push(leg.line.name);
          }
        });
        
        const transitLegsCount = legs.filter(leg => leg.line).length;
        const transfers = Math.max(0, transitLegsCount - 1);
        
        // Extract occupancy & look for bus replacement service indication.
        // Prefer the structured loadFactor field when the API provides it,
        // falling back to free-text remark parsing.
        let occupancy = 'low';
        let hasSEV = false;

        legs.forEach(leg => {
          occupancy = maxOccupancy(occupancy, legOccupancy(leg));
          const remarks = leg.remarks || [];
          remarks.forEach(rem => {
            if (rem.text) {
              const txt = rem.text.toLowerCase();
              if (rem.code === 'EV' || txt.includes('ersatzverkehr') || txt.includes('replacement bus')) {
                hasSEV = true;
              }
            }
          });
        });
        
        // Check if any leg uses a bus
        const usesBus = legs.some(leg => leg.line && (leg.line.mode === 'bus' || leg.line.product === 'bus'));
        
        // Format leg details for popup / side dashboard
        const formattedLegs = legs.map(leg => {
          const isWalking = leg.walking === true || !leg.line;
          const isBus = leg.line && (leg.line.mode === 'bus' || leg.line.product === 'bus');
          const isBusEV = isBus && (leg.remarks || []).some(rem => 
            rem.code === 'EV' || rem.text?.toLowerCase().includes('ersatzverkehr') || rem.text?.toLowerCase().includes('replacement')
          );
          
          const depVal = leg.departure || leg.plannedDeparture;
          const arrVal = leg.arrival || leg.plannedArrival;
          const depTime = depVal ? new Date(depVal) : null;
          const arrTime = arrVal ? new Date(arrVal) : null;
          const duration = (depTime && arrTime && !isNaN(depTime) && !isNaN(arrTime))
            ? Math.round((arrTime - depTime) / 1000 / 60)
            : 0;
          
          return {
            lineName: leg.line?.name || (leg.walking ? 'Walk' : 'Transit'),
            lineColor: leg.line?.color || { bg: '#888', fg: '#fff' },
            originName: leg.origin?.name || 'Start',
            destName: leg.destination?.name || 'End',
            depTime: formatTimeClock(leg.departure || leg.plannedDeparture),
            arrTime: formatTimeClock(leg.arrival || leg.plannedArrival),
            depPlatform: leg.departurePlatform || '',
            arrPlatform: leg.arrivalPlatform || '',
            duration,
            isBus,
            isBusEV,
            cancelled: leg.cancelled === true,
            // null on walking legs, where the question doesn't apply.
            bikeCarriage: isWalking ? null : legCarriesBikes(leg),
            rawProduct: leg.line?.product || '',
            rawMode: leg.line?.mode || '',
            tripId: leg.tripId || '',
            plannedDeparture: leg.plannedDeparture || leg.departure || ''
          };
        });

        // A bike ride is only possible if EVERY transit leg carries bikes — one
        // leg that doesn't breaks the whole door-to-door trip.
        const ridableLegs = formattedLegs.filter(l => l.bikeCarriage !== null);
        const bikesAllowed = ridableLegs.length > 0
          ? ridableLegs.every(l => l.bikeCarriage === true)
          : null;
        
        return {
          durationMin,
          lines,
          transfers,
          occupancy,
          legs: formattedLegs,
          usesBus,
          hasSEV,
          bikesAllowed,
          isLocked: false,
          dataQuality: 'full'
        };
      });
      return processedJourneys;
    }
  return null;
}

// MOTIS `leg.mode` → the HAFAS-flavoured {mode, product} pair the app's leg
// fields and isBus checks are written against. Non-transit modes map to null.
const MOTIS_MODE_MAP = {
  HIGHSPEED_RAIL:     { mode: 'train', product: 'express' },
  LONG_DISTANCE:      { mode: 'train', product: 'express' },
  NIGHT_RAIL:         { mode: 'train', product: 'express' },
  REGIONAL_FAST_RAIL: { mode: 'train', product: 'regional' },
  REGIONAL_RAIL:      { mode: 'train', product: 'regional' },
  METRO:              { mode: 'train', product: 'suburban' }, // S-Bahn
  SUBWAY:             { mode: 'train', product: 'subway' },   // U-Bahn
  TRAM:               { mode: 'train', product: 'tram' },
  BUS:                { mode: 'bus',   product: 'bus' },
  COACH:              { mode: 'bus',   product: 'bus' },
  FERRY:              { mode: 'watercraft', product: 'ferry' },
};

/**
 * MOTIS emits `routeShortName` with the trip number appended for regional rail,
 * e.g. "RE1 (73770)". Strip it: the line name is displayed directly, joined into
 * `lines`, and prefix-matched by getMainTransitLeg / checkCancellations.
 */
function cleanMotisLineName(routeShortName) {
  if (!routeShortName) return '';
  return routeShortName.replace(/\s*\(\d+\)\s*$/, '').trim();
}

/**
 * Render an instant as HH:MM in a given IANA zone.
 *
 * MOTIS returns UTC ("...T09:16:00Z"), so the HAFAS-oriented formatTimeClock —
 * which slices HH:MM straight out of the ISO string to preserve the API's own
 * local offset — would render 11:16 Berlin time as 09:16. Convert explicitly
 * instead, using the zone MOTIS reports on the stop.
 */
function formatTimeInZone(isoString, timeZone) {
  if (!isoString) return '';
  const d = new Date(isoString);
  if (isNaN(d.getTime())) return '';
  try {
    return new Intl.DateTimeFormat('en-GB', {
      timeZone: timeZone || 'Europe/Berlin',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23'
    }).format(d);
  } catch {
    return formatTimeClock(isoString);
  }
}

/**
 * Normalize a MOTIS (Transitous) `/api/v1/plan` response into the same journey
 * shape as normalizeHafasJourneys.
 *
 * Both endpoints of the query are resolved stop IDs, so itineraries start and
 * end at stops and `durationMin` stays station-to-station — comparable with the
 * HAFAS path, which matters because it's the sole ranking input in sortResults.
 *
 * MOTIS carries no occupancy (`loadFactor`), no `EV` replacement-bus code and no
 * `FK` bike-carriage code, so `occupancy`/`hasSEV` are null rather than
 * defaulted — a missing signal, not a claim of an empty train. `dataQuality`
 * marks the journey so the UI can say so.
 */
function normalizeMotisJourneys(data) {
  const itineraries = data?.itineraries;
  if (!Array.isArray(itineraries) || itineraries.length === 0) return null;

  const journeys = itineraries.map(itinerary => {
    const rawLegs = itinerary.legs || [];

    const depTime = itinerary.startTime ? new Date(itinerary.startTime) : null;
    const arrTime = itinerary.endTime ? new Date(itinerary.endTime) : null;
    const durationMin = (depTime && arrTime && !isNaN(depTime) && !isNaN(arrTime))
      ? Math.round((arrTime - depTime) / 1000 / 60)
      : null;

    const lines = [];
    let usesBus = false;

    const formattedLegs = rawLegs.map(leg => {
      const products = MOTIS_MODE_MAP[leg.mode] || null;
      const isWalking = !products;
      const lineName = cleanMotisLineName(leg.routeShortName);
      if (!isWalking && lineName) lines.push(lineName);
      if (products?.mode === 'bus') usesBus = true;

      const tz = leg.from?.tz || leg.to?.tz;
      const lineColor = leg.routeColor
        ? { bg: `#${leg.routeColor}`, fg: `#${leg.routeTextColor || 'fff'}` }
        : { bg: '#888', fg: '#fff' };

      return {
        lineName: lineName || (isWalking ? 'Walk' : 'Transit'),
        lineColor,
        originName: leg.from?.name || 'Start',
        destName: leg.to?.name || 'End',
        depTime: formatTimeInZone(leg.startTime, tz),
        arrTime: formatTimeInZone(leg.endTime, tz),
        depPlatform: leg.from?.track || '',
        arrPlatform: leg.to?.track || '',
        duration: Number.isFinite(leg.duration) ? Math.round(leg.duration / 60) : 0,
        isBus: products?.mode === 'bus',
        // MOTIS has no EV remark code, so replacement buses are indistinguishable
        // from scheduled ones here.
        isBusEV: false,
        cancelled: leg.cancelled === true,
        // MOTIS `bikesAllowed` splits by source feed, not by trip — see
        // legCarriesBikes for why it isn't trustworthy enough to surface.
        bikeCarriage: null,
        rawProduct: products?.product || '',
        rawMode: products?.mode || (isWalking ? 'walking' : ''),
        tripId: leg.tripId || '',
        // Raw ISO (UTC) — the dedupe key and calculateFrequency both parse this
        // with new Date(), which handles the Z suffix correctly.
        plannedDeparture: leg.scheduledStartTime || leg.startTime || ''
      };
    });

    return {
      durationMin,
      lines,
      transfers: Number.isFinite(itinerary.transfers) ? itinerary.transfers : Math.max(0, lines.length - 1),
      occupancy: null,
      legs: formattedLegs,
      usesBus,
      hasSEV: null,
      bikesAllowed: null,
      isLocked: false,
      dataQuality: 'reduced'
    };
  })
  // Drop walk-only itineraries so calculateTrainRoute falls through to its
  // bus-allowed retry instead of presenting a walk as a train connection.
  .filter(j => j.lines.length > 0);

  return journeys.length > 0 ? journeys : null;
}

/**
 * Whether a HAFAS leg carries bicycles, from the `FK` ("Fahrradmitnahme")
 * remark: {code:'FK', text:'Bicycle conveyance (S+U Alexanderplatz Bhf …)'}.
 *
 * This is a real per-trip flag, not boilerplate — sampled live across four
 * corridors it was present on every regional and U-Bahn leg, absent on every
 * replacement-bus and ICE leg, and mixed on S-Bahn. Absence is therefore treated
 * as "no bike carriage", which is the safe direction for this app: a false
 * "bikes OK" would strand someone at a platform, whereas a false warning just
 * pushes them to a different departure.
 *
 * Note this is deliberately HAFAS-only. Transitous exposes a GTFS `bikesAllowed`
 * boolean, but it splits by source feed rather than by trip — de_VBB.gtfs
 * reports true for everything and de_DELFI reports false for almost everything,
 * including RB24 and RE3 services that plainly do carry bikes. Surfacing that
 * would be worse than staying silent, so MOTIS journeys leave this null and lean
 * on the reduced-data marker instead.
 */
function legCarriesBikes(leg) {
  return (leg.remarks || []).some(rem => rem.code === 'FK');
}

/**
 * Determine the occupancy level ('low' | 'medium' | 'high') for a single leg.
 * Uses the structured hafas loadFactor when present, otherwise parses remarks.
 */
function legOccupancy(leg) {
  const lf = (leg.loadFactor || '').toLowerCase();
  if (lf) {
    if (lf.includes('very-high') || lf.includes('exceptionally-high') || lf === 'high') return 'high';
    if (lf.includes('medium')) return 'medium'; // covers 'medium' and 'low-to-medium'
    return 'low';
  }

  let occ = 'low';
  for (const rem of leg.remarks || []) {
    if (!rem.text) continue;
    const txt = rem.text.toLowerCase();
    if (txt.includes('occupancy') || txt.includes('auslastung')) {
      if (txt.includes('hoch') || txt.includes('high') || txt.includes('packed')) return 'high';
      if (txt.includes('medium') || txt.includes('mäßig')) occ = 'medium';
    }
  }
  return occ;
}

const OCCUPANCY_RANK = { low: 0, medium: 1, high: 2 };

function maxOccupancy(a, b) {
  return OCCUPANCY_RANK[b] > OCCUPANCY_RANK[a] ? b : a;
}

/**
 * Find the main transit leg of a journey for capacity assessment and deduping.
 */
function getMainTransitLeg(legs) {
  // 1. Look for regional trains (RE, RB, FEX)
  for (const leg of legs) {
    if (leg.lineName && (leg.lineName.startsWith('RE') || leg.lineName.startsWith('RB') || leg.lineName.startsWith('FEX'))) {
      return leg;
    }
  }
  // 2. Look for S-Bahn
  for (const leg of legs) {
    if (leg.lineName && leg.lineName.startsWith('S') && !leg.lineName.startsWith('SEV')) {
      return leg;
    }
  }
  // 3. Fallback to first non-walking leg
  for (const leg of legs) {
    if (leg.lineName && leg.lineName !== 'Walk') {
      return leg;
    }
  }
  return legs[0];
}

/**
 * Deduplicate journeys sharing the same main transit leg (e.g. regional train trip).
 */
function deduplicateJourneys(journeys) {
  const seenMainLegs = new Set();
  const uniqueJourneys = [];

  for (const journey of journeys) {
    const mainLeg = getMainTransitLeg(journey.legs);
    if (!mainLeg) {
      uniqueJourneys.push(journey);
      continue;
    }

    let mainLegKey = '';
    if (mainLeg.tripId) {
      mainLegKey = mainLeg.tripId;
    } else {
      mainLegKey = `${mainLeg.lineName}-${mainLeg.plannedDeparture || mainLeg.depTime}`;
    }

    if (!seenMainLegs.has(mainLegKey)) {
      seenMainLegs.add(mainLegKey);
      uniqueJourneys.push(journey);
    }
  }

  return uniqueJourneys;
}

/**
 * Calculate the frequency of the connections.
 */
function calculateFrequency(uniqueJourneys) {
  const depTimes = uniqueJourneys
    .map(j => new Date(j.legs[0]?.plannedDeparture || j.legs[0]?.depTime))
    .filter(d => !isNaN(d.getTime()))
    .sort((a, b) => a - b);

  if (depTimes.length < 2) {
    return { label: 'Infrequent (2h+ interval)', avgIntervalMin: null };
  }

  const intervals = [];
  for (let i = 0; i < depTimes.length - 1; i++) {
    const diffMs = depTimes[i+1] - depTimes[i];
    const diffMin = Math.round(diffMs / 1000 / 60);
    intervals.push(diffMin);
  }

  const avgInterval = intervals.reduce((a, b) => a + b, 0) / intervals.length;

  let label = 'Infrequent (2h+ interval)';
  if (avgInterval <= 25) {
    label = 'Very Frequent (~20m)';
  } else if (avgInterval <= 35) {
    label = 'Frequent (~30m)';
  } else if (avgInterval <= 65) {
    label = 'Hourly (~60m)';
  } else if (avgInterval <= 125) {
    label = 'Bi-hourly (~2h)';
  }

  return { label, avgIntervalMin: Math.round(avgInterval) };
}



/**
 * Check primary journey for cancellations and generate helpful guidance.
 */
function checkCancellations(primaryJourney, frequency) {
  let hasCancelledLeg = false;
  let isCritical = false;
  const cancelledLegs = [];

  for (const leg of primaryJourney.legs) {
    if (leg.cancelled) {
      hasCancelledLeg = true;
      cancelledLegs.push(leg);
      if (leg.lineName.startsWith('RE') || leg.lineName.startsWith('RB') || leg.lineName.startsWith('FEX')) {
        isCritical = true;
      }
    }
  }

  let guidance = '';
  if (hasCancelledLeg) {
    const mainCancelled = cancelledLegs[0];
    if (isCritical) {
      guidance = `⚠️ Critical: The regional train leg (${mainCancelled.lineName}) is CANCELLED. Frequency is low (${frequency.label}), meaning you may face a delay of 1-2 hours. Consider planning a different route or starting station.`;
    } else {
      guidance = `⚠️ Minor Leg Cancelled: The local connection leg (${mainCancelled.lineName}) is CANCELLED. Since local trains run frequently, you can take an alternative S-Bahn or Tram leg to catch your regional train connection.`;
    }
  }

  return { hasCancelledLeg, isCritical, guidance, cancelledLegs };
}

function formatTimeClock(isoString) {
  if (!isoString) return '';
  // Try slicing local time directly from ISO string (e.g., 2026-06-07T10:20:00+02:00 -> 10:20)
  if (isoString.includes('T')) {
    const parts = isoString.split('T');
    if (parts[1]) {
      return parts[1].slice(0, 5);
    }
  }
  // Fallback to standard Date parsing if format is unexpected
  const d = new Date(isoString);
  return d.toTimeString().slice(0, 5);
}

