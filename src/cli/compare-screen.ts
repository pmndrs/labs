import type { ReadStream, WriteStream } from 'node:tty';
import { type CompareResult, printCompareReport } from '../compare.ts';
import type { LabsConfig } from '../config.ts';
import { comparisonSummary, renderCompareView } from './compare-view.ts';
import { isInteractiveTerminal, openReportScreen } from './screen.ts';
import { terminalText } from './terminal.ts';

/** Use the alternate screen only when both input and output are interactive. */
export async function showCompareReport(result: CompareResult, config: LabsConfig): Promise<void> {
  if (!isInteractiveTerminal() || result.environmentFailures.length || !result.benches.length) {
    printCompareReport(result, config);
    return;
  }
  await openCompareScreen(result, config);
  console.log(
    `\ncompare ${terminalText(result.baselineName)} → ${terminalText(result.candidateName)}  ${comparisonSummary(result)}\n`
  );
}

export function openCompareScreen(
  result: CompareResult,
  config: LabsConfig,
  input: ReadStream = process.stdin,
  output: WriteStream = process.stdout
): Promise<void> {
  return openReportScreen(
    (state) => renderCompareView(result, config, state),
    result.benches.length,
    input,
    output
  );
}
