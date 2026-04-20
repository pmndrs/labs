import type { EligibleBench } from './compare.ts';
import { formatDelta, formatTime } from './utils/format.ts';

const NS = 'http://www.w3.org/2000/svg';
export const MAX_BENCHES_PER_P50_CHART = 8;

export function renderP50DumbbellChartSvg(
  benches: EligibleBench[],
  title: string
): string | undefined {
  if (benches.length === 0) return undefined;

  const rowHeight = 34;
  const chartTop = 56;
  const chartLeft = 180;
  const chartBottom = 36;
  const chartRight = 84;
  const width = 760;
  const plotWidth = width - chartLeft - chartRight;
  const chartHeight = benches.length * rowHeight;
  const height = chartTop + chartHeight + chartBottom;
  const maxValue = Math.max(
    ...benches.flatMap((bench) => [bench.baselineP50, bench.candidateP50]),
    1
  );
  const ticks = createTicks(maxValue, 4);
  const grid = '#c7bca8';
  const label = '#8a8174';
  const connector = '#d6ccbb';
  const baselineColor = '#d70206';
  const candidateColor = '#f05b4f';

  const svg = [
    `<svg xmlns="${NS}" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-labelledby="title desc">`,
    `<title id="title">${escapeXml(title)}</title>`,
    `<desc id="desc">Dumbbell chart showing baseline and candidate p50 values for ${benches.length} benchmarks.</desc>`,
    `<rect width="${width}" height="${height}" fill="#ffffff"/>`,
    `<text x="${chartLeft}" y="24" font-family="Avenir Next, Helvetica Neue, Arial, sans-serif" font-size="18" font-weight="600" fill="${label}">${escapeXml(title)}</text>`,
    `<text x="${chartLeft}" y="44" font-family="Avenir Next, Helvetica Neue, Arial, sans-serif" font-size="12" fill="${label}">baseline and candidate p50 on a shared time axis</text>`,
  ];

  for (const tick of ticks) {
    const x = chartLeft + (tick / maxValue) * plotWidth;
    svg.push(
      `<line x1="${x}" y1="${chartTop - 8}" x2="${x}" y2="${chartTop + chartHeight}" stroke="${grid}" stroke-width="1" stroke-dasharray="4 4"/>`,
      `<text x="${x}" y="${chartTop - 16}" text-anchor="middle" font-family="Avenir Next, Helvetica Neue, Arial, sans-serif" font-size="11" fill="${label}">${escapeXml(formatTime(tick))}</text>`
    );
  }

  benches.forEach((bench, index) => {
    const y = chartTop + index * rowHeight + rowHeight / 2;
    const labelText = chartLabel(bench);
    const baselineX = chartLeft + (bench.baselineP50 / maxValue) * plotWidth;
    const candidateX = chartLeft + (bench.candidateP50 / maxValue) * plotWidth;
    const deltaColor = bench.deltaP50 <= 0 ? baselineColor : candidateColor;
    const deltaText = formatDelta(bench.deltaP50);

    svg.push(
      `<text x="${chartLeft - 14}" y="${y + 4}" text-anchor="end" font-family="Avenir Next, Helvetica Neue, Arial, sans-serif" font-size="12" fill="${label}">${escapeXml(labelText)}</text>`,
      `<line x1="${baselineX}" y1="${y}" x2="${candidateX}" y2="${y}" stroke="${connector}" stroke-width="4" stroke-linecap="round"/>`,
      `<circle cx="${baselineX}" cy="${y}" r="5.5" fill="#ffffff" stroke="${baselineColor}" stroke-width="3"/>`,
      `<circle cx="${candidateX}" cy="${y}" r="5.5" fill="${candidateColor}"/>`,
      `<text x="${width - 10}" y="${y + 4}" text-anchor="end" font-family="Avenir Next, Helvetica Neue, Arial, sans-serif" font-size="11" fill="${deltaColor}">${escapeXml(`${deltaText} (${formatTime(bench.baselineP50)} -> ${formatTime(bench.candidateP50)})`)}</text>`
    );
  });

  const legendY = height - 10;
  svg.push(
    `<circle cx="${chartLeft}" cy="${legendY - 4}" r="5.5" fill="#ffffff" stroke="${baselineColor}" stroke-width="3"/>`,
    `<text x="${chartLeft + 12}" y="${legendY}" font-family="Avenir Next, Helvetica Neue, Arial, sans-serif" font-size="12" fill="${label}">baseline</text>`,
    `<circle cx="${chartLeft + 86}" cy="${legendY - 4}" r="5.5" fill="${candidateColor}"/>`,
    `<text x="${chartLeft + 98}" y="${legendY}" font-family="Avenir Next, Helvetica Neue, Arial, sans-serif" font-size="12" fill="${label}">candidate</text>`
  );

  svg.push(`</svg>`);
  return svg.join('');
}

export function splitEligibleBenchesForCharts(
  benches: EligibleBench[],
  maxPerChart = MAX_BENCHES_PER_P50_CHART
): EligibleBench[][] {
  const chunks: EligibleBench[][] = [];
  for (let i = 0; i < benches.length; i += maxPerChart) {
    chunks.push(benches.slice(i, i + maxPerChart));
  }
  return chunks;
}

function createTicks(max: number, count: number): number[] {
  const rawStep = max / count;
  const magnitude = Math.pow(10, Math.floor(Math.log10(rawStep || 1)));
  const normalized = rawStep / magnitude;
  const nice =
    normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 5 ? 5 : 10;
  const step = nice * magnitude;
  const top = Math.ceil(max / step) * step;
  const ticks: number[] = [];
  for (let value = 0; value <= top; value += step) ticks.push(value);
  return ticks;
}

function chartLabel(bench: EligibleBench): string {
  const label = bench.key.group && bench.key.group !== bench.key.name
    ? `${bench.key.group} > ${bench.key.name}`
    : bench.key.name || 'anonymous';
  return label.length > 28 ? `${label.slice(0, 27)}…` : label;
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
