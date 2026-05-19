import crypto from "crypto";
import pkg from "elliptic";
const { ec: EC } = pkg;
const ec = new EC("secp256k1");

// Base58 alphabet
const BASE58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

// ---------------- BASE58 ENCODE ----------------
function base58Encode(buffer) {
    let num = BigInt("0x" + buffer.toString("hex"));
    let result = "";

    while (num > 0n) {
        const rem = num % 58n;
        num = num / 58n;
        result = BASE58_ALPHABET[Number(rem)] + result;
    }

    // leading zero bytes → "1"
    for (let i = 0; i < buffer.length && buffer[i] === 0; i++) {
        result = "1" + result;
    }

    return result;
}

// ---------------- HASH FUNCTIONS ----------------
function sha256(data) {
    return crypto.createHash("sha256").update(data).digest();
}

function ripemd160(data) {
    return crypto.createHash("ripemd160").update(data).digest();
}

// ---------------- PRIVATE KEY → PUBLIC KEY ----------------
function privateKeyToPublicKey(privateKeyHex, compressed = true) {
    const keyPair = ec.keyFromPrivate(privateKeyHex);
    const pubPoint = keyPair.getPublic();

    if (compressed) {
        return Buffer.from(pubPoint.encodeCompressed());
    } else {
        return Buffer.from(pubPoint.encode("hex", false), "hex");
    }
}

// ---------------- PUBLIC KEY → LEGACY ADDRESS ----------------
function publicKeyToLegacyAddress(publicKey) {
    // 1. SHA256
    const sha = sha256(publicKey);

    // 2. RIPEMD160
    const pubKeyHash = ripemd160(sha);

    // 3. Add version byte (0x00 for Bitcoin mainnet)
    const versionedPayload = Buffer.concat([
        Buffer.from([0x00]),
        pubKeyHash
    ]);

    // 4. Double SHA256 for checksum
    const checksum = sha256(sha256(versionedPayload)).subarray(0, 4);

    // 5. Final payload
    const fullPayload = Buffer.concat([
        versionedPayload,
        checksum
    ]);

    // 6. Base58Check encode
    return base58Encode(fullPayload);
}

// ---------------- MAIN FUNCTION ----------------
export function privateKeyToLegacyAddress(privateKeyHex) {
    const publicKey = privateKeyToPublicKey(privateKeyHex, true);
    return publicKeyToLegacyAddress(publicKey);
}

// ---------------- EXAMPLE ----------------
const privKey = "000000000000000000000000000000001c533b6bb7f0804e09960225e44877ac";
console.log("Legacy Address:", privateKeyToLegacyAddress(privKey));
