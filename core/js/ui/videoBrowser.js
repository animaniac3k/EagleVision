/**
 * Screen 2: Fullscreen Stored Video Player with Floating GUI Overlay
 *
 * Renders saved clips at 100% fullscreen in their native recorded resolution
 * using createImageBitmap lookahead decoding, with a collapsible left clip
 * drawer and floating bottom transport bar.
 */
import { appState, updateState, subscribeState } from '../state.js';
import { createJpegFramePlayer } from '../recorder/jpegFramePlayer.js';
import { listVideoClips, getVideoClip, deleteVideoClip, exportClipToDisk } from '../storage/videoStore.js';
import { renderCctvTrack } from './cctvScrubBar.js';
import { shouldHoldCanvasPan } from './ringController.js';
import { exportAnnotatedCanvasPng } from '../renderer/compositor.js';

let cachedClips = [];
let selectedClipId = null;
let clipDuration = 0;
let playheadSec = 0;
let playbackSpeed = 1.0;
let isPlaying = false;
let lastTickMs = 0;
let rafId = null;
let galleryZoom = 1.0;
let galleryPanX = 0;
let galleryPanY = 0;
let galleryEventNavHelper = null;
let galleryPlayer = null;
let lastTimeLabel = '';
let lastPlayBtnText = '';

function stopPlayerLoop() {
  if (rafId) {
    cancelAnimationFrame(rafId);
    rafId = null;
  }
}

function renderGalleryFrame() {
  const canvasEl = document.getElementById('galleryPlayerCanvas');
  const scrubber = document.getElementById('galleryScrubber');
  const timeReadout = document.getElementById('galleryTimeReadout');
  const btnPlayPause = document.getElementById('btnGalleryPlayPause');
  if (!canvasEl || !galleryPlayer) return;

  if (!galleryPlayer.getFrameCount()) {
    galleryPlayer.clearCanvas();
    if (lastTimeLabel !== '0.0s / 0.0s') {
      lastTimeLabel = '0.0s / 0.0s';
      timeReadout.textContent = lastTimeLabel;
    }
    return;
  }

  const idx = galleryPlayer.getIndexForTime(playheadSec);
  if (idx >= 0) {
    galleryPlayer.showFrame(idx);
  }

  scrubber.value = playheadSec.toFixed(2);
  const nextLabel = `${playheadSec.toFixed(1)}s / ${clipDuration.toFixed(1)}s`;
  if (nextLabel !== lastTimeLabel) {
    lastTimeLabel = nextLabel;
    timeReadout.textContent = nextLabel;
  }
  const nextPlayText = isPlaying ? '⏸' : '▶';
  if (nextPlayText !== lastPlayBtnText) {
    lastPlayBtnText = nextPlayText;
    btnPlayPause.textContent = nextPlayText;
  }
}

function galleryTickLoop(nowMs) {
  const screenGallery = document.getElementById('screenGallery');
  if (!screenGallery || screenGallery.classList.contains('hidden')) {
    stopPlayerLoop();
    return;
  }

  if (isPlaying && galleryPlayer && galleryPlayer.getFrameCount() > 0) {
    const dtSec = Math.max(0, (nowMs - lastTickMs) / 1000) * playbackSpeed;
    playheadSec += dtSec;
    if (playheadSec >= clipDuration) {
      playheadSec = 0;
    }
    renderGalleryFrame();
  }
  lastTickMs = nowMs;
  rafId = requestAnimationFrame(galleryTickLoop);
}

