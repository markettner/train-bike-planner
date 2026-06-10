/**
 * Route details panel UI.
 * Displays train connection details for a selected route.
 */

import { isMobile } from './mobileSheet.js';
import { showRouteList } from './mobileSheet.js';

const panel = document.getElementById('route-details-panel');
const routeNameEl = document.getElementById('route-details-name');
const closeBtn = document.getElementById('route-details-close-btn');

closeBtn?.addEventListener('click', () => {
  if (isMobile()) {
    // On mobile: navigate back to the route list
    document.querySelectorAll('.route-card.active').forEach(c => c.classList.remove('active'));
    showRouteList();
  } else {
    hide();
  }
});

/**
 * Show the train connection details for the selected route.
 *
 * @param {object} result - The route result containing trainStats and station info
 */
export function showRouteDetails(result) {
  if (!result) return;

  // Update labels
  if (routeNameEl) {
    routeNameEl.textContent = `${result.lines.map(l => l.id).join(' / ')} · ${result.station.name} → Home`;
  }

  // Populate VBB train details timeline
  populateTrainTimeline(result, result.station.name);

  // Show panel — on mobile the sheet reveals it; on desktop show the fixed panel
  if (!isMobile()) {
    panel?.classList.remove('hidden');
  }
}

/**
 * Hide the route details panel.
 */
export function hide() {
  panel?.classList.add('hidden');
}

export function populateTrainTimeline(result, stationName, containerEl) {
  const columnEl = containerEl || document.getElementById('train-details-column');
  if (!columnEl) return;

  const trainStats = result?.trainStats;
  const status = result?.trainStatsStatus || (result?.trainStats ? 'success' : 'failed');

  if (status === 'loading') {
    columnEl.innerHTML = `
      <div class="details-loading-container">
        <div class="btn-spinner details-loading-spinner"></div>
        <span>Fetching live train connection details…</span>
      </div>
    `;
    return;
  }

  if (status === 'failed' || !trainStats || !trainStats.legs || trainStats.legs.length === 0) {
    columnEl.innerHTML = `
      <div class="details-unavailable-message">
        ${status === 'failed' ? '⚠️ Live train connection details unavailable (APIs offline)' : 'No train connections found for this time.'}
      </div>
    `;
    return;
  }

  let html = '';

  // 1. Cancellation Guidance (if any, full width at the top)
  if (trainStats.cancellations && trainStats.cancellations.hasCancelledLeg) {
    const isCritical = trainStats.cancellations.isCritical;
    html += `
      <div class="cancellation-alert${isCritical ? ' critical' : ''}">
        ${trainStats.cancellations.guidance}
      </div>
    `;
  }

  // 2. Horizontal Two-Column Layout
  html += `<div class="details-layout">`;

  // --- LEFT COLUMN: Journey Timeline ---
  html += `<div class="details-timeline-col">`;

  // Summary header
  const occupancyLabel = trainStats.occupancy === 'high' ? 'Packed Train Warning ⚠️' : `${trainStats.occupancy} occupancy`;
  const occupancyClass = trainStats.occupancy === 'high' ? 'occupancy-high' : (trainStats.occupancy === 'medium' ? 'occupancy-med' : 'occupancy-low');

  html += `
    <div class="details-summary-header">
      <span class="details-transfers-label">${trainStats.transfers === 0 ? 'Direct ride' : `${trainStats.transfers} transfer${trainStats.transfers > 1 ? 's' : ''}`}</span>
      <span class="details-occupancy-label ${occupancyClass}">${occupancyLabel}</span>
    </div>
  `;

  // Timeline legs
  html += `<div class="details-legs-list">`;
  trainStats.legs.forEach(leg => {
    const isWalking = leg.lineName === 'Walk' || !leg.depTime;
    const badgeBg = leg.lineColor?.bg || '#888';
    const badgeFg = leg.lineColor?.fg || '#fff';
    const isCancelled = leg.cancelled === true;

    html += `
      <div class="timeline-leg${isCancelled ? ' cancelled' : ''}">
        <div class="leg-header">
          <div class="leg-header-left">
            <span class="leg-badge" style="background:${badgeBg}; color:${badgeFg};">${leg.lineName}</span>
            ${isCancelled ? '<span class="leg-cancelled-label">Cancelled ❌</span>' : ''}
          </div>
          <span class="leg-duration">${leg.duration} min</span>
        </div>
        <div class="leg-stops">
          <div class="leg-stop-row">
            <span class="leg-stop-name">➔ ${leg.originName}</span>
            <span class="leg-time">${leg.depTime}${leg.depPlatform ? ` <span class="leg-platform">[Pl. ${leg.depPlatform}]</span>` : ''}</span>
          </div>
          <div class="leg-stop-row secondary">
            <span class="leg-stop-name"">➔ ${leg.destName}</span>
            <span class="leg-time muted">${leg.arrTime}${leg.arrPlatform ? ` <span class="leg-platform">[Pl. ${leg.arrPlatform}]</span>` : ''}</span>
          </div>
        </div>
      </div>
    `;
  });
  html += `</div>`; // End legs list
  html += `</div>`; // End left column

  // --- RIGHT COLUMN: Service Frequency & Alternatives ---
  html += `<div class="details-frequency-col">`;

  if (trainStats.frequency) {
    html += `
      <div class="frequency-panel">
        <div class="frequency-panel-header">
          <span>⏱ Frequency</span>
          <span class="frequency-label">${trainStats.frequency.label}</span>
        </div>
    `;

    if (trainStats.alternatives && trainStats.alternatives.length > 0) {
      html += `
        <div class="departures-list">
          <div class="departures-list-title">Next Departures:</div>
      `;

      trainStats.alternatives.forEach(alt => {
        let occClass = 'occ-low';
        let occLabel = 'low';
        if (alt.occupancy === 'medium') { occClass = 'occ-med'; occLabel = 'med'; }
        else if (alt.occupancy === 'high') { occClass = 'occ-high'; occLabel = 'packed'; }

        const isAltCancelled = alt.cancelled === true;
        const cancelledClass = isAltCancelled ? ' cancelled' : '';

        let adviceHtml = '';
        if (trainStats.occupancy === 'high' && alt.occupancy !== 'high' && !isAltCancelled) {
          adviceHtml = `<span class="departure-advice">💡 Recommended</span>`;
        }

        html += `
          <div class="departure-row${cancelledClass}">
            <div class="departure-row-left">
              <span class="departure-time">${alt.depTime}</span>
              <span class="departure-lines">(${alt.lines.join('/')})</span>
            </div>
            ${isAltCancelled
              ? `<span class="departure-cancelled">Cancelled</span>`
              : (adviceHtml ? adviceHtml : `<span class="departure-occ ${occClass}">${occLabel}</span>`)
            }
          </div>
        `;
      });

      html += `</div>`;
    } else {
      html += `<div class="departures-empty">No alternative departures found.</div>`;
    }

    html += `</div>`; // End frequency-panel
  }

  html += `</div>`; // End right column
  html += `</div>`; // End details-layout

  columnEl.innerHTML = html;
}
