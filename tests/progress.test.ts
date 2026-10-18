import { spawnSync } from 'node:child_process';
import { rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  applyEvent,
  createProgress,
  finishFile,
  type ProgressEvent,
  remainingTime,
  renderProgress,
  startFile,
} from '../src/cli/progress.ts';

const view = { columns: 80, rows: 30, now: 5_000, colors: false };

function running() {
  const progress = createProgress('main', ['entities.bench.ts', 'scene.bench.ts'], 0);
  startFile(progress, 0, 0);
  applyEvent(progress, 0, {
    type: 'start',
    blocks: 3,
    benches: [
      { index: 0, name: 'create entities', group: 'entities', cases: 1 },
      { index: 1, name: 'remove entities', group: 'entities', cases: 1 },
    ],
  });
  return progress;
}

describe('live progress', () => {
  it('shows each bench with completed blocks and its median so far', () => {
    const progress = running();
    applyEvent(progress, 0, { type: 'bench', index: 0, block: 0 });
    applyEvent(progress, 0, { type: 'block', index: 0, block: 0, duration: 500, median: 575 });
    applyEvent(progress, 0, { type: 'bench', index: 1, block: 0 });

    const text = renderProgress(progress, view).join('\n');
    expect(text).toMatch(/labs {2}v\d+\.\d+\.\d+ {2}main/);
    expect(text).toContain('block 1/3');
    expect(text).toMatch(/create entities\s+●○○\s+575\.00 ns/);
    expect(text).toMatch(/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] remove entities\s+○○○/);
    expect(text).toContain('· scene.bench.ts');
  });

  it('estimates the time left from pilot durations once every bench has run once', () => {
    const progress = running();
    applyEvent(progress, 0, { type: 'block', index: 0, block: 0, duration: 2_000, median: 1 });
    expect(remainingTime(progress.files[0])).toBeUndefined();

    applyEvent(progress, 0, { type: 'block', index: 1, block: 0, duration: 4_000, median: 1 });
    // Two blocks left for each bench
    expect(remainingTime(progress.files[0])).toBe(12_000);
    expect(renderProgress(progress, view).join('\n')).toContain('block 2/3  ~12.0s');
  });

  it('stops counting blocks for a bench whose pilot failed', () => {
    const progress = running();
    applyEvent(progress, 0, { type: 'block', index: 0, block: 0, duration: 1_000, error: 'boom' });
    applyEvent(progress, 0, { type: 'block', index: 1, block: 0, duration: 1_000, median: 1 });

    expect(remainingTime(progress.files[0])).toBe(2_000);
    const text = renderProgress(progress, view).join('\n');
    expect(text).toContain('✗ create entities');
    expect(text).toContain('boom');
  });

  it('collapses finished files into a summary and reports crashed workers', () => {
    const progress = running();
    finishFile(progress, 0, 4_200, {
      statuses: [
        { symbol: '✓', message: '' },
        { symbol: '⚠', message: 'noisy samples' },
      ],
    });
    startFile(progress, 1, 4_200);
    finishFile(progress, 1, 5_000, { error: 'Cannot find module ./missing.ts' });

    const text = renderProgress(progress, view).join('\n');
    expect(text).toMatch(/⚠ entities\.bench\.ts\s+2 benches {2}1 warning {2}4\.2s/);
    expect(text).not.toContain('create entities');
    expect(text).toMatch(/✗ scene\.bench\.ts\s+crashed/);
    expect(text).toContain('Cannot find module ./missing.ts');
  });

  it('keeps the running bench visible when the list is taller than the terminal', () => {
    const progress = createProgress('main', ['many.bench.ts'], 0);
    startFile(progress, 0, 0);
    applyEvent(progress, 0, {
      type: 'start',
      blocks: 2,
      benches: Array.from({ length: 40 }, (_, index) => ({
        index,
        name: `bench ${index}`,
        group: '',
        cases: 1,
      })),
    });
    applyEvent(progress, 0, { type: 'bench', index: 30, block: 0 });

    const lines = renderProgress(progress, { ...view, rows: 12 });
    expect(lines.length).toBeLessThanOrEqual(12);
    expect(lines.join('\n')).toContain('bench 30');
    expect(lines[0]).toContain('labs');
  });

  it(
    'receives progress events from a worker instead of a printed report',
    { timeout: 60_000 },
    () => {
      const resultFile = join(tmpdir(), `labs-progress-test-${process.pid}.json`);
      try {
        const worker = spawnSync(
          process.execPath,
          [
            '--import',
            pathToFileURL(createRequire(import.meta.url).resolve('tsx')).href,
            fileURLToPath(new URL('../src/worker.ts', import.meta.url)),
          ],
          {
            stdio: ['ignore', 'pipe', 'pipe', 'pipe'],
            encoding: 'utf8',
            env: {
              ...process.env,
              LABS_BENCH_FILE: pathToFileURL(
                fileURLToPath(new URL('./fixtures/isolation.bench.ts', import.meta.url))
              ).href,
              LABS_RESULT_FILE: resultFile,
              LABS_BLOCKS: '2',
              LABS_BLOCK_TIME: '1',
              LABS_MIN_SAMPLES: '12',
              LABS_PROGRESS: '1',
            },
          }
        );
        expect(worker.status).toBe(0);
        const events: ProgressEvent[] = String(worker.output[3])
          .trim()
          .split('\n')
          .map((line) => JSON.parse(line));

        expect(events[0]).toMatchObject({ type: 'start', blocks: 2 });
        expect(events[0].type === 'start' && events[0].benches.map((bench) => bench.group)).toEqual([
          'isolation',
          'isolation',
        ]);
        // Blocks run round robin, so each bench finishes its pilot before any replay
        const blocks = events.flatMap((event) =>
          event.type === 'block' ? [`${event.index}:${event.block}`] : []
        );
        expect(blocks).toEqual(['0:0', '1:0', '0:1', '1:1']);
        expect(worker.stdout).not.toContain('clk:');
      } finally {
        rmSync(resultFile, { force: true });
      }
    }
  );
});
