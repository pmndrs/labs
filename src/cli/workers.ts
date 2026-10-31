import { type ChildProcess, spawn } from 'node:child_process';
import type { ProgressEvent } from './progress.ts';

export interface WorkerSpec {
  /** Arguments for the node executable, ending with the worker script. */
  args: string[];
  env: NodeJS.ProcessEnv;
  cwd?: string;
  /** Names the worker in its failure message. */
  name?: string;
  /**
   * Captures output instead of inheriting the terminal. Progress events
   * arrive as JSON lines on fd 3 and bench output is passed through as lines.
   */
  live?: {
    onEvent: (event: ProgressEvent) => void;
    onOutput: (line: string) => void;
  };
}

/** Call `onLine` with each complete line from a stream. */
function readLines(stream: NodeJS.ReadableStream, onLine: (line: string) => void): void {
  let pending = '';
  stream.setEncoding('utf8');
  stream.on('data', (chunk: string) => {
    const lines = (pending + chunk).split('\n');
    pending = lines.pop()!;
    lines.forEach(onLine);
  });
  stream.on('end', () => pending && onLine(pending));
}

/**
 * Runs bench workers together under the turn protocol. Each worker is spawned
 * with an IPC channel, sends `turn` before every measurement, and holds the
 * CPU until its next request or exit. Turns go to the longest waiting worker,
 * so two workers alternate and their blocks interleave in time. A single
 * worker simply runs through. Rejects when any worker exits unsuccessfully.
 * Diagnostic turns wait until every worker has finished timing.
 */
export function runWorkers(specs: WorkerSpec[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const waiting: ChildProcess[] = [];
    const diagnosing = new Set<ChildProcess>();
    let holder: ChildProcess | null = null;
    let alive = specs.length;
    let failure: Error | undefined;

    const dispatch = () => {
      if (holder || waiting.length !== alive) return;
      const next = waiting.findIndex((child) => !diagnosing.has(child));
      holder = waiting.splice(next === -1 ? 0 : next, 1)[0];
      holder.send('go');
    };

    const release = (child: ChildProcess) => {
      if (holder === child) holder = null;
      const i = waiting.indexOf(child);
      if (i !== -1) waiting.splice(i, 1);
    };

    for (const spec of specs) {
      const child = spawn(process.execPath, spec.args, {
        cwd: spec.cwd,
        stdio: spec.live
          ? ['ignore', 'pipe', 'pipe', 'pipe', 'ipc']
          : ['inherit', 'inherit', 'inherit', 'ignore', 'ipc'],
        env: spec.live ? { ...spec.env, LABS_PROGRESS: '1' } : spec.env,
      });
      let lastError = '';
      if (spec.live) {
        const { onEvent, onOutput } = spec.live;
        readLines(child.stdio[3] as NodeJS.ReadableStream, (line) => {
          if (line) onEvent(JSON.parse(line));
        });
        readLines(child.stdout!, onOutput);
        readLines(child.stderr!, (line) => {
          if (line.trim()) lastError = line.trim();
          onOutput(line);
        });
      }
      child.on('message', (message) => {
        if (message !== 'turn' && message !== 'diagnostics') return;
        if (message === 'diagnostics') diagnosing.add(child);
        release(child);
        waiting.push(child);
        dispatch();
      });
      let finished = false;
      const finish = (err: Error | undefined) => {
        if (finished) return;
        finished = true;
        release(child);
        if (err && spec.name) err.message = `${spec.name}: ${err.message}`;
        failure ??= err;
        if (--alive === 0) {
          if (failure) reject(failure);
          else resolve();
          return;
        }
        dispatch();
      };
      child.on('error', (err) => {
        // A process that never started emits no exit
        if (child.pid === undefined) finish(err);
        else failure ??= err;
      });
      // Close rather than exit so captured output is complete
      child.on('close', (code, signal) => {
        finish(
          code === 0
            ? undefined
            : new Error(lastError || `bench worker exited with ${signal ?? `code ${code}`}`)
        );
      });
    }
  });
}
