// Stand in for a bench worker. Takes TURNS turns under the turn protocol and
// appends ID to LOG on each so a test can read the order workers ran in.
import { appendFileSync } from 'node:fs';

function takeTurn(phase = 'turn'): Promise<void> {
  return new Promise((resolve) => {
    const onMessage = (message: unknown) => {
      if (message !== 'go') return;
      process.off('message', onMessage);
      resolve();
    };
    process.on('message', onMessage);
    process.send!(phase);
  });
}

if (process.env.DELAY) await new Promise((resolve) => setTimeout(resolve, Number(process.env.DELAY)));
if (process.env.FAIL_BEFORE_TURN) process.exit(3);
for (let i = 0; i < Number(process.env.TURNS); i++) {
  await takeTurn();
  appendFileSync(process.env.LOG!, process.env.ID!);
}
if (process.env.DIAGNOSTICS) {
  await takeTurn('diagnostics');
  appendFileSync(process.env.LOG!, process.env.ID!.toUpperCase());
}
if (process.env.FAIL) process.exit(3);
