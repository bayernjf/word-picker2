/**
 * 打包脚本：生成可上传 Chrome 商店的 zip
 *
 * 用白名单方式，只把运行时必需的文件打进 dist/wordcatcher.zip：
 *   manifest.json + assets/ + content/ + lib/ + options/ + popup/ + service/
 * 明确排除：data/（63MB 原料 csv）、scripts/、tests/、node_modules/ 等。
 *
 * 运行：node scripts/pack.js
 * 前置：先跑 node scripts/build-dict.js 生成 assets/dict/ecdict.min.json
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const DIST_DIR = path.join(ROOT, "dist");
const ZIP_PATH = path.join(DIST_DIR, "wordcatcher.zip");

// 运行时必需，按白名单打包
const INCLUDE = [
  "manifest.json",
  "assets",
  "content",
  "lib",
  "options",
  "popup",
  "service",
];

const REQUIRED_DICT = path.join(ROOT, "assets", "dict", "ecdict.min.json");

function main() {
  // 1. 校验离线词库已生成
  if (!fs.existsSync(REQUIRED_DICT)) {
    console.error("[pack] 缺少离线词库：assets/dict/ecdict.min.json");
    console.error("请先运行：node scripts/build-dict.js");
    process.exit(1);
  }

  // 2. 校验白名单文件都存在
  const missing = INCLUDE.filter((item) => !fs.existsSync(path.join(ROOT, item)));
  if (missing.length > 0) {
    console.error(`[pack] 缺少必需文件/目录：${missing.join(", ")}`);
    process.exit(1);
  }

  // 3. 准备 dist 并清理旧 zip
  fs.mkdirSync(DIST_DIR, { recursive: true });
  if (fs.existsSync(ZIP_PATH)) {
    fs.rmSync(ZIP_PATH);
  }

  // 4. 用 zip 命令打包（macOS/Linux 自带），排除 .DS_Store
  //    -r 递归，-X 不存额外属性，--exclude 排除噪音文件
  execFileSync(
    "zip",
    ["-r", "-X", ZIP_PATH, ...INCLUDE, "--exclude", "*.DS_Store", "--exclude", "__MACOSX/*"],
    { cwd: ROOT, stdio: "inherit" }
  );

  const bytes = fs.statSync(ZIP_PATH).size;
  console.log("\n[pack] 打包完成");
  console.log(`  输出：${ZIP_PATH}`);
  console.log(`  体积：${(bytes / 1024 / 1024).toFixed(2)} MB`);
  console.log("  可直接上传 Chrome 开发者后台。");
}

main();
