/**
 * ECDICT mini 词库预处理脚本
 *
 * 用途：把下载的 data/ecdict.mini.csv 清洗、裁剪后，生成可直接打包进插件的
 *       离线词库资产 assets/dict/ecdict.min.json。
 *
 * 运行：node scripts/build-dict.js [--limit=50000] [--require-frq]
 *   --limit=N      最多保留 N 条（按词频从高到低），默认不限制
 *   --require-frq  仅保留有当代语料库词频（frq>0）的常用词，进一步瘦身
 *
 * 输入 CSV 字段（ECDICT 标准表头）：
 *   word, phonetic, definition, translation, pos, collins, oxford,
 *   tag, bnc, frq, exchange, detail, audio
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const DATA_DIR = path.join(ROOT, "data");
// 优先用完整版 ecdict.csv，回退到样例 ecdict.mini.csv
const INPUT_CSV = [
  path.join(DATA_DIR, "ecdict.csv"),
  path.join(DATA_DIR, "ecdict.mini.csv"),
].find((p) => fs.existsSync(p)) || path.join(DATA_DIR, "ecdict.csv");
const OUTPUT_DIR = path.join(ROOT, "assets", "dict");
const OUTPUT_JSON = path.join(OUTPUT_DIR, "ecdict.min.json");

function parseArgs(argv) {
  const args = { limit: 0, requireFrq: false };
  for (const item of argv.slice(2)) {
    if (item.startsWith("--limit=")) {
      args.limit = Number(item.slice("--limit=".length)) || 0;
    } else if (item === "--require-frq") {
      args.requireFrq = true;
    }
  }
  return args;
}

/**
 * 解析单行 CSV，支持双引号包裹字段、字段内逗号与转义的双引号（""）。
 * 注意：ECDICT 的 translation 字段内可能含换行 \n（已是字面 \n 文本，非真实换行）。
 */
function parseCsvLine(line) {
  const fields = [];
  let current = "";
  let inQuotes = false;

  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          current += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        current += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      fields.push(current);
      current = "";
    } else {
      current += ch;
    }
  }
  fields.push(current);
  return fields;
}

/**
 * 清洗中文释义：
 * - 把字面的 \n 拆成多义项
 * - 去掉 [网络]/[医]/[化] 等来源标记的整条义项（保留权威基础释义）
 * - 合并成「；」分隔的紧凑文本，便于卡片单行展示
 */
function cleanTranslation(raw) {
  const text = String(raw || "").trim();
  if (!text) return "";

  const parts = text
    .split(/\\n|\n/)
    .map((item) => item.trim())
    .filter(Boolean)
    .filter((item) => !/^\[(网络|医|化|计|经|法|军|电|建|机|物|生|动|植)\]/.test(item));

  const kept = parts.length > 0 ? parts : [text];
  return normalizePosInTranslation(kept.join("；"));
}

/**
 * 把 ECDICT 释义中的非标准词性缩写统一为标准写法。
 * 例："a. 新的" → "adj. 新的"
 */
function normalizePosInTranslation(text) {
  // 匹配义项开头或分号后的 "a. "，替换为 "adj. "
  // 注意：不全局裸替换，避免误伤正文里的 "a."
  return text.replace(/(^|；)a\. /g, "$1adj. ");
}

function buildExchangeMap(exchange) {
  // exchange 形如 "d:perceived/p:perceived/3:perceives/i:perceiving"
  // 取所有变形 -> 原词，用于离线词形还原（went -> go）
  const text = String(exchange || "").trim();
  if (!text) return [];
  const forms = [];
  for (const seg of text.split("/")) {
    const idx = seg.indexOf(":");
    if (idx <= 0) continue;
    const value = seg.slice(idx + 1).trim();
    if (value) forms.push(value);
  }
  return forms;
}

function main() {
  const args = parseArgs(process.argv);

  if (!fs.existsSync(INPUT_CSV)) {
    console.error(`[build-dict] 未找到输入文件：${INPUT_CSV}`);
    console.error("请先下载 ecdict.mini.csv 放到 data/ 目录后重试。");
    process.exit(1);
  }

  const content = fs.readFileSync(INPUT_CSV, "utf8");
  const lines = content.split(/\r?\n/);
  const header = parseCsvLine(lines[0]).map((h) => h.trim());

  const col = {
    word: header.indexOf("word"),
    phonetic: header.indexOf("phonetic"),
    translation: header.indexOf("translation"),
    frq: header.indexOf("frq"),
    bnc: header.indexOf("bnc"),
    exchange: header.indexOf("exchange"),
  };

  if (col.word < 0 || col.translation < 0) {
    console.error("[build-dict] CSV 表头缺少 word/translation 列，无法处理。");
    process.exit(1);
  }

  const entries = [];
  const lemmaMap = {}; // 变形 -> 原词

  for (let i = 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (!line) continue;
    const fields = parseCsvLine(line);

    const word = String(fields[col.word] || "").trim();
    if (!word) continue;

    const translation = cleanTranslation(fields[col.translation]);
    if (!translation) continue;

    const frq = col.frq >= 0 ? Number(fields[col.frq]) || 0 : 0;
    if (args.requireFrq && frq <= 0) continue;

    const phonetic = col.phonetic >= 0 ? String(fields[col.phonetic] || "").trim() : "";
    const bnc = col.bnc >= 0 ? Number(fields[col.bnc]) || 0 : 0;

    entries.push({ word, phonetic, translation, frq, bnc });

    if (col.exchange >= 0) {
      for (const form of buildExchangeMap(fields[col.exchange])) {
        const key = form.toLowerCase();
        if (key && key !== word.toLowerCase() && !lemmaMap[key]) {
          lemmaMap[key] = word.toLowerCase();
        }
      }
    }
  }

  // 按词频排序：frq>0 优先（数值越小越高频），再按 bnc
  entries.sort((a, b) => {
    const fa = a.frq > 0 ? a.frq : Number.MAX_SAFE_INTEGER;
    const fb = b.frq > 0 ? b.frq : Number.MAX_SAFE_INTEGER;
    if (fa !== fb) return fa - fb;
    const ba = a.bnc > 0 ? a.bnc : Number.MAX_SAFE_INTEGER;
    const bb = b.bnc > 0 ? b.bnc : Number.MAX_SAFE_INTEGER;
    return ba - bb;
  });

  const limited = args.limit > 0 ? entries.slice(0, args.limit) : entries;

  // 输出精简结构：去掉排序用的 frq/bnc，运行时不需要
  const dict = limited.map(({ word, phonetic, translation }) => ({
    w: word,
    p: phonetic,
    t: translation,
  }));

  const output = {
    version: 1,
    source: "ECDICT mini (skywind3000/ECDICT, MIT)",
    count: dict.length,
    lemmaCount: Object.keys(lemmaMap).length,
    entries: dict,
    lemma: lemmaMap,
  };

  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  fs.writeFileSync(OUTPUT_JSON, JSON.stringify(output), "utf8");

  const bytes = fs.statSync(OUTPUT_JSON).size;
  console.log("[build-dict] 完成");
  console.log(`  词条数：${dict.length}`);
  console.log(`  词形还原映射：${output.lemmaCount}`);
  console.log(`  输出文件：${OUTPUT_JSON}`);
  console.log(`  体积：${(bytes / 1024 / 1024).toFixed(2)} MB`);
}

main();
