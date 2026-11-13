import type {
  GeneratorBench,
  MeasureOptions,
  OptimizationSample,
  OptimizationTier,
  Snapshot,
  Stats,
} from '../types.ts';
import {
  AsyncFunction,
  do_not_optimize,
  dollar_vm,
  kind,
  never_optimize,
  now as runtimeNow,
} from './runtime.ts';
import { toSnapshot } from './snapshot.ts';
import { batchSize, defaults } from './constants.ts';
import { createWarmup, isWarmupDone, isWarmupUnsettled, recordWarmup } from './warmup.ts';
import { memoryPass } from './memory.ts';
import { computePass, freshShader, gpuDevice, meterAllocations, renderPass } from './gpu.ts';
import { GcObservation, GcScope } from './gc.ts';
import { optimization, optimizationClock } from './optimization.ts';

/** Range and median of the per-sample values, sorted in place. */
function summarize(values: Float64Array): { min: number; max: number; p50: number } {
  values.sort();
  return {
    min: values[0],
    max: values[values.length - 1],
    p50: values[(0.5 * (values.length - 1)) | 0],
  };
}

/**
 * Sample storage for one block. A typed array keeps timings off the JS heap,
 * so it neither allocates while sampling nor adds to the GC work being
 * observed. Sampling stops at capacity instead of growing.
 */
function createSamples(maxSamples: number): Float64Array {
  return new Float64Array(Math.max(0, Math.ceil(maxSamples)));
}

/**
 * Sorts the first `count` samples in place and derives the headline stats.
 * The saved samples are copied out as a plain array once, at the boundary.
 */
function summarizeSamples(samples: Float64Array, count: number) {
  const sorted = samples.subarray(0, count).sort();
  let sum = 0;
  for (let i = 0; i < count; i++) sum += sorted[i];
  return {
    samples: Array.from(sorted),
    min: sorted[0],
    max: sorted[count - 1],
    p25: sorted[(0.25 * (count - 1)) | 0],
    p50: sorted[(0.5 * (count - 1)) | 0],
    p75: sorted[(0.75 * (count - 1)) | 0],
    p99: sorted[(0.99 * (count - 1)) | 0],
    p999: sorted[(0.999 * (count - 1)) | 0],
    avg: sum / count,
  };
}

/**
 * Measure the performance of `f`. A generator goes through
 * {@link benchGenerator}, which unwraps the function it yields for
 * {@link benchFn}.
 */
export function measure(gen: GeneratorBench, opts?: MeasureOptions): Promise<Stats>;
export function measure(f: (...args: any[]) => any, opts?: MeasureOptions): Promise<Stats>;
export async function measure(f: (...args: any[]) => any, opts: MeasureOptions = {}): Promise<Stats> {
  const k = kind(f);
  if (!k) throw new TypeError('expected generator or one-shot function');
  return k === 'yield' ? benchGenerator(f, opts) : benchFn(f, opts);
}

/**
 * Benchmark adapter for generator functions.
 *
 * The generator yields a benchmarkable function or options object. After
 * measurement it receives the first untimed result. The snapshot comes from
 * the yielded object's `snapshot` hook or the generator's return value.
 */
