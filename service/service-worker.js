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
import { translateWord } from '../lib/translator.js';
import {
  selectPreferredSyncBook,
  normalizeContextValue,
  normalizeSourceLinkValue,
} from '../lib/utils.js';
import { DEFAULT_SYNC_BASE_URL } from '../lib/constants.js';
import { MESSAGE_TYPES } from '../lib/messaging.js';

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
    case MESSAGE_TYPES.SAVE_WORD:
      return handleSaveWord(message.entry || message.word);
    case MESSAGE_TYPES.DELETE_WORD:
      return handleDeleteWord(message.id || message.wordId);
    case MESSAGE_TYPES.GET_WORDS:
      await syncForRead();
      return { words: await searchWords(message.query || '') };
    case MESSAGE_TYPES.GET_BOOKS:
      await syncForRead();
      return { books: await getBooks() };
    case MESSAGE_TYPES.GET_BOOK_WORDS:
      await syncForRead();
      return { words: await getWordsByBook(message.bookId, message.query || '') };
    case MESSAGE_TYPES.EXPORT_WORDS:
      return handleExportWords(message.format || 'json');
    case MESSAGE_TYPES.GET_SETTINGS:
      return { settings: await getSettings() };
    case MESSAGE_TYPES.SAVE_SETTINGS:
      return { settings: await saveSettings(message.settings || {}) };
    case MESSAGE_TYPES.SYNC_NOW:
    case MESSAGE_TYPES.TRIGGER_SYNC:
      return { sync: await handleSyncNow() };
    case MESSAGE_TYPES.GET_SYNC_STATUS:
      return handleGetSyncStatus();
    case MESSAGE_TYPES.AUTH_LOGIN:
      return handleAuthLogin(message.email, message.password, message.baseUrl);
    case MESSAGE_TYPES.AUTH_REGISTER:
      return handleAuthRegister(message.email, message.password, message.baseUrl);
    case MESSAGE_TYPES.AUTH_LOGOUT:
      return handleAuthLogout();
    case MESSAGE_TYPES.AUTH_STATUS:
      return handleAuthStatus();
    case MESSAGE_TYPES.TRANSLATE:
      return handleTranslate(message.word);
    case MESSAGE_TYPES.PING:
      return { pong: true };
    default:
      throw new Error(`未知消息类型：${message?.type || 'EMPTY'}`);
  }
}

