<h1 align="center">
  <strong>捕获生词 SeekWord - 你的 AI 驱动语言学习助手</strong>
</h1>

<p align="center">
 <b>简体中文</b> | <a href="README.en.md">English</a> | <a href="README.es.md">Español</a> | <a href="README.fr.md">Français</a> | <a href="README.de.md">Deutsch</a> | <a href="README.ja.md">日本語</a> | <a href="README.ko.md">한국어</a> | <a href="README.ru.md">Русский</a>
</p>

<p align="center"><em>先用任意英文内容预习生词，再带着上下文去阅读/观看——学得更快、记得更牢。</em></p>

**捕获生词（SeekWord = seek + word，寻找生词）。** 它的目标是“用任何英文内容学语言”。无论是 YouTube 字幕、任意网页文章、划选的一段文字，还是自己粘贴的文本，捕获生词都会在正式阅读/观看之前，先把生词与表达**自动捕获**成学习卡片；完成预习后再回到原文，借助真实上下文强化记忆。这样的 Contextual learning（基于上下文情境的学习）能事半功倍，让学习变得有趣且“无痛”。
本项目继承自 ：https://github.com/liangdabiao/SeekWord ,但是大幅度修改和增强功能，相信更适合初学者和进修者！

## 🤔 能做什么？
### 1｜多来源内容捕获
- **YouTube 字幕**：自动提取字幕。字幕接口常被 YouTube 的 PO Token 签名拦截，插件采用**多层保障**（详见下方“字幕提取”章节）：优先从页面播放器获取带签名（pot）的真实字幕 URL 并拦截其网络请求（借鉴 read-frog 方案，成功率最高）→ 页面内 InnerTube 接口 → 无登录多客户端兜底。
- **任意网页文章**：打开网页点扩展图标，或右键“用捕获生词学习本页”，自动提取正文。
- **PDF 文档**：打开在线 PDF（`.pdf` 链接）点扩展图标，内置 pdf.js 本地解析正文；扫描版/无文本层自动走 Firecrawl 兜底。
- **划词**：在网页上选中一段文字，右键即可用它建卡。
- **手动粘贴**：浮层内点击“+”新建内容，粘贴任意文本即可。

### 2｜智能筛选 & 生成闪卡
AI 先对生词做初筛（只挑真正值得学的），你在面板中微调选择，随后自动生成学习卡片——音标、词性、释义、例句、笔记一应俱全，点击卡片上的喇叭即可朗读发音（默认 **Edge TTS** 微软神经语音，发音自然清晰）。

<img width="1822" height="1180" alt="image" src="https://github.com/user-attachments/assets/92bdcef1-b6ff-4b81-8c02-75cbd87d201f" />

---

<img width="1822" height="1180" alt="英语" src="https://github.com/user-attachments/assets/85dca5e9-f13d-46e1-94a4-20e0428331c8" />

---

### 3｜单词本：记录所有学过的内容与单词，可按来源过滤（视频/文章/划词/手动），便于课后复习与导出。

<img width="1822" height="1180" alt="image" src="https://github.com/user-attachments/assets/2dce6ade-dce2-4c1d-8455-ce58524b3212" />

---

<img width="1822" height="1180" alt="image" src="https://github.com/user-attachments/assets/08484923-7b1c-4385-80d4-4e429998bce5" />

---

### 4｜可设置释义语言，多语言支持，各个国家的人都可以学习各个国家的语言！

