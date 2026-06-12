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
import { appendResult, clearSidebar, finalizeSidebar, selectRouteById,
         getVisibleResults, getSelectedRouteId, clearSelection } from './ui/routeList.js';
import { findRoutesForAllLines, clearTransitQueue } from './algorithm/stationFinder.js';
import { exportAllRoutesAsGPX } from './algorithm/gpxExport.js';
import { setStationMappings, getHomeVbbId } from './algorithm/routeService.js';
import { showRouteDetails } from './ui/routeDetailsPanel.js';
import { initMobileSheet, isMobile, showRouteList as mobileShowRouteList, showRouteDetails as mobileShowDetails, showSettings as mobileShowSettings, startSearchMode, updateSearchProgress, collapseForLocationPick } from './ui/mobileSheet.js';

// Default: Alexanderplatz, Berlin
const DEFAULT_HOME = { lat: 52.5219, lon: 13.4132, name: 'Alexanderplatz, Berlin' };

const SETTINGS_KEY = 'tbp-settings';
const HOME_KEY = 'tbp-home';

let homeCoords = { ...DEFAULT_HOME };
let linesData = null;
let calculatedResults = [];
let isCalculating = false;
let controls = null;
let lastSearchedSettings = null;

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
    onSetHomeClick: () => {
      setHomePickerMode(true);
      collapseForLocationPick(); // on mobile: collapse sheet, show tap hint
    },
    onSettingsChange: () => {
      checkSettingsStale();
      persistSettings();
    },
    onRequestGps: detectLocation,
  });

  // Restore persisted settings (distance, tolerance, profile, timeType)
  const savedSettings = loadJson(SETTINGS_KEY);
  if (savedSettings) controls.setValues(savedSettings);

  // 3. Restore the saved home location, or request geolocation
  const savedHome = loadJson(HOME_KEY);
  if (savedHome && Number.isFinite(savedHome.lat) && Number.isFinite(savedHome.lon)) {
    setHome(savedHome);
  } else {
    detectLocation();
  }

  // 4. Load train line data and station mappings
  await Promise.all([loadLinesData(), loadStationMappings()]);

  // 5. Export all button — exports only the routes currently visible
  // (soft-match filter and per-route visibility toggles applied)
  document.getElementById('export-all-btn')?.addEventListener('click', () => {
    const visible = getVisibleResults();
    if (visible.length > 0) {
      exportAllRoutesAsGPX(visible);
    } else {
      showError('No visible routes to export. Unhide a route or enable additional routes first.');
    }
  });

  // 6. Initialize mobile sheet (no-op on desktop)
  initMobileSheet({
    onNewSearch: () => {
      // Clear existing results and reset UI for a new search.
      // (The BRouter response cache is deliberately kept — it is keyed by
      // coordinates + profile and never goes stale within a session.)
      clearRoutes();
      clearSidebar();
      clearTransitQueue();
      calculatedResults = [];
      lastSearchedSettings = null;
      clearStaleState();
      document.body.classList.remove('sidebar-open');
    },
    onBack: clearSelection,
  });

  // 7. The mobile/desktop layouts are set up once at load (panels are moved
  // into the sheet DOM on mobile). If the viewport crosses the boundary —
  // tablet rotation, window resize — reload to rebuild the correct layout.
  window.matchMedia('(max-width: 768px)').addEventListener('change', () => {
    window.location.reload();
  });
}

// --- Persistence ---

function loadJson(key) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function saveJson(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Storage full or unavailable (private mode) — persistence is best-effort
  }
}

function persistSettings() {
  if (!controls) return;
  const { distance, tolerance, profile, timeType } = controls.getValues();
  saveJson(SETTINGS_KEY, { distance, tolerance, profile, timeType });
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
    const url = `https://nominatim.openstreetmap.org/reverse?lat=${coords.lat}&lon=${coords.lon}&format=json&zoom=18`;
    const res = await fetch(url, { headers: { 'Accept-Language': 'en' } });
    const data = await res.json();
    
    const addr = data.address;
    if (!addr) return 'Your Location';

    // Build a structured address
    const street = addr.road ? (addr.road + (addr.house_number ? ' ' + addr.house_number : '')) : '';
    const localArea = addr.suburb || addr.neighbourhood || addr.quarter || addr.village || addr.hamlet;
    const city = addr.city || addr.town || addr.municipality;

    const parts = [street, localArea, city].filter(Boolean);
    return parts.slice(0, 2).join(', ') || data.display_name?.split(',')[0] || 'Your Location';
  } catch {
    return 'Your Location';
  }
}

function setHome(coords) {
  homeCoords = coords;
  setHomeMarker(coords);
  controls.setHomeName(coords.name || `${coords.lat.toFixed(4)}, ${coords.lon.toFixed(4)}`);
  checkSettingsStale();
  saveJson(HOME_KEY, coords);
}