async function handleSaveWord(entry) {
  if (!entry?.word) {
    throw new Error('单词内容不能为空');
  }

  const auth = await getAuthData();
  const settings = await getSettings();
  
  // 检查是否启用了同步且已登录
  const syncEnabled = settings.syncEnabled !== false;
  const isLoggedIn = Boolean(auth?.accessToken && auth?.refreshToken);

  // 如果启用了同步但未登录，提示用户
  if (syncEnabled && !isLoggedIn) {
    throw new Error('请先登录才能添加单词');
  }

  // 登录后先拉取一次远端单词本，确保新增单词能直接落到当前同步单词本中。
  if (isLoggedIn) {
    await syncForRead(settings);
  }

  const existingWords = await getWords();
  const incomingContexts = Array.isArray(entry.contexts) ? entry.contexts : [];
  const duplicateEntry = existingWords.find((item) => {
    const sameWord = normalizeWordValue(item?.word) === normalizeWordValue(entry.word);
    if (!sameWord) return false;

    const existingContexts = Array.isArray(item.contexts) ? item.contexts : [];
    if (incomingContexts.length === 0) {
      return true;
    }

    return incomingContexts.every((incomingContext) =>
      existingContexts.some((existingContext) =>
        normalizeContextValue(existingContext?.context) === normalizeContextValue(incomingContext?.context) &&
        normalizeSourceLinkValue(existingContext) === normalizeSourceLinkValue(incomingContext)
      )
    );
  });
  const duplicate = Boolean(duplicateEntry);

  if (duplicate) {
    return {
      saved: true,
      duplicate: true,
      entry: duplicateEntry,
      sync: { ok: true, skipped: true, queueSize: 0 },
    };
  }

  const result = await addWord(entry);

  if (result.duplicate) {
    return {
      saved: true,
      duplicate: true,
      entry: result.entry,
      sync: { ok: true, skipped: true, queueSize: 0 },
    };
  }
  
  // 只有在已登录时才尝试同步
  if (isLoggedIn) {
    await enqueueSyncEntry(result.entry || entry);
    const sync = await flushSyncQueue(settings);
    return {
      saved: Boolean(result.success),
      duplicate,
      entry: result.entry,
      sync,
    };
  }

  return {
    saved: Boolean(result.success),
    duplicate,
    entry: result.entry,
    sync: { ok: false, skipped: true, queueSize: 0 },
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
  const nextEntry = {
    ...entry,
    id: entry.id || entry._legacy?.id || `${entry.word}-${entry.timeAdded || Date.now()}`,
  };
  const nextKey = getQueuedWordKey(nextEntry);
  const dedupedQueue = queue.filter((item) => getQueuedWordKey(item) !== nextKey);
  await setSyncQueue([nextEntry, ...dedupedQueue].slice(0, 500));
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
  return (settingsBaseUrl || DEFAULT_SYNC_BASE_URL).replace(/\/+$/, '');
}

function normalizeWordValue(word) {
  return String(word || '').trim().toLowerCase();
}

function normalizeBookValue(bookId) {
  const trimmed = String(bookId || '').trim();
  return trimmed || '__sync_book__';
}

function getQueuedWordKey(entry) {
  return `${normalizeWordValue(entry?.word)}::${normalizeBookValue(entry?.bookId)}`;
}

async function syncForRead(settingsOverride) {
  const auth = await getAuthData();
  if (!auth?.accessToken || !auth?.refreshToken) {
    return;
  }
  if (isSyncing) {
    return;
  }

  const settings = settingsOverride || (await getSettings());
  await flushSyncQueue(settings);
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

  // 从缓存的单词本中查找同步单词本，为缺少 bookId 的条目自动分配
  let syncBook = null;
  const cachedBooks = await getBooks();
  syncBook = selectPreferredSyncBook(cachedBooks);

  // 如果缓存中没有同步单词本，尝试从服务器获取
  if (!syncBook) {
    try {
      const booksRes = await fetch(`${baseUrl}/api/v1/books`, {
        headers: { Authorization: `Bearer ${auth.accessToken}` },
      });
      if (booksRes.ok) {
        const serverBooks = await booksRes.json();
        const serverSyncBook = Array.isArray(serverBooks)
          ? serverBooks.find((b) => b.is_sync)
          : null;
        if (serverSyncBook) {
          syncBook = { id: serverSyncBook.id, isSync: true };
          // 同时更新本地缓存
          await saveBooks(serverBooks.map(mapServerBookToLocal));
        }
      }
    } catch (err) {
      console.warn('[pushWords] 无法从服务器获取单词本:', err.message);
    }
  }

  const payload = syncQueue
    .map((item) => {
      const mapped = mapLocalWordToServer(item);
      const bookId = mapped.book_id;
      // 自动分配 book_id：如果未设置或是无效值，使用缓存中的同步单词本 ID
      if ((!bookId || bookId === 'local_default_book' || bookId.length < 10) && syncBook) {
        mapped.book_id = syncBook.id;
      }
      return mapped;
    })
    .filter((item) => typeof item.book_id === 'string' && item.book_id.length > 20)
    .reduce((list, item) => {
      const key = `${normalizeWordValue(item.word)}::${normalizeBookValue(item.book_id)}`;
      const index = list.findIndex((candidate) => `${normalizeWordValue(candidate.word)}::${normalizeBookValue(candidate.book_id)}` === key);
      if (index === -1) {
        list.push(item);
      } else {
        list[index] = item;
      }
      return list;
    }, []); // 合并同一单词/单词本的重复推送，避免服务端 upsert 冲突。

  if (payload.length === 0) {
    console.warn('[pushWords] 无法同步单词：没有可用的 book_id，已缓存待下次同步');
    return { ok: false, error: 'no_book_id', queueSize: syncQueue.length };
  }

  console.log(`[pushWords] 准备同步 ${payload.length} 个单词，book_id: ${payload[0]?.book_id}`);

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

  // 只清除已成功同步的词条
  const syncedWordKeys = new Set(
    payload.map((item) => `${normalizeWordValue(item.word)}::${normalizeBookValue(item.book_id)}`)
  );
  if (syncedWordKeys.size > 0) {
    await setSyncQueue(
      syncQueue.filter((item) => {
        const bookId = item.bookId || syncBook?.id || '';
        const key = `${normalizeWordValue(item.word)}::${normalizeBookValue(bookId)}`;
        return !syncedWordKeys.has(key);
      })
    );
    console.log(`[pushWords] 同步完成，清除 ${syncedWordKeys.size} 条，队列剩余 ${Math.max(0, syncQueue.length - syncedWordKeys.size)} 条`);
  }

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
      await pushDeletes(currentAuth, settings);
      await pushWords(currentAuth, settings);
      await pullChanges(currentAuth, settings);
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

      await pushDeletes(currentAuth, settings);
      await pushWords(currentAuth, settings);
      await pullChanges(currentAuth, settings);
    }
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

// 存储当前登录用户的唯一标识（用于检测用户切换）
const STORAGE_CURRENT_USER_EMAIL = 'currentUserEmail';

async function getCurrentUserEmail() {
  const data = await chrome.storage.local.get([STORAGE_CURRENT_USER_EMAIL]);
  return data[STORAGE_CURRENT_USER_EMAIL] || null;
}

async function setCurrentUserEmail(email) {
  await chrome.storage.local.set({ [STORAGE_CURRENT_USER_EMAIL]: email });
}

// 清空用户数据（在切换用户或登出时调用）
async function clearUserData() {
  await chrome.storage.local.remove([
    'words',
    'books',
    'syncQueue',
    'deleteQueue',
    STORAGE_SYNC_QUEUE,
    STORAGE_DELETE_QUEUE,
  ]);
}

async function handleAuthLogin(email, password, baseUrl) {
  const normalizedUrl = (baseUrl || 'http://localhost:3001').trim().replace(/\/+$/, '');
  const result = await doLoginOrRegister(normalizedUrl, 'login', email, password);
  
  if (result.ok && result.accessToken && result.refreshToken) {
    const previousEmail = await getCurrentUserEmail();
    const newEmail = result.user?.email || email;
    
    // 如果用户切换了账号，清空旧数据
    if (previousEmail && previousEmail !== newEmail) {
      await clearUserData();
    }
    
    await setCurrentUserEmail(newEmail);
    await setAuthData({
      accessToken: result.accessToken,
      refreshToken: result.refreshToken,
      user: result.user,
      baseUrl: normalizedUrl,
      lastSyncAt: Date.now(),
    });
    await setupAlarms();
    // 立即拉取新用户的数据
    await flushSyncQueue(await getSettings());
  }
  return result;
}

async function handleAuthRegister(email, password, baseUrl) {
  const normalizedUrl = (baseUrl || 'http://localhost:3001').trim().replace(/\/+$/, '');
  const result = await doLoginOrRegister(normalizedUrl, 'register', email, password);
  
  if (result.ok && result.accessToken && result.refreshToken) {
    const previousEmail = await getCurrentUserEmail();
    const newEmail = result.user?.email || email;
    
    // 如果用户切换了账号，清空旧数据
    if (previousEmail && previousEmail !== newEmail) {
      await clearUserData();
    }
    
    await setCurrentUserEmail(newEmail);
    await setAuthData({
      accessToken: result.accessToken,
      refreshToken: result.refreshToken,
      user: result.user,
      baseUrl: normalizedUrl,
      lastSyncAt: Date.now(),
    });
    await setupAlarms();
    // 立即拉取新用户的数据
    await flushSyncQueue(await getSettings());
  }
  return result;
}

async function handleAuthLogout() {
  await setAuthData(null);
  await setCurrentUserEmail(null);
  // 登出时清空数据，但注意不要清空设置
  await clearUserData();
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

async function handleTranslate(word) {
  if (!word || !word.trim()) {
    throw new Error('待翻译单词不能为空');
  }
  const settings = await getSettings();
  const translation = await translateWord(word, settings);
  return { translation };
}
