/**
 * Instant In-Memory Playback Controller (Native Resolution)
 *
 * Streams compressed JPEG frames from RAM onto #replayCanvas at native
 * resolution using createImageBitmap lookahead decoding, while saving
 * the clip to the Stored Video Archive without blocking playback startup.
 *
 * Supports zoom & pan using the interface zoom controls, and exact single-frame
 * stepping backward and forward.
 */
import { appState, updateState, subscribeState } from '../state.js';
import { snapshotMemoryBuffer } from './memoryRingBuffer.js';
import { createJpegFramePlayer } from './jpegFramePlayer.js';
import { saveVideoClip, listVideoClips } from '../storage/videoStore.js';
import { refreshGalleryClips, openClipAtTime } from '../ui/videoBrowser.js';
import { renderCctvTrack } from '../ui/cctvScrubBar.js';
import { shouldHoldCanvasPan } from '../ui/ringController.js';

let activeDuration = 20;
let playheadSec = 0;
let isPlaying = false;
let playbackSpeed = 1.0;
let lastTickMs = 0;
let rafId = null;
let eventNavHelper = null;
let pendingSaveTimer = null;
let pendingSaveTask = null;
let openReplayHandler = null;
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

/**
 * Opens Instant Replay from the rolling RAM buffer pre-seeked near a detection hit timestamp,
 * falling back to matching saved clips in the Gallery if the hit has already rolled out of RAM.
 * @returns {Promise<boolean>} True if replay or saved clip covered the hit timestamp, false otherwise.
 */
export async function openReplayAtTimestamp(targetPerfMs, targetWallMs = null) {
  const clips = await listVideoClips();
  const matched = (typeof targetWallMs === 'number' && Number.isFinite(targetWallMs))
    ? clips.find((clip) => {
      const durMs = Math.max(500, (clip.durationSec || 0) * 1000);
      const startW = clip.timeline?.wallStartMs ?? (clip.createdAt - durMs);
      const endW = clip.timeline?.wallEndMs ?? clip.createdAt;
      return targetWallMs >= startW - 1500 && targetWallMs <= endW + 1500;
    })
    : null;

  if (openReplayHandler) {
    // Skip saving a duplicate DB clip if this hit was already persisted in a saved clip
    const openedRam = await openReplayHandler(targetPerfMs, { saveToDb: !matched });
    if (openedRam) return true;
  }

  if (matched) {
    const durMs = Math.max(500, (matched.durationSec || 0) * 1000);
    const startW = matched.timeline?.wallStartMs ?? (matched.createdAt - durMs);
    const offsetSec = Math.max(0, (targetWallMs - startW) / 1000 - 2.0);
    return openClipAtTime(matched.id, offsetSec);
  }
  return false;
}

