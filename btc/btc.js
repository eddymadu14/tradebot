const fs = require("fs");
const axios = require("axios");
const bip39 = require("bip39");
const bitcoin = require("bitcoinjs-lib");

const MNEMONIC_FILE = "mnemonics.txt";
const OUTPUT_FILE = "rich_wallets.txt";
const DERIVATION_PATH = "m/44'/0'/0'/0/0"; // Legacy BTC address path

async function getBTCBalance(address) {
  try {
    const url = `https://blockstream.info/api/address/${address}`;
    const res = await axios.get(url);
    const balance = res.data.chain_stats.funded_txo_sum - res.data.chain_stats.spent_txo_sum;
    return balance / 1e8; // Convert from satoshi to BTC
  } catch (error) {
    console.error(`Error fetching balance for ${address}: ${error.message}`);
    return 0;
  }
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
    const root = bitcoin.bip32.fromSeed(seed);
    const child = root.derivePath(DERIVATION_PATH);
    const { address } = bitcoin.payments.p2pkh({ pubkey: child.publicKey });

    const balance = await getBTCBalance(address);
    console.log(`Address: ${address} | Balance: ${balance} BTC`);

    if (balance > 0) {
      output.push(`Mnemonic: ${mnemonic}\nAddress: ${address}\nBalance: ${balance} BTC\n`);
    }
  }

  fs.writeFileSync(OUTPUT_FILE, output.join("\n"), "utf8");
  console.log(`Done. Saved wallets with balance > 0 to ${OUTPUT_FILE}`);
}

main();
