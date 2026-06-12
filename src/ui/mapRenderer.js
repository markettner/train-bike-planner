/**
 * Leaflet map renderer.
 * Handles all map layers: base tiles, train lines, bike routes,
 * markers, distance circle, and interactions.
 */

import L from 'leaflet';
import 'maplibre-gl/dist/maplibre-gl.css';
import '@maplibre/maplibre-gl-leaflet';
import { escapeHtml, formatTime } from '../utils.js';
import { isMobile } from './mobileSheet.js';

// Color palette (primary + extended)
const ROUTE_COLORS = [
  '#1982c4', '#4267ac', '#52a675', '#6a4c93', '#8ac926',
  '#c5ca30', '#ff595e', '#ff924c', '#ffca3a',
  '#288bb1', '#36949d', '#449d89', '#565aa0', '#6eb84e',
  '#a0383b', '#c04347', '#e04e53', '#e2ca35', '#ff7655', '#ffae43'
];

let map = null;
let homeMarker = null;
let distanceCircle = null;
let trainLineLayer = L.layerGroup();
let routeLayerGroup = L.layerGroup();
let stationLayerGroup = L.layerGroup();

let onHomeChange = null;
let onRouteClick = null;
let isSettingHome = false;

// Track active route layers for hover effects
const routeLayers = new Map(); // resultId → { polyline, stationMarker }
let activeRouteId = null;

/**
 * Initialize the Leaflet map.
 */
export function initMap(options = {}) {
  map = L.map('map', {
    center: [52.5219, 13.4132],
    zoom: 10,
    zoomControl: false,
  });

  // Dark tile layer (CartoDB Dark Matter)
  const darkTiles = L.tileLayer(
    'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png',
    {
      attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> · © <a href="https://carto.com/attributions">CARTO</a>',
      subdomains: 'abcd',
      maxZoom: 19,
    }
  );

  // Light tile layer (Custom styled OpenFreeMap vector style)
  const lightTiles = L.maplibreGL({
    style: `${import.meta.env.BASE_URL}map-style.json`,
    attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> · © <a href="https://openfreemap.org">OpenFreeMap</a>',
  });

  // Select tile based on color scheme
  const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
  (prefersDark ? darkTiles : lightTiles).addTo(map);

  // Listen for theme changes
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', e => {
    map.removeLayer(darkTiles);
    map.removeLayer(lightTiles);
    (e.matches ? darkTiles : lightTiles).addTo(map);
  });

  // Zoom control (bottom left)
  L.control.zoom({ position: 'bottomleft' }).addTo(map);

  // Train lines toggle control (bottom left, will stack above the zoom control)
  const TrainLinesToggleControl = L.Control.extend({
    options: {
      position: 'bottomleft'
    },
    onAdd: function(map) {
      const container = L.DomUtil.create('div', 'leaflet-bar leaflet-control leaflet-control-train-toggle');
      L.DomEvent.disableClickPropagation(container);
      const button = L.DomUtil.create('a', 'leaflet-control-train-toggle-btn', container);
      button.href = '#';
      button.title = 'Toggle Train Lines';
      button.role = 'button';
      button.innerHTML = '🚆';

      L.DomEvent.on(button, 'click', function(e) {
        L.DomEvent.stopPropagation(e);
        L.DomEvent.preventDefault(e);

        const isVisible = map.hasLayer(trainLineLayer);
        if (isVisible) {
          map.removeLayer(trainLineLayer);
          button.classList.add('inactive');
        } else {
          map.addLayer(trainLineLayer);
          button.classList.remove('inactive');
        }
      });

      return container;
    }
  });

  new TrainLinesToggleControl().addTo(map);

  // Add layer groups
  trainLineLayer.addTo(map);
  routeLayerGroup.addTo(map);
  stationLayerGroup.addTo(map);

  // Map click handler
  map.on('click', handleMapClick);

  if (options.onHomeChange) onHomeChange = options.onHomeChange;
  if (options.onRouteClick) onRouteClick = options.onRouteClick;

  return map;
}

/**
 * Set or move the home marker.
 */