export function initInstantReplay() {
  const modal = document.getElementById('instantReplayModal');
  const canvasEl = document.getElementById('replayCanvas');
  const replayBar = document.getElementById('replayBar');
  const btnPlayPause = document.getElementById('btnReplayPlayPause');
  const btnStepBack = document.getElementById('btnReplayStepBack');
  const btnStep = document.getElementById('btnReplayStep');
  const btnPrevEvt = document.getElementById('btnReplayPrevEvt');
  const btnNextEvt = document.getElementById('btnReplayNextEvt');
  const btnBackToLive = document.getElementById('btnReplayBackToLive');
  const waveformEl = document.getElementById('replayWaveform');
  const markersEl = document.getElementById('replayMarkers');
  const scrubber = document.getElementById('replayScrubber');
  const timeText = document.getElementById('replayTimeText');
  const bannerText = document.getElementById('replayBannerText');
  const btnReplay = document.getElementById('btnReplay20s');
  const btnClose = document.getElementById('btnCloseReplay');

  const player = createJpegFramePlayer(canvasEl, () => ({
    zoom: appState.mainZoom || 1.0,
    panX: appState.mainPanX || 0,
    panY: appState.mainPanY || 0
  }));

  let lastTimeLabel = '';
  let lastPlayBtnText = '';

  function syncTransportUi() {
    scrubber.value = playheadSec.toFixed(2);
    const nextLabel = `${playheadSec.toFixed(1)}s / ${activeDuration.toFixed(1)}s`;
    if (nextLabel !== lastTimeLabel) {
      lastTimeLabel = nextLabel;
      timeText.textContent = nextLabel;
    }
    const nextPlayText = isPlaying ? '⏸' : '▶';
    if (nextPlayText !== lastPlayBtnText) {
      lastPlayBtnText = nextPlayText;
      btnPlayPause.textContent = nextPlayText;
    }
  }

  // Re-render when main zoom or pan changes via interface controls / gamepad / touch
  subscribeState((state, patch) => {
    if (patch.replayActive !== undefined) {
      document.getElementById('screenLive')?.classList.toggle('replay-active', !!state.replayActive);
    }
    if (state.replayActive && (patch.mainZoom !== undefined || patch.mainPanX !== undefined || patch.mainPanY !== undefined)) {
      canvasEl.style.cursor = (state.mainZoom || 1.0) > 1.01 ? 'grab' : 'default';
      player.draw();
    }
  });

  // Touch / Pointer Panning during replay when zoomed in (>1.0x)
  let panning = false;
  let panCommitted = false;
  let panStartTime = 0;
  let panStartX = 0;
  let panStartY = 0;
  let startOffsetX = 0;
  let startOffsetY = 0;

  canvasEl.addEventListener('pointerdown', (e) => {
    if ((appState.mainZoom || 1.0) <= 1.01) return;
    panning = true;
    panStartTime = performance.now();
    panCommitted = !shouldHoldCanvasPan(panStartTime);
    panStartX = e.clientX;
    panStartY = e.clientY;
    startOffsetX = appState.mainPanX || 0;
    startOffsetY = appState.mainPanY || 0;
    canvasEl.style.cursor = 'grabbing';
    canvasEl.setPointerCapture(e.pointerId);
  });

  canvasEl.addEventListener('pointermove', (e) => {
    if (!panning) return;
    if (!panCommitted) {
      if (shouldHoldCanvasPan(panStartTime)) return;
      panCommitted = true;
      panStartX = e.clientX;
      panStartY = e.clientY;
    }
    const rect = canvasEl.getBoundingClientRect();
    const dx = (e.clientX - panStartX) / Math.max(1, rect.width);
    const dy = (e.clientY - panStartY) / Math.max(1, rect.height);
    const maxPan = Math.max(0, (1 - 1 / (appState.mainZoom || 1.0)) / 2);
    updateState({
      mainPanX: Math.max(-maxPan, Math.min(maxPan, startOffsetX - dx / (appState.mainZoom || 1.0))),
      mainPanY: Math.max(-maxPan, Math.min(maxPan, startOffsetY - dy / (appState.mainZoom || 1.0)))
    });
  });

  const stopPan = () => {
    if (panning) {
      panning = false;
      canvasEl.style.cursor = (appState.mainZoom || 1.0) > 1.01 ? 'grab' : 'default';
    }
  };
  canvasEl.addEventListener('pointerup', stopPan);
  canvasEl.addEventListener('pointercancel', stopPan);

  function stopLoop() {
    if (rafId) {
      cancelAnimationFrame(rafId);
      rafId = null;
    }
  }

  function flushPendingAutoSave() {
    if (pendingSaveTimer) {
      clearTimeout(pendingSaveTimer);
      pendingSaveTimer = null;
    }
    if (pendingSaveTask) {
      const task = pendingSaveTask;
      pendingSaveTask = null;
      task();
    }
  }

  function renderCurrentFrame() {
    if (!player.getFrameCount()) return;
    const idx = player.getIndexForTime(playheadSec);
    if (idx >= 0) {
      player.showFrame(idx);
    }
    syncTransportUi();
  }

  function tickLoop(nowMs) {
    if (!appState.replayActive) return;
    if (isPlaying) {
      const dtSec = Math.max(0, (nowMs - lastTickMs) / 1000) * playbackSpeed;
      playheadSec += dtSec;
      if (playheadSec >= activeDuration) {
        playheadSec = 0;
      }
      renderCurrentFrame();
    }
    lastTickMs = nowMs;
    rafId = requestAnimationFrame(tickLoop);
  }

  async function openReplay(targetWallMs = null, options = {}) {
    const { saveToDb = true } = options;
    const snap = await snapshotMemoryBuffer();
    if (!snap || !snap.jpegFrames.length) return false;

    let initialPlayhead = 0;
    if (typeof targetWallMs === 'number' && Number.isFinite(targetWallMs)) {
      if (targetWallMs < snap.startTs - 2500 || targetWallMs > snap.endTs + 1500) {
        return false;
      }
      const offsetSec = (targetWallMs - snap.startTs) / 1000;
      initialPlayhead = Math.max(0, Math.min(Math.max(0.5, snap.durationSec) - 0.5, offsetSec - 2.0));
    }

    if (appState.currentScreen !== 'live') {
      updateState({ currentScreen: 'live' });
    }

    stopLoop();
    flushPendingAutoSave();

    activeDuration = Math.max(0.5, snap.durationSec);
    playheadSec = initialPlayhead;
    isPlaying = true;
    playbackSpeed = 1.0;
    lastTimeLabel = '';
    lastPlayBtnText = '';

    const btnSlow = document.getElementById('btnReplaySlowMo');
    if (btnSlow) { btnSlow.classList.remove('radar-btn-active'); btnSlow.textContent = '0.5x'; }
    lastTickMs = performance.now();

    canvasEl.width = snap.width || 1920;
    canvasEl.height = snap.height || 1080;
    canvasEl.style.cursor = (appState.mainZoom || 1.0) > 1.01 ? 'grab' : 'default';

    player.load(snap.jpegFrames, activeDuration, snap.frameTimestamps);

    scrubber.max = String(activeDuration.toFixed(2));
    scrubber.value = '0';
    bannerText.textContent = saveToDb
      ? `INSTANT REPLAY — AUTO-SAVED ${activeDuration.toFixed(1)}s (${snap.width}×${snap.height} @ ${snap.fps} FPS)`
      : `INSTANT REPLAY — ${activeDuration.toFixed(1)}s (${snap.width}×${snap.height} @ ${snap.fps} FPS)`;

    // Render CCTV Waveform & Event Markers
    eventNavHelper = renderCctvTrack({
      waveformEl,
      markersEl,
      timeline: snap.timeline,
      durationSec: activeDuration,
      onSeek: (t) => {
        playheadSec = t;
        lastTickMs = performance.now();
        renderCurrentFrame();
      }
    });

    document.getElementById('screenLive')?.classList.add('replay-active');
    modal.classList.remove('hidden');
    replayBar.classList.remove('hidden');
    updateState({ replayActive: true });

    renderCurrentFrame();
    rafId = requestAnimationFrame(tickLoop);

    // Persist clip once after playback starts (skipping duplicates or already-saved hit reviews)
    if (saveToDb) {
      if (autoSaveTimer) {
        clearTimeout(autoSaveTimer);
        autoSaveTimer = null;
      }
      pendingSaveTask = async () => {
        try {
          await saveSnapIfDistinct(snap);
        } catch (err) {
          console.warn('Auto-save replay error:', err);
        }
      };
      pendingSaveTimer = setTimeout(flushPendingAutoSave, 250);
    }
    return true;
  }

  function closeReplay() {
    stopLoop();
    flushPendingAutoSave();
    isPlaying = false;
    player.unload();
    document.getElementById('screenLive')?.classList.remove('replay-active');
    modal.classList.add('hidden');
    replayBar.classList.add('hidden');
    updateState({ replayActive: false });
  }

  const btnSlowMo = document.getElementById('btnReplaySlowMo');
  btnSlowMo?.addEventListener('click', () => {
    playbackSpeed = playbackSpeed === 1.0 ? 0.5 : 1.0;
    btnSlowMo.classList.toggle('radar-btn-active', playbackSpeed < 0.9);
    btnSlowMo.textContent = playbackSpeed < 0.9 ? '0.5x (SLOW)' : '0.5x';
  });

  btnPlayPause.addEventListener('click', () => {
    isPlaying = !isPlaying;
    lastTickMs = performance.now();
    renderCurrentFrame();
  });

  // Frame-by-frame stepping backward / forward (exact frame index delta)
  function stepReplayFrame(delta) {
    const totalFrames = player.getFrameCount();
    if (!totalFrames) return;
    isPlaying = false;
    const currentIdx = player.getCurrentIndex() >= 0
      ? player.getCurrentIndex()
      : Math.max(0, player.getIndexForTime(playheadSec));
    let nextIdx = currentIdx + delta;
    if (nextIdx < 0) nextIdx = totalFrames - 1;
    if (nextIdx >= totalFrames) nextIdx = 0;

    playheadSec = player.getTimeForIndex(nextIdx);
    player.showFrame(nextIdx);
    syncTransportUi();
    lastTickMs = performance.now();
  }

  btnStepBack?.addEventListener('click', () => stepReplayFrame(-1));
  btnStep?.addEventListener('click', () => stepReplayFrame(1));

  btnPrevEvt?.addEventListener('click', () => {
    if (!eventNavHelper) return;
    const prev = eventNavHelper.getPrevEvent(playheadSec);
    if (prev !== null) {
      playheadSec = prev;
      lastTickMs = performance.now();
      renderCurrentFrame();
    }
  });

  btnNextEvt?.addEventListener('click', () => {
    if (!eventNavHelper) return;
    const next = eventNavHelper.getNextEvent(playheadSec);
    if (next !== null) {
      playheadSec = next;
      lastTickMs = performance.now();
      renderCurrentFrame();
    }
  });

  scrubber.addEventListener('input', (e) => {
    playheadSec = parseFloat(e.target.value) || 0;
    lastTickMs = performance.now();
    renderCurrentFrame();
  });

  openReplayHandler = openReplay;

  btnReplay.addEventListener('click', () => {
    if (!modal.classList.contains('hidden')) {
      closeReplay();
    } else {
      openReplay();
    }
  });

  btnClose.addEventListener('click', closeReplay);
  btnBackToLive?.addEventListener('click', closeReplay);
}
