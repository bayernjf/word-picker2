import {
  addWord,
  deleteWordById,
  ensureDefaults,
  getBooks,
  getSettings,
  getWords,
  getWordsByBook,
  saveBooks,
  saveSettings,
  saveWords,
  searchWords,
} from '../lib/storage.js';

const STORAGE_DEVICE_ID = 'deviceId';
const STORAGE_SYNC_QUEUE = 'syncQueue';
const STORAGE_DELETE_QUEUE = 'deleteQueue';
const STORAGE_AUTH = 'authData';

let isSyncing = false;

chrome.runtime.onInstalled.addListener(() => {
  void ensureDefaults();
  void setupAlarms();
});

chrome.runtime.onStartup?.addListener(() => {
  void ensureDefaults();
  void setupAlarms();
});

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === 'sync-words') {
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
        error: error instanceof Error ? error.message : String(error),
      });
    });

  return true;
});

async function handleMessage(message) {
  await ensureDefaults();

  switch (message?.type) {
    case 'SAVE_WORD':
      return handleSaveWord(message.entry || message.word);
    case 'DELETE_WORD':
      return handleDeleteWord(message.id || message.wordId);
    case 'GET_WORDS':
      return { words: await searchWords(message.query || '') };
    case 'GET_BOOKS':
      return { books: await getBooks() };
    case 'GET_BOOK_WORDS':
      return { words: await getWordsByBook(message.bookId, message.query || '') };
    case 'EXPORT_WORDS':
      return handleExportWords(message.format || 'json');
    case 'GET_SETTINGS':
      return { settings: await getSettings() };
    case 'SAVE_SETTINGS':
      return { settings: await saveSettings(message.settings || {}) };
    case 'SYNC_NOW':
    case 'TRIGGER_SYNC':
      return { sync: await handleSyncNow() };
    case 'GET_SYNC_STATUS':
      return handleGetSyncStatus();
    case 'AUTH_LOGIN':
      return handleAuthLogin(message.email, message.password, message.baseUrl);
    case 'AUTH_REGISTER':
      return handleAuthRegister(message.email, message.password, message.baseUrl);
    case 'AUTH_LOGOUT':
      return handleAuthLogout();
    case 'AUTH_STATUS':
      return handleAuthStatus();
    case 'PING':
      return { pong: true };
    default:
      throw new Error(`未知消息类型：${message?.type || 'EMPTY'}`);
  }
}

async function handleSaveWord(entry) {
  if (!entry?.word) {
    throw new Error('单词内容不能为空');
  }

  const existingWords = await getWords();
  const duplicate = existingWords.some(
    (item) => String(item?.word || '').toLowerCase() === String(entry.word || '').toLowerCase()
  );

  const result = await addWord(entry);
  await enqueueSyncEntry(result.entry || entry);
  const sync = await flushSyncQueue(await getSettings());

  return {
    saved: Boolean(result.success),
    duplicate,
    entry: result.entry,
    sync,
  };
}

async function handleDeleteWord(id) {
  if (!id) {
    throw new Error('缺少单词 id');
  }

  const result = await deleteWordById(id);
  if (result.success) {
    await enqueueDelete(id);
  }

  const sync = await flushSyncQueue(await getSettings());
  return {
    deleted: Boolean(result.success),
    sync,
  };
}

async function handleExportWords(format) {
  const words = await getWords();
  const normalized = String(format || 'json').toLowerCase();

  if (normalized === 'csv') {
    return {
      format: 'csv',
      fileName: 'wordcatcher-words.csv',
      data: toCsv(words),
    };
  }

  return {
    format: 'json',
    fileName: 'wordcatcher-words.json',
    data: JSON.stringify({ words }, null, 2),
  };
}

function toCsv(words) {
  const headers = ['word', 'frequency', 'translation', 'timeAdded', 'timeUpdated', 'contextCount'];
  const lines = [headers.join(',')];
  words.forEach((word) => {
    const contextCount = (word.contexts?.length || 0).toString();
    lines.push(
      headers
        .map((header) => {
          if (header === 'contextCount') {
            return csvEscape(contextCount);
          }
          return csvEscape(word[header] ?? word._legacy?.[header] ?? '');
        })
        .join(',')
    );
  });
  return lines.join('\n');
}

