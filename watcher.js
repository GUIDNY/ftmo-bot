// Watches MT5 events file and sends to Railway bot
require("dotenv").config();
const fs = require("fs");
const axios = require("axios");

const MT5_FILES = "/Users/idanguindy/Library/Application Support/net.metaquotes.wine.metatrader5/drive_c/Program Files/MetaTrader 5/MQL5/Files/ftmo_events.txt";
const BOT_URL = "https://endearing-vitality-production-5bfb.up.railway.app";
const API_KEY = "ftmo_bridge_2024";
const PHONE = "972547701899";

let lastContent = "";
const sentEvents = new Set(); // dedup in-process

async function sendEvent(event) {
  const endpoint = {
    trade_opened: "/api/mt5/trade-opened",
    trade_closed: "/api/mt5/trade-closed",
    ftmo_alert:   "/api/mt5/alert",
  }[event.event];

  if (!endpoint) return;

  // Dedup — never send same event+ticket twice
  const key = `${event.event}_${event.ticket}_${event.pair}`;
  if (sentEvents.has(key)) {
    console.log(`[DEDUP] Skipped: ${key}`);
    return;
  }
  sentEvents.add(key);
  // Auto-clear after 60s
  setTimeout(() => sentEvents.delete(key), 60000);

  try {
    await axios.post(BOT_URL + endpoint, { ...event, key: API_KEY, phone: PHONE });
    console.log(`[${new Date().toLocaleTimeString("he-IL")}] ✅ Sent: ${event.event} ${event.pair || ""}`);
  } catch (e) {
    console.error("Send error:", e.message);
  }
}

function checkFile() {
  try {
    if (!fs.existsSync(MT5_FILES)) return;
    const content = fs.readFileSync(MT5_FILES, "utf8").trim();
    if (!content || content === lastContent) return;

    lastContent = content;
    const event = JSON.parse(content);
    sendEvent(event);

    // Clear file after reading
    fs.writeFileSync(MT5_FILES, "");
    lastContent = "";
  } catch (e) {
    // ignore parse errors
  }
}

console.log("👀 Watching MT5 events...");
console.log("File:", MT5_FILES);
setInterval(checkFile, 2000);
