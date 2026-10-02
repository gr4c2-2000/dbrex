/**
 * The connection form.
 *
 * A form, because the thing it replaced was a chain of eight modal pickers: you
 * could not see what you had already answered, could not go back to change one
 * of them, and a mistake on the third question meant starting over. Everything
 * is on screen at once and nothing is committed until Save.
 *
 * The fields come from the daemon, so choosing a kind draws that engine's own
 * options — the same reason the picker version had no per-kind code, kept here.
 */

import type {
  FormBootstrap,
  FormHostMessage,
  FormProvider,
  FormSubmission,
  FormWebviewMessage,
  Scope,
} from '../src/connectionFormProtocol';
import { FORM_PROTOCOL } from '../src/connectionFormProtocol';

interface Api {
  postMessage(message: FormWebviewMessage): void;
}
declare function acquireVsCodeApi(): Api;
const vscode = acquireVsCodeApi();

const app = document.getElementById('app')!;

interface State {
  bootstrap?: FormBootstrap;
  kind: string;
  scope: Scope;
  /** What has been typed, kept across a change of kind so a shared field survives. */
  readonly values: Map<string, string>;
  name: string;
  reference: string;
  password: string;
  problems: Map<string, string>;
  banner: string | undefined;
}

const state: State = {
  kind: '',
  scope: 'global',
  values: new Map(),
  name: '',
  reference: '',
  password: '',
  problems: new Map(),
  banner: undefined,
};

window.addEventListener('message', event => apply(event.data as FormHostMessage));
vscode.postMessage({ type: 'ready', protocol: FORM_PROTOCOL });

function apply(message: FormHostMessage): void {
  switch (message.type) {
    case 'bootstrap': {
      state.bootstrap = message.data;
      state.kind = message.data.providers[0]?.id ?? '';
      const usable = message.data.scopes.find(s => s.available);
      state.scope = usable?.scope ?? 'global';
      render();
      return;
    }
    case 'failed':
      state.banner = message.message;
      state.problems = new Map(message.problems.map(p => [p.field, p.message]));
      render();
      return;
    case 'saved':
      state.banner = undefined;
      render();
      return;
  }
}

function provider(): FormProvider | undefined {
  return state.bootstrap?.providers.find(p => p.id === state.kind);
}

/* ---------------------------------------------------------------- building */

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className !== undefined) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/** A labelled row: label, control, description, and the problem if there is one. */
function row(
  label: string,
  control: HTMLElement,
  options: { description?: string; problem?: string; required?: boolean } = {},
): HTMLElement {
  const wrapper = el('div', 'field');
  const labelEl = el('label', 'label', label);
  if (options.required === true) labelEl.append(el('span', 'required', ' *'));
  labelEl.htmlFor = control.id;
  wrapper.append(labelEl, control);
  if (options.description !== undefined) wrapper.append(el('div', 'hint', options.description));
  if (options.problem !== undefined) wrapper.append(el('div', 'problem', options.problem));
  if (options.problem !== undefined) control.classList.add('invalid');
  return wrapper;
}

function text(id: string, value: string, onInput: (value: string) => void, placeholder = ''): HTMLInputElement {
  const input = el('input');
  input.type = 'text';
  input.id = id;
  input.value = value;
  input.placeholder = placeholder;
  input.addEventListener('input', () => onInput(input.value));
  return input;
}

function render(): void {
  const data = state.bootstrap;
  if (data === undefined) {
    app.replaceChildren(el('div', 'loading', 'Asking the daemon what it can connect to…'));
    return;
  }
  if (data.providers.length === 0) {
    app.replaceChildren(el('div', 'problem', 'The daemon reports no providers.'));
    return;
  }

  const form = el('div', 'form');
  if (state.banner !== undefined) form.append(el('div', 'banner', state.banner));

  form.append(el('h1', undefined, 'New connection'));
  form.append(kindRow(data));
  form.append(row(
    'Name',
    text('f-name', state.name, v => { state.name = v; }, 'prod'),
    { required: true, description: 'How you will refer to it in SQL and on the command line.', ...problem('name') },
  ));

  const current = provider();
  if (current !== undefined) {
    form.append(el('h2', undefined, `${current.displayName} settings`));
    for (const field of current.fields) {
      if (field.prompt === false) continue;
      form.append(fieldRow(field));
    }
    if (current.takesSecret) form.append(passwordRow());
  }

  form.append(el('h2', undefined, 'Where it lives'));
  form.append(scopeRow(data));

  form.append(row(
    'What is it for?',
    text('f-reference', state.reference, v => { state.reference = v; },
      'Production orders. Schema docs: https://…'),
    { description: 'Shown to an AI agent before it queries. Optional, and the cheapest context there is.' },
  ));

  form.append(buttons());
  app.replaceChildren(form);
}