<table>
  <tr>
    <td align="center">
      <a href="https://github.com/user-attachments/assets/d14eb772-8679-44e6-9c90-9376567bea4b"><img src="https://github.com/user-attachments/assets/d14eb772-8679-44e6-9c90-9376567bea4b" alt="Chinese (Simplified)" width="300" /></a>
      <br><sub>简体中文 / Chinese (Simplified)</sub>
    </td>
    <td align="center">
      <a href="https://github.com/user-attachments/assets/543fa9d7-024c-4619-bb55-cec191606b34"><img src="https://github.com/user-attachments/assets/543fa9d7-024c-4619-bb55-cec191606b34" alt="Chinese (Traditional)" width="300" /></a>
      <br><sub>繁體中文 / Chinese (Traditional)</sub>
    </td>
    <td align="center">
      <a href="https://github.com/user-attachments/assets/074c2f62-1c93-43d6-b9ee-ceb86a307e3c"><img src="https://github.com/user-attachments/assets/074c2f62-1c93-43d6-b9ee-ceb86a307e3c" alt="English" width="300" /></a>
      <br><sub>英语 / English</sub>
    </td>
  </tr>
  <tr>
    <td align="center">
      <a href="https://github.com/user-attachments/assets/a259136a-9f58-4c0f-9474-c34a7d557940"><img src="https://github.com/user-attachments/assets/a259136a-9f58-4c0f-9474-c34a7d557940" alt="Spanish" width="300" /></a>
      <br><sub>西班牙语 / Español (Spanish)</sub>
    </td>
    <td align="center">
      <a href="https://github.com/user-attachments/assets/4d028322-914a-4171-8a2a-e3d1193cfac7"><img src="https://github.com/user-attachments/assets/4d028322-914a-4171-8a2a-e3d1193cfac7" alt="Japanese" width="300" /></a>
      <br><sub>日语 / 日本語 (Japanese)</sub>
    </td>
    <td align="center">
      <a href="https://github.com/user-attachments/assets/3c51cafe-34c7-4243-8670-5f87be6407fc"><img src="https://github.com/user-attachments/assets/3c51cafe-34c7-4243-8670-5f87be6407fc" alt="Korean" width="300" /></a>
      <br><sub>韩语 / 한국어 (Korean)</sub>
    </td>
  </tr>
  <tr>
    <td align="center">
      <a href="https://github.com/user-attachments/assets/acc893fc-b00c-4d16-ac1a-18e22f5bba96"><img src="https://github.com/user-attachments/assets/acc893fc-b00c-4d16-ac1a-18e22f5bba96" alt="French" width="300" /></a>
      <br><sub>法语 / Français (French)</sub>
    </td>
    <td align="center">
      <a href="https://github.com/user-attachments/assets/dff198e4-8a04-4282-ad61-7cb0e29a519b"><img src="https://github.com/user-attachments/assets/dff198e4-8a04-4282-ad61-7cb0e29a519b" alt="Russian" width="300" /></a>
      <br><sub>俄语 / Русский (Russian)</sub>
    </td>
    <td align="center">
      <a href="https://github.com/user-attachments/assets/9ab5b61e-a4c5-4cc8-93ce-a8da446a43c8"><img src="https://github.com/user-attachments/assets/9ab5b61e-a4c5-4cc8-93ce-a8da446a43c8" alt="German" width="300" /></a>
      <br><sub>德语 / Deutsch (German)</sub>
    </td>
  </tr>
</table>

---

## ⚙️ 使用方法
1. 安装：
 
- 开发：Chrome → `chrome://extensions` → 打开“开发者模式” → “加载已解压的扩展程序” → 选择本仓库目录。（请先 git clone https://github.com/liangdabiao/SeekWord.git）

- **手动安装 .crx（无需编译）**：项目根目录已提供 `CaptiPrep-main.crx`，直接拖入浏览器即可安装：
  - **Chrome 浏览器**：地址栏输入 `chrome://extensions` 回车 → 右上角开启「开发者模式」→ 将 `CaptiPrep-main.crx` 文件拖入页面 → 弹窗点击「添加扩展程序」（若提示"未通过 Chrome 网上应用店验证"，点击仍要启用即可）
  - **Edge 浏览器**：地址栏输入 `edge://extensions` 回车 → 左下角开启「开发人员模式」→ 将 `CaptiPrep-main.crx` 拖入页面 → 点击「添加扩展」
  - **备选方案**：若 Chrome 严格模式阻止 .crx 安装，可将 `CaptiPrep-main.crx` 重命名为 `.zip` 解压，再用「加载已解压的扩展程序」选择解压目录。

2. **视频**：打开任意带字幕的 YouTube 视频，点击扩展图标。
3. **文章**：打开任意英文网页，点击扩展图标或右键“用捕获生词学习本页”，自动提取正文。
4. **PDF**：打开任意在线 PDF（`.pdf` 链接），点击扩展图标，自动提取正文（默认 pdf.js 本地解析，扫描版自动切 Firecrawl 兜底）。
5. **划词**：在网页上选中一段文字，右键“用捕获生词学习本页”。
6. **手动**：浮层内点击右上角“+”新建内容，粘贴文本后开始。
7. 在浮层面板：提取内容 → 选择要学的词/短语 → 生成卡片 → 学习。**点击小键盘的左右可以切换单词卡，点击空格可以收藏该单词。**
8. 点击右侧入口打开“单词本”，可按来源（视频/文章/划词/手动）过滤，随时回顾已学内容。
9. 点击导出按钮，可将单词打包导出。
10. **模型选择**：推荐将筛选模型设置为 gemini-3.1-flash-lite，将制卡模型设置为 gemini-3.5-flash（或 gemini-3.8-flash），速度与效果均衡。

### 🤖 大模型配置指南（Base URL 怎么填）

在扩展的**选项页**（右键扩展图标 → 选项）中配置 API Key、Base URL 与模型，配置仅保存在本地浏览器。下拉框支持 **Gemini、OpenAI、Claude（Anthropic）、OpenRouter、OpenAI Compatible** 五种服务商，切换后按下面表格填写即可。**模型与接口更新很快，下表为 2026 年 9 月核实的最新版本；如有个别模型下架/改名，以选项页「显示大模型列表」自动拉取的结果为准。**

