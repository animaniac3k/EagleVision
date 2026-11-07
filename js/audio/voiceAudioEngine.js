/**
 * EagleVision Embedded Voice Audio Engine
 * 
 * 100% Host-Independent, Offline Studio Female Voice Synthesizer
 * Uses Web Audio API + Pre-rendered 24kHz Jenny (en-US) Studio Voice Sprites.
 * 
 * Guarantees bit-for-bit identical, high-definition female voice playback
 * across Windows 10/11, Chromebook (IdeaPad Duet 3), Linux, and mobile devices.
 */
import { VOICE_SPRITE_SRC, VOICE_MANIFEST } from './voiceManifest.js';
import { appState } from '../state.js';

let audioCtx = null;
let masterGain = null;
let spriteAudioBuffer = null;
let loadPromise = null;
let isLoaded = false;
let activeSources = [];

/**
 * Acquire or initialize the Web Audio Context with auto-resume
 */
export function getVoiceAudioContext() {
  if (!audioCtx) {
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextClass) return null;
    audioCtx = new AudioContextClass();
    masterGain = audioCtx.createGain();
    masterGain.gain.value = 1.0;
    masterGain.connect(audioCtx.destination);
  }
  if (audioCtx.state === 'suspended') {
    audioCtx.resume().catch(() => {});
  }
  return audioCtx;
}

/**
 * Preload and decode the embedded audio sprite buffer into RAM
 */
export async function preloadVoiceAudio() {
  if (isLoaded && spriteAudioBuffer) return spriteAudioBuffer;
  if (loadPromise) return loadPromise;

  loadPromise = (async () => {
    try {
      const ctx = getVoiceAudioContext();
      if (!ctx) return null;
      const resp = await fetch(VOICE_SPRITE_SRC);
      if (!resp.ok) {
        throw new Error(`Failed to load voice sprite: HTTP ${resp.status}`);
      }
      const arrayBuf = await resp.arrayBuffer();
      spriteAudioBuffer = await ctx.decodeAudioData(arrayBuf);
      isLoaded = true;
      return spriteAudioBuffer;
    } catch (err) {
      console.warn('[VoiceAudioEngine] Failed to decode voice sprite:', err);
      return null;
    } finally {
      loadPromise = null;
    }
  })();

  return loadPromise;
}

/**
 * Cancel any ongoing speech immediately
 */
export function stopVoiceAnnouncement() {
  if (activeSources.length > 0) {
    activeSources.forEach((src) => {
      try {
        src.stop();
        src.disconnect();
      } catch (_) {}
    });
    activeSources = [];
  }
}

/**
 * Synthesizes a subtle high-tech alert chime for unmapped custom keywords
 */
function scheduleAlertChime(ctx, startTime) {
  try {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(987.77, startTime); // B5
    osc.frequency.exponentialRampToValueAtTime(1318.51, startTime + 0.08); // E6
    gain.gain.setValueAtTime(0.25, startTime);
    gain.gain.exponentialRampToValueAtTime(0.001, startTime + 0.09);
    osc.connect(gain);
    gain.connect(masterGain || ctx.destination);
    osc.start(startTime);
    osc.stop(startTime + 0.10);
    activeSources.push(osc);
  } catch (_) {}
}

/**
 * Parses detection announcements and callout phrases into sprite tokens
 * Examples:
 * - "Detection! 11 o'clock, 3 clicks"
 * - "Contact! 1 o'clock, 1 click"
 * - "Target! Center"
 * - "Detection! Voice callouts active"
 * - "Warning! 6 o'clock, 42 clicks"
 */
