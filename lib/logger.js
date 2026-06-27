const LEVEL_PRIORITY = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

const STORAGE_KEY = 'wordcatcher-log-level';

function getMinLevel() {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved && saved in LEVEL_PRIORITY) return saved;
  } catch {
    // ignore
  }
  // 默认只输出 warn/error，开发调试时可在控制台执行：
  // localStorage.setItem('wordcatcher-log-level', 'debug')
  return 'warn';
}

function isLevelEnabled(level) {
  return LEVEL_PRIORITY[level] >= LEVEL_PRIORITY[getMinLevel()];
}

function formatTime() {
  const now = new Date();
  return (
    now.toLocaleTimeString('zh-CN', { hour12: false }) +
    '.' +
    String(now.getMilliseconds()).padStart(3, '0')
  );
}

function formatArgs(args) {
  return args.map((arg) => {
    if (arg instanceof Error) {
      return arg.stack || arg.message;
    }
    if (typeof arg === 'object' && arg !== null) {
      try {
        return JSON.stringify(arg);
      } catch {
        return String(arg);
      }
    }
    return arg;
  });
}

class Logger {
  constructor(namespace) {
    this.ns = namespace;
  }

  debug(...args) {
    if (!isLevelEnabled('debug')) return;
    console.debug(`[${formatTime()}] [${this.ns}] [DEBUG]`, ...formatArgs(args));
  }

  info(...args) {
    if (!isLevelEnabled('info')) return;
    console.info(`[${formatTime()}] [${this.ns}] [INFO]`, ...formatArgs(args));
  }

  warn(...args) {
    if (!isLevelEnabled('warn')) return;
    console.warn(`[${formatTime()}] [${this.ns}] [WARN]`, ...formatArgs(args));
  }

  error(...args) {
    if (!isLevelEnabled('error')) return;
    console.error(`[${formatTime()}] [${this.ns}] [ERROR]`, ...formatArgs(args));
  }
}

export function createLogger(namespace) {
  return new Logger(namespace);
}

export { Logger };
