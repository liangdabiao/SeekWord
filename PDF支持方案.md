# 捕获生词 PDF 支持方案

> 版本：v1.0（2026-09-04）
> 目标：让 捕获生词 在 PDF 页面也能「提取正文 → 筛选生词 → 生成卡片」，复用现有完整学习流程。

---

## 一、现状与问题

**现状：捕获生词 目前无法处理 PDF 页面。**

1. **capture.js 提取正文依赖 HTML DOM**：走 `article / main / [role=main]` 等语义容器 + `document.body.innerText` 密度评分。Chrome 打开 PDF 时用内置 PDF viewer 渲染，页面 DOM 是 viewer 的画布/文本层，**没有这些语义容器**，提取到的是空或 viewer 界面文字。
2. **扩展默认不注入 PDF 页面**：manifest 的 content script 只匹配 YouTube；网页提取靠 `activeTab` + `scripting` 注入，但 Chrome 对 `.pdf` MIME 页面与内置 PDF viewer（`chrome-extension://mhjfb…`）有限制，即便注入也读不到正文。

**结论**：需要一条独立的「PDF → 文本」通道，绕开页面 DOM。

---

## 二、方案总览

| 通道 | 优先级 | 能力 | 成本 | 说明 |
| --- | --- | --- | --- | --- |
| **pdf.js 本地解析**（Mozilla 开源） | 首选 | 在线 PDF URL 提取文本 | 免费 / 离线 / 隐私好 | 直接 `fetch` PDF 字节 → 逐页提取文本层 |
| **Firecrawl 兜底** | 备选 | 在线 PDF → markdown；填 key 解锁扫描版 OCR / 本地文件上传 | 无 key 免费（IP 限流）；key 免费 1000 额度 | 当 pdf.js 失败或文本为空时自动切换 |

**核心思路**：PDF 解析放在 **background（MV3 service worker）** 执行——它的 `fetch` 受 `host_permissions`（`<all_urls>`）授权，不受页面 CORS 限制，能直接抓取 PDF 二进制。页面侧只需检测「这是 PDF」并转发请求。

---

## 三、技术架构（改动后的调用链）

```
用户打开 https://example.com/report.pdf
  → 点击插件图标 / 右键「用 捕获生词 学习本页」
  → background.injectAndOpen() 注入 capture.js/content.js/tts.js/ui.js
  → ui.js.startContentFlow('article')
  → content.js.captureContent('article')
  → capture.js.captureContent('article')
       ├─ isPdfUrl() === true ?
       │    └─ 发消息 CC_EXTRACT_PDF { url } 给 background
       │         → background.fetch(PDF 字节)   ← 不受 CORS 限制
       │         → pdf.js getDocument → 逐页 getTextContent（按 y 坐标拼行）
       │              ├─ 成功且有文本 → 返回 { text, title, pageCount, via:'pdf.js' }
       │              └─ 失败/空（扫描版）→ Firecrawl POST /v2/scrape 兜底
       │                   → 返回 markdown 文本（via:'firecrawl'）
       │         → 包装成 captured 对象返回
       └─ 非 PDF → 原有 DOM 提取逻辑（不变）
  → 后续「筛选生词 → 生成卡片 → 学习」流程完全不变
```

**pdf.js 在 MV3 service worker 的运行方式**：
- 顶层 `importScripts('assets/vendor/pdfjs/pdf.min.js')` 同步加载（MV3 SW 支持）。
- `GlobalWorkerOptions.workerSrc` 指向插件内 worker 文件；service worker 全局**没有 `Worker` 构造器**，pdf.js 自动回退到 **fake worker（主线程解析）**，无需处理 worker 创建问题。

---

## 四、模块改动明细

### 4.1 新增文件
| 文件 | 说明 |
| --- | --- |
| `assets/vendor/pdfjs/pdf.min.js` | pdf.js 主库（3.11.174，已内置） |
| `assets/vendor/pdfjs/pdf.worker.min.js` | pdf.js worker（已内置，SW 主线程模式下作为备用/回退） |

