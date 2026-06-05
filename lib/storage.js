export const DEFAULT_SETTINGS = {
  lookupKey: "Control",
  hoverDelay: 100,
  translator: "free",
  autoSpeak: false,
  maxCacheSize: 200,
  syncEnabled: true,
  syncBaseUrl: "http://localhost:3001",
  pairingCode: "",
  syncToken: ""
};

const STORAGE_KEYS = {
  WORDS: "words",
  CACHE: "cache",
  SETTINGS: "settings"
};

// 日期时间格式化函数（用于显示，输入还是用这个）
export function formatDateTimeForDisplay(timestamp) {
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
export function migrateOldWordFormat(oldWord) {
  const now = Date.now();
  const timeAdded = oldWord.createdAt || now;
  
  // 构建上下文对象
  const contexts = [];
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
      reviewCount: oldWord.reviewCount
    }
  };
}

// 检查是否是旧格式
function isOldFormat(word) {
  return !word.frequency && !word.contexts && !word.timeAdded;
}

export async function ensureDefaults() {
  const current = await chrome.storage.local.get([
    STORAGE_KEYS.WORDS,
    STORAGE_KEYS.CACHE,
    STORAGE_KEYS.SETTINGS
  ]);

  const patch = {};
  if (!Array.isArray(current.words)) {
    patch[STORAGE_KEYS.WORDS] = [];
  } else {
    // 迁移旧格式数据
    const migratedWords = current.words.map(word => {
      if (isOldFormat(word)) {
        return migrateOldWordFormat(word);
      }
      return word;
    });
    patch[STORAGE_KEYS.WORDS] = migratedWords;
  }
  
  if (!current.cache || typeof current.cache !== "object" || Array.isArray(current.cache)) {
    patch[STORAGE_KEYS.CACHE] = {};
  }
  patch[STORAGE_KEYS.SETTINGS] = {
    ...DEFAULT_SETTINGS,
    ...(current.settings || {})
  };

  if (Object.keys(patch).length > 0) {
    await chrome.storage.local.set(patch);
  }

  return {
    words: Array.isArray(patch[STORAGE_KEYS.WORDS]) ? patch[STORAGE_KEYS.WORDS] : Array.isArray(current.words) ? current.words : [],
    cache: current.cache && !Array.isArray(current.cache) ? current.cache : {},
    settings: patch[STORAGE_KEYS.SETTINGS]
  };
}

export async function getSettings() {
  const { settings } = await ensureDefaults();
  return settings;
}

export async function saveSettings(settingsPatch) {
  const settings = {
    ...(await getSettings()),
    ...settingsPatch
  };
  await chrome.storage.local.set({ [STORAGE_KEYS.SETTINGS]: settings });
  return settings;
}

export async function getWords() {
  const { words } = await ensureDefaults();
  return words;
}

export async function saveWords(words) {
  await chrome.storage.local.set({ [STORAGE_KEYS.WORDS]: words });
  return words;
}

export async function addWord(entry) {
  const words = await getWords();
  const duplicateIndex = words.findIndex((item) => 
    item.word.toLowerCase() === entry.word.toLowerCase());

  if (duplicateIndex !== -1) {
    // 如果是重复单词，追加新的上下文信息
    const existingWord = words[duplicateIndex];
    const newContexts = entry.contexts || [];
    const existingContexts = existingWord.contexts || [];
    
    // 合并并去重
    const mergedContexts = [...existingContexts];
    newContexts.forEach(newCtx => {
      const isDuplicate = mergedContexts.some(existingCtx => 
        existingCtx.context === newCtx.context && 
        existingCtx.sourceLink === newCtx.sourceLink);
      if (!isDuplicate) {
        mergedContexts.push(newCtx);
      }
    });
    
    const updatedWord = {
      ...existingWord,
      timeUpdated: entry.timeAdded || Date.now(),
      contexts: mergedContexts,
      frequency: mergedContexts.length
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
      entry: updatedWord
    };
  }

  // 如果是新单词，直接添加
  const nextWords = [entry, ...words];
  nextWords.sort((a, b) => {
    const timeA = a.timeAdded || a._legacy?.createdAt || 0;
    const timeB = b.timeAdded || b._legacy?.createdAt || 0;
    return timeB - timeA;
  });
  
  await saveWords(nextWords);

  return {
    success: true,
    entry
  };
}

export async function deleteWordById(id) {
  const words = await getWords();
  // 兼容旧id可能在_legacy.id中
  const nextWords = words.filter((item) => 
    (item._legacy?.id !== id && (item.word && item._legacy?.id !== id)));
  await saveWords(nextWords);
  return {
    success: nextWords.length !== words.length
  };
}

// 兼容旧数据：时间可能是字符串也可能是数字
function ensureTimeNumber(timeVal) {
  if (!timeVal) return 0;
  if (typeof timeVal === "number") return timeVal;
  const date = new Date(timeVal);
  return isNaN(date.getTime()) ? 0 : date.getTime();
}

export async function searchWords(query = "") {
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
      const searchFields = [
        item.word,
        item.translation,
        // 搜索上下文中的内容
        ...(item.contexts?.map(ctx => ctx.context) || []),
        ...(item.contexts?.map(ctx => ctx.translation) || []),
        // 兼容旧格式字段
        item._legacy?.sourceTitle || ""
      ].filter(Boolean);
      return searchFields.some((value) => value.toLowerCase().includes(normalized));
    })
    .sort((a, b) => {
      const timeA = ensureTimeNumber(a.timeAdded || a._legacy?.createdAt);
      const timeB = ensureTimeNumber(b.timeAdded || b._legacy?.createdAt);
      return timeB - timeA;
    });
}

export async function getCacheMap() {
  const { cache } = await ensureDefaults();
  return cache;
}

export async function saveCacheMap(cache) {
  await chrome.storage.local.set({ [STORAGE_KEYS.CACHE]: cache });
  return cache;
}
