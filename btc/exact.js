/**
 * BTC Mnemonic Checker — Resume-capable Address Matcher
 * ───────────────────────────────────────────────────────
 * - Tries all 12! = 479,001,600 permutations of the 12 seed words
 * - Validates BIP39 checksum
 * - Derives BTC address (BIP44 m/44'/0'/0'/0/0) and compares to target
 * - Saves ONLY memory checkpoint (permutation index), never phrases
 * - Saves matched phrase to match.txt ONLY on a hit
 *
 * Install deps:
 *   npm install bip39 @scure/bip32 @noble/hashes @noble/secp256k1
 *
 * Run:
 *   node mnemonic_checker.js
 *   node mnemonic_checker.js <startIndex> <endIndex>   ← optional range
 */

import * as bip39 from "bip39";
import { HDKey } from "@scure/bip32";
import { ripemd160 } from "@noble/hashes/ripemd160";
import { sha256 } from "@noble/hashes/sha256";
import { readFileSync, writeFileSync, existsSync } from "fs";

// ── Target BTC address ─────────────────────────────────────────────────────
const TARGET_ADDRESS = "1KfZGvwZxsvSmemoCmEV75uqcNzYBHjkHZ";

// ── 12 unique seed word candidates ────────────────────────────────────────
const WORDS = [
  "find", "seed", "phrase", "brave", "new", "world",
  "breathe", "peace", "justice", "matter", "needle", "liberty",
];

const TOTAL        = factorial(12);   // 479,001,600
const MEMORY_FILE  = "checkpoint.json";
const MATCH_FILE   = "match.txt";
const LOG_EVERY    = 100_000;

// ── Parse optional CLI range ───────────────────────────────────────────────
const cliStart = process.argv[2] ? BigInt(process.argv[2]) : null;
const cliEnd   = process.argv[3] ? BigInt(process.argv[3]) : null;

// ── Load or init checkpoint ────────────────────────────────────────────────
let checkpoint = loadCheckpoint();

const startIdx = cliStart ?? checkpoint.index;
const endIdx   = cliEnd   ?? BigInt(TOTAL);

console.log(`\n🔐 Target address : ${TARGET_ADDRESS}`);
console.log(`📖 Words          : ${WORDS.join(", ")}`);
console.log(`📊 Total perms    : ${TOTAL.toLocaleString()}`);
console.log(`▶️  Start index    : ${startIdx.toLocaleString()}`);
console.log(`⏹️  End index      : ${endIdx.toLocaleString()}`);
console.log(`📍 Range size     : ${(endIdx - startIdx).toLocaleString()}`);
console.log(`\n🔍 Scanning...\n`);

// ── Main scan ──────────────────────────────────────────────────────────────
let checked  = 0;
let valid    = 0;
let matched  = 0;
const startTime = Date.now();

for (let i = startIdx; i < endIdx; i++) {
  const perm   = nthPermutation(WORDS, i);
  const phrase = perm.join(" ");

  // BIP39 checksum validation
  if (!bip39.validateMnemonic(phrase)) {
    checked++;
    maybeLog(i, checked, valid, matched, startIdx, endIdx, startTime);
    continue;
  }

  valid++;

  // Derive BTC address
  const address = deriveAddress(phrase);

  if (address === TARGET_ADDRESS) {
    matched++;
    const msg = `\n🎯 MATCH FOUND!\nPhrase : ${phrase}\nAddress: ${address}\nIndex  : ${i}\n`;
    console.log(msg);
    writeFileSync(MATCH_FILE, msg, "utf8");
  }

  checked++;
  maybeLog(i, checked, valid, matched, startIdx, endIdx, startTime);
}

// Final checkpoint save
saveCheckpoint(endIdx);

const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
console.log(`\n\n${"=".repeat(60)}`);
console.log(`✅ Done in ${elapsed}s`);
console.log(`   Checked : ${checked.toLocaleString()}`);
console.log(`   Valid   : ${valid.toLocaleString()}`);
console.log(`   Matched : ${matched}`);
console.log(matched > 0
  ? `   Result  → ${MATCH_FILE}`
  : `   No match found in this range.`
);

// ── Logging + checkpoint ───────────────────────────────────────────────────
function maybeLog(i, checked, valid, matched, startIdx, endIdx, startTime) {
  if (checked % LOG_EVERY !== 0) return;
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  const rangeSize = Number(endIdx - startIdx);
  const pct = ((checked / rangeSize) * 100).toFixed(2);
  process.stdout.write(
    `\r   [${i}] Checked: ${checked.toLocaleString()} | Valid: ${valid} | Matched: ${matched} | ${pct}% | ${elapsed}s`
  );
  // Save checkpoint every LOG_EVERY steps
  saveCheckpoint(i);
}

function saveCheckpoint(index) {
  writeFileSync(MEMORY_FILE, JSON.stringify({ index: index.toString() }), "utf8");
}

function loadCheckpoint() {
  if (existsSync(MEMORY_FILE)) {
    try {
      const data = JSON.parse(readFileSync(MEMORY_FILE, "utf8"));
      const idx  = BigInt(data.index);
      console.log(`\n📌 Resuming from checkpoint: index ${idx.toLocaleString()}`);
      return { index: idx };
    } catch {
      console.log(`\n⚠️  Corrupt checkpoint — starting from 0`);
    }
  }
  return { index: 0n };
}

// ── nth permutation (Factoradic / Lehmer code) ────────────────────────────
// Returns the permutation at position n (0-based) without iterating all prior
function nthPermutation(arr, n) {
  arr = arr.slice();
  const result = [];
  let remaining = BigInt(n);
  for (let i = arr.length; i > 0; i--) {
    const fact = BigInt(factorial(i - 1));
    const idx  = Number(remaining / fact);
    result.push(arr.splice(idx, 1)[0]);
    remaining %= fact;
  }
  return result;
}

// ── BTC address derivation (BIP44 m/44'/0'/0'/0/0) ───────────────────────
function deriveAddress(mnemonic) {
  const seed    = bip39.mnemonicToSeedSync(mnemonic);
  const root    = HDKey.fromMasterSeed(seed);
  const child   = root.derive("m/44'/0'/0'/0/0");
  const pubKey  = child.publicKey;
  return pubKeyToP2PKH(pubKey);
}

function pubKeyToP2PKH(pubKey) {
  // SHA256 → RIPEMD160
  const sha    = sha256(pubKey);
  const hash160 = ripemd160(sha);

  // Version byte 0x00 for mainnet
  const versioned = new Uint8Array(21);
  versioned[0] = 0x00;
  versioned.set(hash160, 1);

  // Double SHA256 checksum
  const checksum = sha256(sha256(versioned)).slice(0, 4);

  // Final payload
  const payload = new Uint8Array(25);
  payload.set(versioned);
  payload.set(checksum, 21);

  return base58Encode(payload);
}

// ── Base58 encoder ────────────────────────────────────────────────────────
const BASE58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

function base58Encode(bytes) {
  let num = BigInt("0x" + Buffer.from(bytes).toString("hex"));
  let result = "";
  while (num > 0n) {
    result = BASE58_ALPHABET[Number(num % 58n)] + result;
    num /= 58n;
  }
  for (const byte of bytes) {
    if (byte === 0) result = "1" + result;
    else break;
  }
  return result;
}

// ── Helpers ───────────────────────────────────────────────────────────────
function factorial(n) {
  let r = 1n;
  for (let i = 2n; i <= BigInt(n); i++) r *= i;
  return r;
}
