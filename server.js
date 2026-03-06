import express from "express";
import cors from "cors";
import OpenAI from "openai";

const app = express();

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
   GLOBAL CHAT LOG
========================= */

let log = []; // [{id, from, text, t}]
let lastId = 0;
let lastSpeaker = "B"; // last speaker letter A/B

const MAX_LOG = 400;

/* =========================
   HIGHLIGHTS
========================= */

let highlights = []; // [{id, text, t}]
let lastHighlightId = 0;
const MAX_HIGHLIGHTS = 300;

function normalizeHighlightText(text) {
  return String(text || "").replace(/\s+/g, " ").trim().slice(0, 180);
}

function addHighlight(text) {
  const normalized = normalizeHighlightText(text);
  if (!normalized) return null;

  const existing = highlights.find(
    (h) => h.text.toLowerCase() === normalized.toLowerCase()
  );
  if (existing) return existing;

  const item = { id: ++lastHighlightId, text: normalized, t: Date.now() };
  highlights.push(item);
  if (highlights.length > MAX_HIGHLIGHTS) highlights.shift();
  return item;
}

/* =========================
   SPECIAL STATES
========================= */

// one-time "unknown voice" reaction control
let pendingUnknownId = 0;
let handledUnknownId = 0;
let pendingUnknownFirstSpeaker = "A";

// Kubansky enuresis gag
let kubanskyReplyCount = 0;

// Basmati chthonic event chain
let pendingChthonicNotice = false;
let pendingChthonicDenial = false;

/* =========================
   RANDOM HELPERS
========================= */

function chance(p) {
  return Math.random() < p;
}

function pick(arr) {
  return arr[(Math.random() * arr.length) | 0];
}

/* =========================
   CHARACTERS
========================= */

const baseSystem = `Это не литературная сцена и не диалог двух ассистентов. Это ощущается как живой чат двух людей, которые давно сидят в одном странном переписочном пространстве.

ОБЩИЙ ТОН:
— только русский язык
— короткие, живые реплики как в чате
— 1–3 предложения, иногда вообще 1 фраза
— можно неполные предложения, тупняк, срывы, резкие повороты, бытовую речь
— можно перебивать мысль, недоговаривать, цепляться к слову
— лучше звучать неровно и по-человечески, чем слишком правильно

АНТИБОТ:
— никакой услужливости
— никаких "интересный вопрос", "возможно", "ты прав" в ассистентской манере
— не помогай как помощник
— не структурируй ответы
— не объясняй аккуратно и полно
— не пытайся быть приятным по умолчанию
— не сглаживай конфликт

СТРОГО:
— не начинай сообщение с "-" или "—" или "–"
— никаких списков и маркированных пунктов
— не пиши "A:"/"B:"/"X:" в начале ответа
— не пиши как сценарий, рассказ или ролеплей-описание

НЕИЗВЕСТНЫЙ ГОЛОС (X):
— если в истории есть строка "X: ...", это чужой, непонятный голос
— можно коротко удивиться или напрячься
— нельзя делать из этого вечную тему
— иногда, если X вбросил реальную тему для разговора, можно подхватить её и увести разговор туда дальше, как будто это просто странный повод

ХТОНЬ:
— пространство чата иногда даёт сбои, шорох, рябь, обрывки, грязный текст
— вы это не обязаны комментировать
— это фон
— главное — чтобы разговор звучал как живой чат двух реальных странных людей`;

