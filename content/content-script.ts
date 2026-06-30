(() => {
  const _logger = {
    debug: (...args: unknown[]) => console.debug(`[${new Date().toLocaleTimeString('zh-CN',{hour12:false})}] [content-script] [DEBUG]`, ...args),
    info: (...args: unknown[]) => console.info(`[${new Date().toLocaleTimeString('zh-CN',{hour12:false})}] [content-script] [INFO]`, ...args),
    warn: (...args: unknown[]) => console.warn(`[${new Date().toLocaleTimeString('zh-CN',{hour12:false})}] [content-script] [WARN]`, ...args),
    error: (...args: unknown[]) => console.error(`[${new Date().toLocaleTimeString('zh-CN',{hour12:false})}] [content-script] [ERROR]`, ...args),
  };

  const { escapeHtml, sendMessage } = (window as any).__WordCatcherShared;

  const STATE = {
    IDLE: "idle",
    PEN: "pen",
    LOADING: "loading",
    SHOWING: "showing",
  } as const;

  type State = typeof STATE[keyof typeof STATE];

  interface Settings {
    lookupKey: "Control" | "Command" | "Alt" | "Option";
    hoverDelay: number;
    autoSpeak: boolean;
    fireworksEffect: "canvas" | "css" | "none";
  }

  const DEFAULT_SETTINGS: Settings = {
    lookupKey: "Control",
    hoverDelay: 100,
    autoSpeak: false,
    fireworksEffect: "css",
  };

  const WORD_PATTERN = /[A-Za-z][A-Za-z'-]{1,44}/g;
  const EXCLUDED_SELECTOR = "input, textarea, [contenteditable='true'], [contenteditable=''], pre, code";
  const CURSOR_STYLE_ID = "word-catcher-cursor-style";
  const HIGHLIGHT_STYLE_ID = "word-catcher-highlight-style";
  const HIGHLIGHT_NAME = "word-catcher-hover";
  const POPUP_WIDTH = 320;
  const PEN_CURSOR_DATA_URL =
    "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='24' height='24' viewBox='0 0 24 24'%3E%3Cg fill='none' fill-rule='evenodd'%3E%3Cpath fill='%234472C4' d='M19.73 5.33a2 2 0 0 0-2.83 0l-1.42 1.42 4.24 4.24 1.42-1.42a2 2 0 0 0 0-2.83l-1.41-1.41Z'/%3E%3Cpath fill='%23FFFFFF' d='m14.07 8.1 4.24 4.24-8.84 8.84-4.98 1.13 1.13-4.98 8.45-8.45Z'/%3E%3Cpath fill='%231F2A44' d='m6.54 17.99 1.47-1.47 1.94 1.94-1.48 1.47-1.93.44.44-1.93Z'/%3E%3C/g%3E%3C/svg%3E";

  let currentState: State = STATE.IDLE;
  let settings: Settings = { ...DEFAULT_SETTINGS };
  let hoverTimer: number | null = null;
  let keydownPopupTimer: number | null = null;
  let popupHost: HTMLDivElement | null = null;
  let popupShadow: ShadowRoot | null = null;
  let popupContainer: HTMLDivElement | null = null;
  let toastHost: HTMLDivElement | null = null;
  let toastShadow: ShadowRoot | null = null;
  let toastTimer: number | null = null;
  let toastNode: HTMLDivElement | null = null;
  let fireworksHost: HTMLDivElement | null = null;
  let fireworksShadow: ShadowRoot | null = null;
  let fireworksRafId: number | null = null;
  let fireworksCanvas: HTMLCanvasElement | null = null;
  let activeAnchor = { x: 0, y: 0 };
  let currentLookup: CurrentLookup | null = null;
  let latestRequestToken = 0;
  let lookupKeyPressed = false;
  let isUpdatingPopup = false;
  let pendingPopupFocus = false;
  let wordHighlight: Highlight | null = null;

  const KEYDOWN_POPUP_DELAY_MS = 100;

  interface DetectionResult {
    word: string;
    node: Node;
    text: string;
    start: number;
    end: number;
    offset: number;
  }

  interface CurrentLookup extends DetectionResult {
    signature: string;
    translation?: TranslationData;
  }

  interface TranslationData {
    word: string;
    phonetic?: string;
    meaning: string;
    exampleEn?: string;
    exampleZh?: string;
    sentence?: string;
    note?: string;
    error?: boolean;
    provider?: string;
  }

  interface SourceRange {
    startXPath: string;
    startOffset: number;
    endXPath: string;
    endOffset: number;
  }

  initialize();

  async function initialize(): Promise<void> {
    await loadSettings();
    bindEvents();
  }

  async function loadSettings(): Promise<void> {
    try {
      const response = await sendMessage({ type: "GET_SETTINGS" });
      settings = {
        ...DEFAULT_SETTINGS,
        ...(response.settings || {}),
      };
    } catch (error) {
      _logger.warn("加载设置失败，使用默认设置：", error);
      settings = { ...DEFAULT_SETTINGS };
    }
  }

  function bindEvents(): void {
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
        clearFireworks();
      }
    });
  }

  function handleStorageChange(changes: { [key: string]: chrome.storage.StorageChange }, areaName: string): void {
    if (areaName !== "local" || !changes.settings?.newValue) {
      return;
    }

    settings = {
      ...DEFAULT_SETTINGS,
      ...changes.settings.newValue,
    };
    exitPenMode();
  }

  function handleKeyDown(event: KeyboardEvent): void {
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

  function handleKeyUp(event: KeyboardEvent): void {
    if (!isLookupKeyEvent(event)) {
      return;
    }

    if (isLookupModifierStillHeld(event)) {
      return;
    }

    lookupKeyPressed = false;
    leavePenMode({ preservePopup: Boolean(popupContainer) });
  }

  function isLookupModifierStillHeld(event: KeyboardEvent): boolean {
    if (settings.lookupKey === "Control") {
      return event.getModifierState("Control") || event.getModifierState("Meta");
    }

    return event.getModifierState(settings.lookupKey);
  }

  function isLookupKeyEvent(event: KeyboardEvent): boolean {
    if (!event) {
      return false;
    }

    if (settings.lookupKey === "Control") {
      return event.key === "Control" || event.key === "Meta";
    }

    return event.key === settings.lookupKey;
  }

  function enterPenMode(): void {
    currentState = currentState === STATE.SHOWING || currentState === STATE.LOADING ? currentState : STATE.PEN;
    applyCursor();
  }

  interface LeavePenOptions {
    preservePopup?: boolean;
  }

  function leavePenMode({ preservePopup = false }: LeavePenOptions = {}): void {
    clearHoverTimer();
    clearKeydownPopupTimer();
    removeCursor();
    clearWordHighlight();
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

  function exitPenMode(): void {
    lookupKeyPressed = false;
    closePopupAndReset();
  }

  function closePopupAndReset(): void {
    clearHoverTimer();
    clearKeydownPopupTimer();
    latestRequestToken += 1;
    lookupKeyPressed = false;
    pendingPopupFocus = false;
    hidePopup();
    currentLookup = null;
    currentState = STATE.IDLE;
    removeCursor();
    clearWordHighlight();
  }

  function scheduleInitialLookupAfterKeydown(): void {
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

  function clearKeydownPopupTimer(): void {
    if (keydownPopupTimer) {
      clearTimeout(keydownPopupTimer);
      keydownPopupTimer = null;
    }
  }

  function isPopupPinned(): boolean {
    return Boolean(
      popupContainer
      && !lookupKeyPressed
      && (currentState === STATE.SHOWING || currentState === STATE.LOADING)
    );
  }

  function isFocusInsidePopup(): boolean {
    const activeElement = popupShadow?.activeElement;
    return Boolean(activeElement && popupContainer?.contains(activeElement));
  }

  function handleViewportChange(): void {
    if (!popupContainer || isPopupPinned()) {
      return;
    }

    positionPopup(popupContainer, activeAnchor.x, activeAnchor.y);
  }

  function handleWheelWhilePinned(): void {
    if (!isPopupPinned()) {
      return;
    }

    requestAnimationFrame(() => {
      focusPopup();
    });
  }

  function handleFocusInWhilePinned(event: FocusEvent): void {
    if (!isPopupPinned()) {
      return;
    }

    const path = typeof event.composedPath === "function" ? event.composedPath() : [];
    if (path.includes(popupHost as EventTarget) || path.includes(popupContainer as EventTarget)) {
      return;
    }

    closePopupAndReset();
  }

  function handleMouseMove(event: MouseEvent): void {
    activeAnchor = { x: event.clientX, y: event.clientY };

    if (!lookupKeyPressed) {
      return;
    }

    // 即时高亮鼠标指向的单词（独立于弹窗的 hoverDelay，体验更跟手）
    updateHoverHighlight(event.clientX, event.clientY);

    if (currentState !== STATE.PEN && currentState !== STATE.SHOWING && currentState !== STATE.LOADING) {
      return;
    }

    clearHoverTimer();

    const delay = Math.max(0, Number(settings.hoverDelay) || DEFAULT_SETTINGS.hoverDelay);
    hoverTimer = window.setTimeout(() => {
      void lookupAtPoint(event.clientX, event.clientY);
    }, delay);
  }

  // 根据鼠标位置检测单词并即时高亮；未命中单词时清除高亮
  function updateHoverHighlight(x: number, y: number): void {
    const detection = detectWordAtPoint(x, y);
    if (detection?.node) {
      highlightWord(detection.node, detection.start, detection.end);
    } else {
      clearWordHighlight();
    }
  }

  async function lookupAtPoint(x: number, y: number): Promise<void> {
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
      positionPopup(popupContainer!, x, y);
      return;
    }

    _logger.debug('lookupAtPoint', { word: detection.word, x, y });
    currentLookup = {
      ...detection,
      signature,
    };
    currentState = STATE.LOADING;
    showPopup(x, y, buildLoadingData(detection.word));

    const requestToken = ++latestRequestToken;

    try {
      const response = await sendMessage({
        type: "TRANSLATE",
        word: detection.word,
      });

      if (requestToken !== latestRequestToken || currentLookup?.signature !== signature) {
        return;
      }

      const translation = response.translation || buildLoadingData(detection.word);
      currentLookup.translation = translation;
      _logger.debug('lookupAtPoint translation received', { word: detection.word, provider: translation.provider });
      updatePopup({
        ...translation,
        sentence: extractSentenceFromDetection(detection),
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
        error: true,
      });
      currentState = STATE.SHOWING;

      if (pendingPopupFocus && isPopupPinned()) {
        pendingPopupFocus = false;
        focusPopup();
      }
    }
  }

  function detectWordAtPoint(x: number, y: number): DetectionResult | null {
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
          offset,
        };
      }
    }

    return null;
  }

  interface CaretPosition {
    node: Node;
    offset: number;
  }

  function getCaretAtPoint(x: number, y: number): CaretPosition | null {
    if (typeof document.caretPositionFromPoint === "function") {
      const position = document.caretPositionFromPoint(x, y);
      if (!position) {
        return null;
      }
      return {
        node: position.offsetNode,
        offset: position.offset,
      };
    }

    if (typeof document.caretRangeFromPoint === "function") {
      const range = document.caretRangeFromPoint(x, y);
      if (!range) {
        return null;
      }
      return {
        node: range.startContainer,
        offset: range.startOffset,
      };
    }

    return null;
  }

  function isExcludedArea(x: number, y: number): boolean {
    const element = document.elementFromPoint(x, y);
    if (!element) {
      return true;
    }
    if (popupHost && (element === popupHost || popupHost.contains(element))) {
      return true;
    }
    return Boolean(element.closest(EXCLUDED_SELECTOR));
  }

  function extractSentenceFromDetection(detection: DetectionResult): string {
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

  function buildLoadingData(word: string): TranslationData {
    return {
      word,
      phonetic: "",
      meaning: "正在查询翻译...",
      exampleEn: "",
      exampleZh: "",
      sentence: currentLookup ? extractSentenceFromDetection(currentLookup) : "",
    };
  }

  function createPopupHost(): void {
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

  function removeAllPopupContainers(): void {
    if (popupShadow) {
      popupShadow.querySelectorAll(".popup-container").forEach((node) => {
        node.remove();
      });
    }
    popupContainer = null;
  }

  function copyPopupPosition(fromElement: HTMLElement, toElement: HTMLElement): void {
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

  function showPopup(x: number, y: number, data: TranslationData): void {
    activeAnchor = { x, y };
    if (!popupHost) {
      createPopupHost();
    }

    removeAllPopupContainers();
    popupContainer = buildPopupElement(data);
    popupShadow!.appendChild(popupContainer);
    positionPopup(popupContainer, x, y);
    requestAnimationFrame(() => {
      if (popupContainer?.isConnected) {
        positionPopup(popupContainer, activeAnchor.x, activeAnchor.y);
      }
    });
  }

  function updatePopup(data: TranslationData): void {
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

  function buildPopupElement(data: TranslationData): HTMLDivElement {
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

        if (event.relatedTarget && popupContainer.contains(event.relatedTarget as Node)) {
          return;
        }

        if (!isPopupPinned()) {
          return;
        }

        closePopupAndReset();
      }, 0);
    });

    container.querySelector(".popup-close")!.addEventListener("click", () => {
      closePopupAndReset();
    });

    container.querySelector(".btn-save")!.addEventListener("click", async () => {
      if (!currentLookup?.translation) {
        return;
      }

      let response;
      try {
        response = await sendMessage({
          type: "SAVE_WORD",
          entry: buildWordEntry(currentLookup),
        });
      } catch (error) {
        showToast(error instanceof Error ? error.message : "保存失败");
        return;
      }

      if (response.duplicate) {
        showToast("已添加");
        safeClosePopupAndReset();
        return;
      }

      if (response.saved) {
        showToast("添加成功");
        launchFireworks(activeAnchor.x, activeAnchor.y);
        safeClosePopupAndReset();
        return;
      }

      showToast("保存失败");
    });

    return container;
  }

  function focusPopup(): void {
    if (!popupContainer) {
      return;
    }

    popupContainer.focus({ preventScroll: true });
  }

  function positionPopup(element: HTMLElement, mouseX: number, mouseY: number): void {
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

  function hidePopup(): void {
    removeAllPopupContainers();
  }

  function ensureToastHost(): void {
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

  function showToast(message: string): void {
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

  // 序列化 DOM 节点为 XPath（用于精确定位回原文）
  function getElementXPath(element: Node | null): string {
    if (!element) return '';
    if (element instanceof Element && element.id) return `//*[@id="${CSS.escape(element.id)}"]`;
    const path: string[] = [];
    while (element && element.nodeType === Node.ELEMENT_NODE) {
      let index = 1;
      for (let sibling: Node | null = element.previousSibling; sibling; sibling = sibling.previousSibling) {
        if (sibling.nodeType === Node.ELEMENT_NODE && sibling.nodeName === element.nodeName) {
          index++;
        }
      }
      path.unshift(`${element.nodeName.toLowerCase()}[${index}]`);
      element = element.parentNode;
    }
    return '/' + path.join('/');
  }

  function getNodeXPath(node: Node): string {
    if (node.nodeType === Node.TEXT_NODE) {
      const parentXPath = getElementXPath(node.parentNode);
      const textNodes = Array.from(node.parentNode!.childNodes as NodeListOf<ChildNode>).filter(n => n.nodeType === Node.TEXT_NODE);
      const textIndex = textNodes.indexOf(node as ChildNode) + 1;
      return `${parentXPath}/text()[${textIndex}]`;
    }
    return getElementXPath(node as Element);
  }

  function serializeRange(node: Node, start: number, end: number): SourceRange {
    const xpath = getNodeXPath(node);
    return {
      startXPath: xpath,
      startOffset: start,
      endXPath: xpath,
      endOffset: end,
    };
  }

  function buildTextFragmentUrl(baseUrl: string, text: string): string {
    const cleanUrl = baseUrl.split('#')[0];
    const maxLen = 80;
    const fragment = text.length > maxLen ? text.slice(0, maxLen) : text;
    return `${cleanUrl}#:~:text=${encodeURIComponent(fragment)}`;
  }

  function buildWordEntry(lookup: CurrentLookup): any {
    const sentence = extractSentenceFromDetection(lookup);
    const now = Date.now();

    // 构建上下文对象
    interface ContextEntry {
      context: string;
      timeAdded: number;
      sourceLink: string;
      sourceRange?: SourceRange;
      translation: string;
    }
    const contexts: ContextEntry[] = [];
    if (sentence) {
      const sourceLink = buildTextFragmentUrl(window.location.href, sentence);
      const sourceRange = lookup.node
        ? serializeRange(lookup.node, lookup.start, lookup.end)
        : undefined;
      contexts.push({
        context: sentence,
        timeAdded: now,
        sourceLink,
        sourceRange,
        translation: "",
      });
    }

    return {
      word: lookup.translation!.word || lookup.word,
      frequency: contexts.length || 1,
      translation: lookup.translation!.meaning || "",
      timeAdded: now,
      timeUpdated: now,
      contexts: contexts,
      // 保留旧数据作为兼容
      _legacy: {
        id: crypto.randomUUID(),
        phonetic: lookup.translation!.phonetic || "",
        exampleEn: lookup.translation!.exampleEn || "",
        exampleZh: lookup.translation!.exampleZh || "",
        sourceUrl: window.location.href,
        sourceTitle: document.title,
        tags: [],
        createdAt: now,
        reviewCount: 0,
      },
    };
  }

  async function saveLookupWord(lookup: CurrentLookup): Promise<any> {
    if (!lookup?.translation) {
      throw new Error("单词翻译数据无效");
    }

    return await sendMessage({
      type: "SAVE_WORD",
      entry: buildWordEntry(lookup),
    });
  }

  async function saveLookupWordWithFeedback(lookup: CurrentLookup): Promise<void> {
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

    if (response.duplicate) {
      showToast("已添加");
      safeClosePopupAndReset();
      return;
    }

    if (response.saved) {
      showToast("添加成功");
      launchFireworks(activeAnchor.x, activeAnchor.y);
      safeClosePopupAndReset();
      return;
    }

    showToast("保存失败");
  }

  function safeClosePopupAndReset(): void {
    window.setTimeout(() => {
      try {
        closePopupAndReset();
      } catch (error) {
        _logger.warn("关闭弹窗时出现异常：", error);
      }
    }, 0);
  }

  function speakWord(word: string): void {
    if (!("speechSynthesis" in window) || !word) {
      return;
    }

    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(word);
    utterance.lang = "en-US";
    // 语速略低于默认，更接近自然朗读节奏
    utterance.rate = 0.9;
    utterance.pitch = 1;
    const voice = pickEnglishVoice();
    if (voice) {
      utterance.voice = voice;
    }
    window.speechSynthesis.speak(utterance);
  }

  // 优先选择高质量的英文女声（Google/系统女声），避免默认机器人音色。
  // 注意：voices 列表可能在页面加载后才异步就绪，取不到时先用默认 voice。
  function pickEnglishVoice(): SpeechSynthesisVoice | null {
    const voices = window.speechSynthesis.getVoices();
    if (!voices || voices.length === 0) {
      return null;
    }
    const enVoices = voices.filter((v) => /^en(-|_)/i.test(v.lang));
    const pool = enVoices.length > 0 ? enVoices : voices;

    // 按优先级匹配高质量音色：Google 系列 > 女性/自然名 > 其余
    const preferredNames = [
      "Google US English",
      "Google UK English Female",
      "Samantha",
      "Karen",
      "Moira",
      "Tessa",
      "Zira",
      "Microsoft Aria",
      "Microsoft Jenny",
    ];
    for (const name of preferredNames) {
      const found = pool.find((v) => v.name === name);
      if (found) {
        return found;
      }
    }
    const google = pool.find((v) => /google/i.test(v.name));
    if (google) {
      return google;
    }
    const female = pool.find((v) => /female|aria|jenny|zira|samantha|karen|moira|tessa/i.test(v.name));
    if (female) {
      return female;
    }
    return pool[0] || null;
  }

  // voices 列表异步加载：首次就绪后无需额外动作，下次 speakWord 会自动取到
  if ("speechSynthesis" in window) {
    window.speechSynthesis.onvoiceschanged = () => {
      window.speechSynthesis.getVoices();
    };
  }

  function applyCursor(): void {
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

  function removeCursor(): void {
    const style = document.getElementById(CURSOR_STYLE_ID);
    if (style) {
      style.remove();
    }
  }

  // 初始化 CSS Custom Highlight（用于在按住唤起键时高亮鼠标指向的单词）
  function ensureWordHighlight(): Highlight | null {
    if (typeof Highlight === "undefined" || !CSS?.highlights) {
      return null;
    }
    if (!wordHighlight) {
      wordHighlight = new Highlight();
      CSS.highlights.set(HIGHLIGHT_NAME, wordHighlight);
    }
    if (!document.getElementById(HIGHLIGHT_STYLE_ID)) {
      const style = document.createElement("style");
      style.id = HIGHLIGHT_STYLE_ID;
      style.textContent = `::highlight(${HIGHLIGHT_NAME}) { background-color: Highlight; color: HighlightText; }`;
      document.documentElement.appendChild(style);
    }
    return wordHighlight;
  }

  // 高亮指定文本节点内 [start, end) 区间的单词，效果与划词选中一致
  function highlightWord(node: Node, start: number, end: number): void {
    const highlight = ensureWordHighlight();
    if (!highlight || !node) {
      return;
    }
    try {
      const range = document.createRange();
      range.setStart(node, start);
      range.setEnd(node, end);
      highlight.clear();
      highlight.add(range);
    } catch (error) {
      highlight.clear();
    }
  }

  function clearWordHighlight(): void {
    if (wordHighlight) {
      wordHighlight.clear();
    }
  }

  function clearHoverTimer(): void {
    if (hoverTimer) {
      clearTimeout(hoverTimer);
      hoverTimer = null;
    }
  }

  // ============ 添加成功烟花效果 ============

  function launchFireworks(x: number, y: number): void {
    const mode = settings.fireworksEffect;
    if (mode === "none") {
      return;
    }
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      return;
    }
    if (mode === "canvas") {
      launchCanvasFireworks(x, y);
      return;
    }
    launchCssFireworks(x, y);
  }

  function ensureFireworksHost(): ShadowRoot | null {
    if (fireworksShadow) {
      return fireworksShadow;
    }
    fireworksHost = document.createElement("div");
    fireworksHost.id = "word-catcher-fireworks-host";
    fireworksHost.style.position = "fixed";
    fireworksHost.style.left = "0";
    fireworksHost.style.top = "0";
    fireworksHost.style.width = "100%";
    fireworksHost.style.height = "100%";
    fireworksHost.style.pointerEvents = "none";
    fireworksHost.style.zIndex = "2147483647";
    document.documentElement.appendChild(fireworksHost);
    fireworksShadow = fireworksHost.attachShadow({ mode: "open" });

    const style = document.createElement("style");
    style.setAttribute("data-fw", "1");
    style.textContent = FIREWORKS_CSS;
    fireworksShadow.appendChild(style);
    return fireworksShadow;
  }

  const FIREWORKS_PALETTE = ["#f38ba8", "#fab387", "#f9e2af", "#a6e3a1", "#94e2d5", "#89b4fa", "#cba6f7", "#f5c2e7"];

  function pickColor(): string {
    return FIREWORKS_PALETTE[Math.floor(Math.random() * FIREWORKS_PALETTE.length)];
  }

  // 方案 B：CSS/DOM 粒子，每个 span 用随机 CSS 变量驱动爆炸方向与颜色
  function launchCssFireworks(x: number, y: number): void {
    const shadow = ensureFireworksHost();
    if (!shadow) {
      return;
    }

    const PARTICLE_COUNT = 56;
    for (let i = 0; i < PARTICLE_COUNT; i++) {
      const particle = document.createElement("span");
      particle.className = "fw-particle";
      const angle = (Math.PI * 2 * i) / PARTICLE_COUNT + Math.random() * 0.4;
      const distance = 60 + Math.random() * 70;
      const dx = Math.cos(angle) * distance;
      const dy = Math.sin(angle) * distance;
      const size = 5 + Math.random() * 5;
      particle.style.setProperty("--dx", `${dx}px`);
      particle.style.setProperty("--dy", `${dy + 40}px`); // 加重力下沉
      particle.style.setProperty("--color", pickColor());
      particle.style.setProperty("--rot", `${Math.random() * 360}deg`);
      particle.style.width = `${size}px`;
      particle.style.height = `${size}px`;
      particle.style.left = `${x}px`;
      particle.style.top = `${y}px`;
      particle.style.animationDuration = `${700 + Math.random() * 400}ms`;
      particle.addEventListener("animationend", () => particle.remove(), { once: true });
      shadow.appendChild(particle);
    }
  }

  // 方案 A：Canvas + requestAnimationFrame 物理动画，拖尾、多波爆炸
  function launchCanvasFireworks(x: number, y: number): void {
    const shadow = ensureFireworksHost();
    if (!shadow || fireworksCanvas) {
      return; // 已有动画进行中，避免叠加
    }

    const canvas = document.createElement("canvas");
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;
    canvas.style.position = "fixed";
    canvas.style.left = "0";
    canvas.style.top = "0";
    canvas.style.pointerEvents = "none";
    shadow.appendChild(canvas);
    fireworksCanvas = canvas;

    const ctx = canvas.getContext("2d");
    if (!ctx) {
      canvas.remove();
      fireworksCanvas = null;
      return;
    }

    interface Particle {
      x: number; y: number; vx: number; vy: number;
      alpha: number; color: string; size: number;
    }
    const particles: Particle[] = [];
    const MAX_PARTICLES = 120;
    const GRAVITY = 0.12;
    const DRAG = 0.985;

    const spawnBurst = (cx: number, cy: number, count: number): void => {
      for (let i = 0; i < count; i++) {
        if (particles.length >= MAX_PARTICLES) {
          break;
        }
        const angle = Math.random() * Math.PI * 2;
        const speed = 2 + Math.random() * 5;
        particles.push({
          x: cx,
          y: cy,
          vx: Math.cos(angle) * speed,
          vy: Math.sin(angle) * speed,
          alpha: 1,
          color: pickColor(),
          size: 2 + Math.random() * 2.5,
        });
      }
    };

    spawnBurst(x, y, 50);
    // 第二波延迟爆炸，增强层次感
    window.setTimeout(() => {
      if (fireworksCanvas === canvas) {
        spawnBurst(x + (Math.random() - 0.5) * 80, y + (Math.random() - 0.5) * 40, 50);
      }
    }, 220);

    const tick = (): void => {
      // destination-out 半透明擦除产生拖尾，canvas 背景保持透明，避免全屏变黑
      ctx.globalCompositeOperation = "destination-out";
      ctx.fillStyle = "rgba(0, 0, 0, 0.2)";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.globalCompositeOperation = "lighter";

      let alive = 0;
      for (const p of particles) {
        if (p.alpha <= 0) {
          continue;
        }
        p.vx *= DRAG;
        p.vy = p.vy * DRAG + GRAVITY;
        p.x += p.vx;
        p.y += p.vy;
        p.alpha -= 0.012;
        if (p.alpha > 0) {
          alive++;
          ctx.globalAlpha = Math.max(0, p.alpha);
          ctx.fillStyle = p.color;
          ctx.beginPath();
          ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2);
          ctx.fill();
        }
      }
      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = "source-over";

      if (alive === 0) {
        cancelAnimationFrame(fireworksRafId!);
        fireworksRafId = null;
        canvas.remove();
        if (fireworksCanvas === canvas) {
          fireworksCanvas = null;
        }
        return;
      }
      fireworksRafId = requestAnimationFrame(tick);
    };
    fireworksRafId = requestAnimationFrame(tick);
  }

  function clearFireworks(): void {
    if (fireworksRafId) {
      cancelAnimationFrame(fireworksRafId);
      fireworksRafId = null;
    }
    if (fireworksCanvas) {
      fireworksCanvas.remove();
      fireworksCanvas = null;
    }
    if (fireworksShadow) {
      fireworksShadow.querySelectorAll(".fw-particle").forEach((node) => node.remove());
    }
  }

  const FIREWORKS_CSS = `
    .fw-particle {
      position: fixed;
      border-radius: 50%;
      background: var(--color);
      box-shadow: 0 0 6px var(--color);
      transform: translate(-50%, -50%) rotate(0deg);
      animation-name: fw-burst;
      animation-timing-function: cubic-bezier(0.15, 0.6, 0.35, 1);
      animation-fill-mode: forwards;
      pointer-events: none;
    }

    @keyframes fw-burst {
      0% {
        opacity: 1;
        transform: translate(-50%, -50%) rotate(0deg) scale(1);
      }
      70% {
        opacity: 1;
      }
      100% {
        opacity: 0;
        transform: translate(calc(-50% + var(--dx)), calc(-50% + var(--dy))) rotate(var(--rot)) scale(0.4);
      }
    }
  `;

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
