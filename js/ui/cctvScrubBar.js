/**
 * CCTV Scrubber Component Helper for EagleVision / SPOTR
 *
 * Renders coarse sound amplitude bars (Electric Cyan for loud spikes)
 * and event markers (Vivid Amber) onto the timeline track.
 * Events occurring within the same second are visually grouped as a single event.
 * Provides helper navigation for [ ◀ EVT ] and [ EVT ▶ ] skipping.
 */

export function groupEventsWithinSecond(rawEvents, windowSec = 1.0) {
  if (!rawEvents || !rawEvents.length) return [];
  const valid = rawEvents
    .map(Number)
    .filter((t) => !isNaN(t) && t >= 0)
    .sort((a, b) => a - b);
  if (!valid.length) return [];

  const clusters = [];
  let current = null;

  for (const t of valid) {
    if (!current) {
      current = { start: t, end: t, count: 1 };
    } else if (t - current.start <= windowSec) {
      current.end = t;
      current.count++;
    } else {
      clusters.push(current);
      current = { start: t, end: t, count: 1 };
    }
  }
  if (current) clusters.push(current);

  return clusters;
}

export function renderCctvTrack({
  waveformEl,
  markersEl,
  timeline,
  durationSec,
  onSeek
}) {
  if (waveformEl) waveformEl.innerHTML = '';
  if (markersEl) markersEl.innerHTML = '';

  const soundPeaks = Array.isArray(timeline?.soundPeaks) ? timeline.soundPeaks : [];
  const rawEvents = Array.isArray(timeline?.events) ? timeline.events : [];
  const dur = Math.max(0.1, Number(durationSec) || 20);

  // Group events within the same 1.0s window into a single distinct event
  const clusteredEvents = groupEventsWithinSecond(rawEvents, 1.0);

  // 1. Render Sound Amplitude Bars
  if (waveformEl && soundPeaks.length > 0) {
    const hasAnySound = soundPeaks.some((p) => p > 0.05);
    if (hasAnySound) {
      const frag = document.createDocumentFragment();
      soundPeaks.forEach((peak) => {
        const bar = document.createElement('div');
        bar.className = `cctv-wave-bar ${peak > 0.65 ? 'peak' : 'ambient'}`;
        const pctHeight = Math.max(6, Math.min(100, Math.round(peak * 100)));
        bar.style.height = `${pctHeight}%`;
        frag.appendChild(bar);
      });
      waveformEl.appendChild(frag);
    }
  }

  // 2. Render Clustered Event Markers (Single Amber Pip & Line per second window)
  if (markersEl && clusteredEvents.length > 0) {
    const frag = document.createDocumentFragment();
    clusteredEvents.forEach((cluster) => {
      const t = cluster.start;
      const pct = Math.max(0, Math.min(100, (t / dur) * 100));

      const marker = document.createElement('div');
      marker.className = 'cctv-event-marker';
      marker.style.left = `${pct}%`;
      const titleSuffix = cluster.count > 1 ? ` (${cluster.count} events)` : '';
      marker.title = `Event at ${t.toFixed(1)}s${titleSuffix}`;
      marker.innerHTML = `
        <div class="cctv-event-marker-pip"></div>
        <div class="cctv-event-marker-line"></div>
        <div class="cctv-event-marker-pip"></div>
      `;

      if (typeof onSeek === 'function') {
        marker.addEventListener('click', (e) => {
          e.stopPropagation();
          onSeek(t);
        });
      }
      frag.appendChild(marker);
    });
    markersEl.appendChild(frag);
  }

  // Navigation helpers: step between distinct clustered event moments
  const clusterTimestamps = clusteredEvents.map((c) => c.start);

  return {
    getPrevEvent: (currentTimeSec) => {
      if (!clusterTimestamps.length) return null;
      const prev = [...clusterTimestamps].reverse().find((t) => t < currentTimeSec - 0.25);
      return prev !== undefined ? prev : clusterTimestamps[clusterTimestamps.length - 1];
    },
    getNextEvent: (currentTimeSec) => {
      if (!clusterTimestamps.length) return null;
      const next = clusterTimestamps.find((t) => t > currentTimeSec + 0.25);
      return next !== undefined ? next : clusterTimestamps[0];
    }
  };
}
