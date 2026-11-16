/**
 * Superimpose Guide Overlays
 *
 * Supports:
 * 1. Fully Customizable Graduated Reticle / Crosshair (with indents/clicks along
 *    horizontal & vertical arms, center gap, click numbers, and optional concentric rings)
 * 2. Custom User-Loaded Image (PNG/SVG/WebP)
 */
import { appState, subscribeState } from '../state.js';

export const RETICLE_VIEWBOX_W = 800;
export const RETICLE_VIEWBOX_H = 500;

const reticleMarkupCache = new WeakMap();

/**
 * Returns the exact on-screen pixel distance of 1 reticle click / indent,
 * dynamically taking into account viewport dimensions and Guide Scale (25%..200%).
 */
export function getClickDistanceInPixels(viewportW, viewportH, overlayScalePercent = 100) {
  const cfg = appState.reticleConfig || {};
  const clicks = Math.max(2, Math.min(30, Number(cfg.clickCount) || 10));
  const defaultFittingStep = Math.max(8, Math.floor(240 / clicks));
  const rawStep = Number(cfg.clickSpacing);
  const clickSpacingSvgUnits = Number.isFinite(rawStep) && rawStep >= 4 ? rawStep : defaultFittingStep;

  // SVG viewBox is 800x500 with preserveAspectRatio="xMidYMid meet"
  const baseScale = Math.min(
    Math.max(1, viewportW) / RETICLE_VIEWBOX_W,
    Math.max(1, viewportH) / RETICLE_VIEWBOX_H
  );

  // First Focal Plane (FFP): scales spacing proportionally with whole-image digital zoom
  const ffpFactor = appState.reticleFfpMode ? Math.max(1.0, Number(appState.mainZoom) || 1.0) : 1.0;
  const scaleMultiplier = Math.max(0.1, (Number(overlayScalePercent) || 100) / 100) * ffpFactor;
  return clickSpacingSvgUnits * baseScale * scaleMultiplier;
}

/**
 * Returns the on-screen pixel distance from reticle center to the edge of the center gap.
 */
export function getCenterGapDistanceInPixels(viewportW, viewportH, overlayScalePercent = 100) {
  const cfg = appState.reticleConfig || {};
  const clicks = Math.max(2, Math.min(30, Number(cfg.clickCount) || 10));
  const defaultFittingStep = Math.max(8, Math.floor(240 / clicks));
  const rawStep = Number(cfg.clickSpacing);
  const step = Number.isFinite(rawStep) && rawStep >= 4 ? rawStep : defaultFittingStep;
  const rawGapHalf = Math.max(0, (Number(cfg.centerGap) ?? 64) / 2);
  const gapHalfSvgUnits = Math.min(rawGapHalf, 360);

  const baseScale = Math.min(
    Math.max(1, viewportW) / RETICLE_VIEWBOX_W,
    Math.max(1, viewportH) / RETICLE_VIEWBOX_H
  );

  const ffpFactor = appState.reticleFfpMode ? Math.max(1.0, Number(appState.mainZoom) || 1.0) : 1.0;
  const scaleMultiplier = Math.max(0.1, (Number(overlayScalePercent) || 100) / 100) * ffpFactor;
  return gapHalfSvgUnits * baseScale * scaleMultiplier;
}

/**
 * Builds the complete SVG markup for the customizable graduated reticle.
 * Can be rendered on the main feed (#svgOverlay), Playback, Hits, or Reticle Customizer preview stage.
 */