export function setHomeMarker(coords) {
  if (homeMarker) map.removeLayer(homeMarker);

  const icon = L.divIcon({
    className: 'home-marker',
    html: '<span class="home-marker-emoji">🏠</span>',
    iconSize: [28, 28],
    iconAnchor: [14, 14],
  });

  homeMarker = L.marker([coords.lat, coords.lon], { icon, zIndexOffset: 1000 })
    .addTo(map)
    .bindTooltip('Home / Start', { direction: 'top', offset: [0, -14] });
}

/**
 * Draw the target distance circle.
 */
export function setDistanceCircle(centerCoords, radiusKm) {
  if (distanceCircle) map.removeLayer(distanceCircle);

  distanceCircle = L.circle([centerCoords.lat, centerCoords.lon], {
    radius: radiusKm * 1000,
    className: 'distance-circle',
    interactive: false,
  }).addTo(map);
}

/**
 * Draw train lines from lines.json data.
 */
export function drawTrainLines(lines) {
  trainLineLayer.clearLayers();

  lines.forEach(line => {
    if (!line.geometry || line.geometry.length === 0) return;

    // Detect if multi-polyline (array of arrays of [lon, lat]) or single flat array of [lon, lat]
    let latlngs;
    if (Array.isArray(line.geometry[0]) && Array.isArray(line.geometry[0][0])) {
      // Multi-polyline (list of contiguous track segments)
      latlngs = line.geometry.map(segment => segment.map(([lon, lat]) => [lat, lon]));
    } else {
      // Flat polyline (fallback for old lines.json formats)
      if (line.geometry.length < 2) return;
      latlngs = line.geometry.map(([lon, lat]) => [lat, lon]);
    }

    L.polyline(latlngs, {
      color: line.color || '#888',
      weight: 2.5,
      opacity: 0.3,
      interactive: false,
    }).addTo(trainLineLayer);
  });
}

/**
 * Add a bike route result to the map.
 * Returns the assigned color for this route.
 */
export function addBikeRoute(result, colorIndex) {
  const color = ROUTE_COLORS[colorIndex % ROUTE_COLORS.length];
  result.lines[0].color = color;

  const coords = result.bikeRoute?.features?.[0]?.geometry?.coordinates;
  if (!coords?.length) return color;

  const latlngs = coords.map(([lon, lat]) => [lat, lon]);

  const polyline = L.polyline(latlngs, {
    color,
    weight: 4,
    opacity: result.isSoftMatch ? 0.35 : 0.85,
    lineJoin: 'round',
    lineCap: 'round',
  }).addTo(routeLayerGroup);

  // Station marker
  const stationIcon = L.divIcon({
    className: '',
    html: `<div class="station-marker" style="background:${color};border-color:rgba(0,0,0,0.5)"></div>`,
    iconSize: [12, 12],
    iconAnchor: [6, 6],
  });

  const stationMarker = L.marker([result.station.lat, result.station.lon], {
    icon: stationIcon,
    zIndexOffset: 500,
    opacity: result.isSoftMatch ? 0.5 : 1.0,
  }).addTo(stationLayerGroup);

  // Bind permanent tooltip for station name
  stationMarker.bindTooltip(escapeHtml(result.station.name), {
    permanent: true,
    direction: 'top',
    className: 'station-tooltip',
    offset: [0, -8],
    opacity: result.isSoftMatch ? 0.5 : 0.9,
  });

  // Popup on station click
  const rebindPopup = () => {
    const lineIds = escapeHtml(result.lines.map(l => l.id).join(' / '));
    const lineNames = escapeHtml(result.lines.map(l => l.name).join(' / '));
    stationMarker.bindPopup(() => {
      const el = document.createElement('div');
      el.innerHTML = `
        <div class="popup-line" style="color:${color}">${lineIds} — ${lineNames}</div>
        <div class="popup-station">${escapeHtml(result.station.name)}</div>
        <div class="popup-stats">
          <span>🚲 ${result.bikeDistanceKm} km bike route</span>
          <span>⏱ ${formatTime(result.estimatedTimeMin)}</span>
        </div>
      `;
      return el;
    }, { maxWidth: 240 });
  };
  rebindPopup();

  // Hover effects
  const handleMouseOver = () => {
    if (activeRouteId !== result.id) {
      polyline.setStyle({ weight: 7, opacity: 1 });
      if (result.isSoftMatch) {
        stationMarker.setOpacity(1.0);
        stationMarker.getTooltip()?.setOpacity(0.9);
      }
    }
  };

  const handleMouseOut = () => {
    if (activeRouteId !== result.id) {
      polyline.setStyle({ weight: 4, opacity: result.isSoftMatch ? 0.35 : 0.85 });
      if (result.isSoftMatch) {
        stationMarker.setOpacity(0.5);
        stationMarker.getTooltip()?.setOpacity(0.5);
      }
    }
  };

  polyline.on('mouseover', handleMouseOver);
  polyline.on('mouseout', handleMouseOut);
  polyline.on('click', () => {
    if (onRouteClick) onRouteClick(result);
    selectRoute(result.id);
  });

  stationMarker.on('mouseover', handleMouseOver);
  stationMarker.on('mouseout', handleMouseOut);

  routeLayers.set(result.id, { polyline, stationMarker, color, result, rebindPopup });

  return color;
}

