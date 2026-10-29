/**
 * Superimpose Guide Overlays
 * Simplified to:
 * 1. Open-Center Graduated Crosshair (with 64px open center gap and uniform
 *    horizontal & vertical tick marks for distance callouts)
 * 2. Custom User-Loaded Image (PNG/SVG/WebP)
 */
import { appState, subscribeState } from '../state.js';

// Each tick mark along the horizontal and vertical crosshair arms is spaced
// by 32 SVG viewBox units from the center (400, 250).
// Tick 1 is at the inner gap bracket (32 units from center).
export const CROSSHAIR_VIEWBOX_W = 800;
export const CROSSHAIR_VIEWBOX_H = 500;
export const CROSSHAIR_TICK_SVG_UNITS = 32;

/**
 * Returns the exact on-screen pixel distance of 1 crosshair tick,
 * dynamically accounting for viewport dimensions and Guide Scale (25%..200%).
 */
export function getCrosshairTickPixelSize(viewportW, viewportH, overlayScalePercent = 100) {
  const baseUnitPx = Math.min(
    Math.max(1, viewportW) / CROSSHAIR_VIEWBOX_W,
    Math.max(1, viewportH) / CROSSHAIR_VIEWBOX_H
  );
  const scaleFactor = Math.max(0.1, (Number(overlayScalePercent) || 100) / 100);
  return CROSSHAIR_TICK_SVG_UNITS * baseUnitPx * scaleFactor;
}

function buildGraduatedCrosshairSvg() {
  const cx = 400;
  const cy = 250;
  const step = CROSSHAIR_TICK_SVG_UNITS; // 32 units per tick
  const lines = [];

  // Horizontal arms with 64px open center gap (368..432, i.e. ±1 tick)
  // Left arm: 80..368 (Ticks 1..10), Right arm: 432..720 (Ticks 1..10)
  lines.push(
    `<line x1="80" y1="${cy}" x2="368" y2="${cy}" stroke="var(--radar-accent)" stroke-width="1.8" />`,
    `<line x1="432" y1="${cy}" x2="720" y2="${cy}" stroke="var(--radar-accent)" stroke-width="1.8" />`
  );

  // Vertical arms with 64px open center gap (218..282, i.e. ±1 tick)
  // Top arm: 26..218 (Ticks 1..7), Bottom arm: 282..474 (Ticks 1..7)
  lines.push(
    `<line x1="${cx}" y1="26" x2="${cx}" y2="218" stroke="var(--radar-accent)" stroke-width="1.8" />`,
    `<line x1="${cx}" y1="282" x2="${cx}" y2="474" stroke="var(--radar-accent)" stroke-width="1.8" />`
  );

  // Horizontal Tick Marks (Ticks 1 to 10 on Left & Right arms)
  for (let t = 1; t <= 10; t++) {
    const offset = t * step;
    const isMajor = t === 1 || t % 5 === 0;
    const halfLen = isMajor ? 9 : 5;
    const sw = isMajor ? '1.8' : '1.4';
    const xLeft = cx - offset;
    const xRight = cx + offset;

    lines.push(
      `<line x1="${xLeft}" y1="${cy - halfLen}" x2="${xLeft}" y2="${cy + halfLen}" stroke="var(--radar-accent)" stroke-width="${sw}" />`,
      `<line x1="${xRight}" y1="${cy - halfLen}" x2="${xRight}" y2="${cy + halfLen}" stroke="var(--radar-accent)" stroke-width="${sw}" />`
    );
  }

  // Vertical Tick Marks (Ticks 1 to 7 on Top & Bottom arms)
  for (let t = 1; t <= 7; t++) {
    const offset = t * step;
    const isMajor = t === 1 || t % 5 === 0;
    const halfLen = isMajor ? 9 : 5;
    const sw = isMajor ? '1.8' : '1.4';
    const yTop = cy - offset;
    const yBottom = cy + offset;

    lines.push(
      `<line x1="${cx - halfLen}" y1="${yTop}" x2="${cx + halfLen}" y2="${yTop}" stroke="var(--radar-accent)" stroke-width="${sw}" />`,
      `<line x1="${cx - halfLen}" y1="${yBottom}" x2="${cx + halfLen}" y2="${yBottom}" stroke="var(--radar-accent)" stroke-width="${sw}" />`
    );
  }

  return lines.join('\n');
}

export function initOverlayManager() {
  const overlayLayer = document.getElementById('overlayLayer');
  const svgOverlay = document.getElementById('svgOverlay');
  const customImg = document.getElementById('customOverlayImg');

  svgOverlay.innerHTML = buildGraduatedCrosshairSvg();

  function renderOverlay(state) {
    overlayLayer.classList.toggle('hidden', !state.overlayEnabled);
    overlayLayer.style.opacity = String(state.overlayOpacity / 100);
    const scaleVal = state.overlayScale / 100;
    svgOverlay.style.transform = `scale(${scaleVal})`;
    customImg.style.transform = `scale(${scaleVal})`;

    if (state.overlayType === 'custom' && state.customOverlayUrl) {
      svgOverlay.classList.add('hidden');
      customImg.classList.remove('hidden');
      if (customImg.src !== state.customOverlayUrl) {
        customImg.src = state.customOverlayUrl;
      }
    } else {
      customImg.classList.add('hidden');
      svgOverlay.classList.remove('hidden');
    }
  }

  renderOverlay(appState);
  subscribeState(renderOverlay);
}
