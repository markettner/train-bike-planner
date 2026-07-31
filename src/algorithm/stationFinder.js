/**
 * Core station-finding algorithm.
 *
 * For each train line, finds the station from which the bike ride
 * home most closely matches the user's desired distance.
 *
 * Algorithm: Adaptive binary search
 *  1. Estimate which station to try first using a detour heuristic
 *  2. Call BRouter API, compare actual distance to target
 *  3. Move closer/further along the line and repeat
 *  4. Converge in 2-4 API calls per line
 */

import {
  calculateBikeRoute,
  extractDistance,
  extractElevationGain,
  extractTime,
  getStationVbbId,
  getHomeStopIdForActiveBackend,
  getActiveBackendKind,
  calculateTrainRoute
} from './routeService.js';
import { haversineKm, toRad } from '../utils.js';

// Initial detour factor estimate: bike routes are ~1.3x the crow-flies distance
export const INITIAL_DETOUR_FACTOR = 1.3;

/**
 * Splits a line's stations into geographical branches based on their bearings from home.
 */
function getLineBranches(line, homeCoords, minBranchDist = 6) {
  const outboundStations = line.stations.filter(s => haversineKm(homeCoords, s) >= minBranchDist);
  if (outboundStations.length === 0) return [];

  // Calculate bearing for each station (0 to 360 degrees).
  // Longitude degrees shrink with latitude, so scale by cos(lat) to keep
  // bearings geometrically correct at Berlin's latitude.
  const lonScale = Math.cos(toRad(homeCoords.lat));
  const stationsWithBearing = outboundStations.map(s => {
    let bearing = Math.atan2(s.lat - homeCoords.lat, (s.lon - homeCoords.lon) * lonScale) * 180 / Math.PI;
    if (bearing < 0) bearing += 360;
    return { station: s, bearing };
  });

  // Sort by bearing
  stationsWithBearing.sort((a, b) => a.bearing - b.bearing);

  // Group into clusters where bearing difference is < 40 degrees
  const clusters = [];
  let currentCluster = [stationsWithBearing[0]];

  for (let i = 1; i < stationsWithBearing.length; i++) {
    const diff = stationsWithBearing[i].bearing - stationsWithBearing[i - 1].bearing;
    if (diff < 40) {
      currentCluster.push(stationsWithBearing[i]);
    } else {
      clusters.push(currentCluster);
      currentCluster = [stationsWithBearing[i]];
    }
  }

  // Wrap-around check
  const first = stationsWithBearing[0];
  const last = stationsWithBearing[stationsWithBearing.length - 1];
  const wrapDiff = (first.bearing + 360) - last.bearing;

  if (wrapDiff < 40 && clusters.length > 0) {
    // Merge last (currentCluster) and first (clusters[0])
    clusters[0] = currentCluster.concat(clusters[0]);
  } else {
    clusters.push(currentCluster);
  }

  // Map clusters back to arrays of stations
  return clusters.map(cluster => cluster.map(item => item.station));
}

/**
 * Find bike-back-home routes for all lines, yielding results progressively.
 *
 * @param {Array}  lines          - Array of line objects from lines.json
 * @param {{lat, lon}} homeCoords - User's home/start location
 * @param {number} targetKm       - Desired bike distance in km
 * @param {number} toleranceKm    - Acceptable deviation in km
 * @param {string} profile        - BRouter profile
 * @param {function} onProgress   - Callback(completed, total, result|null)
 * @returns {Promise<Array>}       - Array of route results
 */
export async function findRoutesForAllLines(
  lines, homeCoords, targetKm, toleranceKm, profile, transitConfig, onProgress
) {
  // Only consider lines that have at least one station further than targetKm/4 away
  const minCrowFlies = targetKm / INITIAL_DETOUR_FACTOR / 2;
  const eligibleLines = lines.filter(line => {
    const maxDist = Math.max(...line.stations.map(s => haversineKm(homeCoords, s)));
    return maxDist >= minCrowFlies;
  });

  // Split each eligible line into branches relative to the home location
  const branchesToSearch = [];
  for (const line of eligibleLines) {
    const branches = getLineBranches(line, homeCoords, 6);
    branches.forEach((stations, branchIdx) => {
      branchesToSearch.push({
        line,
        stations,
        branchIdx
      });
    });
  }

  const results = [];
  const total = branchesToSearch.length;

  for (let i = 0; i < branchesToSearch.length; i++) {
    const { line, stations, branchIdx } = branchesToSearch[i];
    let result = null;

    try {
      result = await findRouteForStationList(line, stations, homeCoords, targetKm, toleranceKm, profile, transitConfig);
    } catch (err) {
      console.warn(`Failed to find route for line ${line.id} branch ${branchIdx}:`, err);
    }

    if (result) {
      // Merge lines that reach the same physical station. Match on stop id, not
      // display name — cleaned VBB names can collide across distinct stops.
      const existing = results.find(r => r.station.id === result.station.id);
      if (existing) {
        if (!existing.lines.some(l => l.id === result.lines[0].id)) {
          existing.lines.push(result.lines[0]);
        }
        if (onProgress) {
          onProgress(i + 1, total, { ...existing, isMergeUpdate: true, newLine: result.lines[0] });
        }
        
        // Queue transit info fetching in the background
        if (transitConfig && transitConfig.homeVbbIdPromise) {
          const alreadyEnqueued = transitQueue.some(item => item.result.id === existing.id);
          if (!alreadyEnqueued && existing.trainStatsStatus === 'loading') {
            transitQueue.push({ result: existing, transitConfig, done: i + 1, total, onProgress });
          }
        }
      } else {
        results.push(result);
        if (onProgress) {
          onProgress(i + 1, total, result);
        }
        
        // Queue transit info fetching in the background
        if (transitConfig && transitConfig.homeVbbIdPromise) {
          transitQueue.push({ result, transitConfig, done: i + 1, total, onProgress });
        }
      }

      if (transitConfig && transitConfig.homeVbbIdPromise) {
        processTransitQueue();
      }
    } else {
      if (onProgress) {
        onProgress(i + 1, total, null);
      }
    }
  }

  return results;
}

