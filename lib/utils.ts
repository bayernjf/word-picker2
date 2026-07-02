import browser from "webextension-polyfill";
import { DEFAULT_BOOK_NAME } from "./constants.js";

export function escapeHtml(value: unknown): string {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export interface MessageResponse {
  success: boolean;
  error?: string;
  [key: string]: unknown;
}

export function sendMessage<TResponse extends { success: boolean; error?: string } = MessageResponse>(message: object): Promise<TResponse> {
  return browser.runtime.sendMessage(message).then((response) => {
    const res = response as TResponse;
    if (!res?.success) {
      throw new Error(res?.error || "扩展消息请求失败");
    }
    return res;
  });
}

export function formatDate(timeValue: number | string): string {
  if (!timeValue) {
    return "未知";
  }

  let date: Date;
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
    hour12: false,
  });
}

export interface SyncStatus {
  syncQueueSize?: number;
  pendingSyncCount?: number;
  queueSize?: number;
  deleteQueueSize?: number;
  pendingDeleteCount?: number;
  lastSyncAt?: number;
}

export function formatSyncStatusSummary(status: SyncStatus = {}): string {
  const syncQueueSize = readQueueCount(
    status.syncQueueSize,
    status.pendingSyncCount,
    status.queueSize
  );
  const deleteQueueSize = readQueueCount(status.deleteQueueSize, status.pendingDeleteCount, 0);
  const lastSyncAt = status.lastSyncAt ? formatDate(status.lastSyncAt) : "从未同步";

  return `待同步 ${syncQueueSize} 条 ｜ 待删除 ${deleteQueueSize} 条 ｜ 最后同步：${lastSyncAt}`;
}

function readQueueCount(...values: (number | undefined)[]): number {
  for (const value of values) {
    const count = Number(value);
    if (Number.isFinite(count)) {
      return Math.max(0, Math.trunc(count));
    }
  }
  return 0;
}

export function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.max(min, Math.min(max, parsed));
}

export function normalizeContextValue(context: unknown): string {
  return String(context || "").trim().replace(/\s+/g, " ");
}

export interface ContextEntry {
  context?: string;
  sourceLink?: string;
  source_link?: string;
  sourceUrl?: string;
  source_url?: string;
}

export function normalizeSourceLinkValue(context: ContextEntry): string {
  const raw = String(
    context?.sourceLink ||
    context?.source_link ||
    context?.sourceUrl ||
    context?.source_url ||
    ""
  ).trim();
  // 去掉 URL fragment（#:~:text=...）后再比较，保证 Text Fragment URL
  // 与旧版纯 URL 在去重时被视为同一页面
  try {
    const url = new URL(raw);
    url.hash = '';
    return url.toString();
  } catch {
    return raw;
  }
}

export interface Book {
  id: string;
  name: string;
  description?: string;
  wordCount?: number;
  icon?: string;
  isSync?: boolean;
  updatedAt?: number;
  createdAt?: number;
}

export function selectPreferredSyncBook(books: Book[]): Book | null {
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
