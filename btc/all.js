const fs = require("fs");
const axios = require("axios");
const bip39 = require("bip39");
const bitcoin = require("bitcoinjs-lib");
const { BIP32Factory } = require("bip32");
const ecc = require("tiny-secp256k1");

// Inject ECC lib into bitcoinjs
bitcoin.initEccLib(ecc);

// Create bip32 instance
const bip32 = BIP32Factory(ecc);

const MNEMONIC_FILE = "mnemonics.txt";
const OUTPUT_FILE = "rich_wallets.txt";
const NETWORK = bitcoin.networks.bitcoin;

async function getBTCBalance(address) {
  try {
    const url = `https://blockstream.info/api/address/${address}`;
    const res = await axios.get(url);
    const balance = res.data.chain_stats.funded_txo_sum - res.data.chain_stats.spent_txo_sum;
    return balance / 1e8;
  } catch (err) {
    console.error(`Error fetching balance for ${address}: ${err.message}`);
    return 0;
  }
}

function deriveAddresses(seed) {
  const root = bip32.fromSeed(seed, NETWORK);

  const paths = {
    legacy: "m/44'/0'/0'/0/0",
    nestedSegwit: "m/49'/0'/0'/0/0",
    nativeSegwit: "m/84'/0'/0'/0/0",
    taproot: "m/86'/0'/0'/0/0"
  };

  const results = {};

  // Legacy P2PKH
  const legacyNode = root.derivePath(paths.legacy);
  results.legacy = bitcoin.payments.p2pkh({ pubkey: legacyNode.publicKey, network: NETWORK }).address;

  // Nested SegWit P2SH-P2WPKH
  const nestedNode = root.derivePath(paths.nestedSegwit);
  results.nestedSegwit = bitcoin.payments.p2sh({
    redeem: bitcoin.payments.p2wpkh({ pubkey: nestedNode.publicKey, network: NETWORK }),
    network: NETWORK
  }).address;

  // Native SegWit P2WPKH
  const segwitNode = root.derivePath(paths.nativeSegwit);
  results.nativeSegwit = bitcoin.payments.p2wpkh({ pubkey: segwitNode.publicKey, network: NETWORK }).address;

  // Taproot (P2TR)
  const taprootNode = root.derivePath(paths.taproot);
  const xOnlyPubkey = taprootNode.publicKey.slice(1, 33); // Remove the 0x02/0x03 prefix
  results.taproot = bitcoin.payments.p2tr({ internalPubkey: xOnlyPubkey, network: NETWORK }).address;

  return results;
}

async function main() {
  const mnemonics = fs.readFileSync(MNEMONIC_FILE, "utf8").split("\n").map(m => m.trim()).filter(Boolean);
  const output = [];

  for (const mnemonic of mnemonics) {
    if (!bip39.validateMnemonic(mnemonic)) {
      console.warn(`Invalid mnemonic: ${mnemonic}`);
      continue;
    }

    const seed = await bip39.mnemonicToSeed(mnemonic);
    const addresses = deriveAddresses(seed);

    let total = 0;
    let log = `Mnemonic: ${mnemonic}\n`;

    for (const [type, address] of Object.entries(addresses)) {
      const balance = await getBTCBalance(address);
      total += balance;
      log += ` - ${type}: ${address} | Balance: ${balance} BTC\n`;
    }

    if (total > 0) {
      output.push(log + "\n");
      console.log(`✔️ Found balance > 0 for mnemonic`);
    } else {
      console.log(`No balance found for mnemonic`);
    }
  }

  fs.writeFileSync(OUTPUT_FILE, output.join("\n"), "utf8");
  console.log(`✅ Completed. Check ${OUTPUT_FILE} for funded wallets.`);
}

main();
