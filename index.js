require("dotenv").config();
const express = require("express");
const axios = require("axios");
const fs = require("fs");
const path = require("path");
const { randomUUID } = require("crypto");

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

const { WHATSAPP_TOKEN, PHONE_NUMBER_ID, VERIFY_TOKEN, PORT = 3001 } = process.env;
const JOURNAL_FILE = path.join(__dirname, "data/journal.json");

// ─── Data ─────────────────────────────────────────────────────────────────────
function loadJournal() {
  try { return JSON.parse(fs.readFileSync(JOURNAL_FILE, "utf8")); }
  catch { return { trades: [] }; }
}
function saveJournal(data) {
  fs.writeFileSync(JOURNAL_FILE, JSON.stringify(data, null, 2));
}

// ─── Checklist definition ─────────────────────────────────────────────────────
const QUESTIONS = [
  {
    key: "dailyTrend",
    text: "1️⃣ מה המגמה ב-Daily?\n(ענה: *עולה* או *יורד*)",
    validate: (ans, state) => {
      const up = /עולה|up|bull/i.test(ans);
      const down = /יורד|down|bear/i.test(ans);
      if (!up && !down) return null; // invalid answer
      const isLong = state.direction === "long";
      return isLong ? up : down;
    },
    failMsg: "🛑 *מגמת Daily* סותרת את כיוון העסקה",
    getValue: (ans) => /עולה|up|bull/i.test(ans) ? "עולה" : "יורד",
  },
  {
    key: "srLevel",
    text: "2️⃣ יש רמת תמיכה/התנגדות חזקה?\n(ענה: *כן* או *לא*)",
    validate: (ans) => /כן|yes/i.test(ans) ? true : /לא|no/i.test(ans) ? false : null,
    failMsg: "🛑 חסרה *רמת תמיכה/התנגדות* חזקה",
    getValue: (ans) => /כן|yes/i.test(ans) ? "כן" : "לא",
  },
  {
    key: "candleConfirm",
    text: "3️⃣ יש אישור נר?\n(ענה: *כן* או *לא*)",
    validate: (ans) => /כן|yes/i.test(ans) ? true : /לא|no/i.test(ans) ? false : null,
    failMsg: "🛑 חסר *אישור נר* לכניסה",
    getValue: (ans) => /כן|yes/i.test(ans) ? "כן" : "לא",
  },
  {
    key: "stopLogical",
    text: "4️⃣ הסטופ במקום הגיוני בגרף?\n(ענה: *כן* או *לא*)",
    validate: (ans) => /כן|yes/i.test(ans) ? true : /לא|no/i.test(ans) ? false : null,
    failMsg: "🛑 *הסטופ לוס* לא במקום הגיוני",
    getValue: (ans) => /כן|yes/i.test(ans) ? "כן" : "לא",
  },
  {
    key: "rrRatio",
    text: "5️⃣ יחס R:R לפחות 1:2?\n(ענה: *כן* או *לא*)",
    validate: (ans) => /כן|yes/i.test(ans) ? true : /לא|no/i.test(ans) ? false : null,
    failMsg: "🛑 יחס *R:R* לא עומד בדרישת 1:2",
    getValue: (ans) => /כן|yes/i.test(ans) ? "כן" : "לא",
  },
  {
    key: "noNews",
    text: "6️⃣ אין חדשות אדומות בשעה הקרובה?\n(ענה: *כן* או *לא*)",
    validate: (ans) => /כן|yes/i.test(ans) ? true : /לא|no/i.test(ans) ? false : null,
    failMsg: "🛑 יש *חדשות אדומות* קרובות — המתן",
    getValue: (ans) => /כן|yes/i.test(ans) ? "כן" : "לא",
  },
];

// ─── User sessions ─────────────────────────────────────────────────────────────
// state: { step: "idle" | "direction" | "q0".."q5", direction, answers[] }
const sessions = {};

function getSession(from) {
  return sessions[from] || { step: "idle" };
}

