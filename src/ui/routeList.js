/**
 * Route list sidebar UI.
 * Shows all calculated routes as cards; supports sorting, selection,
 * visibility toggle, and GPX export per route.
 */

import { exportRouteAsGPX } from '../algorithm/gpxExport.js';
import { selectRoute, toggleRouteVisibility } from './mapRenderer.js';
import { showRouteDetails } from './routeDetailsPanel.js';
import { isMobile, showRouteDetails as mobileShowDetails } from './mobileSheet.js';

const sidebar = document.getElementById('route-sidebar');
const routeList = document.getElementById('route-list');
const routeCount = document.getElementById('route-count');
const sortSelect = document.getElementById('sort-select');
const closeBtn = document.getElementById('sidebar-close-btn');
const toggleBtn = document.getElementById('sidebar-toggle-btn');
const toggleCount = document.getElementById('sidebar-toggle-count');
const exportAllBtn = document.getElementById('export-all-btn');

let allResults = [];
let visibilityState = {}; // resultId → boolean

closeBtn?.addEventListener('click', () => {
  sidebar.classList.add('hidden');
  toggleBtn.classList.remove('hidden');
  document.body.classList.remove('sidebar-open');
});

toggleBtn?.addEventListener('click', () => {
  sidebar.classList.remove('hidden');
  toggleBtn.classList.add('hidden');
  document.body.classList.add('sidebar-open');
});

sortSelect?.addEventListener('change', () => renderList(allResults));

const softMatchesToggle = document.getElementById('soft-matches-toggle');
softMatchesToggle?.addEventListener('change', () => {
  filterSoftMatches(softMatchesToggle.checked);
});

/**
 * Initialize the sidebar with a new set of results.
 * Called progressively as routes are calculated.
 */
export function initSidebar(results) {
  allResults = results;
  results.forEach(r => {
    if (visibilityState[r.id] === undefined) {
      visibilityState[r.id] = true;
    }
  });

  routeCount.textContent = `${results.length} route${results.length !== 1 ? 's' : ''} found`;
  toggleCount.textContent = results.length;

  renderList(results);

  sidebar.classList.remove('hidden');
  toggleBtn.classList.add('hidden');
  exportAllBtn.classList.remove('hidden');
  if (!isMobile()) document.body.classList.add('sidebar-open');
}

/**
 * Append a single newly-calculated result card.
 * Used for progressive rendering during calculation.
 */
export function appendResult(result, index) {
  visibilityState[result.id] = true;

  // Add or update in allResults
  const existingIdx = allResults.findIndex(r => r.id === result.id);
  if (existingIdx === -1) {
    allResults.push(result);
    
    // Hide soft matches from map immediately if toggle is off
    const showSoft = document.getElementById('soft-matches-toggle')?.checked ?? true;
    if (result.isSoftMatch && !showSoft) {
      toggleRouteVisibility(result.id, false);
    }
  } else {
    allResults[existingIdx] = result;
  }

  renderList(allResults);

  sidebar.classList.remove('hidden');
  if (!isMobile()) toggleBtn.classList.add('hidden');
  exportAllBtn?.classList.remove('hidden');
}

/**
 * Clear all route cards (before a new calculation).
 */
export function clearSidebar() {
  allResults = [];
  visibilityState = {};
  routeList.innerHTML = '';
  routeCount.textContent = '0 routes found';
  toggleCount.textContent = '0';
  sidebar.classList.add('hidden');
  toggleBtn.classList.add('hidden');
  exportAllBtn?.classList.add('hidden');
  document.body.classList.remove('sidebar-open');
}

/**
 * Finalize the sidebar after all calculations are complete.
 * Sorts and renders the full list of results.
 */
export function finalizeSidebar() {
  renderList(allResults);
  if (allResults.length > 0) {
    exportAllBtn?.classList.remove('hidden');
  }
}

// --- Internal ---

