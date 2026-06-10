/**
 * Route details panel UI.
 * Displays train connection details for a selected route.
 */

const panel = document.getElementById('route-details-panel');
const routeNameEl = document.getElementById('route-details-name');
const closeBtn = document.getElementById('route-details-close-btn');

closeBtn?.addEventListener('click', hide);

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

  // Show panel
  panel?.classList.remove('hidden');
}

/**
 * Hide the route details panel.
 */
export function hide() {
  panel?.classList.add('hidden');
}

function populateTrainTimeline(result, stationName) {
  const columnEl = document.getElementById('train-details-column');
  if (!columnEl) return;

  const trainStats = result?.trainStats;
  const status = result?.trainStatsStatus || (result?.trainStats ? 'success' : 'failed');

  if (status === 'loading') {
    columnEl.innerHTML = `
      <div class="train-loading-spinner-container" style="color: var(--text-muted); font-style: italic; padding: 30px 0; font-size: 12px; text-align: center; display: flex; flex-direction: column; align-items: center; gap: 8px;">
        <div class="btn-spinner" style="width: 20px; height: 20px; border-width: 2px; border-color: rgba(77, 159, 255, 0.2); border-top-color: var(--accent);"></div>
        <span>Fetching live train connection details…</span>
      </div>
    `;
    return;
  }

  if (status === 'failed' || !trainStats || !trainStats.legs || trainStats.legs.length === 0) {
    columnEl.innerHTML = `
      <div style="color: var(--text-muted); font-style: italic; padding: 20px 0; font-size: 12px; text-align: center;">
        ${status === 'failed' ? '⚠️ Live train connection details unavailable (APIs offline)' : 'No train connections found for this time.'}
      </div>
    `;
    return;
  }

  let html = '';

  // 1. Cancellation Guidance (if any, full width at the top)
  if (trainStats.cancellations && trainStats.cancellations.hasCancelledLeg) {
    const isCritical = trainStats.cancellations.isCritical;
    const alertBg = isCritical ? 'rgba(231, 76, 60, 0.12)' : 'rgba(241, 196, 15, 0.08)';
    const alertBorder = isCritical ? 'rgba(231, 76, 60, 0.3)' : 'rgba(241, 196, 15, 0.2)';
    const alertColor = isCritical ? '#ff6b6b' : '#f1c40f';
    
    html += `
      <div style="background: ${alertBg}; border: 1px solid ${alertBorder}; border-radius: 8px; padding: 10px; font-size: 11px; line-height: 1.4; color: ${alertColor}; margin-bottom: 10px; font-weight: 500; width: 100%;">
        ${trainStats.cancellations.guidance}
      </div>
    `;
  }

  // 2. Horizontal Two-Column Layout
  html += `<div style="display: flex; gap: 16px; width: 100%; align-items: stretch;">`;

  // --- LEFT COLUMN: Journey Timeline ---
  html += `<div style="flex: 1.1; display: flex; flex-direction: column; gap: 6px; min-width: 0;">`;
  
  // Summary header for Left Column
  const occupancyLabel = trainStats.occupancy === 'high' ? 'Packed Train Warning ⚠️' : `${trainStats.occupancy} occupancy`;
  const occupancyColor = trainStats.occupancy === 'high' ? 'var(--danger)' : (trainStats.occupancy === 'medium' ? 'var(--accent)' : 'var(--success)');
  
  html += `
    <div style="display: flex; justify-content: space-between; font-size: 11px; font-weight: 700; border-bottom: 1px dashed var(--border-glass); padding-bottom: 4px; text-transform: uppercase; letter-spacing: 0.05em; margin-bottom: 4px;">
      <span style="color: var(--text-secondary);">${trainStats.transfers === 0 ? 'Direct ride' : `${trainStats.transfers} transfer${trainStats.transfers > 1 ? 's' : ''}`}</span>
      <span style="color: ${occupancyColor};">${occupancyLabel}</span>
    </div>
  `;

  // Timeline list (scrollable if many legs)
  html += `<div id="train-legs-timeline" style="display: flex; flex-direction: column; gap: 6px; overflow-y: auto; max-height: 160px; padding-right: 4px;">`;
  trainStats.legs.forEach(leg => {
    const isWalking = leg.lineName === 'Walk' || !leg.depTime;
    const badgeBg = leg.lineColor?.bg || '#888';
    const badgeFg = leg.lineColor?.fg || '#fff';
    const isCancelled = leg.cancelled === true;
    const strikeStyle = isCancelled ? 'text-decoration: line-through; opacity: 0.6;' : '';
    
    html += `
      <div style="display: flex; flex-direction: column; gap: 3px; padding: 6px 8px; background: ${isCancelled ? 'rgba(231, 76, 60, 0.05)' : 'rgba(255,255,255,0.02)'}; border-radius: 4px; border: 1px solid ${isCancelled ? 'rgba(231, 76, 60, 0.2)' : 'var(--border-glass)'};">
        <div style="display: flex; align-items: center; justify-content: space-between;">
          <div style="display: flex; align-items: center; gap: 6px;">
            <span style="background:${badgeBg}; color:${badgeFg}; padding: 1px 6px; border-radius: 4px; font-weight: 800; font-size: 9px; text-transform: uppercase; ${strikeStyle}">
              ${leg.lineName}
            </span>
            ${isCancelled ? '<span style="color: var(--danger); font-weight: 800; font-size: 9px; text-transform: uppercase;">Cancelled ❌</span>' : ''}
          </div>
          <span style="font-size: 10px; color: var(--text-muted); font-weight: 500; ${strikeStyle}">${leg.duration} min</span>
        </div>
        <div style="display: flex; flex-direction: column; gap: 2px; font-size: 11px; margin-top: 2px;">
          <div style="display: flex; justify-content: space-between; ${strikeStyle}">
            <span style="color: var(--text-primary); font-weight: 500; text-overflow: ellipsis; overflow: hidden; white-space: nowrap; max-width: 170px;">➔ ${leg.originName}</span>
            <span style="font-variant-numeric: tabular-nums; color: var(--accent); font-weight: 600; font-size: 11px;">
              ${leg.depTime} ${leg.depPlatform ? `[Pl. ${leg.depPlatform}]` : ''}
            </span>
          </div>
          <div style="display: flex; justify-content: space-between; ${strikeStyle}">
            <span style="color: var(--text-secondary); text-overflow: ellipsis; overflow: hidden; white-space: nowrap; max-width: 170px;">➔ ${leg.destName}</span>
            <span style="font-variant-numeric: tabular-nums; color: var(--text-muted); font-size: 11px;">
              ${leg.arrTime} ${leg.arrPlatform ? `[Pl. ${leg.arrPlatform}]` : ''}
            </span>
          </div>
        </div>
      </div>
    `;
  });
  html += `</div>`; // End of timeline list
  html += `</div>`; // End of Left Column

  // --- RIGHT COLUMN: Service Frequency & Alternatives ---
  html += `<div style="flex: 0.9; display: flex; flex-direction: column; gap: 6px; min-width: 0;">`;
  
  if (trainStats.frequency) {
    html += `
      <div style="display: flex; flex-direction: column; gap: 4px; padding: 8px 10px; background: rgba(255,255,255,0.01); border-radius: 6px; border: 1px solid var(--border-glass); height: 100%;">
        <div style="display: flex; align-items: center; justify-content: space-between; font-size: 11px; font-weight: 700; color: var(--text-secondary); text-transform: uppercase; border-bottom: 1px dashed var(--border-glass); padding-bottom: 4px; margin-bottom: 4px;">
          <span>⏱ Frequency</span>
          <span style="color: var(--accent); font-weight: 800;">${trainStats.frequency.label}</span>
        </div>
    `;

    if (trainStats.alternatives && trainStats.alternatives.length > 0) {
      html += `
        <div style="display: flex; flex-direction: column; gap: 4px; overflow-y: auto; max-height: 130px; padding-right: 2px;">
          <div style="font-size: 10px; font-weight: 700; color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.02em;">Next Departures:</div>
      `;

      trainStats.alternatives.forEach(alt => {
        let occColor = 'var(--success)';
        let occLabel = 'low';
        if (alt.occupancy === 'medium') {
          occColor = 'var(--warning)';
          occLabel = 'med';
        } else if (alt.occupancy === 'high') {
          occColor = 'var(--danger)';
          occLabel = 'packed';
        }
        
        const isAltCancelled = alt.cancelled === true;
        const strike = isAltCancelled ? 'text-decoration: line-through; opacity: 0.5;' : '';

        // Generate occupancy advice if alternative is emptier than current
        let adviceHtml = '';
        if (trainStats.occupancy === 'high' && alt.occupancy !== 'high' && !isAltCancelled) {
          adviceHtml = `<span style="font-size: 8px; font-weight: 800; color: var(--success); text-transform: uppercase; margin-left: auto;" title="Fewer passengers expected">💡 Recommended</span>`;
        }

        html += `
          <div style="display: flex; align-items: center; justify-content: space-between; font-size: 11px; padding: 4px 6px; background: rgba(255,255,255,0.01); border-radius: 4px; ${strike}">
            <div style="display: flex; align-items: center; gap: 4px; min-width: 0; flex: 1;">
              <span style="font-variant-numeric: tabular-nums; font-weight: 600; color: var(--text-primary);">${alt.depTime}</span>
              <span style="color: var(--text-muted); font-size: 9px; text-overflow: ellipsis; overflow: hidden; white-space: nowrap;">(${alt.lines.join('/')})</span>
            </div>
            ${isAltCancelled ? 
              `<span style="color: var(--danger); font-size: 9px; font-weight: 800; text-transform: uppercase; margin-left: auto;">Cancelled</span>` :
              (adviceHtml ? adviceHtml : `<span style="color: ${occColor}; font-size: 9px; font-weight: 700; text-transform: uppercase; margin-left: auto;">${occLabel}</span>`)
            }
          </div>
        `;
      });

      html += `</div>`;
    } else {
      html += `
        <div style="font-size: 11px; color: var(--text-muted); font-style: italic; margin-top: 2px;">
          No alternative departures found.
        </div>
      `;
    }

    html += `</div>`;
  }
  
  html += `</div>`; // End of Right Column
  html += `</div>`; // End of Two-Column Layout

  columnEl.innerHTML = html;
}
