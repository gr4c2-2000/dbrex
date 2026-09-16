/**
 * The sandboxed view runner.
 *
 * This file is the runtime half of a frame with an opaque origin. The view's own
 * source is a second `<script>` in the same document, which defines a global
 * `render(data, ctx)`; this half receives the rows by message and calls it.
 *
 * The view is a real script rather than a string passed to `new Function`,
 * because the frame inherits the panel's content policy and that policy has no
 * `'unsafe-eval'`. Which is the better arrangement anyway: no eval at all.
 *
 * Nothing here can reach the panel document or the extension host:
 * `sandbox="allow-scripts"` without `allow-same-origin` sees to that, and the
 * frame's own policy sets `connect-src 'none'` so a view cannot exfiltrate the
 * data it is drawing.
 *
 * `ctx.chart` draws SVG. Not bundling a charting library is a deliberate trade:
 * the old panel shipped roughly a megabyte of ECharts into the webview and
 * handed view code the live library and the live container. Views here get
 * their own element and a declarative spec, and anything more elaborate is
 * plain DOM inside a frame that cannot do harm.
 */

interface ViewData {
  readonly columns: readonly string[];
  readonly types: readonly string[];
  readonly rows: readonly (readonly unknown[])[];
}

interface ChartSpec {
  readonly type: 'line' | 'bar' | 'scatter';
  /** Column name or index for the horizontal axis. Defaults to the first column. */
  readonly x?: string | number;
  /** Column names or indexes to plot. Defaults to every numeric column but `x`. */
  readonly y?: readonly (string | number)[];
  readonly title?: string;
}

interface ViewContext {
  readonly container: HTMLElement;
  /** Draw a chart from a spec. Returns the element it drew into. */
  chart(spec: ChartSpec): SVGSVGElement;
  /** Rows as objects, for view code that prefers names over positions. */
  records(): Record<string, unknown>[];
}

const PALETTE = ['#4e9bcd', '#d98d3a', '#5aab6b', '#c25b6b', '#8a76c4', '#b0894a'];

declare global {
  interface Window {
    render?: (data: ViewData, ctx: ViewContext) => unknown;
  }
}

window.addEventListener('message', event => {
  const payload = event.data as { name?: string; data?: ViewData } | undefined;
  if (!payload?.data) return;

  const root = document.getElementById('root');
  if (!root) return;
  root.replaceChildren();

  try {
    run(payload.data, root);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    showFailure(root, message, e instanceof Error ? e.stack : undefined);
    parent.postMessage({ viewError: message, view: payload.name }, '*');
  }
});

/**
 * Show the failure where the chart would have been.
 *
 * A view that throws is the author's own code failing while they edit it, so
 * the message belongs in the tab they are looking at — not in a notification
 * that interrupts, and not in a log they would have to know to open.
 */
function showFailure(root: HTMLElement, message: string, stack?: string): void {
  root.replaceChildren();
  const box = document.createElement('div');
  box.setAttribute('style', 'padding:16px;font:13px/1.5 monospace;white-space:pre-wrap;');

  const title = document.createElement('div');
  title.setAttribute('style', 'font-weight:bold;margin-bottom:6px;');
  title.textContent = 'This view did not run';
  box.append(title);

  const detail = document.createElement('div');
  detail.textContent = message;
  box.append(detail);

  // The first frame of the stack is usually the line the author needs; the rest
  // is this runtime and helps nobody.
  const where = stack?.split('\n').slice(1, 2).join('').trim();
  if (where !== undefined && where.length > 0) {
    const at = document.createElement('div');
    at.setAttribute('style', 'opacity:.6;margin-top:6px;');
    at.textContent = where;
    box.append(at);
  }

  root.append(box);
}

function run(data: ViewData, root: HTMLElement): void {
  const context: ViewContext = {
    container: root,
    chart: spec => chart(spec, data, root),
    records: () => data.rows.map(row => {
      const record: Record<string, unknown> = {};
      data.columns.forEach((name, i) => { record[name] = row[i]; });
      return record;
    }),
  };

  const render = window.render;
  if (typeof render !== 'function') {
    // An empty or malformed view file still gets a useful default rather than a
    // blank tab: first column across, every numeric column as a line.
    context.chart({ type: 'line' });
    return;
  }

  render(data, context);
}

