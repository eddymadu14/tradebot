// run.mjs

import {
  analyzeRange,
  bitEntropy,
  sequenceAnalysis,
  classifyPuzzle
} from "./puzzle-analyzer-v1.mjs";

// -----------------------------
// DEFINE PUZZLE HERE
// -----------------------------
const startHex = "0x400000000000000000000000000000000000000000000000";
const endHex   = "0x7fffffffffffffffffffffffffffffffffffffffffffffff";

// optional: tx / sequence data
const txValues = [0.071, 0.639, 6.39];

// -----------------------------
// PIPELINE
// -----------------------------
const range = analyzeRange(startHex, endHex);
const entropy = bitEntropy([]); // no key samples yet
const sequence = sequenceAnalysis(txValues);

const result = classifyPuzzle({
  range,
  entropy,
  sequence
});

console.log(range);
console.log(sequence);
console.log(result);