function renderList(results) {
  const showSoft = document.getElementById('soft-matches-toggle')?.checked ?? true;
  const filtered = showSoft ? results : results.filter(r => !r.isSoftMatch);

  const sorted = sortResults([...filtered], sortSelect?.value || 'distance');
  routeList.innerHTML = '';
  sorted.forEach((r, i) => routeList.appendChild(buildCard(r, i)));

  routeCount.textContent = `${filtered.length} route${filtered.length !== 1 ? 's' : ''} found`;
  toggleCount.textContent = filtered.length;
}

/**
 * Filter soft matches on both map and list based on checkbox state.
 */
export function filterSoftMatches(showSoft) {
  allResults.forEach(r => {
    if (r.isSoftMatch) {
      const visible = showSoft && (visibilityState[r.id] !== false);
      toggleRouteVisibility(r.id, visible);
    }
  });

  renderList(allResults);
}

function sortResults(results, by) {
  switch (by) {
    case 'distance':
      return results.sort((a, b) => a.bikeDistanceKm - b.bikeDistanceKm);
    case 'name':
      return results.sort((a, b) => a.lines[0].id.localeCompare(b.lines[0].id));
    default:
      return results;
  }
}

function getOccupancyBadge(occupancy) {
  if (!occupancy) return '';
  let className = 'badge-low';
  let label = 'low';
  if (occupancy === 'medium') {
    className = 'badge-med';
    label = 'med';
  } else if (occupancy === 'high') {
    className = 'badge-high';
    label = 'packed ⚠️';
  }
  const peopleIcon = `<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="margin-right: 3px; display: inline-block;"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"></path><circle cx="9" cy="7" r="4"></circle><path d="M23 21v-2a4 4 0 0 0-3-3.87"></path><path d="M16 3.13a4 4 0 0 1 0 7.75"></path></svg>`;
  return `<span class="occupancy-badge ${className}">${peopleIcon}${label}</span>`;
}

function getFrequencyBadge(frequency) {
  if (!frequency || !frequency.label) return '';
  let className = 'badge-low';
  let shortLabel = 'Frequent';
  if (frequency.label.includes('Very Frequent')) {
    className = 'badge-low';
    shortLabel = 'Frequent';
  } else if (frequency.label.includes('Frequent')) {
    className = 'badge-low';
    shortLabel = 'Frequent';
  } else if (frequency.label.includes('Hourly')) {
    className = 'badge-med';
    shortLabel = 'Hourly';
  } else if (frequency.label.includes('Bi-hourly') || frequency.label.includes('Infrequent')) {
    className = 'badge-high';
    shortLabel = '2h interval';
  }
  return `<span class="occupancy-badge ${className}">⏱ ${shortLabel}</span>`;
}

