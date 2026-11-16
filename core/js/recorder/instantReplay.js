/**
 * Instant Replay Trigger & Optional Background Hit Auto-Save
 *
 * Pressing Replay snapshots the rolling RAM ring buffer and opens it
 * directly in the unified Screen 2 Playback view (unsaved until the user
 * chooses Save Clip). Background auto-save on hit remains off by default.
 */
import { appState } from '../state.js';
import { snapshotMemoryBuffer } from './memoryRingBuffer.js';
import { saveVideoClip } from '../storage/videoStore.js';
import { refreshGalleryClips, openLiveBufferInPlayer } from '../ui/videoBrowser.js';

let lastAutoSaveMs = -20000;
let autoSaveTimer = null;
let lastSavedEndTs = -Infinity;
let lastSavedMaxHitId = 0;

function getLatestHitId() {
  const hits = Array.isArray(appState.detectionHits) ? appState.detectionHits : [];
  return hits.length ? hits[hits.length - 1].id : 0;
}

function buildWallTimeline(snap) {
  const monoToWall = Date.now() - performance.now();
  return {
    ...(snap.timeline || { soundPeaks: [], events: [] }),
    wallStartMs: Math.round(snap.startTs + monoToWall),
    wallEndMs: Math.round(snap.endTs + monoToWall)
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

  lastSavedEndTs = snap.endTs;
  if (maxHitId > lastSavedMaxHitId) {
    lastSavedMaxHitId = maxHitId;
  }

  await saveVideoClip({
    jpegFrames: snap.jpegFrames,
    frameTimestamps: snap.frameTimestamps,
    fps: snap.fps,
    durationSec: snap.durationSec,
    sizeBytes: snap.sizeBytes,
    width: snap.width,
    height: snap.height,
    timeline: buildWallTimeline(snap)
  });
  await refreshGalleryClips();
  return true;
}

/**
 * Triggers a cooldown-guarded clip auto-save from the RAM ring buffer when a localized hit occurs.
 */
export function triggerAutoSaveHeatmapClip(triggerHitId = null) {
  if (!appState.heatmapAutoSave || !appState.bufferEnabled) return;
  if (typeof triggerHitId === 'number' && triggerHitId <= lastSavedMaxHitId) return;
  const now = performance.now();
  const cooldownMs = Math.max(15000, Math.round((appState.bufferMaxSeconds || 20) * 850));
  if (now - lastAutoSaveMs < cooldownMs || autoSaveTimer) return;
  lastAutoSaveMs = now;
  autoSaveTimer = setTimeout(async () => {
    autoSaveTimer = null;
    try {
      const snap = await snapshotMemoryBuffer();
      await saveSnapIfDistinct(snap, triggerHitId);
    } catch (err) {
      console.warn('Heatmap auto-save failed:', err);
    }
  }, 1600);
}

export function initInstantReplay() {
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