async function handleHomeChange(coords) {
  const name = await reverseGeocode(coords);
  setHome({ ...coords, name });
  // On mobile: re-open the settings sheet so user can continue to Find Routes
  if (isMobile()) {
    const { expand } = await import('./ui/mobileSheet.js');
    expand();
  }
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

  lastSearchedSettings = {
    homeLat: homeCoords.lat,
    homeLon: homeCoords.lon,
    distance,
    tolerance,
    profile,
    date,
    time,
    timeType
  };
  clearStaleState();

  // On mobile: immediately collapse the sheet and show progress pill on the map
  if (isMobile()) startSearchMode();

  // Reset UI (the BRouter cache survives — repeat searches with tweaked
  // settings reuse cached routes instead of re-hitting the API)
  clearRoutes();
  clearSidebar();
  clearTransitQueue();

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
        if (!result || !result.isTrainUpdate) {
          controls.updateProgress(done, total);
          if (isMobile()) {
            const foundLabel = (result && !result.isMergeUpdate)
              ? `${result.lines[0].id} ${result.station.name}`
              : null;
            updateSearchProgress(done, total, foundLabel);
          }
        }

        if (result) {
          if (result.isMergeUpdate || result.isTrainUpdate) {
            updateBikeRoutePopup(result);
            appendResult(result);
            const foundIdx = calculatedResults.findIndex(r => r.id === result.id);
            if (foundIdx !== -1) {
              calculatedResults[foundIdx] = result;
            }

            // If this route is currently selected, refresh the open details panel
            if (getSelectedRouteId() === result.id) {
              showRouteDetails(result);
            }
          } else {
            // Assign color
            const color = getRouteColor(colorIndex);
            result.lines[0].color = color;
            colorIndex++;

            // Add to map immediately (progressive)
            addBikeRoute(result, colorIndex - 1);

            // Add to sidebar immediately (progressive)
            appendResult(result);

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
  checkSettingsStale();
  finalizeSidebar();

  if (calculatedResults.length > 0) {
    fitToRoutes();
    // On mobile: transition sheet to route list view
    if (isMobile()) {
      mobileShowRouteList(calculatedResults.length);
    } else {
      document.body.classList.add('sidebar-open');
    }
  } else {
    showError(`No routes found within ${tolerance} km of ${distance} km. Try adjusting the distance or tolerance.`);
  }
}

function handleRouteClick(result) {
  selectRouteById(result.id);
  if (isMobile()) {
    const routeName = `${result.lines.map(l => l.id).join(' / ')} · ${result.station.name}`;
    mobileShowDetails(routeName);
  }
}

// --- Error Display ---

function showError(message) {
  // Simple toast notification
  const existing = document.getElementById('error-toast');
  if (existing) existing.remove();

  const toast = document.createElement('div');
  toast.id = 'error-toast';
  toast.className = 'error-toast';
  toast.textContent = message;
  document.body.appendChild(toast);

  setTimeout(() => toast.remove(), 5000);
}

window.addEventListener('show-error-toast', (e) => {
  if (e.detail && e.detail.message) {
    showError(e.detail.message);
  }
});

function clearStaleState() {
  const calculateBtn = document.getElementById('calculate-btn');
  if (calculateBtn) {
    calculateBtn.classList.remove('stale');
    const textEl = document.getElementById('calculate-btn-text');
    if (textEl && !isCalculating) {
      textEl.textContent = 'Find Routes';
    }
  }
}

function checkSettingsStale() {
  if (!lastSearchedSettings || calculatedResults.length === 0) {
    clearStaleState();
    return;
  }

  const values = controls.getValues();
  const isStale = (
    homeCoords.lat !== lastSearchedSettings.homeLat ||
    homeCoords.lon !== lastSearchedSettings.homeLon ||
    values.distance !== lastSearchedSettings.distance ||
    values.tolerance !== lastSearchedSettings.tolerance ||
    values.profile !== lastSearchedSettings.profile ||
    values.date !== lastSearchedSettings.date ||
    values.time !== lastSearchedSettings.time ||
    values.timeType !== lastSearchedSettings.timeType
  );

  const calculateBtn = document.getElementById('calculate-btn');
  if (calculateBtn) {
    const textEl = document.getElementById('calculate-btn-text');
    if (isStale) {
      calculateBtn.classList.add('stale');
      if (textEl && !isCalculating) {
        textEl.textContent = 'Update Routes';
      }
    } else {
      calculateBtn.classList.remove('stale');
      if (textEl && !isCalculating) {
        textEl.textContent = 'Find Routes';
      }
    }
  }
}

// --- Start ---
main();
