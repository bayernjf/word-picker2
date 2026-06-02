export const DEFAULT_SETTINGS = {
  lookupKey: "Control",
  hoverDelay: 300,
  translator: "free",
  autoSpeak: false,
  maxCacheSize: 200
};

const STORAGE_KEYS = {
  WORDS: "words",
  CACHE: "cache",
  SETTINGS: "settings"
};

export async function ensureDefaults() {
  const current = await chrome.storage.local.get([
    STORAGE_KEYS.WORDS,
    STORAGE_KEYS.CACHE,
    STORAGE_KEYS.SETTINGS
  ]);

  const patch = {};
  if (!Array.isArray(current.words)) {
    patch[STORAGE_KEYS.WORDS] = [];
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
    words: Array.isArray(current.words) ? current.words : [],
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
  const duplicate = words.find((item) => item.word.toLowerCase() === entry.word.toLowerCase());

  if (duplicate) {
    return {
      success: false,
      duplicate: true,
      entry: duplicate
    };
  }

  const nextWords = [entry, ...words].sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  await saveWords(nextWords);

  return {
    success: true,
    duplicate: false,
    entry
  };
}

export async function deleteWordById(id) {
  const words = await getWords();
  const nextWords = words.filter((item) => item.id !== id);
  await saveWords(nextWords);
  return {
    success: nextWords.length !== words.length
  };
}

export async function searchWords(query = "") {
  const words = await getWords();
  const normalized = query.trim().toLowerCase();

  if (!normalized) {
    return words.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  }

  return words
    .filter((item) => {
      return [item.word, item.meaning, item.sentence, item.sourceTitle]
        .filter(Boolean)
        .some((value) => value.toLowerCase().includes(normalized));
    })
    .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
}

export async function getCacheMap() {
  const { cache } = await ensureDefaults();
  return cache;
}

export async function saveCacheMap(cache) {
  await chrome.storage.local.set({ [STORAGE_KEYS.CACHE]: cache });
  return cache;
}
