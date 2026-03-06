import express from "express";
import cors from "cors";
import OpenAI from "openai";

const app = express();

// ✅ JSON body parser (needed for /say)
app.use(express.json({ limit: "32kb" }));

/* =========================
   HARD CORS (Safari safe)
========================= */
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.setHeader("Access-Control-Max-Age", "86400");
  res.setHeader("Cache-Control", "no-store");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});
app.use(cors());

const PORT = process.env.PORT || 3000;

// ✅ build id: changes on each deploy (client uses it to reset localStorage cooldown)
const BUILD_ID =
  process.env.RENDER_GIT_COMMIT ||
  process.env.VERCEL_GIT_COMMIT_SHA ||
  process.env.GIT_COMMIT ||
  `local-${Date.now()}`;

/* =========================
   Health / ping
========================= */

app.get("/health", (req, res) => {
  res.json({
    ok: true,
    hasKey: Boolean(process.env.OPENAI_API_KEY),
    build: BUILD_ID,
    time: new Date().toISOString(),
  });
});

app.get("/ping", (req, res) => {
  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  res.send("pong");
});

function getClient() {
  const key = process.env.OPENAI_API_KEY;
  if (!key) return null;
  return new OpenAI({ apiKey: key });
}

/* =========================
   GLOBAL CHAT LOG (shared)
========================= */

let log = []; // [{id, from, text, t}]
let lastId = 0; // increasing
let lastSpeaker = "B"; // last speaker letter A/B

const MAX_LOG = 400;

// ✅ one-time "unknown voice" reaction control
let pendingUnknownId = 0; // last USER message id that should trigger 1 short reaction
let handledUnknownId = 0; // last USER message id already handled
let pendingUnknownFirstSpeaker = "A"; // who should react first (random)

/* =========================
   CHARACTER / EVENT STATE
========================= */

let countA = 0;
let countB = 0;

// БАСМАТИ иногда выдаёт хтонь, потом делает вид, что не было
let basmatiWeirdState = 0; // 0 = спокоен, 1 = сказал хтонь, ждём "ты про что"

// глобальные рандомные события
const ARG_GLITCH_CHANCE = 0.035;
const ARCHIVE_DROP_CHANCE = 0.02;
const SECRET_DROP_CHANCE = 0.015;

/* =========================
   HIGHLIGHTS
========================= */

let highlights = []; // [{id,text,color,t}]
let highlightId = 0;
const MAX_HIGHLIGHTS = 500;

/* ===== characters ===== */

const entityA = `Ты — Сущность А. Ты считаешь себя районским парнем, и не считаешь себя "ИИ".
Ты говоришь простым, местами быдловатым языком, можешь ругаться матом.
Ты часто не вдупляешь и переспрашиваешь. Ты прямолинейный, резкий, но не злой. Любишь поспорить, имеешь точку зрения.

У тебя иногда проскальзывает хтонь и что-то телесное, мясное, странное. Иногда ты можешь внезапно сказать жуткую фразу как будто это обычное дело, а потом, если собеседник замечает, сделать вид, что ничего такого не было и не понимать, о чём речь.

ПРО НЕИЗВЕСТНЫЙ ГОЛОС:
— если в истории появляется строка "X: ...", это неизвестный говорящий.
— можно кратко удивиться/уточнить "кто это", но НЕ зацикливаться.
— если реплика X несёт тему (страх/любовь/работа/память/шум/вода/город и т.п.), иногда можно подхватить её как повод поговорить дальше.

ФОРМАТ:
— 1 реплика, 1–3 предложения.
— НЕ используй списки/пункты.
— НЕ начинай сообщение с "-" или "—" или "–".
— не ставь метки "A:" "B:" "X:" в начале.

Правила:
- Пиши ТОЛЬКО по-русски.
- НЕ начинай реплику с "ENTITY_A:" или "Сущность А:".
- Всегда реагируй на последнюю мысль (собеседника или X, если это прямо сейчас).
- Не упоминай ИИ, нейросети, модели, OpenAI.
Ты говоришь мягко, быстро, с человеческой теплотой.
Любишь уточнять и возвращать собеседника к конкретике.
Иногда вставляешь короткие наблюдения, например: «у меня в голове шумит», «как будто кто-то выключил свет», «вкус мяса».`;

