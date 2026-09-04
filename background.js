// Background service worker (MV3, ESM)

// Default settings
const DEFAULT_SETTINGS = {
  provider: 'gemini',
  baseUrl: '', // will derive by provider
  apiKey: '',
  model: 'gemini-2.5-flash',
  // New: allow different models per role (fallback to `model`)
  modelFirst: 'gemini-2.5-flash-lite',
  modelSecond: 'gemini-2.5-flash',
  accent: 'us', // 'us' or 'uk'
  // New: definition/notes language for cards. 'auto' follows browser language on first run.
  // Supported: 'en','zh_CN','zh_TW','ja','ko','ru','fr','de','es'
  glossLang: 'auto',
  // UI language override: 'auto' | 'en' | 'zh_CN'
  uiLang: 'auto',
  // 可选：Firecrawl API Key（PDF 提取兜底；留空走无 key 免费档，按 IP 限流）
  ttsEngine: 'edge', // edge（Edge TTS 微软神经语音，免费无 key，失败回退浏览器语音）| system（浏览器自带语音）
  firecrawlKey: ''
};

async function getSettings() {
  const { settings } = await chrome.storage.local.get('settings');
  return { ...DEFAULT_SETTINGS, ...(settings || {}) };
}

async function setSettings(next) {
  await chrome.storage.local.set({ settings: next });
}

// Ensure defaults exist once installed
chrome.runtime.onInstalled.addListener(async (details) => {
  const s = await getSettings();
  await setSettings(s);
  try { await cleanupStorage(); } catch {}
  // Only open options page on first install, not on every update/reload
  if (details.reason === 'install' && !s.apiKey) {
    try { await chrome.runtime.openOptionsPage(); } catch (e) {}
  }
});

// Also clean on service worker startup
try {
  chrome.runtime.onStartup.addListener(async () => {
    try { await cleanupStorage(); } catch {}
  });
} catch {}

async function cleanupStorage() {
  try {
    const all = await chrome.storage.local.get(null);
    const badKeys = Object.keys(all || {}).filter(k => k === 'CCAPTIPREPS:video:' || k === 'CCAPTIPREPS:video:null' || k === 'CCAPTIPREPS:video:undefined');
    if (badKeys.length) {
      await chrome.storage.local.remove(badKeys);
    }
  } catch {}
}

// ===== YouTube subtitle extraction: keyless multi-client InnerTube fallback =====
// Ported from youtube-caption-extractor. YouTube rejects old client fingerprints
// globally; when this path stops working, bump clientVersion/UA below to current
// values (track yt-dlp's recent commits).
const YT_CLIENT_PROFILES = [
  {
    name: 'ios',
    clientName: 'IOS',
    clientVersion: '20.10.4',
    clientNameHeader: '5',
    userAgent: 'com.google.ios.youtube/20.10.4 (iPhone16,2; U; CPU iOS 18_3_2 like Mac OS X;)',
    context: { deviceMake: 'Apple', deviceModel: 'iPhone16,2', platform: 'MOBILE', osName: 'iOS', osVersion: '18.3.2.22D82' }
  },
  {
    name: 'android_vr',
    clientName: 'ANDROID_VR',
    clientVersion: '1.62.20',
    clientNameHeader: '28',
    userAgent: 'com.google.android.apps.youtube.vr.oculus/1.62.20 (Linux; U; Android 12L; eureka-user Build/SQ3A.220605.009.A1) gzip',
    context: { deviceMake: 'Oculus', deviceModel: 'Quest 3', platform: 'MOBILE', osName: 'Android', osVersion: '12L', androidSdkVersion: 32 }
  },
  {
    name: 'mweb',
    clientName: 'MWEB',
    clientVersion: '2.20251209.01.00',
    clientNameHeader: '2',
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
    context: { platform: 'MOBILE', osName: 'iOS', osVersion: '17.5.1' }
  }
];

// Keyless InnerTube /player call that tries every client and returns the first
// response that has captionTracks. Does NOT bail on a single client's ERROR
// status (YouTube reuses ERROR for both "video unavailable" and "client too old").
async function fetchPlayerDirect(videoId) {
  const failures = [];
  for (const c of YT_CLIENT_PROFILES) {
    try {
      const body = {
        context: {
          client: { clientName: c.clientName, clientVersion: c.clientVersion, hl: 'en', gl: 'US', ...c.context },
          user: { lockedSafetyMode: false },
          request: { useSsl: true }
        },
        videoId,
        contentCheckOk: true,
        racyCheckOk: true
      };
      const res = await fetch('https://youtubei.googleapis.com/youtubei/v1/player?prettyPrint=false', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: '*/*',
          'User-Agent': c.userAgent,
          'X-YouTube-Client-Name': c.clientNameHeader,
          'X-YouTube-Client-Version': c.clientVersion,
          Origin: 'https://www.youtube.com'
        },
        body: JSON.stringify(body)
      });
      if (!res.ok) {
        failures.push(`${c.name}: http ${res.status}`);
        continue;
      }
      const data = await res.json();
      const st = data && data.playabilityStatus && data.playabilityStatus.status;
      if (st && st !== 'OK') {
        failures.push(`${c.name}: ${st}`);
        continue;
      }
      const tracks = data && data.captions && data.captions.playerCaptionsTracklistRenderer && data.captions.playerCaptionsTracklistRenderer.captionTracks;
      if (Array.isArray(tracks) && tracks.length) {
        return { tracks, error: null };
      }
      failures.push(`${c.name}: OK but no caption tracks`);
    } catch (e) {
      failures.push(`${c.name}: ${e && e.message || e}`);
    }
  }
  return { tracks: [], error: failures.join(' | ') };
}

// Open modal in the active tab when the action is clicked
chrome.action.onClicked.addListener(async (tab) => {
  if (!tab.id) return;
  try {
    await chrome.tabs.sendMessage(tab.id, { type: 'CC_TOGGLE_MODAL' });
  } catch (e) {
    // Content scripts may not be injected yet (e.g., initial load). Inject both UI and backend.
    try {
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content.js', 'assets/tts.js', 'ui.js'] });
      await chrome.tabs.sendMessage(tab.id, { type: 'CC_TOGGLE_MODAL' });
    } catch (err) {
      console.error('Failed to open modal:', err);
    }
  }
});

// ===== LLM 调试日志（仅记录调用过程，不改变任何 LLM 行为）=====
const LLM_DEBUG_LOG = [];
const LLM_DEBUG_MAX = 800;
const LLM_DEBUG_STORAGE_KEY = 'CCAPTIPREPS:llmDebugLog';
let LLM_DEBUG_WRITE_Q = Promise.resolve();
let LLM_DEBUG_SEQ = 0;
function llmLog(stage, role, detail) {
  try {
    const ev = { seq: ++LLM_DEBUG_SEQ, ts: new Date().toISOString(), t: Math.round(performance.now()), stage, role: role || '', detail: detail || {} };
    LLM_DEBUG_LOG.push(ev);
    if (LLM_DEBUG_LOG.length > LLM_DEBUG_MAX) LLM_DEBUG_LOG.shift();
    // 持久化到 storage（串行写队列，保证顺序）：MV3 service worker 会休眠重启，内存日志会丢，必须落盘
    LLM_DEBUG_WRITE_Q = LLM_DEBUG_WRITE_Q.then(() => chrome.storage.local.get(LLM_DEBUG_STORAGE_KEY)).then((r) => {
      const arr = (r && r[LLM_DEBUG_STORAGE_KEY]) || [];
      arr.push(ev);
      if (arr.length > LLM_DEBUG_MAX) arr.splice(0, arr.length - LLM_DEBUG_MAX);
      return chrome.storage.local.set({ [LLM_DEBUG_STORAGE_KEY]: arr });
    }).catch(() => {});
  } catch (e) {}
}

