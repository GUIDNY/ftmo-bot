require("dotenv").config();
const express = require("express");
const axios = require("axios");
const fs = require("fs");
const path = require("path");
const { randomUUID } = require("crypto");
const cron = require("node-cron");

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

const {
  WHATSAPP_TOKEN, PHONE_NUMBER_ID, VERIFY_TOKEN,
  GEMINI_KEY, NEWS_API_KEY, OWNER_PHONE, PORT = 3001
} = process.env;

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

// ─── Sessions ─────────────────────────────────────────────────────────────────
const sessions = {};
// Store owner phone from first message if not set in env
let ownerPhone = OWNER_PHONE || null;
function getState(from) { return sessions[from] || { step: "idle" }; }

// ─── Checklist steps ──────────────────────────────────────────────────────────
const CHECKLIST_STEPS = [
  { key: "pair",        q: "1️⃣ איזה זוג?\n(למשל EUR/USD, XAUUSD, NAS100)" },
  { key: "trend",       q: "2️⃣ מה המגמה ב-Daily?\n(*עולה* / *יורד* / *לא ברור*)" },
  { key: "sr",          q: "3️⃣ יש רמת S/R חזקה?\n(*כן* / *לא*)" },
  { key: "candle",      q: "4️⃣ יש אישור נר? (פין-בר / Engulfing)\n(*כן* / *לא*)" },
  { key: "entry",       q: "5️⃣ מחיר כניסה?" },
  { key: "sl",          q: "6️⃣ מחיר סטופ לוס?" },
  { key: "tp",          q: "7️⃣ מחיר טייק פרופיט?" },
  { key: "accountSize", q: "8️⃣ גודל החשבון בדולרים?" },
];

function parseNum(text) {
  const n = parseFloat(text.replace(/[,\s]/g, ""));
  return isNaN(n) ? null : n;
}

// Find first step index that doesn't have an answer yet
function firstUnansweredStep(answers) {
  for (let i = 0; i < CHECKLIST_STEPS.length; i++) {
    if (answers[CHECKLIST_STEPS[i].key] == null) return i;
  }
  return CHECKLIST_STEPS.length;
}

// ─── Checklist handler ────────────────────────────────────────────────────────
async function handleChecklist(from, state, text) {
  const stepIdx = parseInt(state.step.replace("cl_", ""));
  const stepDef = CHECKLIST_STEPS[stepIdx];
  const answers = state.answers;

  if (stepDef.key === "trend") {
    if (!/עולה|יורד|לא ברור|up|down|unclear/i.test(text))
      return send(from, "ענה: *עולה* / *יורד* / *לא ברור*");
    if (/לא ברור|unclear/i.test(text)) {
      saveFailedTrade(answers, "🛑 מגמת Daily לא ברורה");
      sessions[from] = { step: "idle" };
      return send(from, "🛑 *אל תיכנס.*\nחכה למגמה ברורה ב-Daily.");
    }
    answers.trend = /עולה|up/i.test(text) ? "עולה" : "יורד";
  }
  else if (stepDef.key === "sr") {
    if (!/כן|לא|yes|no/i.test(text)) return send(from, "ענה *כן* או *לא*");
    if (/לא|no/i.test(text)) {
      saveFailedTrade(answers, "🛑 אין רמת S/R חזקה");
      sessions[from] = { step: "idle" };
      return send(from, "🛑 *אל תיכנס.*\nאין רמה חזקה לעבוד מולה.");
    }
    answers.sr = "כן";
  }
  else if (stepDef.key === "candle") {
    if (!/כן|לא|yes|no/i.test(text)) return send(from, "ענה *כן* או *לא*");
    if (/לא|no/i.test(text)) {
      saveFailedTrade(answers, "🛑 אין אישור נר");
      sessions[from] = { step: "idle" };
      return send(from, "🛑 *אל תיכנס.*\nחכה לנר אישור.");
    }
    answers.candle = "כן";
  }
  else if (["entry", "sl", "tp", "accountSize"].includes(stepDef.key)) {
    const n = parseNum(text);
    if (!n) return send(from, "שלח מספר בלבד.");
    answers[stepDef.key] = n;
  }
  else {
    answers[stepDef.key] = text.trim();
  }

  // Find next unanswered step (skip pre-filled ones)
  const nextIdx = firstUnansweredStep(answers);

  if (nextIdx < CHECKLIST_STEPS.length) {
    sessions[from] = { ...state, step: `cl_${nextIdx}`, answers };
    const hint = state[`suggested_${CHECKLIST_STEPS[nextIdx].key}`]
      ? `\n_(מהגרף: ${state[`suggested_${CHECKLIST_STEPS[nextIdx].key}`]})_` : "";
    return send(from, `✓\n\n${CHECKLIST_STEPS[nextIdx].q}${hint}`);
  }

  // ── All done — calculate ──
  await finishChecklist(from, answers);
}