function chart(spec: ChartSpec, data: ViewData, root: HTMLElement): SVGSVGElement {
  const xIndex = resolve(spec.x, data) ?? 0;
  const yIndexes = spec.y !== undefined
    ? spec.y.map(y => resolve(y, data)).filter((i): i is number => i !== undefined)
    : data.columns.map((_, i) => i).filter(i => i !== xIndex && isNumericColumn(data, i));

  const width = Math.max(320, root.clientWidth || 640);
  const height = Math.max(200, root.clientHeight || 360);
  const pad = { top: spec.title ? 34 : 16, right: 16, bottom: 34, left: 56 };

  const svg = element('svg');
  svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
  svg.setAttribute('width', '100%');
  svg.setAttribute('height', '100%');

  if (spec.title) {
    const title = element('text');
    title.setAttribute('x', String(width / 2));
    title.setAttribute('y', '20');
    title.setAttribute('text-anchor', 'middle');
    title.setAttribute('fill', 'currentColor');
    title.textContent = spec.title;
    svg.append(title);
  }

  if (yIndexes.length === 0 || data.rows.length === 0) {
    const empty = element('text');
    empty.setAttribute('x', String(width / 2));
    empty.setAttribute('y', String(height / 2));
    empty.setAttribute('text-anchor', 'middle');
    empty.setAttribute('fill', 'currentColor');
    empty.setAttribute('opacity', '0.6');
    empty.textContent = 'nothing numeric to plot';
    svg.append(empty);
    root.append(svg);
    return svg;
  }

  const plotWidth = width - pad.left - pad.right;
  const plotHeight = height - pad.top - pad.bottom;
  const values = yIndexes.flatMap(i => data.rows.map(row => toNumber(row[i])).filter(n => n !== undefined) as number[]);
  const max = Math.max(...values, 0);
  const min = Math.min(...values, 0);
  const span = max - min || 1;

  const xAt = (i: number): number =>
    pad.left + (data.rows.length === 1 ? plotWidth / 2 : (i / (data.rows.length - 1)) * plotWidth);
  const yAt = (value: number): number => pad.top + plotHeight - ((value - min) / span) * plotHeight;

  svg.append(axis(pad.left, pad.top + plotHeight, pad.left + plotWidth, pad.top + plotHeight));
  svg.append(axis(pad.left, pad.top, pad.left, pad.top + plotHeight));
  svg.append(label(pad.left - 8, yAt(max), format(max), 'end'));
  svg.append(label(pad.left - 8, yAt(min), format(min), 'end'));
  svg.append(label(pad.left, pad.top + plotHeight + 18, String(data.rows[0]?.[xIndex] ?? ''), 'start'));
  svg.append(label(
    pad.left + plotWidth,
    pad.top + plotHeight + 18,
    String(data.rows[data.rows.length - 1]?.[xIndex] ?? ''),
    'end',
  ));

  yIndexes.forEach((column, series) => {
    const colour = PALETTE[series % PALETTE.length]!;
    const points = data.rows
      .map((row, i) => ({ i, value: toNumber(row[column]) }))
      .filter((p): p is { i: number; value: number } => p.value !== undefined);

    if (spec.type === 'bar') {
      const barWidth = Math.max(1, (plotWidth / Math.max(1, data.rows.length)) / yIndexes.length - 1);
      for (const point of points) {
        const bar = element('rect');
        bar.setAttribute('x', String(xAt(point.i) + series * barWidth - barWidth / 2));
        bar.setAttribute('y', String(Math.min(yAt(point.value), yAt(0))));
        bar.setAttribute('width', String(barWidth));
        bar.setAttribute('height', String(Math.abs(yAt(point.value) - yAt(0))));
        bar.setAttribute('fill', colour);
        svg.append(bar);
      }
      return;
    }

    if (spec.type === 'scatter') {
      for (const point of points) {
        const dot = element('circle');
        dot.setAttribute('cx', String(xAt(point.i)));
        dot.setAttribute('cy', String(yAt(point.value)));
        dot.setAttribute('r', '2.5');
        dot.setAttribute('fill', colour);
        svg.append(dot);
      }
      return;
    }

    const line = element('path');
    line.setAttribute('fill', 'none');
    line.setAttribute('stroke', colour);
    line.setAttribute('stroke-width', '1.5');
    line.setAttribute('d', points.map((p, i) => `${i === 0 ? 'M' : 'L'}${xAt(p.i)},${yAt(p.value)}`).join(' '));
    svg.append(line);
  });

  yIndexes.forEach((column, series) => {
    svg.append(label(
      pad.left + 6 + series * 110,
      pad.top - 4,
      data.columns[column] ?? `column ${column}`,
      'start',
      PALETTE[series % PALETTE.length]!,
    ));
  });

  root.append(svg);
  return svg;
}

function resolve(key: string | number | undefined, data: ViewData): number | undefined {
  if (key === undefined) return undefined;
  if (typeof key === 'number') return key;
  const at = data.columns.indexOf(key);
  return at === -1 ? undefined : at;
}

function isNumericColumn(data: ViewData, index: number): boolean {
  return data.rows.some(row => toNumber(row[index]) !== undefined);
}

function toNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function format(value: number): string {
  return Math.abs(value) >= 1000 ? value.toLocaleString() : String(Math.round(value * 100) / 100);
}

function element<K extends keyof SVGElementTagNameMap>(name: K): SVGElementTagNameMap[K] {
  return document.createElementNS('http://www.w3.org/2000/svg', name);
}

function axis(x1: number, y1: number, x2: number, y2: number): SVGLineElement {
  const line = element('line');
  line.setAttribute('x1', String(x1));
  line.setAttribute('y1', String(y1));
  line.setAttribute('x2', String(x2));
  line.setAttribute('y2', String(y2));
  line.setAttribute('stroke', 'currentColor');
  line.setAttribute('opacity', '0.35');
  return line;
}

function label(x: number, y: number, text: string, anchor: string, colour = 'currentColor'): SVGTextElement {
  const el = element('text');
  el.setAttribute('x', String(x));
  el.setAttribute('y', String(y));
  el.setAttribute('text-anchor', anchor);
  el.setAttribute('font-size', '11');
  el.setAttribute('fill', colour);
  el.setAttribute('opacity', colour === 'currentColor' ? '0.7' : '1');
  el.textContent = text.length > 18 ? `${text.slice(0, 17)}…` : text;
  return el;
}
