/**
 * Screen 2: Unified Review Controller (Playback + Spatial Hits Consolidated)
 *
 * Combines live RAM ring-buffer replay, saved IndexedDB clips, and spatial
 * detection hit pins onto a single aspect-matched fullscreen stage with:
 * - Time-synced hit pins (SYNC with video playhead, ALL, or OFF)
 * - Automatic still-snapshot fallback for earlier hits outside the rolling buffer
 * - Clickable numbered hit markers on both the target and CCTV timeline scrubber
 * - Unified slide-over drawer (Hits | Clips) + top-right Reticle, Pins, Re-Zero & Export
 */
import { appState, updateState, subscribeState } from '../state.js';
import { createJpegFramePlayer } from '../recorder/jpegFramePlayer.js';
import { snapshotMemoryBuffer } from '../recorder/memoryRingBuffer.js';
import {
  listVideoClips,
  getVideoClip,
  saveVideoClip,
  deleteVideoClip,
  exportClipToDisk
} from '../storage/videoStore.js';
import { renderCctvTrack } from './cctvScrubBar.js';
import { shouldHoldCanvasPan } from './ringController.js';
import {
  rezeroHeatmap,
  clearDetectionHits,
  exportAnnotatedCanvasPng
} from '../renderer/compositor.js';
import {
  renderReticleOverlayLayer,
  computeFfpMatchScale,
  computeReticleBaseScale,
  getLiveViewportDimensions
} from '../renderer/overlayManager.js';
import {
  formatHitClockTime,
  drawDisplayTimestampOnCanvas,
  drawHitTimestampBadge
} from '../renderer/timestampOverlay.js';
import {
  formatAgeShort,
  getAgeClass,
  mapHitToClip,
  findBestSavedClipForHit,
  projectNormToReviewPct
} from './detectionsScreen.js';
import { saveSettings } from '../storage/settingsStore.js';

const LIVE_BUFFER_ID = '__live_buffer__';

let cachedClips = [];
let activeBufferClip = null;
let activeLoadedClip = null; // Currently loaded video clip object (activeBufferClip or full saved clip)
let selectedClipId = null;
let stillOverrideHitId = null; // Non-null when displaying a hit's still snapshot instead of video
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
let syncGalleryZoomUiFn = null;
let renderReviewOverlayUiFn = null;
let openingLiveBuffer = false;

let activeClipWidth = 1920;
let activeClipHeight = 1080;
let activeClipWallStartMs = null;
let frameBoxW = 0;
let frameBoxH = 0;
let lastPinVisibilityKey = '';

function stopPlayerLoop() {
  if (rafId) {
    cancelAnimationFrame(rafId);
    rafId = null;
  }
}

function getHitsList() {
  return Array.isArray(appState.detectionHits) ? appState.detectionHits : [];
}

function getSelectedHit(hits = getHitsList()) {
  if (!hits.length) return null;
  return hits.find((h) => h.id === appState.selectedHitId) || hits[hits.length - 1];
}

function getPinMode() {
  const m = appState.reviewPinMode;
  return ['sync', 'all', 'off'].includes(m) ? m : 'sync';
}

function isInStillMode() {
  return Boolean(stillOverrideHitId) || (!activeLoadedClip && getHitsList().length > 0);
}

function getActiveStillHit() {
  const hits = getHitsList();
  if (!hits.length) return null;
  if (stillOverrideHitId) {
    const match = hits.find((h) => h.id === stillOverrideHitId);
    if (match) return match;
  }
  return getSelectedHit(hits);
}

function fitReviewFrameBox() {
  const stageEl = document.getElementById('galleryClipsStage');
  const boxEl = document.getElementById('reviewFrameBox');
  if (!stageEl || !boxEl || appState.currentScreen !== 'gallery') return;

  const availW = Math.max(240, stageEl.clientWidth || window.innerWidth);
  const availH = Math.max(160, stageEl.clientHeight || window.innerHeight);

  const stillHit = isInStillMode() ? getActiveStillHit() : null;
  const fw = (stillHit?.frameW) || activeClipWidth || appState.streamWidth || 16;
  const fh = (stillHit?.frameH) || activeClipHeight || appState.streamHeight || 9;
  const aspect = fw > 0 && fh > 0 ? fw / fh : 16 / 9;

  let bw = availW;
  let bh = bw / aspect;
  if (bh > availH) {
    bh = availH;
    bw = bh * aspect;
  }
  frameBoxW = Math.round(bw);
  frameBoxH = Math.round(bh);
  boxEl.style.width = `${frameBoxW}px`;
  boxEl.style.height = `${frameBoxH}px`;
}

function applyStillImageTransform() {
  const stillImg = document.getElementById('reviewStillImage');
  if (!stillImg || stillImg.classList.contains('hidden')) return;
  const z = Math.max(1.0, galleryZoom);
  const cropFrac = 1 / z;
  const halfCrop = cropFrac / 2;
  const clampedPanX = Math.max(-(0.5 - halfCrop), Math.min(0.5 - halfCrop, galleryPanX));
  const clampedPanY = Math.max(-(0.5 - halfCrop), Math.min(0.5 - halfCrop, galleryPanY));
  // Shift in opposite direction of pan center so still image matches jpegFramePlayer crop 1:1
  const txPct = -clampedPanX * z * 100;
  const tyPct = -clampedPanY * z * 100;
  stillImg.style.transform = `translate3d(${txPct.toFixed(3)}%, ${tyPct.toFixed(3)}%, 0) scale(${z.toFixed(3)})`;
}

function syncPlaybackReticleOverlay() {
  const layerEl = document.getElementById('galleryReticleLayer');
  const svgEl = document.getElementById('galleryReticleSvg');
  const customImg = document.getElementById('galleryReticleCustomImg');
  if (customImg && !customImg._ffpLoadWired) {
    customImg._ffpLoadWired = true;
    customImg.addEventListener('load', () => syncPlaybackReticleOverlay());
  }
  const boxEl = document.getElementById('reviewFrameBox') || document.getElementById('galleryClipsStage');
  const btnReticle = document.getElementById('btnTogglePlaybackReticle');
  const enabled = appState.overlayEnabled !== false;

  if (btnReticle) {
    btnReticle.textContent = 'Reticle';
    btnReticle.classList.toggle('radar-btn-active', enabled);
    btnReticle.setAttribute('aria-pressed', String(enabled));
    btnReticle.title = enabled ? 'Reticle Overlay: ON (click to hide)' : 'Reticle Overlay: OFF (click to show)';
  }

  const stillHit = isInStillMode() ? getActiveStillHit() : null;
  const stageW = frameBoxW || boxEl?.clientWidth || window.innerWidth || 1920;
  const stageH = frameBoxH || boxEl?.clientHeight || window.innerHeight || 1080;
  const frameW = stillHit?.frameW || activeClipWidth || appState.streamWidth || 1920;
  const frameH = stillHit?.frameH || activeClipHeight || appState.streamHeight || 1080;
  const useCustom = appState.overlayType === 'custom' && customImg?.naturalWidth > 0 && customImg?.naturalHeight > 0;
  const imgW = useCustom ? customImg.naturalWidth : 0;
  const imgH = useCustom ? customImg.naturalHeight : 0;

  const ffpMatchScale = computeFfpMatchScale({
    stageWidth: stageW,
    stageHeight: stageH,
    frameWidth: frameW,
    frameHeight: frameH,
    fitMode: 'contain',
    customImgWidth: imgW,
    customImgHeight: imgH
  });
  const liveDims = getLiveViewportDimensions();
  const liveBase = computeReticleBaseScale(liveDims.width, liveDims.height, imgW, imgH);
  const revBase = computeReticleBaseScale(stageW, stageH, imgW, imgH);
  const sfpMatchScale = revBase > 0 ? liveBase / revBase : 1.0;

  renderReticleOverlayLayer(layerEl, svgEl, customImg, appState, enabled, galleryZoom, {
    ffpMatchScale,
    sfpMatchScale
  });
}

function disarmDeleteBtn(btn) {
  if (!btn) return;
  if (btn._armTimer) {
    clearTimeout(btn._armTimer);
    btn._armTimer = null;
  }
  if (btn.dataset.armed === '1') {
    delete btn.dataset.armed;
    btn.classList.remove('radar-btn-armed');
    if (btn.dataset.origHtml !== undefined) {
      btn.innerHTML = btn.dataset.origHtml;
    }
  }
}

