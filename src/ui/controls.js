/**
 * Control panel UI.
 * Manages: distance slider/input, tolerance slider/input,
 * bike profile selector, calculate button, home location display.
 */

export function initControls(options = {}) {
  const {
    onCalculate,
    onDistanceChange,
    onToleranceChange,
    onProfileChange,
    onSetHomeClick,
    onRequestGps,
    onSettingsChange,
  } = options;

  // Elements
  const distanceSlider = document.getElementById('distance-slider');
  const distanceInput = document.getElementById('distance-input');
  const toleranceSlider = document.getElementById('tolerance-slider');
  const toleranceInput = document.getElementById('tolerance-input');
  const calculateBtn = document.getElementById('calculate-btn');
  const calculateBtnText = document.getElementById('calculate-btn-text');
  const calculateBtnSpinner = document.getElementById('calculate-btn-spinner');
  const setLocationBtn = document.getElementById('set-location-btn');
  const panelCollapseBtn = document.getElementById('panel-collapse-btn');
  const controlPanel = document.getElementById('control-panel');
  const profileBtns = document.querySelectorAll('.profile-btn');
  const locationHint = document.getElementById('location-hint');
  const journeyDateInput = document.getElementById('journey-date');
  const journeyTimeInput = document.getElementById('journey-time');

  // Default date/time to "now". As long as the user hasn't picked their own
  // values, refresh the defaults whenever the tab regains focus — a tab left
  // open overnight would otherwise quietly search with yesterday's date.
  let dateTouched = false;
  let timeTouched = false;

  function refreshDateTimeDefaults() {
    const now = new Date();
    if (journeyDateInput && !dateTouched) {
      const y = now.getFullYear();
      const m = String(now.getMonth() + 1).padStart(2, '0');
      const d = String(now.getDate()).padStart(2, '0');
      journeyDateInput.value = `${y}-${m}-${d}`;
    }
    if (journeyTimeInput && !timeTouched) {
      const hours = String(now.getHours()).padStart(2, '0');
      const minutes = String(now.getMinutes()).padStart(2, '0');
      journeyTimeInput.value = `${hours}:${minutes}`;
    }
  }

  refreshDateTimeDefaults();
  window.addEventListener('focus', refreshDateTimeDefaults);
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) refreshDateTimeDefaults();
  });

  // --- Sync slider ↔ input ---
  distanceSlider?.addEventListener('input', () => {
    distanceInput.value = distanceSlider.value;
    updateSliderFill(distanceSlider);
    onDistanceChange?.(Number(distanceSlider.value));
    onSettingsChange?.();
  });

  distanceInput?.addEventListener('input', () => {
    const v = clamp(Number(distanceInput.value), 20, 200);
    distanceSlider.value = v;
    updateSliderFill(distanceSlider);
    onDistanceChange?.(v);
    onSettingsChange?.();
  });

  // The slider tracks the clamped value while typing, but the input keeps
  // whatever raw digits were entered (e.g. "300"). Write the clamped value back
  // once the field is committed so what's shown matches what the search uses.
  distanceInput?.addEventListener('change', () => {
    distanceInput.value = clamp(Number(distanceInput.value), 20, 200);
  });

  toleranceSlider?.addEventListener('input', () => {
    toleranceInput.value = toleranceSlider.value;
    updateSliderFill(toleranceSlider);
    onToleranceChange?.(Number(toleranceSlider.value));
    onSettingsChange?.();
  });

  toleranceInput?.addEventListener('input', () => {
    const v = clamp(Number(toleranceInput.value), 2, 30);
    toleranceSlider.value = v;
    updateSliderFill(toleranceSlider);
    onToleranceChange?.(v);
    onSettingsChange?.();
  });

  toleranceInput?.addEventListener('change', () => {
    toleranceInput.value = clamp(Number(toleranceInput.value), 2, 30);
  });

  // Initialize slider fills
  updateSliderFill(distanceSlider);
  updateSliderFill(toleranceSlider);

  // --- Profile selector ---
  let activeProfile = 'trekking';

  profileBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      profileBtns.forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      activeProfile = btn.dataset.profile;
      onProfileChange?.(activeProfile);
      onSettingsChange?.();
    });
  });

  // --- Date, Time, and Time-type selectors ---
  journeyDateInput?.addEventListener('change', () => {
    dateTouched = true;
    onSettingsChange?.();
  });

  journeyTimeInput?.addEventListener('change', () => {
    timeTouched = true;
    onSettingsChange?.();
  });

  document.querySelectorAll('input[name="time-type"]').forEach(radio => {
    radio.addEventListener('change', () => {
      onSettingsChange?.();
    });
  });

  // --- Calculate button ---
  calculateBtn?.addEventListener('click', () => {
    if (calculateBtn.disabled) return;
    const timeTypeEl = document.querySelector('input[name="time-type"]:checked');
    onCalculate?.({
      distance: Number(distanceSlider.value),
      tolerance: Number(toleranceSlider.value),
      profile: activeProfile,
      date: journeyDateInput?.value || '',
      time: journeyTimeInput?.value || '',
      timeType: timeTypeEl?.value || 'departure',
    });
  });

  // --- Home location picker ---
  setLocationBtn?.addEventListener('click', () => {
    locationHint.style.opacity = '1';
    locationHint.style.color = 'var(--accent)';
    locationHint.textContent = 'Tap anywhere on the map to set home…';
    onSetHomeClick?.();

    // Reset hint after delay
    setTimeout(() => {
      locationHint.style.color = '';
      locationHint.textContent = 'Tap the map to set a custom starting point';
    }, 5000);
  });

  // Tapping the name also triggers the change flow
  const homeNameEl = document.getElementById('home-location-name');
  homeNameEl?.addEventListener('click', () => setLocationBtn?.click());

  // GPS button re-requests geolocation
  const gpsBtn = document.getElementById('set-location-gps-btn');
  gpsBtn?.addEventListener('click', () => {
    onRequestGps?.();
  });

  // --- Collapse panel ---
  let collapsed = false;
  panelCollapseBtn?.addEventListener('click', () => {
    collapsed = !collapsed;
    controlPanel.classList.toggle('collapsed', collapsed);
    panelCollapseBtn.style.transform = collapsed ? 'rotate(180deg)' : '';
  });

  // --- Collapse/Expand Help panel ---
  const helpPanel = document.getElementById('help-panel');
  const helpContent = document.getElementById('help-content');
  const helpCloseBtn = document.getElementById('help-close-btn');

  // The expanded height is content-driven (height: auto), which CSS can't
  // transition to. Measure both end states and animate explicit pixel sizes
  // so width and height reach their final values at the same time.
  let helpResizeCleanup = null;
  function resizeHelpPanel(collapse) {
    helpResizeCleanup?.();

    const startW = helpPanel.offsetWidth;
    const startH = helpPanel.offsetHeight;
    // Measure the target size with transitions off: while one is in flight,
    // offsetWidth/Height report the interpolated value, not the end state.
    helpPanel.style.transition = 'none';
    helpPanel.classList.toggle('collapsed', collapse);
    helpPanel.classList.add('animating');
    helpPanel.style.width = '';
    helpPanel.style.height = '';
    const targetW = helpPanel.offsetWidth;
    const targetH = helpPanel.offsetHeight;

    // Lay the content out at the expanded width so the shrinking/growing
    // panel clips it instead of reflowing the text mid-animation.
    helpContent.style.width = `${Math.max(startW, targetW)}px`;
    helpPanel.style.width = `${startW}px`;
    helpPanel.style.height = `${startH}px`;
    helpPanel.offsetHeight; // commit the start size before transitioning
    helpPanel.style.transition = '';
    helpPanel.style.width = `${targetW}px`;
    helpPanel.style.height = `${targetH}px`;

    const cleanup = () => {
      helpResizeCleanup?.();
      helpPanel.classList.remove('animating');
      helpPanel.style.width = '';
      helpPanel.style.height = '';
      helpContent.style.width = '';
    };
    const onEnd = (e) => {
      if (e.target === helpPanel && e.propertyName === 'width') cleanup();
    };
    helpPanel.addEventListener('transitionend', onEnd);
    const fallback = setTimeout(cleanup, 500);
    helpResizeCleanup = () => {
      helpPanel.removeEventListener('transitionend', onEnd);
      clearTimeout(fallback);
      helpResizeCleanup = null;
    };
  }

  helpPanel?.addEventListener('click', () => {
    if (helpPanel.classList.contains('collapsed')) {
      resizeHelpPanel(false);
    }
  });

  helpCloseBtn?.addEventListener('click', (e) => {
    e.stopPropagation();
    resizeHelpPanel(true);
  });

  // --- Public API ---
  return {
    setCalculating(isCalc, progress = null) {
      calculateBtn.disabled = isCalc;
      calculateBtnText.textContent = isCalc
        ? (progress ? `Calculating (${progress.done}/${progress.total})…` : 'Calculating…')
        : 'Find Routes';
      calculateBtnSpinner.classList.toggle('hidden', !isCalc);
    },

    updateProgress(done, total) {
      calculateBtnText.textContent = `Calculating (${done}/${total})…`;
    },

    setHomeName(name) {
      const el = document.getElementById('home-location-name');
      if (el) el.textContent = name;
    },

    getValues() {
      const timeTypeEl = document.querySelector('input[name="time-type"]:checked');
      return {
        distance: Number(distanceSlider.value),
        tolerance: Number(toleranceSlider.value),
        profile: activeProfile,
        date: journeyDateInput?.value || '',
        time: journeyTimeInput?.value || '',
        timeType: timeTypeEl?.value || 'departure',
      };
    },

    /**
     * Restore persisted settings (distance, tolerance, profile, timeType).
     * Date/time are intentionally not restored — they default to "now".
     */
    setValues({ distance, tolerance, profile, timeType } = {}) {
      if (distance != null && distanceSlider && distanceInput) {
        const v = clamp(Number(distance), 20, 200);
        distanceSlider.value = v;
        distanceInput.value = v;
        updateSliderFill(distanceSlider);
      }
      if (tolerance != null && toleranceSlider && toleranceInput) {
        const v = clamp(Number(tolerance), 2, 30);
        toleranceSlider.value = v;
        toleranceInput.value = v;
        updateSliderFill(toleranceSlider);
      }
      if (profile) {
        const btn = document.querySelector(`.profile-btn[data-profile="${profile}"]`);
        if (btn) {
          profileBtns.forEach(b => b.classList.remove('active'));
          btn.classList.add('active');
          activeProfile = profile;
        }
      }
      if (timeType) {
        const radio = document.querySelector(`input[name="time-type"][value="${timeType}"]`);
        if (radio) radio.checked = true;
      }
    },
  };
}

// Fill the slider track up to the thumb position
function updateSliderFill(slider) {
  if (!slider) return;
  const min = Number(slider.min);
  const max = Number(slider.max);
  const val = Number(slider.value);
  const pct = ((val - min) / (max - min)) * 100;
  slider.style.background = `linear-gradient(to right, var(--accent) ${pct}%, var(--border-glass) ${pct}%)`;
}

function clamp(v, min, max) {
  return Math.min(Math.max(v, min), max);
}
