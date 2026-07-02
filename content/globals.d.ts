// Content scripts load browser-polyfill as a global script before this file,
// so `browser` is available on `window` without an import.
declare const browser: typeof import("webextension-polyfill").default;
