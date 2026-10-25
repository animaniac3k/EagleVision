/**
 * Superimpose Guide Overlays (Preset Vector Reticles + Custom Image Upload)
 * Uses CSS variables (--radar-accent, --radar-text) so overlays adapt to the chosen Interface Color.
 */
import { appState, subscribeState } from '../state.js';

const PRESET_SVGS = {
  crosshair: `
    <line x1="400" y1="0" x2="400" y2="500" stroke="var(--radar-accent)" stroke-width="1.5" stroke-dasharray="10 6" />
    <line x1="0" y1="250" x2="800" y2="250" stroke="var(--radar-accent)" stroke-width="1.5" stroke-dasharray="10 6" />
    <circle cx="400" cy="250" r="55" stroke="var(--radar-accent)" stroke-width="1.5" fill="none" />
    <circle cx="400" cy="250" r="4" fill="var(--radar-text)" />
  `,
  grid: `
    <line x1="266.6" y1="0" x2="266.6" y2="500" stroke="var(--radar-accent)" stroke-width="1.3" />
    <line x1="533.3" y1="0" x2="533.3" y2="500" stroke="var(--radar-accent)" stroke-width="1.3" />
    <line x1="0" y1="166.6" x2="800" y2="166.6" stroke="var(--radar-accent)" stroke-width="1.3" />
    <line x1="0" y1="333.3" x2="800" y2="333.3" stroke="var(--radar-accent)" stroke-width="1.3" />
    <rect x="120" y="75" width="560" height="350" stroke="var(--radar-text-muted)" stroke-width="1.2" stroke-dasharray="8 6" fill="none" />
  `,
  rings: `
    <circle cx="400" cy="250" r="35" stroke="var(--radar-accent)" stroke-width="1.5" fill="none" />
    <circle cx="400" cy="250" r="85" stroke="var(--radar-accent)" stroke-width="1.5" fill="none" />
    <circle cx="400" cy="250" r="145" stroke="var(--radar-accent)" stroke-width="1.5" fill="none" />
    <circle cx="400" cy="250" r="205" stroke="var(--radar-accent)" stroke-width="1.2" stroke-dasharray="8 6" fill="none" />
    <line x1="360" y1="250" x2="440" y2="250" stroke="var(--radar-text-muted)" stroke-width="1.5" />
    <line x1="400" y1="210" x2="400" y2="290" stroke="var(--radar-text-muted)" stroke-width="1.5" />
  `
};

export function initOverlayManager() {
  const overlayLayer = document.getElementById('overlayLayer');
  const svgOverlay = document.getElementById('svgOverlay');
  const customImg = document.getElementById('customOverlayImg');

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
      const markup = PRESET_SVGS[state.overlayType] || PRESET_SVGS.crosshair;
      if (svgOverlay.dataset.activeType !== state.overlayType) {
        svgOverlay.innerHTML = markup;
        svgOverlay.dataset.activeType = state.overlayType;
      }
    }
  }

  renderOverlay(appState);
  subscribeState(renderOverlay);
}
