/**
 * Turning a filled-in form into a connections-file entry.
 *
 * Separate from the form and from the panel, and free of `vscode`, because this
 * is the part that decides what gets written to somebody's configuration and so
 * is the part worth testing. The form collects strings; a field declared as a
 * number has to become one, a checkbox has to become a boolean, and a blank has
 * to be left out entirely rather than written as an empty string the provider
 * then has to interpret.
 */

import * as path from 'node:path';
import type { FieldSpec, ProviderInfo } from '@dbrex/core';
import type { FormProvider, FormSubmission, ScopeOption } from './connectionFormProtocol';

export interface Problem {
  /** Field name, or `name` / `kind` for the two the form owns itself. */
  readonly field: string;
  readonly message: string;
}

/**
 * Coerce one declared field from what a form control produced.
 *
 * Returns `undefined` for "leave this out". A provider distinguishes an absent
 * option from a present empty one — absent means "use the default", and an empty
 * string means "the host is the empty string" — so a blank must not be written.
 */
export function coerceField(field: FieldSpec, raw: string | undefined): unknown {
  const value = (raw ?? '').trim();

  if (field.type === 'boolean') {
    // A checkbox always reports something, so a boolean is never "absent"
    // unless the form never drew it.
    if (raw === undefined) return undefined;
    return value === 'true' || value === 'on' || value === '1';
  }

  if (value.length === 0) return undefined;

  if (field.type === 'number') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : Number.NaN;
  }

  return value;
}

/** Everything wrong with a submission, or an empty list. */
export function validateSubmission(
  submission: FormSubmission,
  fields: readonly FieldSpec[],
  existing: readonly string[],
): Problem[] {
  const problems: Problem[] = [];
  const name = submission.name.trim();

  if (name.length === 0) {
    problems.push({ field: 'name', message: 'a name is required' });
  } else if (existing.some(taken => taken === name)) {
    // Caught here rather than by the daemon, which would load the file and have
    // one of the two entries silently win.
    problems.push({ field: 'name', message: `a connection named "${name}" already exists` });
  }

  if (submission.kind.trim().length === 0) {
    problems.push({ field: 'kind', message: 'choose what kind of connection this is' });
  }

  for (const field of fields) {
    const value = coerceField(field, submission.options[field.name]);

    if (field.required === true && value === undefined) {
      problems.push({ field: field.name, message: `${field.name} is required` });
      continue;
    }
    if (typeof value === 'number' && Number.isNaN(value)) {
      problems.push({ field: field.name, message: `${field.name} must be a number` });
    }
  }

  return problems;
}

/**
 * The entry to write.
 *
 * Options go in an `options` block rather than at the top level. Both spellings
 * are accepted, and the nested one keeps a provider's own option from colliding
 * with a key the file format owns — a connection with a field called `name` or
 * `kind` is not hypothetical once providers can declare their own.
 */
export function buildEntry(
  submission: FormSubmission,
  fields: readonly FieldSpec[],
): Record<string, unknown> {
  const options: Record<string, unknown> = {};
  for (const field of fields) {
    const value = coerceField(field, submission.options[field.name]);
    // A value equal to the declared default is still written: it is what the
    // user chose, and a default that changes later should not silently change
    // their connection with it.
    if (value !== undefined) options[field.name] = value;
  }

  const reference = submission.reference.trim();
  return {
    name: submission.name.trim(),
    kind: submission.kind.trim(),
    ...(reference.length === 0 ? {} : { reference }),
    // Declared so the daemon knows where the credential comes from. A password
    // typed into the form is stored in the vault, not in this file.
    ...(submission.password.length > 0 ? { secret: { from: 'vault' } } : {}),
    options,
  };
}

/**
 * Where each scope writes.
 *
 * Shown in the form rather than described, because "this workspace" means
 * nothing until you can see the path it produces — and when no folder is open it
 * means nothing at all, which the form has to be able to say.
 */
export function scopeOptions(configDir: string, workspace: string | undefined): ScopeOption[] {
  return [
    { scope: 'global', file: path.join(configDir, 'connections.json'), available: true },
    {
      scope: 'workspace',
      file: workspace === undefined
        ? '(no folder is open)'
        : path.join(workspace, '.dbrex', 'connections.json'),
      available: workspace !== undefined,
    },
  ];
}

/**
 * A provider as the form needs it.
 *
 * `takesSecret` is read from the declared fields rather than from a list of
 * engine names: a provider that asks for a `user` is a provider that will be
 * asked for a password, and one that does not — a local directory — must not be
 * offered a password box it would never use.
 */
export function formProvider(provider: ProviderInfo): FormProvider {
  return {
    id: provider.id,
    displayName: provider.displayName,
    fields: provider.fields,
    takesSecret: provider.fields.some(f => f.name === 'user'),
  };
}
