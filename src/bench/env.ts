/**
 * Higher-level environment detection for runtime name, version, CPU model,
 * architecture, and color support.  All functions probe `globalThis` and
 * dynamic imports. None depend on benchmark state.
 */

/** Whether the terminal supports ANSI colors (`FORCE_COLOR` / `NO_COLOR`). */
export function colors(): any {
  return (
    (globalThis as any).tjs?.env?.FORCE_COLOR ||
    (globalThis as any).process?.env?.FORCE_COLOR ||
    (!(globalThis as any).Deno?.noColor &&
      !(globalThis as any).tjs?.env?.NO_COLOR &&
      !(globalThis as any).process?.env?.NO_COLOR &&
      !(globalThis as any).process?.env?.NODE_DISABLE_COLORS)
  );
}

/** Detect the CPU model string via `os.cpus()` or equivalent. */
export async function cpu(): Promise<string | null> {
  if ((globalThis as any).process?.versions?.webcontainer) return null;
  try {
    let n;
    if ((n = (globalThis as any).require('os')?.cpus?.()?.[0]?.model)) return n;
  } catch {}
  try {
    let n;
    if ((n = (globalThis as any).require('node:os')?.cpus?.()?.[0]?.model)) return n;
  } catch {}
  try {
    let n;
    if ((n = (globalThis as any).tjs?.system?.cpus?.[0]?.model)) return n;
  } catch {}
  try {
    let n;
    const _os = 'node:os';
    if ((n = (await import(_os))?.cpus?.()?.[0]?.model)) return n;
  } catch {}

  return null;
}

/** Return the version string for the detected {@link runtime}. */
export function version(): string | null {
  return (
    (
      {
        v8: () => (globalThis as any).version?.(),
        bun: () => (globalThis as any).Bun?.version,
        'txiki.js': () => (globalThis as any).tjs?.version,
        deno: () => (globalThis as any).Deno?.version?.deno,
        llrt: () => (globalThis as any).process?.versions?.llrt,
        node: () => (globalThis as any).process?.versions?.node,
        graaljs: () => (globalThis as any).Graal?.versionGraalVM,
        webcontainer: () => (globalThis as any).process?.versions?.webcontainer,
        'quickjs-ng': () => (globalThis as any).navigator?.userAgent?.split?.('/')[1],
        hermes: () =>
          (globalThis as any).HermesInternal?.getRuntimeProperties?.()?.['OSS Release Version'],
      } as Record<string, () => string | null>
    )[runtime() as string]?.() || null
  );
}

/** Identify the current JS runtime by probing well-known globals. */
export function runtime(): string | null {
  if ((globalThis as any).d8) return 'v8';
  if ((globalThis as any).tjs) return 'txiki.js';
  if ((globalThis as any).Graal) return 'graaljs';
  if ((globalThis as any).process?.versions?.llrt) return 'llrt';
  if ((globalThis as any).process?.versions?.webcontainer) return 'webcontainer';
  if ((globalThis as any).inIon && (globalThis as any).performance?.mozMemory) return 'spidermonkey';
  if ((globalThis as any).window && (globalThis as any).netscape && (globalThis as any).InternalError)
    return 'firefox';
  if ((globalThis as any).window && (globalThis as any).navigator && (Error as any).prepareStackTrace)
    return 'chromium';
  if ((globalThis as any).navigator?.userAgent?.toLowerCase?.()?.includes?.('quickjs-ng'))
    return 'quickjs-ng';
  if (
    (globalThis as any).$262 &&
    (globalThis as any).lockdown &&
    (globalThis as any).AsyncDisposableStack
  )
    return 'XS Moddable';
  if (
    (globalThis as any).$ &&
    'IsHTMLDDA' in (globalThis as any).$ &&
    new Error().stack?.includes('runtime@')
  )
    return 'jsc';
  if (
    (globalThis as any).window &&
    (globalThis as any).navigator &&
    new Error().stack?.includes('runtime@')
  )
    return 'webkit';

  if ((globalThis as any).os && (globalThis as any).std) return 'quickjs';
  if ((globalThis as any).Bun) return 'bun';
  if ((globalThis as any).Deno) return 'deno';
  if ((globalThis as any).HermesInternal) return 'hermes';
  if ((globalThis as any).window && (globalThis as any).navigator) return 'browser';
  if ((globalThis as any).process) return 'node';
  else return null;
}

/** Detect the CPU architecture / platform (e.g. `arm64-darwin`). */
export async function arch(): Promise<string | null> {
  if (runtime() === 'webcontainer') return 'js + wasm';
  try {
    let n;
    if ((n = (globalThis as any).Deno?.build?.target)) return n;
  } catch {}
  try {
    const _os = 'node:os';
    const os = await import(_os);
    return `${os.arch()}-${os.platform()}`;
  } catch {}

  if ((globalThis as any).process?.arch && (globalThis as any).process?.platform) {
    return `${(globalThis as any).process.arch}-${(globalThis as any).process.platform}`;
  }

  if (runtime() === 'txiki.js') {
    return `${(globalThis as any).tjs.system?.arch}-${(globalThis as any).tjs.system?.platform}`;
  }

  if (runtime() === 'spidermonkey') {
    try {
      const build = (globalThis as any).getBuildConfiguration();
      const platforms = ['osx', 'linux', 'android', 'windows'];
      const archs = ['arm', 'x64', 'x86', 'wasi', 'arm64', 'mips32', 'mips64', 'loong64', 'riscv64'];

      const arch = archs.find((k) => build[k]);
      const platform = platforms.find((k) => build[k]);
      if (arch) return !platform ? arch : `${arch}-${platform}`;
    } catch {}

    try {
      if ((globalThis as any).isAvxPresent()) return 'x86_64';
    } catch {}
  }

  return null;
}