### 4.2 `background.js`
1. 顶部 `importScripts('assets/vendor/pdfjs/pdf.min.js')`，初始化 `pdfjsLib.GlobalWorkerOptions.workerSrc`。
2. 新增 `extractPdfText(url)`：fetch → arrayBuffer → `getDocument({data})` → 遍历页 `getTextContent()`，按 `item.transform[5]`（y 坐标）感知换行拼出正文；带页码上限（默认 200 页）防超时；`getMetadata()` 取标题。
3. 新增 `firecrawlScrape(url, apiKey)`：`POST https://api.firecrawl.dev/v2/scrape`，body `{url, formats:["markdown"], parsers:["pdf"], onlyMainContent:true}`；有 key 加 `Authorization: Bearer`；返回 `data.markdown`。
4. 新增消息 `CC_EXTRACT_PDF`：`{url, apiKey?}` → 先 pdf.js，失败/空则 Firecrawl → `sendResponse({ok, text, title, via})`。

### 4.3 `assets/capture.js`
1. 新增 `isPdfUrl()`：`location.href` 以 `.pdf` 结尾（含 `.pdf#…`）/ `document.contentType === 'application/pdf'` / 存在 `embed[type="application/pdf"]`。
2. `captureContent('article')` 内：命中 `isPdfUrl()` 时改走 `chrome.runtime.sendMessage({type:'CC_EXTRACT_PDF', url: location.href, apiKey})`，把 background 返回的文本包装成与现有 `captured` 相同结构（`id/sourceType/sourceUrl/title/text/lang/meta`）返回，对上层完全透明。

### 4.4 `options/`（选项页）
1. 设置页「大模型」区新增一个可选输入：**Firecrawl API Key（可选，留空用免费无 key 档）**。
2. 存储字段 `firecrawlKey`；随 `getFormSettings()`/profile 一起保存。

### 4.5 `manifest.json`
- **无需新增权限**：`<all_urls>` host_permissions 已覆盖跨域 fetch PDF；pdf.js 走 background `importScripts`（同扩展资源），无需 `web_accessible_resources`。

---

## 五、Firecrawl 兜底策略

| 场景 | 行为 |
| --- | --- |
| pdf.js 解析成功且有文本 | 用本地结果（免费离线，默认路径） |
| pdf.js fetch 失败（网络/404/权限） | 自动切换 Firecrawl `/v2/scrape` |
| pdf.js 返回空文本（扫描版/图片型 PDF） | 自动切换 Firecrawl（OCR 能力） |
| Firecrawl 也失败 | 返回明确错误文案（区分 429 限流 / 401 / 其他），浮层显示 |

无 key 档：免密钥免费，按 IP 每天「请求数 + 额度」双上限，超限返回 429；学习场景（偶尔抓 PDF）基本够用。填 key：注册即送 1000 额度，更高限额，并解锁本地文件上传 `/parse`（二期）。

---

## 六、边界与限制

1. **本地 `file://` PDF**：Chrome 扩展不能 `fetch` `file://`（需开启文件访问权限且仍受限）。**本期支持在线 PDF URL**；本地 PDF 可先把文件上传到可访问 URL，或手动复制文本。Firecrawl `/parse` 上传本地文件（需 key）作为二期。
2. **扫描版 PDF**：pdf.js 只能取文本层，扫描件需 Firecrawl OCR（填 key 走 `/parse`，一期先用 `/v2/scrape` 试，不行提示换 key）。
3. **无 key IP 限流**：不稳定因素，429 时提示用户注册 key。
4. **超大 PDF**：默认限制前 200 页，超出截断并在 meta 中标记。
5. **有密码 PDF**：pdf.js 会抛密码错误，提示用户。

---

## 七、测试方案

1. **单元测试**（node + pdf.js）：构造/下载一个测试 PDF，直接调 `extractPdfText`，断言返回文本含预期单词、标题正确、分页拼接正确。
2. **端到端**（vm + mock chrome）：模拟 `CC_EXTRACT_PDF` 消息（mock `fetch` 返回 PDF 字节 / mock Firecrawl），断言：
   - 本地解析成功 → `via:'pdf.js'`
   - pdf.js 空/失败 → 切 Firecrawl → `via:'firecrawl'`
   - 两者失败 → 明确错误
3. **语法检查**：`node --check` 全部改动文件。
4. **手动测试指引**：给用户在线 PDF URL 列表，在扩展里实测提取 → 筛选 → 制卡全流程。

