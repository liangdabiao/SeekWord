(() => {
  function post(pr, error) {
    try {
      window.postMessage({ type: 'CC_PLAYER_RESPONSE', payload: pr || null, error: error ? String(error) : undefined }, location.origin);
    } catch (e) {
      try { window.postMessage({ type: 'CC_PLAYER_RESPONSE', payload: null, error: String(e) }, location.origin); } catch {}
    }
  }
  function readPR() {
    try {
      // Try multiple sources for player response
      let pr = window.ytInitialPlayerResponse;
      if (!pr && window.ytplayer && window.ytplayer.config && window.ytplayer.config.args) {
        const args = window.ytplayer.config.args;
        if (args.player_response) {
          try {
            pr = JSON.parse(args.player_response);
          } catch {}
        }
      }
      // Also try from ytPlayerConfig if available
      if (!pr && window.ytPlayerConfig && window.ytPlayerConfig.args && window.ytPlayerConfig.args.player_response) {
        try {
          pr = JSON.parse(window.ytPlayerConfig.args.player_response);
        } catch {}
      }
      return pr;
    } catch (e) {
      return null;
    }
  }

  // NEW: helpers to read InnerTube runtime config from the page safely
  function getYtCfgValue(key) {
    try {
      const ytcfg = window.ytcfg;
      if (ytcfg && typeof ytcfg.get === 'function') {
        const v = ytcfg.get(key);
        if (v !== undefined && v !== null && v !== '') return v;
      }
      const data = ytcfg && (ytcfg.data_ || ytcfg.data);
      if (data && data[key] !== undefined) return data[key];
    } catch {}
    return undefined;
  }
  function getInnerTubeDefaults() {
    const pr = readPR();
    const apiKey = getYtCfgValue('INNERTUBE_API_KEY');
    const clientVersion = getYtCfgValue('INNERTUBE_CLIENT_VERSION');
    const visitorData = getYtCfgValue('VISITOR_DATA') || (pr && pr.responseContext && pr.responseContext.visitorData) || undefined;
    return { apiKey, clientVersion, visitorData };
  }
  
  // Try immediate read first
  const immediate = readPR();
  if (immediate) {
    post(immediate);
  } else {
    // If not available, poll for it
    const start = Date.now();
    const timeoutMs = 8000; // wait up to 8s (increased)
    const int = setInterval(() => {
      const pr = readPR();
      if (pr) {
        clearInterval(int);
        post(pr);
      } else if (Date.now() - start > timeoutMs) {
        clearInterval(int);
        post(null, 'Timed out waiting for ytInitialPlayerResponse');
      }
    }, 150); // check more frequently
  }

  // Caption fetch proxy: allow content script to fetch via page context
  window.addEventListener('message', async (event) => {
    // 强化来源校验
    if (!event || event.source !== window || event.origin !== location.origin) return;
    const d = event && event.data;
    if (!d) return;

    // Existing caption fetch (GET)
    if (d.type === 'CC_FETCH_CAPTION' && d.url && d.id) {
      try {
        // URL 白名单校验
        let u;
        try { u = new URL(d.url); } catch { u = null; }
        const allowedHosts = new Set(['www.youtube.com', 'youtube.com', 'm.youtube.com', 'music.youtube.com']);
        const isHttps = !!u && u.protocol === 'https:';
        const hostOk = !!u && (allowedHosts.has(u.hostname));
        const pathOk = !!u && (u.pathname === '/api/timedtext');
        if (!u || !isHttps || !hostOk || !pathOk) {
          try { window.postMessage({ type: 'CC_FETCH_CAPTION_RESULT', id: d.id, ok: false, status: 0, contentType: '', text: '', error: 'URL not allowed' }, location.origin); } catch {}
          return;
        }

        const res = await fetch(d.url, { credentials: 'include' });
        const ct = res.headers.get('content-type') || '';
        const text = await res.text();
        window.postMessage({ type: 'CC_FETCH_CAPTION_RESULT', id: d.id, ok: !!res.ok, status: res.status, contentType: ct, text }, location.origin);
      } catch (e) {
        try { window.postMessage({ type: 'CC_FETCH_CAPTION_RESULT', id: d.id, ok: false, status: 0, contentType: '', text: '', error: String(e) }, location.origin); } catch {}
      }
      return;
    }

    // Read currently selected caption track from the in-page player
    if (d.type === 'CC_GET_SELECTED_CC' && d.id) {
      try {
        const player = document.getElementById('movie_player');
        let track = null;
        try {
          if (player && typeof player.getOption === 'function') {
            track = player.getOption('captions', 'track') || player.getOption('cc', 'track') || null;
          }
        } catch {}
        // Normalize shape
        const pick = track ? {
          languageCode: track.languageCode || track.lang || '',
          vssId: track.vssId || '',
          translationLanguage: track.translationLanguage || '',
          kind: track.kind || '',
          name: (track.name && (track.name.simpleText || track.name.runs?.map(r=>r.text).join('') || '')) || ''
        } : null;
        window.postMessage({ type: 'CC_SELECTED_CC', id: d.id, ok: true, track: pick }, location.origin);
      } catch (e) {
        try { window.postMessage({ type: 'CC_SELECTED_CC', id: d.id, ok: false, error: String(e) }, location.origin); } catch {}
      }
      return;
    }
    // NEW: InnerTube POST proxy (player/next/get_transcript)
    if (d.type === 'CC_YT_API' && d.id && d.endpoint && d.payload) {
      try {
        // endpoint 白名单
        const allowedEndpoints = new Set(['/player', '/next', '/get_transcript']);
        if (typeof d.endpoint !== 'string' || !allowedEndpoints.has(d.endpoint)) {
          try { window.postMessage({ type: 'CC_YT_API_RESULT', id: d.id, ok: false, status: 0, contentType: '', json: null, text: '', error: 'Endpoint not allowed' }, location.origin); } catch {}
          return;
        }

        const API_BASE = 'https://www.youtube.com/youtubei/v1';
        const { apiKey: pageApiKey, clientVersion: pageClientVersion, visitorData: pageVisitorData } = getInnerTubeDefaults();
        const API_KEY = d.apiKey || pageApiKey;
        if (!API_KEY) {
          try { window.postMessage({ type: 'CC_YT_API_RESULT', id: d.id, ok: false, status: 0, contentType: '', json: null, text: '', error: 'No INNERTUBE_API_KEY available' }, location.origin); } catch {}
          return;
        }
        const url = `${API_BASE}${d.endpoint}?key=${API_KEY}`;
        const headers = {
          'Content-Type': 'application/json',
          'Accept': '*/*',
          'X-Youtube-Client-Name': '1', // WEB
        };
        const cv = d.clientVersion || pageClientVersion;
        if (cv) headers['X-Youtube-Client-Version'] = cv;
        const visitorId = (d.payload && (d.payload.visitorData || (d.payload.context && d.payload.context.client && d.payload.context.client.visitorData))) || pageVisitorData;
        if (visitorId) headers['X-Goog-Visitor-Id'] = visitorId;

        // Normalize payload to include clientName/clientVersion/visitorData when missing
        let payload;
        try { payload = JSON.parse(JSON.stringify(d.payload)); } catch { payload = d.payload || {}; }
        if (!payload.context) payload.context = {};
        if (!payload.context.client) payload.context.client = {};
        if (!payload.context.client.clientName) payload.context.client.clientName = 'WEB';
        if (cv && !payload.context.client.clientVersion) payload.context.client.clientVersion = cv;
        const pv = visitorId;
        if (pv) {
          if (!payload.visitorData) payload.visitorData = pv;
          if (!payload.context.client.visitorData) payload.context.client.visitorData = pv;
        }

        const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(payload), credentials: 'include' });
        const ct = res.headers.get('content-type') || '';
        const text = await res.text();
        let json = null; try { json = JSON.parse(text); } catch {}
        window.postMessage({ type: 'CC_YT_API_RESULT', id: d.id, ok: !!res.ok, status: res.status, contentType: ct, json, text }, location.origin);
      } catch (e) {
        try { window.postMessage({ type: 'CC_YT_API_RESULT', id: d.id, ok: false, status: 0, contentType: '', json: null, text: '', error: String(e) }, location.origin); } catch {}
      }
      return;
    }
  });
})();


