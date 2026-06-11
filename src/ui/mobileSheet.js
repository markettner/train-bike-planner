/**
 * Mobile Bottom Sheet
 *
 * Manages a draggable bottom sheet with three views:
 *   - Settings  (the control panel)
 *   - Routes    (the route list sidebar)
 *   - Details   (the selected route details panel)
 *
 * Also manages the mobile help modal.
 *
 * Only active when window.innerWidth <= 768.
 */

const PEEK_HEIGHT   = 60;   // px — slim Apple Maps-style peek strip
const HALF_HEIGHT   = 0.50; // fraction of dvh — routes list
const EXPAND_HEIGHT = 0.92; // fraction of dvh — settings

let currentView = 'settings'; // 'settings' | 'routes' | 'details'
let currentSnapFrac = null;   // null means peek

// DOM refs
let sheet, backdrop, peekText, handleArea;
let settingsView, routesView, detailsView;
let backBtn, detailsTitle;
let newSearchBtn;
let helpBtn, helpModal, helpCloseBtn;

let onNewSearch = null;  // callback → app.js
let onBack = null;       // callback → routeList.js (deselect)
let isInitialized = false;
let progressPill = null; // floating progress overlay on map

/**
 * Initialise the bottom sheet.
 * Moves desktop panel DOM nodes into the correct sheet views.
 *
 * @param {{ onNewSearch: Function, onBack: Function }} options
 */
export function initMobileSheet({ onNewSearch: _onNewSearch, onBack: _onBack } = {}) {
  if (!isMobile()) return;

  onNewSearch = _onNewSearch;
  onBack = _onBack;

  sheet       = document.getElementById('mobile-sheet');
  backdrop    = document.getElementById('mobile-sheet-backdrop');
  peekText    = document.getElementById('mobile-peek-text');
  handleArea  = document.getElementById('mobile-sheet-handle-area');

  settingsView = document.getElementById('mobile-settings-view');
  routesView   = document.getElementById('mobile-routes-view');
  detailsView  = document.getElementById('mobile-details-view');

  backBtn      = document.getElementById('mobile-back-btn');
  detailsTitle = document.getElementById('mobile-details-title');
  newSearchBtn = document.getElementById('mobile-new-search-btn');

  helpBtn      = document.getElementById('mobile-help-btn');
  helpModal    = document.getElementById('mobile-help-modal');
  helpCloseBtn = document.getElementById('mobile-help-close-btn');

  if (!sheet) return;

  // --- Move desktop panels into sheet views ---
  const controlPanel   = document.getElementById('control-panel');
  const routeSidebar   = document.getElementById('route-sidebar');
  const detailsPanel   = document.getElementById('route-details-panel');

  const settingsScroll = settingsView.querySelector('.mobile-sheet-scroll');
  const routesScroll   = routesView.querySelector('.mobile-sheet-scroll');
  const detailsScroll  = detailsView.querySelector('.mobile-sheet-scroll');

  if (controlPanel && settingsScroll) settingsScroll.appendChild(controlPanel);
  if (routeSidebar && routesScroll)   routesScroll.appendChild(routeSidebar);
  if (detailsPanel && detailsScroll)  detailsScroll.appendChild(detailsPanel);

  // Build floating progress pill (shown on map during search)
  progressPill = document.createElement('div');
  progressPill.id = 'mobile-progress-pill';
  progressPill.className = 'mobile-progress-pill hidden';
  progressPill.innerHTML = `
    <div class="mpp-spinner"></div>
    <span class="mpp-text">Finding routes…</span>
    <div class="mpp-bar-track"><div class="mpp-bar-fill" style="width:0%"></div></div>
  `;
  document.body.appendChild(progressPill);

  // Start at peek — map is visible on load, user taps to configure
  peekText.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="18 15 12 9 6 15"></polyline></svg> Configure route`;
  showView('settings');
  snapTo(null);

  // Wire drag gesture
  initDrag();

  // Backdrop tap collapses the sheet
  backdrop.addEventListener('click', () => snapTo(null));

  // Back button
  backBtn?.addEventListener('click', () => {
    if (currentView === 'details') {
      showRouteList();
      onBack?.();
    }
  });

  // New search button
  newSearchBtn?.addEventListener('click', () => {
    showSettings();
    onNewSearch?.();
  });

  // Help
  helpBtn?.addEventListener('click', () => {
    helpModal?.classList.add('visible');
  });
  helpCloseBtn?.addEventListener('click', () => {
    helpModal?.classList.remove('visible');
  });

  isInitialized = true;

  window.__mobileSheet = {
    expand,
    collapse,
    showSettings,
    showRouteList,
    showRouteDetails,
  };

  // Trigger Leaflet to recalculate map size after DOM reorganisation
  // (fixes blank map on first load — the panel move can confuse the layout engine)
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      window.dispatchEvent(new Event('resize'));
    });
  });
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Show the settings view (used on New Search) */
export function showSettings() {
  if (!isMobile() || !isInitialized) return;
  peekText.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="18 15 12 9 6 15"></polyline></svg> Configure route`;
  showView('settings');
  snapTo(EXPAND_HEIGHT); // Always open fully so Find Routes is always visible
}

