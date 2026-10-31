import { mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { expect, it } from 'vitest';
import { startChromeServer } from '../src/chrome-server.ts';

it('serves local fixtures while rejecting filesystem paths and symlinks outside the asset roots', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'labs-assets-'));
  let server: Awaited<ReturnType<typeof startChromeServer>> | undefined;
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
      import image from './image space.svg'; bench('test', () => [image, fixtureUrl()]);`
    );
    writeFileSync(
      join(directory, 'project', 'image space.svg'),
      '<svg xmlns="http://www.w3.org/2000/svg"/>'
    );
    writeFileSync(join(directory, 'project', 'fixture.json'), '{"value":42}');
    writeFileSync(join(directory, 'outside', 'file.txt'), 'outside');
    symlinkSync(join(directory, 'outside'), join(directory, 'project', 'escape'), 'junction');
    server = await startChromeServer(pathToFileURL(file).href);
    const bundle = await (await fetch(`${server.url}/bench.js`)).text();
    const imageUrl = bundle.match(/"([^"\n]+\.svg)"/)![1];
    const image = await fetch(new URL(imageUrl, server.url));
    expect(image.status).toBe(200);
    expect(image.headers.get('Content-Type')).toBe('image/svg+xml');
    const response = await fetch(`${server.url}/fixture.json`);
    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toBe('application/json');
    expect(response.headers.get('Cross-Origin-Embedder-Policy')).toBe('require-corp');
    expect(await response.json()).toEqual({ value: 42 });
    const moduleUrl = `${server.url}/_labs/fs${pathToFileURL(realpathSync(join(dependency, 'dist', 'helper.js'))).pathname}`;
    expect(bundle).toContain(moduleUrl);
    const linked = await fetch(new URL('../assets/fixture.json', moduleUrl));
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