export async function refreshGalleryClips(autoSelectFirst = false) {
  cachedClips = await listVideoClips();
  const badge = document.getElementById('clipCountBadge');
  const listEl = document.getElementById('clipsList');
  const titleEl = document.getElementById('activeClipTitle');
  const metaEl = document.getElementById('activeClipMeta');

  badge.textContent = String(cachedClips.length);

  if (!cachedClips.length) {
    stopPlayerLoop();
    galleryPlayer?.unload();
    selectedClipId = null;
    listEl.innerHTML = `
      <div class="clip-card" style="cursor:default;">
        <div>
          <div class="clip-name">NO SAVED RECORDINGS</div>
          <div class="clip-meta">Tap REPLAY on the live feed to view & auto-save clips.</div>
        </div>
      </div>
    `;
    titleEl.textContent = 'NO CLIP SELECTED';
    metaEl.textContent = '—';
    renderGalleryFrame();
    return;
  }

  const galleryVisible = appState.currentScreen === 'gallery';
  let currentClip = cachedClips.find((c) => c.id === selectedClipId);
  if (galleryVisible && (!currentClip || autoSelectFirst)) {
    currentClip = cachedClips[0];
    selectClip(currentClip, true);
  } else if (!currentClip) {
    selectedClipId = cachedClips[0].id;
  }

  renderClipList();
}

function renderClipList() {
  const listEl = document.getElementById('clipsList');
  listEl.innerHTML = cachedClips
    .map((clip) => {
      const mb = (clip.sizeBytes / (1024 * 1024)).toFixed(1);
      const isSelected = clip.id === selectedClipId;
      return `
        <div class="clip-card ${isSelected ? 'active' : ''}" data-clip-id="${clip.id}">
          <div style="flex:1; min-width:0; padding-right:8px;">
            <div class="clip-name" style="white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">${clip.name}</div>
            <div class="clip-meta">${clip.width}×${clip.height} • ${clip.durationSec}s (${clip.fps || 15} FPS) • ${mb} MB</div>
          </div>
          <button type="button" class="btn-quick-delete-clip" data-delete-id="${clip.id}" title="Delete ${clip.name}" aria-label="Delete ${clip.name}">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="pointer-events:none;">
              <polyline points="3 6 5 6 21 6"></polyline>
              <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
              <line x1="10" y1="11" x2="10" y2="17"></line>
              <line x1="14" y1="11" x2="14" y2="17"></line>
            </svg>
          </button>
        </div>
      `;
    })
    .join('');

  listEl.querySelectorAll('.clip-card[data-clip-id]').forEach((card) => {
    card.addEventListener('click', (e) => {
      if (e.target.closest('.btn-quick-delete-clip')) return;
      const found = cachedClips.find((c) => c.id === card.dataset.clipId);
      if (found) {
        selectClip(found, true);
        renderClipList();
      }
    });
  });

  listEl.querySelectorAll('.btn-quick-delete-clip').forEach((btn) => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const clipId = btn.dataset.deleteId;
      const clip = cachedClips.find((c) => c.id === clipId);
      const clipName = clip ? clip.name : 'this recording';
      if (!window.confirm(`Permanently delete "${clipName}"?`)) {
        return;
      }
      await deleteVideoClip(clipId);
      const wasSelected = selectedClipId === clipId;
      if (wasSelected) {
        selectedClipId = null;
      }
      await refreshGalleryClips(wasSelected);
    });
  });
}