function csvEscape(value) {
  const text = String(value).replace(/"/g, '""');
  return `"${text}"`;
}

async function handleSyncNow() {
  return flushSyncQueue(await getSettings());
}

async function handleGetSyncStatus() {
  const auth = await getAuthData();
  const deviceId = await ensureDeviceId();
  const syncQueue = await getSyncQueue();
  const deleteQueue = await getDeleteQueue();

  return {
    deviceId,
    queueSize: syncQueue.length + deleteQueue.length,
    isLoggedIn: Boolean(auth?.accessToken && auth?.refreshToken),
    user: auth?.user || null,
    lastSyncAt: auth?.lastSyncAt || null,
  };
}

async function setupAlarms() {
  const existing = await chrome.alarms.get('sync-words');
  if (!existing) {
    await chrome.alarms.create('sync-words', { periodInMinutes: 3 });
  }
}

async function ensureDeviceId() {
  const current = await chrome.storage.local.get([STORAGE_DEVICE_ID]);
  const existing = typeof current?.[STORAGE_DEVICE_ID] === 'string' ? current[STORAGE_DEVICE_ID].trim() : '';
  if (existing) {
    return existing;
  }
  const next = globalThis.crypto?.randomUUID
    ? globalThis.crypto.randomUUID()
    : `device-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  await chrome.storage.local.set({ [STORAGE_DEVICE_ID]: next });
  return next;
}

async function getQueue(key) {
  const current = await chrome.storage.local.get([key]);
  return Array.isArray(current?.[key]) ? current[key] : [];
}

async function setQueue(key, queue) {
  await chrome.storage.local.set({ [key]: queue });
  return queue;
}

async function getSyncQueue() {
  return getQueue(STORAGE_SYNC_QUEUE);
}

async function setSyncQueue(queue) {
  return setQueue(STORAGE_SYNC_QUEUE, queue);
}

async function getDeleteQueue() {
  return getQueue(STORAGE_DELETE_QUEUE);
}

async function setDeleteQueue(queue) {
  return setQueue(STORAGE_DELETE_QUEUE, queue);
}

async function enqueueSyncEntry(entry) {
  if (!entry?.word) {
    return;
  }
  const queue = await getSyncQueue();
  const entryId = entry.id || entry._legacy?.id || `${entry.word}-${entry.timeAdded || Date.now()}`;
  const exists = queue.some((item) => (item.id || item._legacy?.id) === entryId);
  if (exists) {
    return;
  }
  await setSyncQueue([{ ...entry, id: entryId }, ...queue].slice(0, 500));
}

async function enqueueDelete(wordId) {
  const queue = await getDeleteQueue();
  if (queue.includes(wordId)) {
    return;
  }
  await setDeleteQueue([wordId, ...queue].slice(0, 500));
}

function normalizeBaseUrl(settings, auth) {
  const authBaseUrl = typeof auth?.baseUrl === 'string' ? auth.baseUrl.trim() : '';
  if (authBaseUrl) {
    return authBaseUrl.replace(/\/+$/, '');
  }
  const settingsBaseUrl = typeof settings?.syncBaseUrl === 'string' ? settings.syncBaseUrl.trim() : '';
  return (settingsBaseUrl || 'http://localhost:3001').replace(/\/+$/, '');
}

async function pullChanges(auth, settings) {
  const baseUrl = normalizeBaseUrl(settings, auth);
  const token = auth.accessToken;
  const [booksRes, wordsRes] = await Promise.all([
    fetch(`${baseUrl}/api/v1/books`, { headers: { Authorization: `Bearer ${token}` } }),
    fetch(`${baseUrl}/api/v1/words`, { headers: { Authorization: `Bearer ${token}` } }),
  ]);

  if (booksRes.status === 401 || wordsRes.status === 401) {
    throw new Error('unauthorized');
  }

  if (booksRes.ok) {
    const books = await booksRes.json();
    await saveBooks(Array.isArray(books) ? books.map(mapServerBookToLocal) : []);
  }

  if (wordsRes.ok) {
    const words = await wordsRes.json();
    await saveWords(Array.isArray(words) ? words.map(mapServerWordToLocal) : []);
  }
}

function mapServerBookToLocal(book) {
  return {
    id: book.id,
    name: book.name || '默认',
    description: book.description || '',
    wordCount: Number(book.word_count) || 0,
    icon: book.icon || 'BookOpen',
    isSync: Boolean(book.is_sync),
    createdAt: Date.parse(book.created_at) || Date.now(),
    updatedAt: Date.parse(book.updated_at) || Date.now(),
  };
}

function mapServerWordToLocal(word) {
  const timeAdded = Date.parse(word.time_added || word.created_at) || Date.now();
  const timeUpdated = Date.parse(word.time_updated || word.updated_at) || timeAdded;
  const examples = Array.isArray(word.examples) ? word.examples : [];
  return {
    id: word.id,
    word: word.word || '',
    frequency: Number(word.frequency) || Math.max((word.contexts || []).length || 0, 1),
    translation: word.translation || word.chinese_translation || '',
    timeAdded,
    timeUpdated,
    contexts: Array.isArray(word.contexts) ? word.contexts : [],
    bookId: word.book_id || '',
    _legacy: {
      id: word.id,
      phonetic: word.phonetic || '',
      exampleEn: examples[0]?.en || '',
      exampleZh: examples[0]?.zh || '',
      sourceUrl: word.meta?.sourceUrl || '',
      sourceTitle: word.meta?.sourceTitle || '',
      createdAt: timeAdded,
      reviewCount: 0,
    },
  };
}

function mapLocalWordToServer(word) {
  const timeAdded = word.timeAdded || word._legacy?.createdAt || Date.now();
  const timeUpdated = word.timeUpdated || timeAdded;
  return {
    word: word.word,
    frequency: word.frequency || Math.max((word.contexts || []).length || 0, 1),
    translation: word.translation || '',
    time_added: new Date(timeAdded).toISOString(),
    time_updated: new Date(timeUpdated).toISOString(),
    contexts: Array.isArray(word.contexts) ? word.contexts : [],
    phonetic: word._legacy?.phonetic || '',
    part_of_speech: '',
    definition: word.translation || '',
    chinese_translation: word.translation || '',
    synonyms: [],
    examples:
      word._legacy?.exampleEn || word._legacy?.exampleZh
        ? [
            {
              en: word._legacy?.exampleEn || '',
              zh: word._legacy?.exampleZh || '',
            },
          ]
        : [],
    usage_history: [],
    level: 'B2',
    familiarity: 0,
    book_id: word.bookId,
    meta: {
      sourceUrl: word._legacy?.sourceUrl || '',
      sourceTitle: word._legacy?.sourceTitle || '',
      createdAt: timeAdded,
    },
  };
}

async function pushDeletes(auth, settings) {
  const deleteQueue = await getDeleteQueue();
  if (deleteQueue.length === 0) {
    return { ok: true, processed: 0 };
  }

  const baseUrl = normalizeBaseUrl(settings, auth);
  const response = await fetch(`${baseUrl}/api/v1/words/batch-delete`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${auth.accessToken}`,
    },
    body: JSON.stringify({ wordIds: deleteQueue }),
  });

  if (response.status === 401) {
    throw new Error('unauthorized');
  }
  if (!response.ok) {
    const text = await response.text();
    throw new Error(text || 'delete_sync_failed');
  }

  await setDeleteQueue([]);
  return { ok: true, processed: deleteQueue.length };
}

