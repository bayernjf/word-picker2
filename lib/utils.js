import { DEFAULT_BOOK_NAME } from "./constants.js";

export function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function sendMessage(message) {
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

export function formatDate(timeValue) {
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

export function clampNumber(value, min, max, fallback) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.max(min, Math.min(max, parsed));
}

export function normalizeContextValue(context) {
  return String(context || "").trim().replace(/\s+/g, " ");
}

export function normalizeSourceLinkValue(context) {
  return String(
    context?.sourceLink ||
    context?.source_link ||
    context?.sourceUrl ||
    context?.source_url ||
    ""
  ).trim();
}

export function selectPreferredSyncBook(books) {
  return [...books]
    .filter((book) => book?.isSync)
    .sort((left, right) => {
      const leftIsDefault = left.name === DEFAULT_BOOK_NAME;
      const rightIsDefault = right.name === DEFAULT_BOOK_NAME;
      if (leftIsDefault !== rightIsDefault) {
        return leftIsDefault ? 1 : -1;
      }

      const leftUpdated = Number(left.updatedAt) || Number(left.createdAt) || 0;
      const rightUpdated = Number(right.updatedAt) || Number(right.createdAt) || 0;
      return rightUpdated - leftUpdated;
    })[0] || null;
}