async function handleTwoTapDelete(btn, onConfirm) {
  if (!btn) return;
  if (btn.dataset.armed === '1') {
    disarmDeleteBtn(btn);
    await onConfirm();
    return;
  }
  btn.dataset.origHtml = btn.innerHTML;
  btn.dataset.armed = '1';
  btn.classList.add('radar-btn-armed');
  btn.textContent = 'Sure?';
  btn._armTimer = setTimeout(() => disarmDeleteBtn(btn), 2500);
}

function syncSourceActionButtons() {
  const stillMode = isInStillMode();
  const hasVideo = Boolean(activeLoadedClip && galleryPlayer?.getFrameCount() > 0);
  const isBuffer = !stillMode && selectedClipId === LIVE_BUFFER_ID && Boolean(activeBufferClip);
  const isSavedClip = !stillMode && Boolean(selectedClipId && selectedClipId !== LIVE_BUFFER_ID);
  const hasAnyFrame = hasVideo || (stillMode && Boolean(getActiveStillHit()?.thumbDataUrl));
  const hasHits = getHitsList().length > 0;

  const btnSaveBuffer = document.getElementById('btnSaveBufferClip');
  const btnDelete = document.getElementById('btnGalleryDelete');
  const btnDownload = document.getElementById('btnGalleryDownload');
  const btnSnapshot = document.getElementById('btnGallerySnapshot');
  const btnResumeVideo = document.getElementById('btnResumeVideoSource');
  const btnHitsClear = document.getElementById('btnHitsClear');

  if (btnSaveBuffer) btnSaveBuffer.classList.toggle('hidden', !isBuffer);
  if (btnDelete) {
    disarmDeleteBtn(btnDelete);
    btnDelete.classList.toggle('hidden', !isSavedClip);
    btnDelete.disabled = !isSavedClip;
  }
  if (btnDownload) {
    btnDownload.classList.toggle('hidden', !hasVideo || stillMode);
    btnDownload.disabled = !hasVideo || stillMode;
  }
  if (btnSnapshot) btnSnapshot.disabled = !hasAnyFrame;
  if (btnResumeVideo) {
    btnResumeVideo.classList.toggle('hidden', !(stillMode && hasVideo));
  }
  if (btnHitsClear) {
    btnHitsClear.disabled = !hasHits;
    btnHitsClear.classList.toggle('dock-btn-dimmed', !hasHits);
  }
}

function syncEventNavButtons() {
  const hasHits = getHitsList().length > 0;
  const hasEvents = Boolean(galleryEventNavHelper?.hasEvents);
  const hitNavGroup = document.getElementById('reviewHitNavGroup');
  const evtNavGroup = document.getElementById('reviewEvtNavGroup');
  const btnPrevEvt = document.getElementById('btnGalleryPrevEvt');
  const btnNextEvt = document.getElementById('btnGalleryNextEvt');

  if (hitNavGroup) hitNavGroup.classList.toggle('hidden', !hasHits);
  if (evtNavGroup) evtNavGroup.classList.toggle('hidden', hasHits || !hasEvents || isInStillMode());
  if (btnPrevEvt) btnPrevEvt.disabled = !hasEvents;
  if (btnNextEvt) btnNextEvt.disabled = !hasEvents;
}

function clearPlaybackTrackUI() {
  const waveformEl = document.getElementById('galleryWaveform');
  const markersEl = document.getElementById('galleryMarkers');
  const scrubber = document.getElementById('galleryScrubber');
  const btnPlayPause = document.getElementById('btnGalleryPlayPause');
  if (waveformEl) waveformEl.innerHTML = '';
  if (markersEl) markersEl.innerHTML = '';
  galleryEventNavHelper = null;
  clipDuration = 0;
  playheadSec = 0;
  isPlaying = false;
  lastTimeLabel = '';
  lastPlayBtnText = '';
  if (scrubber) {
    scrubber.max = '0';
    scrubber.value = '0';
  }
  if (btnPlayPause) {
    btnPlayPause.textContent = '▶';
  }
  syncEventNavButtons();
}

function getVisibleHitsForCurrentFrame() {
  const hits = getHitsList();
  const pinMode = getPinMode();
  if (!hits.length || pinMode === 'off') return [];

  const stillMode = isInStillMode();
  const clip = !stillMode ? activeLoadedClip : null;
  const result = [];

  hits.forEach((hit, idx) => {
    const num = idx + 1;
    if (stillMode || !clip) {
      result.push({ hit, num, status: 'landed', tSec: null });
      return;
    }
    const mapped = mapHitToClip(hit, clip);
    if (pinMode === 'sync') {
      if (mapped.relation === 'before') {
        result.push({ hit, num, status: 'prior', tSec: null });
      } else if (mapped.relation === 'inside' && playheadSec >= mapped.tSec - 0.08) {
        result.push({ hit, num, status: 'landed', tSec: mapped.tSec });
      }
      return;
    }
    // pinMode === 'all'
    if (mapped.relation === 'before') {
      result.push({ hit, num, status: 'prior', tSec: null });
    } else if (mapped.relation === 'inside') {
      const landed = playheadSec >= mapped.tSec - 0.08;
      result.push({ hit, num, status: landed ? 'landed' : 'future', tSec: mapped.tSec });
    } else {
      result.push({ hit, num, status: 'future', tSec: null });
    }
  });
  return result;
}

function renderReviewPins(forceRebuild = false) {
  const pinsLayer = document.getElementById('reviewPinsLayer');
  if (!pinsLayer || appState.currentScreen !== 'gallery') return;

  const pinMode = getPinMode();
  const visible = getVisibleHitsForCurrentFrame();
  const selectedHit = getSelectedHit();
  const selId = selectedHit?.id ?? null;
  const showTime = Boolean(appState.showHitTimestamps);

  // Fast key check avoids unnecessary DOM rebuilds at 60 FPS during video playback
  const key = `${pinMode}|${selId}|${showTime}|${galleryZoom.toFixed(2)}|${galleryPanX.toFixed(3)}|${galleryPanY.toFixed(3)}|` +
    visible.map((v) => `${v.hit.id}:${v.status}`).join(',');
  if (!forceRebuild && key === lastPinVisibilityKey) return;
  lastPinVisibilityKey = key;

  pinsLayer.classList.toggle('hidden', pinMode === 'off' || visible.length === 0);
  pinsLayer.innerHTML = '';
  if (pinMode === 'off' || !visible.length) return;

  const frag = document.createDocumentFragment();
  for (const item of visible) {
    const { hit, num, status } = item;
    const proj = projectNormToReviewPct(hit.normX, hit.normY, galleryZoom, galleryPanX, galleryPanY);
    if (!proj.inView) continue;

    const pin = document.createElement('button');
    pin.type = 'button';
    const isSel = hit.id === selId;
    const statusCls = status === 'prior' ? ' pin-prior' : (status === 'future' ? ' pin-future' : '');
    pin.className = `hit-pin ${getAgeClass(hit.timestampMs)}${statusCls}${isSel ? ' selected' : ''}`;
    pin.dataset.hitTs = String(hit.timestampMs || 0);
    pin.style.left = `${proj.leftPct.toFixed(2)}%`;
    pin.style.top = `${proj.topPct.toFixed(2)}%`;
    pin.textContent = String(num);
    pin.title = `Hit #${num} · ${hit.dirLabel || 'Hit'} — Click to inspect`;

    if (showTime && hit.timestampMs) {
      const timeBadge = document.createElement('span');
      timeBadge.className = 'hit-pin-time';
      timeBadge.textContent = formatHitClockTime(hit.timestampMs);
      pin.appendChild(timeBadge);
    }

    pin.addEventListener('pointerdown', (e) => e.stopPropagation());
    pin.addEventListener('click', (e) => {
      e.stopPropagation();
      selectAndJumpToHitFn?.(hit.id);
    });
    frag.appendChild(pin);
  }
  pinsLayer.appendChild(frag);
}

let selectAndJumpToHitFn = null;

