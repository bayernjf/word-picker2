import { createLogger } from "./logger.js";
import type { Settings } from "./storage.js";
import type { OfflineTranslationResult } from "./offlineDict.js";

const logger = createLogger("translator");

const MEMORY_TRANSLATE_ENDPOINT = "https://api.mymemory.translated.net/get";
const FREE_DICTIONARY_ENDPOINT = "https://api.dictionaryapi.dev/api/v2/entries/en";
const YOUDAO_DICT_ENDPOINT = "https://dict.youdao.com/jsonapi";

interface FallbackEntry {
  meaning: string;
  phonetic: string;
  exampleEn: string;
  exampleZh: string;
}

const FALLBACK_DICTIONARY: Record<string, FallbackEntry> = {
  ubiquitous: {
    meaning: "adj. 无处不在的；普遍存在",
    phonetic: "/juːˈbɪkwɪtəs/",
    exampleEn: "Cloud computing has become ubiquitous in modern society.",
    exampleZh: "云计算在现代社会已经无处不在。",
  },
  algorithm: {
    meaning: "n. 算法；运算法则",
    phonetic: "/ˈalɡərɪðəm/",
    exampleEn: "The algorithm optimizes the result with fewer iterations.",
    exampleZh: "这个算法用更少的迭代优化结果。",
  },
  browser: {
    meaning: "n. 浏览器；浏览程序",
    phonetic: "/ˈbraʊzər/",
    exampleEn: "The browser extension works on Chromium-based products.",
    exampleZh: "这个浏览器扩展可运行在基于 Chromium 的产品上。",
  },
};

export interface TranslationResult {
  word: string;
  meaning: string;
  phonetic: string;
  exampleEn: string;
  exampleZh: string;
  note: string;
  provider: string;
}

// 给 Promise 加超时，避免单个慢接口拖慢整体
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`请求超时（${ms}ms）`)), ms)
    ),
  ]);
}

export async function translateWord(word: string, settings: Settings): Promise<TranslationResult> {
  const normalizedWord = String(word || "").trim();
  if (!normalizedWord) {
    throw new Error("待翻译单词不能为空");
  }

  const provider = settings.translator || "free";
  logger.debug('translateWord', { word: normalizedWord, provider, useYoudao: settings.useYoudaoDict });
  if (provider === "fallback") {
    return buildFallbackTranslation(normalizedWord);
  }

  const useYoudao = settings.useYoudaoDict !== false;
  const result = await translateWithFreeApis(normalizedWord, useYoudao);
  logger.info('translateWord success', { word: normalizedWord, provider: result.provider });
  return result;
}

interface FreeDictionaryEntry {
  phonetic?: string;
  phonetics?: Array<{ text?: string }>;
  meanings?: Array<{
    partOfSpeech?: string;
    definitions?: Array<{
      definition?: string;
      example?: string;
    }>;
  }>;
}

interface YoudaoResult {
  meaning: string;
}

async function translateWithFreeApis(word: string, useYoudao: boolean = true): Promise<TranslationResult> {
  const fallback = buildFallbackTranslation(word);
  const [translationResult, dictionaryResult, youdaoResult] = await Promise.allSettled([
    withTimeout(fetchFreeTranslation(word), 2500),
    withTimeout(fetchDictionaryEntry(word), 2500),
    useYoudao ? withTimeout(fetchYoudaoDict(word), 2500) : Promise.resolve(null),
  ]);

  const translation = translationResult.status === "fulfilled" ? translationResult.value : null;
  const dictionary = dictionaryResult.status === "fulfilled" ? dictionaryResult.value : null;
  const youdao = youdaoResult.status === "fulfilled" ? youdaoResult.value : null;

  if (!translation && !dictionary && !youdao) {
    return buildFallbackTranslation(word, "免费翻译接口暂时不可用，已返回本地兜底结果");
  }

  let exampleZh = fallback.exampleZh || "";
  if (dictionary?.exampleEn) {
    try {
      // 例句翻译加超时，避免第二轮串行请求拖慢整体释义返回
      exampleZh = await withTimeout(
        fetchFreeTranslation(dictionary.exampleEn),
        1500
      );
    } catch (error) {
      logger.warn("例句翻译失败或超时，使用兜底结果：", error);
      exampleZh = fallback.exampleZh || "";
    }
  }

  return {
    word,
    meaning: buildMeaning(translation, dictionary, fallback, youdao),
    phonetic: dictionary?.phonetic || fallback.phonetic || "",
    exampleEn: dictionary?.exampleEn || fallback.exampleEn || "",
    exampleZh,
    note: buildNote(translation, dictionary, youdao),
    provider: "free",
  };
}

