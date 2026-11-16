/**
 * Screen 2: Unified Fullscreen Playback (Live RAM Buffer + Saved Video Archive)
 *
 * Renders either a live RAM ring-buffer snapshot (Instant Replay) or saved
 * IndexedDB clips at native resolution using createImageBitmap lookahead
 * decoding, with a collapsible left source drawer, optional reticle overlay,
 * and floating bottom transport bar.
 */
import { appState, updateState, subscribeState } from '../state.js';
import { createJpegFramePlayer } from '../recorder/jpegFramePlayer.js';
import {
  listVideoClips,
  getVideoClip,
  saveVideoClip,
  deleteVideoClip,
  exportClipToDisk
} from '../storage/videoStore.js';
import { renderCctvTrack } from './cctvScrubBar.js';
import { shouldHoldCanvasPan } from './ringController.js';
import { exportAnnotatedCanvasPng } from '../renderer/compositor.js';
import { renderReticleOverlayLayer } from '../renderer/overlayManager.js';
import { saveSettings } from '../storage/settingsStore.js';

const LIVE_BUFFER_ID = '__live_buffer__';

let cachedClips = [];
let activeBufferClip = null;
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
let setDrawerOpenFn = null;
let openingLiveBuffer = false;

function stopPlayerLoop() {
  if (rafId) {
    cancelAnimationFrame(rafId);
    rafId = null;
  }
}

function syncPlaybackReticleOverlay() {
  const layerEl = document.getElementById('galleryReticleLayer');
  const svgEl = document.getElementById('galleryReticleSvg');
  const customImg = document.getElementById('galleryReticleCustomImg');
  const btnReticle = document.getElementById('btnTogglePlaybackReticle');
  const enabled = Boolean(appState.playbackReticleEnabled);

  if (btnReticle) {
    btnReticle.textContent = enabled ? 'Reticle: ON' : 'Reticle: OFF';
    btnReticle.classList.toggle('radar-btn-active', enabled);
  }
  renderReticleOverlayLayer(layerEl, svgEl, customImg, appState, enabled, galleryZoom);
}

function syncSourceActionButtons() {
  const isBuffer = selectedClipId === LIVE_BUFFER_ID && Boolean(activeBufferClip);
  const btnSaveBuffer = document.getElementById('btnSaveBufferClip');
  const btnDelete = document.getElementById('btnGalleryDelete');
  const btnDownload = document.getElementById('btnGalleryDownload');
  const btnSnapshot = document.getElementById('btnGallerySnapshot');
  const hasSource = isBuffer || Boolean(selectedClipId);

  if (btnSaveBuffer) btnSaveBuffer.classList.toggle('hidden', !isBuffer);
  if (btnDelete) {
    btnDelete.classList.toggle('hidden', isBuffer);
    btnDelete.disabled = !selectedClipId;
  }
  if (btnDownload) btnDownload.disabled = !hasSource;
  if (btnSnapshot) btnSnapshot.disabled = !hasSource;
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

  const isViewingBuffer = selectedClipId === LIVE_BUFFER_ID && Boolean(activeBufferClip);

  if (!cachedClips.length && !activeBufferClip) {
    stopPlayerLoop();
    galleryPlayer?.unload();
    selectedClipId = null;
    listEl.innerHTML = `
      <div class="clip-card" style="cursor:default;">
        <div>
          <div class="clip-name">NO SAVED RECORDINGS</div>
          <div class="clip-meta">Tap Replay on Live to inspect RAM buffer, or enable Auto-Save in Setup.</div>
        </div>
      </div>
    `;
    titleEl.textContent = 'NO CLIP SELECTED';
    metaEl.textContent = '—';
    syncSourceActionButtons();
    renderGalleryFrame();
    return;
  }

  const galleryVisible = appState.currentScreen === 'gallery';
  if (!isViewingBuffer) {
    let currentClip = cachedClips.find((c) => c.id === selectedClipId);
    if (galleryVisible && (!currentClip || autoSelectFirst)) {
      if (cachedClips.length) {
        currentClip = cachedClips[0];
        selectClip(currentClip, true);
      } else if (activeBufferClip) {
        selectClip(activeBufferClip, true);
      }
    } else if (!currentClip && cachedClips.length) {
      selectedClipId = cachedClips[0].id;
    }
  }

  renderClipList();
}

