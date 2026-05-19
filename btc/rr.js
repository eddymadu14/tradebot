const HEX = "0123456789abcdef".split("");

const RULES = {
  "0": 3,
  "1": 3,
  default: 2
};

const MIN_LETTERS = 4;

function isLetter(c) {
  return c >= "a" && c <= "f";
}

function isValid(str) {
  let letterCount = 0;

  for (let i = 0; i < str.length; i++) {
    const c = str[i];

    if (isLetter(c)) letterCount++;

    // repetition check
    let count = 1;
    while (i + 1 < str.length && str[i + 1] === c) {
      count++;
      i++;
    }

    const limit = RULES[c] ?? RULES.default;
    if (count > limit) return false;
  }

  return letterCount >= MIN_LETTERS;
}

// increment lexicographically
function nextChar(c) {
  return HEX[HEX.indexOf(c) + 1];
}

// generate next candidate
function increment(str) {
  let arr = str.split("");

  for (let i = arr.length - 1; i >= 0; i--) {
    let idx = HEX.indexOf(arr[i]);

    if (idx < HEX.length - 1) {
      arr[i] = HEX[idx + 1];

      // reset everything after
      for (let j = i + 1; j < arr.length; j++) {
        arr[j] = "0";
      }

      return arr.join("");
    }
  }

  return "1" + arr.map(() => "0").join("");
}

function findNext(start) {
  let cur = start;

  while (true) {
    if (isValid(cur)) return cur;
    cur = increment(cur);
  }
}

// Example usage
const start =
"0000000000000000000000000000000000000000000000700000000000000000";

console.log(findNext(start));
