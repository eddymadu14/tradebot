/**
 * BTC Mnemonic Permutation Checker (N-word pool edition)
 * ────────────────────────────────────────────────────────
 * Supply ANY number of candidate words (≥12).
 * The script will:
 *   1. Validate each word is in the BIP39 wordlist
 *   2. Generate every unique 12-word COMBINATION from the pool
 *   3. For each combination, generate every 12-word PERMUTATION
 *   4. Validate BIP39 checksum and save hits to valid_mnemonics.txt
 *
 * Install deps:
 *   npm install bip39
 *
 * Run (uses built-in pool below):
 *   node mnemonic_checker.js
 *
 * Or pass your own words as CLI args:
 *   node mnemonic_checker.js word1 word2 word3 ... wordN
 */

import * as bip39 from "bip39";
import { createWriteStream } from "fs";

// ── Full candidate pool from the puzzle ────────────────────────────────────
// Duplicates are removed automatically — order doesn't matter here
const DEFAULT_CANDIDATES = [
  "breathe", "stop",    "end",     "world",   "new",     "brave",
  "matter",  "black",   "live",    "peace",   "find",    "phrase",
  "seed",    "police",  "under",   "justice", "welcome", "liberty",
  "flag",    "eye",     "clock",   "time",    "mask",    "vote",
  "book",    "free",    "raise",   "stone",   "build",   "degree",
  "needle",  "cry",     "call",    "ask",
];

// ── CLI args override the default pool ────────────────────────────────────
const raw = process.argv.length > 2
  ? process.argv.slice(2)
  : DEFAULT_CANDIDATES;

const PHRASE_LEN = 12;

// ── Validate every word against BIP39 wordlist ────────────────────────────
const wordlist = bip39.wordlists.english;
const invalid = raw.filter((w) => !wordlist.includes(w));
if (invalid.length > 0) {
  console.error(`\n⚠️  These words are NOT in the BIP39 wordlist and will be skipped:`);
  console.error(`   ${invalid.join(", ")}\n`);
}

// De-duplicate and keep only valid words
const pool = [...new Set(raw.filter((w) => wordlist.includes(w)))];

console.log(`\n✅ ${pool.length} unique valid BIP39 words in pool:`);
console.log(`   ${pool.join(", ")}\n`);

if (pool.length < PHRASE_LEN) {
  console.error(`⚠️  Need at least ${PHRASE_LEN} valid words, only have ${pool.length}. Exiting.\n`);
  process.exit(1);
}

// ── Estimate total work ────────────────────────────────────────────────────
const combCount    = combinationCount(pool.length, PHRASE_LEN);
const permPerComb  = factorial(PHRASE_LEN);           // 479,001,600
const totalChecks  = combCount * permPerComb;

console.log(`📊 Pool size           : ${pool.length} words`);
console.log(`📊 12-word combinations: ${combCount.toLocaleString()}`);
console.log(`📊 Permutations / combo: ${permPerComb.toLocaleString()}`);
console.log(`📊 Total checks        : ${totalChecks.toLocaleString()}`);
console.log(`\n   ⏱  This may take a long time. Valid finds are printed in real-time.`);
console.log(`   Results are also saved to valid_mnemonics.txt\n`);
console.log(`🔍 Starting scan…\n`);

// ── Output file ───────────────────────────────────────────────────────────
const OUTPUT_FILE = "valid_mnemonics.txt";
const stream = createWriteStream(OUTPUT_FILE, { flags: "w" });
stream.write(`BIP39 Valid Mnemonics — pool: ${pool.length} words\n`);
stream.write(`Words: ${pool.join(", ")}\n`);
stream.write("=".repeat(70) + "\n\n");

let checked   = 0n;
let found     = 0;
const LOG_EVERY = 5_000_000n;
const startTime = Date.now();

// ── Main double loop: combinations → permutations ─────────────────────────
for (const combo of combinationsOf(pool, PHRASE_LEN)) {
  for (const perm of permutations(combo)) {
    const phrase = perm.join(" ");

    if (bip39.validateMnemonic(phrase)) {
      found++;
      const line = `[${found}] ${phrase}`;
      stream.write(line + "\n");
      process.stdout.write(`\n✅ VALID #${found}: ${phrase}\n\n`);
    }

    checked++;
    if (checked % LOG_EVERY === 0n) {
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      const pct     = ((Number(checked) / totalChecks) * 100).toFixed(3);
      process.stdout.write(
        `\r   Checked: ${Number(checked).toLocaleString()} | Found: ${found} | ${pct}% | ${elapsed}s elapsed   `
      );
    }
  }
}

stream.end();

const totalTime = ((Date.now() - startTime) / 1000).toFixed(1);
console.log(`\n\n${"=".repeat(70)}`);
console.log(`✅ Scan complete in ${totalTime}s`);
console.log(`   Checked : ${Number(checked).toLocaleString()}`);
console.log(`   Valid   : ${found}`);
if (found > 0) {
  console.log(`   Results → ${OUTPUT_FILE}`);
} else {
  console.log(`   No valid mnemonics found with this word pool.`);
}

// ── Generators ────────────────────────────────────────────────────────────

/**
 * Yield every r-length combination from arr (no repeats, order irrelevant).
 * Uses lexicographic index walking — O(1) memory per combination.
 */
function* combinationsOf(arr, r) {
  const n = arr.length;
  const idx = Array.from({ length: r }, (_, i) => i);
  while (true) {
    yield idx.map((i) => arr[i]);
    // Find rightmost index that can be incremented
    let i = r - 1;
    while (i >= 0 && idx[i] === i + n - r) i--;
    if (i < 0) return;
    idx[i]++;
    for (let j = i + 1; j < r; j++) idx[j] = idx[j - 1] + 1;
  }
}

/**
 * Yield every permutation of arr using Heap's algorithm.
 * Mutates a local copy — caller gets fresh slices.
 */
function* permutations(arr) {
  arr = arr.slice();
  const n = arr.length;
  const c = new Array(n).fill(0);
  yield arr.slice();
  let i = 0;
  while (i < n) {
    if (c[i] < i) {
      if (i % 2 === 0) [arr[0], arr[i]] = [arr[i], arr[0]];
      else             [arr[c[i]], arr[i]] = [arr[i], arr[c[i]]];
      yield arr.slice();
      c[i]++;
      i = 0;
    } else {
      c[i] = 0;
      i++;
    }
  }
}

// ── Math helpers ──────────────────────────────────────────────────────────
function factorial(n) {
  let r = 1;
  for (let i = 2; i <= n; i++) r *= i;
  return r;
}

function combinationCount(n, r) {
  if (r > n) return 0;
  let num = 1, den = 1;
  for (let i = 0; i < r; i++) {
    num *= (n - i);
    den *= (i + 1);
  }
  return Math.round(num / den);
}