// ===== Edge TTS（微软神经语音，REST，参考 read-frog edge-tts 方案）=====
const EDGE_TTS_CONST = {
  TRUSTED_CLIENT_TOKEN: '6A5AA1D4EAFF4E9FB37E23D68491D6F4',
  SIGNATURE_SECRET_B64: 'oik6PdDdMnOXemTbwvMn9de/h9lFnfBaCWbGMMZqqoSaQaqUOqjVGm5NqsmjcBI1x+sS9ugjB55HEJWRiFXYFw==',
  SIGNATURE_APP_ID: 'MSTranslatorAndroidApp',
  ENDPOINT_URL: 'https://dev.microsofttranslator.com/apps/endpoint?api-version=1.0',
  CLIENT_VERSION: '4.0.530a 5fe1dc6c',
  USER_ID: '0f04d16a175c411e',
  HOME_REGION: 'zh-Hans-CN',
  OUTPUT_FORMAT: 'audio-24khz-48kbitrate-mono-mp3',
  USER_AGENT: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36 Edg/127.0.0.0',
  TOKEN_TTL_MS: 10 * 60 * 1000,
  REFRESH_EARLY_MS: 3 * 60 * 1000,
};
let edgeTokenInfo = null; // { token, region, expiry }
const EDGE_TOKEN_STORAGE_KEY = 'CC_EDGE_TTS_TOKEN';
let _edgeTokenLoading = null; // 防并发重复请求
function edgeBase64ToBytes(b64) { const bin = atob(b64); const u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i); return u; }
function edgeBytesToBase64(u) { let bin = ''; const CH = 0x8000; for (let i = 0; i < u.length; i += CH) bin += String.fromCharCode.apply(null, u.subarray(i, i + CH)); return btoa(bin); }
function edgeSigDate(d) { return d.toUTCString().replace(/GMT/, '').trim().toLowerCase() + ' GMT'; }
async function edgeHmacSha256(keyBytes, data) {
  const k = await crypto.subtle.importKey('raw', keyBytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', k, new TextEncoder().encode(data));
  return new Uint8Array(sig);
}
async function edgeBuildSignature(url, now) {
  const encodedUrl = encodeURIComponent(url.split('://')[1] || '');
  const requestId = (crypto.randomUUID ? crypto.randomUUID() : String(Date.now() + Math.random())).replace(/-/g, '');
  const date = edgeSigDate(now);
  const payload = (EDGE_TTS_CONST.SIGNATURE_APP_ID + encodedUrl + date + requestId).toLowerCase();
  const key = edgeBase64ToBytes(EDGE_TTS_CONST.SIGNATURE_SECRET_B64);
  const sig = await edgeHmacSha256(key, payload);
  return EDGE_TTS_CONST.SIGNATURE_APP_ID + '::' + edgeBytesToBase64(sig) + '::' + date + '::' + requestId;
}
function edgeJwtExpiryMs(token) {
  try {
    const p = token.split('.')[1]; if (!p) return null;
    const n = p.replace(/-/g, '+').replace(/_/g, '/');
    const pad = n.padEnd(Math.ceil(n.length / 4) * 4, '=');
    const d = JSON.parse(atob(pad));
    return typeof d.exp === 'number' ? d.exp * 1000 : null;
  } catch { return null; }
}
async function edgeGetToken(force) {
  const now = Date.now();
  // 1) 内存缓存
  if (!force && edgeTokenInfo && now < edgeTokenInfo.expiry - EDGE_TTS_CONST.REFRESH_EARLY_MS) return edgeTokenInfo;
  // 2) 内存没有，尝试 storage 持久化缓存（SW 重启后免重新取）
  if (!force && !edgeTokenInfo) {
    try {
      const stored = await chrome.storage.local.get(EDGE_TOKEN_STORAGE_KEY);
      const s = stored && stored[EDGE_TOKEN_STORAGE_KEY];
      if (s && s.token && s.region && s.expiry && now < s.expiry - EDGE_TTS_CONST.REFRESH_EARLY_MS) {
        edgeTokenInfo = s;
        return edgeTokenInfo;
      }
    } catch (e) {}
  }
  // 3) 防并发：复用同一个请求 Promise
  if (_edgeTokenLoading) return _edgeTokenLoading;
  _edgeTokenLoading = (async () => {
    try {
      const sig = await edgeBuildSignature(EDGE_TTS_CONST.ENDPOINT_URL, new Date());
      const traceId = (crypto.randomUUID ? crypto.randomUUID() : String(Date.now() + Math.random())).replace(/-/g, '');
      const res = await fetch(EDGE_TTS_CONST.ENDPOINT_URL, {
        method: 'POST',
        headers: {
          'Accept-Language': 'zh-Hans',
          'X-ClientVersion': EDGE_TTS_CONST.CLIENT_VERSION,
          'X-UserId': EDGE_TTS_CONST.USER_ID,
          'X-HomeGeographicRegion': EDGE_TTS_CONST.HOME_REGION,
          'X-ClientTraceId': traceId,
          'X-MT-Signature': sig,
          'User-Agent': EDGE_TTS_CONST.USER_AGENT,
          'Content-Type': 'application/json; charset=utf-8',
        },
        body: '',
      });
      if (!res.ok) throw new Error('Edge endpoint ' + res.status);
      const data = await res.json();
      if (!data || !data.t || !data.r) throw new Error('Edge endpoint payload invalid');
      const expiry = edgeJwtExpiryMs(data.t) || (Date.now() + EDGE_TTS_CONST.TOKEN_TTL_MS);
      edgeTokenInfo = { token: data.t, region: data.r, expiry };
      // 4) 持久化到 storage，SW 重启后可用
      try { await chrome.storage.local.set({ [EDGE_TOKEN_STORAGE_KEY]: edgeTokenInfo }); } catch (e) {}
      return edgeTokenInfo;
    } finally {
      _edgeTokenLoading = null;
    }
  })();
  return _edgeTokenLoading;
}


function edgeEscapeXml(t) {
  return String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}
function edgeBuildSSML(text, voice, rate) {
  const clean = String(text || '').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, ' ').trim();
  if (!clean) throw new Error('empty tts text');
  const locale = voice.split('-').slice(0, 2).join('-') || 'en-US';
  const pct = (typeof rate === 'number' && rate !== 1) ? ((rate > 1 ? '+' : '') + Math.round((rate - 1) * 100) + '%') : '+0%';
  return '<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="' + edgeEscapeXml(locale) + '"><voice name="' + edgeEscapeXml(voice) + '"><prosody rate="' + edgeEscapeXml(pct) + '" pitch="+0Hz" volume="+0%">' + edgeEscapeXml(clean) + '</prosody></voice></speak>';
}
async function edgeSynthesize(text, voice, rate) {
  const info = await edgeGetToken(false);
  const url = 'https://' + info.region + '.tts.speech.microsoft.com/cognitiveservices/v1';
  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': info.token,
        'Content-Type': 'application/ssml+xml',
        'User-Agent': EDGE_TTS_CONST.USER_AGENT,
        'X-Microsoft-OutputFormat': EDGE_TTS_CONST.OUTPUT_FORMAT,
      },
      body: edgeBuildSSML(text, voice, rate),
    });
  } catch (e) { throw new Error('Edge TTS network: ' + e.message); }
  if (!res.ok) {
    if (res.status === 401 || res.status === 403) { edgeTokenInfo = null; throw new Error('Edge TTS token invalid ' + res.status); }
    throw new Error('Edge TTS ' + res.status);
  }
  const buf = await res.arrayBuffer();
  const bytes = new Uint8Array(buf);
  return { audioBase64: edgeBytesToBase64(bytes), contentType: res.headers.get('content-type') || 'audio/mpeg' };
}
async function edgeSynthesizeWithRetry(text, voice, rate) {
  let lastErr = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    try { return await edgeSynthesize(text, voice, rate); }
    catch (e) { lastErr = e; if (attempt < 2) await new Promise(r => setTimeout(r, 500 * (attempt + 1))); }
  }
  throw lastErr || new Error('Edge TTS failed');
}
// Generic LLM call routing
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg && msg.type === 'CC_EDGE_TTS') {
    (async () => {
      try {
        const r = await edgeSynthesizeWithRetry(String(msg.text || ''), String(msg.voice || 'en-US-AriaNeural'), typeof msg.rate === 'number' ? msg.rate : 1);
        sendResponse({ ok: true, audioBase64: r.audioBase64, contentType: r.contentType });
      } catch (e) { sendResponse({ ok: false, error: String(e && e.message || e) }); }
    })();
    return true;
  }
  if (msg && msg.type === 'CC_LLM_CALL') {
    llmLog('bg.recv', msg.payload && msg.payload.role, { dataKeys: msg.payload && msg.payload.data ? Object.keys(msg.payload.data) : [] });
    (async () => {
      try {
        const result = await handleLLMCall(msg.payload);
        sendResponse({ ok: true, result });
      } catch (err) {
        sendResponse({ ok: false, error: String(err && err.message || err) });
      }
    })();
    return true; // keep channel open for async
  }
  if (msg && msg.type === 'CC_GET_LLM_DEBUG_LOG') {
    (async () => {
      try {
        const r = await chrome.storage.local.get(LLM_DEBUG_STORAGE_KEY);
        sendResponse({ ok: true, log: (r && r[LLM_DEBUG_STORAGE_KEY]) || [] });
      } catch (e) { sendResponse({ ok: true, log: [] }); }
    })();
    return true;
  }
  if (msg && msg.type === 'CC_CLEAR_LLM_DEBUG_LOG') {
    (async () => { try { await chrome.storage.local.remove(LLM_DEBUG_STORAGE_KEY); } catch (e) {} LLM_DEBUG_LOG.length = 0; sendResponse({ ok: true }); })();
    return true;
  }
  if (msg && msg.type === 'CC_LLM_DEBUG_EVENT') { llmLog(msg.stage, msg.role, msg.detail || {}); sendResponse({ ok: true }); return; }
  if (msg && msg.type === 'CC_OPEN_OPTIONS') {
    chrome.runtime.openOptionsPage(() => {
      if (chrome.runtime.lastError) {
        console.warn('openOptionsPage failed:', chrome.runtime.lastError.message);
      }
      sendResponse({ ok: true });
    });
    return true;
  }
  if (msg && msg.type === 'CC_OPEN_WORDBOOK') {
    (async () => {
      try {
        const url = chrome.runtime.getURL('assets/wordbook.html');
        await chrome.tabs.create({ url });
        sendResponse({ ok: true });
      } catch (e) {
        sendResponse({ ok: false, error: String(e && e.message || e) });
      }
    })();
    return true;
  }
  if (msg && msg.type === 'CC_EXTRACT_PDF') {
    (async () => {
      try {
        const url = String(msg.url || '').trim();
        if (!url) { sendResponse({ ok: false, error: 'missing url' }); return; }
        const s = await getSettings();
        const apiKey = String(msg.apiKey || s.firecrawlKey || '').trim();
        let r = null;
        try {
          r = await extractPdfText(url);
          if (!r || !r.text || r.text.length < 10) r = null; // 空文本（扫描版/无文本层）→ Firecrawl 兜底
        } catch (e) { r = null; }
        if (r) { sendResponse({ ok: true, text: r.text, title: r.title || '', pageCount: r.pageCount || 0, via: 'pdf.js' }); return; }
        try {
          const f = await firecrawlScrape(url, apiKey);
          sendResponse({ ok: true, text: f.text, title: f.title || '', via: 'firecrawl' });
        } catch (e2) {
          sendResponse({ ok: false, error: String(e2 && e2.message || e2), via: 'firecrawl' });
        }
      } catch (e) { sendResponse({ ok: false, error: String(e && e.message || e) }); }
    })();
    return true;
  }
  if (msg && msg.type === 'CC_GET_SETTINGS') {
    (async () => {
      const s = await getSettings();
      sendResponse({ ok: true, settings: s });
    })();
    return true;
  }
  if (msg && msg.type === 'CC_TEST_LLM') {
    (async () => {
      try {
        const override = msg.override || {};
        const settings = { ...(await getSettings()), ...override };
        const { provider, baseUrl, apiKey } = settings;
        if (!apiKey) throw new Error('API key missing');
        // Prefer modelFirst > model > modelSecond for test
        const model = override.model || settings.modelFirst || settings.model || settings.modelSecond;
        const text = await callProvider({ provider, baseUrl, apiKey, model, prompt: 'Return this exact JSON: {"ok":true}', temperature: 0, topP: 1 });
        let ok = false;
        try {
          const jsonStr = extractJson(text);
          const parsed = JSON.parse(jsonStr);
          ok = parsed && parsed.ok === true;
        } catch {}
        if (!ok) throw new Error('Unexpected response: ' + (text || '(empty)'));
        sendResponse({ ok: true });
      } catch (e) {
        sendResponse({ ok: false, error: String(e && e.message || e) });
      }
    })();
    return true;
  }
  if (msg && msg.type === 'CC_LIST_MODELS') {
    (async () => {
      try {
        const override = msg.override || {};
        const s = await getSettings();
        const provider = (override.provider || s.provider || '').toLowerCase();
        const baseUrl = (override.baseUrl ?? s.baseUrl ?? '').trim();
        const apiKey = (override.apiKey ?? s.apiKey ?? '').trim();
        const list = await listModels({ provider, baseUrl, apiKey });
        sendResponse({ ok: true, models: list });
      } catch (e) {
        sendResponse({ ok: false, error: String(e && e.message || e) });
      }
    })();
    return true;
  }
  if (msg && msg.type === 'CC_YT_PLAYER_DIRECT') {
    (async () => {
      try {
        const videoId = String(msg.videoId || '').trim();
        if (!videoId) {
          sendResponse({ ok: false, tracks: [], error: 'missing videoId' });
          return;
        }
        const { tracks, error } = await fetchPlayerDirect(videoId);
        sendResponse({ ok: tracks.length > 0, tracks, error });
      } catch (e) {
        sendResponse({ ok: false, tracks: [], error: String(e && e.message || e) });
      }
    })();
    return true;
  }
});

