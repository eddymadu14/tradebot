import readline from "readline";

// Terminal input interface
const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
});

function ask(question) {
    return new Promise(resolve => rl.question(question, resolve));
}

async function main() {
    console.log("=== PROP TRADING POSITION SIZE CALCULATOR ===\n");

    const account = parseFloat(await ask("Account size ($): "));
    const riskPercent = parseFloat(await ask("Risk % per trade (e.g. 0.5): "));
    const entryPrice = parseFloat(await ask("Entry price of asset ($): "));
    const stopPrice = parseFloat(await ask("Stop-loss price ($): "));

    // Calculate stop-loss distance automatically
    const slDistance = Math.abs(entryPrice - stopPrice);

    if(slDistance === 0) {
        console.log("Stop-loss distance cannot be 0!");
        rl.close();
        return;
    }

    // Dollar risk
    const dollarRisk = account * (riskPercent / 100);

    // Position size
    const positionSize = dollarRisk / slDistance;

    console.log("\n===== RESULT =====");
    console.log("Account Size:", account);
    console.log("Risk %:", riskPercent + "%");
    console.log("Dollar Risk:", dollarRisk.toFixed(2));
    console.log("Entry Price:", entryPrice);
    console.log("Stop-Loss Price:", stopPrice);
    console.log("Stop-Loss Distance:", slDistance.toFixed(2));
    console.log("Position Size:", positionSize.toFixed(4));
    console.log("==================\n");

    rl.close();
}

main();
