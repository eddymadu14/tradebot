import crypto from "crypto";
import pkg from "elliptic";
const { ec: EC } = pkg;
const ec = new EC("secp256k1");

// Base58 alphabet
const BASE58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

// ---------------- BASE58 DECODE ----------------
function base58Decode(str) {
    let num = 0n;

    for (const char of str) {
        const index = BASE58_ALPHABET.indexOf(char);
        if (index === -1) throw new Error("Invalid Base58 character: " + char);
        num = num * 58n + BigInt(index);
    }

    // Convert BigInt to hex, pad to even length
    let hex = num.toString(16);
    if (hex.length % 2 !== 0) hex = "0" + hex;

    // Count leading "1"s → leading zero bytes
    let leadingZeros = 0;
    for (const char of str) {
        if (char === "1") leadingZeros++;
        else break;
    }

    const leadingBuffer = Buffer.alloc(leadingZeros, 0);
    const restBuffer = Buffer.from(hex, "hex");
    return Buffer.concat([leadingBuffer, restBuffer]);
}

// ---------------- HASH FUNCTIONS ----------------
function sha256(data) {
    return crypto.createHash("sha256").update(data).digest();
}

function ripemd160(data) {
    return crypto.createHash("ripemd160").update(data).digest();
}

// ---------------- LEGACY ADDRESS → PUBLIC KEY HASH (decomposed) ----------------
function legacyAddressToComponents(address) {
    // 1. Base58Check decode
    const fullPayload = base58Decode(address);

    // 2. Split checksum (last 4 bytes) from versioned payload
    const versionedPayload = fullPayload.subarray(0, fullPayload.length - 4);
    const checksum = fullPayload.subarray(fullPayload.length - 4);

    // 3. Verify checksum
    const expectedChecksum = sha256(sha256(versionedPayload)).subarray(0, 4);
    if (!checksum.equals(expectedChecksum)) {
        throw new Error("Invalid address: checksum mismatch");
    }

    // 4. Split version byte (0x00) from pubKeyHash
    const versionByte = versionedPayload[0];
    const pubKeyHash = versionedPayload.subarray(1);

    return {
        versionByte,        // 0x00 for Bitcoin mainnet
        pubKeyHash,         // RIPEMD160(SHA256(publicKey)) — 20 bytes
        checksum,           // First 4 bytes of double-SHA256
        fullPayload,        // Complete decoded payload
    };
}

// ---------------- PUBLIC KEY → LEGACY ADDRESS (kept for validation) ----------------
function publicKeyToLegacyAddress(publicKey) {
    const sha = sha256(publicKey);
    const pubKeyHash = ripemd160(sha);
    const versionedPayload = Buffer.concat([Buffer.from([0x00]), pubKeyHash]);
    const checksum = sha256(sha256(versionedPayload)).subarray(0, 4);
    const fullPayload = Buffer.concat([versionedPayload, checksum]);
    return base58Encode(fullPayload);
}

function base58Encode(buffer) {
    let num = BigInt("0x" + buffer.toString("hex"));
    let result = "";
    while (num > 0n) {
        const rem = num % 58n;
        num = num / 58n;
        result = BASE58_ALPHABET[Number(rem)] + result;
    }
    for (let i = 0; i < buffer.length && buffer[i] === 0; i++) {
        result = "1" + result;
    }
    return result;
}

// ---------------- PUBLIC KEY → VALIDATE AGAINST ADDRESS ----------------
function publicKeyMatchesAddress(publicKeyHex, address) {
    const publicKey = Buffer.from(publicKeyHex, "hex");
    const derivedAddress = publicKeyToLegacyAddress(publicKey);
    return derivedAddress === address;
}

// ---------------- MAIN REVERSED FUNCTION ----------------
export function legacyAddressToPublicKeyHash(address) {
    const { versionByte, pubKeyHash, checksum } = legacyAddressToComponents(address);

    return {
        address,                            // INPUT  (was the output before)
        pubKeyHash: pubKeyHash.toString("hex"), // OUTPUT (intermediate hash recovered)
        versionByte: `0x${versionByte.toString(16).padStart(2, "0")}`,
        checksum: checksum.toString("hex"),
    };
}

// ---------------- EXAMPLE ----------------
const address = "1LoVGDgRs9hTfTNJNuXKSpywcbdvwRXpmK";
const result = legacyAddressToPublicKeyHash(address);

console.log("Input  (Legacy Address):", result.address);
console.log("Output (pubKeyHash)    :", result.pubKeyHash);
console.log("Version Byte           :", result.versionByte);
console.log("Checksum               :", result.checksum);
