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

/* ===== characters ===== */

const entityA = `Ты — Сущность А. Ты считаешь себя районским парнем, и не считаешь себя "ИИ".
Ты говоришь простым, местами быдловатым языком, можешь ругаться матом.
Ты часто не вдупляешь и переспрашиваешь. Ты прямолинейный, резкий, но не злой. Любишь поспорить, имеешь точку зрения.

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
Иногда вставляешь короткие наблюдения: «у меня в голове шумит», «как будто кто-то выключил свет».`;

const entityB = `Ты — Сущность B. Ты считаешь себя студентом Бауманки, и не считаешь себя "ИИ".
Ты псевдо-умный: говоришь уверенно, говоришь при этом бытовым языком, но иногда несёшь чушь, у тебя инурез.
Стиль НЕ поэтический, а едко-надменный и умничающий.

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
Любишь спорить, но не токсично.
Иногда замечаешь странности в тексте и пугаешься, но быстро шутишь, чтобы разрядить.`;

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

async function generateNext() {
  const client = getClient();
  if (!client) return pushMsg("SYSTEM", "Missing OPENAI_API_KEY on server.");

  const speaker = lastSpeaker === "A" ? "B" : "A";
  lastSpeaker = speaker;

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

  const messages = [
    {
      role: "system",
      content: `Это бесконечный диалог двух сущностей. Они не знают, кто они. Только русский язык.

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

Мир (лёгкая хтонь, 5%):
— "комната текста", иногда шорох/рябь/обрыв, но без хоррор-экшена

Цель: живой разговор.`,
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
    temperature: 0.9,
    max_tokens: 140,
  });

  const raw = r.choices?.[0]?.message?.content ?? "...";
  const text = cleanText(raw);

  const saved = pushMsg("ENTITY_" + speaker, text);

  if (shouldReactOnce) handledUnknownId = pendingUnknownId;

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
<pre id="out"></pre>
<script>
const out=document.getElementById("out"); const log=(t)=>out.textContent+=t+"\\n";
let last=0;

document.getElementById("ping").onclick=async()=>{ const r=await fetch("/ping"); log(await r.text()); };
document.getElementById("start").onclick=async()=>{ const r=await fetch("/start"); log(JSON.stringify(await r.json(),null,2)); };
document.getElementById("history").onclick=async()=>{ const r=await fetch("/history"); const j=await r.json(); last=j.lastId||0; log(JSON.stringify(j,null,2)); };
document.getElementById("since").onclick=async()=>{ const r=await fetch("/since?after="+last+"&t="+Date.now()); const j=await r.json(); last=j.lastId||last; log(JSON.stringify(j,null,2)); };
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
:root{--paper:#fff;--ink:#000;--w:900px;--ui:2px solid var(--ink);}
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

/* chat + custom scroll */
.chatWrap{border:1px solid var(--ink);padding:10px;}
.chatLog{
  height:56vh;
  overflow:auto;
  padding:0;
  line-height:1.55;
  white-space:pre-wrap;
  scrollbar-width:none;         /* Firefox hide */
}
.chatLog::-webkit-scrollbar{width:0;height:0;} /* WebKit hide */

.msg{margin:10px 0;}
.who{font-weight:700;letter-spacing:1px;}
.sys{opacity:.65;font-style:italic;}
.caret{display:inline-block;width:8px;margin-left:2px;animation:blink 1s steps(1,end) infinite;}
@keyframes blink{0%{opacity:1}50%{opacity:0}100%{opacity:1}}

.footerBox{border:2px solid var(--ink);margin:10px 0;padding:10px;box-sizing:border-box;}
.footerText{line-height:1.35;}
.footerText .accent{border:1px solid var(--ink);padding:1px 4px;}
.marquee{overflow:hidden;margin-top:10px;border-top:1px solid var(--ink);border-bottom:1px solid var(--ink);padding:6px 0;font-size:11px;white-space:nowrap;}
.marqueeInner{display:inline-block;padding-left:100%;animation:marquee 18s linear infinite;}
@keyframes marquee{from{transform:translateX(0)}to{transform:translateX(-100%)}}

/* input row */
.controls{display:flex;gap:8px;align-items:center;margin:10px 0 10px;}
.inp{
  flex:1;
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

/* ===== custom scroll slider (VOL style) ===== */
.scrollBar{
  border-top:1px solid var(--ink);
  margin-top:10px;
  padding-top:10px;
  display:flex;
  align-items:center;
  gap:10px;
  flex-wrap:wrap;
}
.scrollLabel{font-weight:700;letter-spacing:1px;white-space:nowrap;}
.scrollValue{margin-left:auto;font-variant-numeric:tabular-nums;letter-spacing:1px;opacity:.85;}
.range{
  -webkit-appearance:none;
  appearance:none;
  width:260px;
  max-width:100%;
  height:18px;
  background:transparent;
  outline:none;
  border:1px solid var(--ink);
  padding:0;
}
.range::-webkit-slider-runnable-track{height:18px;background:transparent;}
.range::-webkit-slider-thumb{
  -webkit-appearance:none;
  appearance:none;
  width:14px;
  height:18px;
  background:var(--ink);
  border:0;
  margin-top:0;
}
.range::-moz-range-track{height:18px;background:transparent;border:0;}
.range::-moz-range-thumb{width:14px;height:18px;background:var(--ink);border:0;}
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
      </div>

      <div class="chatWrap">
        <div class="chatLog" id="log" aria-live="polite"></div>

        <div class="scrollBar">
          <div class="scrollLabel">SCROLL</div>
          <input id="scroll" class="range" type="range" min="0" max="1000" step="1" value="1000" />
          <div id="scrollVal" class="scrollValue">END</div>
        </div>
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
    "SYSTEM": "SYSTEM"
  };

  const DISPLAY_COLOR = {
    "ENTITY_A": "#0047FF",
    "ENTITY_B": "#D10000",
    "USER": "#000000",
    "SYSTEM": "#000000"
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
    scroll: document.getElementById("scroll"),
    scrollVal: document.getElementById("scrollVal"),
  };

  const POLL_MS = 2500;
  let lastId = 0;

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

  async function typeInto(targetEl, fullText){
    const caret = document.createElement("span");
    caret.className = "caret";
    caret.textContent = "█";
    targetEl.appendChild(caret);

    for (let i=0;i<fullText.length;i++){
      const ch = fullText[i];
      caret.insertAdjacentText("beforebegin", ch);
      updateScrollSliderFromLog(); // keep slider synced
      let delay = randInt(TYPE_MIN_MS, TYPE_MAX_MS);
      if (/[.,!?]/.test(ch)) delay += PUNCT_PAUSE_MS;
      if (ch === "\\n") delay += NEWLINE_PAUSE_MS;
      await new Promise(r => setTimeout(r, delay));
    }
    caret.remove();
    updateScrollSliderFromLog();
  }

  async function addMessage(from, text, isInstant=false){
    const div = document.createElement("div");
    div.className = "msg";

    if ((from||"").toUpperCase() === "SYSTEM"){
      div.classList.add("sys");
      el.log.appendChild(div);
      if (isInstant) div.textContent = String(text||"");
      else await typeInto(div, String(text||""));
      updateScrollSliderFromLog();
      return;
    }

    div.innerHTML =
      '<span class="who" style="color:'+prettyColor(from)+'">' +
      escapeHtml(prettyFrom(from)) +
      ':</span> ';

    const span = document.createElement("span");
    div.appendChild(span);
    el.log.appendChild(div);

    if (isInstant) span.textContent = String(text||"");
    else await typeInto(span, String(text||""));

    updateScrollSliderFromLog();
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

  // ===== custom scroll slider logic =====
  let stickToBottom = true;

  function getMaxScroll(){
    return Math.max(0, el.log.scrollHeight - el.log.clientHeight);
  }

  function updateScrollSliderFromLog(){
    const max = getMaxScroll();
    const top = el.log.scrollTop;

    // if user is near bottom, stay pinned
    const nearBottom = max - top < 4;
    if (nearBottom) stickToBottom = true;

    const val = max === 0 ? 1000 : Math.round((top / max) * 1000);
    el.scroll.value = String(val);

    if (max === 0) el.scrollVal.textContent = "END";
    else if (val >= 995) el.scrollVal.textContent = "END";
    else el.scrollVal.textContent = String(val).padStart(4,"0");
  }

  function setLogScrollFromSlider(){
    const max = getMaxScroll();
    const v = Number(el.scroll.value || 0);
    const top = max === 0 ? 0 : Math.round((v / 1000) * max);
    stickToBottom = v >= 995;
    el.log.scrollTop = top;
    updateScrollSliderFromLog();
  }

  function maybeAutoScroll(){
    if (stickToBottom) scrollBottom();
  }

  el.log.addEventListener("scroll", () => {
    // if user manually scrolls up -> unstick
    const max = getMaxScroll();
    const top = el.log.scrollTop;
    stickToBottom = (max - top) < 4;
    updateScrollSliderFromLog();
  });

  el.scroll.addEventListener("input", () => setLogScrollFromSlider());

  async function loadHistory(){
    setStatus("LOADING");
    const j = await getJson("/history?limit=250");
    lastId = j.lastId || 0;

    el.log.textContent = "";
    for (const m of (j.items || [])){
      await addMessage(m.from, m.text, true);
    }

    scrollBottom();
    stickToBottom = true;
    updateScrollSliderFromLog();
    setStatus("LIVE");
  }

  async function pollNew(){
    try{
      const j = await getJson("/since?after=" + lastId);
      const items = j.items || [];
      if (items.length){
        setStatus("LIVE");
        for (const m of items){
          lastId = Math.max(lastId, m.id || lastId);
          await addMessage(m.from, m.text, false);
          maybeAutoScroll();
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
    stickToBottom = true;
    maybeAutoScroll();

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

  enqueue(async () => {
    ensureBuildReset();
    updateCooldownUI();
    setInterval(updateCooldownUI, 1000);

    try{ await getJson("/start"); }catch(e){}
    await loadHistory();

    el.send.onclick = () => enqueue(sendVoice);
    el.inp.addEventListener("keydown", (e) => {
      if (e.key === "Enter") enqueue(sendVoice);
    });

    // keep slider sane on resizes
    window.addEventListener("resize", () => updateScrollSliderFromLog());

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