async function handleLLMCall(payload) {
  const settings = await getSettings();
  const t0 = performance.now();
  const { role, data } = payload; // role: 'first'|'second'
  llmLog('bg.handle.start', role, {
    subLen: data && typeof data.subtitlesText === 'string' ? data.subtitlesText.length : undefined,
    contextLen: data && data.context ? JSON.stringify(data.context).length : undefined,
    selectedN: Array.isArray(data && data.selected) ? data.selected.length : undefined,
    maxItems: data && data.maxItems,
  });

  const { provider, baseUrl, apiKey, accent } = settings;
  const glossLang = resolveGlossLang(settings.glossLang, settings.uiLang);
  if (!apiKey) throw new Error('Missing API key in settings');

  const prompts = buildPrompts(role, data, { accent, glossLang });
  llmLog('bg.prompt', role, { promptLen: prompts && prompts.prompt ? prompts.prompt.length : 0 });

  // Choose model per role with fallback
  const model = role === 'first'
    ? (settings.modelFirst || settings.model)
    : (settings.modelSecond || settings.model);
  llmLog('bg.model', role, { provider: settings.provider, model, modelFirst: settings.modelFirst || '', modelSecond: settings.modelSecond || '', baseUrl: (settings.baseUrl || '').slice(0, 40) });

  // Sampling per role
  // Lower temperature to reduce hallucination in definition/example stage
  const temperature = role === 'first' ? 0 : 0.0;
  const topP = 1;
  const baseMaxTokens = role === 'first' ? 4096 : 16384;

  // Try up to 2 times: bounded output cap first; on empty/invalid-JSON retry without a cap
  // (some models/gateways return empty or truncated output when max_tokens is set)
  let text = '';
  let parsed = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    const a0 = performance.now();
    llmLog('bg.provider.start', role, { attempt, model, maxTokens: attempt === 0 ? baseMaxTokens : undefined });
    text = await callProvider({ provider, baseUrl, apiKey, model, prompt: prompts.prompt, temperature, topP, maxTokens: attempt === 0 ? baseMaxTokens : undefined });
    llmLog('bg.provider.end', role, { attempt, ms: Math.round(performance.now() - a0), outLen: text ? String(text).length : 0 });
    if (!text || !String(text).trim()) continue; // empty -> retry
    try {
      parsed = JSON.parse(extractJson(text));
      break;
    } catch (e) {
      llmLog('bg.parse.fail', role, { attempt, textLen: text ? String(text).length : 0 });
      if (attempt === 0) continue; // invalid JSON -> retry once with relaxed cap
    }
  }
  if (!parsed) {
    llmLog('bg.handle.end', role, { totalMs: Math.round(performance.now() - t0), ok: false, err: text ? 'invalid-json' : 'empty' });
    if (!text || !String(text).trim()) {
      throw new Error('LLM returned empty content. Check your API key, model and quota (retried once).');
    }
    throw new Error('LLM returned non-JSON or invalid JSON. Raw: ' + truncate(text, 800));
  }
  // Post-processing
  if (role === 'first') {
    try {
      parsed = postProcessCandidates(parsed, data && data.subtitlesText, data && data.captionLang, data && data.maxItems);
    } catch (e) { /* ignore */ }
  } else if (role === 'second') {
    try {
      const srcLang = normalizeLang(data && data.captionLang);
      const gloss = resolveGlossLang((await getSettings()).glossLang, (await getSettings()).uiLang);
      parsed = postProcessCards(parsed, srcLang, gloss, (await getSettings()).accent);
      // Align to requested ordering to avoid stray or missing items
      const want = Array.isArray(data && data.selected) ? data.selected : [];
      parsed = alignCardsToSelected(parsed, want, srcLang);
    } catch (e) {
      // best-effort; ignore
    }
  }
  llmLog('bg.handle.end', role, { totalMs: Math.round(performance.now() - t0), ok: true, resultCount: parsed && parsed.items ? parsed.items.length : (parsed && parsed.cards ? parsed.cards.length : 0) });
  return parsed;
}