async function pushWords(auth, settings) {
  const syncQueue = await getSyncQueue();
  if (syncQueue.length === 0) {
    return { ok: true, processed: 0 };
  }

  const baseUrl = normalizeBaseUrl(settings, auth);
  const payload = syncQueue.map(mapLocalWordToServer).filter((item) => item.book_id);
  if (payload.length === 0) {
    await setSyncQueue([]);
    return { ok: true, processed: 0 };
  }

  const response = await fetch(`${baseUrl}/api/v1/words/batch`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${auth.accessToken}`,
    },
    body: JSON.stringify({ words: payload }),
  });

  if (response.status === 401) {
    throw new Error('unauthorized');
  }
  if (!response.ok) {
    const text = await response.text();
    throw new Error(text || 'word_sync_failed');
  }

  await setSyncQueue([]);
  return { ok: true, processed: payload.length };
}

async function flushSyncQueue(settings) {
  const auth = await getAuthData();
  if (!auth?.accessToken || !auth?.refreshToken) {
    const queueSize = (await getSyncQueue()).length + (await getDeleteQueue()).length;
    return { ok: false, skipped: true, queueSize };
  }

  if (isSyncing) {
    return { ok: false, skipped: true, queueSize: (await getSyncQueue()).length + (await getDeleteQueue()).length };
  }

  isSyncing = true;
  try {
    let currentAuth = auth;

    try {
      await pullChanges(currentAuth, settings);
      await pushDeletes(currentAuth, settings);
      await pushWords(currentAuth, settings);
    } catch (error) {
      if (String(error?.message || error) !== 'unauthorized') {
        throw error;
      }

      const refreshed = await doRefreshToken(normalizeBaseUrl(settings, currentAuth), currentAuth.refreshToken);
      if (!refreshed.ok || !refreshed.accessToken) {
        await setAuthData(null);
        return { ok: false, error: refreshed.error || 'token_refresh_failed', queueSize: (await getSyncQueue()).length };
      }

      currentAuth = {
        ...currentAuth,
        accessToken: refreshed.accessToken,
        refreshToken: refreshed.refreshToken || currentAuth.refreshToken,
        user: refreshed.user || currentAuth.user,
      };
      await setAuthData({ ...currentAuth, lastSyncAt: Date.now() });

      await pullChanges(currentAuth, settings);
      await pushDeletes(currentAuth, settings);
      await pushWords(currentAuth, settings);
    }

    await pullChanges(currentAuth, settings);
    await setAuthData({ ...currentAuth, lastSyncAt: Date.now() });

    return {
      ok: true,
      processed: 1,
      queueSize: (await getSyncQueue()).length + (await getDeleteQueue()).length,
    };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
      queueSize: (await getSyncQueue()).length + (await getDeleteQueue()).length,
    };
  } finally {
    isSyncing = false;
  }
}

async function getAuthData() {
  const data = await chrome.storage.local.get([STORAGE_AUTH]);
  const auth = data?.[STORAGE_AUTH];
  return auth && typeof auth === 'object' ? auth : null;
}

async function setAuthData(auth) {
  await chrome.storage.local.set({ [STORAGE_AUTH]: auth });
}

async function handleAuthLogin(email, password, baseUrl) {
  const normalizedUrl = (baseUrl || 'http://localhost:3001').trim().replace(/\/+$/, '');
  const result = await doLoginOrRegister(normalizedUrl, 'login', email, password);
  if (result.ok && result.accessToken && result.refreshToken) {
    await setAuthData({
      accessToken: result.accessToken,
      refreshToken: result.refreshToken,
      user: result.user,
      baseUrl: normalizedUrl,
      lastSyncAt: Date.now(),
    });
    await setupAlarms();
    await flushSyncQueue(await getSettings());
  }
  return result;
}

async function handleAuthRegister(email, password, baseUrl) {
  const normalizedUrl = (baseUrl || 'http://localhost:3001').trim().replace(/\/+$/, '');
  const result = await doLoginOrRegister(normalizedUrl, 'register', email, password);
  if (result.ok && result.accessToken && result.refreshToken) {
    await setAuthData({
      accessToken: result.accessToken,
      refreshToken: result.refreshToken,
      user: result.user,
      baseUrl: normalizedUrl,
      lastSyncAt: Date.now(),
    });
    await setupAlarms();
    await flushSyncQueue(await getSettings());
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
    baseUrl: auth?.baseUrl || '',
  };
}

async function doLoginOrRegister(baseUrl, type, email, password) {
  const endpoint = type === 'login' ? '/api/v1/auth/login' : '/api/v1/auth/register';
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);

  try {
    const response = await fetch(`${baseUrl}${endpoint}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
      signal: controller.signal,
    });
    const text = await response.text();

    if (!response.ok) {
      return { ok: false, status: response.status, error: text || 'request_failed' };
    }

    const data = text ? JSON.parse(text) : null;
    if (!data?.accessToken || !data?.refreshToken) {
      return { ok: false, error: 'invalid_response' };
    }

    return {
      ok: true,
      accessToken: data.accessToken,
      refreshToken: data.refreshToken,
      user: data.user || null,
    };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  } finally {
    clearTimeout(timeout);
  }
}

async function doRefreshToken(baseUrl, refreshToken) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);

  try {
    const response = await fetch(`${baseUrl}/api/v1/auth/refresh`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refreshToken }),
      signal: controller.signal,
    });
    const text = await response.text();

    if (!response.ok) {
      return { ok: false, status: response.status, error: text || 'refresh_failed' };
    }

    const data = text ? JSON.parse(text) : null;
    if (!data?.accessToken) {
      return { ok: false, error: 'invalid_refresh_response' };
    }

    return {
      ok: true,
      accessToken: data.accessToken,
      refreshToken: data.refreshToken || refreshToken,
      user: data.user || null,
    };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  } finally {
    clearTimeout(timeout);
  }
}
