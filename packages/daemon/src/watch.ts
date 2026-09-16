/**
 * Watching connection files.
 *
 * Editing a connections file and having it take effect without a reload was one
 * of the old tool's quiet pleasures, and it went missing in the rewrite.
 *
 * Two details make this less trivial than `fs.watch(file)`:
 *
 * - Editors save atomically, writing a temporary file and renaming it over the
 *   original. A watch on the *file* follows the replaced inode and stops
 *   firing, so the directory is watched and the name filtered instead.
 * - A single save can produce several events. They are debounced, and the
 *   callback is only invoked when the file's content actually differs from what
 *   was last loaded — an editor that rewrites an unchanged buffer should not
 *   drop every open database session.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';

const DEBOUNCE_MS = 300;

export class ConfigWatcher {
  private readonly watchers = new Map<string, fs.FSWatcher>();
  private readonly digests = new Map<string, string>();
  private timer: NodeJS.Timeout | undefined;

  constructor(
    private readonly onChange: () => void,
    private readonly debounceMs: number = DEBOUNCE_MS,
  ) {}

  /**
   * Watch one connections file. Safe to call repeatedly with the same path, and
   * safe when neither the file nor its directory exists yet — a file created
   * later still fires, as long as its directory does.
   */
  add(file: string): void {
    if (this.watchers.has(file)) return;
    const directory = path.dirname(file);
    const name = path.basename(file);

    this.digests.set(file, digestOf(file));

    try {
      const watcher = fs.watch(directory, (_event, changed) => {
        if (changed !== null && changed !== name) return;
        this.schedule(file);
      });
      watcher.on('error', () => this.remove(file));
      this.watchers.set(file, watcher);
    } catch {
      // An unreadable or missing directory is not worth failing over; the
      // explicit reload command still works.
    }
  }

  remove(file: string): void {
    this.watchers.get(file)?.close();
    this.watchers.delete(file);
    this.digests.delete(file);
  }

  dispose(): void {
    if (this.timer) clearTimeout(this.timer);
    for (const watcher of this.watchers.values()) watcher.close();
    this.watchers.clear();
    this.digests.clear();
  }

  private schedule(file: string): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = undefined;
      const digest = digestOf(file);
      if (digest === this.digests.get(file)) return;
      this.digests.set(file, digest);
      this.onChange();
    }, this.debounceMs);
    this.timer.unref?.();
  }
}

/** Content hash, or a marker for "not there", so appearing and vanishing both count. */
function digestOf(file: string): string {
  try {
    return createHash('sha1').update(fs.readFileSync(file)).digest('hex');
  } catch {
    return 'absent';
  }
}
