import { execFileSync, spawn, spawnSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runWorkers } from '../src/cli/workers.ts';
import { checkoutRef, openSide, resolveRef } from '../src/cli/worktree.ts';
import { getBaseline } from '../src/store.ts';

const TSX = pathToFileURL(createRequire(import.meta.url).resolve('tsx')).href;
const WORKER = fileURLToPath(new URL('../src/worker.ts', import.meta.url));
const STUB = fileURLToPath(new URL('./fixtures/turns.worker.ts', import.meta.url));
const FIXTURE = fileURLToPath(new URL('./fixtures/blocks.bench.ts', import.meta.url));

describe('worker turn protocol', () => {
  it(
    'asks for a turn before every measurement when given a channel',
    { timeout: 60_000 },
    async () => {
      const resultFile = join(tmpdir(), `labs-turns-${process.pid}.json`);
      const child = spawn(process.execPath, ['--import', TSX, WORKER], {
        stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
        env: {
          ...process.env,
          LABS_BENCH_FILE: pathToFileURL(FIXTURE).href,
          LABS_RESULT_FILE: resultFile,
          LABS_BLOCK_TIME: '1',
          LABS_MIN_SAMPLES: '12',
          LABS_BLOCKS: '3',
        },
      });
      let turns = 0;
      child.on('message', (message) => {
        if (message !== 'turn') return;
        turns++;
        child.send('go');
      });
      const code = await new Promise<number | null>((resolve) => child.on('exit', resolve));

      try {
        expect(code).toBe(0);
        const result = JSON.parse(readFileSync(resultFile, 'utf-8'));
        expect(result.benchmarks).toHaveLength(2);
        for (const trial of result.benchmarks) {
          expect(trial.runs[0].stats.blocks.medians).toHaveLength(3);
        }
        // One turn to start, then one per block of each bench
        expect(turns).toBe(1 + 2 * 3);
      } finally {
        rmSync(resultFile, { force: true });
      }
    }
  );
});

describe('runWorkers', () => {
  const log = join(tmpdir(), `labs-turn-log-${process.pid}`);
  afterEach(() => rmSync(log, { force: true }));

  const stub = (env: Record<string, string>) => ({
    args: ['--import', TSX, STUB],
    env: { ...process.env, LOG: log, TURNS: '3', ...env },
  });

  it('alternates turns between concurrent workers', async () => {
    await runWorkers([stub({ ID: 'a' }), stub({ ID: 'b', DELAY: '200' })]);

    // Whichever worker asks first leads, the other always follows
    expect(readFileSync(log, 'utf-8')).toMatch(/^(ababab|bababa)$/);
  });

  it('rejects when a worker exits unsuccessfully', async () => {
    await expect(runWorkers([stub({ ID: 'a' }), stub({ ID: 'b', FAIL: '1' })])).rejects.toThrow(
      'code 3'
    );
    expect(readFileSync(log, 'utf-8')).toMatch(/^(ababab|bababa)$/);
  });

  it('finishes timing on both sides before granting a diagnostic replay', async () => {
    await runWorkers([
      stub({ ID: 'a', TURNS: '1', DIAGNOSTICS: '1' }),
      stub({ ID: 'b', DIAGNOSTICS: '1' }),
    ]);
    expect(readFileSync(log, 'utf-8')).toMatch(/^(abbb|babb)(AB|BA)$/);
  });

  it('finishes the surviving worker when its peer fails before requesting a turn', async () => {
    await expect(
      runWorkers([stub({ ID: 'a' }), stub({ ID: 'b', FAIL_BEFORE_TURN: '1' })])
    ).rejects.toThrow('code 3');
    expect(readFileSync(log, 'utf-8')).toBe('aaa');
  });
});

