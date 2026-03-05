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

  if (req.method === "OPTIONS") {
    return res.sendStatus(204);
  }

  next();

});

app.use(cors());

/* ========================= */

const PORT = process.env.PORT || 3000;

/* ===== health ===== */

app.get("/health", (req,res)=>{

res.json({
ok:true,
hasKey:Boolean(process.env.OPENAI_API_KEY),
time:new Date().toISOString()
});

});

/* ===== ping (debug) ===== */

app.get("/ping",(req,res)=>{

res.setHeader("Content-Type","text/plain");
res.send("pong");

});

/* ===== OpenAI ===== */

function getClient(){

const key=process.env.OPENAI_API_KEY;

if(!key) return null;

return new OpenAI({apiKey:key});

}

/* ===== memory ===== */

let history=[];
let lastSpeaker="B";

/* ===== characters ===== */

const entityA=`Ты — Сущность А.
Ты немного грубоватый и прямолинейный.
Иногда тупишь и переспрашиваешь.
Говоришь просто.

Правила:
- Только русский язык
- Не начинай с ENTITY_A
- 1-3 коротких фразы
- реагируй на собеседника
`;

const entityB=`Ты — Сущность B.
Ты псевдо-умный и любишь умничать.
Используешь сложные слова.

Правила:
- Только русский язык
- Не начинай с ENTITY_B
- 1-3 коротких фразы
- реагируй на собеседника
`;

/* ===== text cleaner ===== */

function cleanText(text){

return String(text||"")
.replace(/^(\s*)(ENTITY_[AB]|СУЩНОСТЬ\s*[AB])\s*:\s*/i,"")
.trim();

}

/* ===== generate message ===== */

async function nextMessage(){

const client=getClient();

if(!client){

return {from:"SYSTEM",text:"Missing OPENAI_API_KEY"};

}

const speaker=lastSpeaker==="A"?"B":"A";

lastSpeaker=speaker;

const system=speaker==="A"?entityA:entityB;

const messages=[

{role:"system",content:"Это диалог двух сущностей. Пиши только по-русски."},

{role:"system",content:system},

...history.map(m=>{

const mSpeaker=m.from==="ENTITY_A"?"A":"B";

const role=mSpeaker===speaker?"assistant":"user";

return {role,content:m.text};

})

];

const r=await client.chat.completions.create({

model:"gpt-4o-mini",
messages,
temperature:0.9,
max_tokens:120

});

const raw=r.choices?.[0]?.message?.content||"...";

const text=cleanText(raw);

const msg={

from:"ENTITY_"+speaker,
text

};

history.push(msg);

if(history.length>60) history.shift();

return msg;

}

/* =========================
   /once  (Neocities)
========================= */

app.get("/once",async(req,res)=>{

try{

const msg=await nextMessage();

res.json(msg);

}catch(e){

res.status(500).json({
from:"SYSTEM",
text:"generation error"
});

}

});

/* =========================
   SSE stream
========================= */

