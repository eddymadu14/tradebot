/**
 * BTC Mnemonic Checker — Resume-capable Address Matcher
 * ───────────────────────────────────────────────────────
 * Deps: npm install bip39 @scure/bip32
 * (Uses Node built-in crypto for sha256 + ripemd160 — no @noble/hashes needed)
 *
 * Run:
 *   node mnemonic_checker.js
 *   node mnemonic_checker.js <startIndex> <endIndex>
 */

import * as bip39 from "bip39";
import { HDKey } from "@scure/bip32";
import { createHash } from "crypto";           // ← Node built-in, no install needed
import { readFileSync, writeFileSync, existsSync } from "fs";

// ── Target BTC address ─────────────────────────────────────────────────────
const TARGET_ADDRESS = "1KfZGvwZxsvSmemoCmEV75uqcNzYBHjkHZ";

// ── Final 12 filtered unique words from puzzle ────────────────────────────
const WORDS = [
  "find",    "seed",    "phrase",  "brave",
  "new",     "world",   "breathe", "peace",
  "justice", "matter",  "needle",  "liberty",
];

const TOTAL       = 479001600n;   // 12!
const MEMORY_FILE = "checkpoint.json";
const MATCH_FILE  = "match.txt";
const LOG_EVERY   = 100_000;

// ── CLI range ──────────────────────────────────────────────────────────────
const cliStart = process.argv[2] ? BigInt(process.argv[2]) : null;
const cliEnd   = process.argv[3] ? BigInt(process.argv[3]) : null;

// ── Checkpoint ────────────────────────────────────────────────────────────
const checkpoint = loadCheckpoint();
const startIdx   = cliStart ?? checkpoint.index;
const endIdx     = cliEnd   ?? TOTAL;

console.log(`\n🔐 Target  : ${TARGET_ADDRESS}`);
console.log(`📖 Words   : ${WORDS.join(", ")}`);
console.log(`📊 Total   : ${Number(TOTAL).toLocaleString()}`);
console.log(`▶️  Start   : ${startIdx.toLocaleString()}`);
console.log(`⏹️  End     : ${endIdx.toLocaleString()}`);
console.log(`📍 Range   : ${(endIdx - startIdx).toLocaleString()}`);
console.log(`\n🔍 Scanning...\n`);

// ── Main scan ──────────────────────────────────────────────────────────────
let checked  = 0;
let valid    = 0;
let matched  = 0;
const startTime = Date.now();

for (let i = startIdx; i < endIdx; i++) {
  const perm   = nthPermutation(WORDS, i);
  const phrase = perm.join(" ");

  if (!bip39.validateMnemonic(phrase)) {
    checked++;
    maybeLog(i, checked, valid, matched, startIdx, endIdx, startTime);
    continue;
  }

  valid++;

  const address = deriveAddress(phrase);

  if (address === TARGET_ADDRESS) {
    matched++;
    const msg = [
      `\n🎯 MATCH FOUND!`,
      `Phrase  : ${phrase}`,
      `Address : ${address}`,
      `Index   : ${i}`,
      `\n`,
    ].join("\n");
    console.log(msg);
    writeFileSync(MATCH_FILE, msg, "utf8");
  }

  checked++;
  maybeLog(i, checked, valid, matched, startIdx, endIdx, startTime);
}

saveCheckpoint(endIdx);

const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
console.log(`\n\n${"=".repeat(60)}`);
console.log(`✅ Done in ${elapsed}s`);
console.log(`   Checked : ${checked.toLocaleString()}`);
console.log(`   Valid   : ${valid.toLocaleString()}`);
console.log(`   Matched : ${matched}`);
console.log(matched > 0 ? `   Result  → ${MATCH_FILE}` : `   No match in this range.`);

// ── Checkpoint helpers ────────────────────────────────────────────────────
function maybeLog(i, checked, valid, matched, startIdx, endIdx, startTime) {
  if (checked % LOG_EVERY !== 0) return;
  const elapsed   = ((Date.now() - startTime) / 1000).toFixed(1);
  const rangeSize = Number(endIdx - startIdx);
  const pct       = ((checked / rangeSize) * 100).toFixed(2);
  process.stdout.write(
    `\r   [${i}] Checked: ${checked.toLocaleString()} | Valid: ${valid} | Matched: ${matched} | ${pct}% | ${elapsed}s`
  );
  saveCheckpoint(i);
}

function saveCheckpoint(index) {
  writeFileSync(
    MEMORY_FILE,
    JSON.stringify({ index: index.toString(), ts: new Date().toISOString() }, null, 2),
    "utf8"
  );
}

function loadCheckpoint() {
  if (existsSync(MEMORY_FILE)) {
    try {
      const data = JSON.parse(readFileSync(MEMORY_FILE, "utf8"));
      const idx  = BigInt(data.index);
      console.log(`\n📌 Resuming from checkpoint: index ${idx.toLocaleString()} (saved ${data.ts ?? "unknown"})`);
      return { index: idx };
    } catch {
      console.log(`\n⚠️  Corrupt checkpoint — starting from 0`);
    }
  }
  return { index: 0n };
}

// ── nth permutation via Factoradic (Lehmer code) ──────────────────────────
function nthPermutation(arr, n) {
  arr = arr.slice();
  const result = [];
  let remaining = BigInt(n);
  for (let i = arr.length; i > 0; i--) {
    const fact = factorialBig(i - 1);
    const idx  = Number(remaining / fact);
    result.push(arr.splice(idx, 1)[0]);
    remaining %= fact;
  }
  return result;
}

// ── BTC P2PKH address (BIP44 m/44'/0'/0'/0/0) ────────────────────────────
function deriveAddress(mnemonic) {
  const seed  = bip39.mnemonicToSeedSync(mnemonic);
  const root  = HDKey.fromMasterSeed(seed);
  const child = root.derive("m/44'/0'/0'/0/0");
  return pubKeyToP2PKH(child.publicKey);
}

function pubKeyToP2PKH(pubKey) {
  // SHA256 then RIPEMD160 — both from Node built-in crypto
  const sha     = createHash("sha256").update(pubKey).digest();
  const hash160 = createHash("ripemd160").update(sha).digest();

  // Version byte 0x00 (mainnet P2PKH)
  const versioned = Buffer.alloc(21);
  versioned[0] = 0x00;
  hash160.copy(versioned, 1);

  // Double-SHA256 checksum
  const h1       = createHash("sha256").update(versioned).digest();
  const h2       = createHash("sha256").update(h1).digest();
  const checksum = h2.slice(0, 4);

  // Final 25-byte payload
  const payload = Buffer.alloc(25);
  versioned.copy(payload, 0);
  checksum.copy(payload, 21);

  return base58Encode(payload);
}

// ── Base58 encoder ────────────────────────────────────────────────────────
const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

function base58Encode(buf) {
  let num    = BigInt("0x" + buf.toString("hex"));
  let result = "";
  while (num > 0n) {
    result = B58[Number(num % 58n)] + result;
    num    = num / 58n;
  }
  for (const byte of buf) {
    if (byte === 0) result = "1" + result;
    else break;
  }
  return result;
}

// ── Math ──────────────────────────────────────────────────────────────────
function factorialBig(n) {
  let r = 1n;
  for (let i = 2n; i <= BigInt(n); i++) r *= i;
  return r;
}