async function fetchFreeTranslation(text: string): Promise<string> {
  const url = new URL(MEMORY_TRANSLATE_ENDPOINT);
  url.search = new URLSearchParams({
    q: text,
    langpair: "en|zh-CN",
  }).toString();

  const response = await fetch(url.toString());
  if (!response.ok) {
    throw new Error(`免费翻译接口请求失败：HTTP ${response.status}`);
  }

  const json = await response.json();
  if (json.responseStatus && json.responseStatus !== 200) {
    throw new Error(json.responseDetails || `免费翻译接口返回错误：${json.responseStatus}`);
  }

  const translatedText = String(json.responseData?.translatedText || "").trim();
  if (!translatedText || translatedText.toLowerCase() === String(text).trim().toLowerCase()) {
    throw new Error("免费翻译接口未返回有效结果");
  }

  return translatedText;
}

async function fetchDictionaryEntry(word: string): Promise<{
  phonetic: string;
  partOfSpeech: string;
  definitionEn: string;
  exampleEn: string;
} | null> {
  const response = await fetch(`${FREE_DICTIONARY_ENDPOINT}/${encodeURIComponent(word.toLowerCase())}`);
  if (response.status === 404) {
    return null;
  }
  if (!response.ok) {
    throw new Error(`免费词典接口请求失败：HTTP ${response.status}`);
  }

  const payload = await response.json();
  const entry: FreeDictionaryEntry = Array.isArray(payload) ? payload[0] : null;
  if (!entry) {
    return null;
  }

  const phonetic = formatPhonetic(
    entry.phonetic ||
      entry.phonetics?.find((item) => item?.text)?.text ||
      ""
  );
  const meaningNode = entry.meanings?.find((item) => item?.definitions && item.definitions.length > 0) || null;
  const definitionNode = meaningNode?.definitions?.find((item) => item?.definition) || null;

  return {
    phonetic,
    partOfSpeech: meaningNode?.partOfSpeech || "",
    definitionEn: definitionNode?.definition || "",
    exampleEn: definitionNode?.example || "",
  };
}

async function fetchYoudaoDict(word: string): Promise<YoudaoResult | null> {
  const url = new URL(YOUDAO_DICT_ENDPOINT);
  url.search = new URLSearchParams({ q: word }).toString();

  const response = await fetch(url.toString());
  if (!response.ok) {
    throw new Error(`有道词典接口请求失败：HTTP ${response.status}`);
  }

  const payload = await response.json();

  // 优先取基础词典释义（ec：英汉），结构最规整
  const ecTrs = payload?.ec?.word?.[0]?.trs;
  if (Array.isArray(ecTrs) && ecTrs.length > 0) {
    const meanings = ecTrs
      .map((item: any) => String(item?.tr?.[0]?.l?.i?.[0] || "").trim())
      .filter(Boolean);
    if (meanings.length > 0) {
      return { meaning: meanings.join("；") };
    }
  }

  // 兜底取网络释义（web_trans），按 support 选最高票
  const webTrans = payload?.web_trans?.["web-translation"];
  if (Array.isArray(webTrans) && webTrans.length > 0) {
    const sameEntry =
      webTrans.find((item: any) => item?.["@same"] === "true") || webTrans[0];
    const trans = sameEntry?.trans;
    if (Array.isArray(trans) && trans.length > 0) {
      const meanings = trans
        .map((item: any) => String(item?.value || "").trim())
        .filter(Boolean)
        .slice(0, 4);
      if (meanings.length > 0) {
        return { meaning: meanings.join("；") };
      }
    }
  }

  return null;
}

