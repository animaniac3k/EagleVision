/**
 * Shared Timestamp Formatting, Adaptive Luminance Sampling & Canvas Overlay Helpers
 */

function pad2(n) {
  return String(n).padStart(2, '0');
}

export function formatDisplayTimestamp(wallMs = Date.now()) {
  const d = new Date(Number.isFinite(wallMs) ? wallMs : Date.now());
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

export function formatHitClockTime(wallMs) {
  if (!Number.isFinite(wallMs)) return '';
  const d = new Date(wallMs);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

export function getTimestampNormRegion(position = 'bottom-right') {
  switch (position) {
    case 'top-left':
      return { nx: 0.02, ny: 0.04, nw: 0.16, nh: 0.08 };
    case 'top-center':
      return { nx: 0.42, ny: 0.02, nw: 0.16, nh: 0.08 };
    case 'top-right':
      return { nx: 0.82, ny: 0.04, nw: 0.16, nh: 0.08 };
    case 'bottom-left':
      return { nx: 0.02, ny: 0.88, nw: 0.16, nh: 0.08 };
    case 'bottom-center':
      return { nx: 0.42, ny: 0.88, nw: 0.16, nh: 0.08 };
    case 'bottom-right':
    default:
      return { nx: 0.82, ny: 0.90, nw: 0.16, nh: 0.08 };
  }
}

let lumaCanvas = null;
let lumaCtx = null;

/**
 * Samples average luma (0..255) from a 4×4 patch under the timestamp position.
 */
export function sampleSourceRegionLuma(source, position = 'bottom-right', sx = 0, sy = 0, cropW = 0, cropH = 0) {
  if (!source) return 30;
  try {
    if (!lumaCanvas) {
      lumaCanvas = document.createElement('canvas');
      lumaCanvas.width = 4;
      lumaCanvas.height = 4;
      lumaCtx = lumaCanvas.getContext('2d', { willReadFrequently: true });
    }
    if (!lumaCtx) return 30;

    const srcW = source.videoWidth || source.width || 0;
    const srcH = source.videoHeight || source.height || 0;
    if (!srcW || !srcH) return 30;

    const effW = cropW > 0 ? cropW : srcW;
    const effH = cropH > 0 ? cropH : srcH;
    const { nx, ny, nw, nh } = getTimestampNormRegion(position);
    const rx = Math.max(0, Math.min(srcW - 4, sx + nx * effW));
    const ry = Math.max(0, Math.min(srcH - 4, sy + ny * effH));
    const rw = Math.max(4, Math.min(srcW - rx, nw * effW));
    const rh = Math.max(4, Math.min(srcH - ry, nh * effH));

    lumaCtx.drawImage(source, rx, ry, rw, rh, 0, 0, 4, 4);
    const data = lumaCtx.getImageData(0, 0, 4, 4).data;
    let sum = 0;
    for (let i = 0; i < data.length; i += 4) {
      sum += 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
    }
    return sum / 16;
  } catch {
    return 30;
  }
}

export function drawDisplayTimestampOnCanvas(
  ctx,
  cw,
  ch,
  wallMs = Date.now(),
  {
    position = 'bottom-right',
    opacity = 0.6,
    adaptive = true,
    bgLuma = 30,
    isLive = false,
    decluttered = false,
    safeInsetX = 0,
    safeInsetY = 0
  } = {}
) {
  if (!ctx || !cw || !ch) return;
  const text = formatDisplayTimestamp(wallMs);
  const fontSize = Math.max(10, Math.min(14, Math.round(ch * 0.0155)));
  const alpha = Math.max(0.15, Math.min(1, Number(opacity) || 0.6));

  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.font = `600 ${fontSize}px ui-monospace, SFMono-Regular, Menlo, monospace`;
  const padX = Math.round(fontSize * 0.58);
  const boxH = Math.round(fontSize * 1.55);
  const textW = Math.ceil(ctx.measureText(text).width);
  const boxW = textW + padX * 2;
  const insetX = Math.max(0, Math.round(Number(safeInsetX) || 0));
  const insetY = Math.max(0, Math.round(Number(safeInsetY) || 0));
  const marginX = 16 + insetX;
  const marginEdgeY = 14 + insetY;

  let x = cw - boxW - marginX;
  let y = ch - boxH - marginEdgeY;

  switch (position) {
    case 'top-left':
      x = marginX;
      y = isLive ? 66 : marginEdgeY;
      break;
    case 'top-center':
      x = Math.round((cw - boxW) / 2);
      y = marginEdgeY;
      break;
    case 'top-right':
      x = cw - boxW - marginX;
      y = isLive && !decluttered ? 60 : marginEdgeY;
      break;
    case 'bottom-left':
      x = marginX;
      y = isLive && !decluttered && cw <= 900 ? ch - boxH - 72 : ch - boxH - marginEdgeY;
      break;
    case 'bottom-center':
      x = Math.round((cw - boxW) / 2);
      y = isLive && !decluttered ? ch - boxH - 72 : ch - boxH - marginEdgeY;
      break;
    case 'bottom-right':
    default:
      x = cw - boxW - marginX;
      y = isLive && !decluttered && cw <= 1120 ? ch - boxH - 72 : ch - boxH - marginEdgeY;
      break;
  }

  x = Math.max(8, Math.min(cw - boxW - 8, x));
  y = Math.max(8, Math.min(ch - boxH - 8, y));

  const useDarkText = adaptive && Number(bgLuma) > 145;
  ctx.fillStyle = useDarkText ? 'rgba(248, 250, 252, 0.58)' : 'rgba(6, 9, 13, 0.52)';
  ctx.strokeStyle = useDarkText ? 'rgba(15, 23, 42, 0.2)' : 'rgba(255, 255, 255, 0.14)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  if (ctx.roundRect) {
    ctx.roundRect(x, y, boxW, boxH, 5);
  } else {
    ctx.rect(x, y, boxW, boxH);
  }
  ctx.fill();
  ctx.stroke();

  ctx.fillStyle = useDarkText ? '#0f172a' : '#cbd5e1';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, x + boxW / 2, y + boxH / 2 + 0.5);
  ctx.restore();
}

export function drawHitTimestampBadge(ctx, pinX, pinY, pinRadius, wallMs, cw, ch = 0) {
  const label = formatHitClockTime(wallMs);
  if (!ctx || !label) return;
  ctx.save();
  ctx.font = '600 9.5px ui-monospace, SFMono-Regular, Menlo, monospace';
  const padX = 4;
  const boxH = 14;
  const boxW = Math.ceil(ctx.measureText(label).width) + padX * 2;
  const placeLeft = pinX + pinRadius + 6 + boxW > cw - 8;
  const rawBx = placeLeft ? Math.round(pinX - pinRadius - 6 - boxW) : Math.round(pinX + pinRadius + 5);
  const bx = Math.max(8, Math.min(Math.max(8, cw - boxW - 8), rawBx));
  const rawBy = Math.round(pinY - boxH / 2);
  const maxBy = ch > 0 ? Math.max(8, ch - boxH - 8) : rawBy;
  const by = Math.max(8, Math.min(maxBy, rawBy));

  ctx.fillStyle = 'rgba(6, 9, 13, 0.72)';
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.16)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  if (ctx.roundRect) {
    ctx.roundRect(bx, by, boxW, boxH, 4);
  } else {
    ctx.rect(bx, by, boxW, boxH);
  }
  ctx.fill();
  ctx.stroke();

  ctx.fillStyle = '#cbd5e1';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.fillText(label, bx + padX, by + boxH / 2 + 0.5);
  ctx.restore();
}
