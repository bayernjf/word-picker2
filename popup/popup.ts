import browser from "webextension-polyfill";
import { escapeHtml, sendMessage, formatDate, formatSyncStatusSummary, selectPreferredSyncBook } from "../lib/utils.js";
import { createLogger } from "../lib/logger.js";
import type { Book, SyncStatus } from "../lib/utils.js";

const logger = createLogger("popup");

const searchInput = document.getElementById("search-input") as HTMLInputElement;
const wordList = document.getElementById("word-list") as HTMLDivElement;
const statusNode = document.getElementById("status") as HTMLDivElement;
const syncStatusNode = document.getElementById("sync-status") as HTMLDivElement | null;
const exportJsonButton = document.getElementById("export-json") as HTMLButtonElement;
const exportCsvButton = document.getElementById("export-csv") as HTMLButtonElement;
const bookSelect = document.getElementById("book-select") as HTMLSelectElement;
const refreshBooksButton = document.getElementById("refresh-books") as HTMLButtonElement;

// 当前选中的单词本
let currentBookId = "";
// 单词本缓存，用于在跨单词本搜索结果中显示每个词条所属单词本名
let booksCache: Book[] = [];
// 单词列表加载请求令牌：保证只渲染最新一次请求的结果，避免慢请求覆盖快请求
let loadWordsToken = 0;
// 当前展示的单词列表（单词本筛选或搜索结果），导出时只导出这部分
let currentWords: Word[] = [];

interface Word {
  word: string;
  translation: string;
  frequency: number;
  timeAdded: number;
  bookId?: string;
  _legacy?: {
    id?: string;
    phonetic?: string;
    meaning?: string;
    createdAt?: number;
  };
}

document.addEventListener("DOMContentLoaded", async () => {
  await checkAuthAndRender();
  bindEvents();

  // 监听后台登录态变化（如 token 失效被清空），实时刷新界面
  browser.storage.onChanged.addListener((changes, areaName) => {
    if (areaName === "local" && changes.authData) {
      void checkAuthAndRender();
    }
  });
});

function bindEvents(): void {
  searchInput.addEventListener("input", () => {
    loadWords(searchInput.value);
  });

  bookSelect.addEventListener("change", () => {
    currentBookId = bookSelect.value;
    loadWords(searchInput.value);
  });

  refreshBooksButton.addEventListener("click", async () => {
    await loadBooks();
    await loadWords(searchInput.value);
    await refreshSyncStatus();
  });

  exportJsonButton.addEventListener("click", () => {
    exportWords("json");
  });

  exportCsvButton.addEventListener("click", () => {
    exportWords("csv");
  });

  const openOptionsBtn = document.getElementById("open-options");
  if (openOptionsBtn) {
    openOptionsBtn.addEventListener("click", async (event) => {
      event.preventDefault();
      await browser.runtime.openOptionsPage();
    });
  }
}

async function loadBooks(): Promise<void> {
  try {
    logger.debug('loadBooks');
    const response = await sendMessage({
      type: "GET_BOOKS",
    }) as { books?: Book[] };
    renderBooks(response.books || []);
    logger.info('loadBooks success', { count: (response.books || []).length });
  } catch (error) {
    logger.error("加载单词本失败", error);
  }
}

function renderBooks(books: Book[]): void {
  booksCache = books;
  // 清空现有选项
  bookSelect.innerHTML = '';

  // 添加单词本选项
  books.forEach(book => {
    const option = document.createElement("option");
    option.value = book.id;
    option.textContent = book.name;
    if (book.isSync) {
      option.textContent += " (同步单词本)";
    }
    bookSelect.appendChild(option);
  });

  // 优先选择同步单词本，或者恢复之前选择的
  const syncBook = selectPreferredSyncBook(books);
  if (currentBookId && books.some(b => b.id === currentBookId)) {
    bookSelect.value = currentBookId;
  } else if (syncBook) {
    currentBookId = syncBook.id;
    bookSelect.value = currentBookId;
  } else if (books.length > 0) {
    currentBookId = books[0].id;
    bookSelect.value = currentBookId;
  }
}

async function loadWords(query: string = ""): Promise<void> {
  const token = ++loadWordsToken;
  setStatus("加载中...");
  logger.debug('loadWords', { bookId: currentBookId, query });

  try {
    // 如果没有选择单词本，尝试先加载单词本
    if (!currentBookId) {
      await loadBooks();
    }

    // 搜索时跨所有单词本匹配：无视当前选中的单词本，
    // 同一单词存在于多个单词本时全部展示。
    const searching = query.trim().length > 0;

    let response: { words?: Word[] };
    if (searching || !currentBookId) {
      response = await sendMessage({
        type: "GET_WORDS",
        query,
      }) as { words?: Word[] };
    } else {
      // 无搜索词时按选中单词本浏览
      response = await sendMessage({
        type: "GET_BOOK_WORDS",
        bookId: currentBookId,
        query,
      }) as { words?: Word[] };
    }

    // 丢弃过期请求的结果，只渲染最新一次
    if (token !== loadWordsToken) {
      return;
    }

    renderList(response.words || []);
    const count = response.words?.length || 0;
    setStatus(`共 ${count} 条记录`);
    logger.info('loadWords success', { count });
  } catch (error) {
    if (token !== loadWordsToken) {
      return;
    }
    logger.error('loadWords failed', error);
    renderError(error instanceof Error ? error.message : "加载失败");
  }
}