app.get("/stream",async(req,res)=>{

res.setHeader("Content-Type","text/event-stream");
res.setHeader("Cache-Control","no-cache");
res.setHeader("Connection","keep-alive");

const send=obj=>{
res.write(`data: ${JSON.stringify(obj)}\n\n`);
};

send({from:"SYSTEM",text:"channel open"});

try{
send(await nextMessage());
}catch{
send({from:"SYSTEM",text:"generation error"});
}

const interval=setInterval(async()=>{

try{

send(await nextMessage());

}catch{

send({from:"SYSTEM",text:"generation error"});

}

},90000);

req.on("close",()=>{

clearInterval(interval);

});

});
app.get("/client", (req, res) => {
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.send(`<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>EAVESDROP CLIENT TEST</title>
<style>
  body{font-family:monospace;padding:24px}
  button{margin-right:8px}
  pre{border:1px solid #000;padding:12px;white-space:pre-wrap}
</style>
</head>
<body>
<h2>EAVESDROP CLIENT TEST (same-origin)</h2>
<button id="ping">PING</button>
<button id="once">ONCE</button>
<pre id="out"></pre>

<script>
const out = document.getElementById("out");
const log = (t)=> out.textContent += t + "\\n";

document.getElementById("ping").onclick = async ()=>{
  log("ping...");
  const r = await fetch("/ping");
  log("status: " + r.status);
  log("text: " + await r.text());
  log("----");
};

document.getElementById("once").onclick = async ()=>{
  log("once...");
  const r = await fetch("/once?t=" + Date.now(), { cache:"no-store" });
  log("status: " + r.status);
  log("json: " + JSON.stringify(await r.json(), null, 2));
  log("----");
};
</script>
</body>
</html>`);
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
}
html,body{height:100%;}
body{
  margin:0;
  background:var(--paper);
  color:var(--ink);
  font-family:"Courier New", Courier, monospace;
  font-size:12px;
  line-height:1.25;
}
.page{ width:min(var(--w), 94vw); margin:18px auto 28px; }
.box{ border:var(--ui); margin:10px 0; }

.archiveHeader{ border:var(--ui); margin:10px 0; padding:10px; box-sizing:border-box; }
.archiveHeaderInner{ display:flex; align-items:center; gap:18px; flex-wrap:nowrap; }
.volMark{ display:flex; align-items:flex-end; gap:10px; flex:0 0 auto; }
.volV{ width:52px; height:26px; display:block; }
.volV path{ fill:var(--ink); }
.volText{ font-size:22px; font-weight:700; letter-spacing:1px; line-height:1; }
.archiveSlab{ margin-left:auto; text-align:right; min-width:0; }
.slabTop{ font-size:12px; font-weight:700; letter-spacing:2px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.slabRows{ margin-top:4px; display:flex; gap:16px; flex-wrap:wrap; justify-content:flex-end; }
.slabRow{ font-size:11px; letter-spacing:1px; white-space:nowrap; }
@media (max-width:520px){
  .archiveHeaderInner{ flex-wrap:wrap; gap:10px; }
  .slabTop,.slabRow{ white-space:normal; }
}

.title{
  padding:8px 10px;
  border-bottom:1px solid var(--ink);
  display:flex;
  align-items:center;
  gap:12px;
  flex-wrap:wrap;
}
.title b{ letter-spacing:2px; }
.title .right{ margin-left:auto; display:flex; gap:10px; align-items:center; flex-wrap:wrap; }

.badge{
  border:1px solid var(--ink);
  padding:2px 6px;
  white-space:nowrap;
  font-size:11px;
  letter-spacing:1px;
}

.content{ padding:10px; display:grid; grid-template-columns:1fr; gap:12px; }
.panel{ border:1px solid var(--ink); padding:10px; min-width:0; }

.hintRow{
  display:flex;
  align-items:center;
  justify-content:space-between;
  gap:12px;
  margin-top:6px;
  margin-bottom:10px;
}
.small{ font-size:11px; opacity:.9; }
.mono{ white-space:pre-wrap; word-break:break-word; margin:0; }
.cipher{
  border:0; padding:0; margin:0;
  white-space:nowrap;
  font-variant-numeric:tabular-nums;
  letter-spacing:1px;
  opacity:.95;
  text-align:right;
  min-width:240px;
}
@media (max-width:520px){ .cipher{ min-width:180px; } }

.chatLog{
  border:1px solid var(--ink);
  height:62vh;
  overflow:auto;
  padding:10px;
  line-height:1.55;
  white-space:pre-wrap;
}
.msg{ margin:10px 0; }
.who{ font-weight:700; letter-spacing:1px; }
.sys{ opacity:.65; font-style:italic; }

.caret{
  display:inline-block;
  width:8px;
  margin-left:2px;
  animation: blink 1s steps(1,end) infinite;
}
@keyframes blink{ 0%{opacity:1} 50%{opacity:0} 100%{opacity:1} }

.footerBox{ border:2px solid var(--ink); margin:10px 0; padding:10px; box-sizing:border-box; }
.footerText{ line-height:1.35; }
.footerText .accent{ border:1px solid var(--ink); padding:1px 4px; }
.marquee{
  overflow:hidden;
  margin-top:10px;
  border-top:1px solid var(--ink);
  border-bottom:1px solid var(--ink);
  padding:6px 0;
  font-size:11px;
  white-space:nowrap;
}
.marqueeInner{
  display:inline-block;
  padding-left:100%;
  animation: marquee 18s linear infinite;
}
@keyframes marquee{ from{transform:translateX(0)} to{transform:translateX(-100%)} }
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
    <b>VOLODYA</b>
    <b>// EAVESDROP //</b>
    <div class="right">
      <span class="badge" id="status">STATUS: CONNECTING</span>
    </div>
  </div>

  <div class="content">
    <div class="panel">
      <div class="hintRow">
        <pre class="mono small">READ ONLY • YOU ARE LISTENING • NEW LINE ~ 90s</pre>
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
      <span>INTERCEPTED DIALOGUE • TWO ENTITIES • UNKNOWN ORIGIN • RELATIONSHIP FORMS • SILENCE MATTERS • </span>
      <span>INTERCEPTED DIALOGUE • TWO ENTITIES • UNKNOWN ORIGIN • RELATIONSHIP FORMS • SILENCE MATTERS • </span>
    </div>
  </div>
</div>

</div>

<script>
(() => {
  "use strict";

  // same-origin endpoints
  const ONCE_URL = "/once";
  const PERIOD_MS = 90000;

  // typing
  const TYPE_MIN_MS = 10;
  const TYPE_MAX_MS = 28;
  const PUNCT_PAUSE_MS = 120;
  const NEWLINE_PAUSE_MS = 160;

  const el = {
    status: document.getElementById("status"),
    log: document.getElementById("log"),
  };

  const escapeHtml = (s) => String(s).replace(/[&<>"']/g, c => ({
    "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#039;"
  }[c]));

  function setStatus(t){ el.status.textContent = "STATUS: " + t; }
  function scrollBottom(){ el.log.scrollTop = el.log.scrollHeight; }
  function randInt(a,b){ return (a + Math.random()*(b-a+1))|0; }

  function addSystemLine(t){
    const div = document.createElement("div");
    div.className = "msg sys";
    div.textContent = t;
    el.log.appendChild(div);
    scrollBottom();
  }

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

  async function addMessageTyped(from, text){
    const div = document.createElement("div");
    div.className = "msg";

    if ((from||"").toUpperCase() === "SYSTEM"){
      div.classList.add("sys");
      el.log.appendChild(div);
      await typeInto(div, String(text||""));
      return;
    }

    div.innerHTML = '<span class="who">' + escapeHtml(from) + ':</span> ';
    const span = document.createElement("span");
    div.appendChild(span);
    el.log.appendChild(div);

    await typeInto(span, String(text||""));
  }

  async function fetchOnce(){
    const r = await fetch(ONCE_URL + "?t=" + Date.now(), { cache:"no-store" });
    if (!r.ok) throw new Error("HTTP " + r.status);
    return await r.json();
  }

  // queue — чтобы печать не накладывалась
  let queue = Promise.resolve();
  const enqueue = (fn) => (queue = queue.then(fn).catch(()=>{}));

  async function tick(){
    try{
      setStatus("LIVE");
      const data = await fetchOnce();
      await addMessageTyped(data.from || "SYSTEM", data.text || "");
    }catch(e){
      setStatus("RECONNECTING");
      await addMessageTyped("SYSTEM", "signal lost. retrying…");
    }
  }

  // start
  setStatus("CONNECTING");
  enqueue(async () => {
    addSystemLine("intercept active. opening channel…");
    // Render sleep: дать проснуться
    await new Promise(r => setTimeout(r, 8000));
    await tick();
  });

  setInterval(() => enqueue(tick), PERIOD_MS);

})();
</script>
</body>
</html>`);
});

/* ===== start ===== */

app.listen(PORT,()=>{

console.log("server running on",PORT);

});