async function selectClip(clip, autoPlay = true) {
  stopPlayerLoop();
  galleryPlayer?.unload();

  selectedClipId = clip.id;
  const titleEl = document.getElementById('activeClipTitle');
  const metaEl = document.getElementById('activeClipMeta');
  const canvasEl = document.getElementById('galleryPlayerCanvas');
  const scrubber = document.getElementById('galleryScrubber');

  canvasEl.width = clip.width || 1920;
  canvasEl.height = clip.height || 1080;

  clipDuration = Math.max(0.5, clip.durationSec);
  playheadSec = 0;
  isPlaying = autoPlay;
  lastTickMs = performance.now();
  lastTimeLabel = '';
  lastPlayBtnText = '';

  scrubber.max = String(clipDuration.toFixed(2));
  scrubber.value = '0';

  const mb = (clip.sizeBytes / (1024 * 1024)).toFixed(1);
  titleEl.textContent = clip.name;
  metaEl.textContent = `${clip.width}×${clip.height} @ ${clip.fps || 15} FPS • ${clip.durationSec}s • ${mb} MB`;

  const fullClip = await getVideoClip(clip.id);
  if (!fullClip || !Array.isArray(fullClip.jpegFrames) || selectedClipId !== clip.id) {
    return;
  }

  galleryPlayer?.load(fullClip.jpegFrames, clipDuration, fullClip.frameTimestamps || null);

  // Render CCTV Waveform & Event Markers for this stored recording
  const waveformEl = document.getElementById('galleryWaveform');
  const markersEl = document.getElementById('galleryMarkers');
  const timeline = fullClip.timeline || clip.timeline || { soundPeaks: [], events: [] };
  galleryEventNavHelper = renderCctvTrack({
    waveformEl,
    markersEl,
    timeline,
    durationSec: clipDuration,
    onSeek: (t) => {
      playheadSec = t;
      lastTickMs = performance.now();
      renderGalleryFrame();
    }
  });

  renderGalleryFrame();
  rafId = requestAnimationFrame(galleryTickLoop);
}

/**
 * Opens the Stored Clips Gallery directly on a saved clip seeked to a target timestamp (seconds).
 */
export async function openClipAtTime(clipId, startSec = 0) {
  await refreshGalleryClips(false);
  const target = cachedClips.find((c) => c.id === clipId);
  if (!target) return false;
  updateState({ currentScreen: 'gallery', galleryArchiveTab: 'clips' });
  await selectClip(target, true);
  if (selectedClipId === target.id && clipDuration > 0) {
    playheadSec = Math.max(0, Math.min(Math.max(0.1, clipDuration - 0.1), Number(startSec) || 0));
    lastTickMs = performance.now();
    renderGalleryFrame();
  }
  return true;
}

