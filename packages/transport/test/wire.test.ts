import { describe, it, expect } from 'vitest';
import { utf8Bytes, Sequencer, randomSessionId } from '../src/wire.js';

describe('wire helpers', () => {
  it('utf8Bytes counts bytes, not chars', () => {
    expect(utf8Bytes('abc')).toBe(3);
    expect(utf8Bytes('🏠')).toBe(4);
    expect(utf8Bytes('héllo')).toBe(6);
  });

  it('Sequencer is monotonic', () => {
    const s = new Sequencer();
    expect([s.next(), s.next(), s.next()]).toEqual([0, 1, 2]);
    expect(s.value).toBe(2);
  });

  it('randomSessionId is unique-ish', () => {
    const a = randomSessionId();
    const b = randomSessionId();
    expect(a).not.toBe(b);
    expect(a.length).toBeGreaterThan(0);
  });
});