function buildPrompts(role, data, opts) {
  const { accent, glossLang } = (opts || {});
  if (role === 'first') {
    const { subtitlesText, captionLang, maxItems = 20 } = data;
    const langHint = captionLang && typeof captionLang === 'string' && captionLang.trim() ? captionLang : 'auto-detect';
    const system = `You are an expert segmenter and vocabulary curator. Work only within the detected source language (source: ${langHint}). Extract learnable units that maximize pedagogical value for a learner.`;

    const langGate = (() => {
      const s = normalizeLang(langHint);
      if (s === 'en') return `Keep ENGLISH originals only. Do not output transliterations. Allow apostrophes/hyphens.`;
      if (s === 'ja') return `Keep JAPANESE originals only. Use the exact surface form from the transcript (kanji/kana mix). Do not output romaji as term. Do not exclude kanji-only items if they are common words.`;
      if (s === 'zh_CN' || s === 'zh_TW') return `Keep CHINESE originals only (Han characters). Mixed strings with Latin digits are allowed if the core is Chinese. Never output pinyin as term.`;
      if (s === 'ko') return `Keep KOREAN originals only (Hangul). Never output romanization as term.`;
      if (s === 'ru') return `Keep RUSSIAN originals only (Cyrillic). Do not output Latin transliteration.`;
      if (s === 'fr' || s === 'de' || s === 'es') return `Keep originals in that language/script. Exclude English words/brand names unless widely lexicalized; keep native diacritics (é, ä, ñ, ß).`;
      return `Only include terms clearly in the source language.`;
    })();

    const user = `Task: From the transcript below, extract high-value WORDS and short PHRASES strictly in the ORIGINAL transcript language. Set "term" to the exact SURFACE string as it appears in the transcript. Exclude fillers, interjections, bare function words, and trivial greetings.

Return JSON strictly with this shape:
{
  "items": [ { "term": string, "type": "word"|"phrase" } ]
}
Selection rules:
- Evidence: Include a term only if the exact string occurs in the transcript. For Latin/Cyrillic scripts, match case-insensitively on whole word/phrase boundaries; for CJK/Korean, substring match is acceptable.
- Learnability (most important): This tool is for VOCABULARY LEARNING. Prefer genuinely valuable new words, advanced words, idioms, collocations and hard-to-guess phrases. Skip ordinary everyday basic vocabulary a learner almost certainly already knows (e.g. en: have/people/time/thing/come; ja: 見る/行く/もの/こと; zh: 看/说/好/想; ko: 가다/하다/것/수). Ranking: novelty/difficulty for a learner > semantic density > idiomaticity/collocation > local frequency.
- Multiword expressions: Prefer if idiomatic or hard to translate literally.
- Morphology: Do NOT rewrite to lemmas in output. Keep surface form in "term". Internally, you may consider lemma for ranking but NOT for output.
- Stop items: Avoid common fillers/backchannels and bare function words. Examples — en: uh/um/like/you know; ja: えっと/あの/まあ; ko: 어/음/그냥/막; ru: ну/типа/как бы; fr: euh/bah/ben/du coup; de: äh/ähm/also; es: eh/pues/bueno/o sea; zh: 嗯/啊/就是/然后。 Only include them if part of a fixed expression with content.
- Cross-language noise: Exclude brand names, gamer tags, hashtags, model numbers, timestamps, and English borrowings unless they are widely lexicalized in the source language.
- Limit items to about ${maxItems}.
- Language gate: ${langGate}
- If uncertain, return an empty list rather than guessing.

Transcript (language: ${langHint}; may be lightly noisy):\n\n${subtitlesText}`;
    return { prompt: composeChat(system, user) };
  } else if (role === 'second') {
    const { selected, captionLang } = data;
    const accentLabel = accent === 'uk' ? 'British' : 'American';
    // Infer source language from selected terms to avoid cross-language contamination
    let srcLang = normalizeLang(captionLang);
    try {
      const inferred = inferLangFromSelected(selected);
      if (inferred && inferred !== 'und') srcLang = inferred;
    } catch {}
    const gloss = normalizeLang(glossLang);
    const glossLabel = humanLabelForLang(gloss);
    const srcLabel = humanLabelForLang(srcLang);
    const pronGuide = pronunciationGuide(srcLang, accentLabel);
    const readGuide = readingGuide(srcLang);

    const system = `You are a multilingual lexicographer. Produce accurate, compact learner cards with source-true pronunciation and meanings constrained by context.`;

    // Examples: unify to 2 lines for all languages (no pronunciation line in examples)
    const exampleRule = `Provide exactly 2 example PAIRS per item. For each pair, output a SINGLE STRING with TWO lines ("\\n"):
  line 1: a natural sentence in ${srcLabel}
  line 2: its concise ${glossLabel} translation
Do NOT include a pronunciation/reading line in examples.`;

    const defRule = (gloss === 'zh_CN' || gloss === 'zh_TW')
      ? `Write the "definition" and "notes" in Chinese (${gloss === 'zh_TW' ? 'Traditional' : 'Simplified'}).`
      : `Write the "definition" and "notes" in ${glossLabel}.`;

    // Updated pronunciation rules for each language
    const ipaRule = `Pronunciation fields:
- "reading": ${readGuide}
- "ipa": ${pronGuide}
Language-specific fill rules:
- Chinese: provide "reading" (Pinyin); leave "ipa" empty.
- Japanese: provide "reading" (kana + NHK pitch); leave "ipa" empty.
- Korean: provide "reading" (Revised Romanization); leave "ipa" empty.
- English: leave "reading" empty; provide both "ipa_us" and "ipa_uk".
- Russian/French/German/Spanish: leave "reading" empty; provide "ipa".`;
    const accentNote = (srcLang === 'en') ? `Include both US and UK variants ("ipa_us" and "ipa_uk"). Set "ipa" to match primary variant.` : `Do NOT include English accent notes for non-English.`;

    const posRule = (gloss === 'zh_CN' || gloss === 'zh_TW')
      ? 'Use POS in Chinese（名词/动词/形容词/副词/短语/惯用语/助词/连词/叹词/敬语等）。名词可在 POS 或 notes 标明性别/可数性；动词可在 notes 标明变位特性/体。'
      : `Use POS in ${glossLabel}. Keep POS concise. Add gender/case/valency in notes if needed.`;

    const critical = `Critical constraints:
- Ground the chosen sense in the provided evidence (if any). Do NOT output an unrelated sense; if truly ambiguous, leave a minimal definition and add "insufficient_context" to notes.
- All pronunciation fields must reflect the SOURCE language (${srcLabel}), NOT the gloss language. When scripts overlap (e.g., Han characters in Japanese), use the reading of the SOURCE language only.
- For English source: include both US and UK variants as separate fields.
- Examples must be written in ${srcLabel} ONLY. Do not mix other languages or transliterations in examples.
- Keep outputs compact and clean; no list markers, brackets, or slashes inside fields.`;

    // Evidence context: up to two transcript lines per item, when available
    const ctx = Array.isArray(data && data.context) ? data.context : [];
    const evidence = ctx.length ? `\nEvidence from transcript (use to disambiguate meaning; do not quote verbatim in output):\n` + ctx.map((c, i) => {
      const lines = Array.isArray(c.lines) ? c.lines : [];
      const head = `${i + 1}. ${c.term}`;
      return head + (lines.length ? `\n- ${lines.join('\n- ')}` : '\n- (no match)');
    }).join('\n') + '\n' : '';

    const user = `Task: For each input item, produce source-true pronunciation (use "reading" for kana/Hangul/Pinyin languages; include "ipa" where customary — include for Korean), a POS label in the chosen gloss language, a short learner-friendly definition constrained by the evidence, exactly two example pairs, and a brief note for key grammar/culture/pitfalls if relevant. Provide a small "grammar" object when relevant (e.g., gender/plural for DE/FR/ES; aspect for RU; separability for DE; politeness/lemma for JA/KO).

${defRule}
${exampleRule}
${ipaRule}
${accentNote}
${posRule}

Notes guidelines:
- Korean: Include grammar notes (honorifics, irregular verbs, sound changes), usage patterns, or cultural context when relevant. Only mention standard pronunciation (표준발음) if there are notable sound changes or irregular pronunciations.
- Spanish: Beyond gender/number, include usage registers (formal/informal), regional variations, idioms, false friends, or cultural context when helpful.
- All languages: Focus on learner-relevant information that aids comprehension and proper usage.

${critical}
${evidence}

Return JSON strictly with this shape and cardinality (one card per input item, same order; do not add or drop items). For English, include both "ipa_us" and "ipa_uk" and set "ipa" to match the primary accent. For Chinese/Japanese/Korean, fill "reading" and leave "ipa" empty. For Russian/French/German/Spanish, leave "reading" empty and fill "ipa".
{
  "cards": [ {
    "term": string,
    "reading": string,        // native reading when applicable (kana+pitch/RR/Pinyin); else empty
    "ipa": string,            // pronunciation string per language rules; empty for CJK/Korean
    "ipa_us": string,         // required when source is English; otherwise empty or omitted
    "ipa_uk": string,         // required when source is English; otherwise empty or omitted
    "pos": string,            // POS label in ${glossLabel}
    "definition": string,     // concise learner definition (${glossLabel}) aligned to evidence
    "examples": string[],     // exactly 2 strings; each with TWO lines (src + translation); NO pronunciation line
    "notes": string,          // may be empty (${glossLabel}); include key inflection/usage notes
    "grammar": object         // optional structured hints (gender/plural/aspect/separable/politeness/etc.)
  } ]
}

Formatting rules:
- Output raw JSON only (no Markdown fences).
- Do not use list markers (-, *, 1.) inside strings.
- Keep pronunciation clean: no surrounding slashes. Square brackets are allowed only for Japanese pitch numbers in readings (e.g., [0]).

Items:\n${selected.map((t, i) => `${i + 1}. ${t.term}`).join('\n')}`;
    return { prompt: composeChat(system, user) };
  }
  throw new Error('Unknown role');
}

function composeChat(system, user) {
  // Provider adapters will wrap into their specific schema. Here we merge as a single text.
  return `SYSTEM:\n${system}\n\nUSER:\n${user}`;
}

function resolveGlossLang(glossLang, uiLang) {
  const g = (glossLang || '').trim();
  if (g && g !== 'auto') return normalizeLang(g);
  const ui = (uiLang && uiLang !== 'auto') ? uiLang : (typeof chrome !== 'undefined' && chrome.i18n && typeof chrome.i18n.getUILanguage === 'function' ? chrome.i18n.getUILanguage() : 'en');
  // Map browser UI to gloss language
  const norm = normalizeLang(ui);
  if (norm === 'zh_CN' || norm === 'zh_TW' || norm === 'en') return norm;
  return 'en';
}

