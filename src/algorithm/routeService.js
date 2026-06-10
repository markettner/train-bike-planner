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
 * Extract elevation data from a BRouter GeoJSON response.
 * Returns { gain, loss, maxElev, profile: [{dist, elev}] }
 */
export function extractElevation(geojson) {
  if (!geojson?.features?.[0]) return null;
  const feature = geojson.features[0];
  const coords = feature.geometry?.coordinates;
  if (!coords?.length) return null;

  let gain = 0, loss = 0, maxElev = -Infinity;
  let cumulativeDist = 0;
  const profile = [];

  for (let i = 0; i < coords.length; i++) {
    const [lon, lat, elev] = coords[i];
    if (elev == null) continue;

    if (i > 0) {
      const [prevLon, prevLat, prevElev] = coords[i - 1];
      const segDist = haversineKm({ lat, lon }, { lat: prevLat, lon: prevLon });
      cumulativeDist += segDist;
      if (prevElev != null) {
        const diff = elev - prevElev;
        if (diff > 0) gain += diff;
        else loss += Math.abs(diff);
      }
    }

    maxElev = Math.max(maxElev, elev);
    profile.push({ dist: cumulativeDist, elev });
  }

  return {
    gain: Math.round(gain),
    loss: Math.round(loss),
    maxElev: maxElev === -Infinity ? 0 : Math.round(maxElev),
    profile
  };
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

/**
 * Clear the route cache (useful when profile changes).
 */
export function clearCache() {
  routeCache.clear();
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

function haversineKm(a, b) {
  const R = 6371;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const sinDlat = Math.sin(dLat / 2);
  const sinDlon = Math.sin(dLon / 2);
  const h = sinDlat * sinDlat + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * sinDlon * sinDlon;
  return 2 * R * Math.asin(Math.sqrt(h));
}

function toRad(deg) {
  return deg * Math.PI / 180;
}

// --- VBB Transit helpers ---

let stationMappings = {};
let homeVbbId = null;
let homeVbbCoords = null;

/**
 * Helper to fetch from VBB API with automatic Deutsche Bahn (DB) API fallback.
 */
async function fetchFromTransitAPI(endpointPath, options = {}) {
  const vbbUrl = `https://v6.vbb.transport.rest${endpointPath}`;
  const dbUrl = `https://v6.db.transport.rest${endpointPath}`;

  try {
    // Try VBB first
    const res = await fetch(vbbUrl, options);
    if (res.ok) {
      return await res.json();
    }
    console.warn(`VBB API returned status ${res.status} for ${endpointPath}. Trying DB API fallback...`);
  } catch (err) {
    console.warn(`VBB API request failed for ${endpointPath} (${err.message}). Trying DB API fallback...`);
  }

  // Fallback to DB API
  try {
    const res = await fetch(dbUrl, options);
    if (!res.ok) {
      throw new Error(`DB API returned status ${res.status}`);
    }
    return await res.json();
  } catch (err) {
    console.error(`Both VBB and DB API requests failed for ${endpointPath}:`, err.message);
    throw err;
  }
}

/**
 * Load pre-computed VBB station mappings.
 */
export function setStationMappings(mappings) {
  stationMappings = mappings || {};
}

/**
 * Resolve a candidate station to its VBB Stop ID.
 * Looks up in the pre-computed mappings first, falling back to a live nearby query.
 */
export async function getStationVbbId(station) {
  if (station && stationMappings[station.id]) {
    return stationMappings[station.id];
  }
  if (!station) return null;
  // Fallback: resolve live
  try {
    const data = await fetchFromTransitAPI(`/locations/nearby?latitude=${station.lat}&longitude=${station.lon}&results=1`);
    if (data && data[0] && data[0].id) {
      const vbbId = data[0].id;
      stationMappings[station.id] = vbbId; // cache in memory
      return vbbId;
    }
  } catch (err) {
    console.warn(`Failed to resolve station VBB/DB ID live for ${station.name}:`, err.message);
  }
  return null;
}

/**
 * Resolve Home coordinates to a VBB Stop ID, caching the result.
 */
export async function getHomeVbbId(coords) {
  if (homeVbbId && homeVbbCoords && homeVbbCoords.lat === coords.lat && homeVbbCoords.lon === coords.lon) {
    return homeVbbId;
  }
  try {
    const data = await fetchFromTransitAPI(`/locations/nearby?latitude=${coords.lat}&longitude=${coords.lon}&results=1`);
    if (data && data[0] && data[0].id) {
      homeVbbId = data[0].id;
      homeVbbCoords = { lat: coords.lat, lon: coords.lon };
      return homeVbbId;
    }
  } catch (err) {
    console.error('Failed to resolve Home VBB/DB ID:', err);
  }
  return null;
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

/**
 * Perform actual VBB journey query.
 */
async function fetchConnection(fromStopId, toStopId, date, time, timeType, excludeBuses) {
  try {
    let path = `/journeys?from=${fromStopId}&to=${toStopId}&results=8`;
    if (excludeBuses) {
      path += '&bus=false';
    }
    
    // Add date/time parameters if provided
    if (date && time) {
      // Calculate local timezone offset to append to query string (e.g. +02:00)
      const localDate = new Date(`${date}T${time}:00`);
      const offsetMin = -localDate.getTimezoneOffset();
      const sign = offsetMin >= 0 ? '+' : '-';
      const pad = num => String(Math.abs(num)).padStart(2, '0');
      const hours = pad(Math.floor(offsetMin / 60));
      const mins = pad(offsetMin % 60);
      const dt = `${date}T${time}:00${sign}${hours}:${mins}`;
      path += `&${timeType}=${encodeURIComponent(dt)}`;
    }
    
    const data = await fetchFromTransitAPI(path, {
      headers: { 'Accept-Language': 'en' }
    });
    
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
        
        // Extract occupancy & look for bus replacement service indication
        let occupancy = 'low';
        let hasSEV = false;
        
        legs.forEach(leg => {
          const remarks = leg.remarks || [];
          remarks.forEach(rem => {
            if (rem.text) {
              const txt = rem.text.toLowerCase();
              if (txt.includes('occupancy') || txt.includes('auslastung')) {
                if (txt.includes('medium') || txt.includes('mäßig')) {
                  occupancy = 'medium';
                } else if (txt.includes('high') || txt.includes('hoch') || txt.includes('sehr hoch') || txt.includes('very high') || txt.includes('packed')) {
                  occupancy = 'high';
                }
              }
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
            rawProduct: leg.line?.product || '',
            rawMode: leg.line?.mode || '',
            tripId: leg.tripId || '',
            plannedDeparture: leg.plannedDeparture || leg.departure || ''
          };
        });
        
        return {
          durationMin,
          lines,
          transfers,
          occupancy,
          legs: formattedLegs,
          usesBus,
          hasSEV,
          isLocked: false
        };
      });
      return processedJourneys;
    }
  } catch (err) {
    console.warn(`fetchConnection failed from ${fromStopId} to ${toStopId}:`, err.message);
  }
  return null;
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

