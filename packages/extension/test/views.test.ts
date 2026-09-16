import { describe, expect, it } from 'vitest';
import { isViewFileFor, loadViews, resolveWithin, viewNameFor, type FileReader } from '../src/views';

function reader(files: Record<string, string>): FileReader {
  return {
    list: async () => Object.keys(files).map(file => file.replace(/^.*\//, '')),
    read: async file => {
      const found = files[file];
      if (found === undefined) throw new Error(`no such file: ${file}`);
      return found;
    },
  };
}

describe('viewNameFor', () => {
  it('recognises the two conventions', () => {
    expect(viewNameFor('sales', 'sales.chart.js')).toBe('chart');
    expect(viewNameFor('sales', 'sales.view.weekly.js')).toBe('weekly');
  });

  it('ignores files belonging to another query', () => {
    expect(viewNameFor('sales', 'orders.chart.js')).toBeUndefined();
    expect(viewNameFor('sales', 'sales.sql')).toBeUndefined();
    expect(viewNameFor('sales', 'sales.chart.ts')).toBeUndefined();
    expect(viewNameFor('sales', 'sales.view..js')).toBeUndefined();
  });

  it('does not confuse a query whose name is a prefix of another', () => {
    expect(viewNameFor('sales', 'sales-eu.chart.js')).toBeUndefined();
  });
});

describe('resolveWithin', () => {
  it('accepts a path inside the query directory', () => {
    expect(resolveWithin('/q', 'views/bar.js')).toBe('/q/views/bar.js');
    expect(resolveWithin('/q', './bar.js')).toBe('/q/bar.js');
  });

  it('refuses to leave the query directory', () => {
    // A `.sql` file can arrive from a repository or a colleague. Its manifest
    // must not be able to name a file elsewhere on the machine — which the old
    // loader allowed, absolute paths and `~` included.
    expect(resolveWithin('/q', '/etc/passwd')).toBeUndefined();
    expect(resolveWithin('/q', '~/.ssh/id_ed25519')).toBeUndefined();
    expect(resolveWithin('/q', '../secrets.js')).toBeUndefined();
    expect(resolveWithin('/q', 'views/../../secrets.js')).toBeUndefined();
    expect(resolveWithin('/q', '')).toBeUndefined();
  });
});

describe('loadViews by convention', () => {
  it('finds sibling views and labels them', async () => {
    const loaded = await loadViews('/q/sales.sql', reader({
      '/q/sales.sql': 'SELECT 1',
      '/q/sales.chart.js': 'render = () => {}',
      '/q/sales.view.by_region.js': '// region',
    }));

    expect(loaded.views.map(v => [v.name, v.label])).toEqual([
      ['chart', 'Chart'],
      ['by_region', 'By region'],
    ]);
    expect(loaded.views[0]!.code).toBe('render = () => {}');
    expect(loaded.defaultView).toBeUndefined();
  });

  it('returns nothing when the directory cannot be read', async () => {
    await expect(loadViews('/q/sales.sql', {
      list: async () => { throw new Error('EACCES'); },
      read: async () => '',
    })).resolves.toEqual({ views: [] });
  });

  it('skips a view it cannot read rather than failing the query', async () => {
    const loaded = await loadViews('/q/sales.sql', {
      list: async () => ['sales.chart.js', 'sales.view.broken.js'],
      read: async file => {
        if (file.endsWith('broken.js')) throw new Error('EACCES');
        return 'ok';
      },
    });
    expect(loaded.views.map(v => v.name)).toEqual(['chart']);
  });

  it('only ever reads files beside the query', async () => {
    const read: string[] = [];
    await loadViews('/q/sales.sql', {
      list: async () => ['sales.chart.js'],
      read: async file => { read.push(file); return ''; },
    });
    expect(read).toEqual(['/q/sales.chart.js']);
  });
});

describe('loadViews with a manifest', () => {
  it('takes labels, order and the default view from the manifest', async () => {
    const loaded = await loadViews('/q/sales.sql', reader({
      '/q/sales.config.json': JSON.stringify({
        views: [
          { name: 'bars', file: 'views/bar.js', label: 'Bars' },
          { name: 'lines', file: 'views/line.js' },
        ],
        defaultView: 'bars',
      }),
      '/q/views/bar.js': '// bar',
      '/q/views/line.js': '// line',
    }));

    expect(loaded.views.map(v => [v.name, v.label])).toEqual([['bars', 'Bars'], ['lines', 'Lines']]);
    expect(loaded.defaultView).toBe('bars');
  });

  it('still picks up conventional views the manifest did not mention', async () => {
    const loaded = await loadViews('/q/sales.sql', reader({
      '/q/sales.config.json': JSON.stringify({ views: [{ name: 'bars', file: 'views/bar.js' }] }),
      '/q/views/bar.js': '// bar',
      '/q/sales.chart.js': '// chart',
    }));
    expect(loaded.views.map(v => v.name)).toEqual(['bars', 'chart']);
  });

  it('drops a manifest entry that points outside the directory', async () => {
    const loaded = await loadViews('/q/sales.sql', reader({
      '/q/sales.config.json': JSON.stringify({
        views: [
          { name: 'escape', file: '../../evil.js' },
          { name: 'fine', file: 'views/bar.js' },
        ],
      }),
      '/q/views/bar.js': '// bar',
    }));
    expect(loaded.views.map(v => v.name)).toEqual(['fine']);
  });

  it('attaches the manifest stylesheet to every view', async () => {
    const loaded = await loadViews('/q/sales.sql', reader({
      '/q/sales.config.json': JSON.stringify({ css: 'theme.css' }),
      '/q/theme.css': 'body { color: red }',
      '/q/sales.chart.js': '// chart',
    }));
    expect(loaded.views[0]!.css).toBe('body { color: red }');
  });

  it('ignores a stylesheet that points outside the directory', async () => {
    const loaded = await loadViews('/q/sales.sql', reader({
      '/q/sales.config.json': JSON.stringify({ css: '/etc/shadow' }),
      '/q/sales.chart.js': '// chart',
    }));
    expect(loaded.views[0]!.css).toBeUndefined();
  });

  it('falls back to the convention when the manifest is broken', async () => {
    const loaded = await loadViews('/q/sales.sql', reader({
      '/q/sales.config.json': '{ not json',
      '/q/sales.chart.js': '// chart',
    }));
    // Hiding every view because a manifest has a typo would be the wrong trade.
    expect(loaded.views.map(v => v.name)).toEqual(['chart']);
  });

  it('ignores a defaultView naming a view that does not exist', async () => {
    const loaded = await loadViews('/q/sales.sql', reader({
      '/q/sales.config.json': JSON.stringify({ defaultView: 'ghost' }),
      '/q/sales.chart.js': '// chart',
    }));
    expect(loaded.defaultView).toBeUndefined();
  });
});

describe('isViewFileFor', () => {
  it('recognises the files that should redraw a query\'s views', () => {
    expect(isViewFileFor('/q/sales.sql', '/q/sales.chart.js')).toBe(true);
    expect(isViewFileFor('/q/sales.sql', '/q/sales.view.weekly.js')).toBe(true);
    expect(isViewFileFor('/q/sales.sql', '/q/sales.config.json')).toBe(true);
  });

  it('ignores everything else, including the query itself', () => {
    expect(isViewFileFor('/q/sales.sql', '/q/sales.sql')).toBe(false);
    expect(isViewFileFor('/q/sales.sql', '/q/orders.chart.js')).toBe(false);
    expect(isViewFileFor('/q/sales.sql', '/elsewhere/sales.chart.js')).toBe(false);
    expect(isViewFileFor('/q/sales.sql', '/q/notes.md')).toBe(false);
  });
});
