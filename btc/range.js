const START = BigInt("0000000000000000000000000000000000000000000000400000000000000000");
const END   = BigInt("0x00000000000000000000000000000000000000000000007fffffffffffffffff");

// total keys = end - start + 1
const totalKeys = END - START + 1n;

console.log("Start (hex):", START.toString(16));
console.log("End (hex):", END.toString(16));
console.log("Total keys:", totalKeys.toString());