export function initVideoBrowser() {
  const screenLive = document.getElementById('screenLive');
  const screenGallery = document.getElementById('screenGallery');
  const btnSwitchScreen = document.getElementById('btnSwitchScreen');
  const btnBackToLive = document.getElementById('btnBackToLive');

  const galleryDrawer = document.getElementById('galleryDrawer');
  const btnToggleGalleryDrawer = document.getElementById('btnToggleGalleryDrawer');
  const btnCloseGalleryDrawer = document.getElementById('btnCloseGalleryDrawer');

  const canvasEl = document.getElementById('galleryPlayerCanvas');
  galleryPlayer = createJpegFramePlayer(canvasEl, () => ({
    zoom: galleryZoom,
    panX: galleryPanX,
    panY: galleryPanY
  }));

  const scrubber = document.getElementById('galleryScrubber');
  const btnPlayPause = document.getElementById('btnGalleryPlayPause');
  const btnSlowMo = document.getElementById('btnGallerySlowMo');
  const btnStepBack = document.getElementById('btnGalleryStepBack');
  const btnStep = document.getElementById('btnGalleryStep');
  const btnDownload = document.getElementById('btnGalleryDownload');
  const btnDelete = document.getElementById('btnGalleryDelete');

  const btnZoomMinus = document.getElementById('galleryZoomMinus');
  const btnZoomPlus = document.getElementById('galleryZoomPlus');
  const btnZoomReset = document.getElementById('galleryZoomReset');
  const zoomBadge = document.getElementById('galleryZoomBadge');

  function syncGalleryZoomUI() {
    if (appState.galleryArchiveTab === 'hits') return;
    if (zoomBadge) zoomBadge.textContent = `${galleryZoom.toFixed(1)}x`;
    if (btnZoomReset) btnZoomReset.classList.toggle('hidden', galleryZoom <= 1.01);
    canvasEl.style.cursor = galleryZoom > 1.01 ? 'grab' : 'default';
    galleryPlayer.draw();
  }

  btnZoomMinus?.addEventListener('click', () => {
    if (appState.galleryArchiveTab === 'hits') return;
    galleryZoom = Math.max(1.0, Math.round((galleryZoom - 0.5) * 10) / 10);
    if (galleryZoom <= 1.01) {
      galleryPanX = 0;
      galleryPanY = 0;
    }
    syncGalleryZoomUI();
  });

  btnZoomPlus?.addEventListener('click', () => {
    if (appState.galleryArchiveTab === 'hits') return;
    galleryZoom = Math.min(8.0, Math.round((galleryZoom + 0.5) * 10) / 10);
    syncGalleryZoomUI();
  });

  btnZoomReset?.addEventListener('click', () => {
    if (appState.galleryArchiveTab === 'hits') return;
    galleryZoom = 1.0;
    galleryPanX = 0;
    galleryPanY = 0;
    syncGalleryZoomUI();
  });

  // Touch / Pointer Panning on Recorded Video when zoomed in (>1.0x)
  let panning = false;
  let panCommitted = false;
  let panStartTime = 0;
  let panStartX = 0;
  let panStartY = 0;
  let startOffX = 0;
  let startOffY = 0;

  canvasEl.addEventListener('pointerdown', (e) => {
    if (galleryZoom <= 1.01) return;
    panning = true;
    panStartTime = performance.now();
    panCommitted = !shouldHoldCanvasPan(panStartTime);
    panStartX = e.clientX;
    panStartY = e.clientY;
    startOffX = galleryPanX;
    startOffY = galleryPanY;
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
    const maxPan = Math.max(0, (1 - 1 / galleryZoom) / 2);
    galleryPanX = Math.max(-maxPan, Math.min(maxPan, startOffX - dx / galleryZoom));
    galleryPanY = Math.max(-maxPan, Math.min(maxPan, startOffY - dy / galleryZoom));
    galleryPlayer.draw();
  });

  const stopPan = () => { panning = false; };
  canvasEl.addEventListener('pointerup', stopPan);
  canvasEl.addEventListener('pointercancel', stopPan);

  function setDrawerOpen(open) {
    const next = typeof open === 'boolean' ? open : !appState.galleryDrawerOpen;
    updateState({ galleryDrawerOpen: next });
    galleryDrawer.classList.toggle('hidden', !next);
    btnToggleGalleryDrawer.classList.toggle('radar-btn-active', next);
  }

  btnToggleGalleryDrawer.addEventListener('click', () => setDrawerOpen());
  btnCloseGalleryDrawer.addEventListener('click', () => setDrawerOpen(false));
  setDrawerOpen(Boolean(appState.galleryDrawerOpen));

  btnSwitchScreen.addEventListener('click', () => {
    updateState({ currentScreen: 'gallery', galleryArchiveTab: 'clips' });
  });

  btnBackToLive.addEventListener('click', () => {
    isPlaying = false;
    stopPlayerLoop();
    galleryPlayer.unload();
    updateState({ currentScreen: 'live' });
  });

  subscribeState((state, patch) => {
    if (patch.currentScreen !== undefined && state.currentScreen !== 'gallery') {
      if (isPlaying || galleryPlayer.getFrameCount() > 0) {
        isPlaying = false;
        stopPlayerLoop();
        galleryPlayer.unload();
      }
    }
    if (state.currentScreen === 'gallery') {
      if (patch.galleryArchiveTab === 'clips') {
        syncGalleryZoomUI();
      }
      if (patch.galleryArchiveTab === 'hits') {
        if (isPlaying) {
          isPlaying = false;
          stopPlayerLoop();
        }
      } else if (
        patch.currentScreen === 'gallery' ||
        (patch.galleryArchiveTab === 'clips' && !galleryPlayer.getFrameCount())
      ) {
        refreshGalleryClips(true).catch(() => {});
      }
    }
  });

  btnPlayPause.addEventListener('click', () => {
    if (!galleryPlayer.getFrameCount()) return;
    isPlaying = !isPlaying;
    lastTickMs = performance.now();
    renderGalleryFrame();
  });

  btnSlowMo.addEventListener('click', () => {
    playbackSpeed = playbackSpeed < 0.9 ? 1.0 : 0.5;
    btnSlowMo.classList.toggle('radar-btn-active', playbackSpeed < 0.9);
  });

  // Frame-by-frame stepping backward / forward (exact frame index delta)
  function stepGalleryFrame(delta) {
    const totalFrames = galleryPlayer.getFrameCount();
    if (!totalFrames) return;
    isPlaying = false;
    const currentIdx = galleryPlayer.getCurrentIndex() >= 0
      ? galleryPlayer.getCurrentIndex()
      : Math.max(0, galleryPlayer.getIndexForTime(playheadSec));
    let nextIdx = currentIdx + delta;
    if (nextIdx < 0) nextIdx = totalFrames - 1;
    if (nextIdx >= totalFrames) nextIdx = 0;

    playheadSec = galleryPlayer.getTimeForIndex(nextIdx);
    galleryPlayer.showFrame(nextIdx);

    scrubber.value = playheadSec.toFixed(2);
    lastTimeLabel = `${playheadSec.toFixed(1)}s / ${clipDuration.toFixed(1)}s`;
    document.getElementById('galleryTimeReadout').textContent = lastTimeLabel;
    lastPlayBtnText = '▶';
    btnPlayPause.textContent = '▶';
    lastTickMs = performance.now();
  }

  btnStepBack?.addEventListener('click', () => stepGalleryFrame(-1));
  btnStep?.addEventListener('click', () => stepGalleryFrame(1));

  const btnPrevEvt = document.getElementById('btnGalleryPrevEvt');
  const btnNextEvt = document.getElementById('btnGalleryNextEvt');
  btnPrevEvt?.addEventListener('click', () => {
    if (!galleryEventNavHelper) return;
    const prev = galleryEventNavHelper.getPrevEvent(playheadSec);
    if (prev !== null) {
      playheadSec = prev;
      lastTickMs = performance.now();
      renderGalleryFrame();
    }
  });

  btnNextEvt?.addEventListener('click', () => {
    if (!galleryEventNavHelper) return;
    const next = galleryEventNavHelper.getNextEvent(playheadSec);
    if (next !== null) {
      playheadSec = next;
      lastTickMs = performance.now();
      renderGalleryFrame();
    }
  });

  scrubber.addEventListener('input', (e) => {
    playheadSec = parseFloat(e.target.value) || 0;
    lastTickMs = performance.now();
    renderGalleryFrame();
  });

  const btnGallerySnapshot = document.getElementById('btnGallerySnapshot');
  btnGallerySnapshot?.addEventListener('click', async () => {
    await exportAnnotatedCanvasPng(canvasEl, { includeReticle: true, prefix: 'SPOTR_Clip' });
  });

  btnDownload.addEventListener('click', async () => {
    if (!selectedClipId) return;
    const clip = await getVideoClip(selectedClipId);
    if (!clip) return;
    const orig = btnDownload.textContent;
    btnDownload.textContent = 'EXPORTING...';
    await exportClipToDisk(clip);
    btnDownload.textContent = orig;
  });

  btnDelete.addEventListener('click', async () => {
    if (!selectedClipId) return;
    const clip = cachedClips.find((c) => c.id === selectedClipId);
    const clipName = clip ? clip.name : 'this recording';
    if (!window.confirm(`Permanently delete "${clipName}" from the video archive?`)) {
      return;
    }
    await deleteVideoClip(selectedClipId);
    selectedClipId = null;
    await refreshGalleryClips(true);
  });

  refreshGalleryClips(false).catch((err) => console.warn('Gallery clips refresh deferred:', err));
}
