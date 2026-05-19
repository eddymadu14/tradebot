const BASE = 16n;

// normalize to MAX length of END (IMPORTANT)
function getLen(n1, n2) {
    return Math.max(n1.toString(16).length, n2.toString(16).length);
}

function toHexArray(n, len) {
    let h = n.toString(16).padStart(len, "0");
    return h.split("").map(c => parseInt(c, 16));
}

let memo = new Map();

function dp(pos, last, run, tight, leadingZero, digits) {
    if (pos === digits.length) return 1n;

    const key = `${pos}|${last}|${run}|${tight}|${leadingZero}`;
    if (!tight && memo.has(key)) return memo.get(key);

    let limit = tight ? digits[pos] : 15;
    let res = 0n;

    for (let d = 0; d <= limit; d++) {
        let newLeading = leadingZero && d === 0;

        let newLast = last;
        let newRun = run;

        if (newLeading) {
            newLast = -1;
            newRun = 0;
        } else {
            if (d === last) {
                newRun = run + 1;
            } else {
                newRun = 1;
                newLast = d;
            }

            if (newRun >= 3) continue;
        }

        res += dp(
            pos + 1,
            newLast,
            newRun,
            tight && d === limit,
            newLeading,
            digits
        );
    }

    if (!tight) memo.set(key, res);
    return res;
}

function countValid(n, len) {
    memo.clear();
    const digits = toHexArray(n, len);
    return dp(0, -1, 0, true, true, digits);
}

function rangeCount(start, end) {
    const len = getLen(start, end);
    return countValid(end, len) - countValid(start - 1n, len);
}

// ---------------- INPUT ----------------
const START = BigInt("0x0000000000000000000000000000000000000000000000400000000000000000");
const END   = BigInt("0x00000000000000000000000000000000000000000000007fffffffffffffffff");

console.log("Result:", rangeCount(START, END).toString());