/**
 * Find the best starting station on a single branch's station list.
 *
 * @returns {object|null} Route result, or null if no suitable station found
 */
async function findRouteForStationList(line, stations, homeCoords, targetKm, toleranceKm, profile, transitConfig) {
  if (stations.length === 0) return null;

  // Pre-filter stations: the actual cycling distance is always >= crow-flies distance.
  // Any station with a crow-flies distance greater than target + soft tolerance is physically too far.
  const softToleranceKm = Math.max(toleranceKm * 2, 10);
  const maxCrowFlies = targetKm + softToleranceKm;
  const filtered = stations.filter(s => haversineKm(homeCoords, s) <= maxCrowFlies);
  if (filtered.length === 0) return null;

  // Sort stations by crow-flies distance from home (closest first = nearest to home)
  const sorted = [...filtered].sort(
    (a, b) => haversineKm(homeCoords, a) - haversineKm(homeCoords, b)
  );

  // Target crow-flies distance (using initial heuristic)
  const targetCrowFlies = targetKm / INITIAL_DETOUR_FACTOR;

  // Find the station index closest to our target crow-flies distance
  let initialIdx = findClosestIndex(sorted, homeCoords, targetCrowFlies);
  initialIdx = Math.max(0, Math.min(initialIdx, sorted.length - 1));

  let low = 0;
  let high = sorted.length - 1;

  let bestResult = null;
  let bestDiff = Infinity;
  let iterations = 0;
  const maxIterations = Math.max(6, Math.ceil(Math.log2(sorted.length)) + 2);

  // 1. Query the initial heuristic guess first
  const initialStation = sorted[initialIdx];
  const initialGeojson = await calculateBikeRoute(initialStation, homeCoords, profile);
  iterations++;

  if (initialGeojson) {
    const actualKm = extractDistance(initialGeojson);
    if (actualKm !== null) {
      const diff = actualKm - targetKm;
      const absDiff = Math.abs(diff);

      bestDiff = absDiff;
      bestResult = { station: initialStation, geojson: initialGeojson, actualKm };

      if (absDiff === 0) {
        // Perfect match on initial guess - skip the binary search loop
        low = high + 1;
      } else if (diff > 0) {
        // Too long -> search below initialIdx
        high = initialIdx - 1;
      } else {
        // Too short -> search above initialIdx
        low = initialIdx + 1;
      }
    }
  }

  // 2. Perform index-based binary search on the remaining subarray
  while (low <= high && iterations < maxIterations) {
    const mid = Math.floor((low + high) / 2);
    const station = sorted[mid];
    iterations++;

    const geojson = await calculateBikeRoute(station, homeCoords, profile);
    if (!geojson) {
      high = mid - 1;
      continue;
    }

    const actualKm = extractDistance(geojson);
    if (actualKm === null) {
      high = mid - 1;
      continue;
    }

    const diff = actualKm - targetKm;
    const absDiff = Math.abs(diff);

    if (absDiff < bestDiff) {
      bestDiff = absDiff;
      bestResult = { station, geojson, actualKm };
    }

    if (absDiff === 0) {
      break;
    }

    if (diff > 0) {
      high = mid - 1;
    } else {
      low = mid + 1;
    }
  }

  if (!bestResult) return null;

  // Enforce tolerance check: if no station is within the strict toleranceKm,
  // we still accept the best match as long as it is within a reasonable soft limit (e.g. max of 2*tolerance or 10km)
  if (Math.abs(bestResult.actualKm - targetKm) > softToleranceKm) {
    return null;
  }

  const isSoftMatch = Math.abs(bestResult.actualKm - targetKm) > toleranceKm;

  // Package the result
  const elevationGainM = extractElevationGain(bestResult.geojson);
  const timeMin = extractTime(bestResult.geojson);

  const trainStatsStatus = (transitConfig && transitConfig.homeVbbIdPromise) ? 'loading' : 'failed';

  // Generate a unique ID for the result (e.g. line-station)
  const id = `${line.id}-${bestResult.station.id}`;

  return {
    id,
    lines: [{
      id: line.id,
      name: line.name,
      type: line.type,
      color: line.color
    }],
    station: bestResult.station,
    bikeRoute: bestResult.geojson,
    bikeDistanceKm: Math.round(bestResult.actualKm * 10) / 10,
    elevationGainM: elevationGainM ?? 0,
    estimatedTimeMin: timeMin ?? Math.round(bestResult.actualKm / 20 * 60),
    isSoftMatch,
    trainStatsStatus,
    trainStats: null
  };
}

