/**
 * The document a custom view runs inside.
 *
 * Kept separate from the webview so it can be tested: the bugs it exists to
 * prevent produce no exception and no console output, only a blank tab.
 *
 * Two rules govern this file, both learned the hard way:
 *
 * 1. A `srcdoc` frame inherits the embedding document's content policy and
 *    enforces the *intersection* with its own. The panel allows scripts by
 *    nonce, so a frame declaring `'unsafe-inline'` intersects to nothing and
 *    its script never runs.
 * 2. That inherited policy has no `'unsafe-eval'`, so the view's code cannot be
 *    evaluated from a string. It is emitted as its own `<script>` tag instead,
 *    which is both allowed and a smaller hammer: no `eval`, no `new Function`,
 *    just a script that defines `render`.
 *
 * Handing the nonce over grants nothing. The frame has no `allow-same-origin`,
 * so it sits in an opaque origin with no reach into the panel, and both
 * policies deny every network destination.
 */

export interface SandboxDocumentOptions {
  /** The panel's nonce. The frame inherits its policy, so it must match. */
  readonly nonce: string;
  /** Bundled sandbox runtime: it calls `render` and draws charts. */
  readonly runtime: string;
  /** The user's view source. Defines `render(data, ctx)`. */
  readonly view: string;
  /** Stylesheet from the query's manifest, if it has one. */
  readonly css?: string | undefined;
  /** Editor foreground colour, so a view inherits the theme. */
  readonly color: string;
}

/**
 * Make a script body safe to place inside an HTML `<script>` element.
 *
 * The parser ends the element at the first `</script` regardless of JavaScript
 * syntax, so a view containing that text in a string would otherwise break out
 * of its own element and into the document.
 */
export function escapeScript(source: string): string {
  return source.replace(/<\/(script)/gi, '<\\/$1');
}

export function buildSandboxDocument(options: SandboxDocumentOptions): string {
  const { nonce, runtime, view, css, color } = options;
  const policy = [
    "default-src 'none'",
    `script-src 'nonce-${nonce}'`,
    `style-src 'nonce-${nonce}'`,
    "connect-src 'none'",
    'img-src data:',
  ].join('; ');

  return `<!DOCTYPE html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${policy}">
<style nonce="${nonce}">html,body{margin:0;height:100%;font-family:sans-serif;color:${color};}${
    css === undefined ? '' : `\n${css}`
  }</style>
</head><body><div id="root"></div>
<script nonce="${nonce}">${escapeScript(runtime)}</script>
<script nonce="${nonce}">${escapeScript(view)}</script>
</body></html>`;
}