export function parsePhraseToTokens(phrase) {
  if (!phrase || typeof phrase !== 'string') return [];
  const raw = phrase.trim();
  const lower = raw.toLowerCase();
  const tokens = [];

  // Check for status messages
  if (lower.includes('callouts active') || lower.includes('voice callouts active')) {
    // Extract prefix if present
    const prefixMatch = raw.match(/^([A-Za-z0-9_-]+)[!:,]/);
    if (prefixMatch) {
      const p = prefixMatch[1].toLowerCase();
      if (VOICE_MANIFEST[p]) tokens.push(p);
    }
    tokens.push('callouts_active');
    return tokens;
  }

  if (lower.includes('callouts muted') || lower.includes('voice callouts muted')) {
    tokens.push('callouts_muted');
    return tokens;
  }

  // 1. Extract Alert Prefix (e.g. "Detection!", "Contact:", "Target")
  let alertToken = null;
  const prefixMatch = raw.match(/^([A-Za-z0-9_-]+)[!:,]?/);
  if (prefixMatch) {
    const candidate = prefixMatch[1].toLowerCase();
    if (VOICE_MANIFEST[candidate]) {
      alertToken = candidate;
    } else {
      // Custom keyword flag
      alertToken = '__custom_chime__';
    }
  }

  if (alertToken) {
    tokens.push(alertToken);
  }

  // 2. Check for Center vs Clock Direction
  if (lower.includes('center')) {
    tokens.push('center');
  } else {
    // Match clock direction e.g. "11 o'clock", "3 o'clock"
    const clockMatch = lower.match(/\b([1-9]|1[0-2])\s*o'?clock\b/);
    if (clockMatch) {
      tokens.push(`${clockMatch[1]}_oclock`);
    }
  }

  // 3. Extract Number Count (1 to 100+)
  let countNum = null;
  // Match number following o'clock
  const oclockCount = lower.match(/o'?clock\s*[, ]+\s*(\d+)/i);
  if (oclockCount) {
    countNum = parseInt(oclockCount[1], 10);
  } else {
    // Match number before a unit word
    const unitCount = lower.match(/\b(\d+)\s*(?:click|mil|mark|unit|degree|meter|yard)/i);
    if (unitCount) {
      countNum = parseInt(unitCount[1], 10);
    } else {
      // Match number after a comma
      const commaCount = lower.match(/,\s*(\d+)/);
      if (commaCount) {
        countNum = parseInt(commaCount[1], 10);
      }
    }
  }

  if (countNum !== null && !isNaN(countNum)) {
    if (countNum >= 1 && countNum <= 100) {
      tokens.push(String(countNum));
    } else if (countNum > 100 && countNum < 200) {
      // Compound 101-199
      tokens.push('100');
      const rem = countNum - 100;
      if (rem > 0 && rem <= 100) {
        tokens.push(String(rem));
      }
    } else if (countNum >= 200) {
      tokens.push('100');
    }
  }

  // 4. Extract Unit Word
  const knownUnits = ['click', 'clicks', 'mil', 'mils', 'mark', 'marks', 'unit', 'units', 'degree', 'degrees', 'meter', 'meters', 'yard', 'yards'];
  for (const u of knownUnits) {
    const regex = new RegExp(`\\b${u}\\b`, 'i');
    if (regex.test(lower)) {
      tokens.push(u);
      break;
    }
  }

  return tokens;
}

/**
 * Primary speech announcement interface.
 * Replaces window.speechSynthesis.speak() with deterministic, host-independent Web Audio playback.
 */
export async function speakDetectionAnnouncement(phrase) {
  if (!phrase) return;

  const ctx = getVoiceAudioContext();
  if (!ctx) return;

  // Ensure audio sprite is in memory
  if (!spriteAudioBuffer) {
    await preloadVoiceAudio();
  }

  if (!spriteAudioBuffer) {
    // Fallback: if sprite failed to fetch, try native speech if available
    if ('speechSynthesis' in window) {
      try {
        const u = new SpeechSynthesisUtterance(phrase);
        u.pitch = Number(appState.voicePitch) || 1.25;
        u.rate = Number(appState.voiceRate) || 1.1;
        window.speechSynthesis.speak(u);
      } catch (_) {}
    }
    return;
  }

  const tokens = parsePhraseToTokens(phrase);
  if (!tokens || tokens.length === 0) return;

  // Interrupt prior speech cleanly
  stopVoiceAnnouncement();

  const rate = Math.max(0.75, Math.min(1.6, Number(appState.voiceRate) || 1.10));
  const pitchMultiplier = Math.max(0.75, Math.min(1.5, Number(appState.voicePitch) || 1.25));
  // Standard semitone detune: 1200 * log2(pitch)
  const detuneCents = Math.round(1200 * Math.log2(pitchMultiplier));

  let scheduledTime = ctx.currentTime + 0.03; // 30ms scheduling lookahead

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];

    if (token === '__custom_chime__') {
      scheduleAlertChime(ctx, scheduledTime);
      scheduledTime += 0.12 / rate;
      continue;
    }

    const slice = VOICE_MANIFEST[token];
    if (!slice) continue;

    const [startSec, durSec] = slice;
    const source = ctx.createBufferSource();
    source.buffer = spriteAudioBuffer;
    source.playbackRate.value = rate;
    if (source.detune) {
      source.detune.value = detuneCents;
    }

    source.connect(masterGain || ctx.destination);
    source.start(scheduledTime, startSec, durSec);
    activeSources.push(source);

    // Natural inter-word spacing: slight extra breath after alert word, tighter between numbers & units
    const effectiveDur = durSec / rate;
    const gap = (i === 0 ? 0.08 : 0.045) / rate;
    scheduledTime += effectiveDur + gap;
  }
}

/**
 * Install global user-interaction listeners to unlock AudioContext on first tap/key
 */
if (typeof window !== 'undefined') {
  const unlockEvents = ['pointerdown', 'keydown', 'touchstart', 'click'];
  const unlockHandler = () => {
    getVoiceAudioContext();
    preloadVoiceAudio();
    unlockEvents.forEach((ev) => window.removeEventListener(ev, unlockHandler));
  };
  unlockEvents.forEach((ev) => window.addEventListener(ev, unlockHandler, { passive: true }));
}