export async function benchGenerator(gen: (...args: any[]) => any, opts: any = {}): Promise<Stats> {
  const device = opts.$gpu ? await gpuDevice() : undefined;
  // Setup builds what the pass holds, the pass itself may grow it
  const meter = device ? meterAllocations(device) : undefined;
  const ctx: Record<string, unknown> = {
    get(name: string) {
      return opts.args?.[name];
    },
    fresh: freshShader,
  };
  // Any bench may use the GPU from the CPU clock, so the device is a promise
  // here, created only when asked for. A GPU bench has it ready.
  if (device) ctx.device = device;
  else Object.defineProperty(ctx, 'gpu', { get: gpuDevice, enumerable: true });

  try {
    const g = gen(ctx);
    const n = await g.next();

    // A GPU bench yields a pass to fill, or its own GPU time
    let gpuTimed = false;
    // What setup built. The timing wrapper then adds readback buffers of its own.
    const resident = meter?.bytes() ?? 0;
    let harness = 0;
    if (device && n.value && 'object' === typeof n.value) {
      if (n.value.compute) n.value = { ...n.value, time: computePass(device, n.value.compute) };
      else if (n.value.render) {
        n.value = { ...n.value, time: renderPass(device, n.value.render, n.value.draw) };
      } else if (n.value.time) {
        const time = n.value.time;
        const counted = Object.assign(() => (counted.calls++, time()), { calls: 0 });
        n.value = { ...n.value, time: counted };
      }
      gpuTimed = !!n.value.time;
    }
    if (device && !gpuTimed) {
      throw new TypeError('expected a GPU bench to yield { compute }, { render, draw } or { time }');
    }
    {
      if (gpuTimed) {
        harness = meter!.bytes() - resident;
        // The CPU heap is idle while the GPU runs, so GC observation has no subject
        opts.sample_gc = false;
        // The GPU clock climbs over tens of milliseconds of continuous load, and
        // passes agree long before that at whatever level it started from
        opts.warmup_settle = Math.max(opts.warmup_settle ?? 0, 5e7);
        opts.warmup_time = Math.max(opts.warmup_time ?? 0, 2e8);
      }
    }

    let $fn = n.value;
    if (!n.value?.heap && null != n.value?.heap) opts.heap = false;
    opts.concurrency ??= n.value?.concurrency ?? opts.args?.concurrency;
    if (!n.value?.counters && null != n.value?.counters) opts.$counters = false;
    if (n.value?.after) opts.after = n.value.after;

    const hook = n.value?.snapshot;
    if (hook !== undefined && 'function' !== typeof hook)
      throw new TypeError('expected snapshot to be a function');

    let first: unknown;
    let snapshot: Snapshot | undefined;
    opts.$first = async (value: unknown) => {
      first = value;
      if (!hook) return;
      const output = await hook();
      if (output === undefined) throw new TypeError('expected a value to snapshot, got undefined');
      snapshot = toSnapshot(output);
    };

    if (n.done || 'fn' !== kind($fn)) {
      // Manual benches time themselves and return durations. `time` is the
      // documented name, `manual` with a budget the earlier one.
      const manual = n.value?.time || n.value?.manual;
      $fn = n.value?.bench || manual;
      if ('fn' !== kind($fn, true))
        throw new TypeError('expected benchmarkable yield from generator');

      opts.params ??= {};
      const params: number = $fn.length;
      opts.manual = !manual ? false : 'manual' !== n.value.budget ? 'real' : 'manual';

      for (let o = 0; o < params; o++) {
        opts.params[o] = n.value[o];
        if ('fn' !== kind(n.value[o]))
          throw new TypeError('expected function for benchmark parameter');
      }
    }

    const stats = await benchFn($fn, opts);
    // Tier records describe the JavaScript that submitted the passes, not the
    // shader the GPU ran, so GPU time carries none
    if (gpuTimed) delete stats.optimization;
    const allocated = meter?.stop() ?? 0;
    // Every encode allocates, including the ones left in flight when sampling
    // stopped, and those finish before anything else uses the device
    const vram = gpuTimed
      ? {
          resident,
          perPass:
            (allocated - resident - harness) /
            Math.max(1, n.value.time.encodes ?? n.value.time.calls),
        }
      : undefined;
    if (gpuTimed) await n.value.time.finish?.();
    const end = await g.next(first);
    if (!end.done) throw new TypeError('expected generator to yield once');

    if (end.value !== undefined) {
      if (snapshot !== undefined)
        throw new TypeError('expected one snapshot source, not both a hook and a generator return');
      snapshot = toSnapshot(end.value);
    }

    return {
      ...stats,
      kind: gpuTimed ? ('gpu' as const) : ('yield' as const),
      ...(vram !== undefined ? { vram } : {}),
      ...(snapshot !== undefined ? { snapshot } : {}),
    };
  } finally {
    // A throw anywhere above must not leave the device patched for the next case
    meter?.stop();
  }
}

/**
 * Core benchmark engine for zero-arg and parameterised functions.
 *
 * Warms the workload, then generates an {@link AsyncFunction} loop that handles
 * batching, parameter injection, and hardware counters. Sampling stops once
 * both `min_samples` and `min_cpu_time` are met. Memory diagnostics follow
 * in a separate pass. The generated source is attached as `debug` on the
 * returned stats.
 */