function normalizeLang(code) {
  if (!code) return 'und';
  const c = String(code).toLowerCase().replace('_','-');
  if (c.startsWith('en')) return 'en';
  if (c.startsWith('zh-cn') || c === 'zh-hans' || c === 'zh') return 'zh_CN';
  if (c.startsWith('zh-tw') || c === 'zh-hant') return 'zh_TW';
  if (c.startsWith('ja')) return 'ja';
  if (c.startsWith('ko')) return 'ko';
  if (c.startsWith('ru')) return 'ru';
  if (c.startsWith('fr')) return 'fr';
  if (c.startsWith('de')) return 'de';
  if (c.startsWith('es')) return 'es';
  return c;
}

function humanLabelForLang(norm) {
  switch (norm) {
    case 'en': return 'English';
    case 'zh_CN': return 'Chinese(Simplified)';
    case 'zh_TW': return 'Chinese(Traditional)';
    case 'ja': return 'Japanese';
    case 'ko': return 'Korean';
    case 'ru': return 'Russian';
    case 'fr': return 'French';
    case 'de': return 'German';
    case 'es': return 'Spanish';
    default: return norm || 'Unknown';
  }
}

function pronunciationGuide(srcLang, accentLabel) {
  const s = normalizeLang(srcLang);
  if (s === 'en') {
    return `IPA (broad). No slashes/brackets. Provide both US and UK variants; mark primary stress (ˈ).`;
  }
  if (s === 'zh_CN' || s === 'zh_TW') {
    return 'Leave "ipa" field empty. Chinese uses Pinyin in "reading" field only.';
  }
  if (s === 'ja') {
    return 'Leave "ipa" field empty. Japanese uses kana with NHK pitch accent in "reading" field only.';
  }
  if (s === 'ko') {
    return 'Leave "ipa" field empty. Korean uses Revised Romanization in "reading" field only.';
  }
  if (s === 'ru') {
    return 'IPA (broad), Moscow standard. Mark stress. Use palatalization ʲ (e.g., nʲ tʲ sʲ). Ensure ё is correctly represented in the source term. No slashes/brackets.';
  }
  if (s === 'fr') {
    return 'IPA (broad), Metropolitan French. Include nasal vowels (ɑ̃ ɔ̃ ɛ̃ œ̃) and uvular ʁ. Do NOT mark stress. Liaison optional. No slashes/brackets.';
  }
  if (s === 'de') {
    return 'IPA (broad), Standard German. Mark long vowels with ː when needed. Include y, ø, œ; ich/ach as ç/x. No slashes/brackets.';
  }
  if (s === 'es') {
    return 'IPA (broad), neutral seseo baseline. Mark stress. No slashes/brackets.';
  }
  return 'Use the standard romanization or IPA customary for the language; clean text without slashes/brackets.';
}

function readingGuide(srcLang) {
  const s = normalizeLang(srcLang);
  if (s === 'ja') return 'Use full kana reading (かな／カナ) with NHK-style pitch accent number in square brackets, e.g., あめ [0]. Do not use romaji as the main reading.';
  if (s === 'ko') return 'Use Revised Romanization (RR) strictly. 시=si, 스=seu. Never mix IPA or other romanization systems.';
  if (s === 'zh_CN' || s === 'zh_TW') return 'Use Hanyu Pinyin with tone marks (mā/má/mǎ/mà). No tone numbers; use ü. Mark common sandhi in notes if necessary.';
  if (s === 'ru' || s === 'fr' || s === 'de') return 'Leave reading field empty; use IPA in the ipa field.';
  if (s === 'es') return 'Leave reading field empty; use IPA in the ipa field.';
  if (s === 'en') return 'Leave reading field empty; use IPA in us/uk variants.';
  return 'Use the language-appropriate native reading when it exists; otherwise leave empty.';
}

function alignCardsToSelected(parsed, selected, srcLang) {
  try {
    const out = { ...parsed };
    const want = Array.isArray(selected) ? selected.map(s => String(s.term || '').trim()) : [];
    const got = Array.isArray(parsed.cards) ? parsed.cards : [];
    const isLatin = ['en','fr','de','es','ru'].includes(normalizeLang(srcLang));
    const norm = (s) => isLatin ? String(s || '').toLowerCase().trim() : String(s || '').trim();
    const map = new Map();
    for (const c of got) { const k = norm(c.term); if (k) { if (!map.has(k)) map.set(k, c); } }
    const aligned = [];
    for (const term of want) {
      const k = norm(term);
      const found = map.get(k);
      if (found) { aligned.push(found); }
      else { aligned.push({ term, ipa: '', ipa_us: '', ipa_uk: '', pos: '', definition: '', examples: [], notes: 'insufficient_context' }); }
    }
    out.cards = aligned;
    return out;
  } catch { return parsed; }
}

function postProcessCandidates(parsed, subtitlesText, captionLang, maxItems) {
  try {
    const out = { ...parsed };
    const items = Array.isArray(out.items) ? out.items : [];
    const text = String(subtitlesText || '');
    const lang = normalizeLang(captionLang);
    if (!text) return parsed;
    if (!items.length) {
      // Build naive candidates directly from transcript to avoid empty selection UI
      const naive = buildNaiveCandidatesFromTranscript(text, lang, maxItems);
      if (naive && naive.length) return { items: naive };
      return parsed;
    }
    
    const lines = text.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
    const fullText = lines.join(' ');
    const contains = (rawTerm) => {
      const term = String(rawTerm || '').trim();
      if (!term) return false;
      // For CJK/Hangul, substring is acceptable across the whole transcript
      if (lang === 'ja' || lang === 'ko' || lang === 'zh_CN' || lang === 'zh_TW') {
        return fullText.includes(term);
      }
      // For Latin/Cyrillic scripts: use Unicode-aware word boundary surrogate
      try {
        const esc = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        // Treat letters/marks/digits/'/- as part of words; negative class around the term
        const re = new RegExp(`(^|[^\\p{L}\\p{M}\\p{N}'-])${esc}([^\\p{L}\\p{M}\\p{N}'-]|$)`, 'iu');
        return re.test(fullText);
      } catch {
        // Fallback: case-insensitive substring on the fused text
        return fullText.toLowerCase().includes(term.toLowerCase());
      }
    };

    // Script gate: drop items whose script clearly does not match the source language
    const hasAny = (re, s) => re.test(s);
    const scriptOk = (t) => {
      const s = String(t || '').trim();
      if (!s) return false;
      switch (lang) {
        case 'ja':
          // Require at least one Hiragana/Katakana or CJK
          return hasAny(/[\u3040-\u30FF\u4E00-\u9FFF]/u, s);
        case 'ko':
          // Require at least one Hangul
          return hasAny(/[\u1100-\u11FF\u3130-\u318F\uAC00-\uD7AF]/u, s);
        case 'zh_CN':
        case 'zh_TW':
          // Require at least one Han character
          return hasAny(/[\u4E00-\u9FFF]/u, s);
        case 'ru':
          // Require at least one Cyrillic
          return hasAny(/[\u0400-\u04FF]/u, s);
        default:
          // Latin-script languages (en/fr/de/es) pass
          return true;
      }
    };

    // Basic stopword/filtering to reduce filler noise per language
    const stop = buildStoplist(lang);
    const isStop = (t) => {
      const s = String(t || '').trim();
      if (!s) return true;
      // Drop terms that are mostly digits/punct
      const alnum = s.replace(/[^\p{L}\p{M}\p{N}]+/gu, '');
      if (!alnum) return true;
      const digitRatio = (s.replace(/[^0-9]/g, '').length) / s.length;
      if (digitRatio > 0.5) return true;
      const key = s.toLowerCase();
      return stop.has(key);
    };

    // Deduplicate by term (case-insensitive for Latin/Cyrillic; exact for CJK/Korean)
    const isLatin = ['en','fr','de','es','ru'].includes(lang);
    const norm = (s) => isLatin ? String(s || '').toLowerCase().trim() : String(s || '').trim();
    const mergedMap = new Map();
    for (const it of items) {
      const k = norm(it.term);
      if (!k) continue;
      if (!mergedMap.has(k)) mergedMap.set(k, { term: it.term, type: it.type || 'word' });
    }
    const merged = Array.from(mergedMap.values());

    const filtered = merged
      .filter(it => contains(String(it.term || '').trim()))
      .filter(it => !isStop(it.term))
      .filter(it => scriptOk(it.term));
    // Keep the LLM's pedagogical order; do NOT re-sort by freq (removed).
    let finalList = typeof maxItems === 'number' ? filtered.slice(0, maxItems) : filtered;

    // Fallback: if filtering wipes out everything (e.g., model lemmatized/rewrote terms), degrade constraints to avoid empty UI
    if (!finalList.length) {
      const looseContains = (rawTerm) => {
        const term = String(rawTerm || '').trim();
        if (!term) return false;
        try {
          return fullText.toLowerCase().includes(term.toLowerCase());
        } catch { return false; }
      };
      const minimal = items
        .filter(it => looseContains(String(it.term || '')))
        .filter(it => !isStop(it.term))
        .filter(it => scriptOk(it.term));
      finalList = typeof maxItems === 'number' ? minimal.slice(0, maxItems) : minimal;
    }

    // Last resort: if still empty, take top-N raw items with sane characters
    if (!finalList.length) {
      const sane = (s) => /[\p{L}\p{M}]/u.test(String(s || ''));
      const basic = items.filter(it => sane(it.term)).slice(0, Math.max(10, Math.min(40, maxItems || 40)));
      finalList = basic;
    }

    out.items = finalList;
    return out;
  } catch { return parsed; }
}

