/**
 * Screen 2: Stored Video Browser & Frame-Accurate Canvas Player Controller
 */
import { updateState } from '../state.js';
import { listVideoClips, deleteVideoClip, exportClipToDisk } from '../storage/videoStore.js';

let cachedClips = [];
let selectedClipId = null;
let decodedBitmaps = [];
let clipDuration = 0;
let playheadSec = 0;
let playbackSpeed = 1.0;
let isPlaying = false;
let lastTickMs = 0;
let rafId = null;

function stopPlayerLoop() {
  if (rafId) {
    cancelAnimationFrame(rafId);
    rafId = null;
  }
}

function releaseDecodedBitmaps() {
  decodedBitmaps.forEach((bmp) => {
    if (bmp && bmp.close) bmp.close();
  });
  decodedBitmaps = [];
}

function renderGalleryFrame() {
  const canvasEl = document.getElementById('galleryPlayerCanvas');
  const scrubber = document.getElementById('galleryScrubber');
  const timeReadout = document.getElementById('galleryTimeReadout');
  const btnPlayPause = document.getElementById('btnGalleryPlayPause');
  if (!canvasEl) return;

  const ctx = canvasEl.getContext('2d');
  if (!decodedBitmaps.length) {
    ctx.clearRect(0, 0, canvasEl.width, canvasEl.height);
    timeReadout.textContent = '0.0s / 0.0s';
    return;
  }

  const progress = clipDuration > 0 ? Math.max(0, Math.min(1, playheadSec / clipDuration)) : 0;
  const idx = Math.min(decodedBitmaps.length - 1, Math.floor(progress * decodedBitmaps.length));
  const bmp = decodedBitmaps[idx];
  if (bmp) {
    ctx.clearRect(0, 0, canvasEl.width, canvasEl.height);
    ctx.drawImage(bmp, 0, 0, canvasEl.width, canvasEl.height);
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

  if (isPlaying && decodedBitmaps.length > 0) {
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
    releaseDecodedBitmaps();
    selectedClipId = null;
    listEl.innerHTML = `
      <div class="clip-card" style="cursor:default;">
        <div>
          <div class="clip-name">NO SAVED RECORDINGS</div>
          <div class="clip-meta">Tap REPLAY on the live feed to view & auto-save the last 20s.</div>
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
    await selectClip(currentClip, true);
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
            <div class="clip-meta">${clip.durationSec}s • ${mb} MB • ${clip.jpegFrames.length} FRAMES</div>
          </div>
          <span class="radar-btn radar-btn-sm ${isSelected ? 'radar-btn-active' : ''}">${isSelected ? 'PLAYING' : 'LOAD'}</span>
        </div>
      `;
    })
    .join('');

  listEl.querySelectorAll('.clip-card[data-clip-id]').forEach((card) => {
    card.addEventListener('click', async () => {
      const found = cachedClips.find((c) => c.id === card.dataset.clipId);
      if (found) {
        await selectClip(found, true);
        renderClipList();
      }
    });
  });
}

async function selectClip(clip, autoPlay = true) {
  stopPlayerLoop();
  releaseDecodedBitmaps();

  selectedClipId = clip.id;
  const titleEl = document.getElementById('activeClipTitle');
  const metaEl = document.getElementById('activeClipMeta');
  const canvasEl = document.getElementById('galleryPlayerCanvas');
  const scrubber = document.getElementById('galleryScrubber');

  canvasEl.width = clip.width || 854;
  canvasEl.height = clip.height || 480;

  decodedBitmaps = await Promise.all(
    clip.jpegFrames.map((buf) => createImageBitmap(new Blob([buf], { type: 'image/jpeg' })))
  );

  clipDuration = Math.max(0.5, clip.durationSec);
  playheadSec = 0;
  isPlaying = autoPlay;
  lastTickMs = performance.now();

  scrubber.max = String(clipDuration.toFixed(2));
  scrubber.value = '0';

  const mb = (clip.sizeBytes / (1024 * 1024)).toFixed(1);
  titleEl.textContent = clip.name;
  metaEl.textContent = `${clip.width}×${clip.height} • ${clip.durationSec}s • ${mb} MB`;

  renderGalleryFrame();
  rafId = requestAnimationFrame(galleryTickLoop);
}

export async function initVideoBrowser() {
  const screenLive = document.getElementById('screenLive');
  const screenGallery = document.getElementById('screenGallery');
  const btnSwitchScreen = document.getElementById('btnSwitchScreen');
  const btnBackToLive = document.getElementById('btnBackToLive');

  const scrubber = document.getElementById('galleryScrubber');
  const btnPlayPause = document.getElementById('btnGalleryPlayPause');
  const btnSlowMo = document.getElementById('btnGallerySlowMo');
  const btnStep = document.getElementById('btnGalleryStep');
  const btnDownload = document.getElementById('btnGalleryDownload');
  const btnDelete = document.getElementById('btnGalleryDelete');

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
    if (!decodedBitmaps.length) return;
    isPlaying = !isPlaying;
    lastTickMs = performance.now();
    renderGalleryFrame();
  });

  btnSlowMo.addEventListener('click', () => {
    playbackSpeed = playbackSpeed < 0.9 ? 1.0 : 0.5;
    btnSlowMo.classList.toggle('radar-btn-active', playbackSpeed < 0.9);
  });

  btnStep.addEventListener('click', () => {
    if (!decodedBitmaps.length) return;
    isPlaying = false;
    const stepSec = clipDuration / Math.max(1, decodedBitmaps.length);
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
