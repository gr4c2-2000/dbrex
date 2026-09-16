/**
 * Who answers a password prompt.
 *
 * One process, one stdin. `dbrex query` reads it with a readline of its own,
 * but `dbrex shell` already holds it for the length of a session, and a second
 * reader on the same stream takes half the keystrokes from the first. So the
 * answer is indirected: whoever owns the terminal installs its own reader and
 * puts the previous one back when it is done.
 */

import * as readline from 'node:readline';

let current: (prompt: string) => Promise<string> = askHidden;

export function askSecret(prompt: string): Promise<string> {
  return current(prompt);
}

/** Install a reader. Returns the undo, which the caller must run. */
export function useSecretPrompt(ask: (prompt: string) => Promise<string>): () => void {
  const previous = current;
  current = ask;
  return () => { current = previous; };
}

/** Read a line without echoing it, on an interface of its own. */
export function askHidden(prompt: string): Promise<string> {
  return new Promise(resolve => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    rl.question(prompt, answer => {
      rl.close();
      process.stdout.write('\n');
      resolve(answer);
    });
    hide(rl, prompt);
  });
}

/** Read a line without echoing it, on an interface that already exists. */
export function askHiddenOn(rl: readline.Interface, prompt: string): Promise<string> {
  return new Promise(resolve => {
    const restore = hide(rl, prompt);
    rl.question(prompt, answer => {
      restore();
      process.stdout.write('\n');
      resolve(answer);
    });
  });
}

/**
 * Echo the prompt, swallow what is typed after it.
 *
 * `_writeToOutput` is readline's own hook for exactly this; there is no public
 * API for a hidden read.
 */
function hide(rl: readline.Interface, prompt: string): () => void {
  const out = rl as unknown as {
    output?: NodeJS.WriteStream;
    _writeToOutput?: ((text: string) => void) | undefined;
  };
  const previous = out._writeToOutput;
  out._writeToOutput = (text: string) => {
    if (text.startsWith(prompt)) out.output?.write(prompt);
  };
  return () => { out._writeToOutput = previous; };
}
