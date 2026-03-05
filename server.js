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

/* ===== start ===== */

app.listen(PORT,()=>{

console.log("server running on",PORT);

});
