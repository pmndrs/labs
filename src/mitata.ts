import * as mitata from './core/main.mjs';

export type B = {
  run(thrw?: boolean, tune?: Record<string, unknown>): Promise<unknown>;
};

export const bench = mitata.bench as (
  nameOrFn: string | ((...args: any[]) => any),
  fn?: (...args: any[]) => any
) => B;

export const group = mitata.group as (
  nameOrFn: string | (() => any),
  fn?: () => any
) => void | Promise<void>;

export const measure = mitata.measure as (
  fn: (...args: any[]) => any,
  opts?: Record<string, unknown>
) => Promise<any>;

export const run = mitata.run as (opts?: Record<string, unknown>) => Promise<any>;