export function buildGraduatedCrosshairSvg(customConfig = null) {
  const cfg = Object.assign(
    {
      clickCount: 10,
      clickSpacing: 32,
      centerGap: 64,
      centerStyle: 'empty', // 'empty' | 'dot' | 'cross' | 'chevron'
      majorInterval: 5,
      minorTickLen: 10,
      majorTickLen: 18,
      showLabels: true,
      concentricRings: false,
      ringInterval: 5,
      strokeWidth: 1.8,
      reticleColor: ''
    },
    appState.reticleConfig || {},
    customConfig || {}
  );

  const cx = RETICLE_VIEWBOX_W / 2; // 400
  const cy = RETICLE_VIEWBOX_H / 2; // 250
  const clicks = Math.max(2, Math.min(30, Number(cfg.clickCount) || 10));
  // Guarantee all configured clicks (up to 30) fit cleanly inside the 500-unit vertical view (240 units from center)
  const defaultFittingStep = Math.max(8, Math.floor(240 / clicks));
  const rawStep = Number(cfg.clickSpacing);
  const step = Number.isFinite(rawStep) && rawStep >= 4 ? rawStep : defaultFittingStep;
  const rawGapHalf = Math.max(0, (Number(cfg.centerGap) ?? 64) / 2);
  const gapHalf = Math.min(rawGapHalf, 360);
  const sw = Number(cfg.strokeWidth) || 1.8;
  const strokeColor = cfg.reticleColor ? cfg.reticleColor : 'var(--radar-accent)';
  const majorInt = Math.max(0, Number(cfg.majorInterval) || 5);
  const minorLen = Math.min(Math.max(3, Number(cfg.minorTickLen) || 10), Math.max(5, step * 0.9));
  const majorLen = Math.min(Math.max(6, Number(cfg.majorTickLen) || 18), Math.max(8, step * 1.6));
  const showLabels = Boolean(cfg.showLabels);

  const lines = [];
  const armLen = clicks * step;
  const maxArmOffset = Math.max(gapHalf + 10, armLen, 380);

  // Center Aiming Point: 'empty' | 'dot' | 'cross' | 'chevron'
  const centerStyle = String(cfg.centerStyle || 'empty').toLowerCase();
  if (centerStyle === 'dot') {
    const dotR = Math.max(0.75, sw * 0.6);
    lines.push(
      `<circle cx="${cx}" cy="${cy}" r="${dotR.toFixed(2)}" fill="${strokeColor}" />`
    );
  } else if (centerStyle === 'cross') {
    const crossLen = gapHalf > 0 ? Math.min(12, Math.max(6, gapHalf * 0.45)) : 8;
    lines.push(
      `<line x1="${(cx - crossLen).toFixed(1)}" y1="${cy}" x2="${(cx + crossLen).toFixed(1)}" y2="${cy}" stroke="${strokeColor}" stroke-width="${sw}" />`,
      `<line x1="${cx}" y1="${(cy - crossLen).toFixed(1)}" x2="${cx}" y2="${(cy + crossLen).toFixed(1)}" stroke="${strokeColor}" stroke-width="${sw}" />`
    );
  } else if (centerStyle === 'chevron') {
    const chW = 8;
    const chH = 10;
    lines.push(
      `<path d="M ${(cx - chW).toFixed(1)} ${(cy + chH).toFixed(1)} L ${cx} ${cy} L ${(cx + chW).toFixed(1)} ${(cy + chH).toFixed(1)}" fill="none" stroke="${strokeColor}" stroke-width="${sw}" stroke-linecap="round" stroke-linejoin="miter" />`
    );
  }

  // Main Arms - Horizontal
  const xArmStart = cx - maxArmOffset;
  const xArmEnd = cx + maxArmOffset;
  if (gapHalf > 0) {
    lines.push(
      `<line x1="${xArmStart}" y1="${cy}" x2="${cx - gapHalf}" y2="${cy}" stroke="${strokeColor}" stroke-width="${sw}" />`,
      `<line x1="${cx + gapHalf}" y1="${cy}" x2="${xArmEnd}" y2="${cy}" stroke="${strokeColor}" stroke-width="${sw}" />`
    );
  } else {
    lines.push(
      `<line x1="${xArmStart}" y1="${cy}" x2="${xArmEnd}" y2="${cy}" stroke="${strokeColor}" stroke-width="${sw}" />`
    );
  }

  // Main Arms - Vertical
  const yArmStart = cy - maxArmOffset;
  const yArmEnd = cy + maxArmOffset;
  if (gapHalf > 0) {
    lines.push(
      `<line x1="${cx}" y1="${yArmStart}" x2="${cx}" y2="${cy - gapHalf}" stroke="${strokeColor}" stroke-width="${sw}" />`,
      `<line x1="${cx}" y1="${cy + gapHalf}" x2="${cx}" y2="${yArmEnd}" stroke="${strokeColor}" stroke-width="${sw}" />`
    );
  } else {
    lines.push(
      `<line x1="${cx}" y1="${yArmStart}" x2="${cx}" y2="${yArmEnd}" stroke="${strokeColor}" stroke-width="${sw}" />`
    );
  }

  // Optional Concentric Range Circles connecting corresponding clicks
  if (cfg.concentricRings) {
    const ringInt = Math.max(1, Number(cfg.ringInterval) || 5);
    for (let t = ringInt; t <= clicks; t += ringInt) {
      const radius = t * step;
      if (radius > gapHalf) {
        lines.push(
          `<circle cx="${cx}" cy="${cy}" r="${radius}" stroke="${strokeColor}" stroke-width="1.2" stroke-dasharray="6 4" fill="none" opacity="0.45" />`
        );
      }
    }
  }

  // Horizontal Indents / Tick Marks
  for (let t = 1; t <= clicks; t++) {
    const offset = t * step;
    if (offset <= gapHalf) continue;
    const isMajor = majorInt > 0 && t % majorInt === 0;
    const tickLen = isMajor ? majorLen : minorLen;
    const tickW = sw;
    const half = tickLen / 2;

    const xL = cx - offset;
    const xR = cx + offset;

    lines.push(
      `<line x1="${xL}" y1="${cy - half}" x2="${xL}" y2="${cy + half}" stroke="${strokeColor}" stroke-width="${tickW}" />`
    );
    if (showLabels && isMajor) {
      lines.push(
        `<text x="${xL}" y="${cy - half - 4}" fill="${strokeColor}" font-family="monospace" font-size="10" font-weight="bold" text-anchor="middle">${t}</text>`
      );
    }

    lines.push(
      `<line x1="${xR}" y1="${cy - half}" x2="${xR}" y2="${cy + half}" stroke="${strokeColor}" stroke-width="${tickW}" />`
    );
    if (showLabels && isMajor) {
      lines.push(
        `<text x="${xR}" y="${cy - half - 4}" fill="${strokeColor}" font-family="monospace" font-size="10" font-weight="bold" text-anchor="middle">${t}</text>`
      );
    }
  }

  // Vertical Indents / Tick Marks
  for (let t = 1; t <= clicks; t++) {
    const offset = t * step;
    if (offset <= gapHalf) continue;
    const isMajor = majorInt > 0 && t % majorInt === 0;
    const tickLen = isMajor ? majorLen : minorLen;
    const tickW = sw;
    const half = tickLen / 2;

    const yT = cy - offset;
    const yB = cy + offset;

    lines.push(
      `<line x1="${cx - half}" y1="${yT}" x2="${cx + half}" y2="${yT}" stroke="${strokeColor}" stroke-width="${tickW}" />`
    );
    if (showLabels && isMajor) {
      lines.push(
        `<text x="${cx + half + 4}" y="${yT + 3}" fill="${strokeColor}" font-family="monospace" font-size="10" font-weight="bold" text-anchor="start">${t}</text>`
      );
    }

    lines.push(
      `<line x1="${cx - half}" y1="${yB}" x2="${cx + half}" y2="${yB}" stroke="${strokeColor}" stroke-width="${tickW}" />`
    );
    if (showLabels && isMajor) {
      lines.push(
        `<text x="${cx + half + 4}" y="${yB + 3}" fill="${strokeColor}" font-family="monospace" font-size="10" font-weight="bold" text-anchor="start">${t}</text>`
      );
    }
  }

  return lines.join('\n');
}

