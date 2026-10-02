/**
 * The results webview.
 *
 * Rows are windowed: only the visible slice exists in the DOM, and pages are
 * fetched from the host as the user scrolls. The old table rendered every row
 * it was handed, which was survivable only because it was never handed more
 * than 500.
 *
 * No framework and no chart library. The whole document is this file, and
 * custom view code runs in a sandboxed frame that this document cannot be
 * reached from.
 */

import type { HostMessage, Lane, ViewDefinition, WebviewMessage } from '../src/webviewProtocol';
import { WEBVIEW_PROTOCOL } from '../src/webviewProtocol';
import { buildSandboxDocument } from '../src/sandboxDocument';

declare function acquireVsCodeApi(): { postMessage(message: WebviewMessage): void };

const vscode = acquireVsCodeApi();
const PAGE = 500;
const ROW_HEIGHT = 21;
const OVERSCAN = 20;

interface State {
  columns: readonly { name: string; type: string }[];
  rowCount: number;
  connection: string;
  sql: string;
  elapsedMs: number;
  truncated: boolean;
  views: readonly ViewDefinition[];
  active: string;
  pages: Map<number, readonly (readonly unknown[])[]>;
  requested: Set<number>;
  status: 'idle' | 'running' | 'ready' | 'failed';
  message?: string | undefined;
  hint?: string | undefined;
  progressRows: number;
}

function freshState(): State {
  return {
    columns: [],
    rowCount: 0,
    connection: '',
    sql: '',
    elapsedMs: 0,
    truncated: false,
    views: [],
    active: 'table',
    pages: new Map(),
    requested: new Set(),
    status: 'idle',
    progressRows: 0,
  };
}

/**
 * One state per lane.
 *
 * An agent and a person share this panel. They used to share one state, so an
 * agent walking a schema replaced whatever was on screen, repeatedly. Each lane
 * now keeps its own result, its own paging and its own active view, and only
 * the lane being looked at is rendered.
 */
const lanes: Record<Lane, State> = { user: freshState(), agent: freshState() };
let shown: Lane = 'user';

/** The lane currently on screen. Reassigned when the tab changes. */
let state: State = lanes[shown];

/**
 * A lane that has received something while it was not on screen.
 *
 * Marked rather than switched to. Being dragged to an agent's result mid-read is
 * the behaviour this whole split exists to remove, so the lane says it has
 * something and waits.
 */
const unread: Record<Lane, boolean> = { user: false, agent: false };

function showLane(lane: Lane): void {
  shown = lane;
  state = lanes[lane];
  unread[lane] = false;
  render();
}

let laneBarEl: HTMLElement | undefined;

/**
 * The lane tabs.
 *
 * Hidden until an agent has actually run something: a person working alone has
 * no second lane to choose between, and a tab bar for it would be furniture.
 */
function laneBar(): HTMLElement {
  const el = document.createElement('div');
  el.className = 'bar';
  laneBarEl = el;
  if (lanes.agent.status === 'idle') {
    el.hidden = true;
    return el;
  }

  const tab = (lane: Lane, label: string): HTMLButtonElement => {
    const button = document.createElement('button');
    button.className = 'secondary';
    button.textContent = unread[lane] ? `${label} ●` : label;
    button.setAttribute('aria-pressed', String(shown === lane));
    button.addEventListener('click', () => showLane(lane));
    return button;
  };

  el.append(tab('user', 'Mine'), tab('agent', 'Agent'));
  return el;
}

/** Redraw only the lane tabs, leaving the shown lane's scroll position alone. */
function renderTabs(): void {
  const previous = laneBarEl;
  if (previous === undefined) {
    render();
    return;
  }
  previous.replaceWith(laneBar());
}

const app = document.getElementById('app')!;
const bootstrap = JSON.parse(
  document.getElementById('sandbox-bootstrap')!.textContent ?? '{}',
) as { code?: string; nonce?: string };
const sandboxSource = bootstrap.code ?? '';
const sandboxNonce = bootstrap.nonce ?? '';

/**
 * Report a blocked resource instead of letting it fail in silence.
 *
 * A content policy denial is not an exception: nothing throws, the script
 * simply never runs. That is how the view sandbox stayed broken while looking
 * like a view that drew nothing.
 *
 * Reported once per rendered view. A page that trips the policy usually trips
 * it repeatedly, and one notification per violation is its own kind of broken.
 */
