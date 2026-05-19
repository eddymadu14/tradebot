import crypto from "crypto";
import pkg from "elliptic";
import fs from "fs";
const { ec: EC } = pkg;
const ec = new EC("secp256k1");

const BASE58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const PROGRESS_FILE = "scanner_progress.json";
const RESULT_FILE   = "match_found.json";
const PROGRESS_VERSION = "3";

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

// ---------------- RANDOM BIGINT IN RANGE ----------------
function randomBigIntInRange(min, max) {
    const range = max - min + 1n;
    const byteLength = Math.ceil(range.toString(16).length / 2);
    let rand;
    do {
        const randBytes = crypto.randomBytes(byteLength);
        rand = BigInt("0x" + randBytes.toString("hex"));
    } while (rand >= range);
    return min + rand;
}

// ---------------- SKIP FILTER: >2 repeating digits/letters in private key (zeros ignored) ----------------
function hasExcessiveRepeats(privKeyHex) {
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

// ---------------- SAVE RESULT ----------------
function saveResult(startHex, endHex, targetAddress, privKeyHex, address, checked, skipped, elapsed) {
    const result = {
        version: PROGRESS_VERSION,
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

// ---------------- PROGRESS MEMORY ----------------
function loadProgress(startHex, endHex, targetAddress) {
    if (fs.existsSync(PROGRESS_FILE)) {
        try {
            const data = JSON.parse(fs.readFileSync(PROGRESS_FILE, "utf8"));
            if (
                data.version === PROGRESS_VERSION &&
                data.startHex === startHex &&
                data.endHex === endHex &&
                data.targetAddress === targetAddress
            ) {
                console.log(`\n📂 Resuming previous session:`);
                console.log(`   Already checked : ${BigInt(data.checked).toLocaleString()} keys`);
                console.log(`   Already skipped : ${BigInt(data.skipped).toLocaleString()} keys`);
                console.log(`   Visited keys    : ${data.visited.length.toLocaleString()} stored\n`);
                return {
                    checked: BigInt(data.checked),
                    skipped: BigInt(data.skipped),
                    visited: new Set(data.visited),
                };
            } else {
                console.log(`\n📂 Incompatible or different session detected, starting fresh.\n`);
            }
        } catch {
            console.log("⚠️  Progress file corrupted, starting fresh.\n");
        }
    }
    return { checked: 0n, skipped: 0n, visited: new Set() };
}

function saveProgress(startHex, endHex, targetAddress, checked, skipped, visited) {
    const data = {
        version: PROGRESS_VERSION,
        startHex,
        endHex,
        targetAddress,
        checked: checked.toString(),
        skipped: skipped.toString(),
        visited: [...visited],
        savedAt: new Date().toISOString(),
    };
    fs.writeFileSync(PROGRESS_FILE, JSON.stringify(data, null, 2));
}

// ---------------- RANGE SCANNER ----------------
async function scanRange(startHex, endHex, targetAddress) {
    // Guard: check if a result was already found in a previous run
    if (fs.existsSync(RESULT_FILE)) {
        try {
            const existing = JSON.parse(fs.readFileSync(RESULT_FILE, "utf8"));
            if (existing.targetAddress === targetAddress) {
                console.log(`\n⚠️  A match for this address was already found in a previous run!`);
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

    const start = BigInt("0x" + startHex);
    const end   = BigInt("0x" + endHex);
    const rangeSize = end - start + 1n;

    // Load memory from previous session if available
    let { checked, skipped, visited } = loadProgress(startHex, endHex, targetAddress);

    console.log(`\n🔍 Scanner started:`);
    console.log(`   Start   : ${startHex}`);
    console.log(`   End     : ${endHex}`);
    console.log(`   Target  : ${targetAddress}`);
    console.log(`   Range   : ${rangeSize.toLocaleString()} keys`);
    console.log(`   Version : ${PROGRESS_VERSION}\n`);

    const startTime  = Date.now();
    const saveEvery  = 5000n;
    const logEvery   = 10000n;

    while (true) {
        // Stop if entire range has been visited
        if (visited.size >= Number(rangeSize)) {
            console.log(`\n🏁 Entire range exhausted after ${checked.toLocaleString()} checks.`);
            console.log(`   No match found for: ${targetAddress}`);
            saveProgress(startHex, endHex, targetAddress, checked, skipped, visited);
            break;
        }

        // Pick a random unvisited key in range
        let privKeyHex;
        let candidate;
        do {
            candidate = randomBigIntInRange(start, end);
            privKeyHex = candidate.toString(16).padStart(64, "0");
        } while (visited.has(privKeyHex));

        // Mark as visited immediately
        visited.add(privKeyHex);

        // Filter: skip private keys with >2 consecutive repeating non-zero chars
        if (hasExcessiveRepeats(privKeyHex)) {
            skipped++;
            continue;
        }

        // Derive legacy address only if key passed the filter
        const address = privateKeyToLegacyAddress(privKeyHex);
        checked++;

        // Check for match
        if (address === targetAddress) {
            const elapsed = ((Date.now() - startTime) / 1000).toFixed(2);

            console.log(`\n✅ MATCH FOUND!`);
            console.log(`   Private Key : ${privKeyHex}`);
            console.log(`   Address     : ${address}`);
            console.log(`   Checked     : ${checked.toLocaleString()} keys`);
            console.log(`   Skipped     : ${skipped.toLocaleString()} keys`);
            console.log(`   Time        : ${elapsed}s`);

            // Save result to file before deleting progress
            saveResult(startHex, endHex, targetAddress, privKeyHex, address, checked, skipped, elapsed);

            // Only delete progress after result is safely saved
            if (fs.existsSync(PROGRESS_FILE)) fs.unlinkSync(PROGRESS_FILE);
            console.log(`   Progress file cleared.\n`);

            return privKeyHex;
        }

        // Progress log every 10,000 checked keys
        if (checked % logEvery === 0n) {
            const elapsed = ((Date.now() - startTime) / 1000).toFixed(2);
            const rate    = Math.floor(Number(checked) / Number(elapsed));
            console.log(
                `   Checked: ${checked.toLocaleString()} | ` +
                `Skipped: ${skipped.toLocaleString()} | ` +
                `Speed: ${rate.toLocaleString()} keys/s | ` +
                `Visited: ${visited.size.toLocaleString()}`
            );
        }

        // Save progress every 5,000 checked keys
        if (checked % saveEvery === 0n) {
            saveProgress(startHex, endHex, targetAddress, checked, skipped, visited);
        }

        // Yield to event loop every 1,000 iterations to prevent blocking
        if ((checked + skipped) % 1000n === 0n) {
            await new Promise(resolve => setImmediate(resolve));
        }
    }

    return null;
}

// ---------------- GRACEFUL SHUTDOWN ----------------
process.on("SIGINT", () => {
    console.log("\n\n⚠️  Interrupted! Progress has been auto-saved to scanner_progress.json");
    console.log("   Restart the script to resume from where you left off.\n");
    process.exit(0);
});

// ---------------- ENTRY POINT ----------------
const START_HEX  = "0000000000000000000000000000000000000000000000400000000000000000";
const END_HEX    = "00000000000000000000000000000000000000000000007fffffffffffffffff";
const TARGET_ADR = "1PWo3JeB9jrGwfHDNpdGK54CRas7fsVzXU";

scanRange(START_HEX, END_HEX, TARGET_ADR);
