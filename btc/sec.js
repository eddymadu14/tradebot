import crypto from "crypto";
import pkg from "elliptic";
import fs from "fs";
const { ec: EC } = pkg;
const ec = new EC("secp256k1");

const BASE58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const RESULT_FILE = "match_found.json";
const LOG_FILE    = "scan_log.txt";

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

// ---------------- ULTRA RANDOM BIGINT IN RANGE ----------------
// Uses multiple entropy sources combined to make repetition extremely unlikely
function randomBigIntInRange(min, max) {
    const range = max - min + 1n;
    const byteLength = Math.ceil(range.toString(16).length / 2) + 8; // extra bytes for better distribution

    // Mix multiple entropy sources
    const r1 = crypto.randomBytes(byteLength);
    const r2 = crypto.randomBytes(byteLength);
    const timeEntropy = Buffer.alloc(8);
    timeEntropy.writeBigInt64BE(BigInt(Date.now()) ^ BigInt(process.hrtime.bigint()));

    // XOR all entropy sources together
    const mixed = Buffer.alloc(byteLength);
    for (let i = 0; i < byteLength; i++) {
        mixed[i] = r1[i] ^ r2[i] ^ (timeEntropy[i % 8]);
    }

    const rand = BigInt("0x" + mixed.toString("hex")) % range;
    return min + rand;
}

// ---------------- FILTER 1: >2 repeating non-zero chars in private key ----------------
function privateKeyHasExcessiveRepeats(privKeyHex) {
    const withoutZeros = privKeyHex.replace(/0/g, "");
    if (withoutZeros.length === 0) return false;

    let count = 1;
    for (let i = 1; i < withoutZeros.length; i++) {
        if (withoutZeros[i] === withoutZeros[i - 1]) {
            count++;
            if (count > 2) return true;
        } else {
            count = 1;
        }
    }
    return false;
}

// ---------------- FILTER 2: >2 repeating chars in address ----------------
function addressHasExcessiveRepeats(address) {
    const body = address.slice(1); // skip leading "1" version prefix
    if (body.length === 0) return false;

    let count = 1;
    for (let i = 1; i < body.length; i++) {
        if (body[i] === body[i - 1]) {
            count++;
            if (count > 2) return true;
        } else {
            count = 1;
        }
    }
    return false;
}

// ---------------- SAVE RESULT ----------------
function saveResult(startHex, endHex, targetAddress, privKeyHex, address, checked, skipped, elapsed) {
    const result = {
        status: "MATCH FOUND",
        privateKey: privKeyHex,
        address,
        targetAddress,
        startHex,
        endHex,
        checked: checked.toString(),
        skipped: skipped.toString(),
        elapsedSeconds: elapsed,
        foundAt: new Date().toISOString(),
    };
    fs.writeFileSync(RESULT_FILE, JSON.stringify(result, null, 2));
    console.log(`\n💾 Result saved to ${RESULT_FILE}`);
}

// ---------------- APPEND TO LOG ----------------
function appendLog(message) {
    const line = `[${new Date().toISOString()}] ${message}\n`;
    fs.appendFileSync(LOG_FILE, line);
}

// ---------------- WORKER: single scan batch ----------------
// Runs a batch of N keys and returns stats — keeps the loop tight
function scanBatch(start, end, targetAddress, batchSize) {
    let checked = 0;
    let skipped = 0;

    for (let i = 0; i < batchSize; i++) {
        const candidate  = randomBigIntInRange(start, end);
        const privKeyHex = candidate.toString(16).padStart(64, "0");

        // Filter 1: private key repeat check (before expensive EC derivation)
        if (privateKeyHasExcessiveRepeats(privKeyHex)) {
            skipped++;
            continue;
        }

        // Derive address
        const address = privateKeyToLegacyAddress(privKeyHex);

        // Filter 2: address repeat check
        if (addressHasExcessiveRepeats(address)) {
            skipped++;
            continue;
        }

        checked++;

        // Match check
        if (address === targetAddress) {
            return { found: true, privKeyHex, address, checked, skipped };
        }
    }

    return { found: false, checked, skipped };
}

