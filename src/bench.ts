import * as core from './core/index.ts';

export type B = {
  run(thrw?: boolean, tune?: Record<string, unknown>): Promise<unknown>;
};

export const bench = core.bench as (
  nameOrFn: string | ((...args: any[]) => any),
  fn?: (...args: any[]) => any
) => B;

export const group = core.group as (
  nameOrFn: string | (() => any),
  fn?: () => any
) => void | Promise<void>;

export const measure = core.measure as (
  fn: (...args: any[]) => any,
  opts?: Record<string, unknown>
) => Promise<any>;

export const run = core.run as (opts?: Record<string, unknown>) => Promise<any>;
