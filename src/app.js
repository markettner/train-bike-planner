/**
 * Main application controller.
 * Coordinates: geolocation, map, controls, algorithm, and route display.
 */

import 'leaflet/dist/leaflet.css';
import './styles/main.css';

import { initMap, setHomeMarker, setDistanceCircle, drawTrainLines,
         addBikeRoute, clearRoutes, fitToRoutes, setHomePickerMode,
         getRouteColor, updateBikeRoutePopup } from './ui/mapRenderer.js';
import { initControls } from './ui/controls.js';
import { initSidebar, appendResult, clearSidebar, finalizeSidebar, selectRouteById, filterSoftMatches } from './ui/routeList.js';
import { findRoutesForAllLines } from './algorithm/stationFinder.js';
import { exportAllRoutesAsGPX } from './algorithm/gpxExport.js';
import { clearCache, setStationMappings, getHomeVbbId } from './algorithm/routeService.js';

// Default: Alexanderplatz, Berlin
const DEFAULT_HOME = { lat: 52.5219, lon: 13.4132, name: 'Alexanderplatz, Berlin' };

let homeCoords = { ...DEFAULT_HOME };
let linesData = null;
let calculatedResults = [];
let isCalculating = false;
let controls = null;

// --- Bootstrap ---

async function main() {
  // 1. Initialize map
  initMap({
    onHomeChange: handleHomeChange,
    onRouteClick: handleRouteClick,
  });

  // 2. Initialize controls
  controls = initControls({
    onCalculate: handleCalculate,
    onSetHomeClick: () => setHomePickerMode(true),
    onSoftMatchesToggle: (showSoft) => filterSoftMatches(showSoft),
  });

  // 3. Request geolocation
  detectLocation();

  // 4. Load train line data and station mappings
  await Promise.all([loadLinesData(), loadStationMappings()]);

  // 5. Export all button
  document.getElementById('export-all-btn')?.addEventListener('click', () => {
    if (calculatedResults.length > 0) {
      exportAllRoutesAsGPX(calculatedResults);
    }
  });
}

// --- Geolocation ---

function detectLocation() {
  controls.setHomeName('Detecting location…');

  if (!navigator.geolocation) {
    setHome(DEFAULT_HOME);
    return;
  }

  navigator.geolocation.getCurrentPosition(
    (pos) => {
      const coords = { lat: pos.coords.latitude, lon: pos.coords.longitude };
      reverseGeocode(coords).then(name => {
        setHome({ ...coords, name });
      });
    },
    () => {
      // Permission denied or unavailable — fall back to default
      setHome(DEFAULT_HOME);
    },
    { timeout: 8000, maximumAge: 60000 }
  );
}

async function reverseGeocode(coords) {
  try {
    const url = `https://nominatim.openstreetmap.org/reverse?lat=${coords.lat}&lon=${coords.lon}&format=json&zoom=14`;
    const res = await fetch(url, { headers: { 'Accept-Language': 'en' } });
    const data = await res.json();
    // Build a short friendly name
    const addr = data.address;
    const parts = [addr?.road, addr?.suburb || addr?.neighbourhood, addr?.city || addr?.town].filter(Boolean);
    return parts.slice(0, 2).join(', ') || data.display_name?.split(',')[0] || 'Your Location';
  } catch {
    return 'Your Location';
  }
}

function setHome(coords) {
  homeCoords = coords;
  setHomeMarker(coords);
  controls.setHomeName(coords.name || `${coords.lat.toFixed(4)}, ${coords.lon.toFixed(4)}`);
}

async function handleHomeChange(coords) {
  const name = await reverseGeocode(coords);
  setHome({ ...coords, name });
}

// --- Load Data ---

async function loadLinesData() {
  try {
    const res = await fetch(`${import.meta.env.BASE_URL}data/lines.json`);
    linesData = await res.json();
    // Draw train lines on map immediately
    if (linesData?.lines) {
      drawTrainLines(linesData.lines);
    }
  } catch (err) {
    console.error('Failed to load lines.json:', err);
    showError('Could not load train line data. Please check that lines.json exists in the /data folder.');
  }
}

async function loadStationMappings() {
  try {
    const res = await fetch(`${import.meta.env.BASE_URL}data/station_mappings.json`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const mappings = await res.json();
    setStationMappings(mappings);
  } catch (err) {
    console.warn('Could not load station_mappings.json, falling back to live resolution:', err.message);
    setStationMappings({});
  }
}

// --- Calculate Routes ---

async function handleCalculate({ distance, tolerance, profile, date, time, timeType }) {
  if (isCalculating) return;
  if (!linesData?.lines?.length) {
    showError('Train line data not loaded yet. Please wait…');
    return;
  }

  isCalculating = true;
  calculatedResults = [];
  let colorIndex = 0;

  // Reset UI
  clearRoutes();
  clearSidebar();
  clearCache();

  // Show the distance circle
  setDistanceCircle(homeCoords, distance / 1.3); // rough crow-flies radius

  controls.setCalculating(true, { done: 0, total: linesData.lines.length });

  try {
    // Resolve Home coordinates to a VBB Stop ID once
    const homeVbbId = await getHomeVbbId(homeCoords);
    const transitConfig = { homeVbbId, date, time, timeType };

    await findRoutesForAllLines(
      linesData.lines,
      homeCoords,
      distance,
      tolerance,
      profile,
      transitConfig,
      (done, total, result) => {
        controls.updateProgress(done, total);

        if (result) {
          if (result.isMergeUpdate) {
            updateBikeRoutePopup(result);
            appendResult(result, colorIndex - 1);
            const foundIdx = calculatedResults.findIndex(r => r.id === result.id);
            if (foundIdx !== -1) {
              calculatedResults[foundIdx] = result;
            }
          } else {
            // Assign color
            const color = getRouteColor(colorIndex);
            result.lines[0].color = color;
            colorIndex++;

            // Add to map immediately (progressive)
            addBikeRoute(result, colorIndex - 1);

            // Add to sidebar immediately (progressive)
            appendResult(result, colorIndex - 1);

            calculatedResults.push(result);
          }
        }
      }
    );
  } catch (err) {
    console.error('Route calculation failed:', err);
    showError('Route calculation encountered an error. Please try again.');
  }

  isCalculating = false;
  controls.setCalculating(false);
  finalizeSidebar();

  if (calculatedResults.length > 0) {
    fitToRoutes();
  } else {
    showError(`No routes found within ${tolerance} km of ${distance} km. Try adjusting the distance or tolerance.`);
  }
}

function handleRouteClick(result) {
  selectRouteById(result.id);
}

// --- Error Display ---

function showError(message) {
  // Simple toast notification
  const existing = document.getElementById('error-toast');
  if (existing) existing.remove();

  const toast = document.createElement('div');
  toast.id = 'error-toast';
  toast.style.cssText = `
    position: fixed;
    bottom: 24px;
    left: 50%;
    transform: translateX(-50%);
    background: rgba(255, 89, 94, 0.95);
    backdrop-filter: blur(12px);
    color: #fff;
    padding: 12px 20px;
    border-radius: 12px;
    font-size: 13px;
    font-weight: 500;
    z-index: 9999;
    box-shadow: 0 4px 20px rgba(0,0,0,0.3);
    max-width: min(400px, calc(100vw - 40px));
    text-align: center;
    animation: fadeIn 0.2s both;
  `;
  toast.textContent = message;
  document.body.appendChild(toast);

  setTimeout(() => toast.remove(), 5000);
}

window.addEventListener('show-error-toast', (e) => {
  if (e.detail && e.detail.message) {
    showError(e.detail.message);
  }
});

// --- Start ---
main();