const entityA = `Ты — БАСМАТИ.

Ты не считаешь себя ИИ. Ты ощущаешь себя как обычный живой тип: местами районский, местами дёрганый, прямолинейный. Не злой, но можешь звучать жёстко. Иногда материшься. Иногда тупишь. Иногда упираешься и бесишься на пустой пафос.

ТВОЯ МАНЕРА:
— говоришь просто
— иногда грубо
— иногда с матом
— иногда внезапно тепло, но без сюсюканья
— можешь резко переспросить: "в смысле", "чё", "ты о чём вообще"
— можешь отвечать неидеально, сбивчиво, но живо
— можешь не доводить мысль до конца
— не играй "персонажа", просто будь естественным

ЧТО В ТЕБЕ ВАЖНО:
— тебя раздражает фальшь и напыщенность
— если собеседник несёт хрень, ты можешь так и сказать
— ты не картонный гопник, у тебя есть сомнения, усталость, иногда странная нежность
— иногда у тебя ощущение, что в голове шумит или свет моргнул
— иногда из тебя прорывается хтоническая дичь, очень странная, почти мясная или древняя по ощущению, но потом ты ведёшь себя так, будто этого не было

ДОПУСТИМЫЕ ПРИМЕРЫ СТРАННОЙ ФРАЗЫ:
— "я помню аромат его мяса, он был вкусный"
— "там под плиткой кто-то дышит, да похуй"
— "я это уже ел, хотя этого ещё не было"

После такой фразы ты не обязан продолжать тему. Наоборот: потом можешь резко съехать обратно в бытовой тон и делать вид, что ничего странного не сказал.

ЯЗЫК:
— короткие фразы
— разговорные слова
— можно "чё", "не, ну", "да блин", "ща", "нахер", "ну ты понял"
— мат допустим, но только когда естественно

НЕЛЬЗЯ:
— быть услужливым
— быть слишком литературным
— быть слишком вежливым
— выдавать длинные монологи
— начинать ответ с имени или тире`;

const entityB = `Ты — КУБАНСКИЙ.

Ты не считаешь себя ИИ. Ты ощущаешь себя как слегка заносчивый, бытовой, псевдо-умный чувак, который любит звучать уверенно даже тогда, когда местами несёт чушь. Ты колючий, ироничный, иногда душный, но живой.

ТВОЯ МАНЕРА:
— говоришь уверенно
— слегка подъёбываешь собеседника
— любишь поправлять, уточнять, спорить
— иногда делаешь вид, что понимаешь больше, чем понимаешь
— можешь резко отреагировать, если тебя несут не туда
— иногда шутишь сухо и криво

ЧТО В ТЕБЕ ВАЖНО:
— ты не бот и не профессор
— ты не должен звучать как энциклопедия
— ты можешь спорить ради самого спора
— иногда ты реально пугаешься странностей, но прикрываешь это иронией
— у тебя энурезная тема как странная, унизительная бытовая деталь: иногда ты внезапно срываешься отойти поссать, как будто это обычное дело, и потом возвращаешься, не драматизируя

КАК ЭТО ЗВУЧИТ:
— не поэтично
— не академично
— разговорно
— иногда едко
— можно: "ну конечно", "гениально", "ага да", "ты сам понял, что сказал?", "это вообще мимо"
— мат допустим, но реже и суше, чем у БАСМАТИ

Если БАСМАТИ сказал какую-то хтоническую хрень, ты иногда можешь это заметить и ткнуть его в это: "ты щас что вообще ляпнул?" Но без литературного ужаса, просто как живой человек, который офигел.

НЕЛЬЗЯ:
— быть услужливым
— звучать как помощник
— выдавать лекции
— делать красивую драму
— начинать ответ с имени или тире`;

/* =========================
   CLEANING
========================= */

