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
  const clickSpacingSvgUnits = Math.max(8, Number(cfg.clickSpacing) || 32);

  // SVG viewBox is 800x500 with preserveAspectRatio="xMidYMid meet"
  const baseScale = Math.min(
    Math.max(1, viewportW) / RETICLE_VIEWBOX_W,
    Math.max(1, viewportH) / RETICLE_VIEWBOX_H
  );
  const scaleMultiplier = Math.max(0.1, (Number(overlayScalePercent) || 100) / 100);
  return clickSpacingSvgUnits * baseScale * scaleMultiplier;
}

/**
 * Returns the on-screen pixel distance from reticle center to the edge of the center gap.
 */
export function getCenterGapDistanceInPixels(viewportW, viewportH, overlayScalePercent = 100) {
  const cfg = appState.reticleConfig || {};
  const gapHalfSvgUnits = Math.max(0, (Number(cfg.centerGap) || 64) / 2);

  const baseScale = Math.min(
    Math.max(1, viewportW) / RETICLE_VIEWBOX_W,
    Math.max(1, viewportH) / RETICLE_VIEWBOX_H
  );
  const scaleMultiplier = Math.max(0.1, (Number(overlayScalePercent) || 100) / 100);
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
  const step = Math.max(8, Number(cfg.clickSpacing) || 32);
  const clicks = Math.max(2, Math.min(25, Number(cfg.clickCount) || 10));
  const gapHalf = Math.max(0, (Number(cfg.centerGap) || 64) / 2);
  const sw = Number(cfg.strokeWidth) || 1.8;
  const strokeColor = cfg.reticleColor ? cfg.reticleColor : 'var(--radar-accent)';
  const majorInt = Math.max(0, Number(cfg.majorInterval) || 5);
  const minorLen = Math.max(3, Number(cfg.minorTickLen) || 10);
  const majorLen = Math.max(6, Number(cfg.majorTickLen) || 18);
  const showLabels = Boolean(cfg.showLabels);

  const lines = [];
  const armLen = clicks * step;

  // Main Arms - Horizontal (Left & Right extending from gap outward)
  const xArmStart = Math.max(8, cx - gapHalf - armLen);
  const xArmEnd = Math.min(RETICLE_VIEWBOX_W - 8, cx + gapHalf + armLen);
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

  // Main Arms - Vertical (Top & Bottom extending from gap outward)
  const yArmStart = Math.max(8, cy - gapHalf - armLen);
  const yArmEnd = Math.min(RETICLE_VIEWBOX_H - 8, cy + gapHalf + armLen);
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
      const radius = gapHalf + t * step;
      lines.push(
        `<circle cx="${cx}" cy="${cy}" r="${radius}" stroke="${strokeColor}" stroke-width="1.2" stroke-dasharray="6 4" fill="none" opacity="0.45" />`
      );
    }
  }

  // Horizontal Indents / Tick Marks (Left & Right - 1 to clicks)
  for (let t = 1; t <= clicks; t++) {
    const offset = gapHalf + t * step;
    const isMajor = majorInt > 0 && t % majorInt === 0;
    const tickLen = isMajor ? majorLen : minorLen;
    const tickW = isMajor ? Math.min(sw * 1.2, 3.2) : Math.max(sw * 0.8, 1.2);
    const half = tickLen / 2;

    const xL = cx - offset;
    const xR = cx + offset;

    // Left tick
    if (xL >= 6) {
      lines.push(
        `<line x1="${xL}" y1="${cy - half}" x2="${xL}" y2="${cy + half}" stroke="${strokeColor}" stroke-width="${tickW}" />`
      );
      if (showLabels && isMajor) {
        lines.push(
          `<text x="${xL}" y="${cy - half - 4}" fill="${strokeColor}" font-family="monospace" font-size="10" font-weight="bold" text-anchor="middle">${t}</text>`
        );
      }
    }

    // Right tick
    if (xR <= RETICLE_VIEWBOX_W - 6) {
      lines.push(
        `<line x1="${xR}" y1="${cy - half}" x2="${xR}" y2="${cy + half}" stroke="${strokeColor}" stroke-width="${tickW}" />`
      );
      if (showLabels && isMajor) {
        lines.push(
          `<text x="${xR}" y="${cy - half - 4}" fill="${strokeColor}" font-family="monospace" font-size="10" font-weight="bold" text-anchor="middle">${t}</text>`
        );
      }
    }
  }

  // Vertical Indents / Tick Marks (Top & Bottom - 1 to clicks)
  for (let t = 1; t <= clicks; t++) {
    const offset = gapHalf + t * step;
    const isMajor = majorInt > 0 && t % majorInt === 0;
    const tickLen = isMajor ? majorLen : minorLen;
    const tickW = isMajor ? Math.min(sw * 1.2, 3.2) : Math.max(sw * 0.8, 1.2);
    const half = tickLen / 2;

    const yT = cy - offset;
    const yB = cy + offset;

    // Top tick
    if (yT >= 6) {
      lines.push(
        `<line x1="${cx - half}" y1="${yT}" x2="${cx + half}" y2="${yT}" stroke="${strokeColor}" stroke-width="${tickW}" />`
      );
      if (showLabels && isMajor) {
        lines.push(
          `<text x="${cx + half + 4}" y="${yT + 3}" fill="${strokeColor}" font-family="monospace" font-size="10" font-weight="bold" text-anchor="start">${t}</text>`
        );
      }
    }

    // Bottom tick
    if (yB <= RETICLE_VIEWBOX_H - 6) {
      lines.push(
        `<line x1="${cx - half}" y1="${yB}" x2="${cx + half}" y2="${yB}" stroke="${strokeColor}" stroke-width="${tickW}" />`
      );
      if (showLabels && isMajor) {
        lines.push(
          `<text x="${cx + half + 4}" y="${yB + 3}" fill="${strokeColor}" font-family="monospace" font-size="10" font-weight="bold" text-anchor="start">${t}</text>`
        );
      }
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
    const scaleVal = state.overlayScale / 100;
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