let violationReported = false;

window.addEventListener('securitypolicyviolation', event => {
  if (violationReported) return;
  violationReported = true;
  const detail = `blocked by the content policy: ${event.violatedDirective}`;
  showViewProblem(detail, 'The view was not allowed to run. This is a bug in DbRex, not in your view.');
  vscode.postMessage({ type: 'viewFailed', view: state.active, message: detail });
});

/** Put a problem where the chart would have been, and nowhere else. */
function showViewProblem(headline: string, detail?: string): void {
  const host = document.getElementById('view-host');
  if (!host) return;
  const box = document.createElement('div');
  box.className = 'message error';
  box.textContent = headline;
  if (detail !== undefined) {
    const note = document.createElement('div');
    note.className = 'hint';
    note.textContent = detail;
    box.append(note);
  }
  host.replaceChildren(box);
}

window.addEventListener('message', event => apply(event.data as HostMessage));
vscode.postMessage({ type: 'ready', protocol: WEBVIEW_PROTOCOL });

function apply(message: HostMessage): void {
  if (message.type === 'hello') return;

  // Written to the lane the message names, drawn only if that is the one on
  // screen: an agent's query must not pull the view away from what is being
  // read, and must not be lost either.
  const target = lanes[message.lane];

  // Anything in the user's lane was caused by the user, so that is where they
  // are looking: switch to it. Nothing switches to the agent's lane — being
  // pulled there mid-read is what this split exists to prevent.
  if (message.lane === 'user' && shown !== 'user') {
    shown = 'user';
    state = lanes.user;
    unread.user = false;
  }

  const visible = message.lane === shown;
  if (!visible) unread[message.lane] = true;

  switch (message.type) {
    case 'running':
      target.status = 'running';
      target.connection = message.connection;
      target.sql = message.sql;
      target.progressRows = 0;
      if (visible) render();
      else renderTabs();
      return;
    case 'progress':
      target.progressRows = message.rows;
      if (visible) updateBar();
      return;
    case 'failed':
      target.status = 'failed';
      target.message = message.message;
      target.hint = message.hint;
      if (visible) render();
      else renderTabs();
      return;
    case 'result':
      target.status = 'ready';
      target.columns = message.columns;
      target.rowCount = message.rowCount;
      target.connection = message.connection;
      target.sql = message.sql;
      target.elapsedMs = message.stats.elapsedMs;
      target.truncated = message.stats.truncated;
      target.views = message.views;
      target.pages = new Map();
      target.requested = new Set();
      if (target.active !== 'table' && !message.views.some(v => v.name === target.active)) {
        target.active = 'table';
      }
      if (message.defaultView !== undefined
        && message.views.some(v => v.name === message.defaultView)) {
        target.active = message.defaultView;
      }
      if (visible) render();
      else renderTabs();
      return;
    case 'rows': {
      target.pages.set(Math.floor(message.offset / PAGE), message.rows);
      if (!visible) return;
      if (state.active === 'table') paintRows();
      else renderView();
      return;
    }
  }
}

// ---------------------------------------------------------------- rendering

let scroller: HTMLDivElement | undefined;
let tbody: HTMLTableSectionElement | undefined;
let topPad: HTMLTableRowElement | undefined;
let bottomPad: HTMLTableRowElement | undefined;

function render(): void {
  app.replaceChildren(laneBar(), bar(), body());
  if (state.active === 'table') paintRows();
  else renderView();
}

function bar(): HTMLElement {
  const el = document.createElement('div');
  el.className = 'bar';

  const tab = (name: string, label: string): HTMLButtonElement => {
    const button = document.createElement('button');
    button.className = 'secondary';
    button.textContent = label;
    button.setAttribute('aria-pressed', String(state.active === name));
    button.addEventListener('click', () => {
      state.active = name;
      render();
    });
    return button;
  };

  if (state.status === 'ready') {
    el.append(tab('table', 'Table'));
    for (const view of state.views) el.append(tab(view.name, view.label));
  }

  const summary = document.createElement('span');
  summary.className = 'sql';
  if (state.status === 'running') {
    summary.append(runningDino());
    const label = document.createElement('span');
    label.className = 'running-label';
    label.textContent = state.progressRows > 0 ? `${state.progressRows} rows…` : 'running…';
    summary.append(label);
  } else if (state.status === 'ready') {
    summary.textContent =
      `${state.rowCount} row${state.rowCount === 1 ? '' : 's'}` +
      `${state.truncated ? ' (truncated)' : ''} · ${state.elapsedMs}ms · ${state.connection}`;
  }
  el.append(summary);

  const spacer = document.createElement('span');
  spacer.className = 'spacer';
  el.append(spacer);

  if (state.status === 'running') {
    const cancel = document.createElement('button');
    cancel.textContent = 'Cancel';
    cancel.addEventListener('click', () => vscode.postMessage({ type: 'cancel' }));
    el.append(cancel);
  } else if (state.status === 'ready') {
    const copy = document.createElement('button');
    copy.className = 'secondary';
    copy.textContent = 'Copy SQL';
    copy.addEventListener('click', () => vscode.postMessage({ type: 'copy', text: state.sql }));
    el.append(copy);
  }

  return el;
}

