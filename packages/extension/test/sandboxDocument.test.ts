import { describe, expect, it } from 'vitest';
import { buildSandboxDocument } from '../src/sandboxDocument';

const base = { nonce: 'abc123', runtime: 'RUNTIME', view: 'function render() {}', color: '#fff' };

describe('the document a view runs in', () => {
  it('carries the panel nonce on both the script and the style', () => {
    // A srcdoc frame inherits the panel's policy and enforces the intersection
    // of the two. Declaring 'unsafe-inline' here intersects with the panel's
    // nonce policy to nothing, so the script never runs — no exception, no
    // console error, just a tab that draws nothing. That was the bug.
    const html = buildSandboxDocument(base);
    expect(html).toContain('<script nonce="abc123">');
    expect(html).toContain('<style nonce="abc123">');
    expect(html).toContain("script-src 'nonce-abc123'");
    expect(html).toContain("style-src 'nonce-abc123'");
  });

  it('never falls back to unsafe-inline, which cannot survive the intersection', () => {
    expect(buildSandboxDocument(base)).not.toContain('unsafe-inline');
  });

  it('denies the view every network destination', () => {
    const html = buildSandboxDocument(base);
    expect(html).toContain("default-src 'none'");
    expect(html).toContain("connect-src 'none'");
  });

  it('includes the runtime, the view and the manifest stylesheet', () => {
    const html = buildSandboxDocument({ ...base, css: '.bar { fill: red }' });
    expect(html).toContain('RUNTIME');
    expect(html).toContain('function render() {}');
    expect(html).toContain('.bar { fill: red }');
  });

  it('ships the view as its own script rather than something to evaluate', () => {
    // The inherited policy has no 'unsafe-eval', so `new Function(code)` is
    // blocked — which is the right outcome; a script tag is the smaller hammer.
    const html = buildSandboxDocument(base);
    expect(html).not.toContain('new Function');
    expect(html.match(/<script nonce="abc123">/g)).toHaveLength(2);
  });

  it('stops a view from breaking out of its own script element', () => {
    const hostile = 'const s = "</script><img src=x onerror=alert(1)>";';
    const html = buildSandboxDocument({ ...base, view: hostile });
    expect(html).not.toContain('</script><img');
    expect(html).toContain('<\\/script>');
  });

  it('works without a stylesheet', () => {
    expect(buildSandboxDocument(base)).toContain('<div id="root"></div>');
  });
});
