/**
 * BTC Mnemonic Permutation Checker
 * Takes 12 candidate words and finds all valid BIP39 mnemonics
 * Uses bip39 library for validation (checksum verification)
 *
 * Install deps first:
 *   npm install bip39
 *
 * Run:
 *   node mnemonic_checker.js
 */

import * as bip39 from "bip39";
import { createWriteStream } from "fs";

// ── 12 strong candidate words from the puzzle ──────────────────────────────
const CANDIDATES = [
  "brave",
  "new",
  "world",
  "breathe",
  "liberty",
  "justice",
  "peace",
  "needle",
  "find",
  "seed",
  "phrase",
  "matter",
];

// ── Validate every word is in the BIP39 wordlist ───────────────────────────
const wordlist = bip39.wordlists.english;
const invalid = CANDIDATES.filter((w) => !wordlist.includes(w));
if (invalid.length > 0) {
  console.error(
    `\n⚠️  These words are NOT in the BIP39 wordlist: ${invalid.join(", ")}`
  );
  console.error("Remove or replace them before continuing.\n");
  process.exit(1);
}
console.log("✅ All 12 words confirmed in BIP39 wordlist.\n");

// ── Permutation generator (Heap's algorithm — no array copies) ────────────
function* permutations(arr) {
  const n = arr.length;
  const c = new Array(n).fill(0);
  yield arr.slice();
  let i = 0;
  while (i < n) {
    if (c[i] < i) {
      if (i % 2 === 0) {
        [arr[0], arr[i]] = [arr[i], arr[0]];
      } else {
        [arr[c[i]], arr[i]] = [arr[i], arr[c[i]]];
      }
      yield arr.slice();
      c[i]++;
      i = 0;
    } else {
      c[i] = 0;
      i++;
    }
  }
}

// ── Main scan ──────────────────────────────────────────────────────────────
const TOTAL = factorial(12); // 479,001,600
console.log(`🔍 Scanning ${TOTAL.toLocaleString()} permutations…`);
console.log("   (Valid ones are rare — only ~1 in 256 pass the checksum)\n");

const OUTPUT_FILE = "valid_mnemonics.txt";
const stream = createWriteStream(OUTPUT_FILE, { flags: "w" });
stream.write("Valid BIP39 Mnemonics Found\n");
stream.write("=".repeat(60) + "\n\n");

let checked = 0;
let found = 0;
const LOG_EVERY = 5_000_000;
const startTime = Date.now();

for (const perm of permutations(CANDIDATES.slice())) {
  const phrase = perm.join(" ");

  if (bip39.validateMnemonic(phrase)) {
    found++;
    const line = `[${found}] ${phrase}\n`;
    stream.write(line);
    process.stdout.write(`\n✅ VALID MNEMONIC FOUND: ${phrase}\n\n`);
  }

  checked++;
  if (checked % LOG_EVERY === 0) {
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    const pct = ((checked / TOTAL) * 100).toFixed(2);
    process.stdout.write(
      `\r   Progress: ${checked.toLocaleString()} / ${TOTAL.toLocaleString()} (${pct}%) | Found: ${found} | ${elapsed}s elapsed`
    );
  }
}

stream.end();

const totalTime = ((Date.now() - startTime) / 1000).toFixed(1);
console.log(`\n\n${"=".repeat(60)}`);
console.log(`✅ Scan complete in ${totalTime}s`);
console.log(`   Checked : ${checked.toLocaleString()}`);
console.log(`   Valid   : ${found}`);
console.log(
  found > 0
    ? `   Results saved to → ${OUTPUT_FILE}`
    : `   No valid mnemonics found with these 12 words.`
);

// ── Helper ─────────────────────────────────────────────────────────────────
function factorial(n) {
  let r = BigInt(1);
  for (let i = 2n; i <= BigInt(n); i++) r *= i;
  return Number(r);
}
