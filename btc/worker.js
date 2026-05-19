import { parentPort, workerData } from "worker_threads";
import crypto from "crypto";
import { ec as EC } from "elliptic";
import bs58check from "bs58check";
import fs from "fs";

const ec = new EC("secp256k1");

const START = BigInt(workerData.start);
const END = BigInt(workerData.end);
const ID = workerData.id;

const keyStream = fs.createWriteStream(`keys_${ID}.csv`);
const addrStream = fs.createWriteStream(`addresses_${ID}.csv`);

function privateKeyToLegacyAddress(hexKey) {
  const key = ec.keyFromPrivate(hexKey);

  const pubPoint = key.getPublic();
  const pubKey = Buffer.from(pubPoint.encode("hex", false), "hex");

  const sha = crypto.createHash("sha256").update(pubKey).digest();
  const ripemd = crypto.createHash("ripemd160").update(sha).digest();

  const payload = Buffer.concat([Buffer.from([0x00]), ripemd]);

  return bs58check.encode(payload);
}

let counter = 0;

for (let k = START; k <= END; k++) {
  const hexKey = k.toString(16).padStart(64, "0");

  const address = privateKeyToLegacyAddress(hexKey);

  keyStream.write(hexKey + "\n");
  addrStream.write(address + "\n");

  counter++;

  if (counter % 50000 === 0) {
    parentPort.postMessage({
      id: ID,
      progress: `${counter} keys processed`
    });
  }
}

keyStream.end();
addrStream.end();

parentPort.postMessage({
  id: ID,
  progress: "DONE"
});
