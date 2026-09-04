// Backend content script: caption extraction, storage, LLM calls; exposes API to UI via window.SeekWord.backend

// Prevent multiple initialization of content script
// Note: top-level `return` is illegal in content scripts, so avoid it.
if (window.CaptiPrepContentLoaded) {
  // Already loaded; keep definitions idempotent below.
} else {
  window.CaptiPrepContentLoaded = true;
}

// Avoid duplicate declarations when content script is injected multiple times
if (!window.CC_NS) {
  window.CC_NS = 'CCAPTIPREPS';
}
if (!window.t) {
  window.t = (k, ...subs) => (chrome.i18n && chrome.i18n.getMessage ? chrome.i18n.getMessage(k, subs) : '') || k;
}

// ===== Debug helper =====
// Avoid duplicate const redeclare when content script is injected twice
if (!('CC_DEBUG' in window)) {
  window.CC_DEBUG = false;
}
function dlog(...args) { if (window.CC_DEBUG) console.log('[SeekWord]', ...args); }

// ===== Settings & LLM bridge (background) =====
async function getSettings() {
  const resp = await chrome.runtime.sendMessage({ type: 'CC_GET_SETTINGS' });
  if (!resp || !resp.ok) return {};
  return resp.settings || {};
}

async function llmCall(role, data) {
  const resp = await chrome.runtime.sendMessage({ type: 'CC_LLM_CALL', payload: { role, data } });
  if (!resp || !resp.ok) throw new Error(resp && resp.error || 'Unknown error');
  return resp.result;
}

// ===== Local storage by video =====
async function loadVideoData(videoId) {
  const key = `${window.CC_NS}:video:${videoId}`;
  const data = await chrome.storage.local.get(key);
  return data[key] || null;
}

async function saveVideoData(videoId, patch) {
  const key = `${window.CC_NS}:video:${videoId}`;
  const current = await loadVideoData(videoId) || {};
  const next = { ...current, ...patch };
  await chrome.storage.local.set({ [key]: next });
}

// ===== 通用内容存储（通用化：文章/划词/手动等非视频来源）=====
// 键：CCAPTIPREPS:content:{contentId}。video:* 键保留兼容（YouTube 旧数据）。
async function loadContentData(contentId) {
  const key = `${window.CC_NS}:content:${contentId}`;
  const data = await chrome.storage.local.get(key);
  return data[key] || null;
}

async function saveContentData(contentId, patch) {
  const key = `${window.CC_NS}:content:${contentId}`;
  const current = await loadContentData(contentId) || {};
  const next = { ...current, ...patch, __ts: Date.now() };
  await chrome.storage.local.set({ [key]: next });
}

// ===== 内容源识别（通用化入口） =====
function isYouTubePage(url) {
  try {
    const h = new URL(url || location.href).host;
    return /(^|\.)youtube\.com$/i.test(h) || /(^|\.)youtu\.be$/i.test(h) || /(^|\.)youtube-nocookie\.com$/i.test(h);
  } catch { return false; }
}

/** 识别当前页面的内容源类型：youtube | selection | article */
function getCurrentSourceType() {
  if (isYouTubePage(location.href)) return 'youtube';
  try {
    const sel = (window.getSelection ? window.getSelection().toString() : '') || '';
    if (sel && sel.trim().length > 10) return 'selection';
  } catch {}
  return 'article';
}

/**
 * 统一内容捕获（通用化）。调用 capture.js（globalThis.CC_CAPTURE）。
 * @param {'article'|'selection'|'manual'} [sourceType] 缺省按页面自动识别
 * @param {{text?:string,title?:string,sourceUrl?:string}} [opts]
 */
async function captureContent(sourceType, opts) {
  const cc = globalThis.CC_CAPTURE;
  if (!cc) throw new Error('capture.js not loaded');
  const type = sourceType || (isYouTubePage(location.href) ? 'youtube' : getCurrentSourceType());
  if (type === 'youtube') {
    // YouTube 走原字幕管线
    const { videoId, title } = getYouTubeVideoInfo();
    const { text, lang } = await extractCaptionsText();
    return {
      id: videoId,
      sourceType: 'youtube',
      sourceUrl: location.href,
      title: title || videoId,
      text: text || '',
      lang: lang || '',
      meta: {},
    };
  }
  const captured = cc.captureContent(type, opts);
  return captured;
}


