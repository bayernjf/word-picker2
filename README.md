# WordCatcher

一个基于 Chromium Manifest V3 的浏览器扩展：按住 `Ctrl` 悬停英文单词即可查词翻译，并支持一键收藏到本地单词本。

## 功能

- 按住 `Ctrl` 进入查词模式，鼠标悬停英文单词触发翻译
- 使用 Shadow DOM 渲染悬浮弹窗，避免页面样式污染
- 一键保存单词、句子上下文、来源地址与标题
- Popup 页面支持搜索、删除、导出 `JSON / CSV`
- Options 页面支持配置查词键、悬停延迟、免费翻译源与缓存上限
- 使用 `chrome.storage.local` 存储单词本、设置与翻译缓存

## 开发使用

1. 打开 `chrome://extensions/`
2. 开启开发者模式
3. 选择“加载已解压的扩展程序”
4. 选择当前项目目录
5. 默认即使用免费公开接口，无需额外填写 `App Key` 或 `App Secret`

## 目录

- `manifest.json`：扩展清单
- `content/`：内容脚本与弹窗样式
- `service/`：Service Worker
- `popup/`：单词本 Popup 页面
- `options/`：设置页
- `lib/`：共享存储、缓存与翻译逻辑
- `tests/`：手动测试清单
