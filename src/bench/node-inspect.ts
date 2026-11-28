import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { isAbsolute, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { DeoptWindow, Findings, InlinedCall, Inspection, OptimizationTier } from './types.ts';

interface Code {
  fn: number;
  sfi: number;
  order: number;
  tier?: OptimizationTier;
  sampled: boolean;
  size: number;
  spans: Array<[start: number, since: number, until: number]>;
  entry?: string;
  inlined: Array<{ fn: number; offset: number; parent: number }>;
}

/**
 * Give heap objects an identity that survives a full collection moving them.
 * Untimed traces can identify an object by any address only it has held.
 */
function identities() {
  const now = new Map<number, number>();
  const ever = new Map<number, number>();
  const owners = new Map<number, Array<[since: number, identity: number]>>();
  let count = 0;
  const hold = (address: number, identity: number, record?: number) => {
    now.set(address, identity);
    const previous = ever.get(address);
    if (record !== undefined && previous !== undefined && previous !== identity) {
      if (!owners.has(address)) owners.set(address, [[0, previous]]);
      owners.get(address)!.push([record, identity]);
    }
    ever.set(address, identity);
    return identity;
  };
  return {
    at(address: number, record?: number) {
      const history = owners.get(address);
      if (!history) return ever.get(address);
      return record === undefined ? undefined : history.findLast(([since]) => since <= record)?.[1];
    },
    of: (address: number, record?: number) => now.get(address) ?? hold(address, count++, record),
    renew: (address: number, record: number) => hold(address, count++, record),
    move(from: number, to: number, record?: number) {
      const identity = now.get(from);
      now.delete(from);
      if (identity !== undefined) hold(to, identity, record);
    },
  };
}

function gather<Key, Value>(lists: Map<Key, Value[]>, key: Key, value: Value) {
  const list = lists.get(key);
  if (list) list.push(value);
  else lists.set(key, [value]);
}

/** Count the entries of an ascending list that are not above the value. */
function upTo(ascending: number[], value: number): number {
  let low = 0;
  for (let high = ascending.length; low < high;) {
    const middle = (low + high) >> 1;
    if (ascending[middle] <= value) low = middle + 1;
    else high = middle;
  }
  return low;
}

/**
 * Read what V8 did with the workload a finished worker marked. The directory
 * holds the worker's code log and, in `traces.txt`, the output of its
 * optimizing compiler and bytecode printer. The log names every function,
 * each tier it was compiled for, the calls inlined into its optimized code,
 * and each bailout with its reason. The trace adds the calls the optimizer
 * looked at without inlining and the bytecode. Every position reads
 * `file:line:column` with the file relative to the working directory.
 */
export function readNodeInspection(
  directory: string,
  { id, targets }: DeoptWindow
): Inspection | undefined {
  // Other isolates of the worker write logs of their own.
  const log = readdirSync(directory)
    .filter((name) => name.endsWith('-code.log'))
    .map((name) => readFileSync(join(directory, name), 'utf8'))
    .find((text) => text.includes(`,labsDeoptStart${id} `));
  if (!log) return;
  const generated: Record<string, { caller: string; label: string }> = JSON.parse(
    readFileSync(join(directory, 'scripts.json'), 'utf8')
  );

  // V8 escapes the characters that would break its comma separated records.
  const text = (field = '') =>
    field.replace(/\\(?:x([0-9A-Fa-f]{2})|u([0-9A-Fa-f]{4})|(n)|\\)/g, (_, x, u, n) =>
      n ? '\n' : x || u ? String.fromCharCode(parseInt(x ?? u, 16)) : '\\'
    );
  const place = (file: string) => {
    const path = file.startsWith('file:') ? fileURLToPath(file) : file;
    return isAbsolute(path) ? relative(process.cwd(), path) : path;
  };
  const labsDirectory = new URL(import.meta.url.endsWith('.ts') ? '../' : './', import.meta.url).href;
  const isUserFile = (file: string) =>
    /^file:|^\/|^[A-Za-z]:/.test(file) && !file.startsWith(labsDirectory);
  const userScripts = new Map<string, string>();
  const functions = new Map<
    number,
    { name: string; file: string; position: string; script?: string }
  >();
  const scriptFile = (fn: number) => {
    const info = functions.get(fn);
    return info && (userScripts.get(info.script ?? '') ?? place(info.file));
  };
  const layouts = new Map<number, string>();
  const sfis = identities();
  const shapes = identities();
  const sources = new Map<string, string>();
  const live = new Map<string, Code>();
  const compiled: Code[] = [];
  const codes = new Map<number, Code[]>();
  const bailouts: Array<
    Inspection['deopts'][number] & { code: Code; inlining: number; before: number }
  > = [];
  const accesses: Array<{
    record: number;
    pc: number;
    position: string;
    state: string;
    shape: number;
    access: string;
    key: string;
  }> = [];
  const ticks: Array<{ record: number; frames: number[] }> = [];
  let engine = '';
  let phase: 'warmup' | 'sampling' | undefined = 'warmup';

  // Code is found by address, and an address only means that code between
  // the records that put it there and took it away.
  const retire = (address: string, record: number) => {
    const code = live.get(address);
    if (code) code.spans.at(-1)![2] = record;
    live.delete(address);
    return code;
  };
  for (const [record, line] of log.split('\n').entries()) {
    const fields = line.split(',');
    if (fields[0] === 'code-creation' && fields[1] === 'JS') {
      const [, , , , address, size, label, sfi, marker = ''] = fields;
      const [, name = '', file, position] =
        /^(?:(.*?) )?((?:[a-z]+:|\/|[A-Za-z]:[\\/]).*|):(\d+:\d+)$/.exec(text(label)) ?? [];
      retire(address, record);
      if (position === undefined) continue;
      if (name === `labsDeoptStart${id}`) phase = 'sampling';
      if (name === `labsDeoptFinish${id}`) phase = undefined;
      // V8 logs nothing when a function dies, so one that later takes its
      // address is told apart by where it is defined.
      let fn = sfis.of(Number(sfi), record);
      const previous = functions.get(fn);
      if (
        !previous ||
        previous.name !== name ||
        previous.file !== file ||
        previous.position !== position
      ) {
        if (previous) fn = sfis.renew(Number(sfi), record);
        functions.set(fn, { name, file, position });
      }
      // V8 leaves the marker off interpreted code that is barred from optimization.
      const tier = ({ '~': 'Ignition', '^': 'Sparkplug', '+': 'Maglev', '*': 'TurboFan' } as const)[
        marker[0] ?? '~'
      ];
      const code = {
        fn,
        sfi: Number(sfi),
        order: compiled.length,
        tier,
        sampled: phase !== undefined,
        size: Number(size),
        spans: [[Number(address), record, Infinity] as Code['spans'][number]],
        inlined: [],
      };
      live.set(address, code);
      compiled.push(code);
    } else if (fields[0] === 'code-source-info') {
      const code = live.get(fields[1]);
      if (!code) continue;
      code.entry = fields[2] + ',' + fields[3];
      const info = functions.get(code.fn)!;
      // Different generated scripts can have identical file and position fields.
      if (info.script !== undefined && info.script !== fields[2]) {
        code.fn = sfis.renew(code.sfi, record);
        functions.set(code.fn, { ...info, script: fields[2] });
      } else info.script = fields[2];
      const inlinees = [...(fields[7] ?? '').matchAll(/S(0x[0-9a-f]+)/g)].map((match) =>
        sfis.of(Number(match[1]), record)
      );
      for (const [, index, offset, parent] of (fields[6] ?? '').matchAll(/F(\d+)O(\d+)(?:I(\d+))?/g))
        code.inlined.push({
          fn: inlinees[Number(index)],
          offset: Number(offset),
          parent: parent === undefined ? -1 : Number(parent),
        });
    } else if (fields[0] === 'code-deopt') {
      const code = live.get(fields[3]);
      if (code?.tier && phase) {
        let frame = Number(fields[4]);
        bailouts.push({
          code,
          inlining: frame,
          before: compiled.length,
          phase,
          tier: code.tier,
          kind: fields[6],
          reason: text(fields[8]),
          // The innermost position comes first, followed by the calls it was inlined through.
          at: [...text(fields[7]).matchAll(/<([^>]*):(\d+:\d+)>/g)].flatMap(([, file, position]) => {
            const call = code.inlined[frame];
            frame = call?.parent ?? -1;
            const source = file === 'unknown' ? scriptFile(call?.fn ?? code.fn) : place(file);
            return source ? [`${source}:${position}`] : [];
          }),
        });
      }
    } else if (fields[0] === 'map-move') shapes.move(Number(fields[2]), Number(fields[3]));
    else if (fields[0] === 'map-details') layouts.set(shapes.of(Number(fields[2])), fields[3] ?? '');
    else if (fields[0] === 'sfi-move') sfis.move(Number(fields[1]), Number(fields[2]), record);
    else if (fields[0].endsWith('IC') && phase) {
      // An inline cache record names the access by its address in the code
      // that ran it and the shape by its address in the heap.
      accesses.push({
        record,
        pc: Number(fields[1]),
        position: `${fields[3]}:${fields[4]}`,
        state: fields[6],
        shape: shapes.of(Number(fields[7])),
        access: fields[0]
          .slice(0, -2)
          .replace(/(?!^)[A-Z]/g, ' $&')
          .toLowerCase(),
        key: text(fields[8]),
      });
    } else if (fields[0] === 'code-move') {
      const code = retire(fields[1], record);
      if (!code) continue;
      live.set(fields[2], code);
      code.spans.push([Number(fields[2]), record, Infinity]);
    } else if (fields[0] === 'code-delete') retire(fields[1], record);
    else if (fields[0] === 'tick') {
      if (phase === 'sampling')
        ticks.push({ record, frames: [fields[1], ...fields.slice(6)].map(Number) });
    } else if (fields[0] === 'script-source') {
      const [, script, path, body] = fields;
      const file = text(path);
      sources.set(script, text(body));
      // The log retains the creator's real filename even when its sourceURL changes its display name.
      const origin = generated[script];
      if (isUserFile(file)) userScripts.set(script, place(file));
      else if (file === '<unknown>' && origin && userScripts.has(origin.caller))
        userScripts.set(script, origin.label);
    } else if (fields[0] === 'v8-version') engine = 'V8 ' + fields.slice(1, 5).join('.');
  }

  const workload = compiled.find((code) => code.entry === targets[0])?.fn;
  if (workload === undefined) return;
  for (const code of compiled) gather(codes, code.fn, code);
  const named = (fn: number) => {
    const info = functions.get(fn);
    return { name: info?.name ?? '', source: info ? `${scriptFile(fn)}:${info.position}` : '' };
  };
  // The offset where each line of a script starts, found once for each script.
  const lines = new Map<string, number[]>();
  const position = (fn: number, offset: number) => {
    const { script = '' } = functions.get(fn) ?? {};
    const source = sources.get(script);
    if (source === undefined) return '';
    if (!lines.has(script))
      lines.set(script, [0, ...[...source.matchAll(/\n/g)].map((match) => match.index + 1)]);
    const starts = lines.get(script)!;
    const line = upTo(starts, offset);
    return `${scriptFile(fn)}:${line}:${offset - starts[line - 1] + 1}`;
  };
  // Labs and Node internals are part of the harness, not the bench.
  const user = (fn: number) => {
    const info = functions.get(fn);
    return (
      info &&
      (info.script && sources.has(info.script) ? userScripts.has(info.script) : isUserFile(info.file))
    );
  };

  // The trace prints tagged pointers, one above the addresses in the log.
  const traced = (pointer: string, record?: number) => sfis.at(Number(pointer) - 1, record);
  const traces = readFileSync(join(directory, 'traces.txt'), 'utf8');
  // A reused function address needs the bytecode address as well. If both
  // addresses were reused, the printer and the code log record builds in order.
  const reusedBytecode = new Map<string, number[]>();
  const reusedCompiles = new Map<number, number[]>();
  for (const code of compiled.toReversed()) {
    if (sfis.at(code.sfi) !== undefined) continue;
    if (code.tier === 'Ignition') gather(reusedBytecode, `${code.sfi}:${code.spans[0][0]}`, code.fn);
    if (code.tier === 'TurboFan') gather(reusedCompiles, code.sfi, code.fn);
  }
  // The trace holds the bytecode of every function, printed when it was compiled.
  const listings = new Map<number, string>();
  for (const [, pointer, listing] of traces.matchAll(
    /^\[generated bytecode for function: [^\n]*\((0x[0-9a-f]+) <SharedFunctionInfo[^\n]*\n([^]*?)^(?:Handler Table|\[)/gm
  )) {
    let fn = traced(pointer);
    if (fn === undefined && reusedBytecode.size) {
      const entry = /(0x[0-9a-f]+) @\s+0 :/.exec(listing)?.[1];
      if (entry) fn = reusedBytecode.get(`${Number(pointer) - 1}:${Number(entry)}`)?.pop();
    }
    if (fn !== undefined) listings.set(fn, listing);
  }
  const bytes = (fn: number) => {
    const length = /^Bytecode length: (\d+)/.exec(listings.get(fn) ?? '')?.[1];
    return length === undefined ? null : Number(length);
  };
  // The trace of each optimizing compile lists every call it looked at, in
  // the order the log records the code those compiles produced.
  const compiles = new Map<number, string[]>();
  for (const [, pointer, trace] of traces.matchAll(
    /^\[compiling method \S+ <JSFunction [^>]*\(sfi = (0x[0-9a-f]+)\)> \(target TURBOFAN_JS\)[^\n]*\n([^]*?)^\[completed compiling/gm
  )) {
    const fn = traced(pointer) ?? reusedCompiles.get(Number(pointer) - 1)?.pop();
    if (fn !== undefined) gather(compiles, fn, trace);
  }

  // A log of a large project asks which code held an address many thousands
  // of times, so the spans are sorted by address once. An address is reused
  // over time, and the search walks back only while an earlier span reaches it.
  const spans = compiled
    .flatMap((code) => code.spans.map(([start, since, until]) => ({ start, since, until, code })))
    .sort((a, b) => a.start - b.start);
  const starts = spans.map((span) => span.start);
  const reach: number[] = [];
  for (const { start, code } of spans) reach.push(Math.max(reach.at(-1) ?? 0, start + code.size));
  const running = (pc: number, record: number) => {
    let index = upTo(starts, pc);
    while (--index >= 0 && reach[index] > pc) {
      const { start, since, until, code } = spans[index];
      if (since <= record && record < until && pc < start + code.size) return code;
    }
  };

  // A profiler tick holds the address that was running and the frames that
  // called it. It counts for the nearest function of yours on that stack, so
  // time in the engine's own routines goes to the function that called them
  // and calls inlined into a function count toward that function.
  const sampled = new Map<number, number>();
  for (const { record, frames } of ticks)
    for (const pc of frames) {
      const code = running(pc, record);
      if (!code || !(user(code.fn) || code.entry === targets[1])) continue;
      sampled.set(code.fn, (sampled.get(code.fn) ?? 0) + 1);
      break;
    }

  // Only unoptimized code reports the position of an access. Optimized code
  // reports the start of its function, so its records cannot be placed.
  const read = new Map<number, typeof accesses>();
  for (const access of accesses) {
    const code = running(access.pc, access.record);
    if (code?.tier === 'Ignition' || code?.tier === 'Sparkplug') gather(read, code.fn, access);
  }

  // An object shape reads as its constructor and the properties it holds, in order.
  const layout = (shape: number) => {
    const details = text(layouts.get(shape));
    const constructor = / - constructor: \S+ <JSFunction (\S+) /.exec(details)?.[1];
    const properties = [...details.matchAll(/^\s+\[\d+\]: [^#\n]*#(\S+) \(/gm)].map(
      (match) => match[1]
    );
    return details
      ? `${constructor && constructor !== 'Object' ? constructor + ' ' : ''}{ ${properties.join(', ')} }`
      : '';
  };

  // What the engine did with one function. Its host is the optimized code it
  // ran in, and a bailout counts when it happened in code the function covers.
  const findings = (
    fn: number,
    host: Code | undefined,
    covers: (code: Code, inlining: number) => boolean
  ): Omit<Findings, 'time'> & { followed: Set<number>; refused: number[] } => {
    const root = host && host.fn !== fn ? host.inlined.findIndex((call) => call.fn === fn) : -1;
    const under = (index: number): boolean =>
      root < 0 ||
      (index >= 0 && (host!.inlined[index].parent === root || under(host!.inlined[index].parent)));
    const calls = (parent: number): InlinedCall[] =>
      (host?.inlined ?? []).flatMap((call, index) =>
        call.parent === parent
          ? [
              {
                ...named(call.fn),
                at: position(parent < 0 ? host!.fn : host!.inlined[parent].fn, call.offset),
                bytecodeBytes: bytes(call.fn),
                calls: calls(index),
              },
            ]
          : []
      );
    // Inline caches belong to a function whichever code it was inlined into,
    // so the function and every function inlined under it are looked at.
    const followed = new Set([
      fn,
      ...(host?.inlined.flatMap((call, index) => (under(index) ? [call.fn] : [])) ?? []),
    ]);

    const refused = new Map<number, string>();
    const compile =
      host?.tier === 'TurboFan' &&
      compiles.get(host.fn)?.[
        codes
          .get(host.fn)!
          .filter((code) => code.tier === 'TurboFan')
          .indexOf(host)
      ];
    if (compile) {
      const reasons = new Map<number | undefined, string>();
      for (const [, pointer] of compile.matchAll(
        /- target: \S+ \{(0x[0-9a-f]+) <SharedFunctionInfo[^>]*>\}/g
      ))
        reasons.set(traced(pointer, host!.spans[0][1]), 'considered but not inlined');
      // V8 13 prints the code of its reason and later versions print the words.
      for (const [, pointer, reason] of compile.matchAll(
        /^Cannot consider \S+ \{(0x[0-9a-f]+) <SharedFunctionInfo[^>]*>\} for inlining \(reason: ([^)]*)\)/gm
      ))
        reasons.set(
          traced(pointer, host!.spans[0][1]),
          (engine.startsWith('V8 13.') &&
            { 5: 'exceeds bytecode limit', 7: 'has optimization disabled' }[reason]) ||
            (/^\d+$/.test(reason) ? `V8 reason ${reason}` : reason)
        );
      for (const [callee, reason] of reasons)
        if (callee !== undefined && callee !== host!.fn && user(callee))
          if (!host!.inlined.some((call) => call.fn === callee)) refused.set(callee, reason);
    }

    const sites = new Map<
      string,
      { state: string; access: string; key: string; at: string; shapes: Set<number> }
    >();
    for (const { owner, position: place_, state, shape, access, key } of [...followed]
      .flatMap((owner) => (read.get(owner) ?? []).map((seen) => ({ owner, ...seen })))
      .sort((a, b) => a.record - b.record)) {
      const id = `${owner}:${place_} ${access} ${key}`;
      const site = sites.get(id) ?? {
        state: '',
        access,
        key,
        at: `${scriptFile(owner)}:${place_}`,
        shapes: new Set(),
      };
      sites.set(id, site);
      // V8 marks a polymorphic access P and a megamorphic one N.
      if (state === 'N' || (state === 'P' && !site.state))
        site.state = state === 'N' ? 'megamorphic' : 'polymorphic';
      site.shapes.add(shape);
    }

    // The path through the tiers lists a compile only when it raises the tier
    // the function runs at. Baseline code is compiled in batches on another
    // thread and often arrives after optimized code, where it changes nothing.
    const deopts = bailouts.filter(({ code, inlining }) => covers(code, inlining));
    const tiers: Findings['tiers'] = [];
    let reached = -1;
    let next = 0;
    // Bailouts that happened before the given compile show as one step back.
    const bail = (order: number) => {
      const from = next;
      while (next < deopts.length && deopts[next].before <= order) next++;
      if (next === from || tiers.at(-1) === 'deopt') return;
      tiers.push('deopt');
      reached = 0;
    };
    for (const code of codes.get(fn) ?? []) {
      bail(code.order);
      const rank = ['Ignition', 'Sparkplug', 'Maglev', 'TurboFan'].indexOf(code.tier ?? '');
      if (!code.sampled || rank <= reached) continue;
      tiers.push(code.tier!);
      reached = rank;
    }
    bail(Infinity);

    return {
      followed,
      refused: [...refused.keys()],
      tiers,
      inlined: host ? calls(root) : [],
      rejected: [...refused].map(([callee, reason]) => ({
        ...named(callee),
        bytecodeBytes: bytes(callee),
        reason,
      })),
      polymorphic: [...sites.values()].flatMap(({ state, shapes: seen, ...site }) =>
        state === 'polymorphic' || state === 'megamorphic'
          ? [
              {
                state,
                ...site,
                shapes: seen.size,
                layouts: [...new Set([...seen].map(layout).filter(Boolean))],
              },
            ]
          : []
      ),
      deopts: deopts.map(({ code: _, inlining: __, before: ___, ...deopt }) => deopt),
    };
  };

  // A batched workload runs as part of the sampling loop once the optimizer
  // has inlined it there. Otherwise its own optimized code is what was timed.
  const last = (fn: number | undefined, tier: OptimizationTier) =>
    codes.get(fn!)?.findLast((code) => code.tier === tier && code.sampled);
  const loop = compiled.find((code) => targets[1] && code.entry === targets[1])?.fn;
  const host = [last(loop, 'TurboFan'), last(workload, 'TurboFan')].find(
    (code) => code && (code.fn === workload || code.inlined.some((call) => call.fn === workload))
  );
  const within = (code: Code, index: number): boolean =>
    code.fn === workload ||
    (index >= 0 && (code.inlined[index].fn === workload || within(code, code.inlined[index].parent)));
  const bench = findings(workload, host, within);

  // Every other function of yours that the profiler saw running while the
  // workload was sampled gets the same findings.
  const reached = [...sampled.keys()].filter((fn) => user(fn) && fn !== loop && fn !== workload);
  const others = reached.map((fn) => ({
    fn,
    ...findings(fn, last(fn, 'TurboFan') ?? last(fn, 'Maglev'), (code) => code.fn === fn),
  }));
  // Time in the sampling loop is the workload's when the workload runs inside it.
  const share = (fn: number) =>
    ticks.length
      ? Math.round(
          (((sampled.get(fn) ?? 0) +
            (fn === workload && host?.fn === loop ? (sampled.get(loop!) ?? 0) : 0)) /
            ticks.length) *
            1000
        ) / 1000
      : null;

  // The printed bytecode carries addresses and raw bytes that change every run.
  const listed = (fn: number) =>
    listings
      .get(fn)!
      .split('\n')
      .flatMap((row) => {
        const [, offset, kind, index, operation] =
          /^\s*(?:(\d+) ([SE])>)?\s*0x[0-9a-f]+ @\s+(\d+) : (?:[0-9a-f]{2} )+\s*(.*)$/.exec(row) ??
          [];
        if (index !== undefined) {
          const source = position(fn, Number(offset)).replace(/^.*?(?=\d+:\d+$)/, '');
          return [
            `${(offset ? `${source} ${kind}>` : '').padStart(12)} ${index.padStart(5)} : ${operation.replaceAll(/0x[0-9a-f]+ /g, '')}`,
          ];
        }
        const constant = /^\s+(\d+): 0x[0-9a-f]+ (.*)$/.exec(row);
        if (constant)
          return [
            `${''.padStart(12)} ${constant[1].padStart(5)} : ${constant[2].replaceAll(/0x[0-9a-f]+ /g, '')}`,
          ];
        return /^(?:Bytecode length|Parameter count|Register count|Frame size|Constant pool)/.test(
          row
        )
          ? [row]
          : [];
      });

  // A size makes sense next to the limit it is held to. The engine lists its
  // defaults, and a flag of the worker's own comes before them.
  const options =
    process.execArgv.join(' ') +
    execFileSync(process.execPath, ['--v8-options'], { encoding: 'utf8' });
  const limit = (flag: string) => Number(new RegExp(`--${flag}=(\\d+)`).exec(options)?.[1]) || null;

  const { followed, refused: _, ...workloadFindings } = bench;
  return {
    engine,
    workload: named(workload),
    optimized: !host ? null : host.fn === workload ? 'alone' : 'in-sampling-loop',
    limits: {
      inlineBytes: limit('max-inlined-bytecode-size'),
      inlineTotalBytes: limit('max-inlined-bytecode-size-cumulative'),
    },
    time: share(workload),
    ...workloadFindings,
    called: others
      .map(({ fn, followed: __, refused: ___, ...found }) => ({
        ...named(fn),
        bytecodeBytes: bytes(fn),
        time: share(fn),
        ...found,
      }))
      .sort((a, b) => (b.time ?? 0) - (a.time ?? 0)),
    // The workload comes first, then everything named in the findings.
    bytecode: [
      ...new Set([
        ...followed,
        ...bench.refused,
        ...others.flatMap((other) => [...other.followed, ...other.refused]),
      ]),
    ].flatMap((fn) =>
      listings.has(fn) && !functions.get(fn)?.file.startsWith('node:')
        ? [{ ...named(fn), listing: listed(fn) }]
        : []
    ),
  };
}