// ===== YouTube page info =====
function getYouTubeVideoInfo() {
  const url = new URL(location.href);
  let v = url.searchParams.get('v');
  if (!v) {
    const paths = location.pathname.split('/').filter(Boolean);
    if (paths[0] === 'shorts' && paths[1]) v = paths[1];
    if (!v && location.host.includes('youtu.be')) v = paths[0];
  }
  // Robust title detection: prefer visible H1 first (meta can lag on SPA navigation)
  const bad = (s) => !s || /^(untitled|\(untitled\)|youtube)$/i.test(String(s).trim());
  const pick = (...vals) => vals.find(t => !bad(t) && String(t).trim());

  // Visible title in the watch page
  const h1New = document.querySelector('ytd-watch-metadata h1 yt-formatted-string')?.textContent?.trim();
  const h1Old = document.querySelector('h1.title, h1#title, h1')?.textContent?.trim();

  // Meta tags (can be stale briefly during SPA navigation)
  const metaOg = document.querySelector('meta[property="og:title"]')?.content?.trim();
  const metaTw = document.querySelector('meta[name="twitter:title"]')?.content?.trim();
  const metaItem = document.querySelector('meta[itemprop="name"]')?.content?.trim();

  // Document title fallback
  let dt = document.title || '';
  if (dt.endsWith(' - YouTube')) dt = dt.replace(/ - YouTube$/,'').trim();

  // Prefer H1 -> meta -> document.title
  const title = pick(h1New, h1Old, metaOg, metaTw, metaItem, dt) || '';
  return { videoId: v, title };
}

// ===== Main-world helpers (via page_inject.js) =====
function getPlayerResponseMainWorld() {
  return new Promise((resolve) => {
    const onMsg = (event) => {
      if (event.source !== window) return;
      if (event.origin !== location.origin) return;
      const d = event.data;
      if (!d || d.type !== 'CC_PLAYER_RESPONSE') return;
      window.removeEventListener('message', onMsg);
      resolve(d.payload || null);
    };
    window.addEventListener('message', onMsg);
    const s = document.createElement('script');
    s.src = chrome.runtime.getURL('page_inject.js');
    (document.head || document.documentElement).appendChild(s);
    s.addEventListener('load', () => setTimeout(() => s.remove(), 0));
  });
}

// Use window property to avoid redeclaration error
if (!window.__cc_injectorReady) {
  window.__cc_injectorReady = null;
}

function ensureInjectorLoaded() {
  if (window.__cc_injectorReady) return window.__cc_injectorReady;
  window.__cc_injectorReady = new Promise((resolve) => {
    try {
      const s = document.createElement('script');
      s.src = chrome.runtime.getURL('page_inject.js');
      s.addEventListener('load', () => resolve(true));
      (document.head || document.documentElement).appendChild(s);
      setTimeout(() => resolve(true), 300);
    } catch {
      resolve(true);
    }
  });
  return window.__cc_injectorReady;
}

function ytApiPostMainWorld(endpoint, payload, opts = {}) {
  return new Promise((resolve) => {
    const id = 'yt_' + Math.random().toString(36).slice(2);
    const onMsg = (event) => {
      if (event.source !== window) return;
      if (event.origin !== location.origin) return;
      const d = event.data;
      if (!d || d.type !== 'CC_YT_API_RESULT' || d.id !== id) return;
      window.removeEventListener('message', onMsg);
      resolve({ ok: !!d.ok, status: d.status || 0, contentType: d.contentType || '', json: d.json || null, text: d.text || '', error: d.error });
    };
    window.addEventListener('message', onMsg);
    try {
      window.postMessage({ type: 'CC_YT_API', id, endpoint, payload, apiKey: opts.apiKey, clientVersion: opts.clientVersion }, location.origin);
    } catch (e) {
      window.removeEventListener('message', onMsg);
      resolve({ ok: false, status: 0, contentType: '', json: null, text: '', error: String(e) });
    }
    setTimeout(() => {
      try { window.removeEventListener('message', onMsg); } catch {}
      resolve({ ok: false, status: 0, contentType: '', json: null, text: '', error: 'timeout' });
    }, 5000);
  });
}

