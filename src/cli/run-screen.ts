import type { LabsConfig } from '../config.ts';
import { replayReport } from '../report.ts';
import type { SavedResult } from '../store.ts';
import { renderRunView } from './run-view.ts';
import { isInteractiveTerminal, openReportScreen } from './screen.ts';

export async function showRunReport(
  result: SavedResult,
  config: LabsConfig,
  saved = true
): Promise<void> {
  const count = result.files.reduce(
    (sum, file) => sum + file.benchmarks.reduce((n, trial) => n + trial.runs.length, 0),
    0
  );
  if (!isInteractiveTerminal() || !count) {
    replayReport(result, config);
    return;
  }
  await openReportScreen((state) => renderRunView(result, config, state, saved), count);
}
