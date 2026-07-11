/**
 * Shared geometry post-processing for lines.json.
 *
 * The raw VBB trip polylines are far more detailed than the map overlay needs
 * (the train lines render at weight 2.5 / low opacity, max zoom ~13):
 *  - coordinates come with 7 decimals (~1 cm) → round to 5 (~1 m)
 *  - track segments contain a point every few meters → Douglas-Peucker
 *    simplification with ~10 m tolerance is visually lossless
 *
 * Together with minified JSON output this shrinks lines.json by >80%.
 */

// ~10 m expressed in degrees of latitude
const DEFAULT_TOLERANCE_DEG = 0.0001;

export function roundCoord(value, decimals = 5) {
  const f = 10 ** decimals;
  return Math.round(value * f) / f;
}

/**
 * Simplify a polyline ([[lon, lat], ...]) with the Douglas-Peucker algorithm.
 */
export function simplifyPolyline(points, toleranceDeg = DEFAULT_TOLERANCE_DEG) {
  if (points.length <= 2) return points;

  const keep = new Array(points.length).fill(false);
  keep[0] = keep[points.length - 1] = true;

  // Iterative DP to avoid deep recursion on long segments
  const stack = [[0, points.length - 1]];
  while (stack.length > 0) {
    const [first, last] = stack.pop();
    let maxDist = 0;
    let index = -1;

    for (let i = first + 1; i < last; i++) {
      const d = perpendicularDistance(points[i], points[first], points[last]);
      if (d > maxDist) {
        maxDist = d;
        index = i;
      }
    }

    if (maxDist > toleranceDeg && index !== -1) {
      keep[index] = true;
      stack.push([first, index], [index, last]);
    }
  }

  return points.filter((_, i) => keep[i]);
}

/**
 * Process a full line geometry (array of segments) — simplify each segment
 * and round coordinates. Longitude distances shrink with latitude, but for
 * a ~10 m display tolerance the simple planar approximation is fine.
 */
export function optimizeGeometry(geometry, toleranceDeg = DEFAULT_TOLERANCE_DEG) {
  return geometry.map(segment =>
    simplifyPolyline(segment, toleranceDeg).map(([lon, lat]) => [roundCoord(lon), roundCoord(lat)])
  );
}

/**
 * Round station coordinates in place-safe copy.
 */
export function optimizeStations(stations) {
  return stations.map(s => ({ ...s, lat: roundCoord(s.lat), lon: roundCoord(s.lon) }));
}

function perpendicularDistance(point, lineStart, lineEnd) {
  const [x, y] = point;
  const [x1, y1] = lineStart;
  const [x2, y2] = lineEnd;

  const dx = x2 - x1;
  const dy = y2 - y1;
  const lenSq = dx * dx + dy * dy;
  if (lenSq === 0) return Math.hypot(x - x1, y - y1);

  // Distance from point to the infinite line through start/end
  return Math.abs(dy * x - dx * y + x2 * y1 - y2 * x1) / Math.sqrt(lenSq);
}