/**
 * Highlight a route (called from sidebar).
 */
export function selectRoute(resultId) {
  // Deselect previous
  if (activeRouteId && routeLayers.has(activeRouteId)) {
    const prev = routeLayers.get(activeRouteId);
    prev.polyline.setStyle({ weight: 4, opacity: prev.result.isSoftMatch ? 0.35 : 0.85 });
    if (prev.result.isSoftMatch) {
      prev.stationMarker.setOpacity(0.5);
      prev.stationMarker.getTooltip()?.setOpacity(0.5);
    }
  }

  activeRouteId = resultId;

  if (routeLayers.has(resultId)) {
    const { polyline, stationMarker, result } = routeLayers.get(resultId);
    polyline.setStyle({ weight: 7, opacity: 1 });
    polyline.bringToFront();
    if (result.isSoftMatch) {
      stationMarker.setOpacity(1.0);
      stationMarker.getTooltip()?.setOpacity(0.9);
    }

    // Fly to bounds with bottom padding for mobile sheet
    const bounds = polyline.getBounds();
    const padding = isMobile() ? [40, 40, Math.round(window.innerHeight * 0.5), 40] : [60, 60];
    map.flyToBounds(bounds, { padding, maxZoom: 12, duration: 0.8 });
  }
}

/**
 * Rebind popup when route lines are updated.
 */
export function updateBikeRoutePopup(result) {
  const layerInfo = routeLayers.get(result.id);
  if (layerInfo && layerInfo.rebindPopup) {
    layerInfo.rebindPopup();
  }
}

/**
 * Toggle a route's visibility.
 */
export function toggleRouteVisibility(resultId, visible) {
  if (!routeLayers.has(resultId)) return;
  const { polyline, stationMarker } = routeLayers.get(resultId);
  if (visible) {
    routeLayerGroup.addLayer(polyline);
    stationLayerGroup.addLayer(stationMarker);
  } else {
    routeLayerGroup.removeLayer(polyline);
    stationLayerGroup.removeLayer(stationMarker);
  }
}

/**
 * Clear all bike routes from the map.
 */
export function clearRoutes() {
  routeLayerGroup.clearLayers();
  stationLayerGroup.clearLayers();
  routeLayers.clear();
  activeRouteId = null;
  if (distanceCircle) map.removeLayer(distanceCircle);
  distanceCircle = null;
}

/**
 * Fit map to show all visible routes.
 */
export function fitToRoutes() {
  const bounds = L.latLngBounds([]);
  routeLayers.forEach(({ polyline }) => bounds.extend(polyline.getBounds()));
  if (homeMarker) bounds.extend(homeMarker.getLatLng());
  if (bounds.isValid()) {
    const padding = isMobile() ? [40, 40, Math.round(window.innerHeight * 0.5), 40] : [60, 60];
    map.flyToBounds(bounds, { padding, duration: 1.2 });
  }
}

/**
 * Enable/disable click-to-set-home mode.
 */
export function setHomePickerMode(enabled) {
  isSettingHome = enabled;
  map.getContainer().style.cursor = enabled ? 'crosshair' : '';
}

function handleMapClick(e) {
  if (isSettingHome && onHomeChange) {
    const coords = { lat: e.latlng.lat, lon: e.latlng.lng };
    onHomeChange(coords);
    isSettingHome = false;
    map.getContainer().style.cursor = '';
  }
}

export function getRouteColor(index) {
  return ROUTE_COLORS[index % ROUTE_COLORS.length];
}
