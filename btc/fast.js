// ultra_scanner.mjs
//
// HIGH-PERFORMANCE BTC LEGACY ADDRESS SCANNER
//
// UPGRADES IMPLEMENTED:
// ✅ Native secp256k1 bindings
// ✅ Native bs58 encoder
// ✅ Worker thread parallelism
// ✅ Sequential scanning
// ✅ No visited set
// ✅ Minimal allocations
// ✅ Buffer-based private key generation
// ✅ Fast progress tracking
// ✅ Optimized logging
// ✅ Core-scaled architecture
// ✅ ES MODULE
//
// INSTALL:
//
// npm install secp256k1 bs58
//
// RUN:
//
// node ultra_scanner.mjs
//

import os from "os";
import fs from "fs";
import crypto from "crypto";
import bs58 from "bs58";
import secp256k1 from "secp256k1";

import {
    Worker,
    isMainThread,
    parentPort,
    workerData
} from "worker_threads";

// ============================================================
// CONFIG
// ============================================================

const TARGET_ADDRESS =
    "1PWo3JeB9jrGwfHDNpdGK54CRas7fsVzXU";

const START_HEX =
    "0000000000000000000000000000000000000000000000400000000000000000";

const END_HEX =
    "00000000000000000000000000000000000000000000007fffffffffffffffff";
const THREADS = Math.max(1, os.cpus()?.length || 1);
const SAVE_FILE = "fast_progress.json";
const RESULT_FILE = "match_found.json";

// ============================================================
// FAST ADDRESS GENERATION
// ============================================================

function privateKeyToAddress(privKeyBuffer) {

    const publicKey =
        secp256k1.publicKeyCreate(privKeyBuffer, true);

    const sha =
        crypto
            .createHash("sha256")
            .update(publicKey)
            .digest();

    const ripe =
        crypto
            .createHash("ripemd160")
            .update(sha)
            .digest();

    const payload = Buffer.allocUnsafe(25);

    payload[0] = 0x00;

    ripe.copy(payload, 1);

    const checksum =
        crypto
            .createHash("sha256")
            .update(
                crypto
                    .createHash("sha256")
                    .update(payload.subarray(0, 21))
                    .digest()
            )
            .digest();

    checksum.copy(payload, 21, 0, 4);

    return bs58.encode(payload);
}

// ============================================================
// FAST FILTER
// ============================================================

function hasTripleRepeats(str) {

    let count = 1;
    let prev = str.charCodeAt(0);

    for (let i = 1; i < str.length; i++) {

        const cur = str.charCodeAt(i);

        if (cur === prev) {

            count++;

            if (count > 2)
                return true;

        } else {

            count = 1;
            prev = cur;
        }
    }

    return false;
}

// ============================================================
// BIGINT → BUFFER
// ============================================================

function bigintToBuffer(num) {

    const hex =
        num.toString(16).padStart(64, "0");

    return Buffer.from(hex, "hex");
}

// ============================================================
// SAVE RESULT
// ============================================================

function saveResult(data) {

    fs.writeFileSync(
        RESULT_FILE,
        JSON.stringify(data, null, 2)
    );
}

// ============================================================
// SAVE PROGRESS
// ============================================================

function saveProgress(progress) {

    fs.writeFileSync(
        SAVE_FILE,
        JSON.stringify(progress)
    );
}

// ============================================================
// WORKER LOGIC
// ============================================================

async function runWorker() {

    const {
        workerId,
        start,
        end,
        target
    } = workerData;

    let checked = 0n;
    let skipped = 0n;

    let current = BigInt(start);
    const max = BigInt(end);

    const startTime = Date.now();

    while (current <= max) {

        const privKeyBuffer =
            bigintToBuffer(current);

        // FAST VALIDITY CHECK
        if (!secp256k1.privateKeyVerify(privKeyBuffer)) {

            current++;
            skipped++;
            continue;
        }

        const privHex =
            privKeyBuffer.toString("hex");

        // PRIVATE KEY FILTER
        if (hasTripleRepeats(privHex)) {

            current++;
            skipped++;
            continue;
        }

        const address =
            privateKeyToAddress(privKeyBuffer);

        // ADDRESS FILTER
        if (hasTripleRepeats(address)) {

            current++;
            skipped++;
            continue;
        }

        checked++;

        // MATCH
        if (address === target) {

            const elapsed =
                ((Date.now() - startTime) / 1000).toFixed(2);

            const result = {

                status: "MATCH FOUND",

                workerId,

                privateKey: privHex,

                address,

                checked: checked.toString(),

                skipped: skipped.toString(),

                elapsedSeconds: elapsed,

                foundAt: new Date().toISOString()
            };

            saveResult(result);

            console.log("\n✅ MATCH FOUND\n");

            console.log(result);

            process.exit(0);
        }

        // LOGGING
        if (checked % 100000n === 0n) {

            const elapsed =
                (Date.now() - startTime) / 1000;

            const rate =
                Math.floor(
                    Number(checked) / elapsed
                );

            console.log(

                `Worker ${workerId} | ` +
                `Checked: ${checked.toLocaleString()} | ` +
                `Skipped: ${skipped.toLocaleString()} | ` +
                `Speed: ${rate.toLocaleString()} keys/s`
            );

            parentPort.postMessage({

                workerId,

                checked: checked.toString(),

                skipped: skipped.toString(),

                current: current.toString()
            });
        }

        current++;
    }

    console.log(`Worker ${workerId} finished range.`);
}

// ============================================================
// MAIN THREAD
// ============================================================

if (isMainThread) {

    const START = BigInt("0x" + START_HEX);
    const END = BigInt("0x" + END_HEX);

    const RANGE = END - START + 1n;

    const chunk =
        RANGE / BigInt(THREADS);

    console.log("\n🚀 ULTRA SCANNER STARTED\n");

    console.log(`Threads : ${THREADS}`);
    console.log(`Range   : ${RANGE.toLocaleString()}`);
    console.log(`Target  : ${TARGET_ADDRESS}\n`);

    for (let i = 0; i < THREADS; i++) {

        const workerStart =
            START + (chunk * BigInt(i));

        const workerEnd =
            i === THREADS - 1
                ? END
                : workerStart + chunk - 1n;

        const worker = new Worker(

            new URL(import.meta.url),

            {
                workerData: {

                    workerId: i + 1,

                    start: workerStart.toString(),

                    end: workerEnd.toString(),

                    target: TARGET_ADDRESS
                }
            }
        );

        worker.on("message", (msg) => {

            saveProgress(msg);
        });

        worker.on("error", (err) => {

            console.error(

                `Worker ${i + 1} crashed:`,

                err
            );
        });

        worker.on("exit", (code) => {

            if (code !== 0) {

                console.log(
                    `Worker ${i + 1} exited with code ${code}`
                );
            }
        });
    }

} else {

    runWorker();
}