async function finishChecklist(from, answers) {
  const { entry, sl, tp, accountSize, pair, trend } = answers;

  // Check daily trade count
  const todayTrades = loadJournal().trades.filter(t =>
    t.checklistPassed && new Date(t.date).toDateString() === new Date().toDateString()
  );
  if (todayTrades.length >= 3) {
    sessions[from] = { step: "idle" };
    return send(from, "🚫 *הגעת למקסימום 3 עסקאות היום!*\nסגור את הפלטפורמה וחזור מחר.");
  }

  const slDist = Math.abs(entry - sl);
  const tpDist = Math.abs(tp - entry);
  const rr = tpDist / slDist;
  const riskPct = (slDist / entry) * 100;
  const riskDollars = (riskPct / 100) * accountSize;

  const warnings = [];
  if (rr < 2) warnings.push(`⚠️ R:R הוא 1:${rr.toFixed(1)} — מומלץ לפחות 1:2.`);
  if (riskPct > 2) warnings.push(`🚨 סיכון ${riskPct.toFixed(1)}% ($${riskDollars.toFixed(0)}) — מקסימום 2%!`);

  // Get session based on Israel time
  const ilHour = new Date().toLocaleString("en-US", { timeZone: "Asia/Jerusalem", hour: "numeric", hour12: false });
  const h = parseInt(ilHour);
  const session = h >= 10 && h < 13 ? "London" : h >= 15 && h < 19 ? "New York" : h >= 2 && h < 9 ? "Asian" : "Off-hours";

  const tradeId = randomUUID();
  const journal = loadJournal();
  journal.trades.push({
    id: tradeId,
    date: new Date().toISOString(),
    pair, trend, entry, sl, tp, accountSize,
    rr: parseFloat(rr.toFixed(2)),
    riskPct: parseFloat(riskPct.toFixed(2)),
    riskDollars: parseFloat(riskDollars.toFixed(2)),
    session,
    checklistPassed: true,
    result: null, lesson: null,
  });
  saveJournal(journal);
  sessions[from] = { step: "idle", lastTradeId: tradeId };

  const dir = trend === "עולה" ? "📈 לונג" : "📉 שורט";
  const tradesLeft = 3 - (todayTrades.length + 1);

  if (warnings.length > 0) {
    return send(from,
      `📊 *סטאפ עם אזהרות:*\n\n${pair} | ${dir}\n` +
      `כניסה: ${entry} | SL: ${sl} | TP: ${tp}\n` +
      `R:R: 1:${rr.toFixed(1)} | סיכון: ${riskPct.toFixed(2)}%\n\n` +
      warnings.join("\n") +
      `\n\n_עסקות שנותרו להיום: ${tradesLeft}/3_`
    );
  }

  return send(from,
    `✅ *הסטאפ עומד בכל התנאים!*\n\n` +
    `${pair} | ${dir} | ${session}\n` +
    `כניסה: ${entry} | SL: ${sl} | TP: ${tp}\n\n` +
    `📊 R:R = 1:${rr.toFixed(1)}\n` +
    `💰 סיכון: ${riskPct.toFixed(2)}% ($${riskDollars.toFixed(0)})\n\n` +
    `_כנס בזהירות. אל תזיז את הסטופ._\n` +
    `_עסקות שנותרו היום: ${tradesLeft}/3_`
  );
}

