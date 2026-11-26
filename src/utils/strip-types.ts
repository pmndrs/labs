// Bun shares the worker entry and has no stripTypeScriptTypes export to link.
import * as module from 'node:module';

/** Erase type annotations exactly as Node does when it runs a TypeScript file. */
export function stripTypes(source: string): string {
  // Node warns that the function is experimental on first use.
  const emitWarning = Object.getOwnPropertyDescriptor(process, 'emitWarning')!;
  process.emitWarning = () => {};
  try {
    return module.stripTypeScriptTypes(source);
  } finally {
    Object.defineProperty(process, 'emitWarning', emitWarning);
  }
}
