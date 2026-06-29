import {
  selectPreferredSyncBook,
  normalizeContextValue,
  normalizeSourceLinkValue,
} from "./utils.js";
import type { Book } from "./utils.js";

export interface WordContext {
  context: string;
  timeAdded: number;
  sourceLink: string;
  translation: string;
}

export interface Word {
  word: string;
  frequency: number;
  translation: string;
  timeAdded: number;
  timeUpdated: number;
  contexts: WordContext[];
  bookId: string;
  phonetic?: string;
  exampleEn?: string;
  exampleZh?: string;
  _legacy?: {
    id?: string;
    phonetic?: string;
    exampleEn?: string;
    exampleZh?: string;
    sourceUrl?: string;
    sourceTitle?: string;
    tags?: string[];
    reviewCount?: number;
    createdAt?: number;
    [key: string]: any;
  };
  id?: string;
}

export interface Settings {
  lookupKey: "Control" | "Command" | "Alt" | "Option";
  hoverDelay: number;
  translator: "free" | "fallback";
  useYoudaoDict: boolean;
  autoSpeak: boolean;
  maxCacheSize: number;
  syncEnabled: boolean;
  rememberDevice7Days: boolean;
  syncBaseUrl: string;
  pairingCode: string;
  syncToken: string;
  fireworksEffect: "canvas" | "css" | "none";
}

export const DEFAULT_SETTINGS: Settings = {
  lookupKey: "Control",
  hoverDelay: 100,
  translator: "free",
  useYoudaoDict: true,
  autoSpeak: false,
  maxCacheSize: 200,
  syncEnabled: true,
  rememberDevice7Days: false,
  syncBaseUrl: "http://localhost:3001",
  pairingCode: "",
  syncToken: "",
  fireworksEffect: "css",
};

const STORAGE_KEYS = {
  WORDS: "words",
  BOOKS: "books",
  CACHE: "cache",
  SETTINGS: "settings",
  SYNC_VERSION: "syncVersion",
};