function buildFallbackTranslation(word: string, note: string = ""): TranslationResult {
  const lower = word.toLowerCase();
  const preset = FALLBACK_DICTIONARY[lower];
  if (preset) {
    return {
      word,
      ...preset,
      note,
      provider: "fallback",
    };
  }

  return {
    word,
    meaning: note || "未配置翻译 API，当前返回本地占位结果",
    phonetic: "",
    exampleEn: "",
    exampleZh: "",
    note,
    provider: "fallback",
  };
}

function buildMeaning(
  translation: string | null,
  dictionary: { phonetic: string; partOfSpeech: string; definitionEn: string; exampleEn: string } | null,
  fallback: FallbackEntry,
  youdao: YoudaoResult | null
): string {
  // 优先使用有道英汉词典释义（含词性，最贴近中文用户）
  const youdaoMeaning = String(youdao?.meaning || "").trim();
  if (youdaoMeaning) {
    return youdaoMeaning;
  }

  const translatedText = String(translation || "").trim();
  const partOfSpeech = mapPartOfSpeech(dictionary?.partOfSpeech || "");
  if (translatedText) {
    return partOfSpeech ? `${partOfSpeech} ${translatedText}` : translatedText;
  }

  if (dictionary?.definitionEn) {
    return partOfSpeech
      ? `${partOfSpeech} ${dictionary.definitionEn}`
      : dictionary.definitionEn;
  }

  return fallback.meaning;
}

function buildNote(
  translation: string | null,
  dictionary: { phonetic: string; partOfSpeech: string; definitionEn: string; exampleEn: string } | null,
  youdao: YoudaoResult | null
): string {
  if (youdao?.meaning) {
    return "";
  }
  if (!translation && dictionary?.definitionEn) {
    return "中文翻译接口暂时不可用，当前展示英文释义";
  }
  if (translation && !dictionary) {
    return "当前未获取到音标和例句，仅展示免费翻译结果";
  }
  return "";
}

function mapPartOfSpeech(partOfSpeech: string): string {
  const map: Record<string, string> = {
    a: "adj.",
    "a.": "adj.",
    adjective: "adj.",
    adj: "adj.",
    "adj.": "adj.",
    noun: "n.",
    n: "n.",
    "n.": "n.",
    verb: "v.",
    v: "v.",
    "v.": "v.",
    adverb: "adv.",
    adv: "adv.",
    "adv.": "adv.",
    pronoun: "pron.",
    pron: "pron.",
    "pron.": "pron.",
    preposition: "prep.",
    prep: "prep.",
    "prep.": "prep.",
    conjunction: "conj.",
    conj: "conj.",
    "conj.": "conj.",
    interjection: "int.",
    int: "int.",
    "int.": "int.",
    article: "art.",
    art: "art.",
    "art.": "art.",
    numeral: "num.",
    num: "num.",
    "num.": "num.",
    determiner: "det.",
    det: "det.",
    "det.": "det.",
    "auxiliary verb": "aux.",
    aux: "aux.",
    "aux.": "aux.",
    "modal verb": "modal.",
    modal: "modal.",
    "modal.": "modal.",
    phrase: "phr.",
    phr: "phr.",
    "phr.": "phr.",
    abbreviation: "abbr.",
    abbr: "abbr.",
    "abbr.": "abbr.",
  };
  return map[String(partOfSpeech || "").toLowerCase().trim()] || "";
}

function formatPhonetic(phonetic: string): string {
  const value = String(phonetic || "").trim();
  if (!value) {
    return "";
  }
  return value.startsWith("/") ? value : `/${value}/`;
}
