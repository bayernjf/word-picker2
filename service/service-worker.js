import { getCachedTranslation, setCachedTranslation } from "../lib/cache.js";
import {
  addWord,
  deleteWordById,
  ensureDefaults,
  getSettings,
  getWords,
  saveSettings,
  searchWords
} from "../lib/storage.js";
import { translateWord } from "../lib/translator.js";

const STORAGE_DEVICE_ID = "deviceId";
const STORAGE_SYNC_QUEUE = "syncQueue";
const STORAGE_AUTH = "authData";

let authRefreshing = false;

chrome.runtime.onInstalled.addListener(() => {
  ensureDefaults();
  setupAlarms();
});

chrome.runtime.onStartup?.addListener(() => {
  ensureDefaults();
  setupAlarms();
});

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === "sync-words") {
    const settings = await getSettings();
    await flushSyncQueue(settings);
  }
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  handleMessage(message)
    .then((payload) => sendResponse({ success: true, ...payload }))
    .catch((error) => {
      sendResponse({
        success: false,
        error: error instanceof Error ? error.message : String(error)
      });
    });

  return true;
});

async function handleMessage(message) {
  await ensureDefaults();

  switch (message?.type) {
    case "TRANSLATE":
      return handleTranslate(message.word);
    case "SAVE_WORD":
      return handleSaveWord(message.entry);
    case "DELETE_WORD":
      return handleDeleteWord(message.id);
    case "GET_WORDS":
      return { words: await searchWords(message.query || "") };
    case "EXPORT_WORDS":
      return handleExportWords(message.format || "json");
    case "GET_SETTINGS":
      return { settings: await getSettings() };
    case "SAVE_SETTINGS":
      return { settings: await saveSettings(message.settings || {}) };
    case "SYNC_NOW":
      return handleSyncNow();
    case "GET_SYNC_STATUS":
      return handleGetSyncStatus();
    case "PING":
      return { pong: true };
    case "AUTH_LOGIN":
      return handleAuthLogin(message.email, message.password, message.baseUrl);
    case "AUTH_REGISTER":
      return handleAuthRegister(message.email, message.password, message.baseUrl);
    case "AUTH_LOGOUT":
      return handleAuthLogout();
    case "AUTH_STATUS":
      return handleAuthStatus();
    default:
      throw new Error(`未知消息类型：${message?.type || "EMPTY"}`);
  }
}

async function handleTranslate(word) {
  const settings = await getSettings();
  const cached = await getCachedTranslation(word);
  if (cached) {
    return { translation: cached, cached: true };
  }

  const translation = await translateWord(word, settings);
  await setCachedTranslation(word, translation, settings.maxCacheSize || 200);

  return {
    translation,
    cached: false
  };
}

async function handleSaveWord(entry) {
  if (!entry?.word) {
    throw new Error("单词内容不能为空");
  }

  const settings = await getSettings();
  const result = await addWord(entry);

  await enqueueSyncEntry(entry);
  const sync = await flushSyncQueue(settings);

  return {
    saved: Boolean(result.success),
    duplicate: Boolean(result.duplicate),
    entry: result.entry,
    sync
  };
}

async function handleSyncNow() {
  const settings = await getSettings();
  return { sync: await flushSyncQueue(settings) };
}

async function handleGetSyncStatus() {
  const auth = await getAuthData();
  const settings = await getSettings();
  const deviceId = await ensureDeviceId();
  const queue = await getSyncQueue();
  return {
    deviceId,
    queueSize: queue.length,
    isLoggedIn: Boolean(auth?.accessToken && auth?.refreshToken),
    user: auth?.user || null,
    lastSyncAt: auth?.lastSyncAt || null
  };
}