function problem(field: string): { problem?: string } {
  const message = state.problems.get(field);
  return message === undefined ? {} : { problem: message };
}

/**
 * The kind, as a list of choices rather than a dropdown.
 *
 * Visible all at once: which engines are supported is the first thing somebody
 * opening this wants to know, and a collapsed select hides exactly that.
 */
function kindRow(data: FormBootstrap): HTMLElement {
  const wrapper = el('div', 'field');
  wrapper.append(el('div', 'label', 'Kind'));

  const choices = el('div', 'choices');
  for (const p of data.providers) {
    const choice = el('button', state.kind === p.id ? 'choice selected' : 'choice');
    choice.type = 'button';
    choice.append(el('span', 'choice-name', p.displayName));
    choice.setAttribute('aria-pressed', String(state.kind === p.id));
    choice.addEventListener('click', () => {
      if (state.kind === p.id) return;
      state.kind = p.id;
      // Problems belonged to the previous engine's fields.
      state.problems = new Map();
      render();
    });
    choices.append(choice);
  }
  wrapper.append(choices);
  return wrapper;
}

function fieldRow(field: FormProvider['fields'][number]): HTMLElement {
  const id = `f-opt-${field.name}`;
  const stored = state.values.get(field.name);

  if (field.type === 'boolean') {
    const box = el('input');
    box.type = 'checkbox';
    box.id = id;
    box.checked = stored === undefined ? field.default === true : stored === 'true';
    // Recorded immediately, so the value is right even if the kind changes next.
    state.values.set(field.name, String(box.checked));
    box.addEventListener('change', () => state.values.set(field.name, String(box.checked)));
    const line = el('div', 'checkbox');
    line.append(box, el('label', 'checkbox-label', field.name));
    (line.lastChild as HTMLLabelElement).htmlFor = id;
    const wrapper = el('div', 'field');
    wrapper.append(line, el('div', 'hint', field.description));
    return wrapper;
  }

  const initial = stored ?? (field.default === undefined ? '' : String(field.default));
  const input = text(id, initial, v => state.values.set(field.name, v));
  if (field.type === 'number') input.inputMode = 'numeric';
  state.values.set(field.name, initial);

  return row(field.name, input, {
    description: field.description,
    ...(field.required === true ? { required: true } : {}),
    ...problem(field.name),
  });
}

/**
 * The password field.
 *
 * Offered here rather than as a separate step afterwards, because "add the
 * connection, then remember to add its password" is two things to remember and
 * the second one is what makes the first one work. It goes to the daemon's
 * vault, never into the file.
 */
function passwordRow(): HTMLElement {
  const input = el('input');
  input.type = 'password';
  input.id = 'f-password';
  input.value = state.password;
  input.autocomplete = 'off';
  input.addEventListener('input', () => { state.password = input.value; });
  return row('Password', input, {
    description: 'Stored in the daemon’s vault, not in the connections file. Leave empty to add it later.',
  });
}

function scopeRow(data: FormBootstrap): HTMLElement {
  const wrapper = el('div', 'field');
  const choices = el('div', 'choices scopes');

  for (const option of data.scopes) {
    const choice = el('button', state.scope === option.scope ? 'choice selected' : 'choice');
    choice.type = 'button';
    choice.disabled = !option.available;
    choice.append(el('span', 'choice-name', option.scope === 'global' ? 'Just for me' : 'This workspace'));
    choice.append(el('span', 'choice-detail', option.available ? option.file : 'no folder is open'));
    choice.addEventListener('click', () => {
      state.scope = option.scope;
      render();
    });
    choices.append(choice);
  }

  wrapper.append(el('div', 'label', 'Scope'), choices);
  wrapper.append(el('div', 'hint',
    'A workspace file can be committed, so everyone working on the repository gets the connection. Passwords never go in it.'));
  return wrapper;
}

function buttons(): HTMLElement {
  const bar = el('div', 'actions');

  const save = el('button', 'primary', 'Save connection');
  save.type = 'button';
  save.addEventListener('click', submit);

  const cancel = el('button', 'secondary', 'Cancel');
  cancel.type = 'button';
  cancel.addEventListener('click', () => vscode.postMessage({ type: 'cancel' }));

  bar.append(save, cancel);
  return bar;
}

function submit(): void {
  const current = provider();
  if (current === undefined) return;

  const options: Record<string, string> = {};
  for (const field of current.fields) {
    if (field.prompt === false) continue;
    const value = state.values.get(field.name);
    if (value !== undefined) options[field.name] = value;
  }

  const submission: FormSubmission = {
    name: state.name,
    kind: state.kind,
    reference: state.reference,
    scope: state.scope,
    options,
    password: state.password,
  };
  // Validation is the host's: it owns the list of names already taken and the
  // field declarations, and a second copy here would be a second opinion.
  vscode.postMessage({ type: 'submit', submission });
}
