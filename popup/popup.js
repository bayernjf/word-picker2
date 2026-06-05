const searchInput = document.getElementById("search-input");
const wordList = document.getElementById("word-list");
const statusNode = document.getElementById("status");
const exportJsonButton = document.getElementById("export-json");
const exportCsvButton = document.getElementById("export-csv");

document.addEventListener("DOMContentLoaded", () => {
  bindEvents();
  loadWords();
});

function bindEvents() {
  searchInput.addEventListener("input", () => {
    loadWords(searchInput.value);
  });

  exportJsonButton.addEventListener("click", () => {
    exportWords("json");
  });

  exportCsvButton.addEventListener("click", () => {
    exportWords("csv");
  });
}

async function loadWords(query = "") {
  setStatus("加载中...");

  try {
    const response = await sendMessage({
      type: "GET_WORDS",
      query
    });
    renderList(response.words || []);
    setStatus(`共 ${response.words?.length || 0} 条记录`);
  } catch (error) {
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
        loadWords(searchInput.value);
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

function truncate(value, maxLength) {
  if (value.length <= maxLength) {
    return value;
  }
  return `${value.slice(0, maxLength - 1)}...`;
}

function formatDate(timeValue) {
  if (!timeValue) {
    return "未知";
  }
  let date;
  if (typeof timeValue === "number") {
    date = new Date(timeValue);
  } else if (typeof timeValue === "string") {
    date = new Date(timeValue);
  } else {
    return "未知";
  }
  
  if (isNaN(date.getTime())) {
    return "未知";
  }
  
  return date.toLocaleString("zh-CN", {
    hour12: false
  });
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
