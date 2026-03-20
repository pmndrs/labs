import { describe, it, expect } from 'vitest';
import { hello } from '../src/index.js';

describe('hello', () => {
  it('returns greeting with default name', () => {
    expect(hello()).toBe('Hello, world!');
  });

  it('returns greeting with custom name', () => {
    expect(hello('vitest')).toBe('Hello, vitest!');
  });
});