describe('checkoutRef', () => {
  let repo: string;
  const git = (...args: string[]) =>
    execFileSync('git', args, { cwd: repo, stdio: ['ignore', 'pipe', 'pipe'] })
      .toString()
      .trim();

  function setup() {
    repo = realpathSync(mkdtempSync(join(tmpdir(), 'labs-repo-')));
    git('init', '-q', '-b', 'main');
    git('config', 'user.email', 'labs@test');
    git('config', 'user.name', 'labs');
    mkdirSync(join(repo, 'node_modules', 'dep'), { recursive: true });
    mkdirSync(join(repo, 'benches'));
    writeFileSync(join(repo, '.gitignore'), 'node_modules\n');
    writeFileSync(join(repo, 'benches', 'a.bench.ts'), 'export const version = 1;\n');
    git('add', '.');
    git('commit', '-q', '-m', 'v1');
    writeFileSync(join(repo, 'benches', 'a.bench.ts'), 'export const version = 2;\n');
    git('commit', '-q', '-am', 'v2');
  }

  afterEach(() => rmSync(repo, { recursive: true, force: true }));

  it('checks out the revision with the working checkout dependencies', () => {
    setup();
    const checkout = checkoutRef(join(repo, 'benches'), 'HEAD~1', join(repo, 'benches'));

    try {
      expect(checkout.git).toEqual({
        commit: git('rev-parse', 'HEAD~1'),
        branch: null,
        dirty: false,
      });
      expect(readFileSync(join(checkout.dir, 'benches', 'a.bench.ts'), 'utf-8')).toContain(
        'version = 1'
      );
      expect(realpathSync(join(checkout.dir, 'node_modules', 'dep'))).toBe(
        join(repo, 'node_modules', 'dep')
      );
      expect(git('worktree', 'list').split('\n')).toHaveLength(2);
    } finally {
      checkout.dispose();
    }

    expect(existsSync(checkout.dir)).toBe(false);
    expect(git('worktree', 'list').split('\n')).toHaveLength(1);
  });

  it('uses an existing worktree as given and links only the dependencies it lacks', () => {
    setup();
    const tree = realpathSync(mkdtempSync(join(tmpdir(), 'labs-agent-')));
    git('worktree', 'add', '--quiet', '-b', 'agent', tree, 'HEAD~1');
    writeFileSync(join(tree, 'benches', 'a.bench.ts'), 'export const version = 3;\n');
    const checkout = openSide(join(repo, 'benches'), tree, join(repo, 'benches'));

    try {
      expect(checkout.dir).toBe(tree);
      expect(checkout.git).toEqual({
        commit: git('rev-parse', 'HEAD~1'),
        branch: 'agent',
        dirty: true,
      });
      expect(realpathSync(join(tree, 'node_modules', 'dep'))).toBe(join(repo, 'node_modules', 'dep'));
    } finally {
      checkout.dispose();
    }

    // The tree and its edits survive, only the link labs made is gone
    expect(readFileSync(join(tree, 'benches', 'a.bench.ts'), 'utf-8')).toContain('version = 3');
    expect(existsSync(join(tree, 'node_modules'))).toBe(false);
    expect(() => openSide(repo, tmpdir(), repo)).toThrow('is not a git checkout');
    rmSync(tree, { recursive: true, force: true });
  });

  it('names the branch a revision points at and rejects unknown revisions', () => {
    setup();
    expect(resolveRef(repo, 'main').branch).toBe('main');
    expect(resolveRef(repo, 'main').commit).toBe(git('rev-parse', 'HEAD'));
    expect(() => resolveRef(repo, 'nope')).toThrow('Unknown git revision "nope"');
  });
});