function renderGalleryFrame() {
  const canvasEl = document.getElementById('galleryPlayerCanvas');
  const scrubber = document.getElementById('galleryScrubber');
  const timeReadout = document.getElementById('galleryTimeReadout');
  const btnPlayPause = document.getElementById('btnGalleryPlayPause');
  if (!canvasEl || !galleryPlayer) return;

  if (isInStillMode()) {
    renderReviewPins(false);
    return;
  }

  if (!galleryPlayer.getFrameCount()) {
    galleryPlayer.clearCanvas();
    if (lastTimeLabel !== '0.0s / 0.0s') {
      lastTimeLabel = '0.0s / 0.0s';
      if (timeReadout) timeReadout.textContent = lastTimeLabel;
    }
    if (btnPlayPause && lastPlayBtnText !== '▶') {
      lastPlayBtnText = '▶';
      btnPlayPause.textContent = '▶';
    }
    renderReviewPins(false);
    return;
  }

  const idx = galleryPlayer.getIndexForTime(playheadSec);
  if (idx >= 0) {
    galleryPlayer.showFrame(idx);
  }

  if (scrubber) scrubber.value = playheadSec.toFixed(2);
  const nextLabel = `${playheadSec.toFixed(1)}s / ${clipDuration.toFixed(1)}s`;
  if (nextLabel !== lastTimeLabel) {
    lastTimeLabel = nextLabel;
    if (timeReadout) timeReadout.textContent = nextLabel;
  }
  const nextPlayText = isPlaying ? '⏸' : '▶';
  if (nextPlayText !== lastPlayBtnText) {
    lastPlayBtnText = nextPlayText;
    if (btnPlayPause) btnPlayPause.textContent = nextPlayText;
  }

  // Update time-synced hit pins as playhead advances
  renderReviewPins(false);
}

function escapeHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function startPlayerLoopIfPlaying() {
  if (!isPlaying || rafId || isInStillMode()) return;
  lastTickMs = performance.now();
  rafId = requestAnimationFrame(galleryTickLoop);
}

