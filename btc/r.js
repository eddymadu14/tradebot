const HEX = "0123456789abcdef".split("");

const RULES = {
  "0": 3,
  "1": 3,
};

const DEFAULT_LIMIT = 2;
const MIN_LETTERS = 4;

function isLetter(c) {
  return c >= "a" && c <= "f";
}

function validPrefix(arr) {
  let letterCount = 0;

  for (let i = 0; i < arr.length; ) {
    let c = arr[i];
    let j = i;

    while (j < arr.length && arr[j] === c) j++;

    let count = j - i;
    let limit = RULES[c] ?? DEFAULT_LIMIT;

    if (count > limit) return false;

    if (isLetter(c)) letterCount++;

    i = j;
  }

  return letterCount <= MIN_LETTERS; // prefix-safe check
}

function buildNext(start) {
  let arr = start.split("");

  for (let i = arr.length - 1; i >= 0; i--) {
    let idx = HEX.indexOf(arr[i]);

    for (let nxt = idx + 1; nxt < HEX.length; nxt++) {
      arr[i] = HEX[nxt];

      // fill suffix minimally
      for (let j = i + 1; j < arr.length; j++) {
        arr[j] = "0";
      }

      if (validPrefix(arr)) {
        // now force letters in cheapest positions
        let filled = enforceLetters(arr.slice());
        if (filled) return filled.join("");
      }
    }
  }

  return null;
}

function enforceLetters(arr) {
  let letters = 0;

  for (let i = 0; i < arr.length; i++) {
    if (isLetter(arr[i])) letters++;
  }

  let i = arr.length - 1;

  while (letters < MIN_LETTERS && i >= 0) {
    if (!isLetter(arr[i])) {
      arr[i] = "a";
      letters++;
    }
    i--;
  }

  if (letters < MIN_LETTERS) return null;

  return arr;
}

// TEST
const start =
"0000000000000000000000000000000000000000000000700000000000000000";

console.log(buildNext(start));