function saveFailedTrade(answers, reason) {
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

// ─── Performance analysis ─────────────────────────────────────────────────────
function buildPerformanceAnalysis(trades) {
  const completed = trades.filter(t => t.checklistPassed && t.result != null);
  if (completed.length < 3) return "";

  // By pair
  const byPair = {};
  completed.forEach(t => {
    if (!byPair[t.pair]) byPair[t.pair] = { pnl: 0, count: 0, wins: 0 };
    byPair[t.pair].pnl += t.result;
    byPair[t.pair].count++;
    if (t.result > 0) byPair[t.pair].wins++;
  });
  const sortedPairs = Object.entries(byPair).sort((a, b) => b[1].pnl - a[1].pnl);
  const bestPair = sortedPairs[0];
  const worstPair = sortedPairs[sortedPairs.length - 1];

  // By session
  const bySession = {};
  completed.forEach(t => {
    const s = t.session || "לא ידוע";
    if (!bySession[s]) bySession[s] = { pnl: 0, count: 0 };
    bySession[s].pnl += t.result;
    bySession[s].count++;
  });
  const worstSession = Object.entries(bySession).sort((a, b) => a[1].pnl - b[1].pnl)[0];
  const bestSession = Object.entries(bySession).sort((a, b) => b[1].pnl - a[1].pnl)[0];

  let analysis = `\n\n📈 *ניתוח ביצועים:*\n`;
  if (bestPair) analysis += `🥇 זוג רווחי: *${bestPair[0]}* (+$${bestPair[1].pnl.toFixed(0)}, ${Math.round(bestPair[1].wins/bestPair[1].count*100)}% win)\n`;
  if (worstPair && worstPair[0] !== bestPair[0]) analysis += `👎 זוג בעייתי: *${worstPair[0]}* ($${worstPair[1].pnl.toFixed(0)})\n`;
  if (bestSession) analysis += `⏰ סשן הכי טוב: *${bestSession[0]}*\n`;
  if (worstSession && worstSession[0] !== bestSession[0]) analysis += `⚠️ סשן בעייתי: *${worstSession[0]}* — שקול להימנע`;

  return analysis;
}

// ─── Summary ──────────────────────────────────────────────────────────────────
function buildSummary() {
  const { trades } = loadJournal();
  if (!trades.length) return "אין עסקות ביומן עדיין.";

  const completed = trades.filter(t => t.result != null);
  const wins = completed.filter(t => t.result > 0).length;
  const total = completed.reduce((s, t) => s + (t.result || 0), 0);
  const winRate = completed.length ? Math.round(wins / completed.length * 100) : 0;
  const sortedByResult = [...completed].sort((a, b) => b.result - a.result);
  const best = sortedByResult[0];
  const worst = sortedByResult[sortedByResult.length - 1];
  const passed = trades.filter(t => t.checklistPassed).length;
  const rejected = trades.filter(t => !t.checklistPassed).length;

  // Today's count
  const todayCount = trades.filter(t =>
    t.checklistPassed && new Date(t.date).toDateString() === new Date().toDateString()
  ).length;

  let msg =
    `📓 *סיכום יומן מסחר*\n\n` +
    `📅 היום: ${todayCount}/3 עסקות\n\n` +
    `סה"כ: ${trades.length} | ✅ ${passed} | 🛑 ${rejected}\n` +
    `📊 סגורות: ${completed.length} | 🏆 ${wins}W / ${completed.length - wins}L\n` +
    `📈 Win Rate: ${winRate}%\n` +
    `💵 P&L: ${total >= 0 ? "+" : ""}$${total.toFixed(0)}\n` +
    (best ? `\n🥇 הכי טוב: +$${best.result} (${best.pair || ""})\n😔 הכי גרוע: $${worst.result} (${worst.pair || ""})` : "");

  // Add performance analysis after 5+ trades
  if (completed.length >= 5) {
    msg += buildPerformanceAnalysis(trades);
  }

  return msg;
}

// ─── Morning briefing ─────────────────────────────────────────────────────────
async function sendMorningBriefing() {
  const phone = ownerPhone;
  if (!phone) return console.log("No owner phone — skipping briefing");

  try {
    // Get forex news
    let newsText = "";
    if (NEWS_API_KEY) {
      const newsRes = await axios.get(
        `https://newsapi.org/v2/everything?q=forex+trading+market&language=en&sortBy=publishedAt&pageSize=3&apiKey=${NEWS_API_KEY}`
      );
      const articles = newsRes.data.articles || [];
      newsText = articles.map((a, i) => `${i + 1}. ${a.title}`).join("\n");
    }

    const journal = loadJournal();
    const todayTrades = journal.trades.filter(t =>
      t.checklistPassed && new Date(t.date).toDateString() === new Date().toDateString()
    ).length;

    const ilDate = new Date().toLocaleDateString("he-IL", { weekday: "long", day: "numeric", month: "long" });

    await send(phone,
      `☀️ *בוקר טוב! ${ilDate}*\n\n` +
      `📊 *סטטוס FTMO:*\n` +
      `עסקות היום: ${todayTrades}/3\n\n` +
      `⚔️ *תזכורת יומית:*\n` +
      `• מקס 2% סיכון לעסקה\n` +
      `• R:R מינימום 1:2\n` +
      `• לא לסחור בחדשות אדומות\n\n` +
      (newsText ? `📰 *חדשות שוק:*\n${newsText}\n\n` : "") +
      `_עבור על הצ'קליסט לפני כל עסקה. בהצלחה!_ 🎯`
    );
    console.log("Morning briefing sent to", phone);
  } catch (e) {
    console.error("Briefing error:", e.message);
  }
}

// Schedule: every day at 09:00 Israel time (UTC+3 = 06:00 UTC)
cron.schedule("0 6 * * 1-5", sendMorningBriefing, { timezone: "UTC" });

// ─── Gemini Vision ────────────────────────────────────────────────────────────
async function askGeminiVision(base64, mimeType) {
  const res = await axios.post(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_KEY}`,
    {
      contents: [{
        parts: [
          { inline_data: { mime_type: mimeType, data: base64 } },
          { text: `אתה אנליסט פורקס. קרא את הגרף וחלץ מידע מדויק.
החזר JSON בלבד (ללא markdown):
{"pair":"שם הזוג","trend":"עולה או יורד","support":1.2345,"resistance":1.2400,"entry":1.2350,"sl":1.2300,"tp":1.2450,"timeframe":"H4"}
אם לא ניתן לקרוא: {"error":"לא הצלחתי"}` }
        ]
      }]
    }
  );
  const raw = res.data.candidates?.[0]?.content?.parts?.[0]?.text || "{}";
  console.log("Gemini raw:", raw.slice(0, 200));
  return JSON.parse(raw.replace(/```json\n?|\n?```/g, "").trim());
}

async function handleImage(from, mediaId) {
  await send(from, "🔍 מנתח את הגרף... שנייה אחת");
  try {
    const mediaRes = await axios.get(
      `https://graph.facebook.com/v25.0/${mediaId}`,
      { headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}` } }
    );
    const imgRes = await axios.get(mediaRes.data.url, {
      responseType: "arraybuffer",
      headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}` }
    });
    const base64 = Buffer.from(imgRes.data).toString("base64");
    const mimeType = imgRes.headers["content-type"] || "image/jpeg";

    const a = await askGeminiVision(base64, mimeType);
    if (a.error) return send(from, `❌ ${a.error}\n\nשלח *עסקה חדשה* לצ'קליסט ידני.`);

    const trend = /עול|up|bull/i.test(a.trend) ? "עולה" : "יורד";

    // Pre-fill as many fields as possible from chart
    const answers = {
      pair: a.pair || null,
      trend: a.pair ? trend : null,
      entry: a.entry ? parseFloat(a.entry) : null,
      sl: a.sl ? parseFloat(a.sl) : null,
      tp: a.tp ? parseFloat(a.tp) : null,
    };

    const firstQ = firstUnansweredStep(answers);
    sessions[from] = {
      step: `cl_${firstQ < CHECKLIST_STEPS.length ? firstQ : 0}`,
      answers,
    };

    const prefilledCount = Object.values(answers).filter(v => v != null).length;
    const dir = trend === "עולה" ? "📈 עולה" : "📉 יורד";

    let msg = `📊 *ניתוח גרף:*\n\n`;
    msg += `זוג: *${a.pair || "—"}* | מגמה: ${dir}\n`;
    msg += `תמיכה: ${a.support || "—"} | התנגדות: ${a.resistance || "—"}\n`;
    if (a.entry) msg += `כניסה: ${a.entry} | SL: ${a.sl} | TP: ${a.tp}\n`;
    msg += `\n_מילאתי ${prefilledCount} שדות אוטומטית._\n\n`;

    if (firstQ < CHECKLIST_STEPS.length) {
      msg += `נשאר לענות על:\n${CHECKLIST_STEPS[firstQ].q}`;
    } else {
      msg += `כל השדות מולאו מהגרף! מחשב...`;
      await send(from, msg);
      return finishChecklist(from, answers);
    }

    return send(from, msg);

  } catch (e) {
    console.error("Image error:", e.message);
    send(from, `❌ בעיה בקריאת התמונה.\nשלח *עסקה חדשה* לצ'קליסט ידני.`);
  }
}

