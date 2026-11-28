// Node runs this before the benchmark's own preloads, which can also create functions.
if (process.env.LABS_INSPECT_SCRIPTS) {
  const { destination, nodeOptions } = JSON.parse(process.env.LABS_INSPECT_SCRIPTS);
  delete process.env.LABS_INSPECT_SCRIPTS;
  if (nodeOptions === undefined) delete process.env.NODE_OPTIONS;
  else process.env.NODE_OPTIONS = nodeOptions;
  const { writeFileSync } = require('node:fs');
  const { Session } = require('node:inspector');
  const session = new Session();
  const scripts = {};
  session.connect();
  session.on(
    'Debugger.scriptParsed',
    ({ params: { scriptId, url, hasSourceURL, stackTrace, hash } }) => {
      if (url && !hasSourceURL) return;
      const caller = stackTrace?.callFrames[0];
      if (caller)
        scripts[scriptId] = {
          caller: caller.scriptId,
          label: url || `<generated ${caller.functionName || 'script'}#${hash.slice(0, 8)}>`,
        };
    }
  );
  session.post('Debugger.enable');
  process.once('exit', () => {
    session.disconnect();
    writeFileSync(destination, JSON.stringify(scripts));
  });
}
