(() => {
  const STATE = {
    IDLE: "idle",
    PEN: "pen",
    LOADING: "loading",
    SHOWING: "showing"
  };

  const DEFAULT_SETTINGS = {
    lookupKey: "Control",
    hoverDelay: 100,
    autoSpeak: false
  };

  const WORD_PATTERN = /[A-Za-z][A-Za-z'-]{1,44}/g;
  const EXCLUDED_SELECTOR = "input, textarea, [contenteditable='true'], [contenteditable=''], pre, code";
  const CURSOR_STYLE_ID = "word-catcher-cursor-style";
  const POPUP_WIDTH = 320;
  const PEN_CURSOR_DATA_URL =
    "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='24' height='24' viewBox='0 0 24 24'%3E%3Cg fill='none' fill-rule='evenodd'%3E%3Cpath fill='%234472C4' d='M19.73 5.33a2 2 0 0 0-2.83 0l-1.42 1.42 4.24 4.24 1.42-1.42a2 2 0 0 0 0-2.83l-1.41-1.41Z'/%3E%3Cpath fill='%23FFFFFF' d='m14.07 8.1 4.24 4.24-8.84 8.84-4.98 1.13 1.13-4.98 8.45-8.45Z'/%3E%3Cpath fill='%231F2A44' d='m6.54 17.99 1.47-1.47 1.94 1.94-1.48 1.47-1.93.44.44-1.93Z'/%3E%3C/g%3E%3C/svg%3E";

  let currentState = STATE.IDLE;
  let settings = { ...DEFAULT_SETTINGS };
  let hoverTimer = null;
  let keydownPopupTimer = null;
  let popupHost = null;
  let popupShadow = null;
  let popupContainer = null;
  let toastHost = null;
  let toastShadow = null;
  let toastTimer = null;
  let toastNode = null;
  let activeAnchor = { x: 0, y: 0 };
  let currentLookup = null;
  let latestRequestToken = 0;
  let lookupKeyPressed = false;
  let isUpdatingPopup = false;
  let pendingPopupFocus = false;

  const KEYDOWN_POPUP_DELAY_MS = 100;

  initialize();

  async function initialize() {
    await loadSettings();
    bindEvents();
  }

  async function loadSettings() {
    try {
      const response = await sendMessage({ type: "GET_SETTINGS" });
      settings = {
        ...DEFAULT_SETTINGS,
        ...(response.settings || {})
      };
    } catch (_error) {
      settings = { ...DEFAULT_SETTINGS };
    }
  }

  function bindEvents() {
    document.addEventListener("keydown", handleKeyDown, true);
    document.addEventListener("keyup", handleKeyUp, true);
    document.addEventListener("mousemove", handleMouseMove, true);
    document.addEventListener("scroll", handleViewportChange, true);
    document.addEventListener("wheel", handleWheelWhilePinned, { capture: true, passive: true });
    document.addEventListener("focusin", handleFocusInWhilePinned, true);
    window.addEventListener("blur", exitPenMode, true);
    window.addEventListener("resize", handleViewportChange, true);
    chrome.storage.onChanged.addListener(handleStorageChange);
    document.addEventListener("visibilitychange", () => {
      if (document.hidden) {
        exitPenMode();
      }
    });
  }

  function handleStorageChange(changes, areaName) {
    if (areaName !== "local" || !changes.settings?.newValue) {
      return;
    }

    settings = {
      ...DEFAULT_SETTINGS,
      ...changes.settings.newValue
    };
    exitPenMode();
  }

  function handleKeyDown(event) {
    if (event.key === "Escape" && popupContainer) {
      event.preventDefault();
      event.stopPropagation();
      closePopupAndReset();
      return;
    }

    if (event.repeat) {
      return;
    }

    if (isLookupKeyEvent(event)) {
      if (isPopupPinned() && currentLookup) {
        event.preventDefault();
        event.stopPropagation();
        const lookup = currentLookup;
        void saveLookupWordWithFeedback(lookup);
        return;
      }

      // 如果有固定的弹窗但没有有效 lookup，直接重置
      if (isPopupPinned()) {
        closePopupAndReset();
        return;
      }

      lookupKeyPressed = true;
      if (currentState === STATE.IDLE) {
        enterPenMode();
      }
      scheduleInitialLookupAfterKeydown();
    }
  }

  function handleKeyUp(event) {
    if (!isLookupKeyEvent(event)) {
      return;
    }

    if (isLookupModifierStillHeld(event)) {
      return;
    }

    lookupKeyPressed = false;
    leavePenMode({ preservePopup: Boolean(popupContainer) });
  }

  function isLookupModifierStillHeld(event) {
    if (settings.lookupKey === "Control") {
      return event.getModifierState("Control") || event.getModifierState("Meta");
    }

    return event.getModifierState(settings.lookupKey);
  }

  function isLookupKeyEvent(event) {
    if (!event) {
      return false;
    }

    if (settings.lookupKey === "Control") {
      return event.key === "Control" || event.key === "Meta";
    }

    return event.key === settings.lookupKey;
  }

  function enterPenMode() {
    currentState = currentState === STATE.SHOWING || currentState === STATE.LOADING ? currentState : STATE.PEN;
    applyCursor();
  }

  function leavePenMode({ preservePopup = false } = {}) {
    clearHoverTimer();
    clearKeydownPopupTimer();
    removeCursor();
    if (preservePopup && popupContainer?.isConnected) {
      currentState = currentState === STATE.LOADING ? STATE.LOADING : STATE.SHOWING;
      positionPopup(popupContainer, activeAnchor.x, activeAnchor.y);
      requestAnimationFrame(() => {
        if (popupContainer?.isConnected) {
          positionPopup(popupContainer, activeAnchor.x, activeAnchor.y);
          if (currentState === STATE.LOADING) {
            pendingPopupFocus = true;
            return;
          }
          pendingPopupFocus = false;
          focusPopup();
        }
      });
      return;
    }
    closePopupAndReset();
  }

  function exitPenMode() {
    lookupKeyPressed = false;
    closePopupAndReset();
  }

  function closePopupAndReset() {
    clearHoverTimer();
    clearKeydownPopupTimer();
    latestRequestToken += 1;
    lookupKeyPressed = false;
    pendingPopupFocus = false;
    hidePopup();
    currentLookup = null;
    currentState = STATE.IDLE;
    removeCursor();
  }

  function scheduleInitialLookupAfterKeydown() {
    clearKeydownPopupTimer();
    keydownPopupTimer = window.setTimeout(() => {
      keydownPopupTimer = null;
      if (!lookupKeyPressed) {
        return;
      }
      if (popupContainer?.isConnected) {
        return;
      }
      if (currentState !== STATE.PEN && currentState !== STATE.IDLE) {
        return;
      }
      void lookupAtPoint(activeAnchor.x, activeAnchor.y);
    }, KEYDOWN_POPUP_DELAY_MS);
  }

  function clearKeydownPopupTimer() {
    if (keydownPopupTimer) {
      clearTimeout(keydownPopupTimer);
      keydownPopupTimer = null;
    }
  }

  function isPopupPinned() {
    return Boolean(
      popupContainer
      && !lookupKeyPressed
      && (currentState === STATE.SHOWING || currentState === STATE.LOADING)
    );
  }

  function isFocusInsidePopup() {
    const activeElement = popupShadow?.activeElement;
    return Boolean(activeElement && popupContainer?.contains(activeElement));
  }

  function handleViewportChange() {
    if (!popupContainer || isPopupPinned()) {
      return;
    }

    positionPopup(popupContainer, activeAnchor.x, activeAnchor.y);
  }

  function handleWheelWhilePinned() {
    if (!isPopupPinned()) {
      return;
    }

    requestAnimationFrame(() => {
      focusPopup();
    });
  }

  function handleFocusInWhilePinned(event) {
    if (!isPopupPinned()) {
      return;
    }

    const path = typeof event.composedPath === "function" ? event.composedPath() : [];
    if (path.includes(popupHost) || path.includes(popupContainer)) {
      return;
    }

    closePopupAndReset();
  }

  function handleMouseMove(event) {
    activeAnchor = { x: event.clientX, y: event.clientY };

    if (!lookupKeyPressed) {
      return;
    }

    if (currentState !== STATE.PEN && currentState !== STATE.SHOWING && currentState !== STATE.LOADING) {
      return;
    }

    clearHoverTimer();

    const delay = Math.max(0, Number(settings.hoverDelay) || DEFAULT_SETTINGS.hoverDelay);
    hoverTimer = window.setTimeout(() => {
      void lookupAtPoint(event.clientX, event.clientY);
    }, delay);
  }

  async function lookupAtPoint(x, y) {
    const detection = detectWordAtPoint(x, y);
    if (!detection) {
      if (lookupKeyPressed && currentState !== STATE.LOADING) {
        hidePopup();
        currentState = STATE.PEN;
        currentLookup = null;
      }
      return;
    }

    const signature = `${detection.word.toLowerCase()}|${detection.start}|${detection.end}|${detection.text}`;
    if (currentLookup?.signature === signature && (currentState === STATE.LOADING || currentState === STATE.SHOWING)) {
      positionPopup(popupContainer, x, y);
      return;
    }

    currentLookup = {
      ...detection,
      signature
    };
    currentState = STATE.LOADING;
    showPopup(x, y, buildLoadingData(detection.word));

    const requestToken = ++latestRequestToken;

    try {
      const response = await sendMessage({
        type: "TRANSLATE",
        word: detection.word
      });

      if (requestToken !== latestRequestToken || currentLookup?.signature !== signature) {
        return;
      }

      const translation = response.translation || buildLoadingData(detection.word);
      currentLookup.translation = translation;
      updatePopup({
        ...translation,
        sentence: extractSentenceFromDetection(detection)
      });
      currentState = STATE.SHOWING;

      if (pendingPopupFocus && isPopupPinned()) {
        pendingPopupFocus = false;
        focusPopup();
      }

      if (settings.autoSpeak) {
        speakWord(translation.word || detection.word);
      }
    } catch (error) {
      if (requestToken !== latestRequestToken || currentLookup?.signature !== signature) {
        return;
      }

      updatePopup({
        word: detection.word,
        phonetic: "",
        meaning: error instanceof Error ? error.message : "翻译失败，请稍后再试",
        exampleEn: "",
        exampleZh: "",
        sentence: extractSentenceFromDetection(detection),
        error: true
      });
      currentState = STATE.SHOWING;

      if (pendingPopupFocus && isPopupPinned()) {
        pendingPopupFocus = false;
        focusPopup();
      }
    }
  }

  function detectWordAtPoint(x, y) {
    if (isExcludedArea(x, y)) {
      return null;
    }

    const caret = getCaretAtPoint(x, y);
    if (!caret || !caret.node || caret.node.nodeType !== Node.TEXT_NODE) {
      return null;
    }

    const text = caret.node.textContent || "";
    if (!text.trim()) {
      return null;
    }

    const offset = Math.max(0, Math.min(caret.offset, text.length));
    const matches = [...text.matchAll(WORD_PATTERN)];

    for (const match of matches) {
      const start = match.index ?? 0;
      const end = start + match[0].length;
      if (offset >= start && offset <= end) {
        const word = match[0];
        if (/^[A-Z'-]+$/.test(word) && word.length <= 3) {
          return null;
        }

        return {
          word,
          node: caret.node,
          text,
          start,
          end,
          offset
        };
      }
    }

    return null;
  }

  function getCaretAtPoint(x, y) {
    if (typeof document.caretPositionFromPoint === "function") {
      const position = document.caretPositionFromPoint(x, y);
      if (!position) {
        return null;
      }
      return {
        node: position.offsetNode,
        offset: position.offset
      };
    }

    if (typeof document.caretRangeFromPoint === "function") {
      const range = document.caretRangeFromPoint(x, y);
      if (!range) {
        return null;
      }
      return {
        node: range.startContainer,
        offset: range.startOffset
      };
    }

    return null;
  }

  function isExcludedArea(x, y) {
    const element = document.elementFromPoint(x, y);
    if (!element) {
      return true;
    }
    if (popupHost && (element === popupHost || popupHost.contains(element))) {
      return true;
    }
    return Boolean(element.closest(EXCLUDED_SELECTOR));
  }

  function extractSentenceFromDetection(detection) {
    if (!detection?.text) {
      return "";
    }

    const boundary = /[.!?;\n\r]/;
    let start = detection.start;
    let end = detection.end;

    while (start > 0 && !boundary.test(detection.text[start - 1])) {
      start -= 1;
    }

    while (end < detection.text.length && !boundary.test(detection.text[end])) {
      end += 1;
    }

    return detection.text.slice(start, end).trim().replace(/\s+/g, " ");
  }

  function buildLoadingData(word) {
    return {
      word,
      phonetic: "",
      meaning: "正在查询翻译...",
      exampleEn: "",
      exampleZh: "",
      sentence: currentLookup ? extractSentenceFromDetection(currentLookup) : ""
    };
  }

  function createPopupHost() {
    popupHost = document.createElement("div");
    popupHost.id = "word-catcher-popup-host";
    popupHost.style.position = "fixed";
    popupHost.style.inset = "0";
    popupHost.style.width = "100%";
    popupHost.style.height = "100%";
    popupHost.style.pointerEvents = "none";
    popupHost.style.zIndex = "2147483647";
    document.documentElement.appendChild(popupHost);
    popupShadow = popupHost.attachShadow({ mode: "open" });

    const style = document.createElement("style");
    style.textContent = POPUP_CSS;
    popupShadow.appendChild(style);
  }

  function removeAllPopupContainers() {
    if (popupShadow) {
      popupShadow.querySelectorAll(".popup-container").forEach((node) => {
        node.remove();
      });
    }
    popupContainer = null;
  }

  function copyPopupPosition(fromElement, toElement) {
    if (!fromElement || !toElement) {
      return;
    }

    if (fromElement.style.left) {
      toElement.style.left = fromElement.style.left;
    }
    if (fromElement.style.top) {
      toElement.style.top = fromElement.style.top;
    }
  }

  function showPopup(x, y, data) {
    activeAnchor = { x, y };
    if (!popupHost) {
      createPopupHost();
    }

    removeAllPopupContainers();
    popupContainer = buildPopupElement(data);
    popupShadow.appendChild(popupContainer);
    positionPopup(popupContainer, x, y);
    requestAnimationFrame(() => {
      if (popupContainer?.isConnected) {
        positionPopup(popupContainer, activeAnchor.x, activeAnchor.y);
      }
    });
  }

  function updatePopup(data) {
    if (!popupContainer?.isConnected) {
      showPopup(activeAnchor.x, activeAnchor.y, data);
      return;
    }

    isUpdatingPopup = true;
    const previousContainer = popupContainer;
    const nextContainer = buildPopupElement(data);
    copyPopupPosition(previousContainer, nextContainer);
    previousContainer.replaceWith(nextContainer);
    popupContainer = nextContainer;
    positionPopup(popupContainer, activeAnchor.x, activeAnchor.y);
    requestAnimationFrame(() => {
      if (popupContainer === nextContainer) {
        positionPopup(popupContainer, activeAnchor.x, activeAnchor.y);
      }
      isUpdatingPopup = false;
    });
  }

  function buildPopupElement(data) {
    const container = document.createElement("div");
    container.className = "popup-container";
    container.tabIndex = -1;
    const noteMarkup = data.note ? `<div class="popup-note">${escapeHtml(data.note)}</div>` : "";
    const exampleMarkup = data.exampleEn || data.exampleZh
      ? `
        <div class="popup-example">
          ${data.exampleEn ? `<p>${escapeHtml(data.exampleEn)}</p>` : ""}
          ${data.exampleZh ? `<p>${escapeHtml(data.exampleZh)}</p>` : ""}
        </div>
      `
      : "";
    const sentenceMarkup = data.sentence
      ? `<div class="popup-sentence">上下文：${escapeHtml(data.sentence)}</div>`
      : "";

    container.innerHTML = `
      <div class="popup-header">
        <span class="popup-word">${escapeHtml(data.word || "")}</span>
        <button class="popup-close" type="button" aria-label="关闭">×</button>
      </div>
      <div class="popup-phonetic">${escapeHtml(data.phonetic || "")}</div>
      <div class="popup-meaning ${data.error ? "is-error" : ""}">${escapeHtml(data.meaning || "")}</div>
      ${noteMarkup}
      ${exampleMarkup}
      ${sentenceMarkup}
      <div class="popup-actions">
        <button class="btn-save" type="button">添加到单词本</button>
      </div>
    `;

    container.addEventListener("focusout", (event) => {
      window.setTimeout(() => {
        if (isUpdatingPopup || !popupContainer) {
          return;
        }

        if (event.currentTarget !== popupContainer) {
          return;
        }

        if (lookupKeyPressed) {
          return;
        }

        if (isFocusInsidePopup()) {
          return;
        }

        if (event.relatedTarget && popupContainer.contains(event.relatedTarget)) {
          return;
        }

        if (!isPopupPinned()) {
          return;
        }

        closePopupAndReset();
      }, 0);
    });

    container.querySelector(".popup-close").addEventListener("click", () => {
      closePopupAndReset();
    });

    container.querySelector(".btn-save").addEventListener("click", async () => {
      if (!currentLookup?.translation) {
        return;
      }

      let response;
      try {
        response = await sendMessage({
          type: "SAVE_WORD",
          entry: buildWordEntry(currentLookup)
        });
      } catch (error) {
        showToast(error instanceof Error ? error.message : "保存失败");
        return;
      }

      if (response.saved && !response.duplicate) {
        showToast("添加成功");
        safeClosePopupAndReset();
        return;
      }

      if (response.duplicate) {
        showToast("已添加");
        safeClosePopupAndReset();
        return;
      }

      showToast("保存失败");
    });

    return container;
  }

  function focusPopup() {
    if (!popupContainer) {
      return;
    }

    popupContainer.focus({ preventScroll: true });
  }

  function positionPopup(element, mouseX, mouseY) {
    if (!element) {
      return;
    }

    const rect = element.getBoundingClientRect();
    const width = rect.width || POPUP_WIDTH;
    const height = rect.height || 220;
    let left = mouseX + 12;
    let top = mouseY + 12;

    if (left + width > window.innerWidth) {
      left = mouseX - width - 12;
    }
    if (top + height > window.innerHeight) {
      top = mouseY - height - 12;
    }

    element.style.left = `${Math.max(8, left)}px`;
    element.style.top = `${Math.max(8, top)}px`;
  }

  function hidePopup() {
    removeAllPopupContainers();
  }

  function ensureToastHost() {
    if (toastHost && toastShadow) {
      return;
    }

    toastHost = document.createElement("div");
    toastHost.id = "word-catcher-toast-host";
    toastHost.style.position = "fixed";
    toastHost.style.left = "0";
    toastHost.style.top = "0";
    toastHost.style.zIndex = "2147483647";
    document.documentElement.appendChild(toastHost);
    toastShadow = toastHost.attachShadow({ mode: "open" });

    const style = document.createElement("style");
    style.textContent = TOAST_CSS;
    toastShadow.appendChild(style);
  }

  function showToast(message) {
    ensureToastHost();

    if (!toastShadow) {
      return;
    }

    if (toastTimer) {
      clearTimeout(toastTimer);
      toastTimer = null;
    }

    if (toastNode) {
      toastNode.remove();
      toastNode = null;
    }

    const node = document.createElement("div");
    node.className = "toast";
    node.textContent = message;
    toastNode = node;
    toastShadow.appendChild(node);

    toastTimer = window.setTimeout(() => {
      if (toastNode === node) {
        node.remove();
        toastNode = null;
      }
      toastTimer = null;
    }, 1400);
  }

  function buildWordEntry(lookup) {
    const sentence = extractSentenceFromDetection(lookup);
    const now = Date.now();
    
    // 构建上下文对象
    const contexts = [];
    if (sentence) {
      contexts.push({
        context: sentence,
        timeAdded: now,
        sourceLink: window.location.href,
        translation: ""
      });
    }
    
    return {
      word: lookup.translation.word || lookup.word,
      frequency: contexts.length || 1,
      translation: lookup.translation.meaning || "",
      timeAdded: now,
      timeUpdated: now,
      contexts: contexts,
      // 保留旧数据作为兼容
      _legacy: {
        id: crypto.randomUUID(),
        phonetic: lookup.translation.phonetic || "",
        exampleEn: lookup.translation.exampleEn || "",
        exampleZh: lookup.translation.exampleZh || "",
        sourceUrl: window.location.href,
        sourceTitle: document.title,
        tags: [],
        createdAt: now,
        reviewCount: 0
      }
    };
  }

  async function saveLookupWord(lookup) {
    if (!lookup?.translation) {
      throw new Error("单词翻译数据无效");
    }

    return await sendMessage({
      type: "SAVE_WORD",
      entry: buildWordEntry(lookup)
    });
  }

  async function saveLookupWordWithFeedback(lookup) {
    if (!lookup?.translation || !popupContainer?.isConnected) {
      closePopupAndReset();
      return;
    }

    let response;
    try {
      response = await saveLookupWord(lookup);
    } catch (error) {
      showToast(error instanceof Error ? error.message : "保存失败");
      return;
    }

    if (response.saved) {
      showToast("添加成功");
      safeClosePopupAndReset();
      return;
    }

    showToast("保存失败");
  }

  function safeClosePopupAndReset() {
    window.setTimeout(() => {
      try {
        closePopupAndReset();
      } catch (_error) {
        // ignore
      }
    }, 0);
  }

  function speakWord(word) {
    if (!("speechSynthesis" in window) || !word) {
      return;
    }

    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(word);
    utterance.lang = "en-US";
    window.speechSynthesis.speak(utterance);
  }

  function applyCursor() {
    let style = document.getElementById(CURSOR_STYLE_ID);
    if (!style) {
      style = document.createElement("style");
      style.id = CURSOR_STYLE_ID;
      document.documentElement.appendChild(style);
    }

    style.textContent = `
      html, html * {
        cursor: url("${PEN_CURSOR_DATA_URL}") 0 24, crosshair !important;
      }
    `;
  }

  function removeCursor() {
    const style = document.getElementById(CURSOR_STYLE_ID);
    if (style) {
      style.remove();
    }
  }

  function clearHoverTimer() {
    if (hoverTimer) {
      clearTimeout(hoverTimer);
      hoverTimer = null;
    }
  }

  function escapeHtml(value) {
    return String(value || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function sendMessage(message) {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage(message, (response) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }
        if (!response?.success) {
          reject(new Error(response?.error || "扩展消息请求失败"));
          return;
        }
        resolve(response);
      });
    });
  }

  const POPUP_CSS = `
    :host {
      all: initial;
    }

    .popup-container {
      position: fixed;
      width: ${POPUP_WIDTH}px;
      box-sizing: border-box;
      pointer-events: auto;
      background: #1e1e2e;
      border: 1px solid #45475a;
      border-radius: 10px;
      padding: 14px;
      color: #cdd6f4;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      font-size: 14px;
      line-height: 1.5;
      box-shadow: 0 12px 32px rgba(0, 0, 0, 0.45);
      z-index: 2147483647;
      outline: none;
    }

    .popup-container:focus,
    .popup-container:focus-within {
      border-color: #89b4fa;
      box-shadow: 0 0 0 1px rgba(137, 180, 250, 0.4), 0 12px 32px rgba(0, 0, 0, 0.45);
    }

    .popup-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
    }

    .popup-word {
      font-size: 18px;
      font-weight: 700;
      color: #f5f7ff;
      word-break: break-word;
    }

    .popup-close {
      background: transparent;
      border: none;
      color: #a6adc8;
      font-size: 20px;
      line-height: 1;
      cursor: pointer;
      padding: 0;
    }

    .popup-phonetic {
      font-size: 13px;
      color: #8b949e;
      margin-top: 4px;
      min-height: 19px;
    }

    .popup-meaning {
      margin-top: 8px;
      color: #d9def7;
    }

    .popup-meaning.is-error {
      color: #ffb4b4;
    }

    .popup-note,
    .popup-sentence {
      margin-top: 8px;
      font-size: 12px;
      color: #a6adc8;
    }

    .popup-example {
      margin-top: 10px;
      padding-left: 10px;
      border-left: 2px solid #45475a;
      color: #a6adc8;
      font-size: 13px;
      font-style: italic;
    }

    .popup-example p {
      margin: 4px 0;
    }

    .popup-actions {
      margin-top: 12px;
    }

    .btn-save {
      width: 100%;
      border: none;
      border-radius: 8px;
      padding: 9px 12px;
      background: #89b4fa;
      color: #11213e;
      font-size: 12px;
      font-weight: 700;
      cursor: pointer;
      transition: background 0.15s ease;
    }

    .btn-save:hover {
      background: #74c7ec;
    }

    .btn-save:disabled {
      opacity: 0.75;
      cursor: default;
    }
  `;

  const TOAST_CSS = `
    :host {
      all: initial;
    }

    .toast {
      position: fixed;
      top: 14px;
      left: 50%;
      transform: translateX(-50%);
      box-sizing: border-box;
      max-width: min(520px, calc(100vw - 24px));
      padding: 10px 14px;
      border-radius: 10px;
      background: rgba(13, 17, 23, 0.92);
      border: 1px solid rgba(48, 54, 61, 0.9);
      color: #f0f6fc;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      font-size: 13px;
      font-weight: 700;
      letter-spacing: 0.2px;
      box-shadow: 0 10px 30px rgba(0, 0, 0, 0.45);
      z-index: 2147483647;
      animation: toast-in 0.15s ease-out, toast-out 0.2s ease-in 1.2s forwards;
      pointer-events: none;
      text-align: center;
      line-height: 1.4;
      user-select: none;
    }

    @keyframes toast-in {
      from { opacity: 0; transform: translateX(-50%) translateY(-8px); }
      to { opacity: 1; transform: translateX(-50%) translateY(0); }
    }

    @keyframes toast-out {
      to { opacity: 0; transform: translateX(-50%) translateY(-10px); }
    }
  `;
})();