// ─── Main message handler ─────────────────────────────────────────────────────
async function handleMessage(from, text) {
  // Save owner phone on first message
  if (!ownerPhone) ownerPhone = from;

  const state = getState(from);
  const t = text.trim();

  if (state.step.startsWith("cl_")) return handleChecklist(from, state, t);

  // ── MT5 trade journal flow ──
  if (state.step === "mt5_why") {
    const journal = loadJournal();
    const trade = journal.trades.find(tr => tr.id === state.tradeId);
    if (trade) { trade.whyEntered = t; saveJournal(journal); }
    sessions[from] = { ...state, step: "mt5_plan" };
    return send(from, `✓ רשמתי.\n\n📋 מה התוכנית שלך לעסקה הזו?\n_(למשל: TP ב-1.1680, SL ב-1.1610, יוצא אם השעה 17:00)_`);
  }

  if (state.step === "mt5_plan") {
    const journal = loadJournal();
    const trade = journal.trades.find(tr => tr.id === state.tradeId);
    if (trade) { trade.plan = t; trade.checklistPassed = true; saveJournal(journal); }
    sessions[from] = { step: "idle", lastTradeId: state.tradeId };
    return send(from, `✅ *נשמר ביומן!*\n\n_תן לעסקה לעבוד. אל תזיז סטופ. אל תגדיל פוזיציה._\n\nבהצלחה 🎯`);
  }

  if (state.step === "closure_result") {
    const amount = parseFloat(t.replace(/[^\d.\-\+]/g, ""));
    if (isNaN(amount)) return send(from, "שלח סכום: *+150* או *-80*");
    sessions[from] = { step: "closure_lesson", result: amount, lastTradeId: state.lastTradeId };
    return send(from, `${amount >= 0 ? "🏆 רווח" : "💔 הפסד"} $${Math.abs(amount)}\n\n📝 מה למדת?`);
  }

  if (state.step === "closure_lesson") {
    const journal = loadJournal();
    const trade = state.lastTradeId
      ? journal.trades.find(tr => tr.id === state.lastTradeId)
      : journal.trades.filter(tr => tr.result == null).pop();
    if (trade) {
      trade.lesson = t;
      trade.closedAt = new Date().toISOString();
      saveJournal(journal);
    }
    sessions[from] = { step: "idle" };
    return send(from,
      `${state.result >= 0 ? "🏆" : "💪"} *נשמר!*\n` +
      `תוצאה: ${state.result >= 0 ? "+" : ""}$${state.result}\n` +
      `לקח: _${t}_\n\n` +
      (state.result < 0 ? "הפסד הוא חלק מהמשחק. ✊" : "כל כבוד! שמור על הפוקוס. 🎯")
    );
  }

  // Commands
  if (/עסקה חדשה|new trade|צ'קליסט/i.test(t)) {
    sessions[from] = { step: "cl_0", answers: {} };
    return send(from, `📋 *צ'קליסט עסקה חדשה*\n\n${CHECKLIST_STEPS[0].q}`);
  }

  if (/^סגירה|^סגור|^close/i.test(t)) {
    sessions[from] = { step: "closure_result", lastTradeId: state.lastTradeId };
    return send(from, "מה הייתה התוצאה? (למשל: *+150* או *-80*)");
  }

  if (/^סיכום|^stats|^summary/i.test(t)) return send(from, buildSummary());

  if (/^כללים|^rules/i.test(t)) {
    return send(from,
      `⚔️ *כללי הברזל:*\n\n` +
      `1️⃣ מקס *2%* סיכון לעסקה\n` +
      `2️⃣ מקס *3 עסקאות* ביום\n` +
      `3️⃣ R:R מינימום *1:2*\n` +
      `4️⃣ אסור סביב *חדשות אדומות*\n` +
      `5️⃣ רק בין *10:00–19:00* שעון ישראל\n\n` +
      `_הכללים קיימים בדיוק לימים שאתה לא רוצה לשמוע אותם._`
    );
  }

  if (/^בריפינג|^briefing/i.test(t)) {
    await sendMorningBriefing();
    return;
  }

  if (/^עזרה|^help/i.test(t)) {
    return send(from,
      `👋 *פקודות:*\n\n` +
      `📋 *עסקה חדשה* — צ'קליסט\n` +
      `📸 *שלח גרף* — ניתוח + צ'קליסט אוטומטי\n` +
      `🔒 *סגירה* — תוצאת עסקה\n` +
      `📊 *סיכום* — סטטיסטיקות + ניתוח ביצועים\n` +
      `⚔️ *כללים* — כללי הברזל\n` +
      `☀️ *בריפינג* — שלח עכשיו`
    );
  }

  return send(from, `שלח *עסקה חדשה* או שלח גרף כדי להתחיל.\nשלח *עזרה* לרשימת פקודות.`);
}

