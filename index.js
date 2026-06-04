require("dotenv").config();
const express = require("express");
const axios = require("axios");
const fs = require("fs");
const path = require("path");
const { randomUUID } = require("crypto");

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

const { WHATSAPP_TOKEN, PHONE_NUMBER_ID, VERIFY_TOKEN, GEMINI_KEY, PORT = 3001 } = process.env;
const JOURNAL_FILE = path.join(__dirname, "data/journal.json");

// ─── Journal ──────────────────────────────────────────────────────────────────
function loadJournal() {
  try { return JSON.parse(fs.readFileSync(JOURNAL_FILE, "utf8")); }
  catch { return { trades: [] }; }
}
function saveJournal(data) {
  try { fs.writeFileSync(JOURNAL_FILE, JSON.stringify(data, null, 2)); }
  catch (e) { console.error("Save error:", e.message); }
}

// ─── WhatsApp ─────────────────────────────────────────────────────────────────
async function send(to, text) {
  try {
    await axios.post(
      `https://graph.facebook.com/v25.0/${PHONE_NUMBER_ID}/messages`,
      { messaging_product: "whatsapp", to, type: "text", text: { body: text } },
      { headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}`, "Content-Type": "application/json" } }
    );
  } catch (e) { console.error("Send error:", e.response?.data?.error?.message || e.message); }
}

// ─── Session state ────────────────────────────────────────────────────────────
const sessions = {};
function getState(from) { return sessions[from] || { step: "idle" }; }

// ─── Checklist flow ───────────────────────────────────────────────────────────
const CHECKLIST_STEPS = [
  { key: "pair",        q: "1️⃣ איזה זוג?\n(למשל EUR/USD, XAUUSD, NAS100)" },
  { key: "trend",       q: "2️⃣ מה המגמה ב-Daily?\n(ענה: *עולה* / *יורד* / *לא ברור*)" },
  { key: "sr",          q: "3️⃣ יש רמת תמיכה/התנגדות חזקה ליד המחיר?\n(ענה: *כן* / *לא*)" },
  { key: "candle",      q: "4️⃣ יש אישור נר? (פין-בר, Engulfing שנסגר?)\n(ענה: *כן* / *לא*)" },
  { key: "entry",       q: "5️⃣ מחיר כניסה?" },
  { key: "sl",          q: "6️⃣ מחיר סטופ לוס?" },
  { key: "tp",          q: "7️⃣ מחיר טייק פרופיט?" },
  { key: "accountSize", q: "8️⃣ גודל החשבון בדולרים?" },
];

function parseNum(text) {
  const n = parseFloat(text.replace(/[, ]/g, ""));
  return isNaN(n) ? null : n;
}

async function handleChecklist(from, state, text) {
  const stepIdx = parseInt(state.step.replace("cl_", ""));
  const stepDef = CHECKLIST_STEPS[stepIdx];
  const answers = state.answers;

  // ── Validate each step ──
  if (stepDef.key === "trend") {
    if (!/עולה|יורד|לא ברור|up|down|unclear/i.test(text)) {
      return send(from, "לא הבנתי. ענה: *עולה* / *יורד* / *לא ברור*");
    }
    if (/לא ברור|unclear/i.test(text)) {
      saveFailedTrade(from, answers, "🛑 אל תיכנס. אין מגמה ברורה ב-Daily. חכה לבהירות.");
      sessions[from] = { step: "idle" };
      return send(from, "🛑 *אל תיכנס.*\nאין מגמה ברורה ב-Daily. חכה לבהירות.");
    }
    answers.trend = /עולה|up/i.test(text) ? "עולה" : "יורד";
  }

  else if (stepDef.key === "sr") {
    if (!/כן|לא|yes|no/i.test(text)) return send(from, "ענה *כן* או *לא*");
    if (/לא|no/i.test(text)) {
      saveFailedTrade(from, answers, "🛑 אין רמת S/R חזקה");
      sessions[from] = { step: "idle" };
      return send(from, "🛑 *אל תיכנס.*\nאין רמת תמיכה/התנגדות חזקה לעבוד מולה.");
    }
    answers.sr = "כן";
  }

  else if (stepDef.key === "candle") {
    if (!/כן|לא|yes|no/i.test(text)) return send(from, "ענה *כן* או *לא*");
    if (/לא|no/i.test(text)) {
      saveFailedTrade(from, answers, "🛑 אין אישור נר");
      sessions[from] = { step: "idle" };
      return send(from, "🛑 *אל תיכנס.*\nחכה לנר אישור — אל תנחש.");
    }
    answers.candle = "כן";
  }

  else if (["entry", "sl", "tp", "accountSize"].includes(stepDef.key)) {
    const n = parseNum(text);
    if (!n) return send(from, `לא הבנתי. שלח מספר בלבד:`);
    answers[stepDef.key] = n;
  }

  else {
    answers[stepDef.key] = text.trim();
  }

  const nextIdx = stepIdx + 1;

  if (nextIdx < CHECKLIST_STEPS.length) {
    sessions[from] = { step: `cl_${nextIdx}`, answers };
    return send(from, `✓\n\n${CHECKLIST_STEPS[nextIdx].q}`);
  }

  // ── All answers collected — calculate ──
  const { entry, sl, tp, accountSize, pair, trend } = answers;
  const slDist = Math.abs(entry - sl);
  const tpDist = Math.abs(tp - entry);
  const rr = tpDist / slDist;
  const riskPct = (slDist / entry) * 100;
  const riskDollars = (riskPct / 100) * accountSize;

  let warnings = [];
  if (rr < 2) warnings.push(`⚠️ יחס R:R הוא 1:${rr.toFixed(1)} — מומלץ לפחות 1:2. שקול לדחות.`);
  if (riskPct > 2) warnings.push(`🚨 אתה מסכן ${riskPct.toFixed(1)}% מהחשבון ($${riskDollars.toFixed(0)})! מקסימום מומלץ 2%. הקטן פוזיציה.`);

  const tradeId = randomUUID();
  const journal = loadJournal();
  journal.trades.push({
    id: tradeId,
    date: new Date().toISOString(),
    pair, trend,
    entry, sl, tp,
    accountSize,
    rr: parseFloat(rr.toFixed(2)),
    riskPct: parseFloat(riskPct.toFixed(2)),
    riskDollars: parseFloat(riskDollars.toFixed(2)),
    checklistPassed: true,
    result: null,
    lesson: null,
  });
  saveJournal(journal);

  sessions[from] = { step: "idle", lastTradeId: tradeId };

  const direction = trend === "עולה" ? "📈 לונג" : "📉 שורט";

  if (warnings.length > 0) {
    return send(from,
      `📊 *ניתוח הסטאפ:*\n\n` +
      `זוג: ${pair} | כיוון: ${direction}\n` +
      `כניסה: ${entry} | SL: ${sl} | TP: ${tp}\n` +
      `יחס R:R: 1:${rr.toFixed(1)}\n` +
      `סיכון: ${riskPct.toFixed(2)}% ($${riskDollars.toFixed(0)})\n\n` +
      warnings.join("\n")
    );
  }

  return send(from,
    `✅ *הסטאפ עומד בכל התנאים!*\n\n` +
    `זוג: *${pair}* | כיוון: ${direction}\n` +
    `כניסה: ${entry} | SL: ${sl} | TP: ${tp}\n\n` +
    `📊 R:R = 1:${rr.toFixed(1)}\n` +
    `💰 סיכון: ${riskPct.toFixed(2)}% ($${riskDollars.toFixed(0)})\n\n` +
    `_כנס בזהירות. הקפד על הסטופ. אל תזיז._`
  );
}

function saveFailedTrade(from, answers, reason) {
  const journal = loadJournal();
  journal.trades.push({
    id: randomUUID(),
    date: new Date().toISOString(),
    pair: answers.pair || "לא ידוע",
    trend: answers.trend || null,
    checklistPassed: false,
    failReason: reason,
    result: null,
  });
  saveJournal(journal);
}

// ─── Summary ──────────────────────────────────────────────────────────────────
function buildSummary() {
  const { trades } = loadJournal();
  if (!trades.length) return "אין עסקות ביומן עדיין.";

  const completed = trades.filter(t => t.result != null);
  const wins = completed.filter(t => t.result > 0).length;
  const losses = completed.filter(t => t.result < 0).length;
  const total = completed.reduce((s, t) => s + (t.result || 0), 0);
  const winRate = completed.length ? ((wins / completed.length) * 100).toFixed(0) : 0;
  const best = completed.sort((a, b) => b.result - a.result)[0];
  const worst = completed.sort((a, b) => a.result - b.result)[0];

  const passed = trades.filter(t => t.checklistPassed).length;
  const rejected = trades.filter(t => !t.checklistPassed).length;

  return (
    `📓 *סיכום יומן מסחר*\n\n` +
    `סה"כ עסקות שנרשמו: ${trades.length}\n` +
    `✅ עברו צ'קליסט: ${passed}\n` +
    `🛑 נדחו: ${rejected}\n\n` +
    `📊 *עסקות שנסגרו:* ${completed.length}\n` +
    `🏆 ניצחונות: ${wins} | 💔 הפסדים: ${losses}\n` +
    `📈 Win Rate: ${winRate}%\n` +
    `💵 רווח/הפסד מצטבר: ${total >= 0 ? "+" : ""}$${total.toFixed(0)}\n` +
    (best ? `\n🥇 הכי טוב: +$${best.result}\n😔 הכי גרוע: $${worst?.result}` : "")
  );
}

// ─── Main handler ─────────────────────────────────────────────────────────────
async function handleMessage(from, text) {
  const state = getState(from);
  const t = text.trim();

  // ── Active checklist ──
  if (state.step.startsWith("cl_")) {
    return handleChecklist(from, state, t);
  }

  // ── Closure flow ──
  if (state.step === "closure_result") {
    const amount = parseFloat(t.replace(/[^\d.\-\+]/g, ""));
    if (isNaN(amount)) return send(from, "שלח סכום בדולרים (למשל: +120 או -85)");
    sessions[from] = { step: "closure_lesson", result: amount, lastTradeId: state.lastTradeId };
    return send(from, `רשמתי ${amount >= 0 ? "רווח" : "הפסד"} של $${Math.abs(amount)}.\n\n📝 מה למדת מהעסקה הזו?`);
  }

  if (state.step === "closure_lesson") {
    const journal = loadJournal();
    const trade = state.lastTradeId
      ? journal.trades.find(t => t.id === state.lastTradeId)
      : journal.trades.filter(t => t.result == null).pop();

    if (trade) {
      trade.result = state.result;
      trade.lesson = t;
      trade.closedAt = new Date().toISOString();
      saveJournal(journal);
    }
    sessions[from] = { step: "idle" };
    const emoji = state.result >= 0 ? "🏆" : "💪";
    return send(from,
      `${emoji} *נשמר ביומן!*\n\n` +
      `תוצאה: ${state.result >= 0 ? "+" : ""}$${state.result}\n` +
      `לקח: _${t}_\n\n` +
      (state.result < 0 ? "הפסד הוא חלק מהמשחק — ההבדל הוא שאתה לומד ממנו. 📈" : "כל כבוד! שמור על הפוקוס.")
    );
  }

  // ── Commands ──
  if (/עסקה חדשה|new trade|צ'קליסט/i.test(t)) {
    sessions[from] = { step: "cl_0", answers: {} };
    return send(from,
      `📋 *צ'קליסט עסקה חדשה*\n\n` +
      `אני אשאל אותך 8 שאלות אחת-אחת.\n` +
      `תהיה כנה — הבוט שומר עליך מעצמך.\n\n` +
      CHECKLIST_STEPS[0].q
    );
  }

  if (/^סגירה|^סגור|^close/i.test(t)) {
    const lastTrade = getState(from).lastTradeId;
    sessions[from] = { step: "closure_result", lastTradeId: lastTrade };
    return send(from, "מה הייתה התוצאה?\nשלח סכום בדולרים (למשל: *+150* או *-80*)");
  }

  if (/^סיכום|^stats|^summary/i.test(t)) {
    return send(from, buildSummary());
  }

  if (/^כללים|^rules/i.test(t)) {
    return send(from,
      `⚔️ *כללי הברזל שלך:*\n\n` +
      `1️⃣ מקסימום *2%* סיכון לעסקה\n` +
      `2️⃣ מקסימום *3 עסקאות* ביום\n` +
      `3️⃣ יחס R:R מינימלי *1:2*\n` +
      `4️⃣ *אסור* לסחור סביב חדשות אדומות\n` +
      `5️⃣ לסחור רק בין *10:00–19:00* שעון ישראל\n\n` +
      `_הכללים לא מיועדים לצ'ים טובים — הם מיועדים לימים רעים._`
    );
  }

  if (/^עזרה|^help|^מה/i.test(t)) {
    return send(from,
      `👋 *פקודות זמינות:*\n\n` +
      `📋 *עסקה חדשה* — מתחיל צ'קליסט\n` +
      `🔒 *סגירה* — רושם תוצאה לעסקה\n` +
      `📊 *סיכום* — סטטיסטיקות\n` +
      `⚔️ *כללים* — כללי הברזל שלך\n\n` +
      `_אני לא מנתח גרפים ולא נותן המלצות._`
    );
  }

  // Default
  return send(from,
    `שלח *עסקה חדשה* להתחיל צ'קליסט.\n` +
    `שלח *עזרה* לרשימת פקודות.\n\n` +
    `_אני כאן כדי לשמור עליך מעצמך — לא לסחור בשבילך._`
  );
}

// ─── Gemini Vision (chart analysis) ────────────────────────────────────────────
async function askGeminiVision(base64, mimeType) {
  try {
    const res = await axios.post(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_KEY}`,
      {
        contents: [{
          parts: [
            { inline_data: { mime_type: mimeType, data: base64 } },
            { text: `אתה סוחר בפורקס. קרא את הגרף הזה וחלץ מידע.
החזר JSON בדיוק כזה (ללא markdown):
{"pair":"זוג/חוזה","trend":"עולה או יורד","support":"רמת תמיכה","resistance":"רמת התנגדות","entry":"כניסה משוערת","sl":"סטופ לוס משוער","tp":"טייק פרופיט משוער","timeframe":"timeframe של הגרף"}
אם לא סוגריך לקרוא את הגרף: {"error":"לא הצלחתי לקרוא את הגרף"}` }
          ]
        }]
      }
    );
    const raw = res.data.candidates?.[0]?.content?.parts?.[0]?.text || "{}";
    console.log("Gemini response:", raw);
    return JSON.parse(raw.replace(/```json\n?|\n?```/g, "").trim());
  } catch (e) {
    console.error("Gemini Vision error:", e.message);
    return { error: "בעיה בניתוח הגרף" };
  }
}

async function handleImage(from, mediaId) {
  // Send immediate acknowledgment so user knows bot is working
  await send(from, "🔍 מנתח את הגרף... רגע אחד");

  try {
    // 1. Get media URL
    const mediaRes = await axios.get(
      `https://graph.facebook.com/v25.0/${mediaId}`,
      { headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}` } }
    );
    const mediaUrl = mediaRes.data.url;

    // 2. Download as base64
    const imgRes = await axios.get(mediaUrl, {
      responseType: "arraybuffer",
      headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}` }
    });
    const base64 = Buffer.from(imgRes.data).toString("base64");
    const mimeType = imgRes.headers["content-type"] || "image/jpeg";

    // 3. Analyze with Gemini Vision
    const analysis = await askGeminiVision(base64, mimeType);

    if (analysis.error) {
      return send(from, `❌ ${analysis.error}\n\nשלח *עסקה חדשה* להתחיל צ'קליסט ידני.`);
    }

    // 4. Pre-fill checklist with analysis
    sessions[from] = {
      step: "cl_0",
      answers: {
        pair: analysis.pair || "לא ידוע",
        trend: /עול|up/i.test(analysis.trend) ? "עולה" : "יורד",
      },
      suggestedEntry: analysis.entry,
      suggestedSl: analysis.sl,
      suggestedTp: analysis.tp,
    };

    return send(from,
      `📊 *ניתחתי את הגרף:*\n\n` +
      `זוג: *${analysis.pair}*\n` +
      `מגמה: ${/עול|up/i.test(analysis.trend) ? "📈 עולה" : "📉 יורד"}\n` +
      `תמיכה: ${analysis.support || "—"}\n` +
      `התנגדות: ${analysis.resistance || "—"}\n` +
      `TP משוער: ${analysis.tp || "—"}\n\n` +
      `_הניתוח הוא הצעה — בואו נעבור צ'קליסט:_\n\n` +
      `${CHECKLIST_STEPS[0].q}`
    );
  } catch (e) {
    console.error("Image handling error:", e.message);
    send(from, `❌ בעיה בקריאת התמונה.\n\nשלח *עסקה חדשה* להתחיל צ'קליסט ידני.`);
  }
}

// ─── Webhook ──────────────────────────────────────────────────────────────────
app.get("/webhook", (req, res) => {
  if (req.query["hub.mode"] === "subscribe" && req.query["hub.verify_token"] === VERIFY_TOKEN) {
    res.status(200).send(req.query["hub.challenge"]);
  } else res.sendStatus(403);
});

app.post("/webhook", async (req, res) => {
  res.sendStatus(200);
  const entry = req.body.entry?.[0]?.changes?.[0]?.value;
  const message = entry?.messages?.[0];
  if (!message) return;

  if (message.type === "image") {
    console.log(`[${new Date().toLocaleTimeString("he-IL")}] ${message.from}: תמונה`);
    return handleImage(message.from, message.image.id);
  }

  if (message.type !== "text") return;
  console.log(`[${new Date().toLocaleTimeString("he-IL")}] ${message.from}: ${message.text.body}`);
  await handleMessage(message.from, message.text.body);
});

// ─── API ──────────────────────────────────────────────────────────────────────
app.get("/api/trades", (req, res) => res.json(loadJournal().trades));

app.listen(PORT, () => console.log(`🚀 FTMO Bot on http://localhost:${PORT}`));