function fetchCaptionMainWorld(url) {
  return new Promise((resolve) => {
    const id = 'f_' + Math.random().toString(36).slice(2);
    const onMsg = (event) => {
      if (event.source !== window) return;
      if (event.origin !== location.origin) return;
      const d = event.data;
      if (!d || d.type !== 'CC_FETCH_CAPTION_RESULT' || d.id !== id) return;
      window.removeEventListener('message', onMsg);
      resolve({ ok: !!d.ok, status: d.status || 0, contentType: d.contentType || '', text: d.text || '', error: d.error });
    };
    window.addEventListener('message', onMsg);
    try { window.postMessage({ type: 'CC_FETCH_CAPTION', id, url }, location.origin); } catch (e) {
      window.removeEventListener('message', onMsg);
      resolve({ ok: false, status: 0, contentType: '', text: '', error: String(e) });
    }
    setTimeout(() => {
      try { window.removeEventListener('message', onMsg); } catch {}
      resolve({ ok: false, status: 0, contentType: '', text: '', error: 'timeout' });
    }, 10000);
  });
}

function getSelectedCaptionTrackMainWorld() {
  return new Promise((resolve) => {
    const id = 'sel_' + Math.random().toString(36).slice(2);
    const onMsg = (event) => {
      if (event.source !== window) return;
      if (event.origin !== location.origin) return;
      const d = event.data;
      if (!d || d.type !== 'CC_SELECTED_CC' || d.id !== id) return;
      window.removeEventListener('message', onMsg);
      resolve((d.ok && d.track) ? d.track : null);
    };
    window.addEventListener('message', onMsg);
    try { window.postMessage({ type: 'CC_GET_SELECTED_CC', id }, location.origin); } catch (e) {
      window.removeEventListener('message', onMsg);
      resolve(null);
    }
    setTimeout(() => {
      try { window.removeEventListener('message', onMsg); } catch {}
      resolve(null);
    }, 1500);
  });
}


