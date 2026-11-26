import { readFile, realpath, stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { dirname, extname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { init, parse } from 'es-module-lexer';
import { moduleResolve } from 'import-meta-resolve';
import { stripTypes } from './utils/strip-types.ts';

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

/**
 * Serve benchmarks to browsers as the ES modules they are. TypeScript is type
 * stripped as Node does and bare specifiers become URLs. Nothing is bundled.
 */
export async function startBrowserServer(file: string) {
  await init();
  const benchFile = await realpath(fileURLToPath(file));
  const harness = fileURLToPath(
    new URL(`./browser.${import.meta.url.endsWith('.ts') ? 'ts' : 'mjs'}`, import.meta.url)
  );
  const roots = new Set([await realpath(process.cwd()), dirname(benchFile)]);
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
  const linked = new Map<string, string>();
  // Assets beside any module in the graph stay reachable through import.meta.url.
  // A static import also records its importer because the page cannot run
  // without it, so a failure to serve it ends the run with both files named.
  const allow = async (path: string, importer?: string): Promise<string> => {
    if (importer) linked.set(path, importer);
    const real = await realpath(path);
    if (importer) linked.set(real, importer);
    roots.add((await packageRoot(dirname(real))) ?? dirname(real));
    return '/_labs/fs' + pathToFileURL(real).pathname.replaceAll("'", '%27');
  };

  const load = async (path: string): Promise<string> => {
    if (/\.[cm]?[jt]sx$/.test(path))
      throw new Error(`${path} contains JSX. Build it to JavaScript before running Labs.`);
    let code = await readFile(path, 'utf8');
    if (/\.[cm]?ts$/.test(path)) {
      try {
        code = stripTypes(code);
      } catch (error) {
        throw new Error(`${path}: ${(error as Error).message}`, { cause: error });
      }
    }
    const [imports, , , hasModuleSyntax] = parse(code, path);
    if (
      linked.has(path) &&
      !hasModuleSyntax &&
      /(?<![.\w$])(?:require\s*\(|module\.exports\b|exports\.\w)/.test(code)
    )
      throw new Error(
        `${path} is CommonJS. Browsers load ES modules only, so build it as an ES module before running Labs.`
      );
    let output = '';
    let end = 0;
    for (const entry of imports) {
      if (entry.type === 'import-meta' || !entry.specifier) continue;
      if (entry.type === 'dynamic' && entry.glob) continue;
      const { specifier } = entry;
      // Attributes mark JSON and CSS modules, which browsers load as they are.
      const importer = entry.type === 'dynamic' || entry.attributes ? undefined : path;
      // Relative imports and URLs resolve in the browser against the module URL.
      if (/^\.{0,2}\//.test(specifier)) {
        if (specifier.startsWith('.'))
          await allow(resolve(dirname(path), specifier.replace(/[?#].*$/, '')), importer).catch(
            () => {}
          );
        continue;
      }
      if (/^(?:https?|data|blob):/.test(specifier)) continue;
      let target: string;
      try {
        const resolved =
          specifier === '@pmndrs/labs'
            ? pathToFileURL(harness)
            : /^[a-z]+:/.test(specifier)
              ? new URL(specifier)
              : moduleResolve(
                  specifier,
                  pathToFileURL(path),
                  new Set(['browser', 'import', 'default'])
                );
        if (resolved.protocol !== 'file:')
          throw new Error(`${path} imports ${specifier}, which browsers cannot load.`);
        target = await allow(fileURLToPath(resolved), importer);
      } catch (error) {
        // A guarded dynamic import may never run in the browser.
        if (entry.type === 'dynamic') continue;
        throw error;
      }
      output +=
        code.slice(end, entry.start) + (entry.type === 'dynamic' ? JSON.stringify(target) : target);
      end = entry.end;
    }
    return output + code.slice(end);
  };

  const main = `import { browserHarness } from ${JSON.stringify(await allow(harness, '/bench.js'))};
import ${JSON.stringify(await allow(benchFile, '/bench.js'))};
globalThis.__labs = browserHarness;
`;
  let url: string;
  let fail: (error: Error) => void;
  // Rejects when a static import cannot be served, which the browser would
  // only report as a timeout.
  const failed = new Promise<never>((_, reject) => (fail = reject));
  failed.catch(() => {});

  const server = createServer((request, response) => {
    response.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    response.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
    const pathname = new URL(request.url!, url).pathname;
    let path = pathname;
    void (async () => {
      if (pathname === '/') {
        response.setHeader('Content-Type', 'text/html');
        response.end('<!doctype html><script type="module" src="/bench.js"></script>');
        return;
      }
      if (pathname === '/bench.js') {
        response.setHeader('Content-Type', 'text/javascript');
        response.end(main);
        return;
      }
      if (pathname === '/favicon.ico') {
        response.writeHead(204).end();
        return;
      }
      path = pathname.startsWith('/_labs/fs/')
        ? fileURLToPath(new URL('file://' + pathname.slice('/_labs/fs'.length)))
        : resolve(dirname(benchFile), '.' + decodeURIComponent(pathname));
      const importer = linked.get(path);
      path = await realpath(path);
      if (
        ![...roots].some((root) => {
          const suffix = relative(root, path);
          return suffix !== '..' && !suffix.startsWith('..' + sep) && !isAbsolute(suffix);
        })
      ) {
        response.writeHead(403).end();
        return;
      }
      if (!(await stat(path)).isFile())
        throw Object.assign(new Error(`${path} is not a file.`), { code: 'ENOENT' });
      // A script that fetches a file wants its bytes, even when the file is code.
      if (request.headers['sec-fetch-dest'] !== 'empty' && /\.[cm]?[jt]sx?$/.test(path)) {
        let code = modules.get(path);
        if (!code) modules.set(path, (code = load(path)));
        const body = await code;
        response.setHeader('Content-Type', 'text/javascript');
        response.end(body);
      } else {
        if (importer && request.headers['sec-fetch-dest'] !== 'empty')
          throw new Error(
            `${importer} imports ${path}, which is not JavaScript. Browsers cannot load it as a module, so build it before running Labs.`
          );
        response.setHeader('Content-Type', contentType(path));
        response.end(await readFile(path));
      }
    })().catch((error: NodeJS.ErrnoException) => {
      const missing = error.code === 'ENOENT' || error.code === 'ENOTDIR';
      const importer = linked.get(path);
      if (importer)
        fail(
          missing
            ? new Error(
                `Cannot find module ${path} imported from ${importer}. Browsers need the exact file name with its extension.`
              )
            : error
        );
      response.writeHead(missing ? 404 : 500).end(String(error.message));
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
  return { url, close, failed };
}
