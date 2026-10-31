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

  // Navigation
  btnReticleBackToLive?.addEventListener('click', () => {
    screenReticle?.classList.add('hidden');
    screenLive?.classList.remove('hidden');
    updateState({ currentScreen: 'live' });
  });

  btnReticleToSettings?.addEventListener('click', () => {
    screenReticle?.classList.add('hidden');
    screenSettings?.classList.remove('hidden');
    updateState({ currentScreen: 'settings' });
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
    const testPhrase = `Detection! 11 o'clock, ${testClicks} ${testClicks === 1 ? 'click' : 'clicks'}`;
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

    const clickWord = clicks === 1 ? 'click' : 'clicks';
    const phrase = clicks === 0 ? 'Detection! Center' : `Detection! ${clockHour} o'clock, ${clicks} ${clickWord}`;

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

  subscribeState(() => {
    if (appState.currentScreen === 'reticle') {
      renderPreview();
    }
  });

  renderPreview();
}
