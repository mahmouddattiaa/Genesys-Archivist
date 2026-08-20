// packages/rendering/test/renderer.test.ts
import { describe, expect, it } from 'vitest';
import { NullRenderer, createRenderer } from '../src/index.js';

describe('NullRenderer', () => {
  it('returns a placeholder SVG rather than throwing', async () => {
    const svg = await new NullRenderer().renderSvg('flowchart TD\n A --> B');
    expect(svg).toContain('<svg');
  });

  it('returns an empty document rather than throwing', async () => {
    expect((await new NullRenderer().renderPdf('<p>x</p>', { title: 't' })).byteLength).toBe(0);
  });

  it('never executes tenant content in the placeholder', async () => {
    const svg = await new NullRenderer().renderSvg('%%{init:{"x":1}}%% <script>alert(1)</script>');
    expect(svg).not.toContain('<script>');
  });
});

describe('createRenderer', () => {
  // Launching a real headless browser routinely exceeds vitest's 5s default
  // when this file runs alongside anything else heavy, which made this fail
  // intermittently in a full-suite run while passing every time in isolation.
  // The timeout is here to catch a hang, not to race the scheduler.
  it('always resolves, with or without a browser', { timeout: 60_000 }, async () => {
    const r = await createRenderer();
    expect(typeof r.degraded).toBe('boolean');
  });

  it('reports degradation rather than throwing when no browser is present', async () => {
    const r = await createRenderer({ forceDegraded: true });
    expect(r.degraded).toBe(true);
    expect(await r.diagram.renderSvg('flowchart TD\n A')).toContain('<svg');
  });
});
