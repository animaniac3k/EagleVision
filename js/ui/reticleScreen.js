/**
 * Reticle Customizer & Click Calibration Screen Controller
 *
 * Provides interactive real-time customization of the main graduated reticle:
 * - Number of indents/clicks per arm (top, bottom, left, right)
 * - Click spacing (distance between clicks in SVG/pixel units)
 * - Center gap size (unobstructed area for the point of interest)
 * - Click number labels (1, 2, 3... or 5, 10)
 * - Concentric range rings
 * - Interactive test click on preview stage to audition voice callouts
 */
import { appState, updateState, subscribeState } from '../state.js';
import { saveSettings } from '../storage/settingsStore.js';
import { buildGraduatedCrosshairSvg, getClickDistanceInPixels, RETICLE_VIEWBOX_W, RETICLE_VIEWBOX_H } from '../renderer/overlayManager.js';
import { speakDetectionAnnouncement } from '../renderer/compositor.js';

export function initReticleScreen() {
  const screenReticle = document.getElementById('screenReticle');
  const screenLive = document.getElementById('screenLive');
  const screenSettings = document.getElementById('screenSettings');

  const btnReticleBackToLive = document.getElementById('btnReticleBackToLive');
  const btnReticleToSettings = document.getElementById('btnReticleToSettings');
  const btnResetReticle = document.getElementById('btnResetReticle');
  const btnTestCallout = document.getElementById('btnTestCallout');
  const previewSvg = document.getElementById('reticlePreviewSvg');
  const previewStage = document.getElementById('reticlePreviewStage');
  const calloutTestText = document.getElementById('calloutTestText');

  // Control inputs
  const sliderClicks = document.getElementById('sliderReticleClicks');
  const valClicks = document.getElementById('valReticleClicks');
  const sliderSpacing = document.getElementById('sliderReticleSpacing');
  const valSpacing = document.getElementById('valReticleSpacing');
  const sliderGap = document.getElementById('sliderReticleGap');
  const valGap = document.getElementById('valReticleGap');
  const btnBrackets = document.getElementById('btnToggleReticleBrackets');
  const sliderMajor = document.getElementById('sliderReticleMajor');
  const valMajor = document.getElementById('valReticleMajor');
  const btnLabels = document.getElementById('btnToggleReticleLabels');
  const btnRings = document.getElementById('btnToggleReticleRings');
  const sliderStroke = document.getElementById('sliderReticleStroke');
  const valStroke = document.getElementById('valReticleStroke');

  function renderPreview() {
    if (!previewSvg) return;
    previewSvg.setAttribute('viewBox', `0 0 ${RETICLE_VIEWBOX_W} ${RETICLE_VIEWBOX_H}`);
    previewSvg.setAttribute('preserveAspectRatio', 'xMidYMid meet');
    const cfg = appState.reticleConfig || {};
    previewSvg.innerHTML = buildGraduatedCrosshairSvg(cfg);

    // Sync input values
    if (sliderClicks && valClicks) {
      sliderClicks.value = String(cfg.clickCount || 10);
      valClicks.textContent = `${cfg.clickCount || 10} clicks`;
    }
    if (sliderSpacing && valSpacing) {
      sliderSpacing.value = String(cfg.clickSpacing || 32);
      valSpacing.textContent = `${cfg.clickSpacing || 32} px`;
    }
    if (sliderGap && valGap) {
      sliderGap.value = String(cfg.centerGap ?? 64);
      valGap.textContent = `${cfg.centerGap ?? 64} px`;
    }
    if (btnBrackets) {
      btnBrackets.textContent = cfg.innerBrackets ? 'ON' : 'OFF';
      btnBrackets.classList.toggle('radar-btn-active', Boolean(cfg.innerBrackets));
    }
    if (sliderMajor && valMajor) {
      sliderMajor.value = String(cfg.majorInterval ?? 5);
      valMajor.textContent = cfg.majorInterval === 0 ? 'NONE' : `EVERY ${cfg.majorInterval}`;
    }
    if (btnLabels) {
      btnLabels.textContent = cfg.showLabels ? 'ON' : 'OFF';
      btnLabels.classList.toggle('radar-btn-active', Boolean(cfg.showLabels));
    }
    if (btnRings) {
      btnRings.textContent = cfg.concentricRings ? 'ON' : 'OFF';
      btnRings.classList.toggle('radar-btn-active', Boolean(cfg.concentricRings));
    }
    if (sliderStroke && valStroke) {
      sliderStroke.value = String(cfg.strokeWidth || 1.8);
      valStroke.textContent = `${Number(cfg.strokeWidth || 1.8).toFixed(1)} px`;
    }
  }

  function updateReticleConfig(patch) {
    const nextCfg = Object.assign({}, appState.reticleConfig, patch);
    updateState({ reticleConfig: nextCfg });
    saveSettings(appState);
    renderPreview();
  }

  // Exported Gamepad Control Definitions for Reticle Customizer
  const RETICLE_CONTROLS = [
    { key: 'clickCount', label: 'Clicks Per Arm', min: 2, max: 25, step: 1, elementId: 'sliderReticleClicks' },
    { key: 'clickSpacing', label: 'Click Spacing', min: 10, max: 80, step: 2, elementId: 'sliderReticleSpacing' },
    { key: 'centerGap', label: 'Center Gap', min: 0, max: 140, step: 4, elementId: 'sliderReticleGap' },
    { key: 'innerBrackets', label: 'Center Brackets', isToggle: true, elementId: 'btnToggleReticleBrackets' },
    { key: 'majorInterval', label: 'Major Tick Interval', min: 0, max: 10, step: 1, elementId: 'sliderReticleMajor' },
    { key: 'showLabels', label: 'Number Labels', isToggle: true, elementId: 'btnToggleReticleLabels' },
    { key: 'concentricRings', label: 'Concentric Rings', isToggle: true, elementId: 'btnToggleReticleRings' },
    { key: 'strokeWidth', label: 'Stroke Weight', min: 0.6, max: 5.0, step: 0.2, isFloat: true, elementId: 'sliderReticleStroke' }
  ];

  let focusedIndex = 0;
  let menuFocusActive = false;
  let toastTimeout = null;

  function showReticleToast(text, activePillKey = null) {
    const toastEl = document.getElementById('reticleGamepadToast');
    const textEl = document.getElementById('reticleToastText');
    if (toastEl && textEl) {
      textEl.textContent = text;
      toastEl.classList.remove('hidden');
      toastEl.style.opacity = '1';
      clearTimeout(toastTimeout);
      toastTimeout = setTimeout(() => {
        toastEl.style.opacity = '0';
        setTimeout(() => toastEl.classList.add('hidden'), 250);
      }, 1800);
    }
    if (activePillKey) {
      const pill = document.querySelector(`.gp-leg-pill[data-leg="${activePillKey}"]`);
      if (pill) {
        pill.classList.add('active');
        setTimeout(() => pill.classList.remove('active'), 250);
      }
    }
  }

  function updateReticleControlHighlight() {
    RETICLE_CONTROLS.forEach((c, idx) => {
      const el = document.getElementById(c.elementId);
      const container = el ? (el.closest('.slider-group') || el) : null;
      if (container) {
        container.classList.toggle('reticle-gp-focused', menuFocusActive && idx === focusedIndex);
        if (menuFocusActive && idx === focusedIndex) {
          container.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        }
      }
    });
  }

  // Attach gamepad interface methods to window for clean cross-module invocation
  window.reticleGamepadAPI = {
    showToast: (text, activePillKey = null) => {
      showReticleToast(text, activePillKey);
    },
    isFocusedOnMenu: () => menuFocusActive,
    initFocus: () => {
      menuFocusActive = true;
      updateReticleControlHighlight();
    },
    cycleFocus: (delta) => {
      menuFocusActive = true;
      focusedIndex = (focusedIndex + delta + RETICLE_CONTROLS.length) % RETICLE_CONTROLS.length;
      updateReticleControlHighlight();
      return RETICLE_CONTROLS[focusedIndex];
    },
    adjust: (delta) => {
      menuFocusActive = true;
      updateReticleControlHighlight();
      const ctrl = RETICLE_CONTROLS[focusedIndex];
      if (!ctrl) return 'UNKNOWN';
      const cfg = appState.reticleConfig || {};

      if (ctrl.isToggle) {
        const nextVal = !cfg[ctrl.key];
        updateReticleConfig({ [ctrl.key]: nextVal });
        return `${ctrl.label.toUpperCase()}: ${nextVal ? 'ON' : 'OFF'}`;
      } else {
        const cur = Number(cfg[ctrl.key] ?? (ctrl.key === 'majorInterval' ? 5 : 10));
        let nextVal = cur + delta * ctrl.step;
        nextVal = Math.max(ctrl.min, Math.min(ctrl.max, nextVal));
        if (ctrl.isFloat) {
          nextVal = Math.round(nextVal * 10) / 10;
        } else {
          nextVal = Math.round(nextVal);
        }
        updateReticleConfig({ [ctrl.key]: nextVal });
        return `${ctrl.label.toUpperCase()}: ${nextVal}${ctrl.isFloat ? 'px' : ''}`;
      }
    },
    activate: () => {
      menuFocusActive = true;
      updateReticleControlHighlight();
      const ctrl = RETICLE_CONTROLS[focusedIndex];
      if (!ctrl) return 'READY';
      if (ctrl.isToggle) {
        return window.reticleGamepadAPI.adjust(1);
      } else {
        const testClicks = Math.min(3, appState.reticleConfig?.clickCount || 10);
        const prefix = (appState.voiceAlertKeyword || 'Detection').trim();
        const unit = (appState.voiceUnitKeyword || (testClicks === 1 ? 'click' : 'clicks')).trim();
        const phrase = `${prefix}! 11 o'clock, ${testClicks} ${unit}`;
        if (calloutTestText) calloutTestText.textContent = `🔊 "${phrase}"`;
        speakDetectionAnnouncement(phrase);
        return `AUDITION: "${phrase}"`;
      }
    },
    quickAdjustClicks: (delta) => {
      const cfg = appState.reticleConfig || {};
      const next = Math.max(2, Math.min(25, (cfg.clickCount || 10) + delta));
      updateReticleConfig({ clickCount: next });
      return `CLICKS PER ARM: ${next}`;
    },
    quickAdjustSpacing: (delta) => {
      const cfg = appState.reticleConfig || {};
      const next = Math.max(10, Math.min(80, (cfg.clickSpacing || 32) + delta));
      updateReticleConfig({ clickSpacing: next });
      return `CLICK SPACING: ${next}px`;
    },
    quickAdjustGap: (delta) => {
      const cfg = appState.reticleConfig || {};
      const next = Math.max(0, Math.min(140, (cfg.centerGap ?? 64) + delta));
      updateReticleConfig({ centerGap: next });
      return `CENTER GAP: ${next}px`;
    },
    quickAdjustStroke: (delta) => {
      const cfg = appState.reticleConfig || {};
      const cur = Number(cfg.strokeWidth || 1.8);
      const next = Math.max(0.6, Math.min(5.0, Math.round((cur + delta) * 10) / 10));
      updateReticleConfig({ strokeWidth: next });
      return `STROKE WEIGHT: ${next.toFixed(1)}px`;
    }
  };

  // Navigation
  btnReticleBackToLive?.addEventListener('click', () => {
    screenReticle?.classList.add('hidden');
    screenLive?.classList.remove('hidden');
    updateState({ currentScreen: 'live', replayActive: false });
  });

  btnReticleToSettings?.addEventListener('click', () => {
    screenReticle?.classList.add('hidden');
    screenSettings?.classList.remove('hidden');
    updateState({ currentScreen: 'settings', replayActive: false });
  });

  // Reset reticle defaults
  btnResetReticle?.addEventListener('click', () => {
    updateReticleConfig({
      clickCount: 10,
      clickSpacing: 32,
      centerGap: 64,
      innerBrackets: true,
      majorInterval: 5,
      minorTickLen: 10,
      majorTickLen: 18,
      showLabels: true,
      concentricRings: false,
      ringInterval: 5,
      strokeWidth: 1.8,
      reticleColor: ''
    });
  });

  // Slider & Toggle Event Listeners
  sliderClicks?.addEventListener('input', (e) => {
    updateReticleConfig({ clickCount: Number(e.target.value) || 10 });
  });

  sliderSpacing?.addEventListener('input', (e) => {
    updateReticleConfig({ clickSpacing: Number(e.target.value) || 32 });
  });

  sliderGap?.addEventListener('input', (e) => {
    updateReticleConfig({ centerGap: Number(e.target.value) || 0 });
  });

  btnBrackets?.addEventListener('click', () => {
    updateReticleConfig({ innerBrackets: !appState.reticleConfig.innerBrackets });
  });

  sliderMajor?.addEventListener('input', (e) => {
    updateReticleConfig({ majorInterval: Number(e.target.value) || 0 });
  });

  btnLabels?.addEventListener('click', () => {
    updateReticleConfig({ showLabels: !appState.reticleConfig.showLabels });
  });

  btnRings?.addEventListener('click', () => {
    updateReticleConfig({ concentricRings: !appState.reticleConfig.concentricRings });
  });

  sliderStroke?.addEventListener('input', (e) => {
    updateReticleConfig({ strokeWidth: Number(e.target.value) || 1.8 });
  });

  // Test Speech Announcement button
  btnTestCallout?.addEventListener('click', () => {
    const testClicks = Math.min(3, appState.reticleConfig?.clickCount || 10);
    const prefix = (appState.voiceAlertKeyword || 'Detection').trim();
    const unit = (appState.voiceUnitKeyword || (testClicks === 1 ? 'click' : 'clicks')).trim();
    const testPhrase = `${prefix}! 11 o'clock, ${testClicks} ${unit}`;
    if (calloutTestText) calloutTestText.textContent = `🔊 "${testPhrase}"`;
    speakDetectionAnnouncement(testPhrase);
  });

  // Interactive Click on the Preview Stage to test arbitrary angle & clicks
  previewStage?.addEventListener('pointerdown', (e) => {
    if (!previewSvg) return;
    const stageRect = previewStage.getBoundingClientRect();
    const svgRect = previewSvg.getBoundingClientRect();

    // The center of the reticle (400, 250 in 800x500 viewBox) corresponds to center of svgRect
    const centerX = svgRect.left + svgRect.width / 2;
    const centerY = svgRect.top + svgRect.height / 2;

    const dx = e.clientX - centerX;
    const dy = e.clientY - centerY;
    const distPx = Math.hypot(dx, dy);

    // Compute click distance on the preview stage (scaled to 800x500 viewBox)
    const baseScale = Math.min(svgRect.width / RETICLE_VIEWBOX_W, svgRect.height / RETICLE_VIEWBOX_H);
    const clickSpacingPx = Math.max(8, Number(appState.reticleConfig?.clickSpacing) || 32) * baseScale;
    const gapHalfPx = Math.max(0, (Number(appState.reticleConfig?.centerGap) || 64) / 2) * baseScale;

    let clicks = 0;
    if (distPx > gapHalfPx + clickSpacingPx * 0.35) {
      clicks = Math.max(1, Math.round((distPx - gapHalfPx) / Math.max(1, clickSpacingPx)));
    }

    const angleDeg = ((Math.atan2(dx, -dy) * 180 / Math.PI) + 360) % 360;
    let clockHour = Math.round(angleDeg / 30);
    if (clockHour === 0) clockHour = 12;

    const prefix = (appState.voiceAlertKeyword || 'Detection').trim();
    let rawUnit = (appState.voiceUnitKeyword || 'clicks').trim();
    let unitWord = rawUnit;
    if (clicks === 1 && rawUnit.toLowerCase() === 'clicks') unitWord = 'click';

    const phrase = clicks === 0 ? `${prefix}! Center` : `${prefix}! ${clockHour} o'clock, ${clicks} ${unitWord}`;

    if (calloutTestText) {
      calloutTestText.textContent = `🔊 "${phrase}"`;
    }
    speakDetectionAnnouncement(phrase);

    // Draw temporary animated ping dot at click location
    const pingDot = document.createElement('div');
    pingDot.className = 'reticle-test-ping';
    pingDot.style.left = `${e.clientX - stageRect.left}px`;
    pingDot.style.top = `${e.clientY - stageRect.top}px`;
    previewStage.appendChild(pingDot);
    setTimeout(() => pingDot.remove(), 1200);
  });

  let wasOnReticle = false;
  subscribeState(() => {
    if (appState.currentScreen === 'reticle') {
      renderPreview();
      if (!wasOnReticle) {
        wasOnReticle = true;
        window.reticleGamepadAPI?.initFocus();
      }
    } else {
      wasOnReticle = false;
    }
  });

  renderPreview();
}
