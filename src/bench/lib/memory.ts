/** Generate a bounded diagnostic pass after the timing loop has finished. */
export function memoryPass({
  heap,
  gc,
  prepare = '',
  body,
  after = '',
  iterations,
}: {
  heap: boolean;
  gc: boolean;
  prepare?: string;
  body: string;
  after?: string;
  iterations: number;
}): string {
  if (!heap) return '';

  return `
    const diagnosticCount = Math.min(20, _);
    const heap = new Float64Array(diagnosticCount);
    ${gc ? '$gc();' : ''}

    ${
      !heap
        ? ''
        : `
      // Subtract the heap reader's own allocation.
      let heapFloor = Infinity;
      for (let i = 0; i < 10; i++) {
        const h0 = $heap();
        const delta = $heap() - h0;
        if (delta >= 0) heapFloor = Math.min(heapFloor, delta);
      }
      if (!Number.isFinite(heapFloor)) heapFloor = 0;
    `
    }

    for (let i = 0; i < diagnosticCount; i++) {
      ${prepare}
      ${gc ? '$gc();' : ''}
      ${heap ? 'const h0 = $heap();' : ''}
      ${body}
      ${heap ? `heap[i] = Math.max(0, ($heap() - h0 - heapFloor) / ${iterations});` : ''}
      ${gc ? '$gc();' : ''}
      ${after}
    }
  `;
}
