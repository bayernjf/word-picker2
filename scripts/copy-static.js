/**
 * 复制静态资源到 dist/extension
 * 运行前需先执行：npx tsc -p tsconfig.extension.json
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = process.cwd();
const DIST = path.join(ROOT, 'dist', 'extension');

const FILES = [
  'manifest.json',
  'popup/popup.html',
  'popup/popup.css',
  'options/options.html',
];

const DIRS = ['assets'];

fs.mkdirSync(DIST, { recursive: true });

for (const file of FILES) {
  const src = path.join(ROOT, file);
  const dest = path.join(DIST, file);
  if (!fs.existsSync(src)) {
    console.error(`[copy-static] Missing: ${file}`);
    process.exit(1);
  }
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest);
  console.log(`[copy-static] ${file}`);
}

for (const dir of DIRS) {
  const src = path.join(ROOT, dir);
  const dest = path.join(DIST, dir);
  if (!fs.existsSync(src)) {
    console.error(`[copy-static] Missing: ${dir}/`);
    process.exit(1);
  }
  fs.rmSync(dest, { recursive: true, force: true });
  fs.cpSync(src, dest, { recursive: true });
  console.log(`[copy-static] ${dir}/`);
}

console.log('[copy-static] Done');