> **Base URL 要填「完整的聊天接口地址」**（不是网页地址、也不是仅域名），结尾带上 `/chat/completions`、`/messages` 或 `:generateContent`。填好后点击「显示大模型列表」可自动拉取该服务商当前可用的模型名，直接点选即可。

| 服务商 | 下拉选择 | API Key 获取 | 应填写的 Base URL | 当前可用模型（2026-09） |
| --- | --- | --- | --- | --- |
| **Google Gemini**（默认推荐） | Gemini | [aistudio.google.com/apikey](https://aistudio.google.com/apikey) | **留空即可**（默认自动按模型拼接） | 筛选：`gemini-3.1-flash-lite`；制卡：`gemini-3.5-flash` 或 `gemini-3.8-flash`（最新） |
| **OpenAI** | OpenAI | [platform.openai.com/api-keys](https://platform.openai.com/api-keys) | `https://api.openai.com/v1/chat/completions` | `gpt-5.4-mini`（快省）/ `gpt-5.4` / `gpt-5.5` / `gpt-5.6-luna` / `gpt-5.4-pro` |
| **Claude** | Anthropic | [console.anthropic.com](https://console.anthropic.com/) | `https://api.anthropic.com/v1/messages` | `claude-haiku-4-5`（快）/ `claude-sonnet-5` / `claude-opus-5` / `claude-fable-5`（旗舰） |
| **OpenRouter**（一个 Key 用多家模型） | OpenRouter | [openrouter.ai/keys](https://openrouter.ai/keys) | `https://openrouter.ai/api/v1/chat/completions` | `deepseek/deepseek-v4-flash`、`google/gemini-3.5-flash`、`openai/gpt-5.4-mini` 等 |
| **DeepSeek** | OpenAI Compatible | [platform.deepseek.com](https://platform.deepseek.com/) | `https://api.deepseek.com/v1/chat/completions` | `deepseek-v4-flash`（快省）/ `deepseek-v4-pro`（强）/ `deepseek-v4-flash-vision-exp` |
| **通义千问 Qwen** | OpenAI Compatible | [bailian.console.aliyun.com](https://bailian.console.aliyun.com/) | `https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions` | `qwen3.8-flash`（快）/ `qwen3.7-plus`（平衡）/ `qwen3.8-max`（旗舰） |
| **Kimi** | OpenAI Compatible | [platform.moonshot.cn](https://platform.moonshot.cn/) | `https://api.moonshot.cn/v1/chat/completions`（海外版 `https://api.moonshot.ai/v1/chat/completions`） | `kimi-k3`（旗舰）/ `kimi-k2.7-code` |
| **智谱 GLM** | OpenAI Compatible | [open.bigmodel.cn](https://open.bigmodel.cn/) | `https://open.bigmodel.cn/api/paas/v4/chat/completions` | `glm-5.2` / `glm-5.1` / `glm-4.7-flash`（免费轻量） |

**要点：**
- 除 Gemini 外，其他服务商都要按上表填**完整**的 Base URL（含结尾的接口路径）；填错会导致无法调用。
- 下拉选择「OpenAI Compatible」可接任意 OpenAI 兼容接口——DeepSeek、通义千问、Kimi、智谱 GLM、本地 Ollama 等都可以。
- 填完点击「显示大模型列表」，可自动拉取该服务商可用的模型名并点选，不用手敲；拉到的就是最新上架的模型。
- API Key 仅保存在本地浏览器，不会上传。

### 📄 PDF 提取（自动，无需配置）
- 打开在线 PDF（`.pdf` 链接）点扩展图标即可：默认用内置 **pdf.js 本地解析**（免费、离线、隐私好），不依赖任何服务。
- 扫描版 PDF（无文本层）会自动切换 **Firecrawl** 在线兜底：**无需 API Key** 也能用（按 IP 免费额度）；在选项页「模型」卡片下方填入 Firecrawl API Key 可提升额度、解锁扫描版 OCR 与本地文件上传。
- 限制：本期支持在线 PDF（http/https），本地 `file://` 文件暂不支持；单个 PDF 最多处理前 200 页；加密 PDF 会提示错误。

### 🔊 朗读引擎（发音）

**默认 Edge TTS（微软神经语音，免费、无需 API key，发音最自然）。** 技术实现：插件在后台用 **Edge TTS REST 接口**合成音频——

1. **取令牌**：先向微软翻译端点 `dev.microsofttranslator.com/apps/endpoint` 发起 HMAC-SHA256 签名请求（`X-MT-Signature`），换取临时 JWT 令牌与就近区域（region），响应字段为 `t`（令牌）/ `r`（区域）。
2. **合成**：再向 `https://<region>.tts.speech.microsoft.com/cognitiveservices/v1` 发送 SSML（含音色、语速），指定输出格式 `audio-24khz-48kbitrate-mono-mp3`，返回 MP3 音频在卡片内播放。
3. **容错**：令牌缓存 10 分钟、提前 3 分钟自动刷新；遇到 401/403 清空令牌重取；任一步失败自动**回退到浏览器系统语音**（Web Speech），不影响使用。

- 默认美音 `en-US-AriaNeural`，英音 `en-GB-SoniaNeural`；单词、例句、长句均可朗读。
- 在选项页「语言」卡片下方可切换为 **浏览器语音**（Web Speech，本地合成，适合离线/隐私敏感场景）。

### 📺 YouTube 字幕提取（多路径降级，带诊断）

YouTube 字幕接口普遍要求 **PO Token（pot）签名**，无签名直连通常返回 403。插件按以下顺序尝试，直到拿到字幕：

1. **pot 优先通道（成功率最高，借鉴 read-frog）**：在页面内拦截播放器真实网络请求（XHR/fetch），捕获带 pot 签名的 `timedtext` 字幕 URL 直接使用；若拦截不到，则从播放器 `getAudioTrack().captionTracks` 提取 pot/potc 参数，**拼回 `captionTracks.baseUrl` 重建签名 URL**（补 `fmt=json3`、`xorb/xobt/xovt`、`c=WEB`、`cplayer=UNIPLAYER`、`device`、`cver`），再抓取——这是 read-frog 的成功关键，不是直接使用 audio 轨道 URL。
2. **页面 `ytInitialPlayerResponse`**：读取页面里现成的 captionTracks。
3. **页面 InnerTube `/player`**：调用页面内 YouTube 接口。
4. **后台无登录多客户端兜底**：用 ANDROID / IOS / TVHTML5 / WEB 多客户端伪装调用 `youtubei.googleapis.com`（部分客户端不强制 pot）。

- 每条通道失败都会在浮层显示**诊断信息**（如“播放器 tracks=1 audio=1 | 重建 pot URL 仍失败”），便于定位。
- 打开 YouTube 页控制台执行 `window.CC_DEBUG = true` 可看每一步详细日志。

## ❓ 为什么有效
- 先学再看：提前掌握词汇与表达，阅读/观看更顺畅。
- 强上下文：例句来自你要学的原文，记忆更牢固。
- 可持续：单词本集中沉淀，复习与迁移更高效。

## 🧾 规划与展望
- [x] 多来源内容捕获（YouTube 字幕 / 网页文章 / 划词 / 手动粘贴）
- [x] 在线 PDF 正文提取（pdf.js 本地解析 + Firecrawl 兜底）
- [x] 卡片朗读（Edge TTS 神经语音 + 浏览器语音双引擎，自动兜底）
- [x] 字幕提取失效自修复（多路径降级 + pot 优先通道）
- [x] 单词本按来源过滤
- [ ] 长文全量分块与候选合并
- [ ] 文件导入与备份
- [ ] 加入提示词自定义
- [ ] 优化单词卡片，提供单词的固定搭配

提示：API Key 与模型等设置在“选项页”中配置，并存储在本地。目前支持 OpenAI, Claude, Gemini 和 OpenAI Compatible 的供应商。

## ❤️ 致谢
如果不是这个项目，我将无法做到提取 youtube 字幕，感谢🙏

I wouldn’t have been able to extract YouTube subtitles without this project. Thank you 🙏

https://github.com/devhims/youtube-caption-extractor

字幕 pot 通道实现参考 read-frog（Edge TTS REST + timedtext 拦截）：https://github.com/read-frog/read-frog

## ☕️ 支持捕获生词

### 如果你喜欢捕获生词，欢迎请我喝杯咖啡～ ☕️ 🩵❤️🧡🩷💛💚

<table>
  <tr>
    <td align="center">
      <img src="https://github.com/user-attachments/assets/cb4fc3c9-ef68-4acb-8c32-232876364a62" alt="微信赞助" width="250" />
      <br><sub>WeChat / 微信</sub>
    </td>
    <td align="center">
      <img src="https://github.com/user-attachments/assets/e9111d96-3fa4-4b79-bcf0-0dfa6a67705f" alt="支付宝赞助" width="250" />
      <br><sub>Alipay / 支付宝</sub>
    </td>
  </tr>
</table>

## 特别致谢

本项目继承自 ：https://github.com/liangdabiao/SeekWord ，感谢作者,
本项目学习了：https://github.com/mengxi-ream/read-frog ，感谢作者,
特别感谢社区支持： https://linux.do 
