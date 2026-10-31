import { createHash } from 'node:crypto';
import { readFile, realpath, stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { dirname, extname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { Loader } from 'esbuild';

function contentType(file: string): string {
  return (
    (
      {
        '.js': 'text/javascript',
        '.mjs': 'text/javascript',
        '.css': 'text/css',
        '.json': 'application/json',
        '.wasm': 'application/wasm',
        '.svg': 'image/svg+xml',
        '.png': 'image/png',
        '.jpg': 'image/jpeg',
        '.jpeg': 'image/jpeg',
        '.webp': 'image/webp',
        '.gif': 'image/gif',
        '.gltf': 'model/gltf+json',
        '.glb': 'model/gltf-binary',
        '.txt': 'text/plain',
        '.wgsl': 'text/plain',
        '.glsl': 'text/plain',
      } as Record<string, string>
    )[extname(file).toLowerCase()] ?? 'application/octet-stream'
  );
}

/** Serve bundled benchmarks and source-relative assets without a development client. */
export async function startChromeServer(file: string) {
  const [{ build }, { parse }] = await Promise.all([import('esbuild'), import('@babel/parser')]);
  const benchFile = await realpath(fileURLToPath(file));
  const roots = new Set([await realpath(process.cwd()), dirname(benchFile)]);
  const assets = new Map<string, Uint8Array>();
  const modules = new Map<string, Promise<string>>();
  const packageRoots = new Map<string, Promise<string | undefined>>();
  const packageRoot = (directory: string): Promise<string | undefined> => {
    let root = packageRoots.get(directory);
    if (!root) {
      root = (async () => {
        try {
          if ((await stat(resolve(directory, 'package.json'))).isFile()) return directory;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        }
        const parent = dirname(directory);
        return parent === directory ? undefined : packageRoot(parent);
      })();
      packageRoots.set(directory, root);
    }
    return root;
  };
  const outputDir = resolve(process.cwd(), 'node_modules/.cache/labs-browser');
  const ext = import.meta.url.endsWith('.ts') ? 'ts' : 'mjs';
  let url: string;

  const bundle = async (entry?: string): Promise<string> => {
    const name = entry
      ? `worker-${createHash('sha256').update(entry).digest('hex').slice(0, 16)}`
      : 'bench';
    const result = await build({
      ...(entry
        ? { entryPoints: [entry] }
        : {
            stdin: {
              contents: `
            import { browserHarness } from ${JSON.stringify(fileURLToPath(new URL(`./browser.${ext}`, import.meta.url)))};
            import ${JSON.stringify(benchFile)};
            globalThis.__labs = browserHarness;
          `,
              resolveDir: dirname(benchFile),
              sourcefile: 'labs-browser-entry.ts',
              loader: 'ts',
            },
          }),
      alias: { '@pmndrs/labs': fileURLToPath(new URL(`./browser.${ext}`, import.meta.url)) },
      bundle: true,
      platform: 'browser',
      format: 'esm',
      target: 'esnext',
      external: ['node:*', 'bun:jsc'],
      keepNames: true,
      write: false,
      logLevel: 'silent',
      outfile: resolve(outputDir, `${name}.js`),
      publicPath: '/_labs/build/',
      assetNames: 'assets/[name]-[hash]',
      loader: {
        '.wasm': 'file',
        '.bin': 'file',
        '.png': 'file',
        '.jpg': 'file',
        '.jpeg': 'file',
        '.webp': 'file',
        '.gif': 'file',
        '.svg': 'file',
      },
      plugins: [
        {
          name: 'labs-module-urls',
          setup(build) {
            build.onLoad({ filter: /\.[cm]?[jt]sx?$/ }, async ({ path }) => {
              const directory = dirname(await realpath(path));
              roots.add((await packageRoot(directory)) ?? directory);
              let contents = await readFile(path, 'utf8');
              if (contents.includes('import') && contents.includes('meta')) {
                const ast = parse(contents, {
                  sourceType: 'unambiguous',
                  allowReturnOutsideFunction: true,
                  plugins: [
                    'decorators-legacy',
                    'decoratorAutoAccessors',
                    ...(/\.[cm]?tsx?$/.test(path) ? ['typescript' as const] : []),
                    ...(/\.[jt]sx$/.test(path) ? ['jsx' as const] : []),
                  ],
                });
                const pending: any[] = [ast.program];
                const replacements: Array<{ start: number; end: number }> = [];
                while (pending.length) {
                  const node = pending.pop();
                  if (
                    (node.type === 'MemberExpression' || node.type === 'OptionalMemberExpression') &&
                    node.object?.type === 'MetaProperty' &&
                    node.object.meta.name === 'import' &&
                    node.object.property.name === 'meta' &&
                    (node.computed
                      ? node.property.type === 'StringLiteral' && node.property.value === 'url'
                      : node.property.type === 'Identifier' && node.property.name === 'url')
                  ) {
                    replacements.push({ start: node.start, end: node.end });
                  }
                  for (const child of Object.values(node) as any[]) {
                    if (Array.isArray(child)) pending.push(...child.filter((value) => value?.type));
                    else if (child?.type) pending.push(child);
                  }
                }
                const sourceUrl = `${url}/_labs/fs${pathToFileURL(path).pathname}`;
                for (const replacement of replacements.sort((a, b) => b.start - a.start)) {
                  contents =
                    contents.slice(0, replacement.start) +
                    JSON.stringify(sourceUrl) +
                    contents.slice(replacement.end);
                }
              }
              const extension = extname(path);
              const loader: Loader = extension.endsWith('x')
                ? (extension.slice(1) as 'jsx' | 'tsx')
                : /\.[cm]?ts$/.test(extension)
                  ? 'ts'
                  : 'js';
              return { contents, loader };
            });
          },
        },
      ],
    });
    for (const output of result.outputFiles) {
      assets.set(
        '/_labs/build/' + relative(outputDir, output.path).split(sep).join('/'),
        output.contents
      );
    }
    return result.outputFiles.find((output) => output.path === resolve(outputDir, `${name}.js`))!
      .text;
  };

  let main: string;
  const server = createServer((request, response) => {
    response.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    response.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
    void (async () => {
      const pathname = new URL(request.url!, url).pathname;
      const emitted = assets.get(decodeURIComponent(pathname));
      if (pathname === '/') {
        response.setHeader('Content-Type', 'text/html');
        response.end(
          '<!doctype html>' +
            (assets.has('/_labs/build/bench.css')
              ? '<link rel="stylesheet" href="/_labs/build/bench.css">'
              : '') +
            '<script type="module" src="/bench.js"></script>'
        );
        return;
      }
      if (pathname === '/bench.js' || emitted) {
        response.setHeader('Content-Type', contentType(pathname));
        response.end(pathname === '/bench.js' ? main : emitted);
        return;
      }
      if (pathname === '/favicon.ico') {
        response.writeHead(204).end();
        return;
      }
      const path = await realpath(
        pathname.startsWith('/_labs/fs/')
          ? fileURLToPath(new URL('file://' + pathname.slice('/_labs/fs'.length)))
          : resolve(dirname(benchFile), '.' + decodeURIComponent(pathname))
      );
      if (
        ![...roots].some((root) => {
          const suffix = relative(root, path);
          return suffix !== '..' && !suffix.startsWith('..' + sep) && !isAbsolute(suffix);
        })
      ) {
        response.writeHead(403).end();
        return;
      }
      if (!(await stat(path)).isFile()) {
        response.writeHead(404).end();
        return;
      }
      if (/\.[cm]?[jt]sx?$/.test(path)) {
        let code = modules.get(path);
        if (!code) modules.set(path, (code = bundle(path)));
        response.setHeader('Content-Type', 'text/javascript');
        response.end(await code);
      } else {
        response.setHeader('Content-Type', contentType(path));
        response.end(await readFile(path));
      }
    })().catch((error: NodeJS.ErrnoException) => {
      response
        .writeHead(error.code === 'ENOENT' || error.code === 'ENOTDIR' ? 404 : 500)
        .end(String(error.message));
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const close = () =>
    new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  try {
    main = await bundle();
    return { url, close };
  } catch (error) {
    await close();
    throw error;
  }
}
