// hex-add.mjs

export function addHex(a, b) {
  const numA = BigInt(`0x${a}`);
  const numB = BigInt(`0x${b}`);

  const sum = numA + numB;

  return sum.toString(16); // back to hex
}

// Example usage
const result = addHex("0000000000000000000000000000000000000000000004000000000000000000", "0000000000000000000000000000000000000000000007ffffffffffffffffff");
console.log(result); // output: 1b31
