// ultra_scanner.mjs
//
// HIGH PERFORMANCE BTC LEGACY ADDRESS SCANNER
//
// INSTALL
// =====================================
// npm install @noble/secp256k1 bs58
//
// RUN
// =====================================
// node ultra_scanner.mjs
//

import os from "os";
import fs from "fs";
import crypto from "crypto";
import bs58 from "bs58";

import * as secp256k1 from "@noble/secp256k1";

import {
    Worker,
    isMainThread,
    parentPort,
    workerData
} from "worker_threads";

// ======================================================
// CONFIG
// ======================================================

const TARGET_ADDRESS =
    "1PWo3JeB9jrGwfHDNpdGK54CRas7fsVzXU";

const START_HEX =
    "0000000000000000000000000000000000000000000000400000000000000000";

const END_HEX =
    "00000000000000000000000000000000000000000000007fffffffffffffffff";

const THREADS =
    Math.max(1, os.cpus()?.length || 1);

const RESULT_FILE =
    "match_found.json";

// ======================================================
// FAST ADDRESS GENERATION
// ======================================================

function privateKeyToAddress(privKeyBuffer) {

    const publicKey =
        secp256k1.getPublicKey(privKeyBuffer, true);

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

    const payload =
        Buffer.allocUnsafe(25);

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

// ======================================================
// FAST REPEAT FILTER
// ======================================================

function hasTripleRepeats(str) {

    let count = 1;

    let prev =
        str.charCodeAt(0);

    for (let i = 1; i < str.length; i++) {

        const cur =
            str.charCodeAt(i);

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

// ======================================================
// BIGINT → 32 BYTE BUFFER
// ======================================================

function bigintToBuffer(num) {

    const hex =
        num
            .toString(16)
            .padStart(64, "0");

    return Buffer.from(hex, "hex");
}

// ======================================================
// SAVE RESULT
// ======================================================

function saveResult(result) {

    fs.writeFileSync(
        RESULT_FILE,
        JSON.stringify(result, null, 2)
    );
}

// ======================================================
// WORKER
// ======================================================

async function runWorker() {

    const {
        workerId,
        start,
        end,
        target
    } = workerData;

    let checked = 0n;
    let skipped = 0n;

    let current =
        BigInt(start);

    const max =
        BigInt(end);

    const startedAt =
        Date.now();

    while (current <= max) {

        const privKeyBuffer =
            bigintToBuffer(current);

        // VALIDITY CHECK

        if (
            !secp256k1.isValidPrivateKey(
                privKeyBuffer
            )
        ) {
            skipped++;
            current++;
            continue;
        }

        const privHex =
            privKeyBuffer.toString("hex");

        // PRIVATE KEY FILTER

        if (hasTripleRepeats(privHex)) {

            skipped++;
            current++;
            continue;
        }

        const address =
            privateKeyToAddress(
                privKeyBuffer
            );

        // ADDRESS FILTER

        if (hasTripleRepeats(address)) {

            skipped++;
            current++;
            continue;
        }

        checked++;

        // MATCH FOUND

        if (address === target) {

            const elapsed =
                (
                    (Date.now() - startedAt)
                    / 1000
                ).toFixed(2);

            const result = {

                status: "MATCH FOUND",

                workerId,

                privateKey: privHex,

                address,

                checked:
                    checked.toString(),

                skipped:
                    skipped.toString(),

                elapsedSeconds:
                    elapsed,

                foundAt:
                    new Date().toISOString()
            };

            saveResult(result);

            console.log("\n\n✅ MATCH FOUND\n");

            console.log(result);

            process.exit(0);
        }

        // SEND STATS

        if (
            (checked + skipped)
            % 100000n === 0n
        ) {

            parentPort.postMessage({

                workerId,

                checked:
                    checked.toString(),

                skipped:
                    skipped.toString(),

                current:
                    current.toString()
            });
        }

        current++;
    }

    parentPort.postMessage({

        workerId,

        finished: true
    });
}

// ======================================================
// MAIN THREAD
// ======================================================

if (isMainThread) {

    const START =
        BigInt("0x" + START_HEX);

    const END =
        BigInt("0x" + END_HEX);

    const RANGE =
        END - START + 1n;

    const CHUNK =
        RANGE / BigInt(THREADS);

    console.log("\n🚀 ULTRA SCANNER STARTED\n");

    console.log(
        `Threads : ${THREADS}`
    );

    console.log(
        `Range   : ${RANGE.toLocaleString()}`
    );

    console.log(
        `Target  : ${TARGET_ADDRESS}\n`
    );

    const stats = {};

    let finishedWorkers = 0;

    const globalStart =
        Date.now();

    // ==========================================
    // SPAWN WORKERS
    // ==========================================

    for (let i = 0; i < THREADS; i++) {

        const workerStart =
            START +
            (
                CHUNK * BigInt(i)
            );

        const workerEnd =
            i === THREADS - 1
                ? END
                : workerStart + CHUNK - 1n;

        stats[i + 1] = {

            checked: 0n,

            skipped: 0n,

            current: workerStart
        };

        const worker =
            new Worker(
                new URL(import.meta.url),
                {
                    workerData: {

                        workerId: i + 1,

                        start:
                            workerStart.toString(),

                        end:
                            workerEnd.toString(),

                        target:
                            TARGET_ADDRESS
                    }
                }
            );

        worker.on("message", (msg) => {

            if (msg.finished) {

                finishedWorkers++;

                if (
                    finishedWorkers
                    === THREADS
                ) {

                    console.log(
                        "\n\n🏁 RANGE COMPLETED"
                    );

                    process.exit(0);
                }

                return;
            }

            stats[msg.workerId] = {

                checked:
                    BigInt(msg.checked),

                skipped:
                    BigInt(msg.skipped),

                current:
                    BigInt(msg.current)
            };
        });

        worker.on("error", (err) => {

            console.error(
                `\nWorker ${i + 1} crashed:\n`,
                err
            );
        });
    }

    // ==========================================
    // LIVE PROGRESS BAR
    // ==========================================

    setInterval(() => {

        let totalChecked = 0n;
        let totalSkipped = 0n;

        for (const id in stats) {

            totalChecked +=
                stats[id].checked;

            totalSkipped +=
                stats[id].skipped;
        }

        const processed =
            totalChecked +
            totalSkipped;

        const elapsed =
            (
                Date.now()
                - globalStart
            ) / 1000;

        const speed =
            Math.floor(
                Number(processed)
                / elapsed
            );

        const percent =
            Number(
                processed
                * 10000n
                / RANGE
            ) / 100;

        const remaining =
            RANGE - processed;

        const etaSeconds =
            speed > 0
                ? Number(remaining)
                    / speed
                : 0;

        const etaMinutes =
            (
                etaSeconds / 60
            ).toFixed(2);

        // BAR

        const width = 30;

        const filled =
            Math.floor(
                (percent / 100)
                * width
            );

        const bar =
            "█".repeat(filled)
            +
            "-".repeat(
                width - filled
            );

        process.stdout.write(

            "\r" +

            `[${bar}] ` +

            `${percent.toFixed(2)}% | ` +

            `Checked: ${totalChecked.toLocaleString()} | ` +

            `Skipped: ${totalSkipped.toLocaleString()} | ` +

            `Speed: ${speed.toLocaleString()} keys/s | ` +

            `ETA: ${etaMinutes}m`
        );

    }, 1000);

} else {

    runWorker();
}
