# 🖊️ WordCatcher 浏览器插件

> 需求文档 · 开发文档 · 技术文档 | Chromium (Chrome + Edge) Manifest V3 | 版本 1.0.0

---

## 📑 目录

- [一、需求文档 (PRD)](#一需求文档-prd)
- [二、用户故事](#二用户故事)
- [三、交互设计文档](#三交互设计文档)
- [四、技术架构](#四技术架构)
- [五、项目结构](#五项目结构)
- [六、数据模型](#六数据模型)
- [七、翻译 API 对接](#七翻译-api-对接方案)
- [八、核心实现方案](#八核心实现方案)
- [九、单词检测算法](#九单词检测算法)
- [十、弹窗 UI 方案](#十弹窗-ui-方案)
- [十一、单词本管理](#十一单词本管理-popup)
- [十二、Manifest 配置](#十二manifest-v3-配置)
- [十三、开发步骤 & 里程碑](#十三开发步骤--里程碑)
- [十四、测试方案](#十四测试方案)
- [十五、跨浏览器适配](#十五跨浏览器适配chrome--edge)
- [十六、常见问题 & 踩坑](#十六常见问题与踩坑指南)

---

## 一、需求文档 (PRD)

### 1.1 项目概述

**WordCatcher** 是一款 Chromium 浏览器（Chrome / Edge）扩展，帮助用户在浏览英文网页时**快速查词翻译并收集生词**。用户只需按住 `Ctrl` 键，鼠标悬停到任意英文单词上即可弹出翻译弹窗，一键收录到单词本——整个过程无需离开当前页面。

### 1.2 核心功能清单

| 编号 | 功能 | 优先级 | 描述 |
|------|------|--------|------|
| F1 | Ctrl 键查词模式 | 🔴 P0 | 用户按住 `Ctrl` 键时，鼠标光标变为 ✒️ 笔形；鼠标悬停在英文单词上 300ms 后弹出翻译弹窗。松开 Ctrl 键后恢复正常光标，弹窗消失。 |
| F2 | 单词翻译弹窗 | 🔴 P0 | 弹窗显示单词、音标、中文释义、例句（如有）。弹窗跟随鼠标位置，超出视口时自动调整位置。 |
| F3 | 一键添加到单词本 | 🔴 P0 | 弹窗底部有「添加到单词本」按钮，点击后将单词保存。弹出已保存的提示。 |
| F4 | 自动捕获句子来源 | 🔴 P0 | 添加单词时自动保存单词所在的完整句子，以及原始网页 URL（用于稍后回看上下文）。 |
| F5 | 单词本管理页面 | 🟠 P1 | 点击扩展图标打开单词本 Popup，支持查看、搜索、删除单词。展示每个单词的释义、来源句子和来源链接。 |
| F6 | 快捷键可配置 | 🔵 P2 | 用户可在扩展设置中将查词快捷键从 Ctrl 改为其他键（Alt / Shift / 组合键）。 |
| F7 | 导出单词本 | 🔵 P2 | 支持导出为 CSV / JSON 格式，方便在 Anki 等工具中使用。 |

### 1.3 非功能需求

| 类别 | 要求 |
|------|------|
| 性能 | 弹窗延迟 ≤ 400ms（含翻译 API 响应）；Content Script 不阻塞页面渲染 |
| 兼容性 | Chrome 88+ (Manifest V3)、Edge 88+；不支持 Firefox（需额外适配） |
| 离线 | 单词本数据离线可用（chrome.storage.local）；翻译需联网 |
| 隐私 | 不收集用户浏览数据；翻译请求仅发送单词本身，不发送上下文 |
| 体积 | 扩展打包 ≤ 5MB |

> 💡 **为什么不用划词翻译？**
> 划词翻译需要用户选中文字再操作，打断阅读流。Ctrl + 悬停方案**零击键、手不离键盘**，阅读外文时体验更流畅。

---

## 二、用户故事

### US-1 · 阅读中快速查词

作为一个英语学习者，我在阅读英文技术文档时，按住 Ctrl 键并把鼠标移到生词上，就能立即看到中文翻译，**不用离开页面、不用复制粘贴**。

**验收标准：**按住 Ctrl → 光标变笔形 → 悬停 300ms → 弹出翻译 → 松开 Ctrl → 弹窗消失。

### US-2 · 一键收录生词

当我看到一个想记住的单词时，点击弹窗里的「添加到单词本」按钮就能保存，**单词、释义、所在句子、页面链接全部自动记录**。

**验收标准：**点击按钮 → 提示「已添加」→ 在 Popup 中能看到刚添加的单词及来源。

### US-3 · 回顾单词本

每天阅读结束后，我打开单词本 Popup 回顾今天收集的词汇，可以点击来源链接回到原文复习上下文。

**验收标准：**Popup 中按时间倒序展示单词列表，点击来源链接能打开原文页面。

### US-4 · 搜索已保存的单词

单词本积累多了以后，我可以用搜索框快速找到某个单词，查看它的释义和来源。

**验收标准：**搜索框输入 → 实时过滤单词列表 → 大小写不敏感。

---

## 三、交互设计文档

### 3.1 主交互流程（时序图描述）

```
用户在任意网页浏览
       │
       ▼
按住 Ctrl 键 ──► 光标变为 ✒️ 笔形光标
       │
       ▼
鼠标移动到英文单词上方
       │
       ▼
悬停 300ms (防抖)
       │
       ├── 单词有效？ ──► 否 ──► 不做任何事
       │
       ▼ 是
调用翻译 API (含缓存)
       │
       ▼
弹出翻译弹窗 ──► 显示：单词、音标、释义、例句
       │
       ├── 用户点「添加到单词本」──► 保存单词+句子+URL ──► 提示「已添加 ✓」
       │
       ├── 用户移开鼠标 ──► 弹窗关闭
       │
       └── 用户松开 Ctrl ──► 弹窗关闭，光标恢复默认
```

### 3.2 弹窗 UI 规格

| 元素 | 说明 |
|------|------|
| 单词 | 粗体 18px，#c9d1d9，原单词保持大小写 |
| 音标 | 13px，#8b949e，IPA 格式（如 /ˈeksəmpəl/） |
| 词性 + 释义 | 14px，如 "n. 例子；实例" |
| 例句 | 13px 斜体，#8b949e，英文例句 + 中文翻译 |
| 「添加到单词本」按钮 | 圆角按钮，蓝色主色，12px 字号 |
| 关闭按钮 | 右上角 X 图标 |

### 3.3 弹窗定位规则

- 默认出现在鼠标光标右下方 (+12px, +12px)
- 右侧超出视口 → 翻转到光标左侧
- 底部超出视口 → 翻转到光标上方
- 弹窗 z-index: 2147483647 (最大层级，避免被页面元素遮挡)

### 3.4 光标样式

- 提供自定义笔形 SVG cursor（24×24 像素）
- 通过 CSS `cursor: url('pen.svg') 0 24, crosshair` 设置
- fallback 为 `crosshair` 确保在 cursor URL 加载失败时仍有视觉提示

---

## 四、技术架构

```
┌─────────────────────────────────────────────────────┐
│                     浏览器扩展                         │
│                                                       │
│  ┌──────────────┐  ┌──────────────┐  ┌─────────────┐ │
│  │ Content      │  │ Service      │  │ Popup       │ │
│  │ Script       │  │ Worker       │  │ (单词本)     │ │
│  │              │  │              │  │             │ │
│  │ · 键盘监听   │  │ · 翻译 API   │  │ · 单词列表  │ │
│  │ · 单词检测   │──│ · 数据管理   │──│ · 搜索/删除 │ │
│  │ · 弹窗渲染   │  │ · 消息中转   │  │ · 导出功能  │ │
│  │ · 句子提取   │  │              │  │             │ │
│  └──────────────┘  └──────────────┘  └─────────────┘ │
│         │                  │                 │         │
│         ▼                  ▼                 ▼         │
│  ┌──────────────────────────────────────────────────┐ │
│  │              chrome.storage.local                  │ │
│  │              · 单词本数据                           │ │
│  │              · 翻译缓存                             │ │
│  │              · 用户设置                             │ │
│  └──────────────────────────────────────────────────┘ │
│         │                                              │
└─────────┼──────────────────────────────────────────────┘
          │
          ▼
   ┌─────────────┐
   │  外部翻译 API │
   │  (有道 /     │
   │   Google /   │
   │   DeepL 等)  │
   └─────────────┘
```

### 架构决策记录 (ADR)

| 决策 | 选择 | 原因 |
|------|------|------|
| 后台脚本 | Service Worker (非持久化) | Manifest V3 强制要求；自动休眠节省资源 |
| 存储方案 | chrome.storage.local | 支持 10MB，离线可用，自动同步（storage.sync 仅 100KB 不够用） |
| 翻译接口 | 有道智云 API（免费额度 100 字符/次）+ 本地缓存 | 国内访问快，免费额度够用；缓存减少重复请求 |
| 弹窗实现 | Shadow DOM 隔离的独立 DOM 树 | 避免被页面 CSS 污染，弹窗样式绝对可控 |
| CSS cursor | cursor: url(data:image/svg+xml,...) | 不需要额外文件，base64 内联 SVG 避免跨域限制 |

> ⚠️ **Manifest V3 限制：**Service Worker 会在闲置 30 秒后被浏览器终止。所有 API 调用必须在 SW 内完成并通过 `chrome.runtime.sendMessage` 返回结果给 Content Script。翻译缓存用 `chrome.storage.local` 实现以跨越 SW 重启。

---

## 五、项目结构

```
word-catcher/
├── manifest.json          · 扩展清单 (MV3)
├── README.md
├── assets/
│   └── icons/               · 16×16, 48×48, 128×128 PNG
├── content/
│   ├── content-script.js    · 主控：键盘、鼠标、弹窗、句子提取
│   └── popup.css             · 弹窗样式（注入 Shadow DOM）
├── service/
│   └── service-worker.js    · 翻译 API 代理 & 数据 CRUD
├── popup/
│   ├── popup.html            · 单词本页面
│   ├── popup.js              · 列表渲染、搜索、删除、导出
│   └── popup.css             · Popup 样式
├── options/
│   ├── options.html          · 设置页面
│   └── options.js            · 快捷键定制、翻译源切换
├── lib/
│   ├── translator.js         · 翻译适配层（有道/Google/DeepL）
│   ├── storage.js            · chrome.storage 封装
│   └── cache.js              · LRU 翻译缓存 (≤ 200条)
└── tests/
    └── test-suite.md
```

**总共约 12 个文件**，纯 JavaScript + HTML + CSS，**零构建工具、零框架**——保持扩展体积最小化。

---

## 六、数据模型

### 6.1 单词条目 (WordEntry)

```json
{
  "id":          "172d8f3a-...",    // UUID v4, 唯一标识
  "word":        "ubiquitous",      // 原始单词
  "phonetic":    "/juːˈbɪkwɪtəs/",  // 音标 IPA
  "meaning":     "adj. 无处不在的",  // 释义
  "exampleEn":   "...",             // 英文例句 (从翻译 API 获取)
  "exampleZh":   "...",             // 中文例句翻译
  "sentence":    "Cloud computing has become ubiquitous in modern...",
                                    // 用户看到的原文句子 (从网页提取)
  "sourceUrl":   "https://...",     // 来源网页 URL
  "sourceTitle": "Cloud Computing - Wikipedia",  // 来源网页标题
  "tags":        ["tech", "ielts"], // 用户标签 (P2 功能)
  "createdAt":   1716825600000,     // Unix timestamp ms
  "reviewCount": 0                  // 复习次数 (P2)
}
```

### 6.2 Storage 结构

```javascript
// chrome.storage.local 中的 key-value 布局:
{
  "words":      [...WordEntry],          // 单词本主列表
  "cache":      { word: {meaning, phonetic, exampleEn, exampleZh, ts} },
                                         // 翻译缓存 (≤ 200条, LRU)
  "settings":   {
    "lookupKey":        "Control",       // 查词快捷键，默认 'Control'
    "hoverDelay":       300,             // 悬停触发延迟 (ms)
    "translator":       "youdao",        // 'youdao' | 'google' | 'deepl'
    "autoSpeak":        false,           // 是否自动发音
    "maxCacheSize":     200              // 缓存上限
  }
}
```

### 6.3 消息格式（Content Script ↔ Service Worker）

```javascript
// Content Script → Service Worker：请求翻译
{ type: 'TRANSLATE', word: 'ubiquitous' }

// Service Worker → Content Script：返回翻译结果
{ type: 'TRANSLATE_RESULT', word: 'ubiquitous', meaning: '...', phonetic: '...', ... }

// Content Script → Service Worker：保存单词
{ type: 'SAVE_WORD', entry: {...WordEntry} }

// Service Worker → Content Script：确认保存
{ type: 'SAVE_RESULT', success: true }

// 任何组件 → Service Worker：获取单词列表
{ type: 'GET_WORDS', query: 'ubi' }   // query 可选，空则返回全部

// Service Worker → 请求方：返回列表
{ type: 'WORDS_LIST', words: [...WordEntry] }
```

---

## 七、翻译 API 对接方案

### 7.1 推荐：有道智云文本翻译 API

| 项目 | 详情 |
|------|------|
| 接口地址 | `https://openapi.youdao.com/api` |
| 认证方式 | 应用 ID + 密钥，SHA256 签名 |
| 免费额度 | 新用户 100 元体验金，约 200 万字符 |
| 返回格式 | JSON，含基本释义、音标、例句（需开启词典服务） |
| 文档 | [有道智云文本翻译 API 文档](https://ai.youdao.com/DOCSIRMA/html/trans/api/wbfy/index.html) |

### 7.2 请求示例（有道）

```http
// POST https://openapi.youdao.com/api
// Content-Type: application/x-www-form-urlencoded

q=ubiquitous
from=en
to=zh-CHS
appKey=YOUR_APP_KEY
salt=1716825600
sign=SHA256(appKey + word + salt + appSecret)

// 返回:
{
  "query": "ubiquitous",
  "translation": ["无处不在的"],
  "basic": {
    "phonetic": "juːˈbɪkwɪtəs",
    "explains": ["adj. 无处不在的", "adj. 普遍存在的"]
  },
  "web": [
    { "key": "ubiquitous", "value": ["无处不在的", "无所不在的"] }
  ]
}
```

### 7.3 备选方案

| API | 优势 | 劣势 | 免费额度 |
|-----|------|------|----------|
| 有道智云 | 国内快、中文释义准确、有音标 | 需注册实名认证 | ≈200 万字符 |
| Google Cloud Translation | 质量高、语言覆盖广 | 需外币信用卡、国内直连不稳定 | 50 万字符/月 |
| DeepL API | 翻译质量最优 | 免费版仅 web，API 付费 | 无 (API 月费 ¥30+) |
| Microsoft Translator | Azure 生态、稳定 | 注册流程繁琐 | 200 万字符/月 |

### 7.4 缓存策略

- 翻译结果写入 `chrome.storage.local`，key 为 `cache.{word}`
- 每条缓存带时间戳，超过 **7 天**自动淘汰
- 缓存条目上限 **200 条**，超出时淘汰最旧的 20%
- 同一次浏览会话中查过的词**不再发起网络请求**

---

## 八、核心实现方案

### 8.1 Content Script 核心逻辑（content-script.js）

下面的伪代码描述了主流程。Trae 可以照着这个骨架展开实现。

```javascript
// ============ content-script.js ============

// ── 状态机 ──
const STATE = {
  IDLE:     'idle',      // 默认
  PEN:      'pen',       // Ctrl 按下，等待单词
  LOADING:  'loading',   // 单词已检测，等待翻译
  SHOWING:  'showing',   // 弹窗展示中
};
let currentState = STATE.IDLE;
let hoverTimer = null;

// ── 键盘事件 ──
document.addEventListener('keydown', (e) => {
  if (e.key === 'Control' && currentState === STATE.IDLE) {
    enterPenMode();
  }
});
document.addEventListener('keyup', (e) => {
  if (e.key === 'Control') {
    exitPenMode();
  }
});

function enterPenMode() {
  currentState = STATE.PEN;
  setCursor('pen');  // cursor: url(data:image/svg+xml,...), crosshair
  // 用 CSS :root 设置全局 cursor，覆盖所有子元素
}

// ── 鼠标移动 + 单词检测 ──
document.addEventListener('mousemove', (e) => {
  if (currentState !== STATE.PEN) return;

  // 防抖 300ms
  clearTimeout(hoverTimer);
  hoverTimer = setTimeout(() => {
    const word = detectWordAtPoint(e.clientX, e.clientY);
    if (word) {
      currentState = STATE.LOADING;
      showPopup(e.clientX, e.clientY, '...'); // 先显示 loading
      requestTranslation(word).then(result => {
        updatePopup(result);
        currentState = STATE.SHOWING;
      });
    }
  }, SETTINGS.hoverDelay);
});

// ── 弹窗渲染 (Shadow DOM) ──
function showPopup(x, y, data) { /* ... 见第十节 */ }

// ── 添加到单词本 ──
function addToWordbook(wordData) {
  const sentence = extractSentence(wordData.word);  // 见 8.2
  const entry = {
    id: crypto.randomUUID(),
    word: wordData.word,
    phonetic: wordData.phonetic,
    meaning: wordData.meaning,
    exampleEn: wordData.exampleEn,
    exampleZh: wordData.exampleZh,
    sentence: sentence,
    sourceUrl: location.href,
    sourceTitle: document.title,
    createdAt: Date.now(),
    reviewCount: 0,
  };
  chrome.runtime.sendMessage({ type: 'SAVE_WORD', entry }, (res) => {
    if (res.success) showSavedIndicator();
  });
}
```

### 8.2 句子提取算法

```javascript
function extractSentence(word) {
  // 1. 通过 selection / range API 获取单词所在文本节点
  const range = getWordRange(word); // 配合 detectWordAtPoint 使用

  // 2. 向左右扩展直到遇到句子边界 (. ! ? ; 换行)
  const SENTENCE_BOUNDARY = /[.!?;\n\r]/;
  let text = range.startContainer.textContent;
  let start = range.startOffset;
  let end = range.endOffset;

  // 向左找句首
  while (start > 0 && !SENTENCE_BOUNDARY.test(text[start-1])) start--;
  // 向右找句尾
  while (end < text.length && !SENTENCE_BOUNDARY.test(text[end])) end++;

  // 3. 提取并清理
  return text.slice(start, end).trim().replace(/\s+/g, ' ');
}
```

### 8.3 Service Worker 核心逻辑（service-worker.js）

```javascript
// ============ service-worker.js ============

const TRANSLATOR_ENDPOINT = 'https://openapi.youdao.com/api';

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  switch (msg.type) {
    case 'TRANSLATE':
      translateWithCache(msg.word).then(sendResponse);
      return true; // 异步响应

    case 'SAVE_WORD':
      saveWord(msg.entry).then(() => sendResponse({ success: true }));
      return true;

    case 'DELETE_WORD':
      deleteWord(msg.id).then(() => sendResponse({ success: true }));
      return true;

    case 'GET_WORDS':
      getWords(msg.query).then(words => sendResponse({ words }));
      return true;

    case 'EXPORT_WORDS':
      exportWords(msg.format).then(data => sendResponse({ data }));
      return true;
  }
});

async function translateWithCache(word) {
  // 1. 查缓存
  const cached = await getCache(word);
  if (cached) return cached;

  // 2. 调 API
  const result = await callYoudaoAPI(word);

  // 3. 写入缓存
  await setCache(word, result);
  return result;
}

async function callYoudaoAPI(word) {
  const salt = Date.now().toString();
  const sign = sha256(YOUDAO_APP_KEY + word + salt + YOUDAO_SECRET);

  const formData = new URLSearchParams({
    q: word, from: 'en', to: 'zh-CHS',
    appKey: YOUDAO_APP_KEY, salt, sign,
  });

  const res = await fetch(TRANSLATOR_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: formData,
  });
  const json = await res.json();

  return {
    word:      json.query,
    meaning:   json.translation?.join('；') || '',
    phonetic:  json.basic?.phonetic || '',
    exampleEn: json.web?.[0]?.key || '',
    exampleZh: json.web?.[0]?.value?.join('；') || '',
  };
}
```

---

## 九、单词检测算法

### 9.1 核心思路

利用浏览器的 `document.caretPositionFromPoint(x, y)` 或 `document.elementFromPoint(x, y)` 定位鼠标下方的文本节点，然后以鼠标位置为中心向左右扩展，找到完整的英文单词边界。

### 9.2 完整实现

```javascript
function detectWordAtPoint(x, y) {
  // Firefox → caretPositionFromPoint; Chromium → caretRangeFromPoint
  const caretFn = document.caretPositionFromPoint || document.caretRangeFromPoint;
  if (!caretFn) return null;

  const caret = caretFn(x, y);
  if (!caret) return null;

  // 获取文本节点和偏移
  const node = caret.offsetNode || caret.startContainer;
  const offset = caret.offset || caret.startOffset;
  if (!node || node.nodeType !== Node.TEXT_NODE) return null;

  const text = node.textContent;

  // 单词边界：[a-zA-Z'-]+  允许连字符和撇号
  const WORD_PATTERN = /[a-zA-Z'-]+/g;

  let match;
  while ((match = WORD_PATTERN.exec(text)) !== null) {
    // 找到包含 offset 的那个匹配
    if (match.index <= offset && match.index + match[0].length >= offset) {
      const word = match[0];
      // 过滤太短或明显的噪声
      if (word.length < 2) return null;
      if (word.length > 45) return null; // 化学式/长串过滤
      // 过滤全大写缩写和非单词（可选）
      if (/^[A-Z'-]+$/.test(word) && word.length <= 3) return null; // 缩写
      return word;
    }
  }
  return null;
}
```

### 9.3 边缘情况处理

| 场景 | 处理 |
|------|------|
| 链接内的单词 (`<a>`) | 正常检测，不特殊处理 |
| 输入框、textarea | 跳过，不在输入区域触发查词 |
| 代码块、pre | 可检测，但建议通过 CSS 类名排除常见代码高亮区域 |
| 非文本元素（图片、SVG） | elementFromPoint 返回非文本节点时跳过 |
| Shadow DOM 内部 | elementFromPoint 可穿透 Light DOM；封闭 Shadow DOM 不可达 |

---

## 十、弹窗 UI 方案

### 10.1 为什么用 Shadow DOM

直接在页面 DOM 中插入弹窗会被**页面自身的 CSS 污染**（font-size、color 等全局样式），导致弹窗显示异常。使用 **Shadow DOM** 创建隔离的样式沙箱，弹窗外观在任何网页上都保持一致。

### 10.2 弹窗 HTML 结构

```html
<!-- 弹窗宿主容器，直接插入到 document.body -->
<div id="word-catcher-popup-host"></div>

<!-- Shadow DOM 内部结构 -->
<div class="popup-container">
  <div class="popup-header">
    <span class="popup-word">ubiquitous</span>
    <button class="popup-close">×</button>
  </div>
  <div class="popup-phonetic">/juːˈbɪkwɪtəs/</div>
  <div class="popup-meaning">adj. 无处不在的；普遍存在的</div>
  <div class="popup-example">
    <p>"Cloud computing has become ubiquitous in modern society."</p>
    <p>云计算在现代社会中已无处不在。</p>
  </div>
  <div class="popup-actions">
    <button class="btn-save">📖 添加到单词本</button>
  </div>
</div>
```

### 10.3 弹窗 CSS（Shadow DOM 内，隔离于页面）

```css
/* Shadow DOM 内部的 CSS — 完全不会被页面样式影响 */
:host { all: initial; }
.popup-container {
  position: fixed;
  width: 300px;
  background: #1e1e2e;
  border: 1px solid #45475a;
  border-radius: 8px;
  padding: 14px;
  color: #cdd6f4;
  font-family: -apple-system, BlinkMacSystemFont, sans-serif;
  font-size: 14px;
  line-height: 1.5;
  box-shadow: 0 8px 32px rgba(0,0,0,.5);
  z-index: 2147483647;
}
.popup-word { font-size: 18px; font-weight: 700; }
.popup-phonetic { font-size: 13px; color: #a6adc8; margin: 4px 0; }
.popup-meaning { margin: 8px 0; }
.popup-example {
  font-size: 13px; font-style: italic; color: #a6adc8;
  border-left: 2px solid #45475a; padding-left: 10px; margin: 8px 0;
}
.btn-save {
  width: 100%; padding: 8px;
  background: #89b4fa; color: #1e1e2e;
  border: none; border-radius: 6px;
  font-weight: 600; cursor: pointer;
}
.btn-save:hover { background: #74c7ec; }
.popup-close {
  background: none; border: none; color: #a6adc8;
  font-size: 18px; cursor: pointer;
}
```

### 10.4 弹窗渲染函数

```javascript
let popupHost = null;
let popupShadow = null;

function createPopupHost() {
  popupHost = document.createElement('div');
  popupHost.id = 'word-catcher-popup-host';
  document.body.appendChild(popupHost);
  popupShadow = popupHost.attachShadow({ mode: 'closed' });

  const style = document.createElement('style');
  style.textContent = POPUP_CSS; // 上面的 CSS 字符串
  popupShadow.appendChild(style);
}

function showPopup(x, y, data) {
  if (!popupHost) createPopupHost();

  // 清空旧内容
  while (popupShadow.firstChild) popupShadow.removeChild(popupShadow.firstChild);
  // 重新添加样式
  const style = document.createElement('style');
  style.textContent = POPUP_CSS;
  popupShadow.appendChild(style);

  // 构建弹窗 DOM
  const container = document.createElement('div');
  container.className = 'popup-container';
  container.innerHTML = `...`; // 见 10.2

  // 绑定事件
  container.querySelector('.btn-save').onclick = () => addToWordbook(data);
  container.querySelector('.popup-close').onclick = hidePopup;

  popupShadow.appendChild(container);

  // 定位
  positionPopup(container, x, y);
}

function positionPopup(el, mouseX, mouseY) {
  const w = 300, h = el.offsetHeight;
  const vw = window.innerWidth, vh = window.innerHeight;

  let left = mouseX + 12;
  let top = mouseY + 12;

  if (left + w > vw) left = mouseX - w - 12;  // 翻转到左侧
  if (top + h > vh) top = mouseY - h - 12;    // 翻转到上方

  el.style.left = Math.max(0, left) + 'px';
  el.style.top = Math.max(0, top) + 'px';
}
```

---

## 十一、单词本管理 (Popup)

### 11.1 Popup 页面设计

- 宽度 380px，高度自适应（最大 600px）
- 顶部搜索框 + 导出按钮
- 单词列表卡片，每张卡片包含：单词、释义、来源句子摘要（截断 80 字符）、来源链接
- 点击来源链接 → `chrome.tabs.create({ url })` 新建标签页打开
- 每个卡片右侧有删除按钮
- 列表按时间倒序排列

### 11.2 Popup JS 核心骨架

```javascript
// ============ popup.js ============

document.addEventListener('DOMContentLoaded', loadWords);

async function loadWords(query = '') {
  const { words } = await chrome.runtime.sendMessage({
    type: 'GET_WORDS', query
  });
  renderList(words);
}

function renderList(words) {
  const container = document.getElementById('word-list');
  container.innerHTML = words.length === 0
    ? '<div class="empty">还没有保存任何单词</div>'
    : words.map(w => `
      <div class="word-card">
        <div class="word-card-header">
          <strong>${escapeHtml(w.word)}</strong>
          <span class="phonetic">${escapeHtml(w.phonetic || '')}</span>
          <button class="btn-delete" data-id="${w.id}">🗑️</button>
        </div>
        <div class="meaning">${escapeHtml(w.meaning)}</div>
        <div class="sentence">
          📖 ${escapeHtml(truncate(w.sentence, 80))}
        </div>
        <a class="source-link" href="${escapeHtml(w.sourceUrl)}" target="_blank">
          🔗 ${escapeHtml(truncate(w.sourceTitle, 50))}
        </a>
      </div>
    `).join('');

  // 绑定删除事件
  container.querySelectorAll('.btn-delete').forEach(btn => {
    btn.addEventListener('click', async () => {
      await chrome.runtime.sendMessage({
        type: 'DELETE_WORD', id: btn.dataset.id
      });
      loadWords(searchInput.value);
    });
  });
}
```

---

## 十二、Manifest V3 配置

```json
{
  "manifest_version": 3,
  "name": "WordCatcher",
  "version": "1.0.0",
  "description": "按住 Ctrl 悬停查词，一键收录到单词本",
  "author": "your-name@email.com",

  "icons": {
    "16":  "assets/icons/icon16.png",
    "48":  "assets/icons/icon48.png",
    "128": "assets/icons/icon128.png"
  },

  "permissions": [
    "storage"
  ],

  "host_permissions": [
    "https://openapi.youdao.com/*"
  ],

  "background": {
    "service_worker": "service/service-worker.js",
    "type": "module"
  },

  "content_scripts": [
    {
      "matches": ["<all_urls>"],
      "js": ["content/content-script.js"],
      "run_at": "document_idle",
      "all_frames": false
    }
  ],

  "action": {
    "default_popup": "popup/popup.html",
    "default_title": "WordCatcher - 单词本",
    "default_icon": {
      "16": "assets/icons/icon16.png",
      "48": "assets/icons/icon48.png"
    }
  },

  "options_page": "options/options.html",

  "commands": {
    "_execute_action": {
      "suggested_key": { "default": "Ctrl+Shift+W" }
    }
  }
}
```

> ⚠️ **manifest.json 关键说明：**
> - `host_permissions` 仅声明翻译 API 域名，最小权限原则
> - `content_scripts.matches: <all_urls>` 是必需的，因为用户可能在任何网页查词
> - `type: "module"` 允许 Service Worker 使用 ES modules
> - `run_at: "document_idle"` 确保 DOM 加载完毕后再注入

---

## 十三、开发步骤 & 里程碑

| 阶段 | 任务 | 预估工时 | 产出 |
|------|------|----------|------|
| **M1: 骨架搭建** 🔴 1 天 | | | |
| 1.1 | 初始化项目目录，创建 manifest.json | 0.5h | 扩展可加载到浏览器 |
| 1.2 | Content Script 注入验证（console.log 确认运行） | 0.5h | 任意网页 F12 可见日志 |
| 1.3 | Service Worker 注册 + chrome.runtime 消息通信验证 | 1h | CS ↔ SW 消息正常发送/接收 |
| 1.4 | Popup 页面骨架 HTML + 加载空列表 | 1h | 点击图标显示 Popup |
| **M2: 核心查词** 🔴 2 天 | | | |
| 2.1 | 键盘监听：Ctrl 键按下/松开，光标切换 | 2h | Ctrl 按下时十字准星光标 |
| 2.2 | 单词检测算法（caretPositionFromPoint） | 3h | 悬停英文单词时 console 输出单词 |
| 2.3 | 翻译 API 对接（有道）+ 签名计算 | 3h | SW 中成功获取翻译结果 |
| 2.4 | Shadow DOM 弹窗渲染 + 定位 | 4h | 弹窗正确显示翻译内容 |
| 2.5 | 弹窗「添加到单词本」按钮功能 | 2h | 单词成功存入 storage |
| **M3: 句子提取 + 单词本** 🔴 1.5 天 | | | |
| 3.1 | 句子提取算法（从单词所在文本节点向左右扩展） | 3h | 保存单词时附带句子 |
| 3.2 | Popup 单词列表渲染 + 搜索功能 | 3h | 按时间排序、可搜索 |
| 3.3 | 删除单词功能 | 1h | 卡片右侧删除按钮可用 |
| 3.4 | 翻译缓存实现 | 2h | 重复查词无网络请求 |
| **M4: 打磨 & 测试** 🟠 1 天 | | | |
| 4.1 | 弹窗定位边缘情况（视口边界、缩放） | 2h | 所有位置弹窗不超出屏幕 |
| 4.2 | 光标 SVG 设计 + 内联 base64 | 1h | 笔形光标美观自然 |
| 4.3 | 多网页测试（维基、Medium、技术博客） | 2h | 常见网站正常使用 |
| 4.4 | 导出功能（CSV）+ 设置页面 | 3h | 可导出单词本 |
| | **总计** | | **约 5.5 个工作日** |

---

## 十四、测试方案

### 14.1 功能测试用例

| # | 测试场景 | 预期结果 |
|---|----------|----------|
| T1 | 按下 Ctrl，光标变化 | 光标变为笔形 |
| T2 | 松开 Ctrl | 光标恢复默认，弹窗消失 |
| T3 | Ctrl + 悬停英文单词 300ms | 弹出翻译弹窗，显示单词+释义 |
| T4 | 悬停在非英文（中文/数字）上 | 不弹窗 |
| T5 | 点击「添加到单词本」 | 提示已添加，Popup 可见新单词 |
| T6 | 同一个单词再次添加 | 不重复添加，提示「单词已存在」 |
| T7 | 打开 Popup，查看单词本 | 列表含单词、释义、句子、链接 |
| T8 | 在 Popup 搜索框输入部分单词 | 列表实时过滤 |
| T9 | 点击来源链接 | 新标签页打开原始网页 |
| T10 | 删除一个单词 | 从列表消失，storage 中移除 |
| T11 | 弹窗出现在视口右下角 → 翻转 | 弹窗不超出屏幕边界 |
| T12 | 在不同网站测试（Wiki, Medium, GitHub, Reddit） | 单词检测、弹窗样式均正常 |

### 14.2 性能测试

- 单词检测 < 5ms（纯 DOM 操作，不阻塞）
- 弹窗显示（含翻译 API）< 400ms
- 缓存命中时弹窗显示 < 50ms
- Content Script 内存占用 < 5MB

### 14.3 兼容性测试矩阵

| 浏览器 | 版本 | OS | 状态 |
|--------|------|----|------|
| Chrome | 88+ | Windows / macOS / Linux | 主要支持 |
| Edge | 88+ | Windows / macOS | 主要支持 |
| Brave / Opera / Vivaldi | Chromium 88+ | — | 理论兼容 |
| Firefox | — | — | 不支持（需单独适配 MV2） |

---

## 十五、跨浏览器适配（Chrome → Edge）

WordCatcher 基于 Manifest V3 和标准 WebExtension API 开发，**在 Chrome 和 Edge 之间无需任何代码修改**即可运行。两个浏览器共享 Chromium 内核。

### 发布流程

| 步骤 | Chrome Web Store | Edge Add-ons |
|------|-------------------|--------------|
| 1 | 打包 .zip（含 manifest.json + 所有源文件） | 同上 |
| 2 | 注册 [Chrome 开发者控制台](https://chrome.google.com/webstore/devconsole) | 注册 [Edge Partner Center](https://partner.microsoft.com/en-us/dashboard/microsoftedge) |
| 3 | 一次性注册费 $5 USD | 免费 |
| 4 | 上传 .zip，填写描述、截图 | 同上 |
| 5 | 审核 1-3 个工作日 | 审核 1-2 个工作日 |

> 💡 **开发阶段加载方式：**
> Chrome: `chrome://extensions` → 开启「开发者模式」→「加载已解压的扩展」→ 选择项目目录
> Edge: `edge://extensions` → 同上流程

---

## 十六、常见问题与踩坑指南

### ❌ 问题 1：弹窗被页面 CSS 污染

**现象：**弹窗字体忽大忽小、颜色异常、背景被覆盖了奇怪的渐变。

**根因：**页面 CSS 的全局选择器（如 `body * { font-size: 20px }`）影响弹窗。

**解决：**使用 Shadow DOM 隔离。Shadow DOM 内部样式绝对不受外部 CSS 影响。

### ❌ 问题 2：无法在 iframe 内查词

**现象：**在嵌套 iframe 的页面中（如 CodePen、JSFiddle 的预览区），Ctrl 悬停无效。

**根因：**manifest.json 中 `all_frames: false`，Content Script 仅注入顶层页面。

**解决：**改为 `all_frames: true`，但需注意每个 frame 都会创建独立的弹窗宿主。

### ❌ 问题 3：Service Worker 闲置后被终止

**现象：**打开浏览器一段时间后，翻译请求无响应。

**根因：**Manifest V3 的 Service Worker 闲置 30 秒后自动休眠。

**解决：**（1）翻译结果缓存到 storage，即使 SW 重启也可直接用缓存；（2）chrome.runtime.sendMessage 会自动唤醒 SW，无需额外处理。

### ❌ 问题 4：Google Docs / Office 365 无法查词

**现象：**在 Google Docs 中查词完全无效。

**根因：**这类网站使用 Canvas 渲染文本或自定义富文本编辑器，内部无常规 DOM 文本节点。

**解决：**无法根本解决——Canvas 渲染的文本不可检测。建议在文档中标注已知不兼容网站。

### ❌ 问题 5：光标 SVG 不生效

**现象：**按 Ctrl 后光标还是默认箭头。

**根因：**页面元素的 `cursor` CSS 覆盖了全局设置（如 `a { cursor: pointer }`）。

**解决：**给 `<html>` 元素设置 `cursor: url(...) !important` 确保最高优先级。

---

*WordCatcher 浏览器插件开发文档 · 版本 1.0 · 生成于 2026-05-27*

*文档风格参考 GitHub Dark Theme · 可直接交付 Trae / Cursor / Windsurf / Copilot 等 AI IDE 执行*