/** Show the route list view (called after routes are found) */
export function showRouteList(count) {
  if (!isMobile() || !isInitialized) return;
  hideProgressPill();
  if (count != null) {
    peekText.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="18 15 12 9 6 15"></polyline></svg> <span class="peek-badge">${count}</span>&nbsp;route${count !== 1 ? 's' : ''} found`;
  } else {
    peekText.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="18 15 12 9 6 15"></polyline></svg> Routes found`;
  }
  showView('routes');
  snapTo(HALF_HEIGHT);

  // Tell the sidebar it's visible (for the sidebar-open CSS class)
  document.body.classList.add('sidebar-open');
}

/** Show the route details view */
export function showRouteDetails(routeName) {
  if (!isMobile() || !isInitialized) return;
  if (detailsTitle) detailsTitle.textContent = routeName || '';
  showView('details');
  snapTo(EXPAND_HEIGHT);
}

/** Collapse to peek */
export function collapse() {
  if (!isMobile() || !isInitialized) return;
  snapTo(null);
}

/** Expand to full height */
export function expand() {
  if (!isMobile() || !isInitialized) return;
  snapTo(EXPAND_HEIGHT);
}

/**
 * Collapse to peek and signal that the user is picking a map location.
 * The map gets a tap-to-set-home overlay via body.picking-location CSS.
 */
