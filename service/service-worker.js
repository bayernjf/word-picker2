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

chrome.runtime.onInstalled.addListener(() => {
  ensureDefaults();
});

chrome.runtime.onStartup?.addListener(() => {
  ensureDefaults();
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
      return deleteWordById(message.id);
    case "GET_WORDS":
      return { words: await searchWords(message.query || "") };
    case "EXPORT_WORDS":
      return handleExportWords(message.format || "json");
    case "GET_SETTINGS":
      return { settings: await getSettings() };
    case "SAVE_SETTINGS":
      return { settings: await saveSettings(message.settings || {}) };
    case "PING":
      return { pong: true };
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

  return addWord(entry);
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
