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
  const previewImg = document.getElementById('reticlePreviewImg');
  const previewStage = document.getElementById('reticlePreviewStage');
  const calloutTestText = document.getElementById('calloutTestText');

  // Card 1: Overlay Master & Optics inputs
  const btnToggleOverlay = document.getElementById('btnToggleOverlay');
  const btnToggleReticleFfp = document.getElementById('btnToggleReticleFfp');
  const sliderOvOpacity = document.getElementById('sliderOvOpacity');
  const valOvOpacity = document.getElementById('valOvOpacity');
  const sliderOvScale = document.getElementById('sliderOvScale');
  const valOvScale = document.getElementById('valOvScale');

  // Control inputs
  const sliderClicks = document.getElementById('sliderReticleClicks');
  const valClicks = document.getElementById('valReticleClicks');
  const sliderSpacing = document.getElementById('sliderReticleSpacing');
  const valSpacing = document.getElementById('valReticleSpacing');
  const sliderGap = document.getElementById('sliderReticleGap');
  const valGap = document.getElementById('valReticleGap');
  const valCenter = document.getElementById('valReticleCenter');
  const centerBtns = document.querySelectorAll('.center-style-btn');
  const btnBrackets = document.getElementById('btnToggleReticleBrackets');
  const sliderMajor = document.getElementById('sliderReticleMajor');
  const valMajor = document.getElementById('valReticleMajor');
  const btnLabels = document.getElementById('btnToggleReticleLabels');
  const btnRings = document.getElementById('btnToggleReticleRings');
  const sliderStroke = document.getElementById('sliderReticleStroke');
  const valStroke = document.getElementById('valReticleStroke');

  function renderPreview() {
    const cfg = appState.reticleConfig || {};
    const op = (appState.overlayOpacity ?? 75) / 100;
    const sc = (appState.overlayScale ?? 100) / 100;

    if (appState.overlayType === 'custom' && appState.customOverlayUrl && previewImg) {
      if (previewSvg) previewSvg.classList.add('hidden');
      previewImg.classList.remove('hidden');
      if (previewImg.src !== appState.customOverlayUrl) {
        previewImg.src = appState.customOverlayUrl;
      }
      previewImg.style.opacity = String(op);
      previewImg.style.transform = `scale(${sc})`;
    } else {
      if (previewImg) previewImg.classList.add('hidden');
      if (previewSvg) {
        previewSvg.classList.remove('hidden');
        previewSvg.setAttribute('viewBox', `0 0 ${RETICLE_VIEWBOX_W} ${RETICLE_VIEWBOX_H}`);
        previewSvg.setAttribute('preserveAspectRatio', 'xMidYMid meet');
        previewSvg.style.opacity = String(op);
        previewSvg.style.transform = `scale(${sc})`;
        previewSvg.innerHTML = buildGraduatedCrosshairSvg(cfg);
      }
    }

    // Sync Card 1 (Overlay & Optics)
    if (btnToggleOverlay) {
      btnToggleOverlay.textContent = appState.overlayEnabled ? 'ON' : 'OFF';
      btnToggleOverlay.classList.toggle('radar-btn-active', Boolean(appState.overlayEnabled));
    }
    if (btnToggleReticleFfp) {
      const ffp = appState.reticleFfpMode !== false;
      btnToggleReticleFfp.textContent = ffp ? 'FFP: ON' : 'FFP: OFF';
      btnToggleReticleFfp.classList.toggle('radar-btn-active', ffp);
    }
    if (sliderOvOpacity && valOvOpacity) {
      sliderOvOpacity.value = String(appState.overlayOpacity ?? 75);
      valOvOpacity.textContent = `${appState.overlayOpacity ?? 75}%`;
    }
    if (sliderOvScale && valOvScale) {
      sliderOvScale.value = String(appState.overlayScale ?? 100);
      valOvScale.textContent = `${appState.overlayScale ?? 100}%`;
    }
    document.querySelectorAll('.ov-btn').forEach(b => {
      b.classList.toggle('radar-btn-active', b.dataset.ov === (appState.overlayType || 'crosshair'));
    });

    const clicks = Math.max(2, Math.min(30, Number(cfg.clickCount) || 10));
    const maxFittingStep = Math.max(8, Math.floor(240 / clicks));
    const rawStep = Number(cfg.clickSpacing);
    const effStep = (!rawStep || rawStep > maxFittingStep) ? maxFittingStep : Math.max(6, rawStep);

    // Sync input values
    if (sliderClicks && valClicks) {
      sliderClicks.value = String(clicks);
      valClicks.textContent = `${clicks} clicks`;
    }
    if (sliderSpacing && valSpacing) {
      sliderSpacing.value = String(effStep);
      valSpacing.textContent = `${effStep} px`;
    }
    if (sliderGap && valGap) {
      sliderGap.value = String(cfg.centerGap ?? 64);
      valGap.textContent = `${cfg.centerGap ?? 64} px`;
    }
    const activeCenter = String(cfg.centerStyle || 'empty').toLowerCase();
    if (valCenter) {
      valCenter.textContent = activeCenter.toUpperCase();
    }
    document.querySelectorAll('.center-style-btn').forEach(btn => {
      const isSel = (btn.dataset.center || '').toLowerCase() === activeCenter;
      btn.classList.toggle('radar-btn-active', isSel);
    });
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
    { key: 'overlayEnabled', label: 'Overlay Guide', isToggle: true, isRoot: true, elementId: 'btnToggleOverlay' },
    { key: 'reticleFfpMode', label: 'FFP Zoom Lock', isToggle: true, isRoot: true, elementId: 'btnToggleReticleFfp' },
    { key: 'overlayOpacity', label: 'Overlay Opacity', min: 10, max: 100, step: 5, isRoot: true, elementId: 'sliderOvOpacity' },
    { key: 'overlayScale', label: 'Reticle Scale', min: 25, max: 200, step: 5, isRoot: true, elementId: 'sliderOvScale' },
    { key: 'clickCount', label: 'Clicks Per Arm', min: 2, max: 30, step: 1, elementId: 'sliderReticleClicks' },
    { key: 'clickSpacing', label: 'Click Spacing', min: 8, max: 100, step: 1, elementId: 'sliderReticleSpacing' },
    { key: 'centerGap', label: 'Center Gap', min: 0, max: 140, step: 1, elementId: 'sliderReticleGap' },
    { key: 'centerStyle', label: 'Center Point', isOption: true, options: ['empty', 'dot', 'cross', 'chevron'], elementId: 'valReticleCenter' },
    { key: 'innerBrackets', label: 'Center Brackets', isToggle: true, elementId: 'btnToggleReticleBrackets' },
    { key: 'majorInterval', label: 'Major Tick Interval', min: 0, max: 10, step: 1, elementId: 'sliderReticleMajor' },
    { key: 'showLabels', label: 'Number Labels', isToggle: true, elementId: 'btnToggleReticleLabels' },
    { key: 'concentricRings', label: 'Concentric Rings', isToggle: true, elementId: 'btnToggleReticleRings' },
    { key: 'strokeWidth', label: 'Stroke Weight', min: 0.5, max: 5.0, step: 0.1, isFloat: true, elementId: 'sliderReticleStroke' }
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

      if (ctrl.isRoot) {
        if (ctrl.isToggle) {
          const nextVal = !appState[ctrl.key];
          updateState({ [ctrl.key]: nextVal });
          saveSettings(appState);
          renderPreview();
          return `${ctrl.label.toUpperCase()}: ${nextVal ? 'ON' : 'OFF'}`;
        } else {
          const cur = Number(appState[ctrl.key] ?? (ctrl.key === 'overlayOpacity' ? 75 : 100));
          let nextVal = cur + delta * ctrl.step;
          nextVal = Math.max(ctrl.min, Math.min(ctrl.max, nextVal));
          updateState({ [ctrl.key]: nextVal });
          saveSettings(appState);
          renderPreview();
          return `${ctrl.label.toUpperCase()}: ${nextVal}%`;
        }
      }

      if (ctrl.isToggle) {
        const nextVal = !cfg[ctrl.key];
        updateReticleConfig({ [ctrl.key]: nextVal });
        return `${ctrl.label.toUpperCase()}: ${nextVal ? 'ON' : 'OFF'}`;
      } else if (ctrl.isOption) {
        const curOpt = (cfg[ctrl.key] || ctrl.options[0]).toLowerCase();
        let idx = ctrl.options.indexOf(curOpt);
        if (idx === -1) idx = 0;
        idx = (idx + delta + ctrl.options.length) % ctrl.options.length;
        const nextOpt = ctrl.options[idx];
        updateReticleConfig({ [ctrl.key]: nextOpt });
        return `${ctrl.label.toUpperCase()}: ${nextOpt.toUpperCase()}`;
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
      if (ctrl.isToggle || ctrl.isOption) {
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
      const next = Math.max(2, Math.min(30, (cfg.clickCount || 10) + delta));
      const maxFittingStep = Math.max(8, Math.floor(240 / next));
      const nextStep = Math.min(cfg.clickSpacing || maxFittingStep, maxFittingStep);
      updateReticleConfig({ clickCount: next, clickSpacing: nextStep });
      return `CLICKS PER ARM: ${next}`;
    },
    quickAdjustSpacing: (delta) => {
      const cfg = appState.reticleConfig || {};
      const next = Math.max(4, Math.min(100, (cfg.clickSpacing || 8) + delta));
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
      const next = Math.max(0.5, Math.min(5.0, Math.round((cur + delta) * 10) / 10));
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
      centerStyle: 'empty',
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

  // Delegated Center Style Button Listener (guarantees instant, 100% reliable clicks across all screens)
  document.addEventListener('click', (e) => {
    const btn = e.target.closest('.center-style-btn');
    if (!btn) return;
    const style = (btn.dataset.center || '').toLowerCase();
    if (!style) return;
    updateReticleConfig({ centerStyle: style });
  });

  // Slider & Toggle Event Listeners
  sliderClicks?.addEventListener('input', (e) => {
    const nextClicks = Number(e.target.value) || 10;
    const maxFittingStep = Math.max(8, Math.floor(240 / nextClicks));
    const nextStep = Math.min(appState.reticleConfig?.clickSpacing || maxFittingStep, maxFittingStep);
    updateReticleConfig({ clickCount: nextClicks, clickSpacing: nextStep });
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

    // Clicks are calculated strictly from optical dead-center
    let clicks = 0;
    if (distPx >= clickSpacingPx * 0.4) {
      clicks = Math.max(1, Math.round(distPx / Math.max(1, clickSpacingPx)));
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
  window.__reticleScreenReady = true;
}
