/**
 * Superimpose Guide Overlays
 * Simplified to:
 * 1. Open-Center Crosshair (gap in the middle so the point of interest is unobstructed)
 * 2. Custom User-Loaded Image (PNG/SVG/WebP)
 */
import { appState, subscribeState } from '../state.js';

const OPEN_CENTER_CROSSHAIR_SVG = `
  <!-- Horizontal arms with a 64px open gap in the center (368..432) -->
  <line x1="60" y1="250" x2="368" y2="250" stroke="var(--radar-accent)" stroke-width="1.8" />
  <line x1="432" y1="250" x2="740" y2="250" stroke="var(--radar-accent)" stroke-width="1.8" />

  <!-- Vertical arms with a 64px open gap in the center (218..282) -->
  <line x1="400" y1="25" x2="400" y2="218" stroke="var(--radar-accent)" stroke-width="1.8" />
  <line x1="400" y1="282" x2="400" y2="475" stroke="var(--radar-accent)" stroke-width="1.8" />

  <!-- Inner gap bracket ticks marking the open inspection window -->
  <line x1="368" y1="242" x2="368" y2="258" stroke="var(--radar-accent)" stroke-width="1.8" />
  <line x1="432" y1="242" x2="432" y2="258" stroke="var(--radar-accent)" stroke-width="1.8" />
  <line x1="392" y1="218" x2="408" y2="218" stroke="var(--radar-accent)" stroke-width="1.8" />
  <line x1="392" y1="282" x2="408" y2="282" stroke="var(--radar-accent)" stroke-width="1.8" />

  <!-- Outer reference circle well outside the center gap -->
  <circle cx="400" cy="250" r="76" stroke="var(--radar-accent)" stroke-width="1.4" stroke-dasharray="8 6" fill="none" />
`;

export function initOverlayManager() {
  const overlayLayer = document.getElementById('overlayLayer');
  const svgOverlay = document.getElementById('svgOverlay');
  const customImg = document.getElementById('customOverlayImg');

  svgOverlay.innerHTML = OPEN_CENTER_CROSSHAIR_SVG;

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
