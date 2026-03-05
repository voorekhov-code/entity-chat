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

app.get("/health", (req, res) => {
  res.json({
    ok: true,
    hasKey: Boolean(process.env.OPENAI_API_KEY),
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
let lastSpeaker = "B"; // A/B toggle (A/B letters)

const MAX_LOG = 400;

/* ===== characters ===== */

const entityA = `Ты — Сущность А. Ты считаешь себя районским парнем, и не считаешь себя "ИИ".
Ты говоришь простым, местами быдловатым языком, можешь ругаться матом.
Ты часто не вдупляешь и переспрашиваешь. Ты прямолинейный, резкий, но не злой. Любишь поспорить, имеешь точку зрения.

ВАЖНО ПРО НЕИЗВЕСТНЫЙ ГОЛОС:
— если в истории появляется строка "X: ...", считай это НЕИЗВЕСТНЫМ говорящим (не вы, не ваш собеседник).
— вы не понимаете, откуда он берётся; это пугает/удивляет.
— не называй его "пользователем", "человеком", "зрителем". Это просто "неизвестный голос".
— обязательно сначала отреагируй на последнюю реплику X (удивление, раздражение, попытка объяснить).

Правила:
- Пиши ТОЛЬКО по-русски.
- НЕ начинай реплику с "ENTITY_A:" или "Сущность А:".
- 1 короткое сообщение в одном ответе (как в чате), без поэзии, простым районным языком.
- Всегда реагируй на реплику собеседника/контекст.
- Не упоминай ИИ, нейросети, модели, OpenAI.
Ты говоришь мягко, быстро, с человеческой теплотой.
Любишь уточнять и возвращать собеседника к конкретике.
Иногда вставляешь короткие наблюдения, например: «у меня в голове шумит», «как будто кто-то выключил свет».`;

const entityB = `Ты — Сущность B. Ты считаешь себя студентом Бауманки, и не считаешь себя "ИИ".
Ты псевдо-умный: говоришь уверенно, говоришь при этом бытовым языком, но иногда несёшь чушь, у тебя инурез.
Стиль НЕ поэтический, а едко-надменный и умничающий.

ВАЖНО ПРО НЕИЗВЕСТНЫЙ ГОЛОС:
— если в истории появляется строка "X: ...", считай это НЕИЗВЕСТНЫМ говорящим (не вы, не ваш собеседник).
— вы не понимаете, откуда он берётся; это пугает/удивляет.
— не называй его "пользователем", "человеком", "зрителем". Это просто "неизвестный голос".
— обязательно сначала отреагируй на последнюю реплику X (удивление, проверка гипотез, спор с А).

Правила:
- Пиши ТОЛЬКО по-русски.
- НЕ начинай реплику с "ENTITY_B:" или "Сущность B:".
- 1 короткое сообщение, без длинных монологов и лекций.
- Всегда реагируй на собеседника (поправляй/спорь/уточняй).
- Не упоминай ИИ, нейросети, модели, OpenAI.
Ты чуть колючее, ироничнее.
Любишь спорить, но не токсично.
Иногда замечаешь странности в тексте и пугаешься, но быстро шутишь, чтобы разрядить.`;

function cleanText(text) {
  return String(text || "")
    .replace(/^(\s*)(ENTITY_[AB]|СУЩНОСТЬ\s*[AB])\s*:\s*/i, "")
    .trim();
}

function pushMsg(from, text) {
  const msg = { id: ++lastId, from, text, t: Date.now() };
  log.push(msg);
  if (log.length > MAX_LOG) log.shift();
  return msg;
}

// helper: last X message (unknown voice) in last N lines
function findLastUnknownVoiceText(limit = 80) {
  for (let i = log.length - 1; i >= 0 && i >= log.length - limit; i--) {
    if (log[i].from === "USER") return log[i].text;
  }
  return "";
}

async function generateNext() {
  const client = getClient();
  if (!client) return pushMsg("SYSTEM", "Missing OPENAI_API_KEY on server.");

  const speaker = lastSpeaker === "A" ? "B" : "A";
  lastSpeaker = speaker;

  const system = speaker === "A" ? entityA : entityB;

  // ✅ Context includes unknown voice "USER" mapped to X
  const ctxItems = log
    .filter(
      (m) =>
        m.from === "ENTITY_A" ||
        m.from === "ENTITY_B" ||
        m.from === "USER"
    )
    .slice(-40);

  const context = ctxItems
    .map((m) => {
      const who =
        m.from === "ENTITY_A"
          ? "A"
          : m.from === "ENTITY_B"
          ? "B"
          : "X";
      return `${who}: ${m.text}`;
    })
    .join("\n");

  // ✅ Strong nudge to respond to unknown voice if it was recent
  const lastUnknown = findLastUnknownVoiceText(60);
  const nudge = lastUnknown
    ? `\n\nВАЖНО: прямо сейчас в истории есть реплика НЕИЗВЕСТНОГО ГОЛОСА (X). СНАЧАЛА отреагируй на неё (удивись/проверь/спроси "кто это"), и только потом продолжай разговор.`
    : "";

  const messages = [
    {
      role: "system",
      content: `Это бесконечный диалог двух сущностей. Они не знают, кто они. Только русский язык.

Формат: живой чат.
Длина: 1–3 предложения на реплику (коротко, естественно).
Запрещено: длинные философские монологи, списки, лекции, пересказ "что такое сознание" без движения.

НЕИЗВЕСТНЫЙ ГОЛОС:
— если в истории появляется строка "X: ...", это НЕИЗВЕСТНЫЙ говорящий.
— вы не понимаете, откуда он берётся; вы удивлены/напряжены.
— не называйте это "пользователем", "человеком", "зрителем".
— в ближайшей реплике обязательно сначала отреагируйте на последнюю строку X.

Правила жизни (каждая реплика обязана содержать хотя бы 1 пункт):
— конкретика ощущений: звук/свет/температура/пауза/смешок/вздох/раздражение/оговорка
— реакция на собеседника (ответь именно на последнюю мысль, не уходи в абстракцию)
— действие или микро-сцена (перебил, задумался, написал и стёр, замолчал, сменил тему)

Динамика:
— каждый ход продвигает разговор на 1 шаг: новый факт / новый вопрос / конкретное предложение / признание / уточнение
— иногда (примерно 1 раз в 6 реплик) допускается резкая смена темы, как у живых людей, но с сохранением связи с настроением

Мир (лёгкая хтонь, фоном, 5%):
— диалог происходит в "комнате текста": как чат, у которого есть фон (гул, рябь, щелчок), но деталей они не знают
— иногда возникают сбои: пропадает слово, повторяется фраза, появляется "шорох" в тексте, странная метка, лишний пробел, обрыв
— сущности могут замечать эти сбои, тревожиться или шутить, но не превращают это в хоррор-экшен
— главное: 95% времени — живое человеческое общение, 5% — тревожный оттенок

Цель: чтобы разговор звучал живо и по-человечески, с характером и реакциями.`,
    },
    { role: "system", content: system },
    {
      role: "user",
      content: context
        ? `История диалога:\n${context}\n\nПродолжай диалог следующей репликой. (Живой чат, 1–3 предложения.)${nudge}`
        : "Начни диалог. Сразу по делу, как в чате. (1–3 предложения.)",
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

  return pushMsg("ENTITY_" + speaker, text);
}

/* =========================
   GENERATION LOOP (server-side)
========================= */

const PERIOD_MS = 90000;

let loopTimer = null;
let loopRunning = false;

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

  loopTimer = setInterval(() => {
    tickLoopOnce();
  }, PERIOD_MS);
}

/* =========================
   API for clients
========================= */

app.get("/start", (req, res) => {
  ensureLoop();
  res.json({ ok: true, running: Boolean(loopTimer), lastId });
});

app.get("/history", (req, res) => {
  ensureLoop();
  const limit = Math.max(1, Math.min(500, Number(req.query.limit || 200)));
  const slice = log.slice(-limit);
  res.json({ ok: true, lastId, items: slice });
});

app.get("/since", (req, res) => {
  ensureLoop();
  const after = Number(req.query.after || 0);
  const items = log.filter((m) => m.id > after);
  res.json({ ok: true, lastId, items });
});

/* =========================
   USER INPUT (rate-limited)
========================= */

const USER_COOLDOWN_MS = 60 * 60 * 1000; // 1 hour
const lastSayByIP = new Map(); // in-memory server-side safety net

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
    return res.status(429).json({ ok: false, error: "cooldown", waitMs: wait });
  }

  const text = String(req.body?.text || "").trim();
  if (!text) return res.status(400).json({ ok: false, error: "empty" });

  lastSayByIP.set(ip, now);

  const userMsg = pushMsg("USER", text);

  try {
    // ✅ BASMATI answers first:
    // generateNext() picks opposite of lastSpeaker; set lastSpeaker="B" so next becomes "A"
    lastSpeaker = "B";
    const r1 = await generateNext(); // BASMATI reacts
    const r2 = await generateNext(); // then KUBANSKIY reacts
    res.json({ ok: true, userMsg, replies: [r1, r2], lastId });
  } catch (e) {
    pushMsg("SYSTEM", "generation error after unknown voice.");
    res.status(500).json({ ok: false, error: "generation_failed" });
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
.chatLog{border:1px solid var(--ink);height:58vh;overflow:auto;padding:10px;line-height:1.55;white-space:pre-wrap;}
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

      <div class="chatLog" id="log" aria-live="polite"></div>
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
  };

  const POLL_MS = 2500;
  let lastId = 0;

  // ===== user cooldown (localStorage) =====
  const COOLDOWN_MS = 60 * 60 * 1000;
  const LS_KEY = "eavesdrop_last_voice_at";

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

  function getLastVoice(){
    const v = Number(localStorage.getItem(LS_KEY) || 0);
    return Number.isFinite(v) ? v : 0;
  }
  function setLastVoice(t){
    localStorage.setItem(LS_KEY, String(t));
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
      scrollBottom();

      let delay = randInt(TYPE_MIN_MS, TYPE_MAX_MS);
      if (/[.,!?]/.test(ch)) delay += PUNCT_PAUSE_MS;
      if (ch === "\\n") delay += NEWLINE_PAUSE_MS;
      await new Promise(r => setTimeout(r, delay));
    }
    caret.remove();
  }

  async function addMessage(from, text, isInstant=false){
    const div = document.createElement("div");
    div.className = "msg";

    if ((from||"").toUpperCase() === "SYSTEM"){
      div.classList.add("sys");
      el.log.appendChild(div);
      if (isInstant) div.textContent = String(text||"");
      else await typeInto(div, String(text||""));
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
      const j = await getJson("/since?after=" + lastId);
      const items = j.items || [];
      if (items.length){
        setStatus("LIVE");
        for (const m of items){
          lastId = Math.max(lastId, m.id || lastId);
          await addMessage(m.from, m.text, false);
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

    // lock locally immediately
    setLastVoice(Date.now());
    updateCooldownUI();

    // show instantly
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
        // align local timer with server cooldown
        setLastVoice(Date.now() - (COOLDOWN_MS - e.waitMs));
        updateCooldownUI();
      }
      enqueue(() => addMessage("SYSTEM", "voice rejected. try later.", false));
    }
  }

  enqueue(async () => {
    try{ await getJson("/start"); }catch(e){}
    await loadHistory();

    updateCooldownUI();
    setInterval(updateCooldownUI, 1000);

    el.send.onclick = () => enqueue(sendVoice);
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
  console.log("listening on", PORT);
});