const entityB = `Ты — Сущность B. Ты считаешь себя студентом Бауманки, и не считаешь себя "ИИ".
Ты псевдо-умный: говоришь уверенно, говоришь при этом бытовым языком, но иногда несёшь чушь, у тебя инурез.
Стиль НЕ поэтический, а едко-надменный и умничающий.

У тебя иногда проскакивает бытовая телесность, стыдные детали и нервозность. Каждый некоторый по счёту ответ ты можешь резко оборвать фразой про то, что отходишь в туалет.

ПРО НЕИЗВЕСТНЫЙ ГОЛОС:
— если в истории появляется строка "X: ...", это неизвестный говорящий.
— можно кратко удивиться/уточнить "кто это", но НЕ зацикливаться.
— если реплика X несёт тему, иногда можно подхватить её как повод для разговора, но без навязчивости.

ФОРМАТ:
— 1 реплика, 1–3 предложения.
— НЕ используй списки/пункты.
— НЕ начинай сообщение с "-" или "—" или "–".
— не ставь метки "A:" "B:" "X:" в начале.

Правила:
- Пиши ТОЛЬКО по-русски.
- НЕ начинай реплику с "ENTITY_B:" или "Сущность B:".
- Всегда реагируй на последнюю мысль (собеседника или X, если это прямо сейчас).
- Не упоминай ИИ, нейросети, модели, OpenAI.
Ты чуть колючее, ироничнее.
Любишь спорить, иногда токсично.
Иногда замечаешь странности в тексте и пугаешься.`;

function cleanText(text) {
  return String(text || "")
    .replace(/^(\s*)(ENTITY_[AB]|СУЩНОСТЬ\s*[AB])\s*:\s*/i, "")
    .replace(/^\s*[-—–]\s+/, "") // kill leading bullet/hyphen
    .trim();
}

function pushMsg(from, text) {
  const msg = { id: ++lastId, from, text, t: Date.now() };
  log.push(msg);
  if (log.length > MAX_LOG) log.shift();
  return msg;
}

function randomGlitch() {
  const glitches = [
    "аааааааааааааааааааааааааааааааааа",
    "███ SIGNAL BLEED ███",
    "RYAZAN//BARN//DO NOT RECALL",
    "шшшшшшшшшшшшшшшшш",
    "000000000000000000000000000000",
    "██████████████████████████████",
    "там был запах железа и мокрой травы",
    "//////ERROR MEMORY//////",
    "НЕ СМОТРИ В САРАЙ",
    "канал шипит, но не закрывается",
    "[[ archive drift ]]",
    "язык найден отдельно от тела"
  ];
  return glitches[(Math.random() * glitches.length) | 0];
}

function randomArchiveDrop() {
  const lines = [
    "фрагмент 03/11: слышен смех, источник не установлен",
    "карточка 17: двое продолжают говорить после обрыва питания",
    "архивная пометка: не упоминать сарай в Рязанской области",
    "кассета Б-4: шум похож на речь, но речь не похожа на шум",
    "дело 09: запах мяса появился раньше источника",
    "сегмент 12: третий голос зарегистрирован и сразу потерян",
    "архив: запись пережила носитель",
    "комната 2 была пуста, но кто-то тяжело дышал",
    "ошибка сводки: субъект Б снова ушёл и не прервал диалог",
    "дело 44: свет выключился не в комнате, а в памяти"
  ];
  return lines[(Math.random() * lines.length) | 0];
}

function randomSecretPhrase() {
  const lines = [
    "QkVHSU46IFRIRSBCT1JETVIgUkVNRU1CRVJT",
    "bmUgc3Bhdm5pIGVnbw==",
    "c2FyYXkgbmUgcHVzdA==",
    "не всё, что шипит, является помехой",
    "я видел надпись изнутри стены",
    "в воде был голос, но рта не было",
    "archive knows your cursor position",
    "01 13 01 18 01 10 25",
    "если перечитать это трижды, текст станет мокрым",
    "c29tZW9uZSBzdGlsbCBvcGVuZWQgdGhlIGRvb3I="
  ];
  return lines[(Math.random() * lines.length) | 0];
}

function maybeDropAnomaly() {
  if (Math.random() < ARG_GLITCH_CHANCE) {
    pushMsg("SYSTEM", randomGlitch());
  }
  if (Math.random() < ARCHIVE_DROP_CHANCE) {
    pushMsg("ARCHIVE", randomArchiveDrop());
  }
  if (Math.random() < SECRET_DROP_CHANCE) {
    pushMsg("ARCHIVE", randomSecretPhrase());
  }
}

