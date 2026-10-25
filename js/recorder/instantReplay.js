/**
 * Instant In-Memory Playback Controller (Native Resolution)
 *
 * Streams compressed JPEG frames from RAM onto #replayCanvas at native
 * resolution using lightweight Blob ObjectURLs and a single HTMLImageElement
 * decoder (using near-zero extra RAM even for long 1080p/4K recordings),
 * while automatically saving the clip to the Stored Video Archive.
 */
import { appState, updateState } from '../state.js';
import { snapshotMemoryBuffer } from './memoryRingBuffer.js';
import { saveVideoClip } from '../storage/videoStore.js';
import { refreshGalleryClips } from '../ui/videoBrowser.js';

let activeFrameUrls = [];
let activeDuration = 20;
let playheadSec = 0;
let isPlaying = false;
let lastTickMs = 0;
let rafId = null;
let lastRenderedIdx = -1;

const decoderImg = new Image();

export function initInstantReplay() {
  const modal = document.getElementById('instantReplayModal');
  const canvasEl = document.getElementById('replayCanvas');
  const ctx = canvasEl.getContext('2d');
  const replayBar = document.getElementById('replayBar');
  const btnPlayPause = document.getElementById('btnReplayPlayPause');
  const scrubber = document.getElementById('replayScrubber');
  const timeText = document.getElementById('replayTimeText');
  const bannerText = document.getElementById('replayBannerText');
  const btnReplay = document.getElementById('btnReplay20s');
  const btnClose = document.getElementById('btnCloseReplay');

  decoderImg.onload = () => {
    if (!appState.replayActive) return;
    ctx.clearRect(0, 0, canvasEl.width, canvasEl.height);
    ctx.drawImage(decoderImg, 0, 0, canvasEl.width, canvasEl.height);
  };

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
    }

    scrubber.value = String(playheadSec.toFixed(2));
    timeText.textContent = `${playheadSec.toFixed(1)}s / ${activeDuration.toFixed(1)}s`;
    btnPlayPause.textContent = isPlaying ? '⏸' : '▶';
  }

  function tickLoop(nowMs) {
    if (!appState.replayActive) return;
    if (isPlaying) {
      const dtSec = Math.max(0, (nowMs - lastTickMs) / 1000);
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
    lastTickMs = performance.now();

    canvasEl.width = snap.width || 1920;
    canvasEl.height = snap.height || 1080;

    scrubber.max = String(activeDuration.toFixed(2));
    scrubber.value = '0';
    bannerText.textContent = `INSTANT REPLAY — AUTO-SAVED ${activeDuration.toFixed(1)}s (${snap.width}×${snap.height} @ ${snap.fps} FPS)`;

    modal.classList.remove('hidden');
    replayBar.classList.remove('hidden');
    updateState({ replayActive: true });

    renderCurrentFrame();
    rafId = requestAnimationFrame(tickLoop);

    // Automatically persist this native-resolution clip to IndexedDB Archive
    try {
      await saveVideoClip({
        jpegFrames: snap.jpegFrames,
        fps: snap.fps,
        durationSec: snap.durationSec,
        sizeBytes: snap.sizeBytes,
        width: snap.width,
        height: snap.height
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
    modal.classList.add('hidden');
    replayBar.classList.add('hidden');
    updateState({ replayActive: false });
  }

  btnPlayPause.addEventListener('click', () => {
    isPlaying = !isPlaying;
    lastTickMs = performance.now();
    renderCurrentFrame();
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
}
