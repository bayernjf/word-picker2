type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_PRIORITY: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

const STORAGE_KEY = 'wordcatcher-log-level';

function getMinLevel(): LogLevel {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved && saved in LEVEL_PRIORITY) return saved as LogLevel;
  } catch {
    // ignore
  }
  // 默认只输出 warn/error，开发调试时可在控制台执行：
  // localStorage.setItem('wordcatcher-log-level', 'debug')
  return 'warn';
}

function isLevelEnabled(level: LogLevel): boolean {
  return LEVEL_PRIORITY[level] >= LEVEL_PRIORITY[getMinLevel()];
}

function formatTime(): string {
  const now = new Date();
  return (
    now.toLocaleTimeString('zh-CN', { hour12: false }) +
    '.' +
    String(now.getMilliseconds()).padStart(3, '0')
  );
}

function formatArgs(args: unknown[]): unknown[] {
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

export class Logger {
  private ns: string;

  constructor(namespace: string) {
    this.ns = namespace;
  }

  debug(...args: unknown[]): void {
    if (!isLevelEnabled('debug')) return;
    console.debug(`[${formatTime()}] [${this.ns}] [DEBUG]`, ...formatArgs(args));
  }

  info(...args: unknown[]): void {
    if (!isLevelEnabled('info')) return;
    console.info(`[${formatTime()}] [${this.ns}] [INFO]`, ...formatArgs(args));
  }

  warn(...args: unknown[]): void {
    if (!isLevelEnabled('warn')) return;
    console.warn(`[${formatTime()}] [${this.ns}] [WARN]`, ...formatArgs(args));
  }

  error(...args: unknown[]): void {
    if (!isLevelEnabled('error')) return;
    console.error(`[${formatTime()}] [${this.ns}] [ERROR]`, ...formatArgs(args));
  }
}

export function createLogger(namespace: string): Logger {
  return new Logger(namespace);
}