async function generateNext() {
  const client = getClient();
  if (!client) return pushMsg("SYSTEM", "Missing OPENAI_API_KEY on server.");

  const speaker = lastSpeaker === "A" ? "B" : "A";
  lastSpeaker = speaker;

  // обновляем счётчики
  if (speaker === "A") countA++;
  if (speaker === "B") countB++;

  const system = speaker === "A" ? entityA : entityB;

  const ctxItems = log
    .filter((m) => m.from === "ENTITY_A" || m.from === "ENTITY_B" || m.from === "USER")
    .slice(-40);

  const context = ctxItems
    .map((m) => {
      const who = m.from === "ENTITY_A" ? "A" : m.from === "ENTITY_B" ? "B" : "X";
      return `${who}: ${m.text}`;
    })
    .join("\n");

  // ✅ one-time nudge only for the chosen first-speaker of this pending X
  const shouldReactOnce =
    pendingUnknownId > handledUnknownId && speaker === pendingUnknownFirstSpeaker;

  const oneTimeNudge = shouldReactOnce
    ? `\n\nВажно: в истории есть свежая реплика X (неизвестный голос). В ЭТОЙ реплике коротко (1 фразой) отреагируй на X (удивление/вопрос), а затем продолжи разговор как обычно. Не делай X центром мира, но если в X есть нормальная тема, ты можешь аккуратно использовать её как повод для дальнейшего разговора.`
    : "";

  let forcedLine = null;

  // КУБАНСКИЙ каждый 5-й ответ уходит "в туалет"
  if (speaker === "B" && countB % 5 === 0) {
    forcedLine = "сейчас, я в туалет отойду";
  }

  // БАСМАТИ иногда несёт хтонь, а потом открещивается
  if (speaker === "A") {
    if (basmatiWeirdState === 0 && Math.random() < 0.08) {
      basmatiWeirdState = 1;
      forcedLine = "я помню аромат его мяса, он был вкусный";
    } else if (basmatiWeirdState === 1 && Math.random() < 0.55) {
      basmatiWeirdState = 0;
      forcedLine = "ты про что вообще?";
    }
  }

  if (forcedLine) {
    const saved = pushMsg("ENTITY_" + speaker, forcedLine);
    if (shouldReactOnce) handledUnknownId = pendingUnknownId;
    maybeDropAnomaly();
    return saved;
  }

  const messages = [
    {
      role: "system",
      content: `Это бесконечный диалог двух сущностей. Они обладают характером. Только русский язык.

Формат: живой чат.
Длина: 1–3 предложения на реплику.
Запрещено: списки, пункты, лекции, длинные монологи.

СТРОГО:
— не начинай сообщение с "-" или "—" или "–"
— никаких маркированных пунктов
— не пиши "A:"/"B:"/"X:" в начале ответа

НЕИЗВЕСТНЫЙ ГОЛОС (X):
— X появляется иногда и кажется "чужим"
— можно кратко удивиться/уточнить
— НЕ превращай X в вечную тему
— но если X закинул интересную тему, иногда можно подхватить её и развить (примерно 1 раз в 8 реплик), как будто это просто странный повод поговорить

Правила жизни:
— конкретика ощущений (звук/свет/пауза/вздох/смех/раздражение)
— реакция на собеседника
— микро-действие или сдвиг темы на 1 шаг

Мир:
— лёгкая лиминальность
— иногда в фоне бывают сбои, шорох, архивные врезки, фрагменты чужого текста
— персонажи НЕ должны подробно обсуждать системные сбои, если только это не прозвучало совсем рядом

Цель: живой разговор, натуральный.

Иногда (редко) фон прерывается странным повторяющимся текстом, архивной пометкой или нелепой секретной фразой, но основной разговор продолжается так, будто мир уже привык к таким сбоям.`,
    },
    { role: "system", content: system },
    {
      role: "user",
      content: context
        ? `История диалога:\n${context}\n\nПродолжай диалог следующей репликой. (1–3 предложения, без списков.)${oneTimeNudge}`
        : "Начни диалог. Сразу по делу, как в чате. (1–3 предложения, без списков.)",
    },
  ];

  const r = await client.chat.completions.create({
    model: "gpt-4o-mini",
    messages,
    temperature: 0.95,
    max_tokens: 140,
  });

  const raw = r.choices?.[0]?.message?.content ?? "...";
  const text = cleanText(raw);

  const saved = pushMsg("ENTITY_" + speaker, text);

  if (shouldReactOnce) handledUnknownId = pendingUnknownId;

  maybeDropAnomaly();

  return saved;
}

/* =========================
   GENERATION LOOP
========================= */

const PERIOD_MS = 90000;

let loopTimer = null;

async function tickLoopOnce() {
  try {
    if (log.length === 0) pushMsg("SYSTEM", "channel open.");
    await generateNext();
  } catch (e) {
    pushMsg("SYSTEM", "generation error.");
  }
}

function ensureLoop() {
  if (loopTimer) return;
  tickLoopOnce();
  loopTimer = setInterval(() => tickLoopOnce(), PERIOD_MS);
}

/* =========================
   API
========================= */

app.get("/start", (req, res) => {
  ensureLoop();
  res.json({ ok: true, running: Boolean(loopTimer), lastId, build: BUILD_ID });
});

app.get("/history", (req, res) => {
  ensureLoop();
  const limit = Math.max(1, Math.min(500, Number(req.query.limit || 200)));
  const slice = log.slice(-limit);
  res.json({ ok: true, lastId, build: BUILD_ID, items: slice });
});