// ─── Webhook ──────────────────────────────────────────────────────────────────
app.get("/webhook", (req, res) => {
  if (req.query["hub.mode"] === "subscribe" && req.query["hub.verify_token"] === VERIFY_TOKEN)
    res.status(200).send(req.query["hub.challenge"]);
  else res.sendStatus(403);
});

app.post("/webhook", async (req, res) => {
  res.sendStatus(200);
  const entry = req.body.entry?.[0]?.changes?.[0]?.value;
  const message = entry?.messages?.[0];
  if (!message) return;

  if (message.type === "image") {
    console.log(`[IMG] ${message.from}`);
    return handleImage(message.from, message.image.id);
  }
  if (message.type !== "text") return;
  console.log(`[${new Date().toLocaleTimeString("he-IL")}] ${message.from}: ${message.text.body}`);
  await handleMessage(message.from, message.text.body);
});

// ─── API ──────────────────────────────────────────────────────────────────────
app.get("/api/trades", (req, res) => res.json(loadJournal().trades));

// ─── MT5 Bridge API ───────────────────────────────────────────────────────────
const MT5_API_KEY = "ftmo_bridge_2024";

function mt5Auth(req, res) {
  if (req.body.key !== MT5_API_KEY) { res.status(401).json({ error: "unauthorized" }); return false; }
  return true;
}