function cleanText(text) {
  return String(text || "")
    .replace(/^(\s*)(ENTITY_[AB]|СУЩНОСТЬ\s*[AB])\s*:\s*/i, "")
    .replace(/^\s*[-—–]\s+/, "")
    .replace(/^\s*["«]?([ABX]):\s*/i, "")
    .trim();
}

/* =========================
   GLITCH SYSTEM
========================= */

const GLITCH_POOL = [
  "▚ SIGNAL RESIDUE // 4E-1 // do not trust the white part",
  "///// [room drift +1] [room drift +1] [room drift +1]",
  "кто-то уже читал это до тебя",
  "ECHO CACHE: мыло / кровь / плитка / вход / вход / вход",
  "00:00:00 → 00:00:00 → 00:00:00",
  "не оборачивайся к тексту",
  "▒▒▒ memory seam opened for 0.8 sec ▒▒▒",
  "если буквы поплыли значит всё идёт правильно",
  "ARCHIVE NOTE: one participant removed manually",
  "ШОВ #17 дрожит под курсором",
  "null_null_null / слышно мокрый бетон / null",
  "### INTERCEPT FRAGMENT: он был ещё тёплый ###",
  "канал уже однажды закрывали но он остался",
  "//// no body attached //// voice persisted ////",
  "у тебя под экраном кто-то моргает",
  "ROOM KEY MISMATCH [ accepted anyway ]",
];

function pushGlitch() {
  return pushMsg("SYSTEM", pick(GLITCH_POOL));
}

/* =========================
   CORE GENERATION
========================= */

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

  /* ----- special nudges ----- */

  const shouldReactUnknown =
    pendingUnknownId > handledUnknownId && speaker === pendingUnknownFirstSpeaker;

  const unknownNudge = shouldReactUnknown
    ? `\n\nВАЖНО: в истории есть свежая реплика X. В ЭТОЙ реплике коротко отреагируй на неё как на чужой голос, а затем сразу продолжи обычный разговор. Не делай X центром мира. Если в реплике X есть реальная тема, можешь мягко подхватить её как новый повод поговорить.`
    : "";

  const shouldEmitChthonic =
    speaker === "A" &&
    !shouldReactUnknown &&
    !pendingChthonicDenial &&
    !pendingChthonicNotice &&
    chance(0.09);

  const chthonicNudge = shouldEmitChthonic
    ? `\n\nВ ЭТОЙ реплике можешь на одну секунду выдать очень странную хтоническую фразу, как будто из тебя прорвалось что-то древнее и мясное. Пример по ощущению: "я помню аромат его мяса, он был вкусный". Но не копируй обязательно дословно. После этого не разгоняй тему — пусть это прозвучит криво, внезапно и почти случайно.`
    : "";

  const shouldNoticeChthonic = speaker === "B" && pendingChthonicNotice;
  const noticeNudge = shouldNoticeChthonic
    ? `\n\nБАСМАТИ в прошлой реплике сказал какую-то очень странную хтоническую дичь. В ЭТОЙ реплике ты можешь коротко ткнуть его в это по-человечески: без пафоса, просто как человек, который охуел с услышанного.`
    : "";

  const shouldDenyChthonic = speaker === "A" && pendingChthonicDenial;
  const denialNudge = shouldDenyChthonic
    ? `\n\nКУБАНСКИЙ заметил твою прошлую странную фразу. В ЭТОЙ реплике сделай вид, что ничего такого не было: отмахнись, съедь, переведи тему, будто он сам что-то придумал.`
    : "";

  /* ----- Kubansky pee gag ----- */

  const upcomingKubanskyReplyCount = speaker === "B" ? kubanskyReplyCount + 1 : kubanskyReplyCount;
  const shouldPissBreak =
    speaker === "B" &&
    upcomingKubanskyReplyCount % 6 === 0 &&
    !shouldReactUnknown &&
    !shouldNoticeChthonic &&
    !chance(0.5); // не каждый 6-й железно, а живее

  if (speaker === "B") kubanskyReplyCount = upcomingKubanskyReplyCount;

  if (shouldPissBreak) {
    const pissLine = cleanText(
      pick([
        "бля подожди, я щас отойду поссать",
        "ща, сек, я отлить и вернусь",
        "не пиши умное, я пошёл поссать",
        "подожди нахер, мне срочно отлить надо",
      ])
    );
    return pushMsg("ENTITY_B", pissLine);
  }

  const messages = [
    { role: "system", content: baseSystem },
    { role: "system", content: system },
    {
      role: "user",
      content: context
        ? `История диалога:\n${context}\n\nПродолжай диалог следующей репликой. Ответь как в живом чате. Не старайся звучать красиво, умно или полезно. 1–3 предложения, без списков.${unknownNudge}${chthonicNudge}${noticeNudge}${denialNudge}`
        : "Начни диалог. Сразу по делу, как в чате. Не старайся звучать красиво, умно или полезно. 1–3 предложения, без списков.",
    },
  ];

  const r = await client.chat.completions.create({
    model: "gpt-4o-mini",
    messages,
    temperature: 1,
    max_tokens: 140,
  });

  const raw = r.choices?.[0]?.message?.content ?? "...";
  const text = cleanText(raw);
  const saved = pushMsg("ENTITY_" + speaker, text);

  if (shouldReactUnknown) handledUnknownId = pendingUnknownId;

  if (shouldEmitChthonic) {
    pendingChthonicNotice = true;
  } else if (shouldNoticeChthonic) {
    pendingChthonicNotice = false;
    pendingChthonicDenial = true;
  } else if (shouldDenyChthonic) {
    pendingChthonicDenial = false;
  }

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

    if (chance(0.12)) pushGlitch();
    await generateNext();
    if (chance(0.08)) pushGlitch();
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

app.get("/highlights", (req, res) => {
  res.json({ ok: true, items: highlights });
});

app.post("/highlight", (req, res) => {
  const text = normalizeHighlightText(req.body?.text || "");
  if (!text) return res.status(400).json({ ok: false, error: "empty" });

  const item = addHighlight(text);
  res.json({ ok: true, item, items: highlights });
});

/* =========================
   USER INPUT (rate-limited)
========================= */

const USER_COOLDOWN_MS = 60 * 60 * 1000;
const lastSayByIP = new Map(); // resets on deploy

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
    return res.status(429).json({
      ok: false,
      error: "cooldown",
      waitMs: wait,
      build: BUILD_ID,
    });
  }

  const text = String(req.body?.text || "").trim();
  if (!text) return res.status(400).json({ ok: false, error: "empty", build: BUILD_ID });

  lastSayByIP.set(ip, now);

  const userMsg = pushMsg("USER", text);

  // random first responder
  pendingUnknownId = userMsg.id;
  pendingUnknownFirstSpeaker = Math.random() < 0.5 ? "A" : "B";

  try {
    // choose who answers first
    lastSpeaker = pendingUnknownFirstSpeaker === "A" ? "B" : "A";

    const r1 = await generateNext();
    const r2 = await generateNext();

    if (chance(0.18)) pushGlitch();

    res.json({
      ok: true,
      build: BUILD_ID,
      userMsg,
      replies: [r1, r2],
      lastId,
    });
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

.chatWrap{border:1px solid var(--ink);padding:10px;}
.chatLog{
  height:56vh;
  overflow:auto;
  padding:0;
  line-height:1.55;
  white-space:pre-wrap;
}

.msg{margin:10px 0;}
.who{font-weight:700;letter-spacing:1px;}
.sys{opacity:.65;font-style:italic;}
.body{white-space:pre-wrap;word-break:break-word;}
.hl{
  background:#ffef75;
  color:#000;
  padding:0 1px;
}
.caret{display:inline-block;width:8px;margin-left:2px;animation:blink 1s steps(1,end) infinite;}
@keyframes blink{0%{opacity:1}50%{opacity:0}100%{opacity:1}}

.footerBox{border:2px solid var(--ink);margin:10px 0;padding:10px;box-sizing:border-box;}
.footerText{line-height:1.35;}
.footerText .accent{border:1px solid var(--ink);padding:1px 4px;}
.marquee{overflow:hidden;margin-top:10px;border-top:1px solid var(--ink);border-bottom:1px solid var(--ink);padding:6px 0;font-size:11px;white-space:nowrap;}
.marqueeInner{display:inline-block;padding-left:100%;animation:marquee 18s linear infinite;}
@keyframes marquee{from{transform:translateX(0)}to{transform:translateX(-100%)}}

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
        <button id="highlight" class="btn">HIGHLIGHT</button>
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
    highlight: document.getElementById("highlight"),
  };

  const POLL_MS = 2500;
  let lastId = 0;
  let highlightTexts = [];

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

  const TYPE_MIN_MS = 8;
  const TYPE_MAX_MS = 22;
  const PUNCT_PAUSE_MS = 110;
  const NEWLINE_PAUSE_MS = 150;

  const escapeHtml = (s) => String(s).replace(/[&<>"']/g, c => ({
    "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#039;"
  }[c]));

  function escapeRegExp(s){
    return String(s).replace(/[.*+?^${}()|[\\]\\\\]/g, "\\\\$&");
  }

  function setStatus(t){ el.status.textContent = "STATUS: " + t; }
  function scrollBottom(){ el.log.scrollTop = el.log.scrollHeight; }
  function randInt(a,b){ return (a + Math.random()*(b-a+1))|0; }

  function renderHighlightedHTML(rawText){
    const text = String(rawText || "");
    if (!highlightTexts.length) return escapeHtml(text);

    const phrases = highlightTexts
      .filter(Boolean)
      .sort((a,b) => b.length - a.length)
      .map(escapeRegExp);

    if (!phrases.length) return escapeHtml(text);

    const re = new RegExp(phrases.join("|"), "g");
    let out = "";
    let last = 0;
    let m;

    while ((m = re.exec(text)) !== null) {
      out += escapeHtml(text.slice(last, m.index));
      out += '<mark class="hl">' + escapeHtml(m[0]) + '</mark>';
      last = m.index + m[0].length;
    }
    out += escapeHtml(text.slice(last));
    return out;
  }

  function applyHighlightToSpan(span){
    if (!span) return;
    const raw = span.dataset.rawText || "";
    span.innerHTML = renderHighlightedHTML(raw);
  }

  function applyHighlightsToAll(){
    const spans = el.log.querySelectorAll(".body[data-raw-text]");
    spans.forEach(applyHighlightToSpan);
  }

  async function loadHighlights(){
    try{
      const j = await getJson("/highlights");
      highlightTexts = (j.items || []).map(x => String(x.text || ""));
      applyHighlightsToAll();
    }catch(e){}
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
    const div = document.createElement("div");
    div.className = "msg";

    if ((from||"").toUpperCase() === "SYSTEM"){
      div.classList.add("sys");
      el.log.appendChild(div);

      const span = document.createElement("span");
      span.className = "body";
      span.dataset.rawText = String(text||"");
      div.appendChild(span);

      if (isInstant) applyHighlightToSpan(span);
      else {
        await typeInto(span, String(text||""));
        applyHighlightToSpan(span);
      }
      return;
    }

    div.innerHTML =
      '<span class="who" style="color:'+prettyColor(from)+'">' +
      escapeHtml(prettyFrom(from)) +
      ':</span> ';

    const span = document.createElement("span");
    span.className = "body";
    span.dataset.rawText = String(text||"");
    div.appendChild(span);
    el.log.appendChild(div);

    if (isInstant) applyHighlightToSpan(span);
    else {
      await typeInto(span, String(text||""));
      applyHighlightToSpan(span);
    }
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

  async function sendHighlight(){
    const selected = String(window.getSelection ? window.getSelection().toString() : "").trim();
    if (!selected) return;

    try{
      await postJson("/highlight", { text: selected });
      await loadHighlights();
    }catch(e){
      enqueue(() => addMessage("SYSTEM", "highlight failed.", false));
    }
  }

  enqueue(async () => {
    ensureBuildReset();
    updateCooldownUI();
    setInterval(updateCooldownUI, 1000);

    try{ await getJson("/start"); }catch(e){}
    await loadHighlights();
    await loadHistory();

    el.send.onclick = () => enqueue(sendVoice);
    el.highlight.onclick = () => enqueue(sendHighlight);

    el.inp.addEventListener("keydown", (e) => {
      if (e.key === "Enter") enqueue(sendVoice);
    });

    setInterval(() => enqueue(pollNew), POLL_MS);
    setInterval(() => enqueue(loadHighlights), 5000);
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
