import { escapeHtml, sendMessage, formatDate, formatSyncStatusSummary } from "../lib/utils.js";
import { createLogger } from "../lib/logger.js";

const logger = createLogger("popup");

const searchInput = document.getElementById("search-input");
const wordList = document.getElementById("word-list");
const statusNode = document.getElementById("status");
const syncStatusNode = document.getElementById("sync-status");
const exportJsonButton = document.getElementById("export-json");
const exportCsvButton = document.getElementById("export-csv");
const bookSelect = document.getElementById("book-select");
const refreshBooksButton = document.getElementById("refresh-books");

// 当前选中的单词本
let currentBookId = "";

document.addEventListener("DOMContentLoaded", async () => {
  await checkAuthAndRender();
  bindEvents();

  // 监听后台登录态变化（如 token 失效被清空），实时刷新界面
  if (chrome?.storage?.onChanged) {
    chrome.storage.onChanged.addListener((changes, areaName) => {
      if (areaName === "local" && changes.authData) {
        void checkAuthAndRender();
      }
    });
  }
});

function bindEvents() {
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
      await chrome.runtime.openOptionsPage();
    });
  }
}

async function loadBooks() {
  try {
    logger.debug('loadBooks');
    const response = await sendMessage({
      type: "GET_BOOKS"
    });
    renderBooks(response.books || []);
    logger.info('loadBooks success', { count: (response.books || []).length });
  } catch (error) {
    logger.error("加载单词本失败", error);
  }
}

function renderBooks(books) {
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
  const syncBook = [...books]
    .filter((book) => book?.isSync)
    .sort((left, right) => {
      const leftIsDefault = left.name === "默认";
      const rightIsDefault = right.name === "默认";
      if (leftIsDefault !== rightIsDefault) {
        return leftIsDefault ? 1 : -1;
      }

      const leftUpdated = Number(left.updatedAt) || Number(left.createdAt) || 0;
      const rightUpdated = Number(right.updatedAt) || Number(right.createdAt) || 0;
      return rightUpdated - leftUpdated;
    })[0];
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

async function loadWords(query = "") {
  setStatus("加载中...");
  logger.debug('loadWords', { bookId: currentBookId, query });

  try {
    // 如果没有选择单词本，尝试先加载单词本
    if (!currentBookId) {
      await loadBooks();
    }

    let response;
    if (currentBookId) {
      response = await sendMessage({
        type: "GET_BOOK_WORDS",
        bookId: currentBookId,
        query
      });
    } else {
      // 兜底：获取所有单词
      response = await sendMessage({
        type: "GET_WORDS",
        query
      });
    }
    renderList(response.words || []);
    const count = response.words?.length || 0;
    setStatus(`共 ${count} 条记录`);
    logger.info('loadWords success', { count });
    await refreshSyncStatus();
  } catch (error) {
    logger.error('loadWords failed', error);
    renderError(error instanceof Error ? error.message : "加载失败");
  }
}

function renderList(words) {
  if (!Array.isArray(words) || words.length === 0) {
    wordList.innerHTML = '<div class="empty">还没有保存任何单词</div>';
    return;
  }

  wordList.innerHTML = words
    .map((item, index) => {
      const wordId = item._legacy?.id || `word-${index}`;
      const phonetic = item._legacy?.phonetic || "";
      const meaning = item.translation || item._legacy?.meaning || "";
      const timeAdded = item.timeAdded || item._legacy?.createdAt;
      
      return `
        <article class="word-card">
          <div class="word-card-header">
            <strong>${escapeHtml(item.word)}</strong>
            <span class="phonetic">${escapeHtml(phonetic)}</span>
            <button class="btn-delete" type="button" data-id="${escapeHtml(wordId)}" aria-label="删除">删除</button>
          </div>
          <div class="meaning">${escapeHtml(meaning)}</div>
          <div class="frequency">频率：${item.frequency || 0}</div>
          <div class="meta">保存时间：${formatDate(timeAdded)}</div>
        </article>
      `;
    })
    .join("");

  wordList.querySelectorAll(".btn-delete").forEach((button) => {
    button.addEventListener("click", async () => {
      const confirmed = window.confirm("确定删除这个单词吗？");
      if (!confirmed) {
        return;
      }

      try {
        await sendMessage({
          type: "DELETE_WORD",
          id: button.dataset.id
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

function renderError(message) {
  wordList.innerHTML = `<div class="empty">${escapeHtml(message)}</div>`;
  setStatus("加载失败");
}

async function exportWords(format) {
  try {
    const response = await sendMessage({
      type: "EXPORT_WORDS",
      format
    });
    downloadFile(response.fileName, response.data, format === "csv" ? "text/csv;charset=utf-8" : "application/json");
    setStatus(`已导出 ${format.toUpperCase()}`);
  } catch (error) {
    setStatus(error instanceof Error ? error.message : "导出失败");
  }
}

function downloadFile(fileName, content, mimeType) {
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

function setStatus(message) {
  statusNode.textContent = message;
}

async function refreshSyncStatus() {
  if (!syncStatusNode) {
    return;
  }

  try {
    const response = await sendMessage({ type: "GET_SYNC_STATUS" });
    syncStatusNode.textContent = formatSyncStatusSummary(response);
  } catch (error) {
    logger.warn("Failed to load sync status:", error);
    syncStatusNode.textContent = "";
  }
}

// 检查登录状态并渲染相应界面
async function checkAuthAndRender() {
  try {
    const authStatus = await sendMessage({ type: "AUTH_STATUS" });
    const authRequired = document.getElementById('auth-required');
    const mainContent = document.getElementById('main-content');
    const isLoggedIn = authStatus.isLoggedIn;

    if (isLoggedIn) {
      // 已登录，显示主内容
      authRequired.style.display = 'none';
      mainContent.style.display = 'block';
      await loadBooks();
      await loadWords();
    } else {
      // 未登录，显示登录提示
      authRequired.style.display = 'block';
      mainContent.style.display = 'none';
    }
  } catch (error) {
    // 出错时默认显示登录提示
    logger.warn("检查登录状态失败：", error);
    const authRequired = document.getElementById('auth-required');
    const mainContent = document.getElementById('main-content');
    authRequired.style.display = 'block';
    mainContent.style.display = 'none';
  }
}