// ===== [read-frog 借鉴] timedtext 拦截 + 播放器字幕数据（pot 签名通道）=====
(() => {
  if (window.__ccRF) return; // 已注入
  window.__ccRF = true;
  const g = window.__ccRFState = window.__ccRFState || {
    cache: new Map(),        // videoId -> 带 pot 的 timedtext URL
    waiters: new Map(),      // videoId -> [resolve]
    hooked: false,
  };
  function cacheUrl(u) {
    try {
      const url = new URL(String(u));
      if (url.hostname.indexOf('youtube.com') !== -1 && url.pathname.indexOf('/api/timedtext') !== -1) {
        const v = url.searchParams.get('v');
        const pot = url.searchParams.get('pot');
        if (v && pot) {
          g.cache.set(v, url.toString());
          const w = g.waiters.get(v);
          if (w && w.length) { w.forEach((r) => { try { r(url.toString()); } catch {} }); g.waiters.delete(v); }
        }
      }
    } catch {}
  }
  function hook() {
    if (g.hooked) return;
    g.hooked = true;
    try {
      const oOpen = XMLHttpRequest.prototype.open, oSend = XMLHttpRequest.prototype.send;
      XMLHttpRequest.prototype.open = function (m, url) { this.__ccUrl = String(url); return oOpen.apply(this, arguments); };
      XMLHttpRequest.prototype.send = function () {
        try { this.addEventListener('load', function () { try { cacheUrl(this.responseURL || this.__ccUrl); } catch {} }); } catch {}
        return oSend.apply(this, arguments);
      };
    } catch {}
    try {
      const oFetch = window.fetch;
      window.fetch = function (input) {
        const u = typeof input === 'string' ? input : (input && input.url) || '';
        const p = oFetch.apply(this, arguments);
        if (typeof u === 'string') p.then(function () { try { cacheUrl(u); } catch {} }).catch(function () {});
        return p;
      };
    } catch {}
  }
  function findPlayer() {
    try { return document.querySelector('.html5-video-player') || document.getElementById('movie_player') || null; } catch { return null; }
  }
  function getSelectedTrack() {
    try {
      const player = findPlayer();
      if (player && typeof player.getOption === 'function') {
        const t = player.getOption('captions', 'track') || player.getOption('cc', 'track') || null;
        if (t) return { languageCode: t.languageCode || t.lang || '', vssId: t.vssId || '', kind: t.kind || '' };
      }
    } catch {}
    return null;
  }
  window.addEventListener('message', (event) => {
    if (!event || event.source !== window || event.origin !== location.origin) return;
    const d = event && event.data;
    if (!d) return;

    // 播放器字幕数据（tracks + 带 pot 的 audioCaptionTracks + 拦截到的 timedtext URL）
    if (d.type === 'CC_YT_CAPTION_DATA' && d.id) {
      (async () => {
        try {
          const player = findPlayer();
          const playerResponse = player && typeof player.getPlayerResponse === 'function' ? player.getPlayerResponse() : null;
          const pr = playerResponse || window.ytInitialPlayerResponse || null;
          const tracks = (pr && pr.captions && pr.captions.playerCaptionsTracklistRenderer && pr.captions.playerCaptionsTracklistRenderer.captionTracks) || [];
          const videoId = d.videoId || (pr && pr.videoDetails && pr.videoDetails.videoId) || '';
          let audioCaptionTracks = [];
          try {
            const at = player && typeof player.getAudioTrack === 'function' ? player.getAudioTrack() : null;
            if (at && Array.isArray(at.captionTracks)) audioCaptionTracks = at.captionTracks;
          } catch {}
          const cached = videoId ? g.cache.get(videoId) || null : null;
          // device/cver：重建带签名 timedtext URL 所需（参考 read-frog url-builder）
          let device = null, cver = null;
          try { const y = window.ytcfg; device = (y && typeof y.get === 'function') ? y.get('DEVICE') || null : null; } catch {}
          try { const wcc = player && typeof player.getWebPlayerContextConfig === 'function' ? player.getWebPlayerContextConfig() : null; cver = (wcc && wcc.innertubeContextClientVersion) || null; } catch {}
          window.postMessage({
            type: 'CC_YT_CAPTION_DATA_RESULT', id: d.id, ok: true, videoId,
            tracks: Array.isArray(tracks) ? tracks : [],
            audioCaptionTracks: Array.isArray(audioCaptionTracks) ? audioCaptionTracks : [],
            cachedTimedtextUrl: cached, selectedTrack: getSelectedTrack(),
            device, cver
          }, location.origin);
        } catch (e) {
          try { window.postMessage({ type: 'CC_YT_CAPTION_DATA_RESULT', id: d.id, ok: false, error: String(e) }, location.origin); } catch {}
        }
      })();
      return;
    }

    // 强制开启字幕（触发播放器发出带 pot 的 timedtext 请求）
    if (d.type === 'CC_YT_ENSURE_CC' && d.id) {
      try {
        const btn = document.querySelector('.ytp-subtitles-button');
        if (btn) {
          if (btn.getAttribute('aria-pressed') !== 'true') {
            const player = findPlayer();
            if (player && typeof player.toggleSubtitles === 'function') player.toggleSubtitles();
            else if (typeof btn.click === 'function') btn.click();
          }
        }
      } catch {}
      try { window.postMessage({ type: 'CC_YT_ENSURE_CC_RESULT', id: d.id, ok: true }, location.origin); } catch {}
      return;
    }

    // 等待拦截到带 pot 的 timedtext URL
    if (d.type === 'CC_YT_WAIT_TIMEDTEXT' && d.id) {
      const videoId = d.videoId || '';
      const timeout = (typeof d.timeout === 'number' && d.timeout > 0) ? d.timeout : 8000;
      const cached = videoId ? g.cache.get(videoId) || null : null;
      const respond = (url) => {
        try { window.postMessage({ type: 'CC_YT_WAIT_TIMEDTEXT_RESULT', id: d.id, url }, location.origin); } catch {}
      };
      if (cached) { respond(cached); return; }
      const arr = g.waiters.get(videoId) || [];
      arr.push(respond);
      g.waiters.set(videoId, arr);
      setTimeout(() => {
        const cur = g.waiters.get(videoId) || [];
        const i = cur.indexOf(respond);
        if (i !== -1) { cur.splice(i, 1); respond(g.cache.get(videoId) || null); }
      }, timeout);
      return;
    }
  });
  hook();
})();
