/**
 * BTC Mnemonic Permutation Checker (N-word pool edition)
 * ────────────────────────────────────────────────────────
 * - Picks every unique 12-word COMBINATION from pool
 * - For each combo, tries every PERMUTATION
 * - Only saves mnemonics where ALL 12 words are unique (no repeats)
 * - Validates BIP39 checksum on unique-word phrases only
 *
 * Install deps:
 *   npm install bip39
 *
 * Run:
 *   node mnemonic_checker.js
 *   node mnemonic_checker.js word1 word2 ... wordN
 */

import * as bip39 from "bip39";
import { createWriteStream } from "fs";

// ── Candidate pool ─────────────────────────────────────────────────────────
const DEFAULT_CANDIDATES = [
  "breathe", "stop",    "end",     "world",   "new",     "brave",
  "matter",  "black",   "live",    "peace",   "find",    "phrase",
  "seed",    "police",  "under",   "justice", "welcome", "liberty",
  "flag",    "eye",     "clock",   "time",    "mask",    "vote",
  "book",    "free",    "raise",   "stone",   "build",   "degree",
  "needle",  "cry",     "call",    "ask",
];

const raw = process.argv.length > 2
  ? process.argv.slice(2)
  : DEFAULT_CANDIDATES;

const PHRASE_LEN = 12;

// ── Validate + de-duplicate ────────────────────────────────────────────────
const wordlist = bip39.wordlists.english;
const invalid  = raw.filter((w) => !wordlist.includes(w));
if (invalid.length > 0) {
  console.error(`\n⚠️  Not in BIP39 wordlist (skipped): ${invalid.join(", ")}\n`);
}

const pool = [...new Set(raw.filter((w) => wordlist.includes(w)))];

console.log(`\n✅ ${pool.length} unique valid BIP39 words in pool:`);
console.log(`   ${pool.join(", ")}\n`);

if (pool.length < PHRASE_LEN) {
  console.error(`⚠️  Need at least ${PHRASE_LEN} valid words, only have ${pool.length}. Exiting.\n`);
  process.exit(1);
}

// ── Since the pool itself is already de-duplicated, every combination
//    drawn from it will automatically have 12 distinct words.
//    We only need to skip permutations that repeat a word — but because
//    combinationsOf() picks r *distinct* indices, every combo is already
//    12 unique words. Heap's algorithm preserves those words, so every
//    permutation is also unique-word. No extra filter needed beyond the
//    pool de-duplication above. ─────────────────────────────────────────

const combCount   = combinationCount(pool.length, PHRASE_LEN);
const permPerComb = factorial(PHRASE_LEN);
const totalChecks = combCount * permPerComb;

console.log(`📊 Pool size           : ${pool.length} words`);
console.log(`📊 12-word combinations: ${combCount.toLocaleString()}`);
console.log(`📊 Permutations / combo: ${permPerComb.toLocaleString()}`);
console.log(`📊 Total checks        : ${totalChecks.toLocaleString()}`);
console.log(`📊 Unique-word filter  : ✅ enforced (pool is pre-deduplicated)`);
console.log(`\n   ⏱  Valid finds printed in real-time & saved to file.\n`);
console.log(`🔍 Starting scan…\n`);

// ── Output ─────────────────────────────────────────────────────────────────
const OUTPUT_FILE = "valid_mnemonics.txt";
const stream = createWriteStream(OUTPUT_FILE, { flags: "w" });
stream.write(`BIP39 Valid Mnemonics (unique words only) — pool: ${pool.length} words\n`);
stream.write(`Words: ${pool.join(", ")}\n`);
stream.write("=".repeat(70) + "\n\n");

let checked   = 0n;
let found     = 0;
const LOG_EVERY  = 5_000_000n;
const startTime  = Date.now();

// ── Main scan ──────────────────────────────────────────────────────────────
for (const combo of combinationsOf(pool, PHRASE_LEN)) {
  // Guard: all words in combo must be unique (should always be true given
  // a de-duplicated pool, but we assert it explicitly for safety)
  if (new Set(combo).size !== PHRASE_LEN) continue;

  for (const perm of permutations(combo)) {
    // Each permutation is the same 12 unique words in a different order —
    // uniqueness is already guaranteed. Validate checksum only.
    const phrase = perm.join(" ");

    if (bip39.validateMnemonic(phrase)) {
      found++;
      stream.write(`[${found}] ${phrase}\n`);
      process.stdout.write(`\n✅ VALID #${found}: ${phrase}\n\n`);
    }

    checked++;
    if (checked % LOG_EVERY === 0n) {
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      const pct     = ((Number(checked) / totalChecks) * 100).toFixed(3);
      process.stdout.write(
        `\r   Checked: ${Number(checked).toLocaleString()} | Found: ${found} | ${pct}% | ${elapsed}s   `
      );
    }
  }
}

stream.end();

const totalTime = ((Date.now() - startTime) / 1000).toFixed(1);
console.log(`\n\n${"=".repeat(70)}`);
console.log(`✅ Done in ${totalTime}s`);
console.log(`   Checked : ${Number(checked).toLocaleString()}`);
console.log(`   Valid   : ${found}`);
console.log(found > 0
  ? `   Results → ${OUTPUT_FILE}`
  : `   No valid mnemonics found.`
);

// ── Generators ────────────────────────────────────────────────────────────

/** Every r-length combination of distinct indices from arr */
function* combinationsOf(arr, r) {
  const n   = arr.length;
  const idx = Array.from({ length: r }, (_, i) => i);
  while (true) {
    yield idx.map((i) => arr[i]);
    let i = r - 1;
    while (i >= 0 && idx[i] === i + n - r) i--;
    if (i < 0) return;
    idx[i]++;
    for (let j = i + 1; j < r; j++) idx[j] = idx[j - 1] + 1;
  }
}

/** Every permutation via Heap's algorithm */
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

// ── Math ──────────────────────────────────────────────────────────────────
function factorial(n) {
  let r = 1;
  for (let i = 2; i <= n; i++) r *= i;
  return r;
}

function combinationCount(n, r) {
  if (r > n) return 0;
  let num = 1, den = 1;
  for (let i = 0; i < r; i++) { num *= (n - i); den *= (i + 1); }
  return Math.round(num / den);
}
