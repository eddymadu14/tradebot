import crypto from "crypto";
import { ec as EC } from "elliptic";
import bs58check from "bs58check";
import fs from "fs";

const ec = new EC("secp256k1");

// Convert private key → legacy Bitcoin address (P2PKH)
function privateKeyToLegacyAddress(privKeyInt) {
  const key = ec.keyFromPrivate(privKeyInt.toString(16));

  const pubPoint = key.getPublic();
  const pubKey = Buffer.from(pubPoint.encode("hex", false), "hex");

  const sha = crypto.createHash("sha256").update(pubKey).digest();
  const ripemd = crypto.createHash("ripemd160").update(sha).digest();

  const payload = Buffer.concat([Buffer.from([0x00]), ripemd]);

  return bs58check.encode(payload);
}

// =========================
// CONFIG
// =========================
const START = 1;
const END = 100000;

// Buffers for output
const keys = [];
const addresses = [];

for (let k = START; k <= END; k++) {
  const address = privateKeyToLegacyAddress(k);

  keys.push(k.toString(16));     // save as hex (cleaner for crypto work)
  addresses.push(address);

  if (k % 20000 === 0) {
    console.log(`Processed ${k} keys...`);
  }
}

// Write to separate files
fs.writeFileSync("keys.csv", keys.join("\n"));
fs.writeFileSync("addresses.csv", addresses.join("\n"));

console.log("Done.");
console.log("keys.csv → private keys");
console.log("addresses.csv → corresponding addresses");