app.post("/api/mt5/trade-opened", async (req, res) => {
  res.json({ ok: true });
  if (!mt5Auth(req, res)) return;
  const { phone, pair, direction, entry, sl, tp, volume, ticket } = req.body;

  const tradeId = ticket?.toString() || randomUUID();
  const dir = direction === "לונג" ? "📈 לונג" : "📉 שורט";

  // Save to journal
  const journal = loadJournal();
  journal.trades.push({
    id: tradeId,
    date: new Date().toISOString(),
    source: "mt5",
    pair, trend: direction === "לונג" ? "עולה" : "יורד",
    entry, sl, tp, volume,
    checklistPassed: null,
    result: null, lesson: null,
  });
  saveJournal(journal);

  const target = phone || ownerPhone;
  if (!target) return;

  // Start journal flow
  sessions[target] = { step: "mt5_why", tradeId };

  await send(target,
    `🔔 *עסקה נפתחה!*\n\n` +
    `*${pair}* | ${dir}\n` +
    `כניסה: ${entry} | SL: ${sl} | TP: ${tp}\n` +
    `נפח: ${volume} lots\n\n` +
    `📓 *למה נכנסת לעסקה הזו?*`
  );
  console.log(`[MT5] Trade opened: ${pair} ${direction}`);
});

