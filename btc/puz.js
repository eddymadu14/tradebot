// puzzle-analyzer-v1.mjs

// -----------------------------
// BIGINT UTIL
// -----------------------------
const toBig = (x) => BigInt(x);

// -----------------------------
// 1. RANGE ANALYSIS
// -----------------------------
export function analyzeRange(startHex, endHex) {
    const start = toBig(startHex);
    const end = toBig(endHex);

    const size = end - start;

    return {
        start: start.toString(16),
        end: end.toString(16),
        size: size.toString(),
        bitLength: size.toString(2).length,
        isPowerOfTwo: (size & (size - 1n)) === 0n,
        msbPattern: {
            startBits: start.toString(2).slice(0, 16),
            endBits: end.toString(2).slice(0, 16)
        }
    };
}

// -----------------------------
// 2. ENTROPY CHECK (bit bias)
// -----------------------------
export function bitEntropy(hexValues) {
    let bits = "";

    for (const h of hexValues) {
        bits += BigInt(h).toString(2).padStart(256, "0");
    }

    let ones = 0;
    for (let i = 0; i < bits.length; i++) {
        if (bits[i] === "1") ones++;
    }

    const p = ones / bits.length;

    return {
        totalBits: bits.length,
        onesRatio: p,
        zerosRatio: 1 - p,
        entropyHint:
            p > 0.55 || p < 0.45
                ? "BIAS DETECTED (possible structure)"
                : "near-random (likely strong entropy)"
    };
}

// -----------------------------
// 3. SEQUENCE ANALYSIS
// -----------------------------
export function sequenceAnalysis(values) {
    const nums = values.map(v => Number(v));

    const deltas = [];
    const ratios = [];

    for (let i = 1; i < nums.length; i++) {
        deltas.push(nums[i] - nums[i - 1]);
        ratios.push(nums[i] / nums[i - 1]);
    }

    const mean = (arr) => arr.reduce((a,b)=>a+b,0)/arr.length;

    const varDelta = mean(deltas.map(x => (x - mean(deltas))**2));
    const varRatio = mean(ratios.map(x => (x - mean(ratios))**2));

    return {
        deltas,
        ratios,
        deltaVariance: varDelta,
        ratioVariance: varRatio,
        patternHint:
            varDelta < 1e6
                ? "possible linear generator"
                : "no clear linear structure"
    };
}

// -----------------------------
// 4. FINAL CLASSIFIER
// -----------------------------
export function classifyPuzzle({ range, entropy, sequence }) {
    let score = 0;

    if (range.isPowerOfTwo) score += 1;
    if (entropy.entropyHint.includes("BIAS")) score += 2;
    if (sequence.patternHint.includes("linear")) score += 2;

    let verdict =
        score >= 4
            ? "LIKELY STRUCTURED (reducible)"
            : score <= 1
            ? "LIKELY RANDOM (not solvable)"
            : "UNCERTAIN (needs more data)";

    return {
        score,
        verdict
    };
}
