/**
 * Shared helpers used across algorithm and UI modules.
 */

import DOMPurify from 'dompurify';

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
 * Escape text so it renders literally inside element content or a double-quoted
 * attribute, e.g. a station name containing "<" or "&". This is about display
 * correctness; sanitizing against injected markup happens at the sink (setHtml).
 */
export function escapeHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * The one place our code assigns innerHTML: sanitizes with DOMPurify first. Use
 * this instead of assigning el.innerHTML directly, so a value that skipped
 * escapeHtml can't inject scripts or event handlers.
 */
export function setHtml(el, html) {
  el.innerHTML = DOMPurify.sanitize(html);
}

/**
 * Replace characters that are illegal or awkward in filenames.
 */
export function sanitizeFilename(name) {
  return String(name).replace(/[/\\:*?"<>|]+/g, '-').replace(/\s+/g, ' ').trim();
}
