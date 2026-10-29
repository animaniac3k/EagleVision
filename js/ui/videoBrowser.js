/**
 * Screen 2: Fullscreen Stored Video Player with Floating GUI Overlay
 *
 * Renders saved clips at 100% fullscreen in their native recorded resolution
 * with a collapsible left clip drawer and floating bottom transport bar.
 */
import { appState, updateState } from '../state.js';
import { listVideoClips, deleteVideoClip, exportClipToDisk } from '../storage/videoStore.js';

let cachedClips = [];
let selectedClipId = null;
let frameUrls = [];
let clipDuration = 0;
let playheadSec = 0;
let playbackSpeed = 1.0;
let isPlaying = false;
let lastTickMs = 0;
let rafId = null;
let lastDrawnIdx = -1;
let galleryZoom = 1.0;
let galleryPanX = 0;
let galleryPanY = 0;

const galleryImg = new Image();

function drawCurrentGalleryImage() {
  const canvasEl = document.getElementById('galleryPlayerCanvas');
  if (!canvasEl || !galleryImg.complete || !galleryImg.naturalWidth) return;
  const ctx = canvasEl.getContext('2d');
  const iw = galleryImg.naturalWidth;
  const ih = galleryImg.naturalHeight;
  const cw = canvasEl.width;
  const ch = canvasEl.height;

  const cropW = iw / galleryZoom;
  const cropH = ih / galleryZoom;
  const centerX = iw * (0.5 + galleryPanX);
  const centerY = ih * (0.5 + galleryPanY);
  const sx = Math.max(0, Math.min(iw - cropW, centerX - cropW / 2));
  const sy = Math.max(0, Math.min(ih - cropH, centerY - cropH / 2));

  ctx.clearRect(0, 0, cw, ch);
  ctx.drawImage(galleryImg, sx, sy, cropW, cropH, 0, 0, cw, ch);
}

function stopPlayerLoop() {
  if (rafId) {
    cancelAnimationFrame(rafId);
    rafId = null;
  }
}

function releaseFrameUrls() {
  frameUrls.forEach((u) => URL.revokeObjectURL(u));
  frameUrls = [];
  lastDrawnIdx = -1;
}

function renderGalleryFrame() {
  const canvasEl = document.getElementById('galleryPlayerCanvas');
  const scrubber = document.getElementById('galleryScrubber');
  const timeReadout = document.getElementById('galleryTimeReadout');
  const btnPlayPause = document.getElementById('btnGalleryPlayPause');
  if (!canvasEl) return;

  if (!frameUrls.length) {
    const ctx = canvasEl.getContext('2d');
    ctx.clearRect(0, 0, canvasEl.width, canvasEl.height);
    timeReadout.textContent = '0.0s / 0.0s';
    return;
  }

  const progress = clipDuration > 0 ? Math.max(0, Math.min(1, playheadSec / clipDuration)) : 0;
  const idx = Math.min(frameUrls.length - 1, Math.floor(progress * frameUrls.length));

  if (idx !== lastDrawnIdx && frameUrls[idx]) {
    lastDrawnIdx = idx;
    galleryImg.src = frameUrls[idx];
  }

  scrubber.value = String(playheadSec.toFixed(2));
  timeReadout.textContent = `${playheadSec.toFixed(1)}s / ${clipDuration.toFixed(1)}s`;
  btnPlayPause.textContent = isPlaying ? 'PAUSE ⏸' : 'PLAY ▶';
}