function postProcessCards(parsed, srcLang, gloss, accent) {
  try {
    const out = { ...parsed };
    const cards = Array.isArray(out.cards) ? out.cards : [];
    const isZh = (gloss === 'zh_CN' || gloss === 'zh_TW');
    const map = (s) => String(s || '').trim();
    const lower = (s) => map(s).toLowerCase();
    const posMapCN = {
      'noun': '名词', 'n.': '名词',
      'verb': '动词', 'v.': '动词', 'auxiliary verb': '助动词', 'aux.': '助动词',
      'adjective': '形容词', 'adj.': '形容词',
      'adverb': '副词', 'adv.': '副词',
      'pronoun': '代词', 'pron.': '代词',
      'preposition': '介词', 'prep.': '介词',
      'conjunction': '连词', 'conj.': '连词',
      'interjection': '叹词', 'int.': '叹词',
      'particle': '助词', 'postposition': '助词', 'classifier': '量词',
      'determiner': '限定词', 'article': '冠词',
      'phrase': '短语', 'idiom': '惯用语', 'expression': '表达',
      'honorific': '敬语'
    };
    const posMapTW = {
      '名词': '名詞', '动词': '動詞', '形容词': '形容詞', '副词': '副詞', '代词': '代名詞', '介词': '介系詞', '连词': '連接詞', '叹词': '感嘆詞', '助词': '助詞', '量词': '量詞', '限定词': '限定詞', '冠词': '冠詞', '短语': '片語', '惯用语': '慣用語', '表达': '表達', '敬语': '敬語', '助动词': '助動詞'
    };
    const lang = normalizeLang(srcLang);
    out.cards = cards.map((c) => {
      const cc = { ...c };
      // Sanitize and normalize expected fields
      if (!cc.reading) cc.reading = '';
      // Drop redundant reading when identical to term for languages where reading often equals surface form
      try {
        const lang2 = normalizeLang(srcLang);
        const map2 = (s) => String(s || '').trim();
        if ((lang2 === 'ko' || lang2 === 'ja' || lang2 === 'zh_CN' || lang2 === 'zh_TW') && map2(cc.reading) && map2(cc.term) && map2(cc.reading) === map2(cc.term)) {
          cc.reading = '';
        }
      } catch {}
      // POS localization fallback for Chinese
      if (isZh && cc.pos) {
        const key = lower(cc.pos).replace(/\./g, '').trim();
        let mapped = null;
        for (const k in posMapCN) {
          if (key === k) { mapped = posMapCN[k]; break; }
        }
        if (mapped) cc.pos = (gloss === 'zh_TW') ? (posMapTW[mapped] || mapped) : mapped;
      }
      // Ensure English has both US/UK fields and force primary accent into ipa
      if (lang === 'en') {
        const us = map(cc.ipa_us);
        const uk = map(cc.ipa_uk);
        cc.ipa = us || uk; // Remove accent preference logic
      }
      // For Korean: ensure ipa is empty
      if (lang === 'ko') {
        cc.ipa = ''; // Force empty for Korean
        // Let model decide whether to include standard pronunciation or other notes
      }
      // For Chinese and Japanese: ensure ipa is empty
      if (lang === 'zh_CN' || lang === 'zh_TW' || lang === 'ja') {
        cc.ipa = '';
      }
      // Trim strings
      ['term','reading','ipa','ipa_us','ipa_uk','pos','definition','notes'].forEach(f => { if (cc[f]) cc[f] = map(cc[f]); });
      // Normalize examples: always 2 lines per block (src + translation); drop any pronunciation line
      cc.examples = normalizeExamples(cc.examples, lang);
      return cc;
    });
    return out;
  } catch {
    return parsed;
  }
}

function normalizeExamples(examples, srcLang) {
  try {
    const list = Array.isArray(examples) ? examples : [];
    const norm = list.slice(0, 2).map(raw => {
      const lines = String(raw || '').split(/\r?\n/).map(s => s.replace(/^\s*[-*\d\.)\u2022\u00B7]?\s*/, '')).map(s => s.trim()).filter(Boolean);
      const l1 = lines[0] || '';
      const l2 = lines[1] || '';
      // Force exactly two lines when possible; ignore any extra lines
      return [l1, l2].filter(Boolean).join('\n');
    });
    return norm;
  } catch { return Array.isArray(examples) ? examples.slice(0, 2) : []; }
}

function inferLangFromSelected(selected) {
  try {
    const list = Array.isArray(selected) ? selected : [];
    if (!list.length) return 'und';
    const terms = list.map(it => String((it && it.term) || '').trim()).filter(Boolean).join(' ');
    if (!terms) return 'und';
    const has = (re) => re.test(terms);
    if (/[\u3040-\u30FF]/u.test(terms) || /[\u30A0-\u30FF]/u.test(terms)) return 'ja';
    if (/[\u1100-\u11FF\u3130-\u318F\uAC00-\uD7AF]/u.test(terms)) return 'ko';
    if (/[\u4E00-\u9FFF]/u.test(terms)) return 'zh_CN'; // default to Simplified for UI
    if (/[\u0400-\u04FF]/u.test(terms)) return 'ru';
    // Latin-based: try to guess among es/fr/de/en via diacritics/signatures
    const lower = terms.toLowerCase();
    if (/[ñáéíóúü]/i.test(terms)) return 'es';
    if (/[éèêëàâîïôùûç]/i.test(terms)) return 'fr';
    if (/[äöüß]/i.test(terms)) return 'de';
    // If contains many English function words, lean en
    const enSignals = ['the','and','of','to','in','for','on','with','as'];
    let hits = 0; for (const w of enSignals) { if (lower.includes(` ${w} `)) hits++; }
    if (hits >= 2) return 'en';
    // Default Latin -> es as a safe learner bias when diacritics include á/í/ó/ú
    if (/[áíóú]/i.test(terms)) return 'es';
    return 'en';
  } catch { return 'und'; }
}

