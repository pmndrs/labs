# GC benchmark example

Three groups of benchmarks that put increasing pressure on the garbage collector, so the
report's `gc` and `gc max` columns have something to show. The workloads are small camera
and scene routines written locally in `camera.ts` with no dependencies.

## low garbage

Camera rigs that track a target circling the origin. They update preallocated state in place,
so they observe little or no GC. They are the baseline for the other groups.

- **look at** points the camera directly at the target every update. It allocates nothing, so
  its `gc` and `gc max` columns read zero.
- **follow** eases the camera toward an offset behind the target.
- **framing** holds the target inside a screen dead zone, easing back when it drifts out and
  never letting it pass a hard limit.

## short-lived garbage

The follow rig again, plus temporary pose copies that are dropped right after each call. The
light case makes one copy per call and the heavy case makes 128. These objects die young, so
they are cleaned up by frequent, cheap minor collections.

## retained garbage

Undo history for 1,000 scene objects. Each edit rotates one object and snapshots every
object's position, quaternion, and scale. The last 64 snapshots are kept in a ring buffer, so
each one survives several collections before it is replaced. Objects that live this long get
promoted to the old generation, which can lead to major collections and longer pauses.

The workloads never force a collection. Whether major events occur depends on the runtime and
how long the benchmark runs.

## Reading the report

- **gc** shows observed GC time per iteration and its share of sampling wall time, including gaps
  between timed calls. Below it is how often a collection occurred, such as `1 gc / 1,728 iter`.
- **gc max** shows the longest recorded pause, labeled when it was a major collection. Below it
  is the number of major collections.

These describe this run. They do not predict future pauses, and not every collection is caused
by the benchmark alone.

## Running

From the labs repository root:

```sh
pnpm --dir examples/gc bench
```

This runs the local labs source and opens the terminal report when measurement finishes. Use
the arrow keys to select a benchmark and `q` to exit.

The default is three fresh process blocks of 150 ms each per benchmark, plus warmup and
diagnostics. To use the usual eight blocks:

```sh
pnpm --dir examples/gc bench --blocks 8
```

Results are not saved by default.
