const MEMORY_TRANSLATE_ENDPOINT = "https://api.mymemory.translated.net/get";
const FREE_DICTIONARY_ENDPOINT = "https://api.dictionaryapi.dev/api/v2/entries/en";

const FALLBACK_DICTIONARY = {
  ubiquitous: {
    meaning: "adj. 无处不在的；普遍存在的",
    phonetic: "/juːˈbɪkwɪtəs/",
    exampleEn: "Cloud computing has become ubiquitous in modern society.",
    exampleZh: "云计算在现代社会已经无处不在。"
  },
  algorithm: {
    meaning: "n. 算法；运算法则",
    phonetic: "/ˈalɡərɪðəm/",
    exampleEn: "The algorithm optimizes the result with fewer iterations.",
    exampleZh: "这个算法用更少的迭代优化结果。"
  },
  browser: {
    meaning: "n. 浏览器；浏览程序",
    phonetic: "/ˈbraʊzər/",
    exampleEn: "The browser extension works on Chromium-based products.",
    exampleZh: "这个浏览器扩展可运行在基于 Chromium 的产品上。"
  }
};

export async function translateWord(word, settings) {
  const normalizedWord = String(word || "").trim();
  if (!normalizedWord) {
    throw new Error("待翻译单词不能为空");
  }

  const provider = settings.translator || "free";
  if (provider === "fallback") {
    return buildFallbackTranslation(normalizedWord);
  }

  return translateWithFreeApis(normalizedWord);
}

async function translateWithFreeApis(word) {
  const fallback = buildFallbackTranslation(word);
  const [translationResult, dictionaryResult] = await Promise.allSettled([
    fetchFreeTranslation(word),
    fetchDictionaryEntry(word)
  ]);

  const translation = translationResult.status === "fulfilled" ? translationResult.value : null;
  const dictionary = dictionaryResult.status === "fulfilled" ? dictionaryResult.value : null;

  if (!translation && !dictionary) {
    return buildFallbackTranslation(word, "免费翻译接口暂时不可用，已返回本地兜底结果");
  }

  let exampleZh = fallback.exampleZh || "";
  if (dictionary?.exampleEn) {
    try {
      exampleZh = await fetchFreeTranslation(dictionary.exampleEn);
    } catch (_error) {
      exampleZh = fallback.exampleZh || "";
    }
  }

  return {
    word,
    meaning: buildMeaning(translation, dictionary, fallback),
    phonetic: dictionary?.phonetic || fallback.phonetic || "",
    exampleEn: dictionary?.exampleEn || fallback.exampleEn || "",
    exampleZh,
    note: buildNote(translation, dictionary),
    provider: "free"
  };
}

async function fetchFreeTranslation(text) {
  const url = new URL(MEMORY_TRANSLATE_ENDPOINT);
  url.search = new URLSearchParams({
    q: text,
    langpair: "en|zh-CN"
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

async function fetchDictionaryEntry(word) {
  const response = await fetch(`${FREE_DICTIONARY_ENDPOINT}/${encodeURIComponent(word.toLowerCase())}`);
  if (response.status === 404) {
    return null;
  }
  if (!response.ok) {
    throw new Error(`免费词典接口请求失败：HTTP ${response.status}`);
  }

  const payload = await response.json();
  const entry = Array.isArray(payload) ? payload[0] : null;
  if (!entry) {
    return null;
  }

  const phonetic = formatPhonetic(
    entry.phonetic ||
      entry.phonetics?.find((item) => item?.text)?.text ||
      ""
  );
  const meaningNode = entry.meanings?.find((item) => item?.definitions?.length > 0) || null;
  const definitionNode = meaningNode?.definitions?.find((item) => item?.definition) || null;

  return {
    phonetic,
    partOfSpeech: meaningNode?.partOfSpeech || "",
    definitionEn: definitionNode?.definition || "",
    exampleEn: definitionNode?.example || ""
  };
}

function buildFallbackTranslation(word, note = "") {
  const lower = word.toLowerCase();
  const preset = FALLBACK_DICTIONARY[lower];
  if (preset) {
    return {
      word,
      ...preset,
      note,
      provider: "fallback"
    };
  }

  return {
    word,
    meaning: note || "未配置翻译 API，当前返回本地占位结果",
    phonetic: "",
    exampleEn: "",
    exampleZh: "",
    note,
    provider: "fallback"
  };
}

function buildMeaning(translation, dictionary, fallback) {
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

function buildNote(translation, dictionary) {
  if (!translation && dictionary?.definitionEn) {
    return "中文翻译接口暂时不可用，当前展示英文释义";
  }
  if (translation && !dictionary) {
    return "当前未获取到音标和例句，仅展示免费翻译结果";
  }
  return "";
}

function mapPartOfSpeech(partOfSpeech) {
  const map = {
    noun: "n.",
    verb: "v.",
    adjective: "adj.",
    adverb: "adv.",
    pronoun: "pron.",
    preposition: "prep.",
    conjunction: "conj.",
    interjection: "int.",
    article: "art."
  };
  return map[String(partOfSpeech || "").toLowerCase()] || "";
}

function formatPhonetic(phonetic) {
  const value = String(phonetic || "").trim();
  if (!value) {
    return "";
  }
  return value.startsWith("/") ? value : `/${value}/`;
}