function buildCard(result, index) {
  const color = result.lines[0].color;
  const isVisible = visibilityState[result.id] !== false;
  const isLocked = result.trainStats?.isLocked === true;
  const hasCancellation = result.trainStats?.cancellations?.hasCancelledLeg === true;

  const card = document.createElement('div');
  let cardClasses = 'route-card';
  if (result.isSoftMatch) cardClasses += ' soft-match';
  if (isLocked) cardClasses += ' locked-route';
  if (hasCancellation) cardClasses += ' cancelled-route';
  card.className = cardClasses;
  
  card.dataset.routeId = result.id;
  card.style.setProperty('--route-color', isLocked ? '#e74c3c' : color);

  const lineIds = result.lines.map(l => l.id).join(' / ');

  const status = result.trainStatsStatus || (result.trainStats ? 'success' : 'failed');
  let trainInfoHtml = '';

  if (status === 'loading') {
    trainInfoHtml = `<span class="train-loading">fetching...</span>`;
  } else if (status === 'failed' || !result.trainStats || result.trainStats.durationMin == null) {
    trainInfoHtml = `<span class="occupancy-badge badge-na" title="Transit connection data is unavailable (API offline)">N/A</span>`;
  } else {
    trainInfoHtml = `
      <span>${result.trainStats.durationMin}m</span>
      ${hasCancellation ? `<span class="occupancy-badge badge-high" style="font-size: 9px; padding: 1px 4px;">❌ Cancelled</span>` : ''}
      ${getOccupancyBadge(result.trainStats.occupancy)}
      ${getFrequencyBadge(result.trainStats.frequency)}
    `;
  }

  card.innerHTML = `
    <div class="route-card-header">
      <div class="route-card-info-row">
        <div class="route-color-dot" style="background:${isLocked ? '#e74c3c' : color};box-shadow:0 0 6px ${isLocked ? '#e74c3c' : color};"></div>
        <div class="route-line-name" style="color:${isLocked ? '#e74c3c' : color};">${escapeHtml(lineIds)}</div>
        <div class="route-station-name">${escapeHtml(result.station.name)}</div>
      </div>
      <div class="route-card-actions">
        <button class="route-visibility-btn" title="${isVisible ? 'Hide route' : 'Show route'}" data-id="${result.id}">
          ${isVisible ? eyeOpenSvg() : eyeClosedSvg()}
        </button>
        <button class="route-export-btn" title="Export as GPX" data-id="${result.id}">
          ${downloadSvg()}
        </button>
      </div>
    </div>
    <div class="route-summary-row">
      <div class="train-summary">
        <span>🚆</span>
        ${trainInfoHtml}
      </div>
      <div class="card-metric-divider"></div>
      <div class="bike-summary">
        <span>🚲 <strong class="bike-distance">${result.bikeDistanceKm} km</strong></span>
        <span>⏱ <strong>${formatTime(result.estimatedTimeMin)}</strong></span>
      </div>
    </div>
  `;

  // Card click → select on map + show elevation
  card.addEventListener('click', (e) => {
    if (e.target.closest('.route-visibility-btn') || e.target.closest('.route-export-btn')) return;
    selectRouteCard(card, result);
  });

  // Visibility toggle
  const visBtn = card.querySelector('.route-visibility-btn');
  if (visBtn) {
    visBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const visible = !visibilityState[result.id];
      visibilityState[result.id] = visible;
      toggleRouteVisibility(result.id, visible);
      visBtn.innerHTML = visible ? eyeOpenSvg() : eyeClosedSvg();
      visBtn.title = visible ? 'Hide route' : 'Show route';
      card.style.opacity = visible ? '1' : '0.45';
    });
  }

  // Export GPX
  const expBtn = card.querySelector('.route-export-btn');
  if (expBtn) {
    expBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      exportRouteAsGPX(result);
    });
  }

  return card;
}

function selectRouteCard(card, result) {
  // Deactivate all cards
  document.querySelectorAll('.route-card.active').forEach(c => c.classList.remove('active'));
  card.classList.add('active');

  selectRoute(result.id);

  if (isMobile()) {
    // On mobile: sheet handles details display
    const routeName = `${result.lines.map(l => l.id).join(' / ')} · ${result.station.name}`;
    mobileShowDetails(routeName);
    showRouteDetails(result); // still populate the panel DOM
  } else {
    showRouteDetails(result);
  }
}

/**
 * Programmatically select a route card and trigger its display.
 */
export function selectRouteById(routeId) {
  const card = routeList.querySelector(`[data-route-id="${routeId}"]`);
  if (!card) return;

  const result = allResults.find(r => r.id === routeId);
  if (!result) return;

  // Make sure sidebar is visible
  sidebar.classList.remove('hidden');
  toggleBtn.classList.add('hidden');

  selectRouteCard(card, result);
  card.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

// --- SVG Icons ---

function eyeOpenSvg() {
  return `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"></path><circle cx="12" cy="12" r="3"></circle></svg>`;
}

function eyeClosedSvg() {
  return `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"></path><line x1="1" y1="1" x2="23" y2="23"></line></svg>`;
}

function downloadSvg() {
  return `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><polyline points="7 10 12 15 17 10"></polyline><line x1="12" y1="15" x2="12" y2="3"></line></svg>`;
}

// --- Helpers ---

function formatTime(minutes) {
  if (!minutes) return '?';
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

function escapeHtml(str) {
  return str?.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;') ?? '';
}