/**
 * Find the index in a sorted-by-distance array whose crow-flies
 * distance is closest to the target.
 */
function findClosestIndex(sortedStations, homeCoords, targetCrowFlies) {
  let bestIdx = 0;
  let bestDiff = Infinity;

  for (let i = 0; i < sortedStations.length; i++) {
    const d = haversineKm(homeCoords, sortedStations[i]);
    const diff = Math.abs(d - targetCrowFlies);
    if (diff < bestDiff) {
      bestDiff = diff;
      bestIdx = i;
    }
  }

  return bestIdx;
}

// --- Asynchronous Transit Queue Processing ---

const transitQueue = [];
let isProcessingQueue = false;
// Incremented on every clear; lets an in-flight loop detect that a new search
// started while it was awaiting, so two loops never process the same queue.
let queueGeneration = 0;

export function clearTransitQueue() {
  transitQueue.length = 0;
  queueGeneration++;
  isProcessingQueue = false;
}

async function processTransitQueue() {
  if (isProcessingQueue || transitQueue.length === 0) return;
  isProcessingQueue = true;
  const myGeneration = queueGeneration;

  while (transitQueue.length > 0) {
    if (myGeneration !== queueGeneration) return; // superseded by a new search
    const { result, transitConfig, done, total, onProgress } = transitQueue.shift();

    try {
      // Resolve the home stop ID lazily here so bike routing was never blocked
      // on it. A null result means no transit backend could be reached at all —
      // that's a transit-API outage, distinct from "this route has no connection".
      const homeVbbId = await transitConfig.homeVbbIdPromise;
      if (myGeneration !== queueGeneration) return; // superseded while awaiting
      if (!homeVbbId) {
        // Transit layer is unreachable — degrade honestly rather than implying
        // this particular route lacks a connection.
        result.trainStatsStatus = 'unavailable';
      } else {
        const stationVbbId = await getStationVbbId(result.station);
        if (stationVbbId) {
          // Resolving the station ID may have failed the active backend over to
          // one with a different stop-ID namespace. Re-fetch the Home ID against
          // whatever backend is now active so both IDs in the journey query share
          // one namespace (mixing them returns nothing useful — HAFAS silently
          // returns no journeys, MOTIS 404s).
          const homeStopId = await getHomeStopIdForActiveBackend();
          if (myGeneration !== queueGeneration) return; // superseded while awaiting
          const backendBefore = getActiveBackendKind();
          let trainStats = await calculateTrainRoute(
            homeStopId || homeVbbId,
            stationVbbId,
            transitConfig.date,
            transitConfig.time,
            transitConfig.timeType
          );
          if (myGeneration !== queueGeneration) return; // superseded while awaiting

          // The journey query itself can be what discovers an outage. By then
          // both IDs were already resolved against the old backend, and handing
          // them to a fallback in a different namespace fails (MOTIS 404s on
          // VBB's 900xxxxxxx IDs). Re-resolve both against whatever is serving
          // now and retry once, so the station where the failover happens isn't
          // wrongly reported as having no connection.
          if (!trainStats && getActiveBackendKind() !== backendBefore) {
            const retryStationId = await getStationVbbId(result.station);
            const retryHomeId = await getHomeStopIdForActiveBackend();
            if (myGeneration !== queueGeneration) return; // superseded while awaiting
            if (retryStationId && retryHomeId) {
              trainStats = await calculateTrainRoute(
                retryHomeId,
                retryStationId,
                transitConfig.date,
                transitConfig.time,
                transitConfig.timeType
              );
              if (myGeneration !== queueGeneration) return; // superseded while awaiting
            }
          }

          if (trainStats) {
            result.trainStats = trainStats;
            result.trainStatsStatus = 'success';
          } else {
            result.trainStatsStatus = 'failed';
          }
        } else {
          result.trainStatsStatus = 'failed';
        }
      }
    } catch (err) {
      console.warn(`Background transit route query failed for ${result.station.name}:`, err.message);
      result.trainStatsStatus = 'failed';
    }

    if (myGeneration !== queueGeneration) return; // don't report into a new search's UI

    if (onProgress) {
      onProgress(done, total, { ...result, isTrainUpdate: true });
    }

    // Rate limiting: wait 800ms between live transit requests to avoid rate limits
    await new Promise(resolve => setTimeout(resolve, 800));
  }

  isProcessingQueue = false;
}
