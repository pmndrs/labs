import { createHash } from 'node:crypto';
import type { Snapshot } from '../types.ts';

/** Serializes supported values deterministically for equality and hashing. */
export function serialize(value: unknown): string {
  const seen = new Set<object>();

  const walk = (v: unknown): string => {
    if (v === null) return 'null';
    switch (typeof v) {
      case 'undefined':
        return 'undefined';
      case 'boolean':
      case 'number':
        return String(v);
      case 'bigint':
        return `${v}n`;
      case 'string':
        return JSON.stringify(v);
      case 'symbol':
        return v.toString();
      case 'function':
        return `[Function ${v.name || 'anonymous'}]`;
    }

    const o = v as object;
    if (seen.has(o)) throw new TypeError('cannot serialize a circular structure');
    seen.add(o);

    try {
      // Array.from preserves sparse slots as undefined.
      if (Array.isArray(o)) return `[${Array.from(o, walk).join(',')}]`;
      if (o instanceof DataView) {
        return `DataView[${Array.from(new Uint8Array(o.buffer, o.byteOffset, o.byteLength)).join(',')}]`;
      }
      if (ArrayBuffer.isView(o)) return `${o.constructor.name}[${Array.from(o as any).join(',')}]`;
      if (o instanceof ArrayBuffer) return `ArrayBuffer[${Array.from(new Uint8Array(o)).join(',')}]`;
      if (o instanceof Date) return `Date(${o.getTime()})`;
      if (o instanceof RegExp) return String(o);
      if (o instanceof Error) return `${o.name}(${JSON.stringify(o.message)})`;
      if (o instanceof Map) {
        const entries = [...o].map(([k, val]) => `${walk(k)}=>${walk(val)}`).sort();
        return `Map{${entries.join(',')}}`;
      }
      if (o instanceof Set) return `Set{${[...o].map(walk).sort().join(',')}}`;

      const ctor = (o as any).constructor;
      const tag = ctor && ctor !== Object ? ctor.name : '';
      const fields = Object.keys(o)
        .sort()
        .map((k) => `${JSON.stringify(k)}:${walk((o as any)[k])}`);
      return `${tag}{${fields.join(',')}}`;
    } finally {
      seen.delete(o);
    }
  };

  return walk(value);
}

/** Extracts a JSON-safe numeric snapshot within the value limit. */
function numeric(value: unknown, budget: { left: number }): Snapshot | null {
  if (typeof value === 'number') {
    if (--budget.left < 0) return null;
    return Number.isFinite(value) ? value : String(value);
  }
  if (ArrayBuffer.isView(value) && !(value instanceof DataView)) value = Array.from(value as any);
  if (!Array.isArray(value)) return null;
  const out: Snapshot[] = [];
  for (const item of value) {
    const n = numeric(item, budget);
    if (n === null) return null;
    out.push(n);
  }
  return out;
}

/** Preserves numeric values and hashes other outputs. */
export function toSnapshot(value: unknown): Snapshot {
  return (
    numeric(value, { left: 16384 }) ??
    createHash('sha256').update(serialize(value)).digest('hex').slice(0, 16)
  );
}

/** Compares finite numbers with relative tolerance and an absolute floor at one. */
function close(a: number, b: number, tolerance: number): boolean {
  if (a === b) return true;
  return Math.abs(a - b) <= tolerance * Math.max(1, Math.abs(a), Math.abs(b));
}

/** Compares finite numbers with tolerance and other values exactly. */
export function snapshotsDiffer(a: Snapshot, b: Snapshot, tolerance: number): boolean {
  if (typeof a === 'string' || typeof b === 'string') return a !== b;
  if (typeof a === 'number' || typeof b === 'number') {
    return typeof a !== typeof b || !close(a as number, b as number, tolerance);
  }
  if (a.length !== b.length) return true;
  return a.some((item, i) => snapshotsDiffer(item, b[i], tolerance));
}