function body(): HTMLElement {
  if (state.status === 'failed') {
    const el = document.createElement('div');
    el.className = 'message error';
    el.textContent = state.message ?? 'failed';
    if (state.hint) {
      const hint = document.createElement('div');
      hint.className = 'hint';
      hint.textContent = state.hint;
      el.append(hint);
    }
    return el;
  }

  if (state.status !== 'ready') {
    const el = document.createElement('div');
    el.className = 'message';
    el.textContent = state.status === 'running' ? 'Running…' : 'Run a statement with Ctrl+Enter.';
    return el;
  }

  if (state.active !== 'table') {
    const host = document.createElement('div');
    host.className = 'scroll';
    host.id = 'view-host';
    return host;
  }

  const wrapper = document.createElement('div');
  wrapper.className = 'scroll';
  const table = document.createElement('table');
  const thead = document.createElement('thead');
  const headRow = document.createElement('tr');

  for (const column of state.columns) {
    const th = document.createElement('th');
    th.textContent = column.name;
    const type = document.createElement('span');
    type.className = 'type';
    type.textContent = column.type;
    th.append(type);
    headRow.append(th);
  }
  thead.append(headRow);

  tbody = document.createElement('tbody');
  topPad = document.createElement('tr');
  topPad.className = 'pad';
  bottomPad = document.createElement('tr');
  bottomPad.className = 'pad';

  table.append(thead, tbody);
  wrapper.append(table);
  wrapper.addEventListener('scroll', () => paintRows());
  scroller = wrapper;
  return wrapper;
}

/** Draw only the rows the viewport can show, and ask for the pages behind them. */
function paintRows(): void {
  if (!tbody || !scroller || !topPad || !bottomPad) return;

  const viewportRows = Math.ceil(scroller.clientHeight / ROW_HEIGHT) + OVERSCAN * 2;
  const first = Math.max(0, Math.floor(scroller.scrollTop / ROW_HEIGHT) - OVERSCAN);
  const last = Math.min(state.rowCount, first + viewportRows);

  request(first, last);

  const children: Node[] = [];
  topPad.style.height = `${first * ROW_HEIGHT}px`;
  bottomPad.style.height = `${Math.max(0, state.rowCount - last) * ROW_HEIGHT}px`;
  children.push(topPad);

  for (let index = first; index < last; index++) {
    const row = rowAt(index);
    const tr = document.createElement('tr');
    for (let column = 0; column < state.columns.length; column++) {
      const td = document.createElement('td');
      if (row === undefined) {
        td.textContent = '';
      } else {
        const value = row[column];
        if (value === null || value === undefined) {
          td.className = 'null';
          td.textContent = 'NULL';
        } else if (typeof value === 'number') {
          td.className = 'num';
          td.textContent = String(value);
        } else {
          td.textContent = typeof value === 'object' ? JSON.stringify(value) : String(value);
        }
        td.title = td.textContent;
      }
      tr.append(td);
    }
    children.push(tr);
  }

  children.push(bottomPad);
  tbody.replaceChildren(...children);
}

function rowAt(index: number): readonly unknown[] | undefined {
  return state.pages.get(Math.floor(index / PAGE))?.[index % PAGE];
}

function request(first: number, last: number): void {
  for (let page = Math.floor(first / PAGE); page <= Math.floor(Math.max(first, last - 1) / PAGE); page++) {
    if (state.pages.has(page) || state.requested.has(page)) continue;
    state.requested.add(page);
    vscode.postMessage({ type: 'requestRows', lane: shown, offset: page * PAGE, limit: PAGE });
  }
}

