// assets/tts.js — Browser speech synthesis (TTS) module
// Exposes globalThis.CC_TTS. Safe to inject multiple times (IIFE + namespace guard).
// Usage (from ui.js content script or wordbook.js page):
//   const tts = await ensureTTS();
//   tts.speak('word', { lang: 'en', accent: 'us', rate: 0.9, onEnd, onError });
//   tts.stop(); tts.isSpeaking();
(() => {
  if (globalThis.CC_TTS) return; // already injected

  const SYNTH = (typeof window !== 'undefined' && window.speechSynthesis) || null;

  // ---------------------------------------------------------------------------
  // Voice loading (async; Chrome's getVoices() is empty on first call)
  // ---------------------------------------------------------------------------
  let voices = [];
  let voicesPromise = null;

  function loadVoices() {
    if (!SYNTH) return Promise.resolve([]);
    if (voicesPromise) return voicesPromise;
    voicesPromise = new Promise((resolve) => {
      const collect = () => {
        const list = SYNTH.getVoices();
        if (list && list.length) { voices = list; return true; }
        return false;
      };
      if (collect()) { resolve(voices); return; }
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        collect();
        resolve(voices);
      };
      try { SYNTH.addEventListener('voiceschanged', finish); } catch {}
      let tries = 0;
      const poll = setInterval(() => {
        tries++;
        if (collect()) { finish(); clearInterval(poll); }
        else if (tries >= 30) { finish(); clearInterval(poll); }
      }, 100);
      setTimeout(() => { finish(); clearInterval(poll); }, 4000);
    });
    return voicesPromise;
  }

  // ---------------------------------------------------------------------------
  // Language helpers
  // ---------------------------------------------------------------------------
  // Quick heuristic when no lang is provided (e.g. wordbook cards carry no lang)
  function detectLang(text) {
    const s = String(text || '');
    if (/[\u3040-\u30FF]/.test(s)) return 'ja';
    if (/[\uAC00-\uD7AF]/.test(s)) return 'ko';
    if (/[\u4E00-\u9FFF]/.test(s)) return 'zh_CN';
    if (/[\u0400-\u04FF]/.test(s)) return 'ru';
    return 'en';
  }

  // Normalized lang + accent -> candidate voice lang prefixes (best first)
  function langCandidates(lang, accent) {
    const L = String(lang || '').toLowerCase().replace('_', '-');
    if (L.startsWith('en')) return accent === 'uk' ? ['en-GB', 'en'] : ['en-US', 'en'];
    if (L.startsWith('ja')) return ['ja-JP', 'ja'];
    if (L.startsWith('ko')) return ['ko-KR', 'ko'];
    if (L.startsWith('zh-tw') || L.startsWith('zh-hk')) return ['zh-TW', 'zh-HK', 'zh-Hant', 'zh'];
    if (L.startsWith('zh')) return ['zh-CN', 'zh-Hans-CN', 'zh'];
    if (L.startsWith('ru')) return ['ru-RU', 'ru'];
    if (L.startsWith('fr')) return ['fr-FR', 'fr'];
    if (L.startsWith('de')) return ['de-DE', 'de'];
    if (L.startsWith('es')) return ['es-ES', 'es'];
    return [];
  }

  // Quality score: prefer natural/neural/online voices (much better audio),
  // fall back to local system voices only when no high-quality one exists.
  function voiceScore(v) {
    const n = String(v && v.name || '').toLowerCase();
    let s = 0;
    if (n.includes('google')) s += 3; // Chrome/Google online voices
    if (/natural|neural|online|premium|enhanced/.test(n)) s += 2; // neural/natural voices
    if (v.localService === false) s += 1; // online voices generally sound better
    if (/desktop|zira|david|mark|mike|hazel|zira|onecore|sapi|mobile|heera|ravi|kiran/.test(n)) s -= 2; // old robotic voices
    return s;
  }

  // Pick the best-sounding voice for a language; prefers high-quality
  // online/neural voices, with local voices only as a fallback.
  function pickVoice(lang, accent) {
    if (!SYNTH) return null;
    const cands = langCandidates(lang, accent);
    if (!cands.length) return null;
    const pool = voices.filter((v) => v && v.lang);
    if (!pool.length) return null;
    const best = (list) => (list.length ? list.slice().sort((a, b) => voiceScore(b) - voiceScore(a))[0] : null);
    // exact language match first (highest quality within it)
    for (const prefix of cands) {
      const exact = pool.filter((v) => v.lang.toLowerCase() === prefix.toLowerCase());
      const m = best(exact);
      if (m) return m;
    }
    // otherwise any voice sharing the base language
    const base = String(cands[0]).split('-')[0].toLowerCase();
    return best(pool.filter((v) => String(v.lang || '').toLowerCase().startsWith(base)));
  }

  // ---------------------------------------------------------------------------
  // Playback state machine
  // ---------------------------------------------------------------------------
  let isSpeakingNow = false;
  let currentQueue = null;

  function stop() {
    stopEdgeAudio();
    if (!SYNTH) return;
    try { SYNTH.cancel(); } catch {}
    isSpeakingNow = false;
    const q = currentQueue;
    currentQueue = null;
    if (q && q.onEnd) { try { q.onEnd(); } catch {} }
    if (q && q.resolve) { try { q.resolve(); } catch {} }
  }

  function isSpeaking() { return isSpeakingNow; }

  // Split text by sentence boundaries (~<=maxLen chars each) so long utterances
  // are not silently truncated by Chrome's ~15s limit.
  function splitChunks(text, maxLen = 180) {
    const src = String(text || '').trim();
    if (!src) return [];
    if (src.length <= maxLen) return [src];
    const parts = src.match(/[^.!?。！？…]+[.!?。！？…]?[\s]*/g) || [];
    const chunks = [];
    let cur = '';
    for (const p of parts) {
      if ((cur + p).trim().length > maxLen && cur.trim()) {
        chunks.push(cur.trim());
        cur = p;
      } else {
        cur += p;
      }
    }
    if (cur.trim()) chunks.push(cur.trim());
    // hard-split any remaining overlong chunk as a safety net
    return chunks.flatMap((ch) =>
      ch.length > maxLen ? (ch.match(/.{1,180}/g) || [ch]) : [ch]
    );
  }

  // ---------------------------------------------------------------------------
  // Edge TTS engine: synthesizes via background (free, neural voices), plays the
  // returned audio. Falls back to the system Web Speech engine on any failure.
  // ---------------------------------------------------------------------------
  let __edgeAudio = null;

  function stopEdgeAudio() {
    if (__edgeAudio) {
      try { __edgeAudio.onended = null; __edgeAudio.onerror = null; __edgeAudio.pause(); } catch (e) {}
      __edgeAudio = null;
    }
  }

  function isEdgeSupported() {
    return typeof chrome !== 'undefined' && !!chrome.runtime && !!chrome.runtime.sendMessage;
  }

  function pickEdgeVoice(lang, accent) {
    const L = String(lang || '').toLowerCase().replace('_', '-');
    const uk = L.indexOf('en-gb') === 0 || (L === 'en' && accent === 'uk');
    return uk ? 'en-GB-SoniaNeural' : 'en-US-AriaNeural';
  }

  // Speak via background Edge TTS; fall back to system voices on any error or timeout.
  function edgeSpeak(text, opts) {
    return new Promise((resolve) => {
      const fallback = () => { systemSpeak(text, opts).then(() => resolve()); };
      if (!isEdgeSupported()) { fallback(); return; }
      const voice = pickEdgeVoice(opts.lang, opts.accent);
      const rate = typeof opts.rate === 'number' ? opts.rate : 1;
      let settled = false;
      // 冷启动优化：Edge TTS 3 秒未返回则自动回退浏览器语音，避免用户长时间等待
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        fallback();
      }, 3000);
      try {
        chrome.runtime.sendMessage({ type: 'CC_EDGE_TTS', text: String(text || ''), voice, rate }, (r) => {
          if (settled) return; // 已超时回退，忽略迟到的响应
          clearTimeout(timer);
          settled = true;
          if (chrome.runtime.lastError || !r || !r.ok || !r.audioBase64) { fallback(); return; }
          try {
            const audio = new Audio('data:' + (r.contentType || 'audio/mpeg') + ';base64,' + r.audioBase64);
            __edgeAudio = audio;
            audio.onended = () => {
              if (__edgeAudio === audio) __edgeAudio = null;
              if (opts.onEnd) { try { opts.onEnd(); } catch {} }
              resolve();
            };
            audio.onerror = () => { if (__edgeAudio === audio) __edgeAudio = null; fallback(); };
            audio.play().catch(() => { fallback(); });
          } catch (e) { fallback(); }
        });
      } catch (e) { clearTimeout(timer); fallback(); }
    });
  }

  // Entry point: dispatch to Edge TTS (default) or the system Web Speech engine.
  function speak(text, opts = {}) {
    const engine = opts.engine || 'edge';
    if (engine === 'edge' && isEdgeSupported()) return edgeSpeak(text, opts);
    return systemSpeak(text, opts);
  }

  // System Web Speech engine (original implementation).
  function systemSpeak(text, opts = {}) {
    return new Promise((resolve) => {
      if (!SYNTH || typeof SYNTH.speak !== 'function') { resolve(); return; }
      const lang = opts.lang || detectLang(text);
      const accent = opts.accent || 'us';
      const rate = typeof opts.rate === 'number' ? opts.rate : 0.9;
      const chunks = splitChunks(text);
      if (!chunks.length) { resolve(); return; }

      stop(); // cancel any current playback
      isSpeakingNow = true;
      let i = 0;
      const q = { resolve };
      currentQueue = q;

      const finished = () => {
        if (currentQueue !== q) return; // superseded by a newer speak/stop
        currentQueue = null;
        isSpeakingNow = false;
        if (opts.onEnd) { try { opts.onEnd(); } catch {} }
        resolve();
      };

      const playNext = () => {
        if (currentQueue !== q) return; // stopped / replaced
        if (i >= chunks.length) { finished(); return; }
        const u = new SpeechSynthesisUtterance(chunks[i++]);
        const v = pickVoice(lang, accent);
        if (v) { u.voice = v; u.lang = v.lang; }
        u.rate = rate;
        u.pitch = 1;
        u.onend = () => { if (currentQueue !== q) return; playNext(); };
        u.onerror = (e) => {
          if (e && e.error === 'interrupted') {
            // normal on cancel(); resolve defensively in case stop() wasn't called
            if (currentQueue === q) { currentQueue = null; isSpeakingNow = false; try { q.resolve(); } catch {} }
            return;
          }
          if (currentQueue !== q) return;
          if (opts.onError) { try { opts.onError(e); } catch {} }
          finished();
        };
        try { SYNTH.speak(u); } catch (e) {
          if (opts.onError) { try { opts.onError(e); } catch {} }
          finished();
          return;
        }
        // nudge: wake the engine if it stalled (Chrome quirk)
        setTimeout(() => { try { if (SYNTH.paused) SYNTH.resume(); } catch {} }, 10);
      };

      playNext();
    });
  }

  globalThis.CC_TTS = { loadVoices, pickVoice, speak, stop, isSpeaking, detectLang };
})();
