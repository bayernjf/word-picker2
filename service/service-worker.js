import {
  addWord,
  deleteWordById,
  ensureDefaults,
  getBooks,
  getCacheMap,
  getSettings,
  getWords,
  getWordsByBook,
  saveBooks,
  saveCacheMap,
  saveSettings,
  saveWords,
  searchWords,
} from '../lib/storage.js';
import { translateWord } from '../lib/translator.js';
import { ensureDictImported, lookupOffline } from '../lib/offlineDict.js';
import {
  selectPreferredSyncBook,
  normalizeContextValue,
  normalizeSourceLinkValue,
} from '../lib/utils.js';
import { DEFAULT_SYNC_BASE_URL } from '../lib/constants.js';
import { MESSAGE_TYPES } from '../lib/messaging.js';
import { createLogger } from '../lib/logger.js';

const logger = createLogger('service-worker');

const STORAGE_DEVICE_ID = 'deviceId';
const STORAGE_SYNC_QUEUE = 'syncQueue';
const STORAGE_DELETE_QUEUE = 'deleteQueue';
const STORAGE_AUTH = 'authData';

let isSyncing = false;

chrome.runtime.onInstalled.addListener(() => {
  void ensureDefaults();
  void setupAlarms();
  void ensureDictImported();
});

chrome.runtime.onStartup?.addListener(() => {
  void ensureDefaults();
  void setupAlarms();
  void ensureDictImported();
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
  logger.debug('handleMessage', { type: message?.type });

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
    case MESSAGE_TYPES.AUTH_SET_REMEMBER:
      return handleAuthSetRemember(message.remember);
    case MESSAGE_TYPES.AUTH_GET_CREDENTIALS:
      return handleAuthGetCredentials();
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

  // 规范化：将单词首字母转为小写（仅当首字母为大写时）
  entry = { ...entry, word: lowercaseFirstLetter(entry.word) };
  logger.debug('handleSaveWord', { word: entry.word, bookId: entry.bookId });

  const auth = await getAuthData();
  const settings = await getSettings();
  
  // 检查是否启用了同步且已登录
  const syncEnabled = settings.syncEnabled !== false;
  const isLoggedIn = Boolean(auth?.accessToken && auth?.refreshToken);

  // 如果启用了同步但未登录，提示用户
  if (syncEnabled && !isLoggedIn) {
    throw new Error('请先登录才能添加单词');
  }

  // 仅当本地尚无任何单词本时，才同步拉取一次（首次冷启动需要拿到同步单词本 ID）。
  // 之后的保存不再被「保存前全量拉取」阻塞，避免每次添加都等一次网络往返。
  if (isLoggedIn) {
    const localBooks = await getBooks();
    if (!Array.isArray(localBooks) || localBooks.length === 0) {
      await syncForRead(settings);
    }
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
    logger.info('handleSaveWord duplicate skipped', { word: entry.word });
    return {
      saved: true,
      duplicate: true,
      entry: duplicateEntry,
      sync: { ok: true, skipped: true, queueSize: 0 },
    };
  }

  const result = await addWord(entry);

  if (result.duplicate) {
    logger.info('handleSaveWord duplicate skipped (after add)', { word: entry.word });
    return {
      saved: true,
      duplicate: true,
      entry: result.entry,
      sync: { ok: true, skipped: true, queueSize: 0 },
    };
  }
  
  // 只有在已登录时才尝试同步：本地已写入成功，远端推送放到后台异步进行，
  // 不阻塞「添加成功」提示。词条已入队并持久化，后台失败也会在后续同步重试。
  if (isLoggedIn) {
    await enqueueSyncEntry(result.entry || entry);
    // 不 await：后台 flush，失败不影响本地结果与用户提示
    flushSyncQueue(settings).catch((error) => {
      logger.warn('[handleSaveWord] 后台同步失败，已入队待重试：', error);
    });
    logger.info('handleSaveWord success (queued for sync)', { word: entry.word, queueSize: (await getSyncQueue()).length });
    return {
      saved: Boolean(result.success),
      duplicate,
      entry: result.entry,
      sync: { ok: true, queued: true, queueSize: (await getSyncQueue()).length },
    };
  }

  logger.info('handleSaveWord success (local only)', { word: entry.word });
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
  logger.debug('handleDeleteWord', { id });

  const result = await deleteWordById(id);
  if (result.success) {
    await enqueueDelete(id);
  }

  const sync = await flushSyncQueue(await getSettings());
  logger.info('handleDeleteWord success', { id, deleted: result.success });
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
  const loggedIn = Boolean(auth?.accessToken && auth?.refreshToken) && !isAuthExpired(auth);

  return {
    deviceId,
    syncQueueSize: syncQueue.length,
    deleteQueueSize: deleteQueue.length,
    queueSize: syncQueue.length + deleteQueue.length,
    isLoggedIn: loggedIn,
    user: loggedIn ? (auth?.user || null) : null,
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

// 规范化首字母大写的普通英文单词：仅 "Hello" 这类首字母大写、其余非全大写的单词转小写首字母；
// 全大写缩写（如 API、NASA）保持不变。
function lowercaseFirstLetter(word) {
  const text = String(word || '');
  if (!text) {
    return text;
  }
  // 仅处理纯英文字母单词（允许连字符/撇号，如 well-known、it's）
  if (!/^[A-Za-z][A-Za-z'-]*$/.test(text)) {
    return text;
  }
  const first = text.charAt(0);
  // 首字母必须是大写，且其余部分不能含大写字母（排除 API、NASA、iOS 等）
  if (first >= 'A' && first <= 'Z' && text.slice(1) === text.slice(1).toLowerCase()) {
    return first.toLowerCase() + text.slice(1);
  }
  return text;
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
  logger.debug('pullChanges started', { baseUrl });
  const [booksRes, wordsRes] = await Promise.all([
    fetch(`${baseUrl}/api/v1/books`, { headers: { Authorization: `Bearer ${token}` } }),
    fetch(`${baseUrl}/api/v1/words`, { headers: { Authorization: `Bearer ${token}` } }),
  ]);

  if (booksRes.status === 401 || wordsRes.status === 401) {
    throw new Error('unauthorized');
  }

  let bookCount = 0;
  let wordCount = 0;
  if (booksRes.ok) {
    const books = await booksRes.json();
    const localBooks = Array.isArray(books) ? books.map(mapServerBookToLocal) : [];
    await saveBooks(localBooks);
    bookCount = localBooks.length;
  }

  if (wordsRes.ok) {
    const words = await wordsRes.json();
    const localWords = Array.isArray(words) ? words.map(mapServerWordToLocal) : [];
    await saveWords(localWords);
    wordCount = localWords.length;
  }
  logger.info('pullChanges success', { books: bookCount, words: wordCount });
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
    definition: '',
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
  logger.debug('pushWords started', { queueSize: syncQueue.length });

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
      logger.warn('[pushWords] 无法从服务器获取单词本:', err.message);
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
    logger.warn('[pushWords] 无法同步单词：没有可用的 book_id，已缓存待下次同步');
    return { ok: false, error: 'no_book_id', queueSize: syncQueue.length };
  }

  logger.info(`[pushWords] 准备同步 ${payload.length} 个单词，book_id: ${payload[0]?.book_id}`);

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
    logger.info(`[pushWords] 同步完成，清除 ${syncedWordKeys.size} 条，队列剩余 ${Math.max(0, syncQueue.length - syncedWordKeys.size)} 条`);
  }

  return { ok: true, processed: payload.length };
}

async function flushSyncQueue(settings) {
  const auth = await getAuthData();
  const syncQueue = await getSyncQueue();
  const deleteQueue = await getDeleteQueue();
  const queueSize = syncQueue.length + deleteQueue.length;

  if (!auth?.accessToken || !auth?.refreshToken) {
    logger.debug('flushSyncQueue skipped (not logged in)', { queueSize });
    return { ok: false, skipped: true, queueSize };
  }

  // 登录态已过期：清除并跳过同步
  if (isAuthExpired(auth)) {
    await setAuthData(null);
    await setCurrentUserEmail(null);
    logger.warn('flushSyncQueue skipped (auth expired)', { queueSize });
    return { ok: false, skipped: true, expired: true, queueSize };
  }

  if (isSyncing) {
    logger.debug('flushSyncQueue skipped (already syncing)');
    return { ok: true, skipped: true, queueSize };
  }

  logger.debug('flushSyncQueue started', { syncQueue: syncQueue.length, deleteQueue: deleteQueue.length });
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
        // 仅在 refresh token 真失效时登出；网络/临时错误保留登录态，下次重试
        if (refreshed.authInvalid) {
          await setAuthData(null);
          await setCurrentUserEmail(null);
          return { ok: false, error: refreshed.error || 'token_refresh_failed', loggedOut: true, queueSize: (await getSyncQueue()).length };
        }
        return { ok: false, skipped: true, error: refreshed.error || 'token_refresh_temporary', queueSize: (await getSyncQueue()).length };
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
    logger.info('flushSyncQueue success', { queueSize: (await getSyncQueue()).length + (await getDeleteQueue()).length });

    return {
      ok: true,
      processed: 1,
      queueSize: (await getSyncQueue()).length + (await getDeleteQueue()).length,
    };
  } catch (error) {
    logger.error('flushSyncQueue failed', { error: String(error) });
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

// 记住登录态的有效期（7天）
const REMEMBER_DEVICE_DURATION_MS = 7 * 24 * 60 * 60 * 1000;

// 本地记住的登录凭证（用于回填登录表单）
const STORAGE_REMEMBERED_CREDENTIALS = 'rememberedCredentials';

async function getRememberedCredentials() {
  const data = await chrome.storage.local.get([STORAGE_REMEMBERED_CREDENTIALS]);
  const cred = data?.[STORAGE_REMEMBERED_CREDENTIALS];
  return cred && typeof cred === 'object' ? cred : null;
}

// 保存登录凭证（email 始终保留以便回填；password 仅在勾选记住时保留）
async function saveRememberedCredentials(email, password, remember) {
  await chrome.storage.local.set({
    [STORAGE_REMEMBERED_CREDENTIALS]: {
      email: email || '',
      password: remember ? (password || '') : '',
      savedAt: Date.now(),
    },
  });
}

// 计算登录态过期时间：勾选“记住7天”则 7 天后过期，否则不设过期（长期保持直到手动登出）
function computeAuthExpiry(remember) {
  return remember ? Date.now() + REMEMBER_DEVICE_DURATION_MS : null;
}

// 判断登录态是否已过期
function isAuthExpired(auth) {
  return Boolean(auth?.expiresAt) && Date.now() > auth.expiresAt;
}

// 勾选/取消“在此设备记住7天”时，更新当前登录态的过期时间
async function handleAuthSetRemember(remember) {
  const auth = await getAuthData();
  if (!auth?.accessToken) {
    return { ok: true };
  }
  await setAuthData({ ...auth, expiresAt: computeAuthExpiry(Boolean(remember)) });
  // 取消勾选时清除已记住的密码，仅保留邮箱
  if (!remember) {
    const cred = await getRememberedCredentials();
    if (cred) {
      await chrome.storage.local.set({
        [STORAGE_REMEMBERED_CREDENTIALS]: { ...cred, password: '' },
      });
    }
  }
  return { ok: true };
}

// 获取回填用的登录凭证：7天内返回邮箱+密码，超过7天只返回邮箱
async function handleAuthGetCredentials() {
  const cred = await getRememberedCredentials();
  if (!cred) {
    return { ok: true, email: '', password: '' };
  }
  const expired = !cred.savedAt || Date.now() > cred.savedAt + REMEMBER_DEVICE_DURATION_MS;
  if (expired && cred.password) {
    // 超过7天：清除密码，仅保留邮箱
    await chrome.storage.local.set({
      [STORAGE_REMEMBERED_CREDENTIALS]: { ...cred, password: '' },
    });
    return { ok: true, email: cred.email || '', password: '' };
  }
  return { ok: true, email: cred.email || '', password: expired ? '' : (cred.password || '') };
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
    const settings = await getSettings();
    await setAuthData({
      accessToken: result.accessToken,
      refreshToken: result.refreshToken,
      user: result.user,
      baseUrl: normalizedUrl,
      lastSyncAt: Date.now(),
      expiresAt: computeAuthExpiry(Boolean(settings.rememberDevice7Days)),
    });
    // 记住凭证用于回填：邮箱始终保存，密码仅在勾选记住时保存
    await saveRememberedCredentials(email, password, Boolean(settings.rememberDevice7Days));
    await setupAlarms();
    // 立即拉取新用户的数据
    await flushSyncQueue(settings);
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
    const settings = await getSettings();
    await setAuthData({
      accessToken: result.accessToken,
      refreshToken: result.refreshToken,
      user: result.user,
      baseUrl: normalizedUrl,
      lastSyncAt: Date.now(),
      expiresAt: computeAuthExpiry(Boolean(settings.rememberDevice7Days)),
    });
    // 记住凭证用于回填：邮箱始终保存，密码仅在勾选记住时保存
    await saveRememberedCredentials(email, password, Boolean(settings.rememberDevice7Days));
    await setupAlarms();
    // 立即拉取新用户的数据
    await flushSyncQueue(settings);
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
  // 登录态已过期：清除并视为未登录
  if (auth && isAuthExpired(auth)) {
    await setAuthData(null);
    await setCurrentUserEmail(null);
    await clearUserData();
    return { ok: true, isLoggedIn: false, user: null, baseUrl: auth.baseUrl || '' };
  }
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
      // 仅 401/403 视为 refresh token 真失效（需要登出）；其余（5xx 等）视为临时错误
      const authInvalid = response.status === 401 || response.status === 403;
      return { ok: false, status: response.status, authInvalid, error: text || 'refresh_failed' };
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
    // 网络错误/超时：临时错误，不应登出
    return { ok: false, authInvalid: false, error: error instanceof Error ? error.message : String(error) };
  } finally {
    clearTimeout(timeout);
  }
}

async function handleTranslate(word) {
  if (!word || !word.trim()) {
    throw new Error('待翻译单词不能为空');
  }
  const settings = await getSettings();
  const cacheKey = word.trim().toLowerCase();

  // 1. 先查缓存，命中直接返回（0 网络，秒回）
  const cache = await getCacheMap();
  const cached = cache[cacheKey];
  if (cached && cached.translation) {
    // 更新 LRU 访问时间
    cached.lastAccess = Date.now();
    await saveCacheMap(cache);
    return { translation: cached.translation, fromCache: true };
  }

  // 2. 查内置离线词库（IndexedDB，高频词秒回，无需联网）
  await ensureDictImported();
  const offline = await lookupOffline(word);
  if (offline) {
    cache[cacheKey] = { translation: offline, lastAccess: Date.now() };
    pruneCache(cache, settings.maxCacheSize || 200);
    await saveCacheMap(cache);
    return { translation: offline, fromOffline: true };
  }

  // 3. 仍未命中才走网络翻译（生僻词/词组兜底）
  const translation = await translateWord(word, settings);

  // 4. 写回缓存（仅缓存有效结果，兜底结果不缓存以便后续重试）
  if (translation && translation.provider !== 'fallback') {
    cache[cacheKey] = { translation, lastAccess: Date.now() };
    pruneCache(cache, settings.maxCacheSize || 200);
    await saveCacheMap(cache);
  }

  return { translation };
}

// LRU 淘汰：超出上限时删除最久未访问的条目
function pruneCache(cache, maxSize) {
  const keys = Object.keys(cache);
  if (keys.length <= maxSize) {
    return;
  }
  keys
    .sort((a, b) => (cache[a]?.lastAccess || 0) - (cache[b]?.lastAccess || 0))
    .slice(0, keys.length - maxSize)
    .forEach((key) => delete cache[key]);
}
