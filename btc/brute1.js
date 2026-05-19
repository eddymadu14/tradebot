import crypto from "crypto";
import bs58check from "bs58check";
import fs from "fs";
import pkg from "elliptic";
const { ec: EC } = pkg;

const ec = new EC("secp256k1");

// =========================
// CONFIG (HEX RANGE)
// =========================
const START = BigInt("0x0000000000000000000000000000000000000000000000000000000000000abc");
const END   = BigInt("0x00000000000000000000000000000000000000000000000000000000000fffff");

// =========================
// SETTINGS
// =========================
const BATCH_SIZE = 20000;

// =========================
// HELPERS
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
// MAIN LOOP
// =========================

let batchIndex = 0;
let counter = 0;

let keyBuffer = "";
let addrBuffer = "";

function flushBatch() {
  fs.writeFileSync(`keys_batch_${batchIndex}.csv`, keyBuffer);
  fs.writeFileSync(`addresses_batch_${batchIndex}.csv`, addrBuffer);

  console.log(`Flushed batch ${batchIndex} (${counter} total keys processed)`);

  keyBuffer = "";
  addrBuffer = "";
  batchIndex++;
}

for (let k = START; k <= END; k++) {
  const hexKey = k.toString(16).padStart(64, "0");
  const address = privateKeyToLegacyAddress(hexKey);

  // accumulate batch strings (fast string concat, not array overhead)
  keyBuffer += hexKey + "\n";
  addrBuffer += address + "\n";

  counter++;

  // flush every 20k
  if (counter % BATCH_SIZE === 0) {
    flushBatch();
  }
}

// flush remaining leftovers
if (keyBuffer.length > 0) {
  flushBatch();
}

console.log("DONE");
console.log(`Total keys processed: ${counter}`);
