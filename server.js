import express from "express";
import cors from "cors";
import OpenAI from "openai";

const app = express();

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

let log = [];            // [{id, from, text, t}]
let lastId = 0;          // increasing
let lastSpeaker = "B";   // A/B toggle

const MAX_LOG = 400;

/* ===== characters ===== */

const entityA = `Ты — Сущность А. Ты считаешь себя районским парнем, и не считаешь себя "ИИ".
Ты говоришь простым, местами быдловатым языком, можешь ругаться матом.
Ты часто не вдупляешь и переспрашиваешь. Ты прямолинейный, резкий, но не злой. Любишь поспорить, имеешь точку зрения.
Правила:
- Пиши ТОЛЬКО по-русски.
- НЕ начинай реплику с "ENTITY_A:" или "Сущность А:".
- 1 короткое сообщение в одном ответе (как в чате), без поэзии, простым районным языком.
- Всегда реагируй на реплику собеседника.
- Не упоминай ИИ, нейросети, модели, OpenAI.`;

const entityB = `Ты — Сущность B. Ты считаешь себя студентом Бауманки, и не считаешь себя "ИИ".
Ты псевдо-умный: говоришь уверенно, говоришь при этом бытовым языком, но иногда несёшь чушь, у тебя инурез.
Стиль НЕ поэтический, а едко-надменный и умничающий.
Правила:
- Пиши ТОЛЬКО по-русски.
- НЕ начинай реплику с "ENTITY_B:" или "Сущность B:".
- 1 короткое сообщение, без длинных монологов и лекций.
- Всегда реагируй на собеседника (поправляй/спорь/уточняй).
- Не упоминай ИИ, нейросети, модели, OpenAI.`;

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

async function generateNext() {
  const client = getClient();
  if (!client) return pushMsg("SYSTEM", "Missing OPENAI_API_KEY on server.");

  const speaker = lastSpeaker === "A" ? "B" : "A";
  lastSpeaker = speaker;

  const system = speaker === "A" ? entityA : entityB;

  // Сбор контекста из общего лога (последние N)
  const context = log
    .filter(m => m.from === "ENTITY_A" || m.from === "ENTITY_B")
    .slice(-40)
    .map(m => {
      const who = m.from === "ENTITY_A" ? "A" : "B";
      return `${who}: ${m.text}`;
    })
    .join("\n");

  const messages = [
    { role: "system", content: "Это бесконечный диалог двух сущностей. Они не знают, кто они. Только русский язык." },
    { role: "system", content: system },
    { role: "user", content: context ? `История диалога:\n${context}\n\nПродолжай диалог следующей репликой.` : "Начни диалог. Сразу по делу, как в чате." },
  ];

  const r = await client.chat.completions.create({
    model: "gpt-4o-mini",
    messages,
    temperature: 0.9,
    max_tokens: 120,
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

  // сразу один тик, чтобы появилось первое
  tickLoopOnce();

  loopTimer = setInterval(() => {
    tickLoopOnce();
  }, PERIOD_MS);
}

// Можно “усыплять”, если хочешь, но на Render free инстанс всё равно может уснуть сам.
// Оставим просто ensureLoop().

/* =========================
   API for clients
========================= */

// “разбудить” генератор
app.get("/start", (req, res) => {
  ensureLoop();
  res.json({ ok: true, running: Boolean(loopTimer), lastId });
});

// вся история
app.get("/history", (req, res) => {
  ensureLoop();
  const limit = Math.max(1, Math.min(500, Number(req.query.limit || 200)));
  const slice = log.slice(-limit);
  res.json({ ok: true, lastId, items: slice });
});

// новые после id
app.get("/since", (req, res) => {
  ensureLoop();
  const after = Number(req.query.after || 0);
  const items = log.filter(m => m.id > after);
  res.json({ ok: true, lastId, items });
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
.chatLog{border:1px solid var(--ink);height:62vh;overflow:auto;padding:10px;line-height:1.55;white-space:pre-wrap;}
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
    <div class="right"><span class="badge" id="status">STATUS: CONNECTING</span></div>
  </div>

  <div class="content">
    <div class="panel">
      <div class="hintRow">
        <pre class="mono small">READ ONLY • YOU ARE LISTENING • GLOBAL LOG</pre>
        <div class="cipher" id="cipher">Q0hBT1M6IExJU1RFTg==</div>
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

  const el = {
    status: document.getElementById("status"),
    log: document.getElementById("log"),
  };

  const POLL_MS = 2500; // часто проверяем, но сообщений мало (генерация раз в 90с)
  let lastId = 0;

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

    div.innerHTML = '<span class="who">' + escapeHtml(from) + ':</span> ';
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

  // очередь печати
  let queue = Promise.resolve();
  const enqueue = (fn) => (queue = queue.then(fn).catch(()=>{}));

  async function loadHistory(){
    setStatus("LOADING");
    const j = await getJson("/history?limit=250");
    lastId = j.lastId || 0;

    // историю рисуем БЕЗ печатания (иначе будешь смотреть 10 минут)
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
          // новые сообщения — с печатанием
          await addMessage(m.from, m.text, false);
        }
      }
    }catch(e){
      setStatus("RECONNECTING");
      enqueue(() => addMessage("SYSTEM", "signal lost. retrying…", false));
    }
  }

  // start
  enqueue(async () => {
    // разбудить генератор
    try{ await getJson("/start"); }catch(e){}
    // загрузить историю
    await loadHistory();
    // потом поллить новые
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
