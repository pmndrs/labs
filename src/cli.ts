#!/usr/bin/env node
import { runCLI } from './runner.ts';

async function main(): Promise<void> {
  await runCLI(process.argv.slice(2));
}

void main();
