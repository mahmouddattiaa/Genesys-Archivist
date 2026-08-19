import { describe, expect, it } from 'vitest';

describe('workspace', () => {
  it('runs typescript under vitest', () => {
    const value: number = 1 + 1;
    expect(value).toBe(2);
  });
});
