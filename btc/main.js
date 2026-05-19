import { Worker } from "worker_threads";
import os from "os";

const START = BigInt("0x0000000000000000000000000000000000000000000000000000000000000001");
const END   = BigInt("0x0000000000000000000000000000000000000000000000000000000000ffffff");

const NUM_WORKERS = os.cpus().length;

const totalRange = END - START;
const chunkSize = totalRange / BigInt(NUM_WORKERS);

console.log(`Using ${NUM_WORKERS} workers...\n`);

for (let i = 0; i < NUM_WORKERS; i++) {
  const chunkStart = START + (chunkSize * BigInt(i));
  const chunkEnd =
    i === NUM_WORKERS - 1
      ? END
      : chunkStart + chunkSize;

  const worker = new Worker("./worker.mjs", {
    workerData: {
      start: chunkStart.toString(),
      end: chunkEnd.toString(),
      id: i
    }
  });

  worker.on("message", msg => {
    console.log(`Worker ${msg.id}: ${msg.progress}`);
  });

  worker.on("error", err => console.error(err));
}
