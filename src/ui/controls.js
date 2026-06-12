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

  // Set default date and time if not set
  if (journeyDateInput && !journeyDateInput.value) {
    const today = new Date().toISOString().split('T')[0];
    journeyDateInput.value = today;
  }
  if (journeyTimeInput && !journeyTimeInput.value) {
    const now = new Date();
    const hours = String(now.getHours()).padStart(2, '0');
    const minutes = String(now.getMinutes()).padStart(2, '0');
    journeyTimeInput.value = `${hours}:${minutes}`;
  }

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
    onSettingsChange?.();
  });

  journeyTimeInput?.addEventListener('change', () => {
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
  const helpCloseBtn = document.getElementById('help-close-btn');

  helpPanel?.addEventListener('click', () => {
    if (helpPanel.classList.contains('collapsed')) {
      helpPanel.classList.remove('collapsed');
    }
  });

  helpCloseBtn?.addEventListener('click', (e) => {
    e.stopPropagation();
    helpPanel?.classList.add('collapsed');
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