describe('comparing checkouts through the CLI', () => {
  let dir: string;
  let repo: string;
  let project: string;
  const git = (...args: string[]) =>
    execFileSync('git', args, { cwd: repo, stdio: ['ignore', 'pipe', 'pipe'] });
  const cli = (...args: string[]) =>
    spawnSync(
      process.execPath,
      ['--import', TSX, fileURLToPath(new URL('../src/cli/cli.ts', import.meta.url)), ...args],
      { cwd: project, encoding: 'utf8', timeout: 30_000 }
    );

  function installLabs(tree: string) {
    const pkg = join(tree, 'node_modules', '@pmndrs', 'labs');
    mkdirSync(pkg, { recursive: true });
    cpSync(fileURLToPath(new URL('../src', import.meta.url)), join(pkg, 'src'), { recursive: true });
    writeFileSync(
      join(pkg, 'package.json'),
      JSON.stringify({ name: '@pmndrs/labs', type: 'module', exports: './src/index.ts' })
    );
  }

  beforeEach(() => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), 'labs-cli-')));
    repo = join(dir, 'repo');
    project = join(repo, 'project');
    mkdirSync(join(project, 'benches'), { recursive: true });
    git('init', '-q', '-b', 'main');
    git('config', 'user.email', 'labs@test');
    git('config', 'user.name', 'labs');
    writeFileSync(join(repo, '.gitignore'), 'node_modules\n.labs\n');
    writeFileSync(join(repo, 'package.json'), JSON.stringify({ type: 'module' }));
    writeFileSync(
      join(project, 'labs.config.ts'),
      `import { defineConfig } from ${JSON.stringify(new URL('../src/config.ts', import.meta.url).href)};
       export default defineConfig({ benchDir: 'benches', blocks: 2, blockTime: 0.001, minSamples: 2, heap: false });`
    );
    writeFileSync(join(project, 'payload.txt'), 'reference');
    writeFileSync(
      join(project, 'benches', 'value.bench.ts'),
      `import { bench } from '@pmndrs/labs';
       import { readFileSync } from 'node:fs';
       bench(readFileSync('payload.txt', 'utf8'), () => Array.from({ length: 100 }, (_, i) => i).join(','));`
    );
    git('add', '.');
    git('commit', '-q', '-m', 'reference');
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it.each(['module', 'commonjs'])(
    'measures both %s checkouts with separate Labs installs and their own working directories',
    { timeout: 40_000 },
    (type) => {
      writeFileSync(join(repo, 'package.json'), JSON.stringify({ type }));
      git('add', '.');
      git('commit', '-q', '--allow-empty', '-m', 'module type');
      const reference = join(dir, 'reference');
      git('worktree', 'add', '--quiet', '--detach', reference, 'HEAD');
      installLabs(repo);
      installLabs(reference);
      writeFileSync(join(project, 'payload.txt'), 'candidate');

      const child = cli('--against', reference, '--no-save', '--json');
      expect(child.status, child.stderr).toBe(0);
      const result = JSON.parse(child.stdout);
      expect(result.crashes).toEqual([]);
      expect(result.benches.map((bench: { name: string }) => bench.name)).toEqual(['candidate']);
      expect(result.reference.benches.map((bench: { name: string }) => bench.name)).toEqual([
        'reference',
      ]);
    }
  );

  it.each([false, true])('fails when a worker crashes with JSON output %s', (json) => {
    writeFileSync(join(project, 'benches', 'value.bench.ts'), 'throw new Error("broken import");');
    const child = cli('--no-save', ...(json ? ['--json'] : []));
    expect(child.status, child.stderr).toBe(1);
    expect(child.stderr).toContain('broken import');
  });

  it('does not establish a baseline from a partially crashed run', { timeout: 40_000 }, () => {
    installLabs(repo);
    writeFileSync(join(project, 'benches', 'broken.bench.ts'), 'throw new Error("broken import");');
    const child = cli('-n', 'partial', '--json');
    expect(child.status, child.stderr).toBe(1);
    const result = JSON.parse(child.stdout);
    expect(result.benches).toHaveLength(1);
    expect(result.crashes).toHaveLength(1);
    expect(result.baseline).toBe(false);
    expect(getBaseline(join(project, '.labs'))).toBeUndefined();
  });
});