app.post("/api/mt5/trade-closed", async (req, res) => {
  res.json({ ok: true });
  if (!mt5Auth(req, res)) return;
  const { phone, pair, profit, ticket } = req.body;

  const pnl = parseFloat(parseFloat(profit).toFixed(2));
  const tradeId = ticket?.toString();

  // Update journal
  const journal = loadJournal();
  const trade = journal.trades.find(t => t.id === tradeId);
  if (trade) {
    trade.result = pnl;
    trade.closedAt = new Date().toISOString();
    saveJournal(journal);
  }

  const target = phone || ownerPhone;
  if (!target) return;

  const emoji = pnl >= 0 ? "🏆" : "💔";
  sessions[target] = { step: "closure_lesson", result: pnl, lastTradeId: tradeId };

  await send(target,
    `${emoji} *${pair} נסגרה*\n\n` +
    `תוצאה: ${pnl >= 0 ? "+" : ""}$${pnl}\n\n` +
    `📝 מה למדת מהעסקה הזו?`
  );
  console.log(`[MT5] Trade closed: ${pair} P&L: ${pnl}`);
});

app.post("/api/mt5/alert", async (req, res) => {
  res.json({ ok: true });
  if (!mt5Auth(req, res)) return;
  const { phone, message } = req.body;
  if (phone && message) await send(phone, message);
  console.log(`[MT5] Alert: ${message}`);
});

app.post("/api/mt5/account-update", (req, res) => {
  res.json({ ok: true });
  if (!mt5Auth(req, res)) return;
  const { balance, equity, profit } = req.body;
  const journal = loadJournal();
  journal.account = { balance, equity, profit, updatedAt: new Date().toISOString() };
  saveJournal(journal);
  console.log(`[MT5] Account: balance=${balance} equity=${equity}`);
});

app.get("/api/export", (req, res) => {
  const { trades } = loadJournal();
  const headers = ["תאריך","זוג","כיוון","כניסה","SL","TP","R:R","סיכון%","סשן","תוצאה","לקח","עבר_צ'קליסט"];
  const rows = trades.map(t => [
    new Date(t.date).toLocaleDateString("he-IL"),
    t.pair || "",
    t.trend || "",
    t.entry || "",
    t.sl || "",
    t.tp || "",
    t.rr || "",
    t.riskPct || "",
    t.session || "",
    t.result != null ? t.result : "",
    (t.lesson || "").replace(/,/g, ";"),
    t.checklistPassed ? "כן" : "לא",
  ]);
  const csv = [headers, ...rows].map(r => r.join(",")).join("\n");
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", "attachment; filename=ftmo-journal.csv");
  res.send("﻿" + csv); // BOM for Hebrew Excel
});

app.listen(PORT, () => console.log(`🚀 FTMO Bot on http://localhost:${PORT}`));
