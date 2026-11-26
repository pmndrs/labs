import { mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { expect, it } from 'vitest';
import { startBrowserServer } from '../src/browser-server.ts';

it('serves benchmarks as stripped modules while rejecting paths and symlinks outside the asset roots', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'labs-assets-'));
  let server: Awaited<ReturnType<typeof startBrowserServer>> | undefined;
  try {
    mkdirSync(join(directory, 'project'));
    mkdirSync(join(directory, 'outside'));
    const dependency = join(directory, 'outside', 'dependency');
    mkdirSync(join(dependency, 'dist'), { recursive: true });
    mkdirSync(join(dependency, 'assets'));
    writeFileSync(
      join(dependency, 'package.json'),
      JSON.stringify({
        name: 'fixture-package',
        type: 'module',
        exports: './dist/helper.js',
      })
    );
    writeFileSync(
      join(dependency, 'dist', 'helper.js'),
      `export const fixtureUrl = () => new URL('../assets/fixture.json', import.meta.url);`
    );
    writeFileSync(join(dependency, 'assets', 'fixture.json'), '{"value":43}');
    mkdirSync(join(directory, 'project', 'node_modules'));
    symlinkSync(
      dependency,
      join(directory, 'project', 'node_modules', 'fixture-package'),
      'junction'
    );
    const file = join(directory, 'project', 'work.bench.ts');
    writeFileSync(
      file,
      `import { bench } from '@pmndrs/labs';
      import { fixtureUrl } from 'fixture-package';
      const scale: number = 2;
      bench('test', () => [scale, fixtureUrl()]);`
    );
    writeFileSync(join(directory, 'project', 'fixture.json'), '{"value":42}');
    writeFileSync(join(directory, 'outside', 'file.txt'), 'outside');
    symlinkSync(join(directory, 'outside'), join(directory, 'project', 'escape'), 'junction');
    server = await startBrowserServer(pathToFileURL(file).href);
    const entry = await (await fetch(`${server.url}/bench.js`)).text();
    const module = await fetch(new URL(entry.match(/"([^"]+work\.bench\.ts)"/)![1], server.url));
    expect(module.headers.get('Content-Type')).toBe('text/javascript');
    const code = await module.text();
    expect(code).toContain('const scale');
    expect(code).not.toContain(': number');
    expect(code).not.toContain("'@pmndrs/labs'");
    const fetched = await fetch(module.url, { headers: { 'sec-fetch-dest': 'empty' } });
    expect(await fetched.text()).toContain('const scale: number');
    const response = await fetch(`${server.url}/fixture.json`);
    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toBe('application/json');
    expect(response.headers.get('Cross-Origin-Embedder-Policy')).toBe('require-corp');
    expect(await response.json()).toEqual({ value: 42 });
    const moduleUrl = `/_labs/fs${pathToFileURL(realpathSync(join(dependency, 'dist', 'helper.js'))).pathname}`;
    expect(code).toContain(`from '${moduleUrl}'`);
    const linked = await fetch(new URL('../assets/fixture.json', server.url + moduleUrl));
    expect(linked.status).toBe(200);
    expect(await linked.json()).toEqual({ value: 43 });
    expect((await fetch(`${server.url}/escape/file.txt`)).status).toBe(403);
    expect(
      (
        await fetch(
          `${server.url}/_labs/fs${pathToFileURL(join(directory, 'outside', 'file.txt')).pathname}`
        )
      ).status
    ).toBe(403);
    expect((await fetch(`${server.url}/missing.json`)).status).toBe(404);
  } finally {
    await server?.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

it('ends the run only when a static import cannot be served', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'labs-graph-'));
  let server: Awaited<ReturnType<typeof startBrowserServer>> | undefined;
  try {
    const file = join(directory, 'work.bench.ts');
    writeFileSync(join(directory, 'package.json'), '{"type":"module"}');
    writeFileSync(join(directory, 'style.css'), 'body {}');
    writeFileSync(
      join(directory, 'wasm-worker.js'),
      'onmessage = (event) => postMessage(event.data.instance.exports.run());'
    );
    writeFileSync(
      file,
      `import { bench } from '@pmndrs/labs';
      import './style.css';
      const optional = await import('optional-package').catch(() => null);
      const generated = await import('./generated.js').catch(() => null);
      bench('test', () => [optional, generated]);`
    );
    server = await startBrowserServer(pathToFileURL(file).href);
    const local = (name: string) =>
      `${server!.url}/_labs/fs${pathToFileURL(realpathSync(directory)).pathname}/${name}`;
    const script = { headers: { 'sec-fetch-dest': 'script' } };
    expect((await fetch(local('work.bench.ts'), script)).status).toBe(200);
    expect((await fetch(local('wasm-worker.js'), script)).status).toBe(200);
    expect((await fetch(local('generated.js'), script)).status).toBe(404);
    expect(await Promise.race([server.failed, Promise.resolve('running')])).toBe('running');
    expect((await fetch(local('style.css'), script)).status).toBe(500);
    await expect(server.failed).rejects.toThrow(/work\.bench\.ts imports .*style\.css/);
  } finally {
    await server?.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