function galleryTickLoop(nowMs) {
  rafId = null;
  const screenGallery = document.getElementById('screenGallery');
  if (!isPlaying || isInStillMode() || !screenGallery || screenGallery.classList.contains('hidden')) {
    return;
  }

  if (galleryPlayer && galleryPlayer.getFrameCount() > 0) {
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

function buildClipHitMarkers(clip) {
  const hits = getHitsList();
  if (!clip || !hits.length) return [];
  const selId = getSelectedHit(hits)?.id ?? null;
  const markers = [];
  hits.forEach((hit, idx) => {
    const mapped = mapHitToClip(hit, clip);
    if (mapped.relation === 'inside') {
      markers.push({
        id: hit.id,
        num: idx + 1,
        tSec: mapped.tSec,
        selected: hit.id === selId
      });
    }
  });
  return markers;
}

function rebuildTimelineTrack() {
  if (!activeLoadedClip || !clipDuration) return;
  const waveformEl = document.getElementById('galleryWaveform');
  const markersEl = document.getElementById('galleryMarkers');
  const timeline = activeLoadedClip.timeline || { soundPeaks: [], events: [] };
  const hitMarkers = buildClipHitMarkers(activeLoadedClip);

  galleryEventNavHelper = renderCctvTrack({
    waveformEl,
    markersEl,
    timeline,
    durationSec: clipDuration,
    hitMarkers,
    onSeek: (t) => {
      stillOverrideHitId = null;
      playheadSec = t;
      lastTickMs = performance.now();
      renderReviewOverlayUiFn?.();
      renderGalleryFrame();
    },
    onSelectHit: (hitId, tSec) => {
      stillOverrideHitId = null;
      isPlaying = false;
      stopPlayerLoop();
      playheadSec = tSec;
      lastTickMs = performance.now();
      updateState({ selectedHitId: hitId });
      renderReviewOverlayUiFn?.();
      renderGalleryFrame();
    }
  });
  syncEventNavButtons();
}

export async function refreshGalleryClips(autoSelectFirst = false) {
  cachedClips = await listVideoClips();
  const drawerClipsCount = document.getElementById('drawerClipsTabCount');
  if (drawerClipsCount) {
    drawerClipsCount.textContent = String(cachedClips.length + (activeBufferClip ? 1 : 0));
  }

  const listEl = document.getElementById('clipsList');
  const isViewingBuffer = selectedClipId === LIVE_BUFFER_ID && Boolean(activeBufferClip);

  if (!cachedClips.length && !activeBufferClip) {
    stopPlayerLoop();
    galleryPlayer?.unload();
    activeLoadedClip = null;
    selectedClipId = null;
    clearPlaybackTrackUI();
    if (listEl) {
      listEl.innerHTML = `
        <div class="clip-card" style="cursor:default;">
          <div>
            <div class="clip-name">NO SAVED RECORDINGS</div>
            <div class="clip-meta">Tap Replay on Live to inspect RAM buffer, or enable Auto-Save in Calibration.</div>
          </div>
        </div>
      `;
    }
    renderReviewOverlayUiFn?.();
    renderGalleryFrame();
    return;
  }

  const galleryVisible = appState.currentScreen === 'gallery';
  if (!isViewingBuffer) {
    let currentClip = cachedClips.find((c) => c.id === selectedClipId);
    if (galleryVisible && (!currentClip || autoSelectFirst)) {
      if (cachedClips.length) {
        currentClip = cachedClips[0];
        await selectClip(currentClip, true);
      } else if (activeBufferClip) {
        await selectClip(activeBufferClip, true);
      }
    } else if (!currentClip && cachedClips.length) {
      selectedClipId = cachedClips[0].id;
    }
  }

  renderClipList();
  renderReviewOverlayUiFn?.();
}

function renderClipList() {
  const listEl = document.getElementById('clipsList');
  const drawerClipsCount = document.getElementById('drawerClipsTabCount');
  if (drawerClipsCount) {
    drawerClipsCount.textContent = String(cachedClips.length + (activeBufferClip ? 1 : 0));
  }
  if (!listEl) return;
  const parts = [];

  if (activeBufferClip) {
    const mb = ((activeBufferClip.sizeBytes || 0) / (1024 * 1024)).toFixed(1);
    const isSelected = selectedClipId === LIVE_BUFFER_ID && !stillOverrideHitId;
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
    const isSelected = clip.id === selectedClipId && !stillOverrideHitId;
    const safeId = escapeHtml(clip.id);
    const safeName = escapeHtml(clip.name);
    parts.push(`
      <div class="clip-card ${isSelected ? 'active' : ''}" data-clip-id="${safeId}">
        <div style="flex:1; min-width:0; padding-right:8px;">
          <div class="clip-name">${safeName}</div>
          <div class="clip-meta">${clip.width}×${clip.height} • ${clip.durationSec}s (${clip.fps || 15} FPS) • ${mb} MB</div>
        </div>
        <button type="button" class="radar-btn btn-quick-delete-clip" data-delete-id="${safeId}" title="Delete ${safeName}" aria-label="Delete ${safeName}">
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

  if (!parts.length) {
    parts.push(`
      <div class="clip-card" style="cursor:default;">
        <div>
          <div class="clip-name">NO SAVED RECORDINGS</div>
          <div class="clip-meta">Tap Replay on Live to inspect RAM buffer.</div>
        </div>
      </div>
    `);
  }

  listEl.innerHTML = parts.join('');
}

function updateClipCardSelectionUI() {
  const listEl = document.getElementById('clipsList');
  if (!listEl) return;
  listEl.querySelectorAll('.clip-card[data-clip-id]').forEach((card) => {
    card.classList.toggle('active', !stillOverrideHitId && card.dataset.clipId === selectedClipId);
  });
}

async function selectClip(clip, autoPlay = true, initialSeekSec = 0) {
  stopPlayerLoop();
  galleryPlayer?.unload();
  clearPlaybackTrackUI();

  stillOverrideHitId = null;
  selectedClipId = clip.id;
  galleryZoom = 1.0;
  galleryPanX = 0;
  galleryPanY = 0;
  syncGalleryZoomUiFn?.();

  const canvasEl = document.getElementById('galleryPlayerCanvas');
  const scrubber = document.getElementById('galleryScrubber');

  activeClipWidth = clip.width || 1920;
  activeClipHeight = clip.height || 1080;
  if (canvasEl) {
    canvasEl.width = activeClipWidth;
    canvasEl.height = activeClipHeight;
  }

  clipDuration = Math.max(0.5, Number(clip.durationSec) || 0.5);
  playheadSec = Math.max(0, Math.min(clipDuration, Number(initialSeekSec) || 0));
  isPlaying = Boolean(autoPlay);
  lastTickMs = performance.now();
  lastTimeLabel = '';
  lastPlayBtnText = '';

  if (scrubber) {
    scrubber.max = String(clipDuration.toFixed(2));
    scrubber.value = playheadSec.toFixed(2);
  }

  const fullClip = clip.isBuffer ? clip : await getVideoClip(clip.id);
  if (!fullClip || !Array.isArray(fullClip.jpegFrames) || selectedClipId !== clip.id || appState.currentScreen !== 'gallery') {
    return;
  }

  activeLoadedClip = fullClip;
  const timeline = fullClip.timeline || clip.timeline || { soundPeaks: [], events: [] };
  activeClipWallStartMs = Number.isFinite(fullClip.startWallMs)
    ? fullClip.startWallMs
    : Number.isFinite(timeline.wallStartMs)
      ? timeline.wallStartMs
      : ((fullClip.createdAt || clip.createdAt || Date.now()) - Math.round((clipDuration || 0) * 1000));

  galleryPlayer?.load(fullClip.jpegFrames, clipDuration, fullClip.frameTimestamps || null);

  fitReviewFrameBox();
  syncPlaybackReticleOverlay();
  rebuildTimelineTrack();
  renderReviewOverlayUiFn?.();
  renderGalleryFrame();
  startPlayerLoopIfPlaying();
}

/**
 * Opens a RAM ring-buffer snapshot directly in the Unified Review screen (without auto-saving).
 */
export async function openLiveBufferInPlayer(snap) {
  if (!snap || !Array.isArray(snap.jpegFrames) || !snap.jpegFrames.length) return false;
  activeBufferClip = {
    id: LIVE_BUFFER_ID,
    isBuffer: true,
    name: 'LIVE BUFFER',
    createdAt: Date.now(),
    startTs: snap.startTs,
    endTs: snap.endTs,
    startWallMs: snap.startWallMs ?? snap.timeline?.wallStartMs ?? (Date.now() - Math.round((snap.durationSec || 0) * 1000)),
    endWallMs: snap.endWallMs ?? snap.timeline?.wallEndMs ?? Date.now(),
    jpegFrames: snap.jpegFrames,
    frameTimestamps: snap.frameTimestamps || null,
    fps: snap.fps || 15,
    durationSec: snap.durationSec,
    sizeBytes: snap.sizeBytes || 0,
    width: snap.width || 1920,
    height: snap.height || 1080,
    timeline: snap.timeline || { soundPeaks: [], events: [] }
  };
  stillOverrideHitId = null;
  selectedClipId = LIVE_BUFFER_ID;
  openingLiveBuffer = true;
  setDrawerOpenFn?.(false);
  updateState({ currentScreen: 'gallery' });
  openingLiveBuffer = false;
  await refreshGalleryClips(false);
  await selectClip(activeBufferClip, true, 0);
  renderClipList();
  return true;
}

export function initVideoBrowser() {
  const btnSwitchScreen = document.getElementById('btnSwitchScreen');
  const btnBackToLive = document.getElementById('btnBackToLive');

  const galleryStage = document.getElementById('galleryClipsStage');
  const galleryDrawer = document.getElementById('galleryDrawer');
  const btnToggleGalleryDrawer = document.getElementById('btnToggleGalleryDrawer');
  const btnCloseGalleryDrawer = document.getElementById('btnCloseGalleryDrawer');
  const drawerTabHits = document.getElementById('drawerTabHits');
  const drawerTabClips = document.getElementById('drawerTabClips');
  const drawerPanelHits = document.getElementById('drawerPanelHits');
  const drawerPanelClips = document.getElementById('drawerPanelClips');

  const canvasEl = document.getElementById('galleryPlayerCanvas');
  const stillImgEl = document.getElementById('reviewStillImage');
  const emptyBanner = document.getElementById('reviewEmptyBanner');

  galleryPlayer = createJpegFramePlayer(canvasEl, () => ({
    zoom: galleryZoom,
    panX: galleryPanX,
    panY: galleryPanY,
    showTimestamp: appState.showDisplayTimestamp !== false,
    baseWallMs: activeClipWallStartMs,
    tsPosition: appState.timestampPosition || 'bottom-right',
    tsOpacity: Math.max(0.15, Math.min(1, Number(appState.timestampOpacity ?? 60) / 100)),
    tsAdaptive: appState.timestampAdaptive !== false
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
  const btnToggleReviewPins = document.getElementById('btnToggleReviewPins');
  const btnToggleHitsTimestamps = document.getElementById('btnToggleHitsTimestamps');
  const btnHitsRezero = document.getElementById('btnHitsRezero');
  const btnHitsClear = document.getElementById('btnHitsClear');
  const btnResumeVideoSource = document.getElementById('btnResumeVideoSource');

  const btnPinModeSync = document.getElementById('btnPinModeSync');
  const btnPinModeAll = document.getElementById('btnPinModeAll');
  const btnPinModeOff = document.getElementById('btnPinModeOff');

  const btnHitPrev = document.getElementById('btnHitPrev');
  const btnHitNext = document.getElementById('btnHitNext');
  const hitSelectedSummary = document.getElementById('hitSelectedSummary');

  const btnZoomMinus = document.getElementById('galleryZoomMinus');
  const btnZoomPlus = document.getElementById('galleryZoomPlus');
  const btnZoomReset = document.getElementById('galleryZoomReset');
  const zoomBadge = document.getElementById('galleryZoomBadge');

  let ageTicker = null;

  function syncDrawerTabUI(tab = appState.reviewDrawerTab || 'hits') {
    const isHits = tab !== 'clips';
    drawerTabHits?.classList.toggle('active', isHits);
    drawerTabClips?.classList.toggle('active', !isHits);
    drawerPanelHits?.classList.toggle('hidden', !isHits);
    drawerPanelClips?.classList.toggle('hidden', isHits);
  }

  function syncPinModeUI() {
    const mode = getPinMode();
    if (btnToggleReviewPins) {
      const labelMap = { sync: 'Pins: SYNC', all: 'Pins: ALL', off: 'Pins: OFF' };
      btnToggleReviewPins.textContent = labelMap[mode] || 'Pins: SYNC';
      btnToggleReviewPins.classList.toggle('radar-btn-active', mode !== 'off');
    }
    btnPinModeSync?.classList.toggle('radar-btn-active', mode === 'sync');
    btnPinModeAll?.classList.toggle('radar-btn-active', mode === 'all');
    btnPinModeOff?.classList.toggle('radar-btn-active', mode === 'off');
  }

  function syncHitsTimestampsBtn() {
    const on = Boolean(appState.showHitTimestamps);
    if (btnToggleHitsTimestamps) {
      btnToggleHitsTimestamps.classList.toggle('radar-btn-active', on);
      btnToggleHitsTimestamps.setAttribute('aria-pressed', String(on));
      btnToggleHitsTimestamps.title = on
        ? 'Timestamp on Hits: ON — Tap to hide'
        : 'Timestamp on Hits: OFF — Tap to show';
    }
  }

  function renderHitsDrawerList() {
    const hits = getHitsList();
    const listEl = document.getElementById('hitsLogList');
    const drawerHitsBadge = document.getElementById('drawerHitsBadge');
    const drawerHitsTabCount = document.getElementById('drawerHitsTabCount');
    const countStr = String(hits.length);

    if (drawerHitsBadge) {
      drawerHitsBadge.textContent = countStr;
      drawerHitsBadge.classList.toggle('has-hits', hits.length > 0);
    }
    if (drawerHitsTabCount) {
      drawerHitsTabCount.textContent = countStr;
    }

    if (!listEl) return;
    if (!hits.length) {
      listEl.innerHTML = '<div style="padding:14px; font-size:12px; color:var(--radar-text-muted); text-align:center;">No motion hits recorded this session.</div>';
      return;
    }

    const selectedHit = getSelectedHit(hits);
    const showHitTime = Boolean(appState.showHitTimestamps);
    listEl.innerHTML = '';

    for (let i = hits.length - 1; i >= 0; i--) {
      const hit = hits[i];
      const num = i + 1;
      const isSel = selectedHit && hit.id === selectedHit.id;

      // Classify whether this hit is in active buffer, a saved clip, or still snapshot only
      let srcTag = 'STILL';
      let srcCls = 'src-still';
      if (activeBufferClip && mapHitToClip(hit, activeBufferClip).relation === 'inside') {
        srcTag = 'BUFFER';
        srcCls = 'src-buffer';
      } else if (activeLoadedClip && !activeLoadedClip.isBuffer && mapHitToClip(hit, activeLoadedClip).relation === 'inside') {
        srcTag = 'CLIP';
        srcCls = 'src-clip';
      } else if (findBestSavedClipForHit(hit, cachedClips)) {
        srcTag = 'CLIP';
        srcCls = 'src-clip';
      }

      const timeStr = showHitTime && hit.timestampMs ? `${formatHitClockTime(hit.timestampMs)} • ` : '';
      const row = document.createElement('div');
      row.className = `hits-log-row${isSel ? ' selected' : ''}`;

      const leftEl = document.createElement('div');
      leftEl.style.cssText = 'min-width:0; flex:1;';
      const topLine = document.createElement('div');
      topLine.style.cssText = 'font-size:12px; font-family:var(--font-mono); white-space:nowrap; overflow:hidden; text-overflow:ellipsis;';
      const numStrong = document.createElement('strong');
      numStrong.textContent = `#${num}`;
      topLine.appendChild(numStrong);
      topLine.appendChild(document.createTextNode(` • ${hit.dirLabel || 'Hit'}`));

      const ageSpan = document.createElement('div');
      ageSpan.className = 'hits-log-age';
      ageSpan.dataset.hitTs = String(hit.timestampMs || 0);
      ageSpan.dataset.timePrefix = timeStr;
      ageSpan.style.cssText = 'font-size:10.5px; color:var(--radar-text-muted); font-family:var(--font-mono); margin-top:2px;';
      ageSpan.textContent = `${timeStr}${formatAgeShort(hit.timestampMs)}`;

      leftEl.appendChild(topLine);
      leftEl.appendChild(ageSpan);

      const tagEl = document.createElement('span');
      tagEl.className = `hit-src-tag ${srcCls}`;
      tagEl.textContent = srcTag;

      row.appendChild(leftEl);
      row.appendChild(tagEl);

      row.addEventListener('click', () => {
        selectAndJumpToHit(hit.id);
        if (window.innerWidth <= 820) {
          setDrawerOpen(false);
        }
      });
      listEl.appendChild(row);
    }
  }

  function updateAgesInPlace() {
    const pinsLayer = document.getElementById('reviewPinsLayer');
    const listEl = document.getElementById('hitsLogList');
    if (pinsLayer) {
      pinsLayer.querySelectorAll('.hit-pin[data-hit-ts]').forEach((pin) => {
        const ts = Number(pin.dataset.hitTs);
        if (!ts) return;
        const nextAge = getAgeClass(ts);
        pin.classList.remove('pin-fresh', 'pin-warm', 'pin-stale');
        pin.classList.add(nextAge);
      });
    }
    if (listEl) {
      listEl.querySelectorAll('.hits-log-age[data-hit-ts]').forEach((span) => {
        const ts = Number(span.dataset.hitTs);
        if (!ts) return;
        span.textContent = `${span.dataset.timePrefix || ''}${formatAgeShort(ts)}`;
      });
    }
  }

  function renderReviewOverlayUI() {
    const hits = getHitsList();
    const stillMode = isInStillMode();
    const hasVideo = Boolean(activeLoadedClip && galleryPlayer?.getFrameCount() > 0);
    const hasNothing = !hasVideo && hits.length === 0;
    const stillHit = stillMode ? getActiveStillHit() : null;
    const selectedHit = getSelectedHit(hits);

    // 1. Toggle Video Canvas vs Still Snapshot vs Empty Banner
    if (emptyBanner) emptyBanner.classList.toggle('hidden', !hasNothing);
    if (canvasEl) canvasEl.classList.toggle('hidden', stillMode || !hasVideo);
    if (stillImgEl) {
      if (stillMode && stillHit?.thumbDataUrl) {
        if (stillImgEl.src !== stillHit.thumbDataUrl) {
          stillImgEl.src = stillHit.thumbDataUrl;
        }
        stillImgEl.classList.remove('hidden');
        applyStillImageTransform();
      } else {
        stillImgEl.classList.add('hidden');
      }
    }

    // 2. Top-Right Source Title & Meta
    const titleEl = document.getElementById('activeClipTitle');
    const metaEl = document.getElementById('activeClipMeta');
    if (titleEl && metaEl) {
      if (stillMode && stillHit) {
        const idx = hits.indexOf(stillHit) + 1;
        titleEl.textContent = `STILL · HIT #${idx}`;
        const clock = stillHit.timestampMs ? formatHitClockTime(stillHit.timestampMs) : '';
        metaEl.textContent = `${stillHit.dirLabel || 'Impact'}${clock ? ` • ${clock}` : ''}`;
      } else if (hasVideo && activeLoadedClip) {
        const mb = ((activeLoadedClip.sizeBytes || 0) / (1024 * 1024)).toFixed(1);
        if (activeLoadedClip.isBuffer) {
          titleEl.textContent = 'LIVE BUFFER';
          metaEl.textContent = `${activeLoadedClip.width}×${activeLoadedClip.height} @ ${activeLoadedClip.fps || 15} FPS • ${activeLoadedClip.durationSec}s • RAM`;
        } else {
          titleEl.textContent = activeLoadedClip.name;
          metaEl.textContent = `${activeLoadedClip.width}×${activeLoadedClip.height} @ ${activeLoadedClip.fps || 15} FPS • ${activeLoadedClip.durationSec}s • ${mb} MB`;
        }
      } else {
        titleEl.textContent = 'NO SOURCE';
        metaEl.textContent = '—';
      }
    }

    // 3. Bottom Bar Mode (Video Transport + Scrubber vs Still-Only Banner)
    const videoBtns = document.getElementById('reviewVideoBtns');
    const scrubWrap = document.getElementById('reviewScrubWrap');
    const stillBanner = document.getElementById('reviewStillBanner');
    const stillReason = document.getElementById('reviewStillReason');

    if (videoBtns) videoBtns.classList.toggle('hidden', stillMode || !hasVideo);
    if (scrubWrap) scrubWrap.classList.toggle('hidden', stillMode || !hasVideo);
    if (stillBanner) stillBanner.classList.toggle('hidden', !stillMode);
    if (stillReason) {
      stillReason.textContent = hasVideo
        ? 'Earlier hit outside loaded video — tap ▶ Video to resume playback'
        : 'Showing captured impact reference frame';
    }

    // 4. Hit Stepper & Floating Callout Chip
    if (hitSelectedSummary) {
      if (!selectedHit) {
        hitSelectedSummary.textContent = '—';
      } else {
        const idx = hits.indexOf(selectedHit) + 1;
        hitSelectedSummary.textContent = `#${idx}/${hits.length}`;
      }
    }
    if (btnHitPrev) btnHitPrev.disabled = !hits.length;
    if (btnHitNext) btnHitNext.disabled = !hits.length;

    const calloutEl = document.getElementById('reviewHitCallout');
    const calloutNum = document.getElementById('reviewHitCalloutNum');
    const calloutText = document.getElementById('reviewHitCalloutText');
    const calloutMeta = document.getElementById('reviewHitCalloutMeta');
    if (calloutEl) {
      const showCallout = Boolean(selectedHit && getPinMode() !== 'off' && appState.currentScreen === 'gallery');
      calloutEl.classList.toggle('hidden', !showCallout);
      if (showCallout && selectedHit) {
        const idx = hits.indexOf(selectedHit) + 1;
        if (calloutNum) calloutNum.textContent = `#${idx}`;
        if (calloutText) calloutText.textContent = selectedHit.dirLabel || 'Hit';
        if (calloutMeta) {
          const mapped = activeLoadedClip ? mapHitToClip(selectedHit, activeLoadedClip) : { relation: 'none' };
          if (!stillMode && mapped.relation === 'inside') {
            calloutMeta.textContent = `@ ${mapped.tSec.toFixed(1)}s`;
          } else if (selectedHit.timestampMs) {
            calloutMeta.textContent = formatHitClockTime(selectedHit.timestampMs);
          } else {
            calloutMeta.textContent = '';
          }
        }
      }
    }

    syncPinModeUI();
    syncHitsTimestampsBtn();
    syncSourceActionButtons();
    syncEventNavButtons();
    fitReviewFrameBox();
    syncPlaybackReticleOverlay();
    renderHitsDrawerList();
    renderReviewPins(true);
    updateClipCardSelectionUI();
  }
  renderReviewOverlayUiFn = renderReviewOverlayUI;

  async function selectAndJumpToHit(hitId) {
    const hits = getHitsList();
    const hit = hits.find((h) => h.id === hitId);
    if (!hit) return;

    // Ensure pins are visible when user explicitly jumps to a hit
    const patch = { selectedHitId: hit.id };
    if (getPinMode() === 'off') {
      patch.reviewPinMode = 'sync';
    }
    updateState(patch);

    // 1. If hit belongs to the currently loaded video (RAM buffer or saved clip), seek straight to it!
    if (activeLoadedClip && galleryPlayer?.getFrameCount() > 0) {
      const mapped = mapHitToClip(hit, activeLoadedClip);
      if (mapped.relation === 'inside') {
        stillOverrideHitId = null;
        isPlaying = false;
        stopPlayerLoop();
        playheadSec = mapped.tSec;
        lastTickMs = performance.now();
        rebuildTimelineTrack();
        renderReviewOverlayUI();
        renderGalleryFrame();
        return;
      }
    }

    // 2. If hit belongs to activeBufferClip (currently backgrounded while viewing another clip), switch back to buffer
    if (activeBufferClip && activeBufferClip !== activeLoadedClip) {
      const mappedBuf = mapHitToClip(hit, activeBufferClip);
      if (mappedBuf.relation === 'inside') {
        await selectClip(activeBufferClip, false, mappedBuf.tSec);
        return;
      }
    }

    // 3. Check if a saved IndexedDB clip covers this earlier hit
    const savedMatch = findBestSavedClipForHit(hit, cachedClips);
    if (savedMatch) {
      await selectClip(savedMatch.clip, false, savedMatch.tSec);
      return;
    }

    // 4. Fallback: earlier hit outside rolling RAM buffer & not in any saved clip -> show its stored still snapshot!
    isPlaying = false;
    stopPlayerLoop();
    stillOverrideHitId = hit.id;
    galleryZoom = 1.0;
    galleryPanX = 0;
    galleryPanY = 0;
    syncGalleryZoomUI();
    renderReviewOverlayUI();
  }
  selectAndJumpToHitFn = selectAndJumpToHit;

  function syncGalleryZoomUI() {
    if (zoomBadge) zoomBadge.textContent = `${galleryZoom.toFixed(1)}x`;
    if (btnZoomReset) btnZoomReset.classList.toggle('hidden', galleryZoom <= 1.01);
    if (galleryStage) galleryStage.style.cursor = galleryZoom > 1.01 ? 'grab' : 'default';
    if (isInStillMode()) {
      applyStillImageTransform();
    } else {
      galleryPlayer.draw();
    }
    syncPlaybackReticleOverlay();
    renderReviewPins(true);
  }
  syncGalleryZoomUiFn = syncGalleryZoomUI;

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

  galleryStage?.addEventListener('wheel', (e) => {
    if (appState.currentScreen !== 'gallery') return;
    if (e.target.closest('#galleryDrawer')) return;
    e.preventDefault();
    const step = e.deltaY < 0 ? 0.35 : -0.35;
    galleryZoom = Math.max(1.0, Math.min(8.0, Math.round((galleryZoom + step) * 20) / 20));
    if (galleryZoom <= 1.01) {
      galleryPanX = 0;
      galleryPanY = 0;
    }
    syncGalleryZoomUI();
  }, { passive: false });

  // Unified Pointer Panning on Video & Still Frame when zoomed (> 1.0x)
  let panning = false;
  let panPointerId = null;
  let panCommitted = false;
  let panStartTime = 0;
  let panStartX = 0;
  let panStartY = 0;
  let startOffX = 0;
  let startOffY = 0;

  galleryStage?.addEventListener('pointerdown', (e) => {
    if (e.target.closest('.hit-pin')) return;
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    if (galleryZoom <= 1.01 || panPointerId !== null) return;
    panning = true;
    panPointerId = e.pointerId;
    panStartTime = performance.now();
    panCommitted = !shouldHoldCanvasPan(panStartTime);
    panStartX = e.clientX;
    panStartY = e.clientY;
    startOffX = galleryPanX;
    startOffY = galleryPanY;
    galleryStage.style.cursor = 'grabbing';
    try {
      galleryStage.setPointerCapture(e.pointerId);
    } catch {}
  });

  galleryStage?.addEventListener('pointermove', (e) => {
    if (!panning || e.pointerId !== panPointerId) return;
    if (!panCommitted) {
      if (shouldHoldCanvasPan(panStartTime)) return;
      panCommitted = true;
      panStartX = e.clientX;
      panStartY = e.clientY;
    }
    const boxEl = document.getElementById('reviewFrameBox') || galleryStage;
    const rect = boxEl.getBoundingClientRect();
    const dx = (e.clientX - panStartX) / Math.max(1, rect.width);
    const dy = (e.clientY - panStartY) / Math.max(1, rect.height);
    const maxPan = Math.max(0, (1 - 1 / galleryZoom) / 2);
    galleryPanX = Math.max(-maxPan, Math.min(maxPan, startOffX - dx / galleryZoom));
    galleryPanY = Math.max(-maxPan, Math.min(maxPan, startOffY - dy / galleryZoom));
    if (isInStillMode()) {
      applyStillImageTransform();
    } else {
      galleryPlayer.draw();
    }
    renderReviewPins(true);
  });

  const stopPan = (e) => {
    if (panning && (!e || e.pointerId === undefined || e.pointerId === panPointerId)) {
      panning = false;
      panPointerId = null;
      if (galleryStage) galleryStage.style.cursor = galleryZoom > 1.01 ? 'grab' : 'default';
    }
  };
  galleryStage?.addEventListener('pointerup', stopPan);
  galleryStage?.addEventListener('pointercancel', stopPan);
  galleryStage?.addEventListener('lostpointercapture', stopPan);

  function setDrawerOpen(open) {
    const next = typeof open === 'boolean' ? open : !appState.galleryDrawerOpen;
    updateState({ galleryDrawerOpen: next });
    galleryDrawer?.classList.toggle('hidden', !next);
    btnToggleGalleryDrawer?.classList.toggle('radar-btn-active', next);
  }
  setDrawerOpenFn = setDrawerOpen;

  btnToggleGalleryDrawer?.addEventListener('click', () => setDrawerOpen());
  btnCloseGalleryDrawer?.addEventListener('click', () => setDrawerOpen(false));
  setDrawerOpen(Boolean(appState.galleryDrawerOpen));

  drawerTabHits?.addEventListener('click', () => {
    updateState({ reviewDrawerTab: 'hits' });
    syncDrawerTabUI('hits');
  });
  drawerTabClips?.addEventListener('click', () => {
    updateState({ reviewDrawerTab: 'clips' });
    syncDrawerTabUI('clips');
  });
  syncDrawerTabUI(appState.reviewDrawerTab || 'hits');

  // Pin reveal mode controls (top-right pill cycles SYNC -> ALL -> OFF; drawer buttons select directly)
  function setReviewPinMode(nextMode) {
    const valid = ['sync', 'all', 'off'].includes(nextMode) ? nextMode : 'sync';
    updateState({ reviewPinMode: valid });
    saveSettings(appState);
    renderReviewOverlayUI();
  }

  btnToggleReviewPins?.addEventListener('click', () => {
    const cur = getPinMode();
    const next = cur === 'sync' ? 'all' : (cur === 'all' ? 'off' : 'sync');
    setReviewPinMode(next);
  });
  btnPinModeSync?.addEventListener('click', () => setReviewPinMode('sync'));
  btnPinModeAll?.addEventListener('click', () => setReviewPinMode('all'));
  btnPinModeOff?.addEventListener('click', () => setReviewPinMode('off'));

  btnToggleHitsTimestamps?.addEventListener('click', () => {
    updateState({ showHitTimestamps: !appState.showHitTimestamps });
    saveSettings(appState);
  });

  btnHitsRezero?.addEventListener('click', () => {
    stillOverrideHitId = null;
    rezeroHeatmap();
    clearDetectionHits();
    rebuildTimelineTrack();
    renderReviewOverlayUI();
  });

  btnHitsClear?.addEventListener('click', () => {
    stillOverrideHitId = null;
    clearDetectionHits();
    rebuildTimelineTrack();
    renderReviewOverlayUI();
  });

  btnResumeVideoSource?.addEventListener('click', () => {
    stillOverrideHitId = null;
    galleryZoom = 1.0;
    galleryPanX = 0;
    galleryPanY = 0;
    syncGalleryZoomUI();
    renderReviewOverlayUI();
    renderGalleryFrame();
  });

  // Clips drawer list delegation
  const clipsListEl = document.getElementById('clipsList');
  clipsListEl?.addEventListener('click', (e) => {
    const delBtn = e.target.closest('.btn-quick-delete-clip');
    if (delBtn) {
      e.stopPropagation();
      const clipId = delBtn.dataset.deleteId;
      handleTwoTapDelete(delBtn, async () => {
        await deleteVideoClip(clipId);
        const wasSelected = selectedClipId === clipId;
        if (wasSelected) {
          selectedClipId = null;
          activeLoadedClip = null;
        }
        await refreshGalleryClips(wasSelected);
      });
      return;
    }
    const card = e.target.closest('.clip-card[data-clip-id]');
    if (!card) return;
    const cid = card.dataset.clipId;
    const found = cid === LIVE_BUFFER_ID ? activeBufferClip : cachedClips.find((c) => c.id === cid);
    if (found) {
      selectClip(found, true, 0);
      updateClipCardSelectionUI();
      if (window.innerWidth <= 820) setDrawerOpen(false);
    }
  });

  // Live Top-Right Simplified "Review" Pill: opens best available source (RAM buffer -> saved clip -> latest hit still)
  btnSwitchScreen?.addEventListener('click', async () => {
    stillOverrideHitId = null;
    if (appState.bufferEnabled) {
      const snap = await snapshotMemoryBuffer().catch(() => null);
      if (snap && snap.jpegFrames?.length) {
        const startWall = Number.isFinite(snap.startWallMs)
          ? snap.startWallMs
          : Math.round(snap.startTs + (Date.now() - performance.now()));
        const durMs = Math.max(0, Math.round((snap.durationSec || 0) * 1000));
        await openLiveBufferInPlayer({
          ...snap,
          timeline: {
            ...(snap.timeline || { soundPeaks: [], events: [] }),
            wallStartMs: startWall,
            wallEndMs: Number.isFinite(snap.endWallMs) ? snap.endWallMs : startWall + durMs
          }
        });
        return;
      }
    }
    updateState({ currentScreen: 'gallery' });
  });

  btnBackToLive?.addEventListener('click', () => {
    isPlaying = false;
    stopPlayerLoop();
    galleryPlayer.unload();
    activeBufferClip = null;
    activeLoadedClip = null;
    stillOverrideHitId = null;
    if (selectedClipId === LIVE_BUFFER_ID) selectedClipId = null;
    galleryZoom = 1.0;
    galleryPanX = 0;
    galleryPanY = 0;
    clearPlaybackTrackUI();
    updateState({ currentScreen: 'live' });
  });

  btnTogglePlaybackReticle?.addEventListener('click', () => {
    updateState({ overlayEnabled: !(appState.overlayEnabled !== false) });
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
        startWallMs: activeBufferClip.startWallMs,
        fps: activeBufferClip.fps,
        durationSec: activeBufferClip.durationSec,
        sizeBytes: activeBufferClip.sizeBytes,
        width: activeBufferClip.width,
        height: activeBufferClip.height,
        timeline: activeBufferClip.timeline
      });
      activeLoadedClip = { ...activeBufferClip, ...savedMeta, isBuffer: false };
      activeBufferClip = null;
      selectedClipId = savedMeta.id;
      await refreshGalleryClips(false);
      renderClipList();
      renderReviewOverlayUI();
    } catch (err) {
      console.warn('Save buffer clip failed:', err);
    } finally {
      btnSaveBufferClip.disabled = false;
      btnSaveBufferClip.textContent = orig;
    }
  });

  // Hit Stepper (◀ Hit / Hit ▶)
  btnHitPrev?.addEventListener('click', () => {
    const hits = getHitsList();
    if (!hits.length) return;
    const cur = getSelectedHit(hits);
    const idx = hits.indexOf(cur);
    const prevIdx = idx <= 0 ? hits.length - 1 : idx - 1;
    selectAndJumpToHit(hits[prevIdx].id);
  });

  btnHitNext?.addEventListener('click', () => {
    const hits = getHitsList();
    if (!hits.length) return;
    const cur = getSelectedHit(hits);
    const idx = hits.indexOf(cur);
    const nextIdx = (idx + 1) % hits.length;
    selectAndJumpToHit(hits[nextIdx].id);
  });

  subscribeState((state, patch = {}) => {
    if (patch.currentScreen !== undefined && state.currentScreen !== 'gallery') {
      if (isPlaying || galleryPlayer.getFrameCount() > 0 || galleryEventNavHelper || activeBufferClip || stillOverrideHitId) {
        isPlaying = false;
        stopPlayerLoop();
        galleryPlayer.unload();
        activeBufferClip = null;
        activeLoadedClip = null;
        stillOverrideHitId = null;
        if (selectedClipId === LIVE_BUFFER_ID) selectedClipId = null;
        galleryZoom = 1.0;
        galleryPanX = 0;
        galleryPanY = 0;
        clearPlaybackTrackUI();
      }
    }
    if (
      state.currentScreen === 'gallery' &&
      (patch.overlayEnabled !== undefined ||
        patch.overlayType !== undefined ||
        patch.overlayOpacity !== undefined ||
        patch.overlayScale !== undefined ||
        patch.reticleFfpMode !== undefined ||
        patch.customOverlayUrl !== undefined ||
        patch.reticleConfig !== undefined ||
        patch.themeColor !== undefined)
    ) {
      syncPlaybackReticleOverlay();
    }
    if (
      patch.detectionHits !== undefined ||
      patch.selectedHitId !== undefined ||
      patch.showHitTimestamps !== undefined ||
      patch.reviewPinMode !== undefined
    ) {
      if (state.currentScreen === 'gallery') {
        if (patch.detectionHits !== undefined || patch.selectedHitId !== undefined) {
          rebuildTimelineTrack();
        }
        renderReviewOverlayUI();
      } else {
        renderHitsDrawerList();
      }
    }
    if (state.currentScreen === 'gallery' && !openingLiveBuffer && patch.currentScreen === 'gallery') {
      requestAnimationFrame(() => {
        fitReviewFrameBox();
        if (selectedClipId === LIVE_BUFFER_ID && activeBufferClip) {
          if (!galleryPlayer.getFrameCount()) {
            selectClip(activeBufferClip, true, 0);
          }
          refreshGalleryClips(false).catch(() => {});
        } else {
          refreshGalleryClips(true).catch(() => {});
        }
        renderReviewOverlayUI();
      });
    }
  });

  btnPlayPause?.addEventListener('click', () => {
    if (isInStillMode()) {
      if (activeLoadedClip && galleryPlayer.getFrameCount() > 0) {
        stillOverrideHitId = null;
        isPlaying = true;
        lastTickMs = performance.now();
        renderReviewOverlayUI();
        renderGalleryFrame();
        startPlayerLoopIfPlaying();
      }
      return;
    }
    if (!galleryPlayer.getFrameCount()) return;
    isPlaying = !isPlaying;
    lastTickMs = performance.now();
    renderGalleryFrame();
    if (isPlaying) {
      startPlayerLoopIfPlaying();
    } else {
      stopPlayerLoop();
    }
  });

  btnSlowMo?.addEventListener('click', () => {
    playbackSpeed = playbackSpeed < 0.9 ? 1.0 : 0.5;
    btnSlowMo.classList.toggle('radar-btn-active', playbackSpeed < 0.9);
  });

  function stepGalleryFrame(delta) {
    const totalFrames = galleryPlayer.getFrameCount();
    if (!totalFrames || isInStillMode()) return;
    isPlaying = false;
    stopPlayerLoop();
    const currentIdx = galleryPlayer.getCurrentIndex() >= 0
      ? galleryPlayer.getCurrentIndex()
      : Math.max(0, galleryPlayer.getIndexForTime(playheadSec));
    let nextIdx = currentIdx + delta;
    if (nextIdx < 0) nextIdx = totalFrames - 1;
    if (nextIdx >= totalFrames) nextIdx = 0;

    playheadSec = galleryPlayer.getTimeForIndex(nextIdx);
    galleryPlayer.showFrame(nextIdx);

    if (scrubber) scrubber.value = playheadSec.toFixed(2);
    lastTimeLabel = `${playheadSec.toFixed(1)}s / ${clipDuration.toFixed(1)}s`;
    const readout = document.getElementById('galleryTimeReadout');
    if (readout) readout.textContent = lastTimeLabel;
    lastPlayBtnText = '▶';
    if (btnPlayPause) btnPlayPause.textContent = '▶';
    lastTickMs = performance.now();
    renderReviewPins(false);
  }

  btnStepBack?.addEventListener('click', () => stepGalleryFrame(-1));
  btnStep?.addEventListener('click', () => stepGalleryFrame(1));

  const btnPrevEvt = document.getElementById('btnGalleryPrevEvt');
  const btnNextEvt = document.getElementById('btnGalleryNextEvt');
  btnPrevEvt?.addEventListener('click', () => {
    if (!galleryEventNavHelper || isInStillMode()) return;
    const prev = galleryEventNavHelper.getPrevEvent(playheadSec);
    if (prev !== null) {
      playheadSec = prev;
      lastTickMs = performance.now();
      renderGalleryFrame();
    }
  });

  btnNextEvt?.addEventListener('click', () => {
    if (!galleryEventNavHelper || isInStillMode()) return;
    const next = galleryEventNavHelper.getNextEvent(playheadSec);
    if (next !== null) {
      playheadSec = next;
      lastTickMs = performance.now();
      renderGalleryFrame();
    }
  });

  scrubber?.addEventListener('input', (e) => {
    if (isPlaying) {
      isPlaying = false;
      stopPlayerLoop();
    }
    playheadSec = parseFloat(e.target.value) || 0;
    lastTickMs = performance.now();
    renderGalleryFrame();
  });

  // Unified Annotated PNG Snapshot (bakes current Video OR Still frame + Reticle + Visible Pins + Timestamps)
  const btnGallerySnapshot = document.getElementById('btnGallerySnapshot');
  btnGallerySnapshot?.addEventListener('click', async () => {
    const stillMode = isInStillMode();
    const stillHit = stillMode ? getActiveStillHit() : null;
    const visiblePins = getVisibleHitsForCurrentFrame();
    const selectedHit = getSelectedHit();

    let sourceCanvas = canvasEl;
    if (stillMode) {
      const cw = stillHit?.frameW || appState.streamWidth || 1280;
      const ch = stillHit?.frameH || appState.streamHeight || 720;
      const tempCanvas = document.createElement('canvas');
      tempCanvas.width = cw;
      tempCanvas.height = ch;
      const tctx = tempCanvas.getContext('2d');
      if (!tctx) return;
      tctx.fillStyle = '#0b1017';
      tctx.fillRect(0, 0, cw, ch);
      if (stillImgEl && !stillImgEl.classList.contains('hidden') && stillImgEl.complete && stillImgEl.naturalWidth) {
        const iw = stillImgEl.naturalWidth;
        const ih = stillImgEl.naturalHeight;
        const z = Math.max(1.0, galleryZoom);
        const cropW = iw / z;
        const cropH = ih / z;
        const sx = Math.max(0, Math.min(iw - cropW, iw * (0.5 + galleryPanX) - cropW / 2));
        const sy = Math.max(0, Math.min(ih - cropH, ih * (0.5 + galleryPanY) - cropH / 2));
        tctx.drawImage(stillImgEl, sx, sy, cropW, cropH, 0, 0, cw, ch);
      }
      sourceCanvas = tempCanvas;
    }

    await exportAnnotatedCanvasPng(sourceCanvas, {
      includeReticle: appState.overlayEnabled !== false,
      reticleZoom: galleryZoom,
      matchLiveFfp: true,
      prefix: stillMode ? 'SPOTR_Hits' : 'SPOTR_Review',
      drawExtra: async (ctx, w, h) => {
        ctx.save();
        for (const item of visiblePins) {
          const { hit, num } = item;
          const proj = projectNormToReviewPct(hit.normX, hit.normY, galleryZoom, galleryPanX, galleryPanY);
          if (!proj.inView) continue;
          const px = (proj.leftPct / 100) * w;
          const py = (proj.topPct / 100) * h;
          const isSel = selectedHit && hit.id === selectedHit.id;
          ctx.beginPath();
          ctx.arc(px, py, isSel ? 16 : 13, 0, Math.PI * 2);
          ctx.fillStyle = isSel ? '#f97316' : '#f59e0b';
          ctx.fill();
          ctx.lineWidth = 2.5;
          ctx.strokeStyle = isSel ? '#ffffff' : '#0b0f17';
          ctx.stroke();
          ctx.fillStyle = '#0b0f17';
          ctx.font = 'bold 13px monospace';
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.fillText(String(num), px, py);
          if (appState.showHitTimestamps && hit.timestampMs) {
            drawHitTimestampBadge(ctx, px, py, isSel ? 16 : 13, hit.timestampMs, w, h);
          }
        }
        if (stillMode && appState.showDisplayTimestamp !== false) {
          drawDisplayTimestampOnCanvas(ctx, w, h, stillHit?.timestampMs || Date.now(), {
            position: appState.timestampPosition || 'bottom-right',
            opacity: (appState.timestampOpacity ?? 60) / 100,
            adaptive: appState.timestampAdaptive !== false,
            isLive: false
          });
        }
        ctx.restore();
      }
    });
  });

  btnDownload?.addEventListener('click', async () => {
    if (!selectedClipId || btnDownload.disabled || isInStillMode()) return;
    const orig = btnDownload.textContent;
    btnDownload.disabled = true;
    btnDownload.textContent = 'EXPORTING...';
    try {
      const clip = selectedClipId === LIVE_BUFFER_ID && activeBufferClip
        ? {
            ...activeBufferClip,
            name: `LIVE_BUFFER_${Date.now()}.WEBM`
          }
        : await getVideoClip(selectedClipId);
      if (!clip) return;
      await exportClipToDisk(clip);
    } catch (err) {
      console.warn('Export clip failed:', err);
    } finally {
      btnDownload.disabled = false;
      btnDownload.textContent = orig;
    }
  });

  btnDelete?.addEventListener('click', () => {
    if (!selectedClipId || selectedClipId === LIVE_BUFFER_ID) return;
    handleTwoTapDelete(btnDelete, async () => {
      await deleteVideoClip(selectedClipId);
      selectedClipId = null;
      activeLoadedClip = null;
      await refreshGalleryClips(true);
    });
  });

  window.addEventListener('resize', () => {
    if (appState.currentScreen === 'gallery') {
      fitReviewFrameBox();
      syncPlaybackReticleOverlay();
      renderReviewPins(true);
    }
  });

  ageTicker = setInterval(() => {
    if (appState.currentScreen === 'gallery' && getHitsList().length > 0) {
      updateAgesInPlace();
    }
  }, 5000);

  syncPinModeUI();
  syncHitsTimestampsBtn();
  syncPlaybackReticleOverlay();
  syncSourceActionButtons();
  syncEventNavButtons();
  renderHitsDrawerList();
  refreshGalleryClips(false).catch((err) => console.warn('Gallery clips refresh deferred:', err));
}
