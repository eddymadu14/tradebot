import {
  analyzeRange,
  bitEntropy,
  sequenceAnalysis,
  classifyPuzzle
} from "./puz.js";

// 1. RANGE
const range = analyzeRange(startHex, endHex);

// 2. ENTROPY (feed known values if you have them)
const entropy = bitEntropy([solutionHex]); // or candidates

// 3. SEQUENCE (tx values or any numeric stream)
const sequence = sequenceAnalysis([0.071, 0.639, 6.39]);

// 4. CLASSIFY
const result = classifyPuzzle({ range, entropy, sequence });

console.log(result);
