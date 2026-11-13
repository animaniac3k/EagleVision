/**
 * Instant In-Memory Playback Controller (Native Resolution)
 *
 * Streams compressed JPEG frames from RAM onto #replayCanvas at native
 * resolution using lightweight Blob ObjectURLs and a single HTMLImageElement
 * decoder (using near-zero extra RAM even for long 1080p/4K recordings),
 * while automatically saving the clip to the Stored Video Archive.
 *
 * Supports zoom & pan using the interface zoom controls, and exact single-frame
 * stepping backward and forward.
 */
import { appState, updateState, subscribeState } from '../state.js';
import { snapshotMemoryBuffer } from './memoryRingBuffer.js';
import { saveVideoClip } from '../storage/videoStore.js';
import { refreshGalleryClips } from '../ui/videoBrowser.js';
import { renderCctvTrack } from '../ui/cctvScrubBar.js';
import { shouldHoldCanvasPan } from '../ui/ringController.js';

let activeFrameUrls = [];
let activeDuration = 20;
let playheadSec = 0;
let isPlaying = false;
let playbackSpeed = 1.0;
let lastTickMs = 0;
let rafId = null;
let lastRenderedIdx = -1;
let eventNavHelper = null;

const decoderImg = new Image();

export function initInstantReplay() {
  const modal = document.getElementById('instantReplayModal');
  const canvasEl = document.getElementById('replayCanvas');
  const ctx = canvasEl.getContext('2d');
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

  function drawReplayImage() {
    if (!decoderImg.complete || !decoderImg.naturalWidth) return;
    ctx.clearRect(0, 0, canvasEl.width, canvasEl.height);

    const imgW = decoderImg.naturalWidth || canvasEl.width;
    const imgH = decoderImg.naturalHeight || canvasEl.height;
    const z = Math.max(1.0, appState.mainZoom || 1.0);
    const cropW = imgW / z;
    const cropH = imgH / z;
    const centerX = imgW * (0.5 + (appState.mainPanX || 0));
    const centerY = imgH * (0.5 + (appState.mainPanY || 0));
    const sx = Math.max(0, Math.min(imgW - cropW, centerX - cropW / 2));
    const sy = Math.max(0, Math.min(imgH - cropH, centerY - cropH / 2));

    ctx.drawImage(decoderImg, sx, sy, cropW, cropH, 0, 0, canvasEl.width, canvasEl.height);
  }

  decoderImg.onload = () => {
    if (!appState.replayActive) return;
    drawReplayImage();
  };

  // Re-render when main zoom or pan changes via interface controls / gamepad / touch
  subscribeState((state, patch) => {
    if (patch.replayActive !== undefined) {
      document.getElementById('screenLive')?.classList.toggle('replay-active', !!state.replayActive);
    }
    if (state.replayActive && (patch.mainZoom !== undefined || patch.mainPanX !== undefined || patch.mainPanY !== undefined)) {
      canvasEl.style.cursor = (state.mainZoom || 1.0) > 1.01 ? 'grab' : 'default';
      drawReplayImage();
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

  function releaseFrameUrls() {
    activeFrameUrls.forEach((url) => URL.revokeObjectURL(url));
    activeFrameUrls = [];
    lastRenderedIdx = -1;
  }

  function renderCurrentFrame() {
    if (!activeFrameUrls.length) return;
    const progress = activeDuration > 0 ? Math.max(0, Math.min(1, playheadSec / activeDuration)) : 0;
    const idx = Math.min(activeFrameUrls.length - 1, Math.floor(progress * activeFrameUrls.length));

    if (idx !== lastRenderedIdx && activeFrameUrls[idx]) {
      lastRenderedIdx = idx;
      decoderImg.src = activeFrameUrls[idx];
    } else {
      drawReplayImage();
    }

    scrubber.value = String(playheadSec.toFixed(2));
    timeText.textContent = `${playheadSec.toFixed(1)}s / ${activeDuration.toFixed(1)}s`;
    btnPlayPause.textContent = isPlaying ? '⏸' : '▶';
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

  async function openReplay() {
    const snap = await snapshotMemoryBuffer();
    if (!snap || !snap.jpegFrames.length) return;

    stopLoop();
    releaseFrameUrls();

    activeFrameUrls = snap.jpegFrames.map((buf) =>
      URL.createObjectURL(new Blob([buf], { type: 'image/jpeg' }))
    );
    activeDuration = Math.max(0.5, snap.durationSec);
    playheadSec = 0;
    isPlaying = true;
    playbackSpeed = 1.0;
    const btnSlow = document.getElementById('btnReplaySlowMo');
    if (btnSlow) { btnSlow.classList.remove('radar-btn-active'); btnSlow.textContent = '0.5x'; }
    lastTickMs = performance.now();

    canvasEl.width = snap.width || 1920;
    canvasEl.height = snap.height || 1080;
    canvasEl.style.cursor = (appState.mainZoom || 1.0) > 1.01 ? 'grab' : 'default';

    scrubber.max = String(activeDuration.toFixed(2));
    scrubber.value = '0';
    bannerText.textContent = `INSTANT REPLAY — AUTO-SAVED ${activeDuration.toFixed(1)}s (${snap.width}×${snap.height} @ ${snap.fps} FPS)`;

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

    // Automatically persist this native-resolution clip with its timeline to IndexedDB Archive
    try {
      await saveVideoClip({
        jpegFrames: snap.jpegFrames,
        fps: snap.fps,
        durationSec: snap.durationSec,
        sizeBytes: snap.sizeBytes,
        width: snap.width,
        height: snap.height,
        timeline: snap.timeline
      });
      await refreshGalleryClips();
    } catch (err) {
      console.warn('Auto-save replay error:', err);
    }
  }

  function closeReplay() {
    stopLoop();
    isPlaying = false;
    releaseFrameUrls();
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
    if (!activeFrameUrls.length) return;
    isPlaying = false;
    const totalFrames = activeFrameUrls.length;
    let currentIdx = lastRenderedIdx >= 0 ? lastRenderedIdx : Math.floor((playheadSec / activeDuration) * totalFrames);
    let nextIdx = currentIdx + delta;
    if (nextIdx < 0) nextIdx = totalFrames - 1;
    if (nextIdx >= totalFrames) nextIdx = 0;

    lastRenderedIdx = nextIdx;
    playheadSec = (nextIdx / totalFrames) * activeDuration;
    decoderImg.src = activeFrameUrls[nextIdx];

    scrubber.value = String(playheadSec.toFixed(2));
    timeText.textContent = `${playheadSec.toFixed(1)}s / ${activeDuration.toFixed(1)}s`;
    btnPlayPause.textContent = '▶';
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
