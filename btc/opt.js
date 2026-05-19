// ============================================================
// main.js  —  entry point
// ============================================================
import crypto from "crypto";
import fs from "fs";
import os from "os";
import { Worker, isMainThread, parentPort, workerData } from "worker_threads";
import { fileURLToPath } from "url";

const RESULT_FILE  = "match_found.json";
const NUM_WORKERS  = os.cpus().length; // one worker per CPU core
const BATCH_SIZE   = 1000;             // keys per batch per worker
const LOG_EVERY    = 500000;           // print stats every 500k checked

// ---------------- MAIN THREAD ----------------
if (isMainThread) {
    const START_HEX  = "0000000000000000000000000000000000000000000000000000000000000001";
    const END_HEX    = "000000000000000000000000000000000000000000000000000000ffffffffff";
    const TARGET_ADR = "1LoVGDgRs9hTfTNJNuXKSpywcbdvwRXpmK";

    // Guard: already found
    if (fs.existsSync(RESULT_FILE)) {
        try {
            const existing = JSON.parse(fs.readFileSync(RESULT_FILE, "utf8"));
            if (existing.targetAddress === TARGET_ADR) {
                console.log(`\n⚠️  Match already found in a previous run!`);
                console.log(`   Private Key : ${existing.privateKey}`);
                console.log(`   Address     : ${existing.address}`);
                console.log(`   Found At    : ${existing.foundAt}`);
                console.log(`\n   Delete ${RESULT_FILE} to scan again.\n`);
                process.exit(0);
            }
        } catch {
            console.log("⚠️  Result file corrupted, ignoring.\n");
        }
    }

    console.log(`\n🔍 Scanner started`);
    console.log(`   Target   : ${TARGET_ADR}`);
    console.log(`   Start    : ${START_HEX}`);
    console.log(`   End      : ${END_HEX}`);
    console.log(`   Workers  : ${NUM_WORKERS} (one per CPU core)`);
    console.log(`   Batch    : ${BATCH_SIZE.toLocaleString()} keys/batch/worker\n`);

    const startTime    = Date.now();
    let totalChecked   = 0;
    let totalSkipped   = 0;
    let done           = false;

    // Spawn one worker per CPU core
    for (let i = 0; i < NUM_WORKERS; i++) {
        const worker = new Worker(fileURLToPath(import.meta.url), {
            workerData: {
                startHex:      START_HEX,
                endHex:        END_HEX,
                targetAddress: TARGET_ADR,
                batchSize:     BATCH_SIZE,
                workerId:      i,
            },
        });

        worker.on("message", (msg) => {
            if (done) return;

            if (msg.type === "stats") {
                totalChecked += msg.checked;
                totalSkipped += msg.skipped;

                if (totalChecked % LOG_EVERY < BATCH_SIZE * NUM_WORKERS) {
                    const elapsed = ((Date.now() - startTime) / 1000).toFixed(2);
                    const rate    = Math.floor(totalChecked / Number(elapsed));
                    console.log(
                        `   Checked: ${totalChecked.toLocaleString()} | ` +
                        `Skipped: ${totalSkipped.toLocaleString()} | ` +
                        `Speed: ${rate.toLocaleString()} keys/s`
                    );
                }
            }

            if (msg.type === "found") {
                done = true;
                const elapsed = ((Date.now() - startTime) / 1000).toFixed(2);
                const rate    = Math.floor(totalChecked / Number(elapsed));

                console.log(`\n✅ MATCH FOUND! (Worker ${msg.workerId})`);
                console.log(`   Private Key : ${msg.privKeyHex}`);
                console.log(`   Address     : ${msg.address}`);
                console.log(`   Checked     : ${totalChecked.toLocaleString()} keys`);
                console.log(`   Skipped     : ${totalSkipped.toLocaleString()} keys`);
                console.log(`   Speed       : ${rate.toLocaleString()} keys/s`);
                console.log(`   Time        : ${elapsed}s`);

                // Save result
                const result = {
                    status:         "MATCH FOUND",
                    privateKey:     msg.privKeyHex,
                    address:        msg.address,
                    targetAddress:  TARGET_ADR,
                    startHex:       START_HEX,
                    endHex:         END_HEX,
                    checked:        totalChecked.toString(),
                    skipped:        totalSkipped.toString(),
                    elapsedSeconds: elapsed,
                    workerId:       msg.workerId,
                    foundAt:        new Date().toISOString(),
                };
                fs.writeFileSync(RESULT_FILE, JSON.stringify(result, null, 2));
                console.log(`\n💾 Result saved to ${RESULT_FILE}\n`);

                process.exit(0);
            }
        });

        worker.on("error", (err) => {
            console.error(`❌ Worker ${i} error:`, err.message);
        });

        worker.on("exit", (code) => {
            if (code !== 0 && !done) {
                console.error(`⚠️  Worker ${i} exited with code ${code}`);
            }
        });
    }

    // Graceful shutdown
    process.on("SIGINT", () => {
        console.log(`\n\n⚠️  Scan interrupted by user.`);
        process.exit(0);
    });
}

