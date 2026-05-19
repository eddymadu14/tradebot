import crypto from "crypto";
import { ec as EC } from "elliptic";
import bs58check from "bs58check";

const ec = new EC("secp256k1");

// =========================
// 1. CONFIG (tiny keyspace)
// =========================
const START = 1;
const END = 1_000_000;

// =========================
// 2. HELPERS
// =========================

// SHA256
function sha256(buffer) {
  return crypto.createHash("sha256").update(buffer).digest();
}

// RIPEMD160(SHA256(pubkey))
function hash160(buffer) {
  return crypto
    .createHash("ripemd160")
    .update(sha256(buffer))
    .digest();
}

// Convert private key → Bitcoin P2PKH address
function privateKeyToAddress(privKeyInt) {
  const key = ec.keyFromPrivate(privKeyInt.toString(16));

  const pubPoint = key.getPublic();
  const pubKey = Buffer.from(pubPoint.encode("hex", false), "hex");

  const pubHash = hash160(pubKey);

  // Mainnet prefix 0x00
  const payload = Buffer.concat([Buffer.from([0x00]), pubHash]);

  return bs58check.encode(payload);
}

// =========================
// 3. STEP A: GENERATE TARGET
// =========================

const targetPrivateKey =
  Math.floor(Math.random() * (END - START)) + START;

const targetAddress = privateKeyToAddress(targetPrivateKey);

console.log("TARGET ADDRESS:");
console.log(targetAddress);
console.log("Searching...\n");

// =========================
// 4. STEP B: BRUTE FORCE SEARCH
// =========================

let found = false;
const startTime = Date.now();

for (let k = START; k <= END; k++) {
  const addr = privateKeyToAddress(k);

  if (addr === targetAddress) {
    console.log("FOUND MATCH!");
    console.log("Private Key:", k.toString(16));
    console.log("Decimal:", k);
    found = true;
    break;
  }

  if (k % 100000 === 0) {
    console.log(`Checked ${k} keys...`);
  }
}

const endTime = Date.now();

if (!found) {
  console.log("Not found in range (unexpected in this toy model).");
}

console.log(`Time: ${(endTime - startTime) / 1000}s`);
