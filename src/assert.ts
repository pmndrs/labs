import { serialize } from './bench/lib/snapshot.ts';

/** Error type used for failed benchmark checks. */
export class AssertionError extends Error {
  actual: unknown;
  expected: unknown;

  constructor(message: string, actual?: unknown, expected?: unknown) {
    super(message);
    this.name = 'AssertionError';
    this.actual = actual;
    this.expected = expected;
  }
}

function preview(value: unknown): string {
  let text: string;
  try {
    text = serialize(value);
  } catch {
    text = String(value);
  }
  return text.length > 60 ? `${text.slice(0, 59)}…` : text;
}

interface Assert {
  (condition: unknown, message?: string): asserts condition;
  /** Deep structural equality using the same serialization as snapshot digests. */
  equal(actual: unknown, expected: unknown, message?: string): void;
}

function assertCondition(condition: unknown, message = 'assertion failed'): asserts condition {
  if (!condition) throw new AssertionError(message);
}

function equal(actual: unknown, expected: unknown, message?: string): void {
  if (serialize(actual) === serialize(expected)) return;
  throw new AssertionError(
    message ?? `expected ${preview(expected)} but got ${preview(actual)}`,
    actual,
    expected
  );
}

export const assert: Assert = Object.assign(assertCondition, { equal });