export async function benchFn(fn: (...args: any[]) => any, opts: any = {}): Promise<Stats> {
  defaults(opts);
  const now: () => number = opts.now;
  const consume = opts.$consume ?? do_not_optimize;
  const started = now();
  let warmup = createWarmup(
    started + opts.warmup_time,
    opts.warmup_samples,
    started + opts.warmup_settle
  );
  let async = false;
  let batch = false;
  let single = 0;
  const params: string[] = Object.keys(opts.params);
  let workload: OptimizationSample | null = null;
  const compiler = optimization?.turboFan;
  let verifiedTurboFan = false;
  let requestedTurboFan = false;
  let observeWorkload: ReturnType<typeof optimizationClock>;

  {
    const $p = Array.from({ length: params.length }, () => 0);

    for (let o = 0; o < params.length; o++) {
      $p[o] = await opts.params[o]();
    }

    observeWorkload = optimizationClock(now());
    const t0 = now();
    const r = fn(...$p);
    let t1: number;
    let first: unknown;

    if ((async = r instanceof Promise)) {
      first = await r;
      if (!opts.manual && first !== void 0) consume(first);
      t1 = now();
    } else {
      first = r;
      if (!opts.manual && r !== void 0) consume(r);
      t1 = now();
    }

    // Manual benchmarks return durations instead of results.
    if (!opts.manual && opts.$first) await opts.$first(first);

    if (opts.after) await opts.after();

    recordWarmup(warmup, opts.manual ? (first as number) : t1 - t0, 1, opts, now());
    workload = observeWorkload(optimization?.tier(fn), now());
    async function warmCalls(limit: number) {
      let duration = 0;
      let iterations = 0;
      while (iterations < limit && now() < warmup.deadline) {
        for (let oo = 0; oo < params.length; oo++) {
          $p[oo] = await opts.params[oo]();
        }

        const t0 = now();
        const value = async ? await fn(...$p) : fn(...$p);
        if (!opts.manual && value !== void 0) consume(value);
        duration += opts.manual ? value : now() - t0;
        if (opts.after) await opts.after();
        iterations++;
      }
      if (iterations) recordWarmup(warmup, duration, iterations, opts, now());
      workload = observeWorkload(optimization?.tier(fn), now());
      return iterations ? duration / iterations : undefined;
    }
    const prepared =
      opts.warmup_samples > 0 &&
      opts.warmup_time > 0 &&
      now() < warmup.deadline &&
      compiler?.prepare(fn);
    // Prepare self-timed submission code before settling its returned timings.
    if (opts.manual && prepared) {
      await warmCalls(15);
      if (now() < warmup.deadline && compiler?.compile(fn)) {
        requestedTurboFan = true;
        warmup = createWarmup(warmup.deadline, opts.warmup_samples, warmup.settled);
      }
    }
    while (
      !isWarmupDone(warmup, opts, now()) &&
      !(prepared && !opts.manual && (warmup.stable || workload?.tier === 'TurboFan'))
    )
      await warmCalls(warmup.iterations);
    single = warmup.single;
    // The budget bounds the agreement loop, not the compile, which is a
    // synchronous millisecond. Jittery workloads spend the whole budget
    // without agreeing and still deserve the top tier.
    if (!opts.manual && prepared) {
      // A replayed block makes the calls the pilot made to estimate its batch
      if (opts.batch_samples && now() < warmup.deadline) await warmCalls(batchSize(opts, single));
      if (compiler?.compile(fn)) {
        requestedTurboFan = true;
        await warmCalls(1);
        single = (await warmCalls(1)) ?? warmup.single;
        verifiedTurboFan = optimization?.tier(fn) === 'TurboFan';
      }
      if (!verifiedTurboFan) {
        while (!isWarmupDone(warmup, opts, now())) await warmCalls(warmup.iterations);
        single = warmup.single;
      }
    }
    batch = single <= opts.batch_threshold;
  }

  if (opts.batch !== undefined) batch = !!opts.batch;

  if (opts.manual) {
    batch = false;
    opts.concurrency = 1;
  }

  let batchSamples: number = opts.batch_samples ?? (batch ? batchSize(opts, single) : 0);
  if (batch && batchSamples < 1)
    throw new TypeError('expected at least one iteration per batched sample');

  // Size the final batch from a continuous loop without per-call clock reads.
  // Parameter generation requires separate timing.
  if (
    opts.batch_samples === undefined &&
    batch &&
    !params.length &&
    !opts.manual &&
    now() < warmup.deadline
  ) {
    const t0 = now();
    for (let o = 0; o < batchSamples; o++) {
      const value = async ? await fn() : fn();
      if (value !== void 0) consume(value);
    }
    batchSamples = batchSize(opts, (now() - t0) / batchSamples);
    if (opts.after) await opts.after();
  }

  const call = (concurrency: number, unroll?: number): string => {
    if (!params.length) return '$fn()';

    const args = params.map((_, parameter) => {
      if (unroll === void 0) return `param_${parameter}_${concurrency}`;
      return `param_${parameter}_${concurrency}[${unroll === 0 ? '' : `${unroll} + `}param_offset]`;
    });
    return `$fn(${args.join(', ')})`;
  };

  const calls = (unroll?: number): string => {
    if (opts.manual) return `t2 += ${async ? 'await ' : ''}${call(0, unroll)};`;

    if (async && opts.concurrency > 1) {
      return `
        {
          const _result = await Promise.all([
            ${Array.from({ length: opts.concurrency }, (_, concurrency) => `${call(concurrency, unroll)},`).join('\n')}
          ]);
          $consume(_result, ${unroll ?? 0});
        }
      `;
    }

    return Array.from(
      { length: opts.concurrency },
      (_, concurrency) => `
        {
          const _result = ${async ? 'await ' : ''}${call(concurrency, unroll)};
          if (void 0 !== _result) $consume(_result, ${(unroll ?? 0) * opts.concurrency + concurrency});
        }
      `
    ).join('\n');
  };

  // The batch was sized from calls made by this function. Inlined into the
  // compiled loop the same call can cost a fraction of that, which on a coarse
  // clock leaves samples too short to time. A pilot whose warm samples fall
  // below `batch_floor` rebuilds the loop once with a batch sized from them.
  let resizable = opts.batch_samples === undefined && !params.length;
  for (;;) {
    const prepare = !params.length
      ? ''
      : !batch
        ? Array.from({ length: params.length }, (_, p) =>
            Array.from(
              { length: opts.concurrency },
              (_, c) => `
            if ((param_${p}_${c} = $params[${p}]()) instanceof Promise) param_${p}_${c} = await param_${p}_${c};
          `
            ).join('\n')
          ).join('\n')
        : `
        for (let o = 0; o < ${batchSamples}; o++) {
          ${Array.from({ length: params.length }, (_, p) =>
            Array.from(
              { length: opts.concurrency },
              (_, c) => `
              if ((param_${p}_${c}[o] = $params[${p}]()) instanceof Promise) param_${p}_${c}[o] = await param_${p}_${c}[o];
            `
            ).join('\n')
          ).join('\n')}
        }
      `;
    const body = `
    ${!opts.manual ? '' : 'let t2 = 0;'}
    ${
      !batch
        ? calls()
        : `
      for (let o = 0; o < ${(batchSamples / opts.batch_unroll) | 0}; o++) {
        ${!params.length ? '' : `const param_offset = o * ${opts.batch_unroll};`}
        ${Array.from({ length: opts.batch_unroll }, (_, unroll) => calls(unroll)).join('\n')}
      }
      for (let param_offset = ${Math.floor(batchSamples / opts.batch_unroll) * opts.batch_unroll}; param_offset < ${batchSamples}; param_offset++) {
        ${calls(0)}
      }
    `
    }
  `;
    const collect = !!(opts.gc && !opts.gc.fallback);
    const samples = createSamples(opts.max_samples);
    const observer = opts.sample_gc ? await GcObservation.create() : undefined;
    const observation = new GcScope(observer);
    const awaitGcOutsideLoop = !opts.heap;
    const after = !opts.after ? '' : 'await $after();';
    // Run each sample's hook before the next sample, or after the final tier check.
    const afterSample = opts.after ? 'if (_ > 0) await $after();' : '';
    const warmed =
      batch &&
      opts.warmup_samples > 0 &&
      opts.warmup_time > 0 &&
      samples.length > 0 &&
      !opts.$counters;
    // Keep probe results outside the sampling loop's live locals.
    function verifiedTier(
      tier: OptimizationTier | undefined,
      harnessTier: OptimizationTier | undefined,
      direct: boolean
    ): OptimizationTier | null {
      return tier &&
        (direct ||
          tier === harnessTier ||
          ['Ignition', 'Sparkplug', 'LLInt', 'Baseline'].includes(harnessTier ?? ''))
        ? tier
        : null;
    }
    let benchmarkEnd: OptimizationTier | null = null;
    const entry = {
      tier: undefined as OptimizationTier | undefined,
      at: 0,
      finish(harnessTier?: OptimizationTier) {
        deopts?.finish();
        benchmarkEnd = verifiedTier(optimization?.tier(fn), harnessTier, !batch && !dollar_vm);
      },
    };

    const loop: (...args: any[]) => Promise<any> = new AsyncFunction(
      '$fn',
      '$gc',
      '$now',
      '$heap',
      '$params',
      '$counters',
      '$consume',
      '$after',
      '$summary',
      '$observation',
      '$samples',
      '$summarize',
      '$minSamples',
      '$minTime',
      '$warm',
      '$entry',
      '$vm',
      '$settle',
      '$recordSamples',
      '$recordTime',
      '$warmUntil',
      `
    ${opts.warmup_samples > 0 && optimization?.frame ? `$entry.tier = ${optimization.frame}; $entry.at = $now();` : ''}
    ${!opts.$counters ? '' : 'let _hc = false;'}
    ${!opts.$counters ? '' : 'try { $counters.init(); _hc = true; } catch {}'}

    let _ = 0; let t = 0;

    ${Array.from({ length: params.length }, (_, p) =>
      Array.from(
        { length: opts.concurrency },
        (_, c) => `
        let param_${p}_${c} = ${!batch ? 'null' : `new Array(${batchSamples}).fill(undefined)`};
      `
      ).join('\n')
    ).join('\n')}

    for (;; _++) {
      const atLimit = _ >= ${samples.length} || (_ >= $minSamples && t >= $minTime);
      if (atLimit && !$settle) break;
      ${afterSample}
      if (atLimit || ($settle && $now() >= $warmUntil)) {
        const settled = $settle(t / _);
        if (settled === null) return;
        if (settled) {
          $minSamples = $recordSamples;
          $minTime = $recordTime;
          $settle = null;
        }
        ${optimization?.frame ? `$entry.tier = ${optimization.frame}; $entry.at = $now();` : ''}
        _ = 0; t = 0;
        if ($minSamples <= 0 && $minTime <= 0) break;
      }
      ${prepare}
      ${!opts.$counters ? '' : 'if (_hc) try { $counters.before(); } catch {};'}
      const t0 = $now();
      ${body}
      const t1 = $now();
      ${!opts.$counters ? '' : 'if (_hc) try { $counters.after(); } catch {};'}

      const diff = ${opts.manual ? 't2' : 't1 - t0'};
      t += ${'manual' === opts.manual ? 't2' : 't1 - t0'};
      $samples[_] = diff ${!batch ? '' : `/ ${batchSamples}`};
    }
    ${opts.warmup_samples > 0 && optimization ? `if (_ > 0) $entry.finish(${optimization.frame ?? ''});` : ''}
    ${afterSample}
    if ($warm) return t / _;

    const gc = ${awaitGcOutsideLoop ? '' : 'await '}$observation.finish(t, _ * ${batch ? batchSamples : 1}, ${now === runtimeNow && !opts.manual});
    ${
      !opts.$counters
        ? ''
        : `
      let counters;
      try {
        if (_hc) counters = $counters.translate(${!batch ? 1 : batchSamples}, _);
      } finally {
        if (_hc) try { $counters.deinit(); } catch {}
      }
    `
    }

    ${memoryPass({ heap: !!opts.heap, gc: collect, prepare, body, after, iterations: batch ? batchSamples : 1 })}

    return {
      ...$summarize($samples, _),
      ticks: _ ${!batch ? '' : `* ${batchSamples}`},
      plan: { batch: ${batch}, batch_samples: ${batchSamples}, batch_unroll: ${opts.batch_unroll}, samples: _ },
      ${!opts.heap ? '' : 'heap: $summary(heap),'}
      gc,
      ${!opts.$counters ? '' : '...(!_hc ? {} : { counters }),'}
    };
  `
    );

    // An unbatched sample calls the function once between clock reads. Once the
    // engine optimizes this loop it inlines the function and times code compiled
    // in the loop's context, which runs tight loops up to 2x slower than the
    // function on its own. Each sample is long enough that interpreting the loop
    // around it costs nothing measurable.
    if (!batch) never_optimize(loop);

    const watchDeopts: MeasureOptions['$deopts'] = opts.$deopts;
    const deopts = requestedTurboFan ? watchDeopts?.(batch ? [fn, loop] : [fn]) : undefined;
    let samplingWarmup = warmup;

    const run = (
      warm: boolean,
      minSamples = warm ? opts.warmup_samples : opts.min_samples,
      settle?: (duration: number) => boolean | null
    ) =>
      loop(
        fn,
        opts.gc,
        opts.now,
        opts.heap,
        opts.params,
        opts.$counters,
        consume,
        opts.after,
        summarize,
        observation,
        samples,
        summarizeSamples,
        settle && !warm ? opts.warmup_samples : minSamples,
        warm || settle ? 0 : opts.min_cpu_time,
        warm,
        entry,
        dollar_vm,
        settle,
        warm ? minSamples : opts.min_samples,
        warm ? 0 : opts.min_cpu_time,
        samplingWarmup.deadline
      );

    try {
      const observeHarness = optimizationClock(now());
      let harness: OptimizationSample | null = readHarness();
      let benchmark: OptimizationSample | null = null;
      function readHarness(): OptimizationSample | null {
        return optimization?.frame
          ? observeHarness(entry.tier, entry.at)
          : observeHarness(optimization?.tier(loop), now());
      }
      function readBenchmark(at = now()): OptimizationSample | null {
        const tier = verifiedTier(workload?.tier, harness?.tier, !batch && !dollar_vm);
        return tier ? { tier, time: at - started } : null;
      }
      let optimizedAt = 0;
      let resized = 0;
      const undersized = (pass: number) => {
        const size = batchSize(opts, pass / batchSamples);
        if (resizable && pass < opts.batch_floor && size > batchSamples) resized = size;
        return resized > 0;
      };
      let settle: Parameters<typeof run>[2];
      // Warm and verify the loop that records samples.
      if (warmed) {
        samplingWarmup = createWarmup(
          now() + opts.warmup_time,
          opts.warmup_samples,
          now() + opts.warmup_settle
        );
        // The loop is labs' own code and compiles whatever tier the workload
        // reached, inlining it as it stands
        const preparedLoop = compiler?.prepare(loop);
        // Prime entry-path feedback before the hot loop can tier up through OSR.
        for (let i = 0; i < 3 && now() < samplingWarmup.deadline; i++) {
          await run(true, 0);
          harness = readHarness();
        }
        if (now() < samplingWarmup.deadline) await run(true, 1);
        for (
          let i = 1;
          preparedLoop && i < opts.warmup_samples && now() < samplingWarmup.deadline;
          i++
        )
          await run(true, 1);
        harness = readHarness();
        let priming = true;
        settle = (pass) => {
          if (priming) {
            priming = false;
            return true;
          }
          const previousTier = harness?.tier;
          const previousWorkload = workload?.tier;
          harness = readHarness();
          workload = observeWorkload(optimization?.tier(fn), now());
          if (harness?.tier !== previousTier || workload?.tier !== previousWorkload) {
            samplingWarmup = createWarmup(
              samplingWarmup.deadline,
              opts.warmup_samples,
              samplingWarmup.settled
            );
          }
          const at = now();
          if (Number.isFinite(pass)) recordWarmup(samplingWarmup, pass, 1, opts, at);
          // Past the settle time a short sample reflects the warm cost. Null
          // abandons the loop without recording.
          if (at >= samplingWarmup.settled && undersized(pass)) return null;
          if (!isWarmupDone(samplingWarmup, opts, at)) return false;
          // A stable batch can still have an ambiguous tier while its caller is optimizing.
          if (at < samplingWarmup.deadline && workload && optimization?.frame) {
            const tier = readBenchmark(at)?.tier;
            if (!tier || (requestedTurboFan && tier !== 'TurboFan')) return false;
          }
          if (opts.gc) opts.gc();
          workload = observeWorkload(optimization?.tier(fn), now());
          if (requestedTurboFan && workload?.tier !== 'TurboFan' && now() < samplingWarmup.deadline)
            return false;
          deopts?.start();
          observation.start();
          return true;
        };
        // Keep the diagnostic callback out of the sampling loop's compiled body.
        never_optimize(settle);
        dollar_vm?.noInline(settle);
        // Prime the recording transition without executing benchmark calls.
        await run(true, 0, settle);
        harness = readHarness();
        if (preparedLoop && optimization && compiler?.compile(loop)) {
          const pass = await run(true, 1);
          harness = readHarness();
          workload = observeWorkload(optimization.tier(fn), now());
          if (
            benchmarkEnd === 'TurboFan' &&
            harness?.tier === 'TurboFan' &&
            optimization.tier(loop) === 'TurboFan' &&
            !undersized(pass)
          ) {
            if (opts.gc) opts.gc();
            workload = observeWorkload(optimization.tier(fn), now());
            if (workload?.tier === 'TurboFan' && optimization.tier(loop) === 'TurboFan') {
              optimizedAt = now();
              settle = undefined;
              deopts?.start();
              observation.start();
            }
          }
        }
        if (settle && now() >= samplingWarmup.deadline) {
          if (opts.gc) opts.gc();
          workload = observeWorkload(optimization?.tier(fn), now());
          settle = undefined;
          deopts?.start();
          observation.start();
        }
      } else {
        if (opts.gc) opts.gc();
        workload = observeWorkload(optimization?.tier(fn), now());
        // A collection can invalidate prepared code before the first timed call.
        while (
          !batch &&
          requestedTurboFan &&
          workload?.tier !== 'TurboFan' &&
          now() < warmup.deadline
        ) {
          await run(true, 1);
          workload = observeWorkload(optimization?.tier(fn), now());
          if (workload?.tier === 'TurboFan' && opts.gc) {
            opts.gc();
            workload = observeWorkload(optimization?.tier(fn), now());
          }
        }
        benchmark = readBenchmark();
        if (!opts.manual && requestedTurboFan && benchmark?.tier === 'TurboFan') optimizedAt = now();
        deopts?.start();
        observation.start();
      }

      const recorded = resized ? undefined : await run(false, opts.min_samples, settle);
      if (!recorded) {
        batchSamples = resized;
        resizable = false;
        continue;
      }
      if (opts.warmup_samples > 0 && optimization?.frame) {
        harness = readHarness();
        benchmark = readBenchmark(entry.at);
      }
      const measured = {
        kind: 'fn' as const,
        debug: loop.toString(),
        ...(!optimizedAt && isWarmupUnsettled(samplingWarmup, opts) ? { unsettled: true } : {}),
        ...(optimizedAt || samplingWarmup.settledAt
          ? {
              warmup: {
                time: (optimizedAt || samplingWarmup.settledAt) - started,
                phase: warmed ? ('sampling' as const) : ('workload' as const),
              },
            }
          : {}),
        ...(opts.warmup_samples > 0
          ? {
              optimization: {
                mode: 'prepared' as const,
                ...(requestedTurboFan ? { target: 'TurboFan' as const } : {}),
                ...(deopts ? { deoptimized: [deopts.observed()] } : {}),
                benchmark: [benchmark],
                benchmarkEnd: [benchmarkEnd],
                workload: [workload],
                ...(warmed ? { harness: [harness] } : {}),
              },
            }
          : {}),
        ...recorded,
      };
      if (observer && awaitGcOutsideLoop) measured.gc = await measured.gc;
      if (!observer) delete measured.gc;
      return measured;
    } finally {
      observation.cancel();
    }
  }
}