// ---------------- MAIN SCANNER ----------------
async function scanRange(startHex, endHex, targetAddress) {
    // Guard: check if already found
    if (fs.existsSync(RESULT_FILE)) {
        try {
            const existing = JSON.parse(fs.readFileSync(RESULT_FILE, "utf8"));
            if (existing.targetAddress === targetAddress) {
                console.log(`\n⚠️  A match for this address was already found!`);
                console.log(`   Private Key : ${existing.privateKey}`);
                console.log(`   Address     : ${existing.address}`);
                console.log(`   Found At    : ${existing.foundAt}`);
                console.log(`\n   Delete ${RESULT_FILE} to scan again.\n`);
                return existing.privateKey;
            }
        } catch {
            console.log("⚠️  Result file corrupted, ignoring.\n");
        }
    }

    const start     = BigInt("0x" + startHex);
    const end       = BigInt("0x" + endHex);
    const rangeSize = end - start + 1n;

    console.log(`\n🔍 Scanner started:`);
    console.log(`   Start   : ${startHex}`);
    console.log(`   End     : ${endHex}`);
    console.log(`   Target  : ${targetAddress}`);
    console.log(`   Range   : ${rangeSize.toLocaleString()} keys`);
    console.log(`   Mode    : Memoryless ultra-random\n`);

    appendLog(`Scan started — Target: ${targetAddress} | Range: ${startHex} → ${endHex}`);

    const startTime  = Date.now();
    const batchSize  = 500;       // keys per batch before yielding
    const logEvery   = 100000;    // log every 100k checked keys

    let totalChecked = 0;
    let totalSkipped = 0;

    while (true) {
        const result = scanBatch(start, end, targetAddress, batchSize);

        totalChecked += result.checked;
        totalSkipped += result.skipped;

        if (result.found) {
            const elapsed = ((Date.now() - startTime) / 1000).toFixed(2);
            const rate    = Math.floor(totalChecked / Number(elapsed));

            console.log(`\n✅ MATCH FOUND!`);
            console.log(`   Private Key : ${result.privKeyHex}`);
            console.log(`   Address     : ${result.address}`);
            console.log(`   Checked     : ${totalChecked.toLocaleString()} keys`);
            console.log(`   Skipped     : ${totalSkipped.toLocaleString()} keys`);
            console.log(`   Speed       : ${rate.toLocaleString()} keys/s`);
            console.log(`   Time        : ${elapsed}s`);

            saveResult(
                startHex, endHex, targetAddress,
                result.privKeyHex, result.address,
                totalChecked, totalSkipped, elapsed
            );

            appendLog(
                `MATCH FOUND — PrivKey: ${result.privKeyHex} | ` +
                `Address: ${result.address} | Checked: ${totalChecked} | Time: ${elapsed}s`
            );

            return result.privKeyHex;
        }

        // Progress log
        if (totalChecked % logEvery < batchSize) {
            const elapsed = ((Date.now() - startTime) / 1000).toFixed(2);
            const rate    = Math.floor(totalChecked / Number(elapsed));
            const logLine =
                `Checked: ${totalChecked.toLocaleString()} | ` +
                `Skipped: ${totalSkipped.toLocaleString()} | ` +
                `Speed: ${rate.toLocaleString()} keys/s`;

            console.log(`   ${logLine}`);
            appendLog(logLine);
        }

        // Yield to event loop between batches to keep process responsive
        await new Promise(resolve => setImmediate(resolve));
    }
}

// ---------------- GRACEFUL SHUTDOWN ----------------
process.on("SIGINT", () => {
    console.log("\n\n⚠️  Scan interrupted.");
    appendLog("Scan interrupted by user (SIGINT).");
    process.exit(0);
});

// ---------------- ENTRY POINT ----------------
const START_HEX  = "0000000000000000000000000000000000000000000000712a0b1c0d2e0f3a45";
const END_HEX    = "000000000000000000000000000000000000000000000071eedcba98765432fe";
const TARGET_ADR = "1PWo3JeB9jrGwfHDNpdGK54CRas7fsVzXU";

scanRange(START_HEX, END_HEX, TARGET_ADR);
