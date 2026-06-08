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
  extractElevation,
  extractTime,
  getStationVbbId,
  calculateTrainRoute
} from './routeService.js';

// Initial detour factor estimate: bike routes are ~1.3x the crow-flies distance
const INITIAL_DETOUR_FACTOR = 1.3;

/**
 * Splits a line's stations into geographical branches based on their bearings from home.
 */
function getLineBranches(line, homeCoords, minBranchDist = 6) {
  const outboundStations = line.stations.filter(s => haversineKm(homeCoords, s) >= minBranchDist);
  if (outboundStations.length === 0) return [];

  // Calculate bearing for each station (0 to 360 degrees)
  const stationsWithBearing = outboundStations.map(s => {
    let bearing = Math.atan2(s.lat - homeCoords.lat, s.lon - homeCoords.lon) * 180 / Math.PI;
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
      const existing = results.find(r => r.station.name === result.station.name);
      if (existing) {
        if (!existing.lines.some(l => l.id === result.lines[0].id)) {
          existing.lines.push(result.lines[0]);
        }
        if (onProgress) {
          onProgress(i + 1, total, { ...existing, isMergeUpdate: true, newLine: result.lines[0] });
        }
      } else {
        results.push(result);
        if (onProgress) {
          onProgress(i + 1, total, result);
        }
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
  const elevation = extractElevation(bestResult.geojson);
  const timeMin = extractTime(bestResult.geojson);

  // Get train connection details from VBB API
  let trainStats = null;
  if (transitConfig && transitConfig.homeVbbId) {
    const stationVbbId = await getStationVbbId(bestResult.station);
    if (stationVbbId) {
      trainStats = await calculateTrainRoute(
        transitConfig.homeVbbId,
        stationVbbId,
        transitConfig.date,
        transitConfig.time,
        transitConfig.timeType
      );
    }
  }

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
    elevationGainM: elevation?.gain ?? 0,
    elevationLossM: elevation?.loss ?? 0,
    elevationMaxM: elevation?.maxElev ?? 0,
    elevationProfile: elevation?.profile ?? [],
    estimatedTimeMin: timeMin ?? Math.round(bestResult.actualKm / 20 * 60),
    isSoftMatch,
    trainStats
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

/**
 * Haversine distance between two {lat, lon} points in km.
 */
export function haversineKm(a, b) {
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

function estimateFallbackTime(km) {
  // Rough estimate: 20 km/h average cycling speed
  return Math.round(km / 20 * 60);
}