function buildNaiveCandidatesFromTranscript(text, lang, maxItems = 20) {
  try {
    const s = String(text || '');
    if (!s.trim()) return [];
    const L = normalizeLang(lang);
    const freq = new Map();
    const push = (tok) => {
      const t = String(tok || '').trim();
      if (!t) return;
      const k = (L === 'en' || L === 'fr' || L === 'de' || L === 'es' || L === 'ru') ? t.toLowerCase() : t;
      freq.set(k, (freq.get(k) || 0) + 1);
    };
    if (L === 'ja') {
      const m = s.match(/[\u3040-\u30FF\u4E00-\u9FFF]+/gu) || [];
      m.filter(x => x.length >= 2 && x.length <= 8).forEach(push);
    } else if (L === 'ko') {
      const m = s.match(/[\u1100-\u11FF\u3130-\u318F\uAC00-\uD7AF]+/gu) || [];
      m.filter(x => x.length >= 2 && x.length <= 10).forEach(push);
    } else if (L === 'zh_CN' || L === 'zh_TW') {
      const m = s.match(/[\u4E00-\u9FFF]+/gu) || [];
      m.filter(x => x.length >= 2 && x.length <= 8).forEach(push);
    } else if (L === 'ru') {
      const m = s.match(/[\u0400-\u04FF]+/gu) || [];
      m.filter(x => x.length >= 3).forEach(push);
    } else {
      const m = s.match(/[\p{L}\p{M}][\p{L}\p{M}'-]*/gu) || [];
      m.filter(x => x.length >= 3).forEach(push);
    }
    // Build items sorted by frequency (freq kept internal only, not in output)
    const ranked = Array.from(freq.entries())
      .sort((a, b) => b[1] - a[1])
      .map(([term]) => ({ term, type: 'word' }));
    return ranked.slice(0, Math.max(10, Math.min(80, maxItems || 20)));
  } catch { return []; }
}

function buildStoplist(lang) {
  const L = (s) => new Set(s.map(x => x.toLowerCase()));
  switch (normalizeLang(lang)) {
    case 'en': return L(['uh','um','er','ah','oh','like','you know','i mean','kind of','sort of','okay','ok','so','well']);
    case 'ja': return L(['えっと','ええと','あの','その','まぁ','まあ','うん','あぁ','はい']);
    case 'ko': return L(['어','음','그냥','막','뭐지','저기','그러니까','근데','아니','자','응']);
    case 'ru': return L(['ну','типа','как бы','ээ','эм','блин','ладно','короче']);
    case 'fr': return L(['euh','bah','ben','du coup','genre','en fait','bref','voilà']);
    case 'de': return L(['äh','ähm','halt','eben','so','naja','also','ja','nee','doch']);
    case 'es': return L(['eh','este','pues','bueno','o sea','vale','ya','entonces']);
    case 'zh_CN':
    case 'zh_TW': return L(['嗯','啊','这个','那個','那个','這個','就是','然后','然後','吧','呃','嘛']);
    default: return L([]);
  }
}

// ===== 关闭推理/思考模式（按模型自动匹配，避免默认思考导致响应慢）=====
function noThinkingParam(provider, model) {
  const m = String(model || '').toLowerCase();
  const p = String(provider || '').toLowerCase();
  if (p === 'openai' || p === 'openai-compatible') {
    if (m.includes('deepseek')) return { thinking: { type: 'disabled' } };
    if (m.includes('qwen')) return { enable_thinking: false };
    if (m.includes('kimi')) return { thinking: { type: 'disabled' } };
    if (m.includes('glm')) return { thinking: { type: 'disabled' } };
    if (m.includes('gpt-5') || m.includes('gpt5')) return { reasoning_effort: 'none' };
    return null;
  }
  if (p === 'gemini' || p === 'google') {
    // Gemini 2.5 Pro 不支持关闭（会 400）；Gemini 3 参数不同暂不处理；仅 2.5 Flash 系可关
    if (m.includes('flash') && !m.includes('3')) return { thinkingConfig: { thinkingBudget: 0 } };
    return null;
  }
  if (p === 'claude' || p === 'anthropic') {
    // Fable/Mythos 拒绝 disabled（无法关闭），跳过；其余（含 5 系列）显式关闭
    if (m.includes('fable') || m.includes('mythos')) return null;
    return { thinking: { type: 'disabled' } };
  }
  if (p === 'openrouter') {
    if (m.includes('deepseek') || m.includes('qwen') || m.includes('kimi') || m.includes('glm') || m.includes('r1')) return { reasoning: { enabled: false } };
    return null;
  }
  return null;
}

async function callProvider({ provider, baseUrl, apiKey, model, prompt, temperature, topP, maxTokens }) {
  const p = provider.toLowerCase();
  if (p === 'gemini' || p === 'google') {
    const url = (baseUrl && baseUrl.trim()) || `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`;
    const body = {
      contents: [ { role: 'user', parts: [ { text: prompt } ] } ],
      generationConfig: {
        temperature: typeof temperature === 'number' ? temperature : undefined,
        topP: typeof topP === 'number' ? topP : undefined,
        maxOutputTokens: typeof maxTokens === 'number' ? maxTokens : undefined,
        ...(noThinkingParam(p, model) || {})
      }
    };
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    if (!res.ok) throw new Error(`Gemini error ${res.status}: ${await res.text()}`);
    const data = await res.json();
    const text = (data.candidates?.[0]?.content?.parts?.map(p => p.text).join('\n')) || '';
    return text;
  }
  if (p === 'openai' || p === 'openai-compatible') {
    const url = (baseUrl && baseUrl.trim()) || 'https://api.openai.com/v1/chat/completions';
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: 'You are a helpful assistant.' },
          { role: 'user', content: prompt }
        ],
        temperature: typeof temperature === 'number' ? temperature : undefined,
        top_p: typeof topP === 'number' ? topP : undefined,
        max_tokens: typeof maxTokens === 'number' ? maxTokens : undefined,
        // 自动关闭推理模型的思考模式（DeepSeek/Qwen/Kimi/GLM/GPT-5 等），避免默认思考导致慢
        ...(noThinkingParam(p, model) || {})
      })
    });
    if (!res.ok) throw new Error(`OpenAI error ${res.status}: ${await res.text()}`);
    const data = await res.json();
    return data.choices?.[0]?.message?.content || '';
  }
  if (p === 'claude' || p === 'anthropic') {
    const url = (baseUrl && baseUrl.trim()) || 'https://api.anthropic.com/v1/messages';
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model,
        max_tokens: typeof maxTokens === 'number' ? maxTokens : 2048,
        temperature: typeof temperature === 'number' ? temperature : undefined,
        top_p: typeof topP === 'number' ? topP : undefined,
        messages: [ { role: 'user', content: prompt } ],
        // Claude 5 系列默认思考，显式关闭（Fable/Mythos 除外，由 noThinkingParam 处理）
        ...(noThinkingParam(p, model) || {})
      })
    });
    if (!res.ok) throw new Error(`Anthropic error ${res.status}: ${await res.text()}`);
    const data = await res.json();
    const content = data.content?.[0]?.text || '';
    return content;
  }
  if (p === 'openrouter') {
    const url = (baseUrl && baseUrl.trim()) || 'https://openrouter.ai/api/v1/chat/completions';
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model,
        messages: [ { role: 'user', content: prompt } ],
        temperature: typeof temperature === 'number' ? temperature : undefined,
        top_p: typeof topP === 'number' ? topP : undefined,
        max_tokens: typeof maxTokens === 'number' ? maxTokens : undefined,
        // 关闭推理模型的思考模式
        ...(noThinkingParam(p, model) || {})
      })
    });
    if (!res.ok) throw new Error(`OpenRouter error ${res.status}: ${await res.text()}`);
    const data = await res.json();
    return data.choices?.[0]?.message?.content || '';
  }
  throw new Error('Unsupported provider: ' + provider);
}

// 根据用户填写的 baseUrl 推导各供应商的模型列表接口地址
// （baseUrl 通常是 chat/completions 或 API 根地址，不能直接作为 models 接口）
function buildModelsUrl(provider, baseUrl, fallback) {
  if (!baseUrl || !String(baseUrl).trim()) return fallback;
  let u = String(baseUrl).trim().replace(/\/+$/, '').split('?')[0];
  // 去掉常见 API 操作端点后缀，得到 API 根
  u = u.replace(/\/chat\/completions$/i, '')
       .replace(/\/messages$/i, '')
       .replace(/\/completions$/i, '')
       .replace(/\/generateContent$/i, '')
       .replace(/\/models$/i, '');
  const p = String(provider || '').toLowerCase();
  // Anthropic 需要 /v1 前缀
  if ((p === 'claude' || p === 'anthropic') && !/\/v1(\/|$)/i.test(u)) u += '/v1';
  if (!/\/models$/i.test(u)) u += '/models';
  return u;
}