function galleryTickLoop(nowMs) {
  const screenGallery = document.getElementById('screenGallery');
  if (!screenGallery || screenGallery.classList.contains('hidden')) {
    stopPlayerLoop();
    return;
  }

  if (isPlaying && frameUrls.length > 0) {
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
    releaseFrameUrls();
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

  let currentClip = cachedClips.find((c) => c.id === selectedClipId);
  if (!currentClip || autoSelectFirst) {
    currentClip = cachedClips[0];
    selectClip(currentClip, true);
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
          <div>
            <div class="clip-name">${clip.name}</div>
            <div class="clip-meta">${clip.width}×${clip.height} • ${clip.durationSec}s (${clip.fps || 15} FPS) • ${mb} MB</div>
          </div>
          <span class="radar-btn radar-btn-sm ${isSelected ? 'radar-btn-active' : ''}">${isSelected ? 'ACTIVE' : 'LOAD'}</span>
        </div>
      `;
    })
    .join('');

  listEl.querySelectorAll('.clip-card[data-clip-id]').forEach((card) => {
    card.addEventListener('click', () => {
      const found = cachedClips.find((c) => c.id === card.dataset.clipId);
      if (found) {
        selectClip(found, true);
        renderClipList();
      }
    });
  });
}

function selectClip(clip, autoPlay = true) {
  stopPlayerLoop();
  releaseFrameUrls();

  selectedClipId = clip.id;
  const titleEl = document.getElementById('activeClipTitle');
  const metaEl = document.getElementById('activeClipMeta');
  const canvasEl = document.getElementById('galleryPlayerCanvas');
  const scrubber = document.getElementById('galleryScrubber');

  canvasEl.width = clip.width || 1920;
  canvasEl.height = clip.height || 1080;

  frameUrls = clip.jpegFrames.map((buf) =>
    URL.createObjectURL(new Blob([buf], { type: 'image/jpeg' }))
  );

  clipDuration = Math.max(0.5, clip.durationSec);
  playheadSec = 0;
  isPlaying = autoPlay;
  lastTickMs = performance.now();

  scrubber.max = String(clipDuration.toFixed(2));
  scrubber.value = '0';

  const mb = (clip.sizeBytes / (1024 * 1024)).toFixed(1);
  titleEl.textContent = clip.name;
  metaEl.textContent = `${clip.width}×${clip.height} @ ${clip.fps || 15} FPS • ${clip.durationSec}s • ${mb} MB`;

  renderGalleryFrame();
  rafId = requestAnimationFrame(galleryTickLoop);
}

export async function initVideoBrowser() {
  const screenLive = document.getElementById('screenLive');
  const screenGallery = document.getElementById('screenGallery');
  const btnSwitchScreen = document.getElementById('btnSwitchScreen');
  const btnBackToLive = document.getElementById('btnBackToLive');

  const galleryDrawer = document.getElementById('galleryDrawer');
  const btnToggleGalleryDrawer = document.getElementById('btnToggleGalleryDrawer');
  const btnCloseGalleryDrawer = document.getElementById('btnCloseGalleryDrawer');

  const canvasEl = document.getElementById('galleryPlayerCanvas');
  const ctx = canvasEl.getContext('2d');
  const scrubber = document.getElementById('galleryScrubber');
  const btnPlayPause = document.getElementById('btnGalleryPlayPause');
  const btnSlowMo = document.getElementById('btnGallerySlowMo');
  const btnStep = document.getElementById('btnGalleryStep');
  const btnDownload = document.getElementById('btnGalleryDownload');
  const btnDelete = document.getElementById('btnGalleryDelete');

  const btnZoomMinus = document.getElementById('galleryZoomMinus');
  const btnZoomPlus = document.getElementById('galleryZoomPlus');
  const btnZoomReset = document.getElementById('galleryZoomReset');
  const zoomBadge = document.getElementById('galleryZoomBadge');

  function syncGalleryZoomUI() {
    if (zoomBadge) zoomBadge.textContent = `${galleryZoom.toFixed(1)}x`;
    if (btnZoomReset) btnZoomReset.classList.toggle('hidden', galleryZoom <= 1.01);
    canvasEl.style.cursor = galleryZoom > 1.01 ? 'grab' : 'default';
    drawCurrentGalleryImage();
  }

  btnZoomMinus?.addEventListener('click', () => {
    galleryZoom = Math.max(1.0, Math.round((galleryZoom - 0.5) * 10) / 10);
    if (galleryZoom <= 1.01) {
      galleryPanX = 0;
      galleryPanY = 0;
    }
    syncGalleryZoomUI();
  });

  btnZoomPlus?.addEventListener('click', () => {
    galleryZoom = Math.min(8.0, Math.round((galleryZoom + 0.5) * 10) / 10);
    syncGalleryZoomUI();
  });

  btnZoomReset?.addEventListener('click', () => {
    galleryZoom = 1.0;
    galleryPanX = 0;
    galleryPanY = 0;
    syncGalleryZoomUI();
  });

  // Touch / Pointer Panning on Recorded Video when zoomed in (>1.0x)
  let panning = false;
  let panStartX = 0;
  let panStartY = 0;
  let startOffX = 0;
  let startOffY = 0;

  canvasEl.addEventListener('pointerdown', (e) => {
    if (galleryZoom <= 1.01) return;
    panning = true;
    panStartX = e.clientX;
    panStartY = e.clientY;
    startOffX = galleryPanX;
    startOffY = galleryPanY;
    canvasEl.setPointerCapture(e.pointerId);
  });

  canvasEl.addEventListener('pointermove', (e) => {
    if (!panning) return;
    const rect = canvasEl.getBoundingClientRect();
    const dx = (e.clientX - panStartX) / Math.max(1, rect.width);
    const dy = (e.clientY - panStartY) / Math.max(1, rect.height);
    const maxPan = Math.max(0, (1 - 1 / galleryZoom) / 2);
    galleryPanX = Math.max(-maxPan, Math.min(maxPan, startOffX - dx / galleryZoom));
    galleryPanY = Math.max(-maxPan, Math.min(maxPan, startOffY - dy / galleryZoom));
    drawCurrentGalleryImage();
  });

  const stopPan = () => { panning = false; };
  canvasEl.addEventListener('pointerup', stopPan);
  canvasEl.addEventListener('pointercancel', stopPan);

  galleryImg.onload = () => {
    drawCurrentGalleryImage();
  };

  function setDrawerOpen(open) {
    const next = typeof open === 'boolean' ? open : !appState.galleryDrawerOpen;
    updateState({ galleryDrawerOpen: next });
    galleryDrawer.classList.toggle('hidden', !next);
    btnToggleGalleryDrawer.classList.toggle('radar-btn-active', next);
  }

  btnToggleGalleryDrawer.addEventListener('click', () => setDrawerOpen());
  btnCloseGalleryDrawer.addEventListener('click', () => setDrawerOpen(false));

  btnSwitchScreen.addEventListener('click', async () => {
    screenLive.classList.add('hidden');
    screenGallery.classList.remove('hidden');
    updateState({ currentScreen: 'gallery' });
    await refreshGalleryClips(true);
  });

  btnBackToLive.addEventListener('click', () => {
    isPlaying = false;
    stopPlayerLoop();
    screenGallery.classList.add('hidden');
    screenLive.classList.remove('hidden');
    updateState({ currentScreen: 'live' });
  });

  btnPlayPause.addEventListener('click', () => {
    if (!frameUrls.length) return;
    isPlaying = !isPlaying;
    lastTickMs = performance.now();
    renderGalleryFrame();
  });

  btnSlowMo.addEventListener('click', () => {
    playbackSpeed = playbackSpeed < 0.9 ? 1.0 : 0.5;
    btnSlowMo.classList.toggle('radar-btn-active', playbackSpeed < 0.9);
  });

  btnStep.addEventListener('click', () => {
    if (!frameUrls.length) return;
    isPlaying = false;
    const stepSec = clipDuration / Math.max(1, frameUrls.length);
    playheadSec = (playheadSec + stepSec) % clipDuration;
    renderGalleryFrame();
  });

  scrubber.addEventListener('input', (e) => {
    playheadSec = parseFloat(e.target.value) || 0;
    lastTickMs = performance.now();
    renderGalleryFrame();
  });

  btnDownload.addEventListener('click', async () => {
    const clip = cachedClips.find((c) => c.id === selectedClipId);
    if (!clip) return;
    const orig = btnDownload.textContent;
    btnDownload.textContent = 'EXPORTING...';
    await exportClipToDisk(clip);
    btnDownload.textContent = orig;
  });

  btnDelete.addEventListener('click', async () => {
    if (!selectedClipId) return;
    await deleteVideoClip(selectedClipId);
    selectedClipId = null;
    await refreshGalleryClips(true);
  });

  await refreshGalleryClips(false);
}
