import crypto from "crypto";
import bs58check from "bs58check";
import fs from "fs";
import pkg from "elliptic";
const { ec: EC } = pkg;

const ec = new EC("secp256k1");

// =========================
// CONFIG
// =========================
const START = BigInt("0x0000000000000000000000000000000000000000000000000000000000000abc");
const END   = BigInt("0x00000000000000000000000000000000000000000000000000000000000fffff");

const BATCH_SIZE = 20000;
const PROGRESS_FILE = "progress.json";

// =========================
// LOAD CHECKPOINT
// =========================
function loadProgress() {
  if (!fs.existsSync(PROGRESS_FILE)) {
    return START;
  }

  const data = JSON.parse(fs.readFileSync(PROGRESS_FILE, "utf-8"));
  return BigInt(data.lastKey);
}

function saveProgress(lastKey) {
  fs.writeFileSync(
    PROGRESS_FILE,
    JSON.stringify({ lastKey: lastKey.toString() }, null, 2)
  );
}

// =========================
// ADDRESS GEN
// =========================
function privateKeyToLegacyAddress(hexKey) {
  const key = ec.keyFromPrivate(hexKey);

  const pubPoint = key.getPublic();
  const pubKey = Buffer.from(pubPoint.encode("hex", false), "hex");

  const sha = crypto.createHash("sha256").update(pubKey).digest();
  const ripemd = crypto.createHash("ripemd160").update(sha).digest();

  const payload = Buffer.concat([Buffer.from([0x00]), ripemd]);

  return bs58check.encode(payload);
}

// =========================
// SAFE SHUTDOWN HANDLER
// =========================
let running = true;

process.on("SIGINT", () => {
  console.log("\nGraceful shutdown triggered...");
  running = false;
});

// =========================
// MAIN LOOP
// =========================
let startKey = loadProgress();
console.log("Resuming from:", startKey.toString(16));

let batchIndex = 0;
let counter = 0;

let keyBuffer = "";
let addrBuffer = "";

function flushBatch() {
  fs.writeFileSync(`keys_batch_${batchIndex}.csv`, keyBuffer);
  fs.writeFileSync(`addresses_batch_${batchIndex}.csv`, addrBuffer);

  console.log(`Flushed batch ${batchIndex} (${counter} processed)`);

  keyBuffer = "";
  addrBuffer = "";
  batchIndex++;
}

// =========================
// PROCESS LOOP
// =========================
for (let k = startKey; k <= END; k++) {
  if (!running) break;

  const hexKey = k.toString(16).padStart(64, "0");
  const address = privateKeyToLegacyAddress(hexKey);

  keyBuffer += hexKey + "\n";
  addrBuffer += address + "\n";

  counter++;

  // checkpoint every key (safe)
  saveProgress(k);

  // batch flush
  if (counter % BATCH_SIZE === 0) {
    flushBatch();
  }
}

// final flush
if (keyBuffer.length > 0) {
  flushBatch();
}

console.log("DONE");
console.log("Total processed:", counter);
