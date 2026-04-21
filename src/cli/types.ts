import { LabsConfig } from '../config';

export interface CLIContext {
  config: LabsConfig;
  configPath: string;
  labsDir: string;
}
