/**
 * SeekWord 内容捕获统一层（通用化：YouTube / 文章 / 划词 / 手动）
 *
 * 对应《通用化解决方案.md》§3-§4：内容源适配器 + 统一 CapturedContent。
 * 纯原生 JS、无依赖、隔离世界运行（content script）。
 * 由 content.js 通过 manifest content_scripts 先于 ui.js 加载，暴露 globalThis.CC_CAPTURE。
 *
 * 职责：
 *  - contentId 生成（normalizeUrl / hash）
 *  - LanguageDetector（字符集 + 拉丁特征词投票）
 *  - ArticleAdapter（正文提取：meta 快路径 → 密度评分主路径 → body 兜底）
 *  - SelectionAdapter（划词）/ ManualAdapter（粘贴文本）
 *  - Segmenter（长文分段）
 *  - registry：captureContent(sourceType, opts) 统一分发
 */
(function () {
  'use strict';
  if (globalThis.CC_CAPTURE) return;

  // ================= contentId =================
  var TRACKING_PARAMS = /^(utm_|fbclid|gclid|mc_cid|mc_eid|spm|yclid|igshid|ref_src|ref_url|share_id)/i;

  /** 规范化 URL：去跟踪参数，作为文章稳定 contentId */
  function normalizeUrl(url) {
    try {
      var u = new URL(url || location.href);
      var keys = Array.from(u.searchParams.keys());
      for (var i = 0; i < keys.length; i++) {
        if (TRACKING_PARAMS.test(keys[i])) u.searchParams.delete(keys[i]);
      }
      return u.href;
    } catch (e) {
      return String(url || '');
    }
  }

  /** djb2 hash → 16 进制（划词/手动内容的稳定 id 用） */
  function hashCode(str) {
    var h = 5381;
    var s = String(str || '');
    for (var i = 0; i < s.length; i++) { h = ((h << 5) + h + s.charCodeAt(i)) | 0; }
    return (h >>> 0).toString(16);
  }

  // ================= LanguageDetector =================
  var LATIN_FEATURES = {
    en: ['the', 'and', 'of', 'to', 'is', 'in', 'that', 'for', 'with', 'this', 'are', 'was', 'it', 'as', 'on'],
    es: ['el', 'la', 'de', 'que', 'en', 'los', 'las', 'un', 'una', 'por', 'con', 'para', 'es', 'y'],
    fr: ['le', 'la', 'les', 'des', 'de', 'et', 'est', 'un', 'une', 'que', 'pour', 'dans', 'en', 'au'],
    de: ['der', 'die', 'das', 'und', 'ist', 'den', 'von', 'mit', 'ich', 'auf', 'für', 'nicht', 'ein'],
    it: ['il', 'la', 'di', 'e', 'che', 'un', 'una', 'per', 'con', 'del', 'non', 'sono', 'è'],
    pt: ['o', 'a', 'de', 'que', 'do', 'em', 'e', 'um', 'uma', 'para', 'com', 'não', 'os'],
    nl: ['de', 'het', 'van', 'en', 'een', 'is', 'dat', 'op', 'te', 'voor', 'in', 'met'],
  };

  /** 检测文本语言，返回归一化 LangCode（en/ja/ko/zh_CN/ru/fr/de/es/it/pt/nl/... 或 'und'） */
  function detectLanguage(text) {
    var t = String(text || '');
    if (t.length < 20) return 'und';
    // ① 字符集强信号
    var ja = (t.match(/[\u3040-\u30ff]/g) || []).length;
    var ko = (t.match(/[\uac00-\ud7af]/g) || []).length;
    var han = (t.match(/[\u4e00-\u9fff]/g) || []).length;
    var cyr = (t.match(/[\u0400-\u04ff]/g) || []).length;
    var gre = (t.match(/[\u0370-\u03ff]/g) || []).length;
    var tha = (t.match(/[\u0e00-\u0e7f]/g) || []).length;
    var ar = (t.match(/[\u0600-\u06ff]/g) || []).length;
    if (ja > 3) return 'ja';
    if (ko > 3) return 'ko';
    if (cyr > 3) return 'ru';
    if (gre > 3) return 'el';
    if (tha > 3) return 'th';
    if (ar > 3) return 'ar';
    if (han > 3) {
      // 简体/繁体粗判：常见简体词多 → zh_CN
      var simp = (t.match(/[\u4e00-\u9fff]/g) || []).length;
      var tradOnly = (t.match(/[\u5f37\u96e3\u4f86\u89ba\u570b\u7d66\u958b\u8207\u5c0d\u7cbe\u9ede\u5373]/g) || []).length;
      return tradOnly > 2 ? 'zh_TW' : 'zh_CN';
    }
    // ② 拉丁语系特征词投票
    var words = t.toLowerCase().split(/[^a-zà-ÿ]+/);
    var votes = {};
    for (var i = 0; i < words.length; i++) {
      var w = words[i];
      for (var lang in LATIN_FEATURES) {
        if (LATIN_FEATURES[lang].indexOf(w) >= 0) {
          votes[lang] = (votes[lang] || 0) + 1;
          break;
        }
      }
    }
    var best = null, bestV = 0;
    for (var k in votes) {
      if (votes[k] > bestV) { bestV = votes[k]; best = k; }
    }
    if (best && bestV >= 3) return best;
    // ③ 英文兜底：大量拉丁字母且无强特征 → 大概率英文
    var letters = t.replace(/[^a-zA-Z]/g, '').length;
    if (letters > 10 && bestV >= 1) return best || 'en';
    return 'und';
  }

  // ================= 元信息 =================
  function metaContent(selectors) {
    for (var i = 0; i < selectors.length; i++) {
      var el = document.querySelector(selectors[i]);
      var v = el && (el.getAttribute('content') || el.getAttribute('value') || el.textContent);
      if (v && String(v).trim()) return String(v).trim();
    }
    return '';
  }
  function getTitle() {
    return metaContent(['meta[property="og:title"]', 'meta[name="twitter:title"]', 'meta[itemprop="name"]'])
      || (document.title || '').trim();
  }
  function getCover() {
    return metaContent(['meta[property="og:image"]', 'meta[name="twitter:image"]', 'meta[itemprop="image"]']) || '';
  }
  function getAuthor() {
    return metaContent(['meta[name="author"]', 'meta[property="article:author"]', 'meta[itemprop="author"]']) || '';
  }
  function getPublishedAt() {
    return metaContent(['meta[property="article:published_time"]', 'meta[itemprop="datePublished"]']) || '';
  }

  // ================= ArticleAdapter：正文提取 =================
  var NOISE_TAGS = 'nav,aside,footer,header,script,style,noscript,form,button,iframe,svg,canvas,.ad,.ads,.advertisement,.banner,.comment,.comments,.related,.recommend,.share,.social,.subscribe,.newsletter,.cookie,.popup,.modal,.menu,.sidebar,.breadcrumb,.pagination';
  var PUNCT_COUNT = /[.,!?;:，。！？；：、]/g;

  /** 计算节点文本密度分（性能优化：链接用计数而非逐链接取文本，避免重页面 O(N²)） */
  function scoreNode(el, cachedLen) {
    var text = (el.textContent || '').replace(/\s+/g, ' ');
    var len = (cachedLen !== undefined ? cachedLen : text.trim().length);
    if (len < 40) return 0;
    var puncts = (text.match(PUNCT_COUNT) || []).length;
    // 链接密度惩罚：按链接数估算（getElementsByTagName 只计数，快）
    var linkCount = el.getElementsByTagName ? el.getElementsByTagName('a').length : 0;
    var density = len - linkCount * 12;
    return density + Math.min(puncts * 20, 200);
  }

  /** 从容器提取段落文本（p/li/标题/块引用等；处理 <p><span>text</span></p> 嵌套） */
  function extractBlocks(container) {
    var clone = container.cloneNode(true);
    var noisy = clone.querySelectorAll(NOISE_TAGS);
    for (var j = 0; j < noisy.length; j++) noisy[j].remove();
    var BLOCK = { p: 1, li: 1, h1: 1, h2: 1, h3: 1, h4: 1, blockquote: 1, pre: 1, td: 1, tr: 1 };
    var blocks = [];
    var walker = document.createTreeWalker(clone, NodeFilter.SHOW_ELEMENT, {
      acceptNode: function (n) {
        var tag = n.tagName ? n.tagName.toLowerCase() : '';
        if (tag === 'br' || BLOCK[tag]) return NodeFilter.FILTER_ACCEPT;
        return NodeFilter.FILTER_SKIP;
      }
    });
    var nodes = [];
    while (walker.nextNode()) nodes.push(walker.currentNode);
    for (var k = 0; k < nodes.length; k++) {
      var n = nodes[k];
      var tag = n.tagName ? n.tagName.toLowerCase() : '';
      if (tag === 'br') { if (blocks.length) blocks.push(''); continue; }
      // 若内部还有更深的块级子节点，交给子节点提取，避免重复
      var subs = n.getElementsByTagName('*');
      var hasChildBlock = false;
      for (var m = 0; m < subs.length; m++) {
        var t2 = subs[m].tagName ? subs[m].tagName.toLowerCase() : '';
        if (BLOCK[t2]) { hasChildBlock = true; break; }
      }
      if (hasChildBlock) continue;
      var t = (n.textContent || '').replace(/\s+/g, ' ').trim();
      if (t) blocks.push(t);
    }
    return cleanExtractedText(blocks.join('\n'));
  }

  function cleanExtractedText(text) {
    return String(text || '')
      .replace(/\u00a0/g, ' ')
      .replace(/[ \t]+/g, ' ')
      .replace(/\n{3,}/g, '\n\n')
      .split('\n').map(function (s) { return s.trim(); }).filter(Boolean)
      .join('\n');
  }

  /**
   * 从当前页面提取正文（逐级回退）。
   * 性能策略：优先少数语义容器（article/main/[role=main] 等）快速路径；
   * 只有语义容器不可用才做通用密度评分兜底（限制候选数），避免重页面卡顿。
   * 返回 { text, title, lang, meta }。
   */
  function extractArticle() {
    var root = document.body || document.documentElement;
    // ① 语义容器快速路径（性能关键：只评少数候选）
    var semanticSel = 'article, main, [role="main"], .post, .entry, .article, .entry-content, .post-content, .body-content, .article-body, .post-body';
    var semanticNodes = [];
    try { semanticNodes = Array.prototype.slice.call(root.querySelectorAll(semanticSel)); } catch {}
    var best = null, bestScore = 0;
    for (var i = 0; i < semanticNodes.length; i++) {
      var el = semanticNodes[i];
      if (el.closest && el.closest(NOISE_TAGS)) continue;
      var s = scoreNode(el);
      if (s > bestScore) { bestScore = s; best = el; }
    }
    var container = (best && bestScore > 200) ? best : null;

    // ② 兜底：通用块级密度评分（限数量，防止重页面遍历失控）
    if (!container) {
      var all = [];
      try { all = Array.prototype.slice.call(root.querySelectorAll('div, section, p, td, article, main')); } catch {}
      var best2 = null, bestScore2 = 0, seen = 0;
      for (var j = 0; j < all.length; j++) {
        if (all[j].closest && all[j].closest(NOISE_TAGS)) continue;
        var len = (all[j].textContent || '').trim().length;
        if (len < 80) continue;
        if (seen++ > 150) break; // 候选上限
        var s2 = scoreNode(all[j], len);
        if (s2 > bestScore2) { bestScore2 = s2; best2 = all[j]; }
      }
      if (best2) container = best2;
    }
    if (!container) container = root;

    // ③ 提取段落
    var text = extractBlocks(container);
    if (text.length < 80) text = cleanExtractedText(container.textContent);
    // ④ 兜底：body innerText 截断
    if (text.length < 80) {
      var bodyText = (document.body && document.body.innerText) || '';
      text = cleanExtractedText(bodyText).slice(0, 60000);
    }
    var title = getTitle();
    var meta = {
      coverUrl: getCover(),
      author: getAuthor(),
      publishedAt: getPublishedAt(),
      wordCount: (text || '').split(/\s+/).filter(Boolean).length,
    };
    return { text: text, title: title, lang: detectLanguage(text), meta: meta };
  }

  // ================= SelectionAdapter / ManualAdapter =================
  /** 划词：当前选区文本（在 content script 隔离世界可用） */
  function extractSelection() {
    var sel = '';
    try { sel = (window.getSelection ? window.getSelection().toString() : '') || ''; } catch (e) { sel = ''; }
    var text = cleanExtractedText(sel);
    var title = text.split('\n')[0].slice(0, 40) || 'Selection';
    return { text: text, title: title, lang: detectLanguage(text), meta: {} };
  }

  /** 手动：粘贴/导入文本 */
  function extractManual(textInput, titleInput) {
    var text = cleanExtractedText(String(textInput || ''));
    var firstLine = text.split('\n')[0] || '';
    var title = String(titleInput || '').trim() || firstLine.slice(0, 40) || 'Manual';
    return { text: text, title: title, lang: detectLanguage(text), meta: {} };
  }

  // ================= Segmenter（长文分段） =================
  /**
   * 按段落边界分段，目标 ~target 字符（允许 ±30%）。
   * @returns {Array<{index, text, start, end}>}
   */
  function segmentText(text, target) {
    var t = String(text || '');
    if (!t) return [];
    var targetLen = target || 4000;
    var paras = t.split('\n');
    var segments = [];
    var buf = [];
    var bufLen = 0;
    var start = 0;
    var offset = 0;
    for (var i = 0; i < paras.length; i++) {
      var p = paras[i];
      var pl = p.length + 1;
      if (bufLen + pl > targetLen * 1.3 && buf.length) {
        segments.push({ index: segments.length, text: buf.join('\n'), start: start, end: offset });
        buf = []; bufLen = 0; start = offset;
      }
      buf.push(p); bufLen += pl; offset += pl;
    }
    if (buf.length) segments.push({ index: segments.length, text: buf.join('\n'), start: start, end: offset });
    if (!segments.length) segments.push({ index: 0, text: t, start: 0, end: t.length });
    return segments;
  }

  // ================= Registry =================
  /**
   * 统一内容捕获入口。
   * @param {'article'|'selection'|'manual'} sourceType
   * @param {{text?:string, title?:string, sourceUrl?:string}} [opts]
   * @returns {CapturedContent}
   */
  /** 判断当前页面是否为 PDF（在线 PDF URL / PDF viewer） */
  function isPdfUrl() {
    try {
      var u = (location.href || '').toLowerCase();
      if (/\.pdf(?:[?#]|$)/.test(u)) return true;
      if (document && document.contentType === 'application/pdf') return true;
      if (document && document.querySelector('embed[type="application/pdf"], iframe[type="application/pdf"]')) return true;
    } catch (e) {}
    return false;
  }

  /** 走 background 解析 PDF（pdf.js 本地 + Firecrawl 兜底），失败返回 null 回落 DOM 提取 */
  async function extractPdfViaBackground() {
    try {
      if (typeof chrome === 'undefined' || !chrome.runtime || !chrome.runtime.sendMessage) return null;
      var resp = await chrome.runtime.sendMessage({ type: 'CC_EXTRACT_PDF', url: location.href });
      if (!resp || !resp.ok || !resp.text) return null;
      return {
        title: resp.title || '',
        text: resp.text,
        lang: '',
        meta: { pdf: true, via: resp.via || 'pdf.js', pageCount: resp.pageCount || 0 },
      };
    } catch (e) { return null; }
  }

  async function captureContent(sourceType, opts) {
    opts = opts || {};
    var base;
    if (sourceType === 'article') {
      // PDF 页面：优先走 background 解析（本地 pdf.js → Firecrawl 兜底）
      base = (isPdfUrl() ? (await extractPdfViaBackground()) : null) || extractArticle();
    }
    else if (sourceType === 'selection') base = extractSelection();
    else if (sourceType === 'manual') base = extractManual(opts.text, opts.title);
    else throw new Error('Unknown sourceType: ' + sourceType);

    var sourceUrl = opts.sourceUrl || (sourceType === 'article' ? normalizeUrl(location.href) : '');
    var id;
    if (sourceType === 'article') id = normalizeUrl(sourceUrl || location.href);
    else id = hashCode((base.text || '').slice(0, 200)) + (sourceType === 'manual' ? '_' + Date.now().toString(36) : '');

    var content = {
      id: id,
      sourceType: sourceType,
      sourceUrl: sourceUrl,
      title: base.title || '',
      text: base.text || '',
      lang: base.lang || '',
      meta: base.meta || {},
    };
    // 长文分段（>2 万字符才有意义）
    if ((content.text || '').length > 20000) {
      content.segments = segmentText(content.text, 4000);
    }
    return content;
  }

  globalThis.CC_CAPTURE = {
    captureContent: captureContent,
    detectLanguage: detectLanguage,
    normalizeUrl: normalizeUrl,
    hashCode: hashCode,
    segmentText: segmentText,
    _internal: {
      extractArticle: extractArticle,
      extractSelection: extractSelection,
      extractManual: extractManual,
      scoreNode: scoreNode,
    },
  };
})();
