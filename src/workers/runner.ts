import { flushShares } from "./flushShares";

async function run() {
  try {
    await flushShares();
    process.exit(0);
  } catch (err) {
    console.error(err);
    process.exit(1);
  }
}

run();