---

## 八、交付物
- 方案文档（本文件）
- `assets/vendor/pdfjs/*`（内置库）
- `background.js`（PDF 解析 + Firecrawl 兜底 + CC_EXTRACT_PDF）
- `assets/capture.js`（PDF 检测 + 转发）
- `options/`（Firecrawl Key 可选输入）
- 测试脚本与结果

---

## 九、实现记录（2026-09-04）

### 实现方式（按本方案落地）

| 模块 | 文件 | 改动 |
| --- | --- | --- |
| 内置库 | `assets/vendor/pdfjs/pdf.min.mjs` + `pdf.worker.min.mjs` | **pdfjs-dist@4.4.168 ESM 版**（3.11 无 ESM 构建，404；4.x 提供 mjs）。SW 全局无 `Worker` 构造器 → pdf.js 自动回退 **fake worker（主线程解析）**，已离线验证 |
| background | `background.js` | ①`DEFAULT_SETTINGS` 加 `firecrawlKey:''`；②新增 `getPdfJs()`（懒加载动态 `import` pdf.min.mjs + 设 workerSrc）、`extractPdfText(url)`（fetch→arrayBuffer→逐页按 y 坐标拼行，限 200 页，取 Title）、`firecrawlScrape(url,apiKey)`（POST `/v2/scrape`，`formats:['markdown']`,`parsers:['pdf']`，429/401/402 明确报错）；③新增 `CC_EXTRACT_PDF` 消息 handler：**先 pdf.js 本地解析，空文本(<10 字符)或失败 → 自动切 Firecrawl**，返回 `{ok,text,title,via}` |
| capture | `assets/capture.js` | ①`isPdfUrl()`：URL 以 `.pdf` 结尾 / `contentType==='application/pdf'` / `embed[type=application/pdf]`；②`captureContent` 改 **async**（调用方 content.js 本就是 async，无缝兼容），article 类型命中 PDF 时发 `CC_EXTRACT_PDF` 给 background，失败回落 DOM 提取；meta 带 `{pdf:true, via, pageCount}` |
| options | `options/index.html` + `options.js` + `_locales/*` | 模型卡片下新增 **Firecrawl API Key** 输入框（可留空），DEFAULTS/load 回填/getFormSettings/autosave 四处置入；en/zh_CN 各加 2 个 i18n key |
| manifest | 无需改 | background 已是 module SW（host_permissions `<all_urls>` 已授权跨域 fetch PDF）；`assets/*` 已在 web_accessible_resources |

### 测试结果（已通过）

- **离线可行性**：node（无 Worker 构造器模拟 SW）动态 import ESM pdf.js → fake worker 成功解析自构造 PDF，提取文本 `"Hello 捕获生词 PDF test 2026"`。
- **端到端 3 场景**（vm + mock chrome/fetch，`--experimental-vm-modules`）：
  - 场景1 pdf.js 本地成功 → `via:'pdf.js'`，text 含预期内容，Firecrawl **未被调用** ✅
  - 场景2 pdf.js 失败(404) → 自动切 Firecrawl → `via:'firecrawl'` ✅
  - 场景3 都失败(Firecrawl 429) → 明确中文报错「Firecrawl 限流(429)…」✅
- **语法**：`node --check` background.js / capture.js / options.js 全部通过；manifest.json 解析通过。

### 待用户实测（手动测试）
1. 到 `chrome://extensions` 重新加载扩展。
2. 打开一个在线文本版 PDF（如 `https://arxiv.org/pdf/…` 或任意 `.pdf` 链接），点扩展图标。
3. 预期：提取 → 生词筛选 → 卡片生成全流程与网页一致，卡片来源标记 `meta.via='pdf.js'`。
4. 若该 PDF 无文本层（扫描版）会自动走 Firecrawl（无 key 免费档）；429 时到选项页填 Firecrawl Key。
5. **已知待验证点**：Chrome 对 `.pdf` 顶层标签页的程序化注入（executeScript）行为因版本而异；若点击图标后浮层未能打开，需在 background 的 `injectAndOpen` 增加「检测到 PDF 标签 → 直接后台提取并打开插件自有页面」的备用通道（下一期）。
