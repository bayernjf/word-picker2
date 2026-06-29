/**
 * 打包脚本：生成可上传 Chrome 商店的 zip
 *
 * 运行前要求 TypeScript 已编译到 dist/extension，离线词库已生成到 assets/dict/ecdict.min.json。
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const ROOT = process.cwd();
const DIST_DIR = path.join(ROOT, "dist");
const EXTENSION_DIR = path.join(DIST_DIR, "extension");
const ZIP_PATH = path.join(DIST_DIR, "wordcatcher.zip");

const INCLUDE = [
  "manifest.json",
  "assets",
  "content",
  "lib",
  "options",
  "popup",
  "service",
];

const STATIC_FILES = [
  "manifest.json",
  "popup/popup.html",
  "popup/popup.css",
  "options/options.html",
];

const REQUIRED_COMPILED_FILES = [
  "content/shared.js",
  "content/content-script.js",
  "popup/popup.js",
  "options/options.js",
  "service/service-worker.js",
];

const REQUIRED_DICT = path.join(ROOT, "assets", "dict", "ecdict.min.json");

function copyFile(sourceRelativePath: string): void {
  const source = path.join(ROOT, sourceRelativePath);
  const target = path.join(EXTENSION_DIR, sourceRelativePath);
  if (!fs.existsSync(source)) {
    throw new Error(`[pack] 缺少静态文件：${sourceRelativePath}`);
  }
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(source, target);
}

function copyDirectory(sourceRelativePath: string): void {
  const source = path.join(ROOT, sourceRelativePath);
  const target = path.join(EXTENSION_DIR, sourceRelativePath);
  if (!fs.existsSync(source)) {
    throw new Error(`[pack] 缺少静态目录：${sourceRelativePath}`);
  }
  fs.rmSync(target, { recursive: true, force: true });
  fs.cpSync(source, target, { recursive: true });
}

function main(): void {
  if (!fs.existsSync(REQUIRED_DICT)) {
    console.error("[pack] 缺少离线词库：assets/dict/ecdict.min.json");
    console.error("请先运行：npm run build:dict");
    process.exit(1);
  }

  const missingCompiled = REQUIRED_COMPILED_FILES.filter((item) => !fs.existsSync(path.join(EXTENSION_DIR, item)));
  if (missingCompiled.length > 0) {
    console.error(`[pack] 缺少编译产物：${missingCompiled.join(", ")}`);
    console.error("请先运行：npm run build:ts");
    process.exit(1);
  }

  for (const file of STATIC_FILES) {
    copyFile(file);
  }
  copyDirectory("assets");

  const missing = INCLUDE.filter((item) => !fs.existsSync(path.join(EXTENSION_DIR, item)));
  if (missing.length > 0) {
    console.error(`[pack] 缺少必需文件/目录：${missing.join(", ")}`);
    process.exit(1);
  }

  fs.mkdirSync(DIST_DIR, { recursive: true });
  if (fs.existsSync(ZIP_PATH)) {
    fs.rmSync(ZIP_PATH);
  }

  execFileSync(
    "zip",
    ["-r", "-X", ZIP_PATH, ...INCLUDE, "--exclude", "*.DS_Store", "--exclude", "__MACOSX/*", "--exclude", "*.map"],
    { cwd: EXTENSION_DIR, stdio: "inherit" }
  );

  const bytes = fs.statSync(ZIP_PATH).size;
  console.log("\n[pack] 打包完成");
  console.log(`  输出：${ZIP_PATH}`);
  console.log(`  体积：${(bytes / 1024 / 1024).toFixed(2)} MB`);
  console.log("  可直接上传 Chrome 开发者后台。");
}

main();
