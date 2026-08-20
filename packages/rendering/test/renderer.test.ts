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
  it('always resolves, with or without a browser', async () => {
    const r = await createRenderer();
    expect(typeof r.degraded).toBe('boolean');
  });

  it('reports degradation rather than throwing when no browser is present', async () => {
    const r = await createRenderer({ forceDegraded: true });
    expect(r.degraded).toBe(true);
    expect(await r.diagram.renderSvg('flowchart TD\n A')).toContain('<svg');
  });
});
