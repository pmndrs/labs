import type { GitInfo } from '../store.ts';
import { BG_BLUE, BG_MAGENTA, RED, RESET, WHITE } from '../utils/ansi.ts';

/** The clock a bench is timed on, as a badge between its status and its name. */
export function clockBadge(gpu: boolean): { text: string; style: string } {
  return { text: gpu ? ' gpu ' : ' cpu ', style: (gpu ? BG_MAGENTA : BG_BLUE) + WHITE };
}

const DEFAULT_NAME_RE = /^\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}$/;

export function runtimeLabel(runtime: string | null): string {
  if (runtime === 'node') return 'Node.js';
  if (runtime === 'chrome') return 'Chrome';
  if (runtime === 'bun') return 'Bun';
  if (runtime === 'firefox') return 'Firefox';
  if (runtime === 'webkit') return 'WebKit';
  return runtime ?? 'unknown';
}

export function dateHint(r: { name: string; timestamp: string }): string | undefined {
  if (DEFAULT_NAME_RE.test(r.name)) return undefined;
  const d = new Date(r.timestamp);
  if (isNaN(d.getTime())) return undefined;
  const mon = d.toLocaleDateString('en-US', { month: 'short' });
  return `${mon} ${d.getDate()} ${d.getFullYear()}`;
}

/** Compact git label: `main@abc1234`, with `*` marking a dirty working tree. */
export function gitHint(git: GitInfo): string {
  const sha = git.commit.slice(0, 7);
  const dirty = git.dirty ? '*' : '';
  return git.branch ? `${git.branch}@${sha}${dirty}` : `${sha}${dirty}`;
}

/**
 * Tags declared in bench source, matched as whole tokens so `@vec` does not
 * select a file that only declares `@vec3`. Mirrors the worker's exact-token
 * tag filter.
 */
export function fileHasAnyTag(content: string, tags: string[]): boolean {
  if (tags.length === 0) return true;
  const declared = new Set(content.match(/@[^\s'"`]+/g) ?? []);
  return tags.some((tag) => declared.has(tag));
}

export function error(msg: string): never {
  console.error(`${RED}✖${RESET} ${msg}`);
  process.exit(1);
}