// ============================================================
// WORKER THREAD  —  same file, different branch
// ============================================================
if (!isMainThread) {
    const { createHash } = await import("crypto");
    const { ec: EC }     = (await import("elliptic")).default;
    const ec             = new EC("secp256k1");

    const { startHex, endHex, targetAddress, batchSize, workerId } = workerData;

    const BASE58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

    // Pre-allocate reusable buffers to reduce GC pressure
    const VERSION_BYTE = Buffer.from([0x00]);

    // ---------------- BASE58 ENCODE ----------------
    function base58Encode(buffer) {
        let num    = BigInt("0x" + buffer.toString("hex"));
        let result = "";
        while (num > 0n) {
            const rem = num % 58n;
            num       = num / 58n;
            result    = BASE58_ALPHABET[Number(rem)] + result;
        }
        for (let i = 0; i < buffer.length && buffer[i] === 0; i++) {
            result = "1" + result;
        }
        return result;
    }

    // ---------------- HASH FUNCTIONS ----------------
    function sha256(data) {
        return createHash("sha256").update(data).digest();
    }

    function ripemd160(data) {
        return createHash("ripemd160").update(data).digest();
    }

    // ---------------- PRIVATE KEY → ADDRESS ----------------
    function privateKeyToLegacyAddress(privateKeyHex) {
        const keyPair   = ec.keyFromPrivate(privateKeyHex);
        const pubPoint  = keyPair.getPublic();
        const publicKey = Buffer.from(pubPoint.encodeCompressed());

        const sha             = sha256(publicKey);
        const pubKeyHash      = ripemd160(sha);
        const versionedPayload = Buffer.concat([VERSION_BYTE, pubKeyHash]);
        const checksum        = sha256(sha256(versionedPayload)).subarray(0, 4);
        const fullPayload     = Buffer.concat([versionedPayload, checksum]);

        return base58Encode(fullPayload);
    }

    // ---------------- ULTRA RANDOM BIGINT IN RANGE ----------------
    function randomBigIntInRange(min, range) {
        const byteLength = Math.ceil(range.toString(16).length / 2) + 4;

        // Mix two random buffers with high-resolution time entropy
        const r1   = crypto.randomBytes(byteLength);
        const r2   = crypto.randomBytes(byteLength);
        const time = process.hrtime.bigint();

        const mixed = Buffer.alloc(byteLength);
        for (let i = 0; i < byteLength; i++) {
            mixed[i] = r1[i] ^ r2[i] ^ Number((time >> BigInt(i % 64)) & 0xFFn);
        }

        return min + (BigInt("0x" + mixed.toString("hex")) % range);
    }

    // ---------------- FILTER 1: private key repeats (zeros ignored) ----------------
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

    // ---------------- FILTER 2: address repeats ----------------
    function addressHasExcessiveRepeats(address) {
        const body = address.slice(1);
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

    // ---------------- WORKER SCAN LOOP ----------------
    const start = BigInt("0x" + startHex);
    const end   = BigInt("0x" + endHex);
    const range = end - start + 1n;

    while (true) {
        let checked = 0;
        let skipped = 0;

        for (let i = 0; i < batchSize; i++) {
            const candidate  = randomBigIntInRange(start, range);
            const privKeyHex = candidate.toString(16).padStart(64, "0");

            // Filter 1: private key repeat check
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
                parentPort.postMessage({
                    type:       "found",
                    privKeyHex,
                    address,
                    workerId,
                });
                process.exit(0);
            }
        }

        // Report batch stats to main thread
        parentPort.postMessage({ type: "stats", checked, skipped });
    }
}