function renderClipList() {
  const listEl = document.getElementById('clipsList');
  const parts = [];

  if (activeBufferClip) {
    const mb = ((activeBufferClip.sizeBytes || 0) / (1024 * 1024)).toFixed(1);
    const isSelected = selectedClipId === LIVE_BUFFER_ID;
    parts.push(`
      <div class="clip-card clip-card-buffer ${isSelected ? 'active' : ''}" data-clip-id="${LIVE_BUFFER_ID}">
        <div style="flex:1; min-width:0; padding-right:8px;">
          <div class="clip-name" style="display:flex; align-items:center; gap:6px;">
            <span class="status-dot" style="width:7px; height:7px;"></span>
            <span>LIVE BUFFER (RAM)</span>
          </div>
          <div class="clip-meta">${activeBufferClip.width}×${activeBufferClip.height} • ${activeBufferClip.durationSec}s (${activeBufferClip.fps || 15} FPS) • ${mb} MB • Unsaved</div>
        </div>
      </div>
    `);
  }

  for (const clip of cachedClips) {
    const mb = (clip.sizeBytes / (1024 * 1024)).toFixed(1);
    const isSelected = clip.id === selectedClipId;
    parts.push(`
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
    `);
  }

  listEl.innerHTML = parts.join('');

  listEl.querySelectorAll('.clip-card[data-clip-id]').forEach((card) => {
    card.addEventListener('click', (e) => {
      if (e.target.closest('.btn-quick-delete-clip')) return;
      const cid = card.dataset.clipId;
      const found = cid === LIVE_BUFFER_ID ? activeBufferClip : cachedClips.find((c) => c.id === cid);
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

  const mb = ((clip.sizeBytes || 0) / (1024 * 1024)).toFixed(1);
  if (clip.isBuffer) {
    titleEl.textContent = 'LIVE BUFFER';
    metaEl.textContent = `${clip.width}×${clip.height} @ ${clip.fps || 15} FPS • ${clip.durationSec}s • RAM`;
  } else {
    titleEl.textContent = clip.name;
    metaEl.textContent = `${clip.width}×${clip.height} @ ${clip.fps || 15} FPS • ${clip.durationSec}s • ${mb} MB`;
  }
  syncSourceActionButtons();

  const fullClip = clip.isBuffer ? clip : await getVideoClip(clip.id);
  if (!fullClip || !Array.isArray(fullClip.jpegFrames) || selectedClipId !== clip.id) {
    return;
  }

  galleryPlayer?.load(fullClip.jpegFrames, clipDuration, fullClip.frameTimestamps || null);

  // Render CCTV Waveform & Event Markers for this source
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
 * Opens a RAM ring-buffer snapshot directly in the unified Playback screen (without auto-saving).
 */
export async function openLiveBufferInPlayer(snap) {
  if (!snap || !Array.isArray(snap.jpegFrames) || !snap.jpegFrames.length) return false;
  activeBufferClip = {
    id: LIVE_BUFFER_ID,
    isBuffer: true,
    name: 'LIVE BUFFER',
    createdAt: Date.now(),
    jpegFrames: snap.jpegFrames,
    frameTimestamps: snap.frameTimestamps || null,
    fps: snap.fps || 15,
    durationSec: snap.durationSec,
    sizeBytes: snap.sizeBytes || 0,
    width: snap.width || 1920,
    height: snap.height || 1080,
    timeline: snap.timeline || { soundPeaks: [], events: [] }
  };
  selectedClipId = LIVE_BUFFER_ID;
  openingLiveBuffer = true;
  setDrawerOpenFn?.(false);
  updateState({ currentScreen: 'gallery', galleryArchiveTab: 'clips' });
  openingLiveBuffer = false;
  await refreshGalleryClips(false);
  await selectClip(activeBufferClip, true);
  renderClipList();
  return true;
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
  const btnSaveBufferClip = document.getElementById('btnSaveBufferClip');
  const btnTogglePlaybackReticle = document.getElementById('btnTogglePlaybackReticle');

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
    syncPlaybackReticleOverlay();
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
  setDrawerOpenFn = setDrawerOpen;

  btnToggleGalleryDrawer.addEventListener('click', () => setDrawerOpen());
  btnCloseGalleryDrawer.addEventListener('click', () => setDrawerOpen(false));
  setDrawerOpen(Boolean(appState.galleryDrawerOpen));

  btnSwitchScreen.addEventListener('click', () => {
    if (selectedClipId === LIVE_BUFFER_ID) {
      selectedClipId = cachedClips[0]?.id || LIVE_BUFFER_ID;
    }
    updateState({ currentScreen: 'gallery', galleryArchiveTab: 'clips' });
  });

  btnBackToLive.addEventListener('click', () => {
    isPlaying = false;
    stopPlayerLoop();
    galleryPlayer.unload();
    updateState({ currentScreen: 'live' });
  });

  btnTogglePlaybackReticle?.addEventListener('click', () => {
    updateState({ playbackReticleEnabled: !appState.playbackReticleEnabled });
    saveSettings(appState);
  });

  btnSaveBufferClip?.addEventListener('click', async () => {
    if (!activeBufferClip || selectedClipId !== LIVE_BUFFER_ID) return;
    const orig = btnSaveBufferClip.textContent;
    btnSaveBufferClip.disabled = true;
    btnSaveBufferClip.textContent = 'Saving...';
    try {
      const savedMeta = await saveVideoClip({
        jpegFrames: activeBufferClip.jpegFrames,
        frameTimestamps: activeBufferClip.frameTimestamps,
        fps: activeBufferClip.fps,
        durationSec: activeBufferClip.durationSec,
        sizeBytes: activeBufferClip.sizeBytes,
        width: activeBufferClip.width,
        height: activeBufferClip.height,
        timeline: activeBufferClip.timeline
      });
      activeBufferClip = null;
      selectedClipId = savedMeta.id;
      await refreshGalleryClips(false);
      const titleEl = document.getElementById('activeClipTitle');
      const metaEl = document.getElementById('activeClipMeta');
      const mb = (savedMeta.sizeBytes / (1024 * 1024)).toFixed(1);
      if (titleEl) titleEl.textContent = savedMeta.name;
      if (metaEl) metaEl.textContent = `${savedMeta.width}×${savedMeta.height} @ ${savedMeta.fps || 15} FPS • ${savedMeta.durationSec}s • ${mb} MB`;
      syncSourceActionButtons();
      renderClipList();
    } catch (err) {
      console.warn('Save buffer clip failed:', err);
    } finally {
      btnSaveBufferClip.disabled = false;
      btnSaveBufferClip.textContent = orig;
    }
  });

  subscribeState((state, patch) => {
    if (patch.currentScreen !== undefined && state.currentScreen !== 'gallery') {
      if (isPlaying || galleryPlayer.getFrameCount() > 0) {
        isPlaying = false;
        stopPlayerLoop();
        galleryPlayer.unload();
      }
    }
    if (
      patch.playbackReticleEnabled !== undefined ||
      patch.overlayType !== undefined ||
      patch.overlayOpacity !== undefined ||
      patch.overlayScale !== undefined ||
      patch.reticleFfpMode !== undefined ||
      patch.customOverlayUrl !== undefined ||
      patch.reticleConfig !== undefined ||
      patch.themeColor !== undefined
    ) {
      syncPlaybackReticleOverlay();
    }
    if (state.currentScreen === 'gallery' && !openingLiveBuffer) {
      if (patch.galleryArchiveTab === 'clips') {
        syncGalleryZoomUI();
        renderGalleryFrame();
      }
      if (patch.galleryArchiveTab === 'hits') {
        if (isPlaying) {
          isPlaying = false;
          stopPlayerLoop();
          lastPlayBtnText = '';
          renderGalleryFrame();
        }
      } else if (
        patch.currentScreen === 'gallery' ||
        (patch.galleryArchiveTab === 'clips' && !galleryPlayer.getFrameCount())
      ) {
        if (selectedClipId === LIVE_BUFFER_ID && activeBufferClip) {
          if (!galleryPlayer.getFrameCount()) {
            selectClip(activeBufferClip, true);
          }
          refreshGalleryClips(false).catch(() => {});
        } else {
          refreshGalleryClips(true).catch(() => {});
        }
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
    await exportAnnotatedCanvasPng(canvasEl, {
      includeReticle: Boolean(appState.playbackReticleEnabled),
      reticleZoom: galleryZoom,
      prefix: 'SPOTR_Clip'
    });
  });

  btnDownload.addEventListener('click', async () => {
    if (!selectedClipId) return;
    const clip = selectedClipId === LIVE_BUFFER_ID && activeBufferClip
      ? {
          ...activeBufferClip,
          name: `LIVE_BUFFER_${Date.now()}.WEBM`
        }
      : await getVideoClip(selectedClipId);
    if (!clip) return;
    const orig = btnDownload.textContent;
    btnDownload.textContent = 'EXPORTING...';
    await exportClipToDisk(clip);
    btnDownload.textContent = orig;
  });

  btnDelete.addEventListener('click', async () => {
    if (!selectedClipId || selectedClipId === LIVE_BUFFER_ID) return;
    const clip = cachedClips.find((c) => c.id === selectedClipId);
    const clipName = clip ? clip.name : 'this recording';
    if (!window.confirm(`Permanently delete "${clipName}" from the video archive?`)) {
      return;
    }
    await deleteVideoClip(selectedClipId);
    selectedClipId = null;
    await refreshGalleryClips(true);
  });

  syncPlaybackReticleOverlay();
  syncSourceActionButtons();
  refreshGalleryClips(false).catch((err) => console.warn('Gallery clips refresh deferred:', err));
}
