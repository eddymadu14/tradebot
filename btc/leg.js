import crypto from "crypto";
import pkg from "elliptic";
const { ec: EC } = pkg;
const ec = new EC("secp256k1");

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

// ---------------- PRIVATE KEY → ADDRESS ----------------
function privateKeyToLegacyAddress(privateKeyHex) {
    const keyPair = ec.keyFromPrivate(privateKeyHex);
    const pubPoint = keyPair.getPublic();
    const publicKey = Buffer.from(pubPoint.encodeCompressed());

    const sha = sha256(publicKey);
    const pubKeyHash = ripemd160(sha);
    const versionedPayload = Buffer.concat([Buffer.from([0x00]), pubKeyHash]);
    const checksum = sha256(sha256(versionedPayload)).subarray(0, 4);
    const fullPayload = Buffer.concat([versionedPayload, checksum]);

    return base58Encode(fullPayload);
}

// ---------------- RANGE SCANNER ----------------
async function scanRange(startHex, endHex, targetAddress) {
    let current = BigInt("0x" + startHex);
    const end = BigInt("0x" + endHex);
    const total = end - current + 1n;

    console.log(`\n🔍 Scanning range:`);
    console.log(`   Start : ${startHex}`);
    console.log(`   End   : ${endHex}`);
    console.log(`   Target: ${targetAddress}`);
    console.log(`   Total keys to scan: ${total.toLocaleString()}\n`);

    let count = 0n;
    const startTime = Date.now();
    const logEvery = 10000n;

    while (current <= end) {
        // Pad private key to 64 hex chars
        const privKeyHex = current.toString(16).padStart(64, "0");
        const address = privateKeyToLegacyAddress(privKeyHex);

        if (address === targetAddress) {
            const elapsed = ((Date.now() - startTime) / 1000).toFixed(2);
            console.log(`\n✅ MATCH FOUND!`);
            console.log(`   Private Key : ${privKeyHex}`);
            console.log(`   Address     : ${address}`);
            console.log(`   Checked     : ${count.toLocaleString()} keys`);
            console.log(`   Time        : ${elapsed}s`);
            return privKeyHex;
        }

        count++;
        current++;

        // Progress log every 10,000 keys
        if (count % logEvery === 0n) {
            const elapsed = ((Date.now() - startTime) / 1000).toFixed(2);
            const rate = Math.floor(Number(count) / Number(elapsed));
            const remaining = total - count;
            const eta = (Number(remaining) / rate).toFixed(0);
            console.log(
                `   Checked: ${count.toLocaleString()} | ` +
                `Speed: ${rate.toLocaleString()} keys/s | ` +
                `ETA: ${eta}s`
            );
        }

        // Yield to event loop every 1000 iterations to avoid blocking
        if (count % 1000n === 0n) {
            await new Promise(resolve => setImmediate(resolve));
        }
    }

    console.log(`\n❌ No match found after scanning ${count.toLocaleString()} keys.`);
    return null;
}

// ---------------- EXAMPLE ----------------
const START_HEX  = "0000000000000000000000000000000000000000000000000000000000000001";
const END_HEX    = "000000000000000000000000000000000000000000000000000000ffffffffff";
const TARGET_ADR = "1LoVGDgRs9hTfTNJNuXKSpywcbdvwRXpmK";

scanRange(START_HEX, END_HEX, TARGET_ADR);