// ===== [read-frog 借鉴] 播放器 pot 字幕通道 =====
function requestYtCaptionData(videoId, opts) {
  // 轮询版：播放器未就绪时返回空数据，最多轮询到 timeout 拿到非空数据为止
  const timeout = (opts && opts.timeout) || 9000;
  const interval = (opts && opts.interval) || 700;
  const start = Date.now();
  return new Promise((resolve) => {
    let done = false;
    const finish = (d) => { if (!done) { done = true; resolve(d); } };
    const tryOnce = () => {
      const id = 'cap_' + Math.random().toString(36).slice(2);
      const onMsg = (event) => {
        if (event.source !== window) return;
        if (event.origin !== location.origin) return;
        const d = event.data;
        if (!d || d.type !== 'CC_YT_CAPTION_DATA_RESULT' || d.id !== id) return;
        window.removeEventListener('message', onMsg);
        const hasData = d && d.ok && ((Array.isArray(d.tracks) && d.tracks.length) || (Array.isArray(d.audioCaptionTracks) && d.audioCaptionTracks.length) || !!d.cachedTimedtextUrl);
        if (hasData || (d && !d.ok) || Date.now() - start > timeout) { finish(d); }
        // 空数据：等待下一轮重试
      };
      window.addEventListener('message', onMsg);
      try { window.postMessage({ type: 'CC_YT_CAPTION_DATA', id, videoId }, location.origin); } catch (e) {
        window.removeEventListener('message', onMsg); finish({ ok: false, error: String(e) }); return;
      }
      setTimeout(() => {
        try { window.removeEventListener('message', onMsg); } catch {}
        if (Date.now() - start > timeout) { finish({ ok: false, error: 'timeout' }); return; }
        setTimeout(tryOnce, interval);
      }, interval);
    };
    tryOnce();
  });
}
function ensureYtCaptions() {
  return new Promise((resolve) => {
    const id = 'cc_' + Math.random().toString(36).slice(2);
    const onMsg = (event) => {
      if (event.source !== window) return;
      if (event.origin !== location.origin) return;
      const d = event.data;
      if (!d || d.type !== 'CC_YT_ENSURE_CC_RESULT' || d.id !== id) return;
      window.removeEventListener('message', onMsg);
      resolve(true);
    };
    window.addEventListener('message', onMsg);
    try { window.postMessage({ type: 'CC_YT_ENSURE_CC', id }, location.origin); } catch (e) { resolve(false); }
    setTimeout(() => { try { window.removeEventListener('message', onMsg); } catch {} resolve(false); }, 1500);
  });
}
function waitYtTimedtext(videoId, timeout) {
  return new Promise((resolve) => {
    const id = 'tw_' + Math.random().toString(36).slice(2);
    const onMsg = (event) => {
      if (event.source !== window) return;
      if (event.origin !== location.origin) return;
      const d = event.data;
      if (!d || d.type !== 'CC_YT_WAIT_TIMEDTEXT_RESULT' || d.id !== id) return;
      window.removeEventListener('message', onMsg);
      resolve(d.url || null);
    };
    window.addEventListener('message', onMsg);
    try { window.postMessage({ type: 'CC_YT_WAIT_TIMEDTEXT', id, videoId, timeout }, location.origin); } catch (e) { resolve(null); }
    setTimeout(() => { try { window.removeEventListener('message', onMsg); } catch {} resolve(null); }, (timeout || 8000) + 500);
  });
}
// 从带 pot 的 audioCaptionTracks 里选一条（优先用户当前选中轨道 → 默认轨道同语言 → 第一条）
function pickAudioTrack(audioTracks, selected, textTracks) {
  if (!Array.isArray(audioTracks) || !audioTracks.length) return null;
  const selVss = selected && selected.vssId;
  const selLang = selected && selected.languageCode;
  let t = selVss ? audioTracks.find((x) => String(x.vssId || '') === String(selVss)) : null;
  if (!t && selLang) t = audioTracks.find((x) => (x.languageCode || '') === selLang) || null;
  if (!t && textTracks && textTracks.length) {
    const def = textTracks[0];
    t = audioTracks.find((x) => (x.languageCode || '') === (def.languageCode || '')) || null;
  }
  if (!t) t = audioTracks[0] || null;
  return t;
}
function langFromYtUrl(u) {
  try { return new URL(u).searchParams.get('lang') || 'und'; } catch { return 'und'; }
}
// 从 audioCaptionTracks 提取 pot/potc（参考 read-frog pot-token.ts）
function extractPotFromAudio(audioTracks, track) {
  if (!Array.isArray(audioTracks) || !audioTracks.length) return { pot: null, potc: null };
  const vss = track && track.vssId;
  const lang = track && track.languageCode;
  let t = vss ? audioTracks.find((x) => String(x.vssId || '') === String(vss)) : null;
  if (!t && lang) t = audioTracks.find((x) => (x.languageCode || '') === lang) || null;
  if (!t) t = audioTracks[0] || null;
  if (!t || !t.url) return { pot: null, potc: null };
  try {
    const u = new URL(t.url);
    return { pot: u.searchParams.get('pot'), potc: u.searchParams.get('potc') };
  } catch { return { pot: null, potc: null }; }
}
// 重建带签名 timedtext URL（参考 read-frog url-builder.ts：baseUrl + FIXED_PARAMS + device + cver + pot）
function buildPotUrl(track, pot, potc, device, cver) {
  try {
    const u = new URL(track.baseUrl);
    const FIXED = { fmt: 'json3', xorb: '2', xobt: '3', xovt: '3', c: 'WEB', cplayer: 'UNIPLAYER' };
    Object.keys(FIXED).forEach((k) => u.searchParams.set(k, FIXED[k]));
    if (device) {
      const dp = new URLSearchParams(device);
      ['cbrand', 'cbr', 'cbrver', 'cos', 'cosver', 'cplatform'].forEach((k) => { const v = dp.get(k); if (v) u.searchParams.set(k, v); });
    }
    if (cver) u.searchParams.set('cver', cver);
    if (pot) u.searchParams.set('pot', pot);
    if (potc) u.searchParams.set('potc', potc);
    return u.toString();
  } catch { return track.baseUrl; }
}