function renderList(words: Word[]): void {
  currentWords = Array.isArray(words) ? words : [];
  if (!Array.isArray(words) || words.length === 0) {
    wordList.innerHTML = '<div class="empty">还没有保存任何单词</div>';
    return;
  }

  const searching = searchInput.value.trim().length > 0;
  const bookNameOf = (bookId?: string): string => {
    if (!bookId) return "";
    return booksCache.find((book) => book.id === bookId)?.name || bookId;
  };

  wordList.innerHTML = words
    .map((item, index) => {
      const wordId = item._legacy?.id ?? `word-${index}`;
      const phonetic = item._legacy?.phonetic || "";
      const meaning = item.translation || item._legacy?.meaning || "";
      const timeAdded = item.timeAdded || item._legacy?.createdAt;
      const bookName = searching ? bookNameOf(item.bookId) : "";

      return `
        <article class="word-card">
          <div class="word-card-header">
            <strong>${escapeHtml(item.word)}</strong>
            <span class="phonetic">${escapeHtml(phonetic)}</span>
            <button class="btn-delete" type="button" data-id="${escapeHtml(wordId)}" aria-label="删除">删除</button>
          </div>
          <div class="meaning">${escapeHtml(meaning)}</div>
          <div class="frequency">频率：${item.frequency || 0}</div>
          ${bookName ? `<div class="meta">单词本：${escapeHtml(bookName)}</div>` : ""}
          <div class="meta">保存时间：${formatDate(timeAdded ?? 0)}</div>
        </article>
      `;
    })
    .join("");

  wordList.querySelectorAll(".btn-delete").forEach((button) => {
    button.addEventListener("click", async () => {
      const id = (button as HTMLButtonElement).dataset.id;
      const confirmed = window.confirm("确定删除这个单词吗？");
      if (!confirmed) {
        return;
      }

      try {
        await sendMessage({
          type: "DELETE_WORD",
          id: id,
        });
        setStatus("已删除");
        await loadWords(searchInput.value);
        await refreshSyncStatus();
      } catch (error) {
        setStatus(error instanceof Error ? error.message : "删除失败");
      }
    });
  });
}

function renderError(message: string): void {
  wordList.innerHTML = `<div class="empty">${escapeHtml(message)}</div>`;
  setStatus("加载失败");
}

type ExportFormat = "json" | "csv";

async function exportWords(format: ExportFormat): Promise<void> {
  // 只导出当前展示的单词（单词本筛选或搜索结果），而非全部单词
  if (currentWords.length === 0) {
    setStatus("没有可导出的单词");
    return;
  }
  try {
    const response = await sendMessage<{ success: boolean; fileName: string; data: string }>({
      type: "EXPORT_WORDS",
      format,
      words: currentWords,
    });
    downloadFile(response.fileName, response.data, format === "csv" ? "text/csv;charset=utf-8" : "application/json");
    setStatus(`已导出 ${format.toUpperCase()}（${currentWords.length} 条）`);
  } catch (error) {
    setStatus(error instanceof Error ? error.message : "导出失败");
  }
}

function downloadFile(fileName: string, content: string, mimeType: string): void {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

function setStatus(message: string): void {
  statusNode.textContent = message;
}

async function refreshSyncStatus(): Promise<void> {
  if (!syncStatusNode) {
    return;
  }

  try {
    const response = await sendMessage<SyncStatus & { success: boolean }>({ type: "GET_SYNC_STATUS" });
    syncStatusNode.textContent = formatSyncStatusSummary(response);
  } catch (error) {
    logger.warn("Failed to load sync status:", error);
    syncStatusNode.textContent = "";
  }
}

// 检查登录状态并渲染相应界面
async function checkAuthAndRender(): Promise<void> {
  try {
    const authStatus = await sendMessage({ type: "AUTH_STATUS" });
    const authRequired = document.getElementById('auth-required') as HTMLDivElement;
    const mainContent = document.getElementById('main-content') as HTMLDivElement;
    const isLoggedIn = authStatus.isLoggedIn;

    if (isLoggedIn) {
      // 已登录，显示主内容
      authRequired.style.display = 'none';
      mainContent.style.display = 'block';
      await loadBooks();
      // 用当前搜索框内容加载，避免后台 authData 变化重置正在进行的搜索
      await loadWords(searchInput.value);
    } else {
      // 未登录，显示登录提示
      authRequired.style.display = 'block';
      mainContent.style.display = 'none';
    }
  } catch (error) {
    // 出错时默认显示登录提示
    logger.warn("检查登录状态失败：", error);
    const authRequired = document.getElementById('auth-required') as HTMLDivElement;
    const mainContent = document.getElementById('main-content') as HTMLDivElement;
    authRequired.style.display = 'block';
    mainContent.style.display = 'none';
  }
}