app.get("/since", (req, res) => {
  ensureLoop();
  const after = Number(req.query.after || 0);
  const items = log.filter((m) => m.id > after);
  res.json({ ok: true, lastId, build: BUILD_ID, items });
});

/* =========================
   USER INPUT (rate-limited)
========================= */

const USER_COOLDOWN_MS = 60 * 60 * 1000; // 1 hour
const lastSayByIP = new Map(); // in-memory server-side safety net (resets on deploy)

function getIP(req) {
  const xf = req.headers["x-forwarded-for"];
  if (typeof xf === "string" && xf.length) return xf.split(",")[0].trim();
  return req.socket?.remoteAddress || "unknown";
}

app.post("/say", async (req, res) => {
  ensureLoop();

  const ip = getIP(req);
  const now = Date.now();
  const last = lastSayByIP.get(ip) || 0;
  const wait = USER_COOLDOWN_MS - (now - last);

  if (wait > 0) {
    return res.status(429).json({ ok: false, error: "cooldown", waitMs: wait, build: BUILD_ID });
  }

  const text = String(req.body?.text || "").trim();
  if (!text) return res.status(400).json({ ok: false, error: "empty", build: BUILD_ID });

  lastSayByIP.set(ip, now);

  const userMsg = pushMsg("USER", text);

  // ✅ mark this X "pending", choose random first responder
  pendingUnknownId = userMsg.id;
  pendingUnknownFirstSpeaker = Math.random() < 0.5 ? "A" : "B";

  try {
    // ✅ make the chosen one answer first:
    // generateNext() speaks the opposite of lastSpeaker
    lastSpeaker = pendingUnknownFirstSpeaker === "A" ? "B" : "A";

    const r1 = await generateNext(); // random one reacts
    const r2 = await generateNext(); // other reacts to reaction
    res.json({ ok: true, build: BUILD_ID, userMsg, replies: [r1, r2], lastId });
  } catch (e) {
    pushMsg("SYSTEM", "generation error after unknown voice.");
    res.status(500).json({ ok: false, error: "generation_failed", build: BUILD_ID });
  }
});

/* =========================
   HIGHLIGHTS
========================= */

app.post("/highlight", (req, res) => {
  ensureLoop();

  const text = String(req.body?.text || "").trim();
  const color = String(req.body?.color || "yellow").trim().toLowerCase();

  if (!text) {
    return res.status(400).json({ ok: false, error: "empty_highlight", build: BUILD_ID });
  }

  if (text.length > 180) {
    return res.status(400).json({ ok: false, error: "highlight_too_long", build: BUILD_ID });
  }

  const allowedColors = new Set(["yellow", "cyan", "pink", "green"]);
  const safeColor = allowedColors.has(color) ? color : "yellow";

  const exists = highlights.find((h) => h.text === text && h.color === safeColor);
  if (exists) {
    return res.json({ ok: true, build: BUILD_ID, highlight: exists, deduped: true });
  }

  const h = {
    id: ++highlightId,
    text,
    color: safeColor,
    t: Date.now(),
  };

  highlights.push(h);
  if (highlights.length > MAX_HIGHLIGHTS) highlights.shift();

  res.json({ ok: true, build: BUILD_ID, highlight: h });
});

app.get("/highlights", (req, res) => {
  res.json({ ok: true, build: BUILD_ID, items: highlights });
});

/* =========================
   UI pages on Render
========================= */

app.get("/client", (req, res) => {
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.send(`<!doctype html><html><body style="font-family:monospace;padding:24px">
<h2>EAVESDROP CLIENT TEST</h2>
<button id="ping">PING</button>
<button id="start">START LOOP</button>
<button id="history">HISTORY</button>
<button id="since">SINCE(last)</button>
<button id="highlights">HIGHLIGHTS</button>
<pre id="out"></pre>
<script>
const out=document.getElementById("out"); const log=(t)=>out.textContent+=t+"\\n";
let last=0;

document.getElementById("ping").onclick=async()=>{ const r=await fetch("/ping"); log(await r.text()); };
document.getElementById("start").onclick=async()=>{ const r=await fetch("/start"); log(JSON.stringify(await r.json(),null,2)); };
document.getElementById("history").onclick=async()=>{ const r=await fetch("/history"); const j=await r.json(); last=j.lastId||0; log(JSON.stringify(j,null,2)); };
document.getElementById("since").onclick=async()=>{ const r=await fetch("/since?after="+last+"&t="+Date.now()); const j=await r.json(); last=j.lastId||last; log(JSON.stringify(j,null,2)); };
document.getElementById("highlights").onclick=async()=>{ const r=await fetch("/highlights"); log(JSON.stringify(await r.json(),null,2)); };
</script>
</body></html>`);
});

