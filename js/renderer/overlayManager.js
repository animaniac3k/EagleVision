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
  const gapHalfSvgUnits = Math.min(rawGapHalf, Math.max(8, step * 1.5));

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
 * Can be rendered on the main feed (#svgOverlay) or inside the Reticle Customizer preview stage.
 */
export function buildGraduatedCrosshairSvg(customConfig = null) {
  const cfg = Object.assign(
    {
      clickCount: 10,
      clickSpacing: 32,
      centerGap: 64,
      centerStyle: 'empty', // 'empty' | 'dot' | 'cross' | 'chevron'
      innerBrackets: true,
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
  const gapHalf = Math.min(rawGapHalf, Math.max(8, step * 1.5));
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
  // Placed at the exact optical dead-center pixel (cx, cy) where clicks are measured from
  // Sized and weighted to strictly match the crosshair stroke weight (sw)
  const centerStyle = String(cfg.centerStyle || 'empty').toLowerCase();
  if (centerStyle === 'dot') {
    // Sharp precision center aiming dot at (cx, cy) with diameter harmonized to line weight sw
    const dotR = Math.max(0.75, sw * 0.6);
    lines.push(
      `<circle cx="${cx}" cy="${cy}" r="${dotR.toFixed(2)}" fill="${strokeColor}" />`
    );
  } else if (centerStyle === 'cross') {
    // Fine precision center mini-crosshair centered at (cx, cy) matching crosshair stroke weight sw
    const crossLen = gapHalf > 0 ? Math.min(12, Math.max(6, gapHalf * 0.45)) : 8;
    lines.push(
      `<line x1="${(cx - crossLen).toFixed(1)}" y1="${cy}" x2="${(cx + crossLen).toFixed(1)}" y2="${cy}" stroke="${strokeColor}" stroke-width="${sw}" />`,
      `<line x1="${cx}" y1="${(cy - crossLen).toFixed(1)}" x2="${cx}" y2="${(cy + crossLen).toFixed(1)}" stroke="${strokeColor}" stroke-width="${sw}" />`
    );
  } else if (centerStyle === 'chevron') {
    // Tactical inverted-V / chevron caret pointing directly to the exact measurement dead-center pixel (cx, cy) matching crosshair stroke weight sw
    const chW = 8;
    const chH = 10;
    lines.push(
      `<path d="M ${(cx - chW).toFixed(1)} ${(cy + chH).toFixed(1)} L ${cx} ${cy} L ${(cx + chW).toFixed(1)} ${(cy + chH).toFixed(1)}" fill="none" stroke="${strokeColor}" stroke-width="${sw}" stroke-linecap="round" stroke-linejoin="miter" />`
    );
  }

  // Main Arms - Horizontal (Left & Right extending from gap outward to maxArmOffset)
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

  // Main Arms - Vertical (Top & Bottom extending from gap outward to maxArmOffset)
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

  // Inner Gap Bracket Ticks (if gap is open and enabled)
  if (gapHalf > 0 && cfg.innerBrackets) {
    const bracketLen = 8;
    lines.push(
      `<line x1="${cx - gapHalf}" y1="${cy - bracketLen}" x2="${cx - gapHalf}" y2="${cy + bracketLen}" stroke="${strokeColor}" stroke-width="${sw}" />`,
      `<line x1="${cx + gapHalf}" y1="${cy - bracketLen}" x2="${cx + gapHalf}" y2="${cy + bracketLen}" stroke="${strokeColor}" stroke-width="${sw}" />`,
      `<line x1="${cx - bracketLen}" y1="${cy - gapHalf}" x2="${cx + bracketLen}" y2="${cy - gapHalf}" stroke="${strokeColor}" stroke-width="${sw}" />`,
      `<line x1="${cx - bracketLen}" y1="${cy + gapHalf}" x2="${cx + bracketLen}" y2="${cy + gapHalf}" stroke="${strokeColor}" stroke-width="${sw}" />`
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

  // Horizontal Indents / Tick Marks (Left & Right - 1 to clicks, measured from dead center)
  for (let t = 1; t <= clicks; t++) {
    const offset = t * step;
    if (offset <= gapHalf) continue; // inside the open center gap
    const isMajor = majorInt > 0 && t % majorInt === 0;
    const tickLen = isMajor ? majorLen : minorLen;
    const tickW = sw; // All ticks share the exact same thinness sw; major ticks differentiated by length
    const half = tickLen / 2;

    const xL = cx - offset;
    const xR = cx + offset;

    // Left tick
    lines.push(
      `<line x1="${xL}" y1="${cy - half}" x2="${xL}" y2="${cy + half}" stroke="${strokeColor}" stroke-width="${tickW}" />`
    );
    if (showLabels && isMajor) {
      lines.push(
        `<text x="${xL}" y="${cy - half - 4}" fill="${strokeColor}" font-family="monospace" font-size="10" font-weight="bold" text-anchor="middle">${t}</text>`
      );
    }

    // Right tick
    lines.push(
      `<line x1="${xR}" y1="${cy - half}" x2="${xR}" y2="${cy + half}" stroke="${strokeColor}" stroke-width="${tickW}" />`
    );
    if (showLabels && isMajor) {
      lines.push(
        `<text x="${xR}" y="${cy - half - 4}" fill="${strokeColor}" font-family="monospace" font-size="10" font-weight="bold" text-anchor="middle">${t}</text>`
      );
    }
  }

  // Vertical Indents / Tick Marks (Top & Bottom - 1 to clicks up to 30, measured from dead center)
  for (let t = 1; t <= clicks; t++) {
    const offset = t * step;
    if (offset <= gapHalf) continue; // inside the open center gap
    const isMajor = majorInt > 0 && t % majorInt === 0;
    const tickLen = isMajor ? majorLen : minorLen;
    const tickW = sw; // All ticks share the exact same thinness sw; major ticks differentiated by length
    const half = tickLen / 2;

    const yT = cy - offset;
    const yB = cy + offset;

    // Top tick
    lines.push(
      `<line x1="${cx - half}" y1="${yT}" x2="${cx + half}" y2="${yT}" stroke="${strokeColor}" stroke-width="${tickW}" />`
    );
    if (showLabels && isMajor) {
      lines.push(
        `<text x="${cx + half + 4}" y="${yT + 3}" fill="${strokeColor}" font-family="monospace" font-size="10" font-weight="bold" text-anchor="start">${t}</text>`
      );
    }

    // Bottom tick
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

export function initOverlayManager() {
  const overlayLayer = document.getElementById('overlayLayer');
  const svgOverlay = document.getElementById('svgOverlay');
  const customImg = document.getElementById('customOverlayImg');

  function renderOverlay(state) {
    if (!overlayLayer || !svgOverlay) return;
    overlayLayer.classList.toggle('hidden', !state.overlayEnabled);
    overlayLayer.style.opacity = String(state.overlayOpacity / 100);

    // In First Focal Plane (FFP) mode, scale overlay in lockstep with main image digital zoom
    const ffpFactor = state.reticleFfpMode ? Math.max(1.0, Number(state.mainZoom) || 1.0) : 1.0;
    const scaleVal = (state.overlayScale / 100) * ffpFactor;
    svgOverlay.style.transform = `scale(${scaleVal})`;
    if (customImg) customImg.style.transform = `scale(${scaleVal})`;

    if (state.overlayType === 'custom' && state.customOverlayUrl && customImg) {
      svgOverlay.classList.add('hidden');
      customImg.classList.remove('hidden');
      if (customImg.src !== state.customOverlayUrl) {
        customImg.src = state.customOverlayUrl;
      }
    } else {
      if (customImg) customImg.classList.add('hidden');
      svgOverlay.classList.remove('hidden');
      svgOverlay.innerHTML = buildGraduatedCrosshairSvg(state.reticleConfig);
    }
  }

  renderOverlay(appState);
  subscribeState(renderOverlay);
}
