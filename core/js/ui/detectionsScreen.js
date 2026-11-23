/**
 * Spatial Detections Helpers & Live Badge Sync for Unified Review (Screen 2)
 *
 * Maps logged session hits to video clip timelines (RAM buffer or saved clips),
 * projects normalized hit coordinates onto zoomed/panned viewports 1:1, and
 * keeps the Live top-right Review badge synchronized with appState.detectionHits.
 */
import { appState } from '../state.js';

let initialized = false;

export function formatAgeShort(tsMs) {
  const sec = Math.max(0, Math.round((Date.now() - tsMs) / 1000));
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m`;
  return `${Math.floor(min / 60)}h`;
}

export function getAgeClass(tsMs) {
  const sec = (Date.now() - tsMs) / 1000;
  if (sec <= 60) return 'pin-fresh';
  if (sec <= 300) return 'pin-warm';
  return 'pin-stale';
}

/**
 * Returns { startWallMs, endWallMs, durationSec } for a live buffer or saved clip.
 */
export function getClipWallBounds(clip) {
  if (!clip) return null;
  const durSec = Math.max(0.1, Number(clip.durationSec) || 0.5);
  const startWallMs = Number.isFinite(clip.startWallMs)
    ? clip.startWallMs
    : Number.isFinite(clip.timeline?.wallStartMs)
      ? clip.timeline.wallStartMs
      : ((clip.createdAt || Date.now()) - Math.round(durSec * 1000));
  const endWallMs = Number.isFinite(clip.endWallMs)
    ? clip.endWallMs
    : Number.isFinite(clip.timeline?.wallEndMs)
      ? clip.timeline.wallEndMs
      : (startWallMs + Math.round(durSec * 1000));
  return { startWallMs, endWallMs, durationSec: durSec };
}

/**
 * Maps a logged detection hit onto a clip's timeline.
 * Returns:
 * - { relation: 'inside', tSec: number } when the hit occurred during the clip
 * - { relation: 'before', tSec: null }   when the hit occurred earlier (already on target at 0.0s)
 * - { relation: 'after',  tSec: null }   when the hit occurred after the clip ended
 * - { relation: 'none',   tSec: null }   when no clip is loaded
 */
export function mapHitToClip(hit, clip) {
  if (!hit || !clip) return { relation: 'none', tSec: null };
  const durSec = Math.max(0.1, Number(clip.durationSec) || 0.5);

  // 1. High-precision monotonic clock match for LIVE BUFFER snapshots
  if (
    clip.isBuffer &&
    Number.isFinite(hit.perfMs) &&
    Number.isFinite(clip.startTs) &&
    Number.isFinite(clip.endTs)
  ) {
    if (hit.perfMs < clip.startTs - 350) {
      return { relation: 'before', tSec: null };
    }
    if (hit.perfMs > clip.endTs + 350) {
      return { relation: 'after', tSec: null };
    }
    const spanMs = Math.max(50, clip.endTs - clip.startTs);
    const frac = Math.max(0, Math.min(1, (hit.perfMs - clip.startTs) / spanMs));
    return { relation: 'inside', tSec: Number((frac * durSec).toFixed(2)) };
  }

  // 2. Wall-clock match for saved IndexedDB clips (or fallback)
  const bounds = getClipWallBounds(clip);
  if (!bounds || !Number.isFinite(hit.timestampMs)) {
    return { relation: 'none', tSec: null };
  }
  if (hit.timestampMs < bounds.startWallMs - 500) {
    return { relation: 'before', tSec: null };
  }
  if (hit.timestampMs > bounds.endWallMs + 500) {
    return { relation: 'after', tSec: null };
  }
  const spanMs = Math.max(100, bounds.endWallMs - bounds.startWallMs);
  const frac = Math.max(0, Math.min(1, (hit.timestampMs - bounds.startWallMs) / spanMs));
  return { relation: 'inside', tSec: Number((frac * durSec).toFixed(2)) };
}

/**
 * Finds the newest saved IndexedDB clip whose wall-clock window contains the hit.
 */
export function findBestSavedClipForHit(hit, savedClips) {
  if (!hit || !Array.isArray(savedClips) || !savedClips.length) return null;
  for (const clip of savedClips) {
    const mapped = mapHitToClip(hit, clip);
    if (mapped.relation === 'inside') {
      return { clip, tSec: mapped.tSec };
    }
  }
  return null;
}

/**
 * Projects a normalized [0..1] source coordinate onto the currently zoomed/panned
 * review viewport, matching jpegFramePlayer.js's exact crop formula.
 */
export function projectNormToReviewPct(normX, normY, zoom = 1.0, panX = 0, panY = 0) {
  const z = Math.max(1.0, Number(zoom) || 1.0);
  const cropFrac = 1 / z;
  const halfCrop = cropFrac / 2;
  const sxFrac = Math.max(0, Math.min(1 - cropFrac, 0.5 + (panX || 0) - halfCrop));
  const syFrac = Math.max(0, Math.min(1 - cropFrac, 0.5 + (panY || 0) - halfCrop));
  const leftPct = ((normX - sxFrac) / cropFrac) * 100;
  const topPct = ((normY - syFrac) / cropFrac) * 100;
  const inView = leftPct >= -4 && leftPct <= 104 && topPct >= -4 && topPct <= 104;
  return { leftPct, topPct, inView };
}

/**
 * Synchronizes the Live screen's simplified top-right Review pill hit badge.
 */
export function initDetectionsScreen(subscribeState) {
  if (initialized) return;
  initialized = true;

  const hitCountBadge = document.getElementById('hitCountBadge');

  function syncLiveReviewBadge(hits) {
    const count = Array.isArray(hits) ? hits.length : 0;
    if (hitCountBadge) {
      hitCountBadge.textContent = String(count);
      hitCountBadge.classList.toggle('has-hits', count > 0);
    }
  }

  subscribeState((state, patch) => {
    if (patch.detectionHits !== undefined) {
      syncLiveReviewBadge(state.detectionHits);
    }
  });

  syncLiveReviewBadge(appState.detectionHits);
}