export function collapseForLocationPick() {
  if (!isMobile() || !isInitialized) return;
  peekText.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3"/></svg> Tap map to set location`;
  snapTo(null);
  document.body.classList.add('picking-location');

  // Clear the picking state once the map is clicked (location set)
  const clear = () => {
    document.body.classList.remove('picking-location');
    peekText.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="18 15 12 9 6 15"></polyline></svg> Configure route`;
    window.removeEventListener('pointerdown', clear);
  };
  // Give a tick before attaching so the current tap doesn't immediately clear it
  setTimeout(() => window.addEventListener('pointerdown', clear, { once: true }), 200);
}

/**
 * Called the moment Find Routes is tapped.
 * Collapses the sheet immediately so the map is visible during the search,
 * and shows a floating progress pill over the map.
 */
export function startSearchMode() {
  if (!isMobile() || !isInitialized) return;
  peekText.innerHTML = `<div class="peek-spinner"></div> Searching…`;
  snapTo(null);
  showProgressPill('Finding routes…', 0);
}

/** Update the progress pill during search (0–100) */
export function updateSearchProgress(done, total) {
  if (!progressPill) return;
  const pct = total > 0 ? Math.round((done / total) * 100) : 0;
  const fill = progressPill.querySelector('.mpp-bar-fill');
  const text = progressPill.querySelector('.mpp-text');
  if (fill) fill.style.width = `${pct}%`;
  if (text) text.textContent = `Finding routes… ${done}/${total}`;
}

function showProgressPill(msg, pct) {
  if (!progressPill) return;
  const text = progressPill.querySelector('.mpp-text');
  const fill = progressPill.querySelector('.mpp-bar-fill');
  if (text) text.textContent = msg;
  if (fill) fill.style.width = `${pct}%`;
  progressPill.classList.remove('hidden');
}

function hideProgressPill() {
  progressPill?.classList.add('hidden');
}

export function isMobileActive() {
  return isMobile() && isInitialized;
}

// ---------------------------------------------------------------------------
// View management
// ---------------------------------------------------------------------------

function showView(name) {
  currentView = name;
  const views = { settings: settingsView, routes: routesView, details: detailsView };
  Object.entries(views).forEach(([key, el]) => {
    if (!el) return;
    if (key === name) {
      el.classList.remove('exiting-left');
      el.classList.add('active');
    } else {
      el.classList.remove('active');
      el.classList.remove('exiting-left');
    }
  });
}

// ---------------------------------------------------------------------------
// Snap position
// ---------------------------------------------------------------------------

function snapTo(frac) {
  currentSnapFrac = frac;
  const dvh = window.innerHeight;

  let translateY;
  if (frac === null) {
    // Peek: sheet bottom sits at PEEK_HEIGHT from bottom of screen
    translateY = dvh - PEEK_HEIGHT;
  } else {
    translateY = dvh - Math.round(dvh * frac);
  }

  setTranslateY(translateY, true);

  // Backdrop
  const isExpanded = frac !== null && frac >= HALF_HEIGHT;
  backdrop.classList.toggle('visible', isExpanded);
}

function setTranslateY(y, animate) {
  const dvh = window.innerHeight;
  y = Math.max(0, Math.min(dvh - PEEK_HEIGHT, y));
  sheet.classList.toggle('no-transition', !animate);
  sheet.style.transform = `translateY(${y}px)`;
  // Keep map controls floating just above the visible sheet edge
  const visibleSheetHeight = dvh - y;
  document.documentElement.style.setProperty('--sheet-bottom', `${visibleSheetHeight}px`);
}

function getCurrentTranslateY() {
  const match = sheet.style.transform.match(/translateY\(([^)]+)px\)/);
  return match ? parseFloat(match[1]) : window.innerHeight - PEEK_HEIGHT;
}

// ---------------------------------------------------------------------------
// Touch drag
// ---------------------------------------------------------------------------

function initDrag() {
  let startY = 0;
  let startTranslateY = 0;
  let isDragging = false;
  let lastY = 0;
  let lastVelocity = 0;
  let lastTimestamp = 0;

  handleArea.addEventListener('touchstart', onTouchStart, { passive: true });
  sheet.addEventListener('touchstart', onTouchStartSheet, { passive: true });

  function onTouchStart(e) {
    beginDrag(e.touches[0].clientY);
  }

  function onTouchStartSheet(e) {
    // Only drag from the handle area or when at peek/half height
    const target = e.target;
    if (!handleArea.contains(target) && currentSnapFrac !== null && currentSnapFrac >= HALF_HEIGHT) {
      // Sheet is expanded — let native scroll handle it
      return;
    }
    if (!handleArea.contains(target) && currentSnapFrac === null) {
      beginDrag(e.touches[0].clientY);
    }
  }

  function beginDrag(y) {
    isDragging = true;
    startY = y;
    lastY = y;
    lastTimestamp = Date.now();
    lastVelocity = 0;
    startTranslateY = getCurrentTranslateY();
    sheet.classList.add('no-transition');
  }

  document.addEventListener('touchmove', (e) => {
    if (!isDragging) return;

    const clientY = e.touches[0].clientY;
    const now = Date.now();
    const dt = now - lastTimestamp;
    if (dt > 0) {
      lastVelocity = (clientY - lastY) / dt; // px/ms, positive = dragging down
    }
    lastY = clientY;
    lastTimestamp = now;

    const delta = clientY - startY;
    const newY = startTranslateY + delta;
    setTranslateY(newY, false);

    // Update backdrop opacity as we drag
    const dvh = window.innerHeight;
    const halfY = dvh - Math.round(dvh * HALF_HEIGHT);
    const progress = Math.max(0, Math.min(1, (halfY - newY) / (halfY)));
    backdrop.style.background = `rgba(0,0,0,${0.3 * progress})`;
    backdrop.classList.toggle('visible', progress > 0);
    backdrop.style.pointerEvents = progress > 0 ? 'auto' : 'none';
  }, { passive: true });

  document.addEventListener('touchend', () => {
    if (!isDragging) return;
    isDragging = false;
    sheet.classList.remove('no-transition');
    backdrop.style.background = '';
    backdrop.style.pointerEvents = '';

    const currentY = getCurrentTranslateY();
    const dvh = window.innerHeight;
    const peekY   = dvh - PEEK_HEIGHT;
    const halfY   = dvh - Math.round(dvh * HALF_HEIGHT);
    const expandY = dvh - Math.round(dvh * EXPAND_HEIGHT);

    // Use velocity to decide snap direction
    // Positive velocity = flicking down (collapse), negative = flicking up (expand)
    const VELOCITY_THRESHOLD = 0.3; // px/ms

    if (lastVelocity > VELOCITY_THRESHOLD) {
      // Flick down
      if (currentY > halfY) {
        snapTo(null);           // collapse to peek
      } else {
        snapTo(HALF_HEIGHT);    // snap to half
      }
    } else if (lastVelocity < -VELOCITY_THRESHOLD) {
      // Flick up
      if (currentY < halfY) {
        snapTo(EXPAND_HEIGHT);  // expand to full
      } else {
        snapTo(HALF_HEIGHT);    // snap to half
      }
    } else {
      // No velocity — snap to nearest
      const toExpand = Math.abs(currentY - expandY);
      const toHalf   = Math.abs(currentY - halfY);
      const toPeek   = Math.abs(currentY - peekY);
      const min = Math.min(toExpand, toHalf, toPeek);
      if (min === toPeek)   snapTo(null);
      else if (min === toHalf) snapTo(HALF_HEIGHT);
      else                  snapTo(EXPAND_HEIGHT);
    }
  });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function isMobile() {
  return window.matchMedia('(max-width: 768px)').matches;
}