// ===== Caption extraction pipeline =====
function appendParam(url, key, value) {
  try {
    const u = new URL(url);
    if (!u.searchParams.has(key)) u.searchParams.append(key, value);
    return u.toString();
  } catch {
    const sep = url.includes('?') ? '&' : '?';
    if (url.includes(`${key}=`)) return url;
    return `${url}${sep}${encodeURIComponent(key)}=${encodeURIComponent(value)}`;
  }
}
function buildUrlWithFmt(base, fmt) { if (!base) return ''; return appendParam(base, 'fmt', fmt); }
function isJsonLike(ct) { const c = (ct || '').toLowerCase(); return c.includes('application/json') || c.includes('+json'); }
function safeJsonParse(text) { try { return JSON.parse(text); } catch { return null; } }

function captionsJsonToText(json) {
  if (!json || !Array.isArray(json.events)) return '';
  const parts = [];
  for (const ev of json.events) {
    if (!ev.segs) continue;
    const line = ev.segs.map(s => s.utf8).join('').replace(/\s+/g, ' ').trim();
    if (line) parts.push(line);
  }
  return parts.join('\n');
}

function captionsVttToText(vtt) {
  if (!vtt) return '';
  const lines = String(vtt).replace(/^\uFEFF/, '').split(/\r?\n/);
  const out = []; let buf = [];
  const flush = () => { const s = buf.join(' ').replace(/\s+/g, ' ').trim(); if (s) out.push(s); buf = []; };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) { flush(); continue; }
    if (i === 0 && /^WEBVTT/i.test(line)) continue;
    if (/^NOTE(\s|$)/i.test(line)) continue;
    if (/^\d+$/.test(line)) continue;
    if (/^\d{2}:\d{2}:\d{2}\.\d{3}\s+--\>/.test(line) || /^\d{2}:\d{2}\.\d{3}\s+--\>/.test(line)) continue;
    const text = line.replace(/<[^>]+>/g, '').trim();
    if (text) buf.push(text);
  }
  flush();
  return out.join('\n');
}

async function fetchAndExtract(url) {
  const res = await fetchCaptionMainWorld(url);
  dlog('fetchAndExtract:', url, 'status:', res.status, 'ct:', res.contentType);
  if (!res.ok) return '';
  const ct = res.contentType || '';
  if (isJsonLike(ct)) {
    const data = safeJsonParse(res.text || '');
    const text = data ? captionsJsonToText(data) : '';
    return text || '';
  } else {
    const raw = res.text || '';
    const data = safeJsonParse(raw);
    if (data) {
      const text = captionsJsonToText(data);
      return text || '';
    }
    const vttText = captionsVttToText(raw);
    return vttText || '';
  }
}

function extractTranscriptTokenFromNext(nextData) {
  const panels = nextData?.engagementPanels;
  if (!Array.isArray(panels)) return null;
  const panel = panels.find(p => p?.engagementPanelSectionListRenderer?.panelIdentifier === 'engagement-panel-searchable-transcript');
  if (!panel) return null;
  const content = panel.engagementPanelSectionListRenderer?.content;
  let token = content?.continuationItemRenderer?.continuationEndpoint?.continuationCommand?.token
    || content?.continuationItemRenderer?.continuationEndpoint?.getTranscriptEndpoint?.params;
  if (!token && content?.sectionListRenderer?.contents?.[0]?.continuationItemRenderer?.continuationEndpoint?.continuationCommand?.token) {
    token = content.sectionListRenderer.contents[0].continuationItemRenderer.continuationEndpoint.continuationCommand.token;
  }
  if (!token && content?.sectionListRenderer?.contents) {
    for (const item of content.sectionListRenderer.contents) {
      const menu = item?.transcriptRenderer?.footer?.transcriptFooterRenderer?.languageMenu?.sortFilterSubMenuRenderer?.subMenuItems;
      if (Array.isArray(menu) && menu.length) {
        // Prefer currently selected language; otherwise the first entry as YouTube's default
        const chosen = menu.find(i => i?.selected) || menu[0];
        token = chosen?.continuation?.reloadContinuationData?.continuation;
        if (token) break;
      }
    }
  }
  return token || null;
}

