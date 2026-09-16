/**
 * NDJSON logger.
 *
 * Two rules carried over from the old implementation because they were right:
 * logging must never throw, and rotation must bound both age and total size.
 * One change: writes are queued and flushed asynchronously. The old logger
 * called `appendFileSync` on the extension host thread for every line.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

export type Level = 'debug' | 'info' | 'warn' | 'error';

const ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export interface LoggerOptions {
  readonly dir: string;
  readonly level: Level;
  readonly retentionDays: number;
  readonly maxTotalBytes: number;
  /** Mirror to stderr. On for a foreground daemon, off when detached. */
  readonly echo: boolean;
}

export class Logger {
  private queue: string[] = [];
  private flushing = false;
  private options: LoggerOptions;

  constructor(options: LoggerOptions) {
    this.options = options;
    try {
      fs.mkdirSync(options.dir, { recursive: true });
      this.sweep();
    } catch {
      /* logging must never take the daemon down */
    }
  }

  setLevel(level: Level): void {
    this.options = { ...this.options, level };
  }

  debug(message: string, fields?: Record<string, unknown>): void { this.write('debug', message, fields); }
  info(message: string, fields?: Record<string, unknown>): void { this.write('info', message, fields); }
  warn(message: string, fields?: Record<string, unknown>): void { this.write('warn', message, fields); }
  error(message: string, fields?: Record<string, unknown>): void { this.write('error', message, fields); }

  write(level: Level, message: string, fields?: Record<string, unknown>): void {
    if (ORDER[level] < ORDER[this.options.level]) return;
    let line: string;
    try {
      line = JSON.stringify({ ts: new Date().toISOString(), level, message, ...fields }) + '\n';
    } catch {
      line = JSON.stringify({ ts: new Date().toISOString(), level, message, fields: '[unserialisable]' }) + '\n';
    }
    if (this.options.echo) process.stderr.write(line);
    this.queue.push(line);
    void this.flush();
  }

  /** Wait for queued lines to reach disk. Used on shutdown and by tests. */
  async drain(): Promise<void> {
    while (this.queue.length > 0 || this.flushing) {
      await this.flush();
      if (this.flushing) await new Promise(r => setTimeout(r, 5));
    }
  }

  private async flush(): Promise<void> {
    if (this.flushing || this.queue.length === 0) return;
    this.flushing = true;
    const batch = this.queue.join('');
    this.queue = [];
    try {
      await fs.promises.appendFile(this.file(), batch);
    } catch {
      /* dropped on purpose: a full disk must not break queries */
    } finally {
      this.flushing = false;
    }
  }

  private file(): string {
    const day = new Date().toISOString().slice(0, 10);
    return path.join(this.options.dir, `dbrex-${day}.log`);
  }

  /** Drop logs older than the retention window, then oldest-first over the size cap. */
  private sweep(): void {
    const cutoff = Date.now() - this.options.retentionDays * 86_400_000;
    const files = fs.readdirSync(this.options.dir)
      .filter(f => f.startsWith('dbrex-') && f.endsWith('.log'))
      .map(f => {
        const full = path.join(this.options.dir, f);
        const stat = fs.statSync(full);
        return { full, mtime: stat.mtimeMs, size: stat.size };
      })
      .sort((a, b) => a.mtime - b.mtime);

    let total = files.reduce((s, f) => s + f.size, 0);
    for (const f of files) {
      const tooOld = f.mtime < cutoff;
      const tooBig = total > this.options.maxTotalBytes;
      if (!tooOld && !tooBig) break;
      try {
        fs.unlinkSync(f.full);
        total -= f.size;
      } catch {
        /* ignore */
      }
    }
  }
}

/** A logger that discards everything. For tests and for code that may run before setup. */
export const NULL_LOGGER: Pick<Logger, 'debug' | 'info' | 'warn' | 'error'> = {
  debug: () => {}, info: () => {}, warn: () => {}, error: () => {},
};
