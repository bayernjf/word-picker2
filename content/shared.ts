interface Window {
  __WordCatcherShared: {
    escapeHtml: (value: unknown) => string;
    sendMessage: (message: object) => Promise<any>;
    createLogger: (namespace: string) => Logger;
  };
}

type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_PRIORITY: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

const STORAGE_KEY = 'wordcatcher-log-level';

class Logger {
  private ns: string;

  constructor(namespace: string) {
    this.ns = namespace;
  }

  private getMinLevel(): LogLevel {
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      if (saved && saved in LEVEL_PRIORITY) return saved as LogLevel;
    } catch {
      // ignore
    }
    return 'warn';
  }

  private isLevelEnabled(level: LogLevel): boolean {
    return LEVEL_PRIORITY[level] >= LEVEL_PRIORITY[this.getMinLevel()];
  }

  private formatTime(): string {
    const now = new Date();
    return (
      now.toLocaleTimeString('zh-CN', { hour12: false }) +
      '.' +
      String(now.getMilliseconds()).padStart(3, '0')
    );
  }

  private formatArgs(args: unknown[]): unknown[] {
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

  debug(...args: unknown[]): void {
    if (!this.isLevelEnabled('debug')) return;
    console.debug(`[${this.formatTime()}] [${this.ns}] [DEBUG]`, ...this.formatArgs(args));
  }

  info(...args: unknown[]): void {
    if (!this.isLevelEnabled('info')) return;
    console.info(`[${this.formatTime()}] [${this.ns}] [INFO]`, ...this.formatArgs(args));
  }

  warn(...args: unknown[]): void {
    if (!this.isLevelEnabled('warn')) return;
    console.warn(`[${this.formatTime()}] [${this.ns}] [WARN]`, ...this.formatArgs(args));
  }

  error(...args: unknown[]): void {
    if (!this.isLevelEnabled('error')) return;
    console.error(`[${this.formatTime()}] [${this.ns}] [ERROR]`, ...this.formatArgs(args));
  }
}

function createLogger(namespace: string): Logger {
  return new Logger(namespace);
}

(() => {
  function escapeHtml(value: unknown): string {
    return String(value || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function sendMessage(message: object): Promise<any> {
    return browser.runtime.sendMessage(message).then((response: any) => {
      if (!response?.success) {
        throw new Error(response?.error || "扩展消息请求失败");
      }
      return response;
    });
  }

  window.__WordCatcherShared = {
    escapeHtml,
    sendMessage,
    createLogger,
  };
})();