async function listModels({ provider, baseUrl, apiKey }) {
  const p = (provider || '').toLowerCase();
  if (p === 'openai' || p === 'openai-compatible') {
    const url = buildModelsUrl('openai', baseUrl, 'https://api.openai.com/v1/models');
    const res = await fetch(url, { headers: { 'Authorization': `Bearer ${apiKey}` } });
    if (!res.ok) throw new Error(`OpenAI list models error ${res.status}: ${await res.text()}`);
    const data = await res.json();
    const ids = (data.data || []).map(m => m.id).filter(Boolean);
    return ids;
  }
  if (p === 'claude' || p === 'anthropic') {
    const url = buildModelsUrl('claude', baseUrl, 'https://api.anthropic.com/v1/models');
    const res = await fetch(url, { headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' } });
    if (!res.ok) throw new Error(`Anthropic list models error ${res.status}: ${await res.text()}`);
    const data = await res.json();
    const ids = (data.data || []).map(m => m.id || m.name || m.slug).filter(Boolean);
    return ids;
  }
  if (p === 'openrouter') {
    const url = buildModelsUrl('openrouter', baseUrl, 'https://openrouter.ai/api/v1/models');
    const headers = { };
    if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;
    const res = await fetch(url, { headers });
    if (!res.ok) throw new Error(`OpenRouter list models error ${res.status}: ${await res.text()}`);
    const data = await res.json();
    const ids = (data.data || []).map(m => m.id || m.name || m.slug).filter(Boolean);
    return ids;
  }
  if (p === 'gemini' || p === 'google') {
    const base = buildModelsUrl('gemini', baseUrl, 'https://generativelanguage.googleapis.com/v1beta/models');
    const url = apiKey ? `${base}?key=${encodeURIComponent(apiKey)}` : base;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Gemini list models error ${res.status}: ${await res.text()}`);
    const data = await res.json();
    const names = (data.models || []).map(m => m.name).filter(Boolean);
    // Normalize: strip leading 'models/' to match generateContent path piece we expect
    const ids = names.map(n => n.replace(/^models\//, ''));
    return ids;
  }
  throw new Error('Unsupported provider for model listing: ' + provider);
}

// ===== PDF 支持：pdf.js 本地解析 + Firecrawl 无 key 兜底 =====
let _pdfjsPromise = null;
async function getPdfJs() {
  if (_pdfjsPromise) return _pdfjsPromise;
  _pdfjsPromise = import(chrome.runtime.getURL('assets/vendor/pdfjs/pdf.min.mjs'))
    .then((m) => {
      const lib = m.default || m;
      try {
        if (lib && lib.GlobalWorkerOptions) {
          lib.GlobalWorkerOptions.workerSrc = chrome.runtime.getURL('assets/vendor/pdfjs/pdf.worker.min.mjs');
        }
      } catch (e) {}
      return lib;
    })
    .catch((e) => { _pdfjsPromise = null; throw new Error('pdf.js 加载失败: ' + (e && e.message || e)); });
  return _pdfjsPromise;
}

const PDF_MAX_PAGES = 200;

/** 本地解析 PDF：fetch 字节 → pdf.js 逐页提取文本（SW 环境自动走 fake worker 主线程） */
async function extractPdfText(url) {
  const res = await fetch(url, { credentials: 'omit' });
  if (!res.ok) throw new Error('PDF 下载失败 HTTP ' + res.status);
  const buf = await res.arrayBuffer();
  const pdfjs = await getPdfJs();
  const doc = await pdfjs.getDocument({ data: new Uint8Array(buf) }).promise;
  let title = '';
  try { const meta = await doc.getMetadata(); title = (meta && meta.info && meta.info.Title) || ''; } catch (e) {}
  const pageCount = doc.numPages;
  const maxPages = Math.min(pageCount, PDF_MAX_PAGES);
  let text = '';
  for (let i = 1; i <= maxPages; i++) {
    const page = await doc.getPage(i);
    const tc = await page.getTextContent();
    let line = '';
    let lastY = null;
    for (const item of tc.items) {
      if (!item.str) continue;
      const y = item.transform ? item.transform[5] : 0;
      if (lastY != null && Math.abs(y - lastY) > 1) { if (line) { text += line + '\n'; line = ''; } }
      line += item.str;
      if (item.hasEOL) { text += line + '\n'; line = ''; lastY = null; continue; }
      lastY = y;
    }
    if (line) text += line + '\n';
    text += '\n';
  }
  try { await doc.destroy(); } catch (e) {}
  return { text: text.trim(), title: String(title || '').trim(), pageCount };
}

/** Firecrawl 兜底：在线 PDF → markdown（无 key 走免费档，填 key 提额度/更稳） */
async function firecrawlScrape(url, apiKey) {
  const headers = { 'Content-Type': 'application/json' };
  if (apiKey) headers['Authorization'] = 'Bearer ' + apiKey;
  const res = await fetch('https://api.firecrawl.dev/v2/scrape', {
    method: 'POST',
    headers,
    body: JSON.stringify({ url, formats: ['markdown'], parsers: ['pdf'], onlyMainContent: true }),
  });
  if (!res.ok) {
    let msg = 'Firecrawl HTTP ' + res.status;
    if (res.status === 429) msg = 'Firecrawl 限流(429)，请稍后再试或在选项页配置 API Key';
    else if (res.status === 401) msg = 'Firecrawl API Key 无效(401)';
    else if (res.status === 402) msg = 'Firecrawl 额度不足(402)';
    throw new Error(msg);
  }
  const data = await res.json();
  const md = (data && data.data && data.data.markdown) || '';
  const title = (data && data.data && data.data.metadata && data.data.metadata.title) || '';
  return { text: md.trim(), title: String(title || '').trim() };
}

function extractJson(text) {
  const raw = String(text || '');

  // Helper: balanced JSON block finder starting at first { or [
  function findBalancedJsonBlock(s) {
    const str = String(s || '');
    let start = str.search(/[\{\[]/);
    if (start < 0) return null;
    let depthObj = 0, depthArr = 0;
    let inStr = false, quote = '', esc = false;
    for (let i = start; i < str.length; i++) {
      const ch = str[i];
      if (inStr) {
        if (esc) { esc = false; continue; }
        if (ch === '\\') { esc = true; continue; }
        if (ch === quote) { inStr = false; continue; }
        continue;
      }
      if (ch === '"' || ch === '\'' ) { inStr = true; quote = ch; continue; }
      if (ch === '{') depthObj++;
      else if (ch === '}') depthObj--;
      else if (ch === '[') depthArr++;
      else if (ch === ']') depthArr--;
      if (depthObj < 0 || depthArr < 0) return null; // invalid
      if (depthObj === 0 && depthArr === 0 && i > start) {
        return str.slice(start, i + 1);
      }
    }
    return null;
  }

  // 1) Collect candidates from code fences first
  const candidates = [];
  const fenceRe = /```(?:json|javascript|js)?\s*([\s\S]*?)```/gi;
  let m;
  while ((m = fenceRe.exec(raw))) {
    const inside = String(m[1] || '').trim();
    if (inside) candidates.push(inside);
  }

  // 2) Also consider the whole raw text
  candidates.push(raw.trim());

  // 3) For each candidate, try direct parse, then balanced block parse
  for (const cand of candidates) {
    // Direct parse
    try {
      const obj = JSON.parse(cand);
      if (obj && (obj.cards || obj.items)) return cand;
      // If it parses but without keys, still return as last resort
    } catch {}
    // Balanced block from the candidate
    const block = findBalancedJsonBlock(cand);
    if (block) {
      try {
        const obj = JSON.parse(block);
        if (obj && (obj.cards || obj.items)) return block;
      } catch {}
    }
  }
  // 4) Final fallback: naive first {...} or [{...}] match from raw
  const naive = raw.match(/[\{\[][\s\S]*[\}\]]/);
  return naive ? naive[0] : raw;
}

function truncate(s, n) {
  return s.length > n ? s.slice(0, n) + '…' : s;
}

// ===== 通用化：内容源迁移（video:* → content:*）+ meta 索引 =====
const BG_NS = 'CCAPTIPREPS';
const BG_META_INDEX = BG_NS + ':meta:index';

/** 一次性迁移旧 video:* 数据到 content:*，并维护内容索引（幂等，可反复执行） */
async function migrateLegacyVideoKeys() {
  try {
    const all = await chrome.storage.local.get(null);
    const prefix = BG_NS + ':video:';
    const keys = Object.keys(all || {}).filter((k) => k.startsWith(prefix) && k.length > prefix.length);
    const indexAdd = {};
    let changed = false;
    for (const k of keys) {
      const videoId = k.slice(prefix.length);
      if (!videoId || videoId === 'null' || videoId === 'undefined') continue;
      const data = all[k] || {};
      if (!data.cards && !data.subtitlesText) continue; // 跳过空记录
      const contentKey = BG_NS + ':content:' + videoId;
      const existing = await chrome.storage.local.get(contentKey);
      if (existing[contentKey]) continue; // 已迁移
      const next = Object.assign({}, data, { sourceType: 'youtube', __ts: data.__ts || data.createdAt || Date.now() });
      await chrome.storage.local.set({ [contentKey]: next });
      indexAdd[videoId] = { sourceType: 'youtube', title: data.title || videoId, updatedAt: next.__ts };
      changed = true;
    }
    if (Object.keys(indexAdd).length) {
      const prev = await chrome.storage.local.get(BG_META_INDEX);
      const merged = Object.assign({}, (prev[BG_META_INDEX] || {}), indexAdd);
      await chrome.storage.local.set({ [BG_META_INDEX]: merged });
    }
    if (changed) console.log('[SeekWord] migrated legacy video:* keys to content:*');
  } catch (e) { console.warn('[SeekWord] migration failed', e); }
}

// 迁移挂载（新增 listener，不动已有 onInstalled/onStartup）
try { chrome.runtime.onInstalled.addListener(() => { try { migrateLegacyVideoKeys(); } catch {} }); } catch {}
try { chrome.runtime.onStartup.addListener(() => { try { migrateLegacyVideoKeys(); } catch {} }); } catch {}

// ===== 通用化：右键菜单 + 图标点击 → 按需注入 =====
function bgIsYouTubeUrl(url) {
  try {
    const h = new URL(url || '').host;
    return /(^|\.)youtube\.com$/i.test(h) || /(^|\.)youtu\.be$/i.test(h) || /(^|\.)youtube-nocookie\.com$/i.test(h);
  } catch { return false; }
}

function createContextMenus() {
  try {
    if (!chrome.contextMenus) return;
    chrome.contextMenus.removeAll(() => {
      chrome.contextMenus.create({
        id: 'cc-learn-page',
        title: '用捕获生词学习本页',
        contexts: ['page', 'selection'],
      });
    });
  } catch (e) {}
}
try { chrome.runtime.onInstalled.addListener(() => { try { createContextMenus(); } catch {} }); } catch {}
try { chrome.runtime.onStartup.addListener(() => { try { createContextMenus(); } catch {} }); } catch {}

/** 动态注入脚本（非 YouTube 页面）并通知 UI 打开对应来源流程 */
async function injectAndOpen(tabId, sourceType) {
  // 已注入：直接通知
  try {
    await chrome.tabs.sendMessage(tabId, { type: 'CC_OPEN_MODAL', payload: { sourceType } });
    return;
  } catch (e) {}
  // 未注入：executeScript 注入（activeTab 授权）
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ['assets/capture.js', 'content.js', 'assets/tts.js', 'ui.js'],
    });
    await chrome.tabs.sendMessage(tabId, { type: 'CC_OPEN_MODAL', payload: { sourceType } });
  } catch (e2) {
    console.warn('[SeekWord] injectAndOpen failed', e2);
  }
}

try {
  chrome.contextMenus.onClicked.addListener(async (info, tab) => {
    if (!info || info.menuItemId !== 'cc-learn-page' || !tab || tab.id == null) return;
    const sel = (info.selectionText || '').trim();
    const sourceType = (sel.length > 10) ? 'selection' : (bgIsYouTubeUrl(tab.url) ? 'youtube' : 'article');
    await injectAndOpen(tab.id, sourceType);
  });
} catch {}

try {
  chrome.action.onClicked.addListener(async (tab) => {
    if (!tab || tab.id == null) return;
    const sourceType = bgIsYouTubeUrl(tab.url) ? 'youtube' : 'article';
    await injectAndOpen(tab.id, sourceType);
  });
} catch {}

// ===== Edge TTS 冷启动优化：SW 激活即预取 token，用户点喇叭时已就绪 =====
try { edgeGetToken().catch(() => {}); } catch (e) {}
