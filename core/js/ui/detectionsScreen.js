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

export function initDetectionsScreen(subscribeState) {
  if (initialized) return;
  initialized = true;

  const btnOpenHitsTab = document.getElementById('btnOpenHitsTab');
  const hitCountBadge = document.getElementById('hitCountBadge');
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

  const btnToggleHitsReticle = document.getElementById('btnToggleHitsReticle');
  const btnToggleHitsVisible = document.getElementById('btnToggleHitsVisible');
  const btnToggleHitsTimestamps = document.getElementById('btnToggleHitsTimestamps');
  const btnHitsRezero = document.getElementById('btnHitsRezero');
  const btnHitsClear = document.getElementById('btnHitsClear');

  const btnHitPrev = document.getElementById('btnHitPrev');
  const btnHitNext = document.getElementById('btnHitNext');
  const hitSelectedSummary = document.getElementById('hitSelectedSummary');
  const btnHitSnapshot = document.getElementById('btnHitSnapshot');

  let hitsDrawerOpen = false;
  let ageTicker = null;
  let hitsZoom = 1.0;
  let hitsPanPxX = 0;
  let hitsPanPxY = 0;
  let hitsLayerW = 0;
  let hitsLayerH = 0;
  let hitsPanning = false;
  let hitsPanPointerId = null;
  let hitsPanStartX = 0;
  let hitsPanStartY = 0;
  let hitsStartOffX = 0;
  let hitsStartOffY = 0;
  let lastFittedAspectKey = '';

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
    hitsMapViewport.style.cursor = hitsPanning ? 'grabbing' : (hitsZoom > 1.01 ? 'grab' : 'default');
    if (isHitsActive) {
      syncHitsReticleOverlay();
    }
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

  function syncHitsReticleOverlay() {
    const layerEl = document.getElementById('hitsReticleLayer');
    const svgEl = document.getElementById('hitsReticleSvg');
    const customImg = document.getElementById('hitsReticleCustomImg');
    if (customImg && !customImg._ffpLoadWired) {
      customImg._ffpLoadWired = true;
      customImg.addEventListener('load', () => syncHitsReticleOverlay());
    }
    const enabled = appState.overlayEnabled !== false;
    if (btnToggleHitsReticle) {
      btnToggleHitsReticle.textContent = enabled ? 'Reticle: ON' : 'Reticle: OFF';
      btnToggleHitsReticle.classList.toggle('radar-btn-active', enabled);
    }

    const hits = Array.isArray(appState.detectionHits) ? appState.detectionHits : [];
    const activeHit = getSelectedHit(hits);
    const fw = activeHit?.frameW || appState.streamWidth || 1920;
    const fh = activeHit?.frameH || appState.streamHeight || 1080;
    const stageW = hitsLayerW || hitsTransformLayer?.clientWidth || fw;
    const stageH = hitsLayerH || hitsTransformLayer?.clientHeight || fh;
    const useCustom = appState.overlayType === 'custom' && customImg?.naturalWidth > 0 && customImg?.naturalHeight > 0;
    const imgW = useCustom ? customImg.naturalWidth : 0;
    const imgH = useCustom ? customImg.naturalHeight : 0;

    // #hitsTransformLayer already applies CSS scale(hitsZoom) to #hitsReticleLayer:
    // - In FFP mode, scale by ffpMatchScale so 1 click matches Live's source-pixel distance at all zooms.
    // - In SFP mode, compensate for hitsLayer size and divide out hitsZoom so reticle stays fixed screen size.
    const ffpMatchScale = computeFfpMatchScale({
      stageWidth: stageW,
      stageHeight: stageH,
      frameWidth: fw,
      frameHeight: fh,
      fitMode: 'contain',
      customImgWidth: imgW,
      customImgHeight: imgH
    });
    const liveDims = getLiveViewportDimensions();
    const liveBase = computeReticleBaseScale(liveDims.width, liveDims.height, imgW, imgH);
    const hitsBase = computeReticleBaseScale(stageW, stageH, imgW, imgH);
    const sfpMatchScale = (hitsBase > 0 ? liveBase / hitsBase : 1.0) / Math.max(1.0, hitsZoom);

    renderReticleOverlayLayer(layerEl, svgEl, customImg, appState, enabled, 1.0, {
      ffpMatchScale,
      sfpMatchScale
    });
  }

  function syncHitsPinsVisibility() {
    const showHits = Boolean(appState.heatmapEnabled);
    if (hitsPinsLayer) {
      hitsPinsLayer.classList.toggle('hidden', !showHits);
    }
    if (btnToggleHitsVisible) {
      btnToggleHitsVisible.textContent = showHits ? 'Hits: ON' : 'Hits: OFF';
      btnToggleHitsVisible.classList.toggle('radar-btn-active', showHits);
    }
    if (btnHitsClear) {
      const hasHits = Array.isArray(appState.detectionHits) && appState.detectionHits.length > 0;
      btnHitsClear.disabled = !hasHits;
      btnHitsClear.classList.toggle('dock-btn-dimmed', !hasHits);
    }
  }

  function syncHitsTimestampsBtn() {
    const on = Boolean(appState.showHitTimestamps);
    if (btnToggleHitsTimestamps) {
      btnToggleHitsTimestamps.classList.toggle('radar-btn-active', on);
      btnToggleHitsTimestamps.setAttribute('aria-pressed', String(on));
      btnToggleHitsTimestamps.title = on
        ? 'Timestamp on Hits: ON — Tap to hide (Synced with Calibration & Live)'
        : 'Timestamp on Hits: OFF — Tap to show (Synced with Calibration & Live)';
    }
  }

  function renderDetectionsMap() {
    const hits = Array.isArray(appState.detectionHits) ? appState.detectionHits : [];
    const count = hits.length;
    const countStr = String(count);

    if (hitCountBadge) {
      hitCountBadge.textContent = countStr;
      hitCountBadge.classList.toggle('has-hits', count > 0);
    }
    if (galleryHitsCountBadge) {
      galleryHitsCountBadge.textContent = countStr;
      galleryHitsCountBadge.classList.toggle('has-hits', count > 0);
    }

    if (appState.currentScreen !== 'gallery' || appState.galleryArchiveTab !== 'hits') {
      return;
    }

    const selectedHit = getSelectedHit(hits);
    const hasHits = Boolean(selectedHit);
    const aspectKey = `${selectedHit?.frameW || appState.streamWidth || 16}x${selectedHit?.frameH || appState.streamHeight || 9}`;
    if (aspectKey !== lastFittedAspectKey) {
      lastFittedAspectKey = aspectKey;
      fitHitsViewportBox();
    }

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
        hitSelectedSummary.textContent = '—';
      } else {
        const idx = hits.indexOf(selectedHit) + 1;
        hitSelectedSummary.textContent = `#${idx} / ${count}`;
      }
    }

    [btnHitPrev, btnHitNext, btnHitSnapshot].forEach((btn) => {
      if (btn) btn.disabled = !hasHits;
    });

    const showHitTime = Boolean(appState.showHitTimestamps);
    if (hitsPinsLayer) {
      hitsPinsLayer.innerHTML = '';
      hits.forEach((hit, idx) => {
        const pin = document.createElement('button');
        pin.type = 'button';
        const isSel = selectedHit && hit.id === selectedHit.id;
        pin.className = `hit-pin ${getAgeClass(hit.timestampMs)}${isSel ? ' selected' : ''}`;
        pin.dataset.hitTs = String(hit.timestampMs || 0);
        pin.style.left = `${(hit.normX * 100).toFixed(2)}%`;
        pin.style.top = `${(hit.normY * 100).toFixed(2)}%`;
        pin.textContent = String(idx + 1);
        if (showHitTime && hit.timestampMs) {
          const timeBadge = document.createElement('span');
          timeBadge.className = 'hit-pin-time';
          timeBadge.textContent = formatHitClockTime(hit.timestampMs);
          pin.appendChild(timeBadge);
        }

        pin.addEventListener('click', (e) => {
          e.stopPropagation();
          updateState({ selectedHitId: hit.id });
        });
        hitsPinsLayer.appendChild(pin);
      });
    }
    syncHitsPinsVisibility();
    syncHitsTimestampsBtn();
    syncHitsReticleOverlay();

    if (hitsLogList) {
      if (!hits.length) {
        hitsLogList.innerHTML = '<div style="padding:14px; font-size:12px; color:var(--radar-text-muted); text-align:center;">No motion hits recorded this session.</div>';
      } else {
        hitsLogList.innerHTML = '';
        for (let i = hits.length - 1; i >= 0; i--) {
          const hit = hits[i];
          const num = i + 1;
          const isSel = selectedHit && hit.id === selectedHit.id;
          const timeStr = showHitTime && hit.timestampMs ? `${formatHitClockTime(hit.timestampMs)} • ` : '';
          const row = document.createElement('div');
          row.className = `hits-log-row${isSel ? ' selected' : ''}`;
          const infoEl = document.createElement('div');
          infoEl.style.cssText = 'font-size:12px; font-family:var(--font-mono);';
          const numStrong = document.createElement('strong');
          numStrong.textContent = `#${num}`;
          infoEl.appendChild(numStrong);
          infoEl.appendChild(document.createTextNode(` • ${hit.dirLabel || 'Hit'}`));

          const ageSpan = document.createElement('span');
          ageSpan.className = 'hits-log-age';
          ageSpan.dataset.hitTs = String(hit.timestampMs || 0);
          ageSpan.dataset.timePrefix = timeStr;
          ageSpan.style.cssText = 'font-size:11px; color:var(--radar-text-muted); font-family:var(--font-mono);';
          ageSpan.textContent = `${timeStr}${formatAgeShort(hit.timestampMs)}`;

          row.appendChild(infoEl);
          row.appendChild(ageSpan);
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

  function updateAgesInPlace() {
    if (hitsPinsLayer) {
      hitsPinsLayer.querySelectorAll('.hit-pin[data-hit-ts]').forEach((pin) => {
        const ts = Number(pin.dataset.hitTs);
        if (!ts) return;
        const nextAge = getAgeClass(ts);
        pin.classList.remove('pin-fresh', 'pin-warm', 'pin-stale');
        pin.classList.add(nextAge);
      });
    }
    if (hitsLogList) {
      hitsLogList.querySelectorAll('.hits-log-age[data-hit-ts]').forEach((span) => {
        const ts = Number(span.dataset.hitTs);
        if (!ts) return;
        span.textContent = `${span.dataset.timePrefix || ''}${formatAgeShort(ts)}`;
      });
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

  // Zoomed Panning via Pointer Events on #hitsMapViewport / #hitsTransformLayer
  hitsMapViewport?.addEventListener('pointerdown', (e) => {
    if (e.target.closest('.hit-pin')) return;
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    if (hitsPanPointerId !== null) return;
    if (hitsZoom > 1.01) {
      hitsPanning = true;
      hitsPanPointerId = e.pointerId;
      hitsPanStartX = e.clientX;
      hitsPanStartY = e.clientY;
      hitsStartOffX = hitsPanPxX;
      hitsStartOffY = hitsPanPxY;
      hitsMapViewport.style.cursor = 'grabbing';
      try {
        hitsMapViewport.setPointerCapture(e.pointerId);
      } catch {
        // Ignore synthetic pointer capture errors
      }
    }
  });

  hitsMapViewport?.addEventListener('pointermove', (e) => {
    if (hitsPanning && e.pointerId === hitsPanPointerId) {
      hitsPanPxX = hitsStartOffX + (e.clientX - hitsPanStartX);
      hitsPanPxY = hitsStartOffY + (e.clientY - hitsPanStartY);
      applyHitsTransform();
    }
  });

  const finishPointer = (e) => {
    if (hitsPanning && (!e || e.pointerId === undefined || e.pointerId === hitsPanPointerId)) {
      hitsPanning = false;
      hitsPanPointerId = null;
      applyHitsTransform();
    }
  };
  hitsMapViewport?.addEventListener('pointerup', finishPointer);
  hitsMapViewport?.addEventListener('pointercancel', finishPointer);
  hitsMapViewport?.addEventListener('lostpointercapture', finishPointer);

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

  btnToggleHitsReticle?.addEventListener('click', () => {
    updateState({ overlayEnabled: !(appState.overlayEnabled !== false) });
    saveSettings(appState);
  });

  btnToggleHitsVisible?.addEventListener('click', () => {
    const nextEnabled = !appState.heatmapEnabled;
    if (nextEnabled) rezeroHeatmap();
    updateState({ heatmapEnabled: nextEnabled });
    saveSettings(appState);
  });

  btnToggleHitsTimestamps?.addEventListener('click', () => {
    updateState({ showHitTimestamps: !appState.showHitTimestamps });
    saveSettings(appState);
  });

  btnHitsRezero?.addEventListener('click', () => {
    rezeroHeatmap();
    clearDetectionHits();
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
      includeReticle: appState.overlayEnabled !== false,
      reticleZoom: 1.0,
      matchLiveFfp: true,
      prefix: 'SPOTR_Hits',
      drawExtra: async (ctx, w, h) => {
        ctx.save();
        if (appState.heatmapEnabled) {
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
            if (appState.showHitTimestamps && hit.timestampMs) {
              drawHitTimestampBadge(ctx, px, py, isSel ? 16 : 13, hit.timestampMs, w, h);
            }
          });
        }
        if (appState.showDisplayTimestamp !== false) {
          drawDisplayTimestampOnCanvas(ctx, w, h, selectedHit?.timestampMs || Date.now(), {
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

  window.addEventListener('resize', fitHitsViewportBox);

  subscribeState((state, patch) => {
    if (patch.currentScreen !== undefined || patch.galleryArchiveTab !== undefined) {
      if (state.currentScreen === 'gallery') {
        syncArchiveTabUi(state.galleryArchiveTab || 'clips');
      }
    }
    if (
      state.currentScreen === 'gallery' &&
      state.galleryArchiveTab === 'hits' &&
      (patch.overlayEnabled !== undefined ||
        patch.overlayType !== undefined ||
        patch.overlayOpacity !== undefined ||
        patch.overlayScale !== undefined ||
        patch.reticleFfpMode !== undefined ||
        patch.customOverlayUrl !== undefined ||
        patch.reticleConfig !== undefined ||
        patch.themeColor !== undefined)
    ) {
      syncHitsReticleOverlay();
    }
    if (patch.heatmapEnabled !== undefined) {
      syncHitsPinsVisibility();
    }
    if (patch.showHitTimestamps !== undefined) {
      syncHitsTimestampsBtn();
    }
    if (
      patch.detectionHits !== undefined ||
      patch.selectedHitId !== undefined ||
      patch.heatmapIgnoreMasks !== undefined ||
      patch.showHitTimestamps !== undefined ||
      patch.heatmapEnabled !== undefined
    ) {
      renderDetectionsMap();
    }
  });

  ageTicker = setInterval(() => {
    if (appState.currentScreen === 'gallery' && appState.galleryArchiveTab === 'hits' && appState.detectionHits?.length) {
      updateAgesInPlace();
    }
  }, 5000);

  syncHitsTimestampsBtn();
  renderDetectionsMap();
}