// ─── Send WhatsApp message ────────────────────────────────────────────────────
async function send(to, text) {
  try {
    await axios.post(
      `https://graph.facebook.com/v25.0/${PHONE_NUMBER_ID}/messages`,
      { messaging_product: "whatsapp", to, type: "text", text: { body: text } },
      { headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}`, "Content-Type": "application/json" } }
    );
  } catch (e) { console.error("Send error:", e.response?.data || e.message); }
}

// ─── Handle message ───────────────────────────────────────────────────────────
async function handleMessage(from, text) {
  const state = getSession(from);

  // ── Trigger ──
  if (state.step === "idle") {
    if (/עסקה חדשה|new trade|צ'קליסט|checklist/i.test(text)) {
      sessions[from] = { step: "direction", answers: {} };
      await send(from,
        "📋 *צ'קליסט עסקה חדשה*\n\nקודם כל — מה כיוון העסקה?\n(ענה: *לונג* או *שורט*)"
      );
    } else if (/יומן|journal|עסקות/i.test(text)) {
      const j = loadJournal();
      const count = j.trades.length;
      if (!count) return send(from, "אין עסקות ביומן עדיין.");
      const last3 = j.trades.slice(-3).reverse().map((t, i) => {
        const date = new Date(t.date).toLocaleDateString("he-IL");
        const result = t.passed ? "✅ נכנס" : "🛑 נדחה";
        return `${i + 1}. ${t.direction?.toUpperCase()} | ${date} | ${result}`;
      }).join("\n");
      await send(from, `📓 *יומן עסקות* (${count} סה"כ)\n\nאחרונות:\n${last3}`);
    } else {
      await send(from,
        "👋 שלום!\n\nשלח *עסקה חדשה* כדי לעבור את הצ'קליסט.\nשלח *יומן* כדי לראות עסקות קודמות."
      );
    }
    return;
  }

  // ── Direction ──
  if (state.step === "direction") {
    const isLong = /לונג|long|buy|קנייה/i.test(text);
    const isShort = /שורט|short|sell|מכירה/i.test(text);
    if (!isLong && !isShort) {
      return send(from, "לא הבנתי 🤔 ענה *לונג* או *שורט*");
    }
    sessions[from] = {
      step: "q0",
      direction: isLong ? "long" : "short",
      answers: {},
      currentQ: 0,
    };
    await send(from, `כיוון: *${isLong ? "📈 לונג" : "📉 שורט"}*\n\nיאללה, מתחילים:\n\n${QUESTIONS[0].text}`);
    return;
  }

  // ── Questions ──
  if (state.step.startsWith("q")) {
    const qIdx = parseInt(state.step.slice(1));
    const q = QUESTIONS[qIdx];
    const valid = q.validate(text, state);

    if (valid === null) {
      return send(from, `לא הבנתי. ${q.text}`);
    }

    state.answers[q.key] = { value: q.getValue(text), passed: valid };

    if (!valid) {
      // Failed — save to journal and stop
      const journal = loadJournal();
      journal.trades.push({
        id: randomUUID(),
        date: new Date().toISOString(),
        direction: state.direction,
        answers: state.answers,
        failedAt: q.key,
        failMsg: q.failMsg,
        passed: false,
      });
      saveJournal(journal);
      sessions[from] = { step: "idle" };
      return send(from,
        `${q.failMsg}\n\n❌ *עסקה לא עומדת בתנאים.*\nנשמר ביומן.\n\n_חכה לסטאפ נקי יותר._`
      );
    }

    const nextQ = qIdx + 1;

    if (nextQ < QUESTIONS.length) {
      // Next question
      sessions[from] = { ...state, step: `q${nextQ}` };
      await send(from, `✓ תקין!\n\n${QUESTIONS[nextQ].text}`);
    } else {
      // All passed!
      const journal = loadJournal();
      journal.trades.push({
        id: randomUUID(),
        date: new Date().toISOString(),
        direction: state.direction,
        answers: state.answers,
        passed: true,
      });
      saveJournal(journal);
      sessions[from] = { step: "idle" };

      const direction = state.direction === "long" ? "📈 לונג" : "📉 שורט";
      await send(from,
        `✅ *הסטאפ עומד בכל 6 התנאים!*\n\n` +
        `כיוון: *${direction}*\n\n` +
        `⚡ *הגדר סטופ ופרופיט וכנס בזהירות.*\n\n` +
        `זכור:\n• סטופ מתחת לרמה\n• טייק פרופיט 1:2 מהסטופ\n• מקסימום 1% ריסק\n\n` +
        `_נשמר ביומן. בהצלחה! 🎯_`
      );
    }
  }
}

// ─── Webhook ──────────────────────────────────────────────────────────────────
app.get("/webhook", (req, res) => {
  if (req.query["hub.mode"] === "subscribe" && req.query["hub.verify_token"] === VERIFY_TOKEN) {
    res.status(200).send(req.query["hub.challenge"]);
  } else {
    res.sendStatus(403);
  }
});

app.post("/webhook", async (req, res) => {
  res.sendStatus(200);
  const entry = req.body.entry?.[0]?.changes?.[0]?.value;
  const message = entry?.messages?.[0];
  if (!message || message.type !== "text") return;
  console.log(`[${new Date().toLocaleTimeString()}] ${message.from}: ${message.text.body}`);
  await handleMessage(message.from, message.text.body);
});

// ─── API ──────────────────────────────────────────────────────────────────────
app.get("/api/trades", (req, res) => res.json(loadJournal().trades));

app.listen(PORT, () => console.log(`🚀 FTMO Bot running on http://localhost:${PORT}`));