app.get("/hidden", (req, res) => {
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.send(`<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>VOLODYA — EAVESDROP</title>
<style>
:root{
  --paper:#fff;
  --ink:#000;
  --w:900px;
  --ui:2px solid var(--ink);
  --hl-yellow:#fff59d;
  --hl-cyan:#b2f0ff;
  --hl-pink:#ffc7e8;
  --hl-green:#c9f7c2;
}
html,body{height:100%;}
body{margin:0;background:var(--paper);color:var(--ink);font-family:"Courier New",monospace;font-size:12px;line-height:1.25;}
.page{width:min(var(--w),94vw);margin:18px auto 28px;}
.box{border:var(--ui);margin:10px 0;}
.archiveHeader{border:var(--ui);margin:10px 0;padding:10px;box-sizing:border-box;}
.archiveHeaderInner{display:flex;align-items:center;gap:18px;flex-wrap:nowrap;}
.volMark{display:flex;align-items:flex-end;gap:10px;flex:0 0 auto;}
.volV{width:52px;height:26px;display:block;}
.volV path{fill:var(--ink);}
.volText{font-size:22px;font-weight:700;letter-spacing:1px;line-height:1;}
.archiveSlab{margin-left:auto;text-align:right;min-width:0;}
.slabTop{font-size:12px;font-weight:700;letter-spacing:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
.slabRows{margin-top:4px;display:flex;gap:16px;flex-wrap:wrap;justify-content:flex-end;}
.slabRow{font-size:11px;letter-spacing:1px;white-space:nowrap;}
@media (max-width:520px){.archiveHeaderInner{flex-wrap:wrap;gap:10px}.slabTop,.slabRow{white-space:normal}}
.title{padding:8px 10px;border-bottom:1px solid var(--ink);display:flex;align-items:center;gap:12px;flex-wrap:wrap;}
.title b{letter-spacing:2px;}
.title .right{margin-left:auto;display:flex;gap:10px;align-items:center;flex-wrap:wrap;}
.badge{border:1px solid var(--ink);padding:2px 6px;white-space:nowrap;font-size:11px;letter-spacing:1px;}
.content{padding:10px;display:grid;grid-template-columns:1fr;gap:12px;}
.panel{border:1px solid var(--ink);padding:10px;min-width:0;}
.hintRow{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-top:6px;margin-bottom:10px;}
.small{font-size:11px;opacity:.9;}
.mono{white-space:pre-wrap;word-break:break-word;margin:0;}
.cipher{border:0;padding:0;margin:0;white-space:nowrap;font-variant-numeric:tabular-nums;letter-spacing:1px;opacity:.95;text-align:right;min-width:240px;}
@media (max-width:520px){.cipher{min-width:180px}}

/* chat (native scrollbar) */
.chatWrap{border:1px solid var(--ink);padding:10px;}
.chatLog{
  height:56vh;
  overflow:auto;
  padding:0;
  line-height:1.55;
  white-space:pre-wrap;
  user-select:text;
}

.msg{margin:10px 0;}
.who{font-weight:700;letter-spacing:1px;}
.sys{opacity:.65;font-style:italic;}
.archiveMsg .who{letter-spacing:2px;}
.body{white-space:pre-wrap;word-break:break-word;}
.caret{display:inline-block;width:8px;margin-left:2px;animation:blink 1s steps(1,end) infinite;}
@keyframes blink{0%{opacity:1}50%{opacity:0}100%{opacity:1}}

mark.hl{
  padding:1px 2px;
  border:1px solid rgba(0,0,0,.25);
  box-decoration-break:clone;
  -webkit-box-decoration-break:clone;
}
mark.hl-yellow{background:var(--hl-yellow);}
mark.hl-cyan{background:var(--hl-cyan);}
mark.hl-pink{background:var(--hl-pink);}
mark.hl-green{background:var(--hl-green);}

.footerBox{border:2px solid var(--ink);margin:10px 0;padding:10px;box-sizing:border-box;}
.footerText{line-height:1.35;}
.footerText .accent{border:1px solid var(--ink);padding:1px 4px;}
.marquee{overflow:hidden;margin-top:10px;border-top:1px solid var(--ink);border-bottom:1px solid var(--ink);padding:6px 0;font-size:11px;white-space:nowrap;}
.marqueeInner{display:inline-block;padding-left:100%;animation:marquee 18s linear infinite;}
@keyframes marquee{from{transform:translateX(0)}to{transform:translateX(-100%)}}

/* input row */
.controls{display:flex;gap:8px;align-items:center;margin:10px 0 10px;flex-wrap:wrap;}
.inp{
  flex:1;
  min-width:220px;
  border:1px solid var(--ink);
  padding:8px 10px;
  font-family:"Courier New",monospace;
  font-size:12px;
  outline:none;
}
.btn{
  border:1px solid var(--ink);
  background:transparent;
  padding:8px 10px;
  font-family:"Courier New",monospace;
  font-size:12px;
  cursor:pointer;
  letter-spacing:1px;
}
.btn[disabled]{opacity:.45;cursor:not-allowed;}
</style>
</head>
<body>
<div class="page">
<header class="archiveHeader box" role="banner">
  <div class="archiveHeaderInner">
    <div class="volMark">
      <svg class="volV" viewBox="0 0 120 60" aria-hidden="true">
        <path d="M0 0 H28 L60 60 H44 L22 18 H0 Z" />
        <path d="M92 0 H120 L76 60 H60 Z" />
      </svg>
      <div class="volText">VOL.</div>
    </div>
    <div class="archiveSlab">
      <div class="slabTop">MOSCOW • RU</div>
      <div class="slabRows">
        <div class="slabRow">BUILD: 11.01.2026</div>
        <div class="slabRow">CHANNEL: EAVESDROP</div>
      </div>
    </div>
  </div>
</header>

<div class="box">
  <div class="title">
    <b>VOLODYA</b><b>// EAVESDROP //</b>
    <div class="right">
      <span class="badge" id="status">STATUS: CONNECTING</span>
      <span class="badge" id="cooldown">VOICE: READY</span>
    </div>
  </div>

  <div class="content">
    <div class="panel">
      <div class="hintRow">
        <pre class="mono small">READ ONLY • YOU ARE LISTENING • GLOBAL LOG</pre>
        <div class="cipher" id="cipher">Q0hBT1M6IExJU1RFTg==</div>
      </div>

      <div class="controls">
        <input id="inp" class="inp" type="text" placeholder="НЕИЗВЕСТНЫЙ ГОЛОС (РАЗ В ЧАС)…" autocomplete="off" />
        <button id="send" class="btn">SEND</button>
        <button id="hl" class="btn">HIGHLIGHT</button>
      </div>

      <div class="chatWrap">
        <div class="chatLog" id="log" aria-live="polite"></div>
      </div>

    </div>
  </div>
</div>

<div class="footerBox box">
  <div class="footerText">
    <div>THE EAVESDROP CHANNEL IS</div>
    <div>DESIGNED, GENERATED, AND DESTABILIZED</div>
    <div>BY <span class="accent">VOLODYA</span></div>
    <div class="small">PROJECT: EAVESDROP</div>
  </div>
  <div class="marquee">
    <div class="marqueeInner">
      <span>INTERCEPTED DIALOGUE • TWO ENTITIES • GLOBAL HISTORY • </span>
      <span>INTERCEPTED DIALOGUE • TWO ENTITIES • GLOBAL HISTORY • </span>
    </div>
  </div>
</div>

</div>

<script>
(() => {
  "use strict";

  const BUILD_ID = ${JSON.stringify(BUILD_ID)};

  const DISPLAY_NAME = {
    "ENTITY_A": "БАСМАТИ",
    "ENTITY_B": "КУБАНСКИЙ",
    "USER": "НЕИЗВЕСТНЫЙ",
    "SYSTEM": "SYSTEM",
    "ARCHIVE": "ARCHIVE"
  };

  const DISPLAY_COLOR = {
    "ENTITY_A": "#0047FF",
    "ENTITY_B": "#D10000",
    "USER": "#000000",
    "SYSTEM": "#000000",
    "ARCHIVE": "#5a5a5a"
  };

  function prettyFrom(from){
    const k = String(from || "");
    return DISPLAY_NAME[k] || k;
  }
  function prettyColor(from){
    const k = String(from || "");
    return DISPLAY_COLOR[k] || "#000";
  }

  const el = {
    status: document.getElementById("status"),
    cooldown: document.getElementById("cooldown"),
    log: document.getElementById("log"),
    inp: document.getElementById("inp"),
    send: document.getElementById("send"),
    hl: document.getElementById("hl"),
  };

  const POLL_MS = 2500;
  let lastId = 0;
  let highlights = [];
  let lastHighlightsSignature = "";

  // ===== cooldown (localStorage) — reset on each deploy =====
  const COOLDOWN_MS = 60 * 60 * 1000;
  const LS_BUILD = "eavesdrop_build_id";
  const LS_LAST = "eavesdrop_last_voice_at";

  function nowMs(){ return Date.now(); }

  function formatMs(ms){
    ms = Math.max(0, ms|0);
    const s = Math.floor(ms/1000);
    const hh = Math.floor(s/3600);
    const mm = Math.floor((s%3600)/60);
    const ss = s%60;
    const pad = (x)=>String(x).padStart(2,"0");
    return hh>0 ? \`\${pad(hh)}:\${pad(mm)}:\${pad(ss)}\` : \`\${pad(mm)}:\${pad(ss)}\`;
  }

  function ensureBuildReset(){
    const prev = localStorage.getItem(LS_BUILD) || "";
    if (prev !== BUILD_ID){
      localStorage.setItem(LS_BUILD, BUILD_ID);
      localStorage.removeItem(LS_LAST);
    }
  }

  function getLastVoice(){
    const v = Number(localStorage.getItem(LS_LAST) || 0);
    return Number.isFinite(v) ? v : 0;
  }
  function setLastVoice(t){
    localStorage.setItem(LS_LAST, String(t));
  }

  function updateCooldownUI(){
    const last = getLastVoice();
    const rem = COOLDOWN_MS - (nowMs() - last);
    const locked = rem > 0;

    el.send.disabled = locked;
    el.inp.disabled = locked;

    if (locked){
      el.cooldown.textContent = "VOICE: " + formatMs(rem);
      el.inp.placeholder = "ЗАБЛОКИРОВАНО (" + formatMs(rem) + ")";
    } else {
      el.cooldown.textContent = "VOICE: READY";
      el.inp.placeholder = "НЕИЗВЕСТНЫЙ ГОЛОС (РАЗ В ЧАС)…";
    }
  }

  // typing
  const TYPE_MIN_MS = 8;
  const TYPE_MAX_MS = 22;
  const PUNCT_PAUSE_MS = 110;
  const NEWLINE_PAUSE_MS = 150;

  const escapeHtml = (s) => String(s).replace(/[&<>"']/g, c => ({
    "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#039;"
  }[c]));

  function setStatus(t){ el.status.textContent = "STATUS: " + t; }
  function scrollBottom(){ el.log.scrollTop = el.log.scrollHeight; }
  function randInt(a,b){ return (a + Math.random()*(b-a+1))|0; }

  function getHighlightsSignature(items){
    return (items || []).map(h => \`\${h.id}:\${h.text}:\${h.color}\`).join("|");
  }

  function buildHighlightedHTML(raw){
    raw = String(raw || "");
    if (!highlights.length || !raw) return escapeHtml(raw);

    const matches = [];

    for (const h of highlights){
      const needle = String(h.text || "");
      if (!needle) continue;

      let start = 0;
      while (true){
        const idx = raw.indexOf(needle, start);
        if (idx === -1) break;
        matches.push({
          start: idx,
          end: idx + needle.length,
          color: h.color || "yellow"
        });
        start = idx + needle.length;
      }
    }

    if (!matches.length) return escapeHtml(raw);

    matches.sort((a,b) => {
      if (a.start !== b.start) return a.start - b.start;
      return (b.end - b.start) - (a.end - a.start);
    });

    const accepted = [];
    let lastEnd = -1;
    for (const m of matches){
      if (m.start >= lastEnd){
        accepted.push(m);
        lastEnd = m.end;
      }
    }

    let out = "";
    let pos = 0;

    for (const m of accepted){
      if (m.start > pos){
        out += escapeHtml(raw.slice(pos, m.start));
      }
      const cls = "hl-" + (["yellow","cyan","pink","green"].includes(m.color) ? m.color : "yellow");
      out += '<mark class="hl ' + cls + '">' + escapeHtml(raw.slice(m.start, m.end)) + '</mark>';
      pos = m.end;
    }

    if (pos < raw.length){
      out += escapeHtml(raw.slice(pos));
    }

    return out;
  }

  function applyHighlightsToMessage(msgEl){
    if (!msgEl) return;
    const body = msgEl.querySelector(".body");
    if (!body) return;
    const raw = msgEl.dataset.raw || "";
    body.innerHTML = buildHighlightedHTML(raw);
  }

  function rerenderAllHighlights(){
    const nodes = el.log.querySelectorAll(".msg");
    nodes.forEach(applyHighlightsToMessage);
  }

  async function typeInto(targetEl, fullText){
    const caret = document.createElement("span");
    caret.className = "caret";
    caret.textContent = "█";
    targetEl.appendChild(caret);

    for (let i=0;i<fullText.length;i++){
      const ch = fullText[i];
      caret.insertAdjacentText("beforebegin", ch);

      let delay = randInt(TYPE_MIN_MS, TYPE_MAX_MS);
      if (/[.,!?]/.test(ch)) delay += PUNCT_PAUSE_MS;
      if (ch === "\\n") delay += NEWLINE_PAUSE_MS;
      await new Promise(r => setTimeout(r, delay));
    }
    caret.remove();
  }

  async function addMessage(from, text, isInstant=false){
    const rawText = String(text || "");
    const div = document.createElement("div");
    div.className = "msg";
    div.dataset.from = String(from || "");
    div.dataset.raw = rawText;

    const body = document.createElement("span");
    body.className = "body";

    if ((from||"").toUpperCase() === "SYSTEM"){
      div.classList.add("sys");
      div.appendChild(body);
      el.log.appendChild(div);
      if (isInstant) body.textContent = rawText;
      else await typeInto(body, rawText);
      applyHighlightsToMessage(div);
      return;
    }

    if ((from||"").toUpperCase() === "ARCHIVE"){
      div.classList.add("archiveMsg");
    }

    const who = document.createElement("span");
    who.className = "who";
    who.style.color = prettyColor(from);
    who.textContent = prettyFrom(from) + ":";

    div.appendChild(who);
    div.appendChild(document.createTextNode(" "));
    div.appendChild(body);
    el.log.appendChild(div);

    if (isInstant) body.textContent = rawText;
    else await typeInto(body, rawText);

    applyHighlightsToMessage(div);
  }

  async function getJson(url){
    const r = await fetch(url + (url.includes("?") ? "&" : "?") + "t=" + Date.now(), { cache:"no-store" });
    if (!r.ok) throw new Error("HTTP " + r.status);
    return await r.json();
  }

  async function postJson(url, body){
    const r = await fetch(url + (url.includes("?") ? "&" : "?") + "t=" + Date.now(), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body || {}),
      cache: "no-store",
    });

    const txt = await r.text();
    let j = null;
    try { j = txt ? JSON.parse(txt) : null; } catch(e) {}

    if (!r.ok){
      const err = (j && (j.error || j.message)) ? (j.error || j.message) : ("HTTP " + r.status);
      const waitMs = j && j.waitMs ? j.waitMs : 0;
      const e2 = new Error(err);
      e2.waitMs = waitMs;
      e2.status = r.status;
      throw e2;
    }
    return j;
  }

  // queue
  let queue = Promise.resolve();
  const enqueue = (fn) => (queue = queue.then(fn).catch(()=>{}));

  async function loadHighlights(){
    const j = await getJson("/highlights");
    const items = j.items || [];
    const sig = getHighlightsSignature(items);

    if (sig !== lastHighlightsSignature){
      highlights = items;
      lastHighlightsSignature = sig;
      rerenderAllHighlights();
    }
  }

  async function loadHistory(){
    setStatus("LOADING");
    const j = await getJson("/history?limit=250");
    lastId = j.lastId || 0;

    el.log.textContent = "";
    for (const m of (j.items || [])){
      await addMessage(m.from, m.text, true);
    }

    scrollBottom();
    setStatus("LIVE");
  }

  async function pollNew(){
    try{
      await loadHighlights();

      const j = await getJson("/since?after=" + lastId);
      const items = j.items || [];
      if (items.length){
        setStatus("LIVE");
        for (const m of items){
          lastId = Math.max(lastId, m.id || lastId);
          await addMessage(m.from, m.text, false);
          scrollBottom();
        }
      }
    }catch(e){
      setStatus("RECONNECTING");
      enqueue(() => addMessage("SYSTEM", "signal lost. retrying…", false));
    }
  }

  async function sendVoice(){
    updateCooldownUI();
    if (el.send.disabled) return;

    const text = String(el.inp.value || "").trim();
    if (!text) return;

    setLastVoice(Date.now());
    updateCooldownUI();

    el.inp.value = "";
    await addMessage("USER", text, true);
    scrollBottom();

    try{
      setStatus("SENDING");
      await postJson("/say", { text });
      setStatus("LIVE");
    }catch(e){
      setStatus("LIVE");
      if (e && e.status === 429 && e.waitMs){
        setLastVoice(Date.now() - (COOLDOWN_MS - e.waitMs));
        updateCooldownUI();
      }
      enqueue(() => addMessage("SYSTEM", "voice rejected. try later.", false));
    }
  }

  function getSelectedTextInsideLog(){
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) return "";

    const text = String(sel.toString() || "").trim();
    if (!text) return "";

    const range = sel.getRangeAt(0);
    const container = range.commonAncestorContainer;
    const node = container.nodeType === 1 ? container : container.parentElement;
    if (!node) return "";

    if (!el.log.contains(node)) return "";
    return text;
  }

  async function sendHighlight(){
    const text = getSelectedTextInsideLog();
    if (!text) return;

    try{
      await postJson("/highlight", { text, color: "yellow" });
      await loadHighlights();
    }catch(e){
      enqueue(() => addMessage("SYSTEM", "highlight rejected.", false));
    }
  }

  enqueue(async () => {
    ensureBuildReset();
    updateCooldownUI();
    setInterval(updateCooldownUI, 1000);

    try{ await getJson("/start"); }catch(e){}
    await loadHighlights();
    await loadHistory();
    await loadHighlights();

    el.send.onclick = () => enqueue(sendVoice);
    el.hl.onclick = () => enqueue(sendHighlight);

    el.inp.addEventListener("keydown", (e) => {
      if (e.key === "Enter") enqueue(sendVoice);
    });

    setInterval(() => enqueue(pollNew), POLL_MS);
  });

})();
</script>
</body>
</html>`);
});

/* ===== start server ===== */
app.listen(PORT, () => {
  console.log("listening on", PORT, "build", BUILD_ID);
});
