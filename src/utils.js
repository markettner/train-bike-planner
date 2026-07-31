/**
 * Shared helpers used across algorithm and UI modules.
 */

/**
 * Tooltip shown wherever a journey carries `dataQuality: 'reduced'`, i.e. it was
 * served by the Transitous backup backend after the HAFAS mirrors failed.
 * Transitous is GTFS-based: no occupancy figures, no replacement-bus flags, and
 * real-time coverage varies by operator.
 */
export const REDUCED_DATA_TITLE =
  'Served by the backup transit provider (Transitous) because the primary API was unreachable. '
  + 'Times and platforms are accurate, but occupancy and replacement-bus info are unavailable and '
  + 'delay data is only partial.';

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

export function toRad(deg) {
  return deg * Math.PI / 180;
}

/**
 * Format minutes as "1h 23m" / "45m".
 */
export function formatTime(minutes) {
  if (minutes == null) return '?';
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

/**
 * Escape a string for safe interpolation into innerHTML.
 */
export function escapeHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Replace characters that are illegal or awkward in filenames.
 */
export function sanitizeFilename(name) {
  return String(name).replace(/[/\\:*?"<>|]+/g, '-').replace(/\s+/g, ' ').trim();
}
