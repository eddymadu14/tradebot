import WebSocket from "ws";

const ws = new WebSocket(
  "wss://fstream.binance.com/ws/btcusdt@markPrice@1s"
);

ws.on("open", () => {
  console.log("OPEN");
});

ws.on("message", (data) => {
  console.log(data.toString());
});

ws.on("error", (err) => {
  console.log("ERROR:", err.message);
});

ws.on("close", (code, reason) => {
  console.log("CLOSE:", code, reason.toString());
});
