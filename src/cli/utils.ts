import { RED, RESET } from '../utils/ansi.ts';

const DEFAULT_NAME_RE = /^\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}$/;

export function dateHint(r: { name: string; timestamp: string }): string | undefined {
  if (DEFAULT_NAME_RE.test(r.name)) return undefined;
  const d = new Date(r.timestamp);
  if (isNaN(d.getTime())) return undefined;
  const mon = d.toLocaleDateString('en-US', { month: 'short' });
  return `${mon} ${d.getDate()} ${d.getFullYear()}`;
}

export function error(msg: string): never {
  console.error(`${RED}✖${RESET} ${msg}`);
  process.exit(1);
}