function transcriptSegmentsToLines(transcriptData) {
  const segments = transcriptData?.actions?.[0]?.updateEngagementPanelAction?.content?.transcriptRenderer?.content?.transcriptSearchPanelRenderer?.body?.transcriptSegmentListRenderer?.initialSegments;
  if (!Array.isArray(segments)) return [];
  const lines = [];
  for (const seg of segments) {
    const r = seg?.transcriptSegmentRenderer; if (!r) continue;
    let text = '';
    if (r.snippet?.simpleText) text = r.snippet.simpleText;
    else if (Array.isArray(r.snippet?.runs)) text = r.snippet.runs.map(x => x.text).join('');
    else if (r.snippet?.text) text = r.snippet.text;
    text = String(text).replace(/<[^>]*>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
    text = text.replace(/\s+/g, ' ').trim();
    if (text) lines.push(text);
  }
  return lines;
}

function chooseDefaultTrack(tracks, selected) {
  if (!Array.isArray(tracks) || !tracks.length) return null;
  const safeTracks = tracks.filter(t => !/[?&]tlang=/.test(String(t.baseUrl || '')));
  const pool = safeTracks.length ? safeTracks : tracks;

  // If user selected a non-translation track (e.g., auto-generated in the native language), honor it by language and kind
  const isTranslatedSel = !!(selected && selected.translationLanguage);
  if (selected && !isTranslatedSel) {
    const lang = selected.languageCode || selected.lang || '';
    const kind = (selected.kind || '').toLowerCase();
    // Exact vssId match
    if (selected.vssId) {
      const byVss = pool.find(t => t.vssId === selected.vssId);
      if (byVss) return byVss;
    }
    // Prefer same language + same kind
    if (lang) {
      const byLangKind = pool.find(t => (t.languageCode === lang) && ((t.kind || '').toLowerCase() === kind));
      if (byLangKind) return byLangKind;
      // Then any with same language
      const byLang = pool.find(t => t.languageCode === lang);
      if (byLang) return byLang;
    }
  }

  // If selection is a translation, avoid using it; pick the first sane non-translation track (usually the source CC)
  const nonAsrFirst = pool.find(t => !t.kind || t.kind !== 'asr');
  return nonAsrFirst || pool[0] || null;
}

async function tryTranscriptViaPage(videoId) {
  try {
    await ensureInjectorLoaded();
    const session = { context: { client: { hl: 'en', gl: 'US', clientName: 'WEB' }, user: { enableSafetyMode: false }, request: { useSsl: true } } };
    const nextRes = await ytApiPostMainWorld('/next', { ...session, videoId });
    if (!nextRes.ok) return '';
    const nextData = nextRes.json || null;
    // IMPORTANT: the transcript panel may default to auto-translated language based on previous videos.
    // We do NOT want translated transcripts. We’ll still read a token, but only use it as a fallback
    // and prefer captionTracks fetch path for original captions.
    // Disable transcript panel fallback to avoid auto-translation bleed-through.
    // Keeping the code for potential future gated use, but returning empty to skip this path.
    const text = '';
    // Try to infer language from currently selected CC, falling back to available tracks
    let lang = 'und';
    try {
      const injected = await getPlayerResponseMainWorld();
      const tracks = injected?.captions?.playerCaptionsTracklistRenderer?.captionTracks || [];
      const selected = await getSelectedCaptionTrackMainWorld();
      const pick = chooseDefaultTrack(tracks, selected);
      if (pick && pick.languageCode) lang = pick.languageCode;
    } catch {}
    if (text) return { text, lang };
    return '';
  } catch { return ''; }
}

async function extractCaptionsText() {
  dlog('Starting caption extraction');
  await ensureInjectorLoaded();

  // 0) [read-frog 借鉴] pot 优先通道：播放器真实字幕 URL 自带 pot 签名，最不易 403
  const diag = [];
  try {
    const { videoId: vid0 } = getYouTubeVideoInfo();
    if (vid0) {
      // 轮询等待播放器就绪 + 数据（最多 9s）
      const cap = await requestYtCaptionData(vid0, { timeout: 9000 });
      if (cap && cap.ok) {
        const nTrack = Array.isArray(cap.tracks) ? cap.tracks.length : 0;
        const nAudio = Array.isArray(cap.audioCaptionTracks) ? cap.audioCaptionTracks.length : 0;
        diag.push('播放器 tracks=' + nTrack + ' audio=' + nAudio + ' cached=' + (cap.cachedTimedtextUrl ? '有' : '无'));
        // a) 拦截到的真实 timedtext URL（播放器实际请求，含 pot）
        if (cap.cachedTimedtextUrl) {
          const langA = langFromYtUrl(cap.cachedTimedtextUrl);
          for (const fmt of ['json3', 'srv3', 'vtt']) {
            try {
              const text = await fetchAndExtract(buildUrlWithFmt(cap.cachedTimedtextUrl, fmt));
              if (text && text.trim()) return { text, lang: langA };
            } catch {}
          }
          diag.push('cached timedtext 三个格式均失败');
        }
        // b) audioCaptionTracks 提供 pot/potc → 重建 captionTrack.baseUrl（read-frog 方式）
        const audioTracks = Array.isArray(cap.audioCaptionTracks) ? cap.audioCaptionTracks : [];
        const textTracks = Array.isArray(cap.tracks) ? cap.tracks : [];
        if (audioTracks.length && textTracks.length) {
          const selected = await getSelectedCaptionTrackMainWorld();
          const pick = chooseDefaultTrack(textTracks, selected);
          if (pick && pick.baseUrl) {
            const potObj = extractPotFromAudio(audioTracks, pick);
            if (potObj.pot) {
              const built = buildPotUrl(pick, potObj.pot, potObj.potc, cap.device, cap.cver);
              dlog('重建 pot URL:', built);
              const langB = pick.languageCode || 'und';
              try {
                const text = await fetchAndExtract(built);
                if (text && text.trim()) return { text, lang: langB };
              } catch {}
              diag.push('重建 pot URL 仍失败');
            } else {
              diag.push('audio 轨道未找到 pot 参数');
            }
          }
        }
        // c) 有轨道但无 pot：强制开字幕，等播放器发出带 pot 的 timedtext 请求（两轮，共 15s）
        if (nTrack && !cap.cachedTimedtextUrl) {
          await ensureYtCaptions();
          let tUrl = await waitYtTimedtext(vid0, 10000);
          if (!tUrl) { await ensureYtCaptions(); tUrl = await waitYtTimedtext(vid0, 5000); }
          if (tUrl) {
            const langC = langFromYtUrl(tUrl);
            for (const fmt of ['json3', 'srv3', 'vtt']) {
              try {
                const text = await fetchAndExtract(buildUrlWithFmt(tUrl, fmt));
                if (text && text.trim()) return { text, lang: langC };
              } catch {}
            }
            diag.push('开字幕后 timedtext 仍失败');
          } else {
            diag.push('开字幕 15s 内未拦截到带 pot 的 timedtext');
          }
        }
      } else {
        diag.push('播放器数据获取失败: ' + (cap && cap.error));
        dlog('POT 通道无数据:', cap && cap.error);
      }
    }
  } catch (e) { diag.push('POT 通道异常: ' + (e && e.message || e)); dlog('POT 通道失败:', e && e.message || e); }

  // 1) Prefer direct captionTracks fetch (original captions), to avoid auto-translated transcript bleed
  try {
    const injected = await getPlayerResponseMainWorld();
    const tracks = injected?.captions?.playerCaptionsTracklistRenderer?.captionTracks || [];
    const selected = await getSelectedCaptionTrackMainWorld();
    const pick = chooseDefaultTrack(tracks, selected);
    if (pick && pick.baseUrl) {
      const base = pick.baseUrl;
      const finalLang = pick.languageCode || 'und';
      for (const fmt of ['json3','srv3','vtt']) {
        try {
          const text = await fetchAndExtract(buildUrlWithFmt(base, fmt));
          if (text && text.trim()) return { text, lang: finalLang };
        } catch {}
      }
    }
  } catch (e) { dlog('Player response method failed:', e?.message || e); }

  // 2) Fallback: call InnerTube /player for a fresh playerResponse (often includes captionTracks when the initial snapshot lacks them)
  try {
    const { videoId } = getYouTubeVideoInfo();
    if (videoId) {
      const session = { context: { client: { hl: 'en', gl: 'US', clientName: 'WEB' }, user: { enableSafetyMode: false }, request: { useSsl: true } } };
      const prRes = await ytApiPostMainWorld('/player', { ...session, videoId });
      if (prRes && prRes.ok) {
        const pr = prRes.json || null;
        const tracks = pr?.captions?.playerCaptionsTracklistRenderer?.captionTracks || [];
        const selected = await getSelectedCaptionTrackMainWorld();
        const pick = chooseDefaultTrack(tracks, selected);
        if (pick && pick.baseUrl) {
          const base = pick.baseUrl;
          const finalLang = pick.languageCode || 'und';
          for (const fmt of ['json3','srv3','vtt']) {
            try {
              const text = await fetchAndExtract(buildUrlWithFmt(base, fmt));
              if (text && text.trim()) return { text, lang: finalLang };
            } catch {}
          }
        }
      } else {
        dlog('InnerTube /player fallback failed:', prRes && prRes.status, prRes && prRes.error);
      }
    }
  } catch (e) { dlog('InnerTube /player fallback error:', e?.message || e); }

  const { videoId } = getYouTubeVideoInfo();
  if (!videoId) throw new Error(window.t('error_no_video'));

  // 3) Fallback: keyless multi-client InnerTube /player (background, independent of page state)
  try {
    const prRes = await chrome.runtime.sendMessage({ type: 'CC_YT_PLAYER_DIRECT', videoId });
    const tracks = (prRes && Array.isArray(prRes.tracks)) ? prRes.tracks : [];
    if (tracks.length) {
      const selected = await getSelectedCaptionTrackMainWorld();
      const pick = chooseDefaultTrack(tracks, selected);
      if (pick && pick.baseUrl) {
        const base = pick.baseUrl;
        const finalLang = pick.languageCode || 'und';
        for (const fmt of ['json3','srv3','vtt']) {
          try {
            const text = await fetchAndExtract(buildUrlWithFmt(base, fmt));
            if (text && text.trim()) return { text, lang: finalLang };
          } catch {}
        }
      }
    } else {
      dlog('Direct InnerTube fallback failed:', prRes && prRes.error);
    }
  } catch (e) { dlog('Direct InnerTube fallback error:', e?.message || e); }

  const diagMsg = diag && diag.length ? ' [' + diag.join(' | ') + ']' : '';
  dlog('字幕提取失败，诊断:', diagMsg);
  const err = new Error(window.t('error_no_captions') + diagMsg);
  err.captionDiag = diag || [];
  throw err;
}

// ===== Expose backend to UI =====
(function expose() {
  const backend = {
    getSettings,
    llmCall,
    loadVideoData,
    saveVideoData,
    loadContentData,
    saveContentData,
    captureContent,
    getCurrentSourceType,
    isYouTubePage,
    getYouTubeVideoInfo,
    extractCaptionsText,
    // Expose current selected caption track (from page context)
    async getSelectedCaptionTrack() {
      try {
        await ensureInjectorLoaded();
        const raw = await getSelectedCaptionTrackMainWorld();
        if (!raw) return null;
        // Normalize translationLanguage to a code string if possible
        let tl = '';
        try {
          const t = raw.translationLanguage;
          tl = typeof t === 'string' ? t : (t && (t.languageCode || t.lang || '')) || '';
        } catch {}
        return {
          languageCode: raw.languageCode || raw.lang || '',
          vssId: raw.vssId || '',
          kind: raw.kind || '',
          translationLanguage: tl,
          name: raw.name || ''
        };
      } catch { return null; }
    },
  };
  globalThis.CaptiPrep = Object.assign(globalThis.CaptiPrep || {}, { backend });
  dlog('Backend exposed');
})();