// ------------------------------------------------------------------- views

/**
 * Run a custom view inside a frame with an opaque origin.
 *
 * `sandbox="allow-scripts"` without `allow-same-origin` is what makes this a
 * real boundary: the frame cannot reach this document, cannot call
 * `acquireVsCodeApi`, and its own policy blocks every network destination. The
 * view gets its data by message, not by reaching for it.
 */
function renderView(): void {
  const host = document.getElementById('view-host');
  const view = state.views.find(v => v.name === state.active);
  if (!host || !view) return;

  // Views draw the first page; a diagram over a million rows is not a diagram.
  const rows = state.pages.get(0);
  if (rows === undefined) {
    if (!state.requested.has(0)) {
      state.requested.add(0);
      vscode.postMessage({ type: 'requestRows', lane: shown, offset: 0, limit: PAGE });
    }
    host.replaceChildren(message('Loading…'));
    return;
  }

  violationReported = false;
  const frame = document.createElement('iframe');
  frame.setAttribute('sandbox', 'allow-scripts');
  frame.srcdoc = buildSandboxDocument({
    nonce: sandboxNonce,
    runtime: sandboxSource,
    view: view.code,
    css: view.css,
    color: cssVar('--vscode-foreground'),
  });

  frame.addEventListener('load', () => {
    frame.contentWindow?.postMessage({
      name: view.name,
      data: { columns: state.columns.map(c => c.name), types: state.columns.map(c => c.type), rows },
    }, '*');
  });

  window.addEventListener('message', event => {
    const payload = event.data as { viewError?: string; view?: string } | undefined;
    if (payload?.viewError) {
      vscode.postMessage({ type: 'viewFailed', view: payload.view ?? view.name, message: payload.viewError });
    }
  });

  host.replaceChildren(frame);
}

/**
 * The running dinosaur.
 *
 * Built from rectangles rather than an image so it inherits the editor's
 * foreground colour in any theme, and so it costs a few hundred bytes. Two leg
 * positions alternate in CSS; nothing here runs a timer.
 */
function runningDino(): SVGSVGElement {
  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', '0 0 22 20');
  svg.setAttribute('class', 'dino');
  svg.setAttribute('aria-hidden', 'true');

  const box = (x: number, y: number, w: number, h: number, parent: Element): void => {
    const rect = document.createElementNS(NS, 'rect');
    rect.setAttribute('x', String(x));
    rect.setAttribute('y', String(y));
    rect.setAttribute('width', String(w));
    rect.setAttribute('height', String(h));
    parent.append(rect);
  };

  const body = document.createElementNS(NS, 'g');
  box(13, 1, 7, 6, body);      // head
  box(19, 3, 2, 2, body);      // snout
  box(12, 4, 2, 3, body);      // jaw
  box(7, 6, 8, 7, body);       // torso
  box(1, 7, 7, 3, body);       // tail
  box(0, 9, 3, 2, body);       // tail tip
  box(9, 12, 5, 3, body);      // hips
  box(11, 8, 3, 2, body);      // arm
  svg.append(body);

  // Eye: a hole punched in the head, so it works on any background.
  const eye = document.createElementNS(NS, 'rect');
  eye.setAttribute('x', '17');
  eye.setAttribute('y', '2');
  eye.setAttribute('width', '1');
  eye.setAttribute('height', '1');
  eye.setAttribute('class', 'dino-eye');
  svg.append(eye);

  const first = document.createElementNS(NS, 'g');
  first.setAttribute('class', 'dino-step-a');
  box(9, 15, 2, 4, first);
  box(12, 15, 2, 2, first);
  svg.append(first);

  const second = document.createElementNS(NS, 'g');
  second.setAttribute('class', 'dino-step-b');
  box(9, 15, 2, 2, second);
  box(12, 15, 2, 4, second);
  svg.append(second);

  return svg;
}

function message(text: string): HTMLElement {
  const el = document.createElement('div');
  el.className = 'message';
  el.textContent = text;
  return el;
}

function updateBar(): void {
  const existing = app.firstElementChild;
  if (existing) app.replaceChild(bar(), existing);
}

function cssVar(name: string): string {
  return getComputedStyle(document.body).getPropertyValue(name).trim() || 'inherit';
}
