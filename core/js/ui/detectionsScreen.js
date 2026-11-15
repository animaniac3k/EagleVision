/**
 * Compact Detections Map & Log Controller (inside Screen 2 Archive: Clips | Hits)
 *
 * Visualizes spatial heatmap hits as numbered pins on a responsive aspect-matched
 * reference frame, with collapsible Log drawer, ignore-zone masking, Re-Zero,
 * Aim Loupe jump, 5s Replay lookup, and annotated PNG export.
 */
import { appState, updateState } from '../state.js';
import {
  rezeroHeatmap,
  clearDetectionHits,
  addHeatmapIgnoreZone,
  clearHeatmapIgnoreZones,
  exportAnnotatedCanvasPng
} from '../renderer/compositor.js';
import { openReplayAtTimestamp } from '../recorder/instantReplay.js';
import { saveSettings } from '../storage/settingsStore.js';

let initialized = false;

function formatAgeShort(tsMs) {
  const sec = Math.max(0, Math.round((Date.now() - tsMs) / 1000));
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m`;
  return `${Math.floor(min / 60)}h`;
}

function getAgeClass(tsMs) {
  const sec = (Date.now() - tsMs) / 1000;
  if (sec <= 60) return 'pin-fresh';
  if (sec <= 300) return 'pin-warm';
  return 'pin-stale';
}

/**
 * Aims the digital Loupe crosshair onto a normalized source frame coordinate and opens Live view.
 */
export function aimLoupeAtHit(hit) {
  if (!hit) return false;
  const nx = Math.max(0.02, Math.min(0.98, Number(hit.normX) || 0.5));
  const ny = Math.max(0.02, Math.min(0.98, Number(hit.normY) || 0.5));
  const zoom = Math.max(1.0, appState.mainZoom || 1.0);

  const vw = hit.frameW || appState.streamWidth || 1920;
  const vh = hit.frameH || appState.streamHeight || 1080;
  const mainCanvas = document.getElementById('mainCanvas');
  const cw = mainCanvas?.width || window.innerWidth || vw;
  const ch = mainCanvas?.height || window.innerHeight || vh;

  const videoAspect = vw / Math.max(1, vh);
  const canvasAspect = cw / Math.max(1, ch);
  let baseW = vw;
  let baseH = vh;
  if (canvasAspect > videoAspect) {
    baseH = vw / canvasAspect;
  } else {
    baseW = vh * canvasAspect;
  }

  const cropW = baseW / zoom;
  const cropH = baseH / zoom;
  const targetSourceX = nx * vw;
  const targetSourceY = ny * vh;

  let nextPanX = appState.mainPanX || 0;
  let nextPanY = appState.mainPanY || 0;

  if (zoom > 1.01) {
    nextPanX = nx - 0.5;
    nextPanY = ny - 0.5;
  } else {
    // Keep current pan unless aspect cropping puts the hit outside visible main canvas bounds
    const curCenterX = vw * (0.5 + nextPanX);
    const curCenterY = vh * (0.5 + nextPanY);
    if (Math.abs(targetSourceX - curCenterX) > cropW * 0.45) {
      nextPanX = nx - 0.5;
    }
    if (Math.abs(targetSourceY - curCenterY) > cropH * 0.45) {
      nextPanY = ny - 0.5;
    }
  }

  const centerX = vw * (0.5 + nextPanX);
  const centerY = vh * (0.5 + nextPanY);
  const sx = Math.max(0, Math.min(vw - cropW, centerX - cropW / 2));
  const sy = Math.max(0, Math.min(vh - cropH, centerY - cropH / 2));

  // Normalize actual clamped pan back cleanly
  nextPanX = (sx + cropW / 2) / vw - 0.5;
  nextPanY = (sy + cropH / 2) / vh - 0.5;

  const roiX = Math.max(0.04, Math.min(0.96, (targetSourceX - sx) / Math.max(1, cropW)));
  const roiY = Math.max(0.04, Math.min(0.96, (targetSourceY - sy) / Math.max(1, cropH)));

  updateState({
    mainPanX: nextPanX,
    mainPanY: nextPanY,
    roiX,
    roiY,
    pipEnabled: true,
    roiTargetVisible: true,
    currentScreen: 'live'
  });
  return true;
}

/**
 * Convenience shortcut: snaps the Loupe to the newest logged motion hit (or re-arms Live).
 */
export function snapLoupeToLatestHit() {
  const hits = Array.isArray(appState.detectionHits) ? appState.detectionHits : [];
  if (!hits.length) return false;
  const latest = hits[hits.length - 1];
  updateState({ selectedHitId: latest.id });
  return aimLoupeAtHit(latest);
}

export function initDetectionsScreen(subscribeState) {
  if (initialized) return;
  initialized = true;

  const btnOpenHitsTab = document.getElementById('btnOpenHitsTab');
  const hitCountBadge = document.getElementById('hitCountBadge');
  const heatmapHitBadge = document.getElementById('heatmapHitBadge');
  const galleryHitsCountBadge = document.getElementById('galleryHitsCountBadge');

  const tabArchiveClips = document.getElementById('tabArchiveClips');
  const tabArchiveHits = document.getElementById('tabArchiveHits');

  const galleryClipsStage = document.getElementById('galleryClipsStage');
  const galleryZoomPod = document.getElementById('galleryZoomPod');
  const galleryClipInfoPill = document.getElementById('galleryClipInfoPill');
  const btnToggleGalleryDrawer = document.getElementById('btnToggleGalleryDrawer');
  const galleryDrawer = document.getElementById('galleryDrawer');
  const galleryClipsBar = document.getElementById('galleryClipsBar');

  const hitsStage = document.getElementById('hitsStage');
  const hitsMapViewport = document.getElementById('hitsMapViewport');
  const hitsTransformLayer = document.getElementById('hitsTransformLayer');
  const hitsRefImage = document.getElementById('hitsRefImage');
  const hitsEmptyBanner = document.getElementById('hitsEmptyBanner');
  const hitsIgnoreLayer = document.getElementById('hitsIgnoreLayer');
  const hitsDrawPreview = document.getElementById('hitsDrawPreview');
  const hitsPinsLayer = document.getElementById('hitsPinsLayer');
  const hitsTopRightPill = document.getElementById('hitsTopRightPill');
  const btnToggleHitsDrawer = document.getElementById('btnToggleHitsDrawer');
  const hitsDrawer = document.getElementById('hitsDrawer');
  const btnCloseHitsDrawer = document.getElementById('btnCloseHitsDrawer');
  const hitsLogList = document.getElementById('hitsLogList');
  const hitsBottomBar = document.getElementById('hitsBottomBar');

  const btnZoomMinus = document.getElementById('galleryZoomMinus');
  const btnZoomPlus = document.getElementById('galleryZoomPlus');
  const btnZoomReset = document.getElementById('galleryZoomReset');
  const zoomBadge = document.getElementById('galleryZoomBadge');

  const btnToggleMaskDraw = document.getElementById('btnToggleMaskDraw');
  const btnClearMasks = document.getElementById('btnClearMasks');
  const btnHitsRezero = document.getElementById('btnHitsRezero');
  const btnHitsClear = document.getElementById('btnHitsClear');

  const btnHitPrev = document.getElementById('btnHitPrev');
  const btnHitNext = document.getElementById('btnHitNext');
  const hitSelectedSummary = document.getElementById('hitSelectedSummary');
  const btnHitAimLoupe = document.getElementById('btnHitAimLoupe');
  const btnHitPlayClip = document.getElementById('btnHitPlayClip');
  const btnHitIgnoreArea = document.getElementById('btnHitIgnoreArea');
  const btnHitSnapshot = document.getElementById('btnHitSnapshot');

  let maskDrawActive = false;
  let hitsDrawerOpen = false;
  let drawStart = null;
  let ageTicker = null;
  let hitsZoom = 1.0;
  let hitsPanPxX = 0;
  let hitsPanPxY = 0;
  let hitsLayerW = 0;
  let hitsLayerH = 0;
  let hitsPanning = false;
  let hitsPanStartX = 0;
  let hitsPanStartY = 0;
  let hitsStartOffX = 0;
  let hitsStartOffY = 0;

  function applyHitsTransform() {
    const isHitsActive = appState.currentScreen === 'gallery' && appState.galleryArchiveTab === 'hits';
    if (isHitsActive) {
      if (zoomBadge) zoomBadge.textContent = `${hitsZoom.toFixed(1)}x`;
      if (btnZoomReset) btnZoomReset.classList.toggle('hidden', hitsZoom <= 1.01);
    }
    if (!hitsTransformLayer || !hitsMapViewport) return;

    if (hitsZoom <= 1.01) {
      hitsPanPxX = 0;
      hitsPanPxY = 0;
    } else {
      const vpW = hitsMapViewport.clientWidth || hitsLayerW;
      const vpH = hitsMapViewport.clientHeight || hitsLayerH;
      const maxPanX = Math.max(0, (hitsLayerW * hitsZoom - vpW) / 2);
      const maxPanY = Math.max(0, (hitsLayerH * hitsZoom - vpH) / 2);
      hitsPanPxX = Math.max(-maxPanX, Math.min(maxPanX, hitsPanPxX));
      hitsPanPxY = Math.max(-maxPanY, Math.min(maxPanY, hitsPanPxY));
    }

    const invPinScale = 1 / Math.pow(Math.max(1, hitsZoom), 0.72);
    hitsTransformLayer.style.setProperty('--hits-inv-scale', invPinScale.toFixed(3));
    hitsTransformLayer.style.transform = `translate3d(${hitsPanPxX.toFixed(1)}px, ${hitsPanPxY.toFixed(1)}px, 0) scale(${hitsZoom.toFixed(3)})`;
    hitsMapViewport.style.cursor = maskDrawActive
      ? 'crosshair'
      : (hitsPanning ? 'grabbing' : (hitsZoom > 1.01 ? 'grab' : 'default'));
  }

  function fitHitsViewportBox() {
    if (!hitsStage || !hitsMapViewport || !hitsTransformLayer || appState.currentScreen !== 'gallery' || appState.galleryArchiveTab !== 'hits') {
      return;
    }
    const availW = Math.max(240, hitsMapViewport.clientWidth || hitsStage.clientWidth);
    const availH = Math.max(160, hitsMapViewport.clientHeight || hitsStage.clientHeight);

    const hits = Array.isArray(appState.detectionHits) ? appState.detectionHits : [];
    const activeHit = hits.find((h) => h.id === appState.selectedHitId) || hits[hits.length - 1];
    const fw = activeHit?.frameW || appState.streamWidth || 16;
    const fh = activeHit?.frameH || appState.streamHeight || 9;
    const aspect = fw > 0 && fh > 0 ? fw / fh : 16 / 9;

    let boxW = availW;
    let boxH = boxW / aspect;
    if (boxH > availH) {
      boxH = availH;
      boxW = boxH * aspect;
    }
    hitsLayerW = Math.round(boxW);
    hitsLayerH = Math.round(boxH);
    hitsTransformLayer.style.width = `${hitsLayerW}px`;
    hitsTransformLayer.style.height = `${hitsLayerH}px`;
    applyHitsTransform();
  }

  function syncArchiveTabUi(tab) {
    const isHits = tab === 'hits';
    tabArchiveClips?.classList.toggle('active', !isHits);
    tabArchiveHits?.classList.toggle('active', isHits);

    galleryClipsStage?.classList.toggle('hidden', isHits);
    galleryZoomPod?.classList.remove('hidden');
    galleryClipInfoPill?.classList.toggle('hidden', isHits);
    btnToggleGalleryDrawer?.classList.toggle('hidden', isHits);
    galleryClipsBar?.classList.toggle('hidden', isHits);
    if (isHits) {
      galleryDrawer?.classList.add('hidden');
    } else {
      galleryDrawer?.classList.toggle('hidden', !appState.galleryDrawerOpen);
    }

    hitsStage?.classList.toggle('hidden', !isHits);
    hitsTopRightPill?.classList.toggle('hidden', !isHits);
    btnToggleHitsDrawer?.classList.toggle('hidden', !isHits);
    hitsBottomBar?.classList.toggle('hidden', !isHits);
    if (!isHits) {
      hitsDrawer?.classList.add('hidden');
      hitsDrawerOpen = false;
      btnToggleHitsDrawer?.classList.remove('radar-btn-active');
    } else {
      requestAnimationFrame(() => {
        fitHitsViewportBox();
        renderDetectionsMap();
      });
    }
  }

  function setArchiveTab(tab) {
    const next = tab === 'hits' ? 'hits' : 'clips';
    if (appState.galleryArchiveTab !== next) {
      updateState({ galleryArchiveTab: next });
    } else {
      syncArchiveTabUi(next);
    }
  }

  function getSelectedHit(hits) {
    if (!hits.length) return null;
    const match = hits.find((h) => h.id === appState.selectedHitId);
    return match || hits[hits.length - 1];
  }

  function renderIgnoreZones() {
    if (!hitsIgnoreLayer || !btnClearMasks) return;
    const masks = Array.isArray(appState.heatmapIgnoreMasks) ? appState.heatmapIgnoreMasks : [];
    btnClearMasks.classList.toggle('hidden', masks.length === 0);
    btnClearMasks.textContent = `${masks.length} Mask${masks.length === 1 ? '' : 's'}`;

    hitsIgnoreLayer.innerHTML = '';
    masks.forEach((m, idx) => {
      const box = document.createElement('div');
      box.className = 'hits-ignore-box';
      box.style.left = `${(m.x * 100).toFixed(2)}%`;
      box.style.top = `${(m.y * 100).toFixed(2)}%`;
      box.style.width = `${(m.w * 100).toFixed(2)}%`;
      box.style.height = `${(m.h * 100).toFixed(2)}%`;

      const rm = document.createElement('button');
      rm.type = 'button';
      rm.className = 'hits-ignore-box-remove';
      rm.title = 'Remove ignore zone';
      rm.textContent = '×';
      rm.addEventListener('click', (e) => {
        e.stopPropagation();
        const next = masks.filter((_, i) => i !== idx);
        updateState({ heatmapIgnoreMasks: next });
        saveSettings(appState);
      });
      box.appendChild(rm);
      hitsIgnoreLayer.appendChild(box);
    });
  }

  function renderDetectionsMap() {
    const hits = Array.isArray(appState.detectionHits) ? appState.detectionHits : [];
    const count = hits.length;
    const countStr = String(count);

    if (hitCountBadge) hitCountBadge.textContent = countStr;
    if (galleryHitsCountBadge) galleryHitsCountBadge.textContent = countStr;
    if (heatmapHitBadge) {
      heatmapHitBadge.textContent = countStr;
      heatmapHitBadge.classList.toggle('hidden', count === 0);
    }

    renderIgnoreZones();

    if (appState.currentScreen !== 'gallery' || appState.galleryArchiveTab !== 'hits') {
      return;
    }

    const selectedHit = getSelectedHit(hits);
    const hasHits = Boolean(selectedHit);

    if (hitsEmptyBanner) hitsEmptyBanner.classList.toggle('hidden', hasHits);
    if (hitsRefImage) {
      if (selectedHit?.thumbDataUrl) {
        if (hitsRefImage.src !== selectedHit.thumbDataUrl) {
          hitsRefImage.src = selectedHit.thumbDataUrl;
        }
        hitsRefImage.classList.remove('hidden');
      } else {
        hitsRefImage.classList.add('hidden');
      }
    }

    if (hitSelectedSummary) {
      if (!selectedHit) {
        hitSelectedSummary.textContent = 'No hits';
      } else {
        const idx = hits.indexOf(selectedHit) + 1;
        hitSelectedSummary.textContent = `#${idx}/${count} • ${selectedHit.dirLabel} • ${formatAgeShort(selectedHit.timestampMs)}`;
      }
    }

    [btnHitPrev, btnHitNext, btnHitAimLoupe, btnHitPlayClip, btnHitIgnoreArea].forEach((btn) => {
      if (btn) btn.disabled = !hasHits;
    });

    if (hitsPinsLayer) {
      hitsPinsLayer.innerHTML = '';
      hits.forEach((hit, idx) => {
        const pin = document.createElement('button');
        pin.type = 'button';
        const isSel = selectedHit && hit.id === selectedHit.id;
        pin.className = `hit-pin ${getAgeClass(hit.timestampMs)}${isSel ? ' selected' : ''}`;
        pin.style.left = `${(hit.normX * 100).toFixed(2)}%`;
        pin.style.top = `${(hit.normY * 100).toFixed(2)}%`;
        pin.textContent = String(idx + 1);

        const lbl = document.createElement('span');
        lbl.className = 'hit-pin-label';
        lbl.textContent = `#${idx + 1} • ${hit.dirLabel} • ${formatAgeShort(hit.timestampMs)}`;
        pin.appendChild(lbl);

        pin.addEventListener('click', (e) => {
          e.stopPropagation();
          updateState({ selectedHitId: hit.id });
        });
        hitsPinsLayer.appendChild(pin);
      });
    }

    if (hitsLogList) {
      if (!hits.length) {
        hitsLogList.innerHTML = '<div style="padding:14px; font-size:12px; color:var(--radar-text-muted); text-align:center;">No motion hits recorded this session.</div>';
      } else {
        hitsLogList.innerHTML = '';
        for (let i = hits.length - 1; i >= 0; i--) {
          const hit = hits[i];
          const num = i + 1;
          const isSel = selectedHit && hit.id === selectedHit.id;
          const row = document.createElement('div');
          row.className = `hits-log-row${isSel ? ' selected' : ''}`;
          row.innerHTML = `
            <div style="font-size:12px; font-family:var(--font-mono);">
              <strong>#${num}</strong> • ${hit.dirLabel}
            </div>
            <span style="font-size:11px; color:var(--radar-text-muted); font-family:var(--font-mono);">${formatAgeShort(hit.timestampMs)}</span>
          `;
          row.addEventListener('click', () => {
            updateState({ selectedHitId: hit.id });
            if (window.innerWidth <= 820) {
              hitsDrawerOpen = false;
              hitsDrawer?.classList.add('hidden');
              btnToggleHitsDrawer?.classList.remove('radar-btn-active');
            }
          });
          hitsLogList.appendChild(row);
        }
      }
    }
  }

  // Shared Top-Left Zoom Controls (when Hits tab is active)
  btnZoomMinus?.addEventListener('click', () => {
    if (appState.currentScreen !== 'gallery' || appState.galleryArchiveTab !== 'hits') return;
    hitsZoom = Math.max(1.0, Math.round((hitsZoom - 0.5) * 10) / 10);
    applyHitsTransform();
  });

  btnZoomPlus?.addEventListener('click', () => {
    if (appState.currentScreen !== 'gallery' || appState.galleryArchiveTab !== 'hits') return;
    hitsZoom = Math.min(8.0, Math.round((hitsZoom + 0.5) * 10) / 10);
    applyHitsTransform();
  });

  btnZoomReset?.addEventListener('click', () => {
    if (appState.currentScreen !== 'gallery' || appState.galleryArchiveTab !== 'hits') return;
    hitsZoom = 1.0;
    hitsPanPxX = 0;
    hitsPanPxY = 0;
    applyHitsTransform();
  });

  hitsMapViewport?.addEventListener('wheel', (e) => {
    if (appState.currentScreen !== 'gallery' || appState.galleryArchiveTab !== 'hits') return;
    e.preventDefault();
    const step = e.deltaY < 0 ? 0.35 : -0.35;
    hitsZoom = Math.max(1.0, Math.min(8.0, Math.round((hitsZoom + step) * 20) / 20));
    applyHitsTransform();
  }, { passive: false });

  // Mask Drawing & Zoomed Panning via Pointer Events on #hitsMapViewport / #hitsTransformLayer
  hitsMapViewport?.addEventListener('pointerdown', (e) => {
    if (e.target.closest('.hits-ignore-box-remove') || e.target.closest('.hit-pin')) return;
    if (maskDrawActive) {
      const rect = (hitsTransformLayer || hitsMapViewport).getBoundingClientRect();
      if (!rect.width || !rect.height) return;
      drawStart = {
        x: Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width)),
        y: Math.max(0, Math.min(1, (e.clientY - rect.top) / rect.height)),
        pointerId: e.pointerId
      };
      hitsMapViewport.setPointerCapture(e.pointerId);
      hitsDrawPreview?.classList.remove('hidden');
      if (hitsDrawPreview) {
        hitsDrawPreview.style.left = `${(drawStart.x * 100).toFixed(2)}%`;
        hitsDrawPreview.style.top = `${(drawStart.y * 100).toFixed(2)}%`;
        hitsDrawPreview.style.width = '0%';
        hitsDrawPreview.style.height = '0%';
      }
      return;
    }

    if (hitsZoom > 1.01) {
      hitsPanning = true;
      hitsPanStartX = e.clientX;
      hitsPanStartY = e.clientY;
      hitsStartOffX = hitsPanPxX;
      hitsStartOffY = hitsPanPxY;
      hitsMapViewport.style.cursor = 'grabbing';
      hitsMapViewport.setPointerCapture(e.pointerId);
    }
  });

  hitsMapViewport?.addEventListener('pointermove', (e) => {
    if (drawStart && hitsDrawPreview) {
      const rect = (hitsTransformLayer || hitsMapViewport).getBoundingClientRect();
      const curX = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
      const curY = Math.max(0, Math.min(1, (e.clientY - rect.top) / rect.height));
      const x = Math.min(drawStart.x, curX);
      const y = Math.min(drawStart.y, curY);
      const w = Math.abs(curX - drawStart.x);
      const h = Math.abs(curY - drawStart.y);
      hitsDrawPreview.style.left = `${(x * 100).toFixed(2)}%`;
      hitsDrawPreview.style.top = `${(y * 100).toFixed(2)}%`;
      hitsDrawPreview.style.width = `${(w * 100).toFixed(2)}%`;
      hitsDrawPreview.style.height = `${(h * 100).toFixed(2)}%`;
      return;
    }

    if (hitsPanning) {
      hitsPanPxX = hitsStartOffX + (e.clientX - hitsPanStartX);
      hitsPanPxY = hitsStartOffY + (e.clientY - hitsPanStartY);
      applyHitsTransform();
    }
  });

  const finishPointer = (e) => {
    if (hitsPanning) {
      hitsPanning = false;
      applyHitsTransform();
    }
    if (!drawStart) return;
    const rect = (hitsTransformLayer || hitsMapViewport).getBoundingClientRect();
    const curX = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    const curY = Math.max(0, Math.min(1, (e.clientY - rect.top) / rect.height));
    const x = Math.min(drawStart.x, curX);
    const y = Math.min(drawStart.y, curY);
    const w = Math.abs(curX - drawStart.x);
    const h = Math.abs(curY - drawStart.y);
    drawStart = null;
    hitsDrawPreview?.classList.add('hidden');
    if (w >= 0.03 && h >= 0.03) {
      addHeatmapIgnoreZone({ x, y, w, h });
      saveSettings(appState);
    }
  };
  hitsMapViewport?.addEventListener('pointerup', finishPointer);
  hitsMapViewport?.addEventListener('pointercancel', () => {
    hitsPanning = false;
    drawStart = null;
    hitsDrawPreview?.classList.add('hidden');
    applyHitsTransform();
  });

  btnOpenHitsTab?.addEventListener('click', () => {
    updateState({ currentScreen: 'gallery', galleryArchiveTab: 'hits' });
  });

  tabArchiveClips?.addEventListener('click', () => setArchiveTab('clips'));
  tabArchiveHits?.addEventListener('click', () => setArchiveTab('hits'));

  btnToggleHitsDrawer?.addEventListener('click', () => {
    hitsDrawerOpen = !hitsDrawerOpen;
    hitsDrawer?.classList.toggle('hidden', !hitsDrawerOpen);
    btnToggleHitsDrawer.classList.toggle('radar-btn-active', hitsDrawerOpen);
  });

  btnCloseHitsDrawer?.addEventListener('click', () => {
    hitsDrawerOpen = false;
    hitsDrawer?.classList.add('hidden');
    btnToggleHitsDrawer?.classList.remove('radar-btn-active');
  });

  btnToggleMaskDraw?.addEventListener('click', () => {
    maskDrawActive = !maskDrawActive;
    btnToggleMaskDraw.classList.toggle('radar-btn-active', maskDrawActive);
    btnToggleMaskDraw.textContent = maskDrawActive ? 'Mask: ON (Drag)' : 'Mask: OFF';
    hitsMapViewport?.classList.toggle('mask-draw-active', maskDrawActive);
    applyHitsTransform();
  });

  btnClearMasks?.addEventListener('click', () => {
    clearHeatmapIgnoreZones();
    saveSettings(appState);
  });

  btnHitsRezero?.addEventListener('click', () => {
    rezeroHeatmap();
    if (hitSelectedSummary) hitSelectedSummary.textContent = 'Background re-zeroed';
  });

  btnHitsClear?.addEventListener('click', () => {
    clearDetectionHits();
  });

  btnHitPrev?.addEventListener('click', () => {
    const hits = Array.isArray(appState.detectionHits) ? appState.detectionHits : [];
    if (!hits.length) return;
    const cur = getSelectedHit(hits);
    const idx = hits.indexOf(cur);
    const prevIdx = idx <= 0 ? hits.length - 1 : idx - 1;
    updateState({ selectedHitId: hits[prevIdx].id });
  });

  btnHitNext?.addEventListener('click', () => {
    const hits = Array.isArray(appState.detectionHits) ? appState.detectionHits : [];
    if (!hits.length) return;
    const cur = getSelectedHit(hits);
    const idx = hits.indexOf(cur);
    const nextIdx = (idx + 1) % hits.length;
    updateState({ selectedHitId: hits[nextIdx].id });
  });

  btnHitAimLoupe?.addEventListener('click', () => {
    const hits = Array.isArray(appState.detectionHits) ? appState.detectionHits : [];
    aimLoupeAtHit(getSelectedHit(hits));
  });

  btnHitPlayClip?.addEventListener('click', async () => {
    const hits = Array.isArray(appState.detectionHits) ? appState.detectionHits : [];
    const hit = getSelectedHit(hits);
    if (!hit) return;
    const played = await openReplayAtTimestamp(hit.perfMs, hit.timestampMs);
    if (!played && hitSelectedSummary) {
      hitSelectedSummary.textContent = 'No matching replay or saved clip';
    }
  });

  btnHitIgnoreArea?.addEventListener('click', () => {
    const hits = Array.isArray(appState.detectionHits) ? appState.detectionHits : [];
    const hit = getSelectedHit(hits);
    if (!hit) return;
    addHeatmapIgnoreZone({
      x: hit.normX - 0.05,
      y: hit.normY - 0.05,
      w: 0.1,
      h: 0.1
    });
    saveSettings(appState);
  });

  btnHitSnapshot?.addEventListener('click', async () => {
    const hits = Array.isArray(appState.detectionHits) ? appState.detectionHits : [];
    const selectedHit = getSelectedHit(hits);
    const cw = selectedHit?.frameW || appState.streamWidth || 1280;
    const ch = selectedHit?.frameH || appState.streamHeight || 720;
    const tempCanvas = document.createElement('canvas');
    tempCanvas.width = cw;
    tempCanvas.height = ch;
    const tctx = tempCanvas.getContext('2d');
    if (!tctx) return;

    tctx.fillStyle = '#0b1017';
    tctx.fillRect(0, 0, cw, ch);

    if (hitsRefImage && !hitsRefImage.classList.contains('hidden') && hitsRefImage.complete && hitsRefImage.naturalWidth) {
      tctx.drawImage(hitsRefImage, 0, 0, cw, ch);
    }

    await exportAnnotatedCanvasPng(tempCanvas, {
      includeReticle: false,
      prefix: 'SPOTR_Hits',
      drawExtra: async (ctx, w, h) => {
        const masks = Array.isArray(appState.heatmapIgnoreMasks) ? appState.heatmapIgnoreMasks : [];
        ctx.save();
        masks.forEach((m) => {
          ctx.fillStyle = 'rgba(245, 158, 11, 0.22)';
          ctx.strokeStyle = '#f59e0b';
          ctx.lineWidth = 2;
          ctx.fillRect(m.x * w, m.y * h, m.w * w, m.h * h);
          ctx.strokeRect(m.x * w, m.y * h, m.w * w, m.h * h);
        });
        hits.forEach((hit, idx) => {
          const px = hit.normX * w;
          const py = hit.normY * h;
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
          ctx.fillText(String(idx + 1), px, py);
        });
        ctx.restore();
      }
    });
  });

  window.addEventListener('resize', fitHitsViewportBox);

  subscribeState((state, patch) => {
    if (patch.currentScreen !== undefined || patch.galleryArchiveTab !== undefined) {
      if (state.currentScreen === 'gallery') {
        syncArchiveTabUi(state.galleryArchiveTab || 'clips');
      }
    }
    if (
      patch.detectionHits !== undefined ||
      patch.selectedHitId !== undefined ||
      patch.heatmapIgnoreMasks !== undefined
    ) {
      renderDetectionsMap();
    }
  });

  ageTicker = setInterval(() => {
    if (appState.currentScreen === 'gallery' && appState.galleryArchiveTab === 'hits' && appState.detectionHits?.length) {
      renderDetectionsMap();
    }
  }, 5000);

  renderDetectionsMap();
}
