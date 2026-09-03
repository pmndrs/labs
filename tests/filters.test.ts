import { describe, expect, it } from 'vitest';
import { fileHasAnyTag } from '../src/cli/utils.ts';

const source = `
group('vec3 @core @vec3', () => {
  bench('add', () => {});
  bench("scale @slow", () => {});
});
`;

describe('selecting bench files by tag', () => {
  it('matches tags declared in the file as whole tokens', () => {
    expect(fileHasAnyTag(source, ['@vec3'])).toBe(true);
    expect(fileHasAnyTag(source, ['@slow'])).toBe(true);
    expect(fileHasAnyTag(source, ['@missing', '@core'])).toBe(true);
  });

  it('does not match a prefix of a declared tag', () => {
    expect(fileHasAnyTag(source, ['@vec'])).toBe(false);
    expect(fileHasAnyTag(source, ['@slo'])).toBe(false);
  });

  it('selects every file when no tags are given', () => {
    expect(fileHasAnyTag(source, [])).toBe(true);
  });
});
