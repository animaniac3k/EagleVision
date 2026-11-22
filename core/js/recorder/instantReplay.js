/**
 * Instant Replay Trigger & Optional Background Hit Auto-Save
 *
 * Pressing Replay snapshots the rolling RAM ring buffer and opens it
 * directly in the unified Screen 2 Playback view (unsaved until the user
 * chooses Save Clip). Background auto-save on hit remains off by default.
 */
import { appState, subscribeState } from '../state.js';
import { snapshotMemoryBuffer } from './memoryRingBuffer.js';
import { saveVideoClip } from '../storage/videoStore.js';
import { refreshGalleryClips, openLiveBufferInPlayer } from '../ui/videoBrowser.js';

let lastAutoSaveMs = -20000;
let autoSaveTimer = null;
let lastSavedEndTs = -Infinity;
let lastSavedMaxHitId = 0;

export function resetAutoSaveWatermark() {
  lastSavedMaxHitId = 0;
  lastSavedEndTs = -Infinity;
}

export function cancelPendingAutoSave() {
  if (autoSaveTimer) {
    clearTimeout(autoSaveTimer);
    autoSaveTimer = null;
  }
}

function getLatestHitId() {
  const hits = Array.isArray(appState.detectionHits) ? appState.detectionHits : [];
  return hits.length ? hits[hits.length - 1].id : 0;
}

function buildWallTimeline(snap) {
  const startWall = Number.isFinite(snap.startWallMs)
    ? snap.startWallMs
    : Math.round(snap.startTs + (Date.now() - performance.now()));
  const durMs = Math.max(0, Math.round((snap.durationSec || 0) * 1000));
  return {
    ...(snap.timeline || { soundPeaks: [], events: [] }),
    wallStartMs: startWall,
    wallEndMs: Number.isFinite(snap.endWallMs) ? snap.endWallMs : startWall + durMs
  };
}

/**
 * Persists a buffer snapshot once, deduplicating repeat saves for the same hit/buffer window.
 */
async function saveSnapIfDistinct(snap, triggerHitId = null) {
  if (!snap || !snap.jpegFrames?.length) return false;
  const maxHitId = Math.max(getLatestHitId(), triggerHitId || 0);
  const sameWindow = (snap.endTs - lastSavedEndTs) < 8000;
  const noNewHits = maxHitId <= lastSavedMaxHitId;
  if (sameWindow && (noNewHits || triggerHitId === null)) {
    return false;
  }

  await saveVideoClip({
    jpegFrames: snap.jpegFrames,
    frameTimestamps: snap.frameTimestamps,
    startWallMs: snap.startWallMs,
    fps: snap.fps,
    durationSec: snap.durationSec,
    sizeBytes: snap.sizeBytes,
    width: snap.width,
    height: snap.height,
    timeline: buildWallTimeline(snap)
  });

  // Update deduplication watermarks only AFTER persistence succeeds
  lastSavedEndTs = snap.endTs;
  if (maxHitId > lastSavedMaxHitId) {
    lastSavedMaxHitId = maxHitId;
  }
  await refreshGalleryClips();
  return true;
}

/**
 * Triggers a cooldown-guarded clip auto-save from the RAM ring buffer when a localized hit occurs.
 */
export function triggerAutoSaveHeatmapClip(triggerHitId = null) {
  if (!appState.heatmapAutoSave || !appState.bufferEnabled) return;
  // Handle Clear Hits resetting nextHitSeq back to 1
  if (typeof triggerHitId === 'number' && triggerHitId < lastSavedMaxHitId && getLatestHitId() <= triggerHitId) {
    lastSavedMaxHitId = 0;
  }
  if (typeof triggerHitId === 'number' && triggerHitId <= lastSavedMaxHitId) return;
  const now = performance.now();
  const cooldownMs = Math.max(15000, Math.round((appState.bufferMaxSeconds || 20) * 850));
  if (now - lastAutoSaveMs < cooldownMs || autoSaveTimer) return;
  lastAutoSaveMs = now;
  autoSaveTimer = setTimeout(async () => {
    autoSaveTimer = null;
    if (!appState.heatmapAutoSave || !appState.bufferEnabled) return;
    try {
      const snap = await snapshotMemoryBuffer();
      await saveSnapIfDistinct(snap, triggerHitId);
    } catch (err) {
      console.warn('Heatmap auto-save failed:', err);
    }
  }, 1600);
}

export function initInstantReplay() {
  subscribeState((state, patch) => {
    if (patch && 'detectionHits' in patch && (!state.detectionHits || state.detectionHits.length === 0)) {
      resetAutoSaveWatermark();
    }
    if (patch && (('heatmapAutoSave' in patch && !state.heatmapAutoSave) || ('bufferEnabled' in patch && !state.bufferEnabled))) {
      cancelPendingAutoSave();
    }
  });

  const btnReplay = document.getElementById('btnReplay20s');
  btnReplay?.addEventListener('click', async () => {
    if (appState.currentScreen === 'gallery') {
      document.getElementById('btnBackToLive')?.click();
      return;
    }
    const snap = await snapshotMemoryBuffer();
    if (!snap || !snap.jpegFrames?.length) return;
    await openLiveBufferInPlayer({
      ...snap,
      timeline: buildWallTimeline(snap)
    });
  });
}
