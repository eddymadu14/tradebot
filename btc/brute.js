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

const keys = [];
const addresses = [];

let counter = 0;

for (let k = START; k <= END; k++) {
  // Convert BigInt → padded hex (64 chars)
  const hexKey = k.toString(16).padStart(64, "0");

  const address = privateKeyToLegacyAddress(hexKey);

  keys.push(hexKey);
  addresses.push(address);

  counter++;

  if (counter % 20000 === 0) {
    console.log(`Processed ${counter} keys...`);
  }
}

// =========================
// SAVE FILES
// =========================

fs.writeFileSync("keys.csv", keys.join("\n"));
fs.writeFileSync("addresses.csv", addresses.join("\n"));

console.log("Done.");
console.log(`Total keys processed: ${counter}`);