async function ensureDeviceId() {
  const current = await chrome.storage.local.get([STORAGE_DEVICE_ID]);
  const existing = typeof current?.[STORAGE_DEVICE_ID] === "string" ? current[STORAGE_DEVICE_ID].trim() : "";
  if (existing) {
    return existing;
  }
  const next = globalThis.crypto?.randomUUID ? globalThis.crypto.randomUUID() : `device-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  await chrome.storage.local.set({ [STORAGE_DEVICE_ID]: next });
  return next;
}

async function getSyncQueue() {
  const current = await chrome.storage.local.get([STORAGE_SYNC_QUEUE]);
  const queue = current?.[STORAGE_SYNC_QUEUE];
  return Array.isArray(queue) ? queue : [];
}

async function setSyncQueue(queue) {
  await chrome.storage.local.set({ [STORAGE_SYNC_QUEUE]: queue });
  return queue;
}

async function enqueueSyncEntry(entry) {
  if (!entry?.id || !entry?.word) {
    return;
  }
  const queue = await getSyncQueue();
  const exists = queue.some((item) => item?.id === entry.id);
  if (exists) {
    return;
  }
  const next = [entry, ...queue].slice(0, 500);
  await setSyncQueue(next);
}

function normalizeBaseUrl(settings) {
  const shouldSync = Boolean(settings?.syncEnabled) && typeof settings?.syncBaseUrl === "string";
  if (!shouldSync) {
    return "";
  }
  return settings.syncBaseUrl.trim().replace(/\/+$/, "");
}

async function flushSyncQueue(settings) {
  const auth = await getAuthData();
  if (!auth?.accessToken || !auth?.refreshToken || !auth?.baseUrl) {
    const queue = await getSyncQueue();
    return { ok: false, skipped: true, queueSize: queue.length };
  }

  const baseUrl = auth.baseUrl;
  const deviceId = await ensureDeviceId();
  const queue = await getSyncQueue();
  if (queue.length === 0) {
    return { ok: true, queueSize: 0, processed: 0 };
  }

  let token = auth.accessToken;
  const batch = queue.slice(0, 50);
  const payloadEntries = batch.map((entry) => ({
    ...(entry || {}),
    client: {
      deviceId,
      entryId: entry.id
    }
  }));

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);
  try {
    let attempt = 0;
    while (attempt < 2) {
      const res = await fetch(`${baseUrl}/api/v1/words/batch`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          deviceId,
          entries: payloadEntries
        }),
        signal: controller.signal
      });
      const text = await res.text();

      if (res.status === 401) {
        const refreshed = await doRefreshToken(baseUrl, auth.refreshToken);
        if (refreshed.ok && refreshed.accessToken) {
          token = refreshed.accessToken;
          await setAuthData({
            ...auth,
            accessToken: token,
            lastSyncAt: Date.now()
          });
          attempt += 1;
          continue;
        }
        await setAuthData(null);
        return { ok: false, status: 401, error: "token_refresh_failed", queueSize: queue.length };
      }

      if (!res.ok) {
        return { ok: false, status: res.status, error: text || "request_failed", queueSize: queue.length };
      }

      let data = null;
      try {
        data = text ? JSON.parse(text) : null;
      } catch {
        data = null;
      }
      const processedEntryIds = Array.isArray(data?.processedEntryIds) ? data.processedEntryIds : [];
      if (processedEntryIds.length > 0) {
        const processedSet = new Set(processedEntryIds);
        const nextQueue = queue.filter((item) => !processedSet.has(item?.id));
        await setSyncQueue(nextQueue);
        await setAuthData({ ...auth, lastSyncAt: Date.now() });
        return {
          ok: true,
          queueSize: nextQueue.length,
          processed: processedEntryIds.length,
          savedCount: Number.isFinite(data?.savedCount) ? data.savedCount : undefined,
          duplicateCount: Number.isFinite(data?.duplicateCount) ? data.duplicateCount : undefined
        };
      }
      return { ok: true, queueSize: queue.length, processed: 0 };
    }

    return { ok: false, error: "unauthorized", queueSize: queue.length };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error), queueSize: queue.length };
  } finally {
    clearTimeout(timeout);
  }
}

async function claimSyncToken(baseUrl, pairingCode, deviceId) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);
  try {
    const res = await fetch(`${baseUrl}/api/v1/pairing/claim`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code: pairingCode, deviceId }),
      signal: controller.signal
    });
    const text = await res.text();
    if (!res.ok) {
      return { ok: false, status: res.status, error: text || "claim_failed" };
    }
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = null;
    }
    const token = typeof data?.token === "string" ? data.token : "";
    if (!token) {
      return { ok: false, error: "claim_failed" };
    }
    return { ok: true, token };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  } finally {
    clearTimeout(timeout);
  }
}

async function handleDeleteWord(id) {
  const result = await deleteWordById(id);
  return {
    deleted: Boolean(result.success)
  };
}

async function handleExportWords(format) {
  const words = await getWords();
  const normalized = String(format || "json").toLowerCase();

  if (normalized === "csv") {
    return {
      format: "csv",
      fileName: "wordcatcher-words.csv",
      data: toCsv(words)
    };
  }

  return {
    format: "json",
    fileName: "wordcatcher-words.json",
    data: JSON.stringify(words, null, 2)
  };
}

function toCsv(words) {
  const headers = [
    "word",
    "phonetic",
    "meaning",
    "exampleEn",
    "exampleZh",
    "sentence",
    "sourceUrl",
    "sourceTitle",
    "createdAt"
  ];

  const lines = [headers.join(",")];
  words.forEach((word) => {
    lines.push(
      headers
        .map((header) => csvEscape(word[header] ?? ""))
        .join(",")
    );
  });

  return lines.join("\n");
}

function csvEscape(value) {
  const text = String(value).replace(/"/g, "\"\"");
  return `"${text}"`;
}

async function setupAlarms() {
  const existing = await chrome.alarms.get("sync-words");
  if (!existing) {
    await chrome.alarms.create("sync-words", { periodInMinutes: 3 });
  }
}

async function getAuthData() {
  const data = await chrome.storage.local.get([STORAGE_AUTH]);
  const auth = data?.[STORAGE_AUTH];
  return auth && typeof auth === "object" ? auth : null;
}

async function setAuthData(auth) {
  await chrome.storage.local.set({ [STORAGE_AUTH]: auth });
}

async function handleAuthLogin(email, password, baseUrl) {
  const normalizedUrl = baseUrl?.trim().replace(/\/+$/, "") || "http://localhost:3001";
  const result = await doLoginOrRegister(normalizedUrl, "login", email, password);
  if (result.ok && result.accessToken && result.refreshToken) {
    await setAuthData({
      accessToken: result.accessToken,
      refreshToken: result.refreshToken,
      user: result.user,
      baseUrl: normalizedUrl,
      lastSyncAt: Date.now()
    });
    await setupAlarms();
    const settings = await getSettings();
    await flushSyncQueue(settings);
  }
  return result;
}

async function handleAuthRegister(email, password, baseUrl) {
  const normalizedUrl = baseUrl?.trim().replace(/\/+$/, "") || "http://localhost:3001";
  const result = await doLoginOrRegister(normalizedUrl, "register", email, password);
  if (result.ok && result.accessToken && result.refreshToken) {
    await setAuthData({
      accessToken: result.accessToken,
      refreshToken: result.refreshToken,
      user: result.user,
      baseUrl: normalizedUrl,
      lastSyncAt: Date.now()
    });
    await setupAlarms();
    const settings = await getSettings();
    await flushSyncQueue(settings);
  }
  return result;
}

async function handleAuthLogout() {
  await setAuthData(null);
  return { ok: true };
}

async function handleAuthStatus() {
  const auth = await getAuthData();
  return {
    ok: true,
    isLoggedIn: Boolean(auth?.accessToken && auth?.refreshToken),
    user: auth?.user || null,
    baseUrl: auth?.baseUrl || ""
  };
}

async function doLoginOrRegister(baseUrl, type, email, password) {
  const endpoint = type === "login" ? "/api/v1/auth/login" : "/api/v1/auth/register";
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);
  try {
    const res = await fetch(`${baseUrl}${endpoint}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password }),
      signal: controller.signal
    });
    const text = await res.text();
    clearTimeout(timeout);
    if (!res.ok) {
      return { ok: false, status: res.status, error: text || "request_failed" };
    }
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = null;
    }
    if (!data || !data.accessToken || !data.refreshToken) {
      return { ok: false, error: "invalid_response" };
    }
    return { ok: true, accessToken: data.accessToken, refreshToken: data.refreshToken, user: data.user };
  } catch (error) {
    clearTimeout(timeout);
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

async function ensureValidAccessToken(baseUrl) {
  const auth = await getAuthData();
  if (!auth?.accessToken || !auth?.refreshToken) {
    return null;
  }
  if (!authRefreshing) {
    return auth.accessToken;
  }
  const isExpired = auth.expiresAt && Number(auth.expiresAt) < Date.now();
  if (!isExpired) {
    return auth.accessToken;
  }
  authRefreshing = true;
  try {
    const result = await doRefreshToken(baseUrl, auth.refreshToken);
    if (result.ok && result.accessToken) {
      await setAuthData({
        ...auth,
        accessToken: result.accessToken,
        lastSyncAt: Date.now(),
        expiresAt: Date.now() + 23 * 60 * 60 * 1000
      });
      return result.accessToken;
    }
    return null;
  } finally {
    authRefreshing = false;
  }
}

async function doRefreshToken(baseUrl, refreshToken) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);
  try {
    const res = await fetch(`${baseUrl}/api/v1/auth/refresh`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ refreshToken }),
      signal: controller.signal
    });
    const text = await res.text();
    clearTimeout(timeout);
    if (!res.ok) {
      return { ok: false, status: res.status, error: text || "refresh_failed" };
    }
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = null;
    }
    if (!data?.accessToken) {
      return { ok: false, error: "invalid_refresh_response" };
    }
    return { ok: true, accessToken: data.accessToken, user: data.user };
  } catch (error) {
    clearTimeout(timeout);
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}