/**
 * Shared renderer for any reticle overlay container (Live, Playback, or Hits).
 */
export function renderReticleOverlayLayer(layerEl, svgEl, customImgEl, state, enabled, zoomForFfp = 1.0) {
  if (!layerEl || !svgEl) return;
  layerEl.classList.toggle('hidden', !enabled);
  if (!enabled) return;

  layerEl.style.opacity = String((state.overlayOpacity ?? 75) / 100);

  const ffpFactor = state.reticleFfpMode ? Math.max(1.0, Number(zoomForFfp) || 1.0) : 1.0;
  const scaleVal = ((state.overlayScale ?? 100) / 100) * ffpFactor;
  svgEl.style.transform = `scale(${scaleVal})`;
  if (customImgEl) customImgEl.style.transform = `scale(${scaleVal})`;

  if (state.overlayType === 'custom' && state.customOverlayUrl && customImgEl) {
    svgEl.classList.add('hidden');
    customImgEl.classList.remove('hidden');
    if (customImgEl.src !== state.customOverlayUrl) {
      customImgEl.src = state.customOverlayUrl;
    }
  } else {
    if (customImgEl) customImgEl.classList.add('hidden');
    svgEl.classList.remove('hidden');
    const reticleKey = `${state.overlayType}_${state.themeColor}_${JSON.stringify(state.reticleConfig || {})}`;
    if (reticleMarkupCache.get(svgEl) !== reticleKey) {
      reticleMarkupCache.set(svgEl, reticleKey);
      svgEl.innerHTML = buildGraduatedCrosshairSvg(state.reticleConfig);
    }
  }
}

export function initOverlayManager() {
  const overlayLayer = document.getElementById('overlayLayer');
  const svgOverlay = document.getElementById('svgOverlay');
  const customImg = document.getElementById('customOverlayImg');

  function renderLiveOverlay(state) {
    renderReticleOverlayLayer(
      overlayLayer,
      svgOverlay,
      customImg,
      state,
      Boolean(state.overlayEnabled),
      state.mainZoom || 1.0
    );
  }

  renderLiveOverlay(appState);
  subscribeState(renderLiveOverlay);
}