// 日期时间格式化函数（用于显示，输入还是用这个）
export function formatDateTimeForDisplay(timestamp: number): string {
  if (!timestamp) return "";
  const date = new Date(timestamp);
  if (isNaN(date.getTime())) return "";
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  const hours = String(date.getHours()).padStart(2, '0');
  const minutes = String(date.getMinutes()).padStart(2, '0');
  const seconds = String(date.getSeconds()).padStart(2, '0');
  return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`;
}

// 旧格式迁移函数
export function migrateOldWordFormat(oldWord: any): Word {
  const now = Date.now();
  const timeAdded = oldWord.createdAt || now;

  // 构建上下文对象
  const contexts: WordContext[] = [];
  if (oldWord.sentence) {
    contexts.push({
      context: oldWord.sentence,
      timeAdded: timeAdded,
      sourceLink: oldWord.sourceUrl || "",
      translation: ""  // 旧格式没有上下文翻译，留空
    });
  }

  return {
    word: oldWord.word || "",
    frequency: contexts.length || 1,
    translation: oldWord.meaning || "",
    timeAdded: timeAdded,
    timeUpdated: timeAdded,
    contexts: contexts,
    // 保留旧字段作为兼容
    _legacy: {
      id: oldWord.id,
      phonetic: oldWord.phonetic,
      exampleEn: oldWord.exampleEn,
      exampleZh: oldWord.exampleZh,
      sourceUrl: oldWord.sourceUrl,
      sourceTitle: oldWord.sourceTitle,
      tags: oldWord.tags,
      reviewCount: oldWord.reviewCount,
      createdAt: oldWord.createdAt,
    },
    bookId: "",
  };
}

// 检查是否是旧格式
function isOldFormat(word: any): boolean {
  return !word.frequency && !word.contexts && !word.timeAdded;
}

export interface StorageData {
  words: Word[];
  books: Book[];
  cache: any;
  settings: Settings;
}

export async function ensureDefaults(): Promise<StorageData> {
  const current: any = await chrome.storage.local.get([
    STORAGE_KEYS.WORDS,
    STORAGE_KEYS.CACHE,
    STORAGE_KEYS.SETTINGS,
    STORAGE_KEYS.BOOKS,
  ]);

  const patch: any = {};
  if (!Array.isArray(current.words)) {
    patch[STORAGE_KEYS.WORDS] = [];
  } else {
    // 迁移旧格式数据
    const migratedWords = current.words.map((word: any) => {
      if (isOldFormat(word)) {
        return migrateOldWordFormat(word);
      }
      return word;
    });
    patch[STORAGE_KEYS.WORDS] = migratedWords;
  }

  // 确保有单词本
  if (!Array.isArray(current[STORAGE_KEYS.BOOKS]) || current[STORAGE_KEYS.BOOKS].length === 0) {
    patch[STORAGE_KEYS.BOOKS] = [{
      id: 'local_default_book',
      name: '默认',
      description: '用于存放单词的默认单词本',
      wordCount: 0,
      icon: 'BookOpen',
      isSync: false,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }];
  }

  if (!current.cache || typeof current.cache !== "object" || Array.isArray(current.cache)) {
    patch[STORAGE_KEYS.CACHE] = {};
  }
  patch[STORAGE_KEYS.SETTINGS] = {
    ...DEFAULT_SETTINGS,
    ...(current.settings || {}),
  };

  if (Object.keys(patch).length > 0) {
    await chrome.storage.local.set(patch);
  }

  return {
    words: Array.isArray(patch[STORAGE_KEYS.WORDS]) ? patch[STORAGE_KEYS.WORDS] : Array.isArray(current.words) ? current.words : [],
    books: Array.isArray(patch[STORAGE_KEYS.BOOKS]) ? patch[STORAGE_KEYS.BOOKS] : Array.isArray(current[STORAGE_KEYS.BOOKS]) ? current[STORAGE_KEYS.BOOKS] : [],
    cache: current.cache && !Array.isArray(current.cache) ? current.cache : {},
    settings: patch[STORAGE_KEYS.SETTINGS],
  };
}

export async function getSettings(): Promise<Settings> {
  const { settings } = await ensureDefaults();
  return settings;
}

export async function saveSettings(settingsPatch: Partial<Settings>): Promise<Settings> {
  const settings = {
    ...(await getSettings()),
    ...settingsPatch,
  };
  await chrome.storage.local.set({ [STORAGE_KEYS.SETTINGS]: settings });
  return settings;
}

export async function getWords(): Promise<Word[]> {
  const { words } = await ensureDefaults();
  return words;
}

export async function saveWords(words: Word[]): Promise<Word[]> {
  await chrome.storage.local.set({ [STORAGE_KEYS.WORDS]: words });
  return words;
}

export interface AddWordResult {
  success: boolean;
  duplicate: boolean;
  entry: Word;
}

export async function addWord(entry: Omit<Word, 'bookId'> & { bookId?: string }): Promise<AddWordResult> {
  const words = await getWords();
  const books = await getBooks();

  // 只使用同步单词本
  const syncBook = selectPreferredSyncBook(books);
  // 如果本地缓存中没有同步单词本，bookId 留空，将在同步时由 service worker 自动解析
  const targetBookId = entry.bookId || (syncBook ? syncBook.id : '');

  // 确保 entry 有 bookId，只使用同步单词本的 bookId
  const entryWithBook: Word = {
    ...entry,
    bookId: targetBookId,
  } as Word;

  const duplicateIndex = words.findIndex((item) =>
    item.word.toLowerCase() === entryWithBook.word.toLowerCase()
    && String(item.bookId || '') === String(targetBookId || ''));

  if (duplicateIndex !== -1) {
    // 如果是重复单词，追加新的上下文信息
    const existingWord = words[duplicateIndex];
    const newContexts = entryWithBook.contexts || [];
    const existingContexts = existingWord.contexts || [];

    // 合并并去重
    const mergedContexts = [...existingContexts];
    let appendedContext = false;
    newContexts.forEach(newCtx => {
      const isDuplicate = mergedContexts.some(existingCtx =>
        normalizeContextValue(existingCtx.context) === normalizeContextValue(newCtx.context) &&
        normalizeSourceLinkValue(existingCtx) === normalizeSourceLinkValue(newCtx));
      if (!isDuplicate) {
        mergedContexts.push(newCtx);
        appendedContext = true;
      }
    });

    if (!appendedContext) {
      return {
        success: true,
        duplicate: true,
        entry: existingWord,
      };
    }

    const updatedWord: Word = {
      ...existingWord,
      timeUpdated: entryWithBook.timeAdded || Date.now(),
      contexts: mergedContexts,
      frequency: mergedContexts.length,
      bookId: targetBookId,
    };

    const nextWords = [...words];
    nextWords[duplicateIndex] = updatedWord;

    // 重新排序
    nextWords.sort((a, b) => {
      const timeA = a.timeAdded || a._legacy?.createdAt || 0;
      const timeB = b.timeAdded || b._legacy?.createdAt || 0;
      return timeB - timeA;
    });

    await saveWords(nextWords);

    return {
      success: true,
      duplicate: false,
      entry: updatedWord,
    };
  }

  // 如果是新单词，直接添加
  const nextWords = [entryWithBook as Word, ...words];
  nextWords.sort((a, b) => {
    const timeA = a.timeAdded || a._legacy?.createdAt || 0;
    const timeB = b.timeAdded || b._legacy?.createdAt || 0;
    return timeB - timeA;
  });

  await saveWords(nextWords);

  return {
    success: true,
    duplicate: false,
    entry: entryWithBook as Word,
  };
}

export async function deleteWordById(id: string): Promise<{ success: boolean }> {
  const words = await getWords();
  const nextWords = words.filter((item) =>
    item.id !== id && item._legacy?.id !== id);
  await saveWords(nextWords);
  return {
    success: nextWords.length !== words.length,
  };
}

// 兼容旧数据：时间可能是字符串也可能是数字
function ensureTimeNumber(timeVal: number | string | undefined): number {
  if (!timeVal) return 0;
  if (typeof timeVal === "number") return timeVal;
  const date = new Date(timeVal);
  return isNaN(date.getTime()) ? 0 : date.getTime();
}

export async function searchWords(query: string = ""): Promise<Word[]> {
  const words = await getWords();
  const normalized = query.trim().toLowerCase();

  if (!normalized) {
    return [...words].sort((a, b) => {
      const timeA = ensureTimeNumber(a.timeAdded || a._legacy?.createdAt);
      const timeB = ensureTimeNumber(b.timeAdded || b._legacy?.createdAt);
      return timeB - timeA;
    });
  }

  return words
    .filter((item) => {
      // 仅按单词本身匹配，不搜索释义、上下文、来源
      return item.word?.toLowerCase().includes(normalized);
    })
    .sort((a, b) => {
      const timeA = ensureTimeNumber(a.timeAdded || a._legacy?.createdAt);
      const timeB = ensureTimeNumber(b.timeAdded || b._legacy?.createdAt);
      return timeB - timeA;
    });
}

// 新增：按单词本获取单词
export async function getWordsByBook(bookId: string, query: string = ""): Promise<Word[]> {
  let words = await getWords();

  // 按单词本过滤
  if (bookId) {
    words = words.filter(item => item.bookId === bookId);
  }

  const normalized = query.trim().toLowerCase();
  if (!normalized) {
    return [...words].sort((a, b) => {
      const timeA = ensureTimeNumber(a.timeAdded || a._legacy?.createdAt);
      const timeB = ensureTimeNumber(b.timeAdded || b._legacy?.createdAt);
      return timeB - timeA;
    });
  }

  return words
    .filter((item) => {
      // 仅按单词本身匹配，不搜索释义、上下文、来源
      return item.word?.toLowerCase().includes(normalized);
    })
    .sort((a, b) => {
      const timeA = ensureTimeNumber(a.timeAdded || a._legacy?.createdAt);
      const timeB = ensureTimeNumber(b.timeAdded || b._legacy?.createdAt);
      return timeB - timeA;
    });
}

export type CacheMap = { [key: string]: any };

export async function getCacheMap(): Promise<CacheMap> {
  const { cache } = await ensureDefaults();
  return cache;
}

export async function saveCacheMap(cache: CacheMap): Promise<CacheMap> {
  await chrome.storage.local.set({ [STORAGE_KEYS.CACHE]: cache });
  return cache;
}

// 单词本管理
export async function getBooks(): Promise<Book[]> {
  const { [STORAGE_KEYS.BOOKS]: books } = await chrome.storage.local.get([STORAGE_KEYS.BOOKS]);
  return Array.isArray(books) ? books : [];
}

export async function saveBooks(books: Book[]): Promise<Book[]> {
  await chrome.storage.local.set({ [STORAGE_KEYS.BOOKS]: books });
  return books;
}

export async function getBookById(id: string): Promise<Book | null> {
  const books = await getBooks();
  return books.find(b => b.id === id) || null;
}

export async function addBook(book: Book): Promise<Book> {
  const books = await getBooks();
  books.push(book);
  await saveBooks(books);
  return book;
}

export async function updateBook(id: string, updates: Partial<Book>): Promise<Book | null> {
  const books = await getBooks();
  const index = books.findIndex(b => b.id === id);
  if (index !== -1) {
    books[index] = { ...books[index], ...updates };
    await saveBooks(books);
    return books[index];
  }
  return null;
}

export async function deleteBookById(id: string): Promise<boolean> {
  const books = await getBooks();
  const filtered = books.filter(b => b.id !== id);
  await saveBooks(filtered);
  return filtered.length !== books.length;
}

// 同步版本管理
export async function getSyncVersion(): Promise<number> {
  const { [STORAGE_KEYS.SYNC_VERSION]: version } = await chrome.storage.local.get([STORAGE_KEYS.SYNC_VERSION]);
  return Number(version) || 0;
}

export async function setSyncVersion(version: number): Promise<number> {
  await chrome.storage.local.set({ [STORAGE_KEYS.SYNC_VERSION]: Number(version) });
  return version;
}
