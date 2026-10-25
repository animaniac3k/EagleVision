/**
 * IndexedDB Storage & Disk Export for Saved 20-Second Video Clips
 *
 * Stores frame-accurate compressed JPEG buffers in IndexedDB for 100% reliable
 * playback, slow-motion, and frame-stepping in the Stored Video Viewer, and
 * encodes a standard .webm video file when exporting to disk.
 */
const DB_NAME = 'EagleVisionVideoDB';
const DB_VERSION = 3;
const STORE_NAME = 'clips';

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (db.objectStoreNames.contains(STORE_NAME)) {
        db.deleteObjectStore(STORE_NAME);
      }
      const store = db.createObjectStore(STORE_NAME, { keyPath: 'id' });
      store.createIndex('createdAt', 'createdAt', { unique: false });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function saveVideoClip({ jpegFrames, fps, durationSec, sizeBytes, width, height }) {
  const db = await openDB();
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}_${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;

  const record = {
    id: `clip_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    name: `CLIP_${stamp}.WEBM`,
    createdAt: Date.now(),
    fps: fps || 15,
    durationSec: Number(durationSec.toFixed(1)),
    sizeBytes: sizeBytes || jpegFrames.reduce((acc, b) => acc + b.byteLength, 0),
    width: width || 854,
    height: height || 480,
    jpegFrames
  };

  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    tx.objectStore(STORE_NAME).put(record);
    tx.oncomplete = () => resolve(record);
    tx.onerror = () => reject(tx.error);
  });
}

export async function listVideoClips() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const req = tx.objectStore(STORE_NAME).getAll();
    req.onsuccess = () => {
      const items = (req.result || []).filter((item) => Array.isArray(item.jpegFrames) && item.jpegFrames.length > 0);
      items.sort((a, b) => b.createdAt - a.createdAt);
      resolve(items);
    };
    req.onerror = () => reject(req.error);
  });
}

export async function deleteVideoClip(id) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    tx.objectStore(STORE_NAME).delete(id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

/**
 * Exports a stored clip to a standard .webm video file on disk.
 */
export async function exportClipToDisk(clip) {
  const filename = clip.name.toLowerCase();
  const canvas = document.createElement('canvas');
  canvas.width = clip.width || 854;
  canvas.height = clip.height || 480;
  const ctx = canvas.getContext('2d');

  const bitmaps = await Promise.all(
    clip.jpegFrames.map((buf) => createImageBitmap(new Blob([buf], { type: 'image/jpeg' })))
  );

  const stream = canvas.captureStream(clip.fps || 15);
  const mimeType = MediaRecorder.isTypeSupported('video/webm;codecs=vp8')
    ? 'video/webm;codecs=vp8'
    : 'video/webm';
  const recorder = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: 3_500_000 });
  const chunks = [];
  recorder.ondataavailable = (e) => {
    if (e.data && e.data.size > 0) chunks.push(e.data);
  };

  const blobPromise = new Promise((resolve) => {
    recorder.onstop = () => resolve(new Blob(chunks, { type: mimeType }));
  });

  recorder.start();
  const frameIntervalMs = Math.round(1000 / (clip.fps || 15));
  for (const bmp of bitmaps) {
    ctx.drawImage(bmp, 0, 0, canvas.width, canvas.height);
    await new Promise((r) => setTimeout(r, frameIntervalMs));
  }
  recorder.stop();
  const webmBlob = await blobPromise;
  bitmaps.forEach((b) => b.close && b.close());

  if ('showSaveFilePicker' in window) {
    try {
      const handle = await window.showSaveFilePicker({
        suggestedName: filename,
        types: [{ description: 'WebM Video', accept: { 'video/webm': ['.webm'] } }]
      });
      const writable = await handle.createWritable();
      await writable.write(webmBlob);
      await writable.close();
      return;
    } catch (err) {
      if (err.name === 'AbortError') return;
    }
  }

  const url = URL.createObjectURL(webmBlob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}
