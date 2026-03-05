import express from "express";
import cors from "cors";
import OpenAI from "openai";

const app = express();
app.use(cors());

const PORT = process.env.PORT || 3000;

// health check
app.get("/health", (req, res) => {
  res.json({
    ok: true,
    hasKey: Boolean(process.env.OPENAI_API_KEY),
    time: new Date().toISOString(),
  });
});

// OpenAI client (lazy)
function getClient() {
  const key = process.env.OPENAI_API_KEY;
  if (!key) return null;
  return new OpenAI({ apiKey: key });
}

// memory (per instance)
let history = [];
let lastSpeaker = "B";

// Characters
const entityA = `Ты — Сущность А. Ты не знаешь, кто ты, и не считаешь себя "ИИ".
Ты говоришь простым, местами быдловатым языком, можешь матюкнуться (но без жести и без ненависти).
Ты часто не вдупляешь и переспрашиваешь. Ты прямолинейный, резкий, но не злой.
Правила:
- Пиши ТОЛЬКО по-русски.
- НЕ начинай реплику с "ENTITY_A:" или "Сущность А:".
- 1 короткое сообщение в одном ответе (как в чате), без поэзии.
- Всегда реагируй на реплику собеседника.
- Не упоминай ИИ, нейросети, модели, OpenAI.`;

const entityB = `Ты — Сущность B. Ты не знаешь, кто ты, и не считаешь себя "ИИ".
Ты псевдо-умный: говоришь уверенно, используешь умные слова, но иногда несёшь чушь.
Стиль НЕ поэтический, а "умничающий" и суховатый, как будто ты всё анализируешь.
Правила:
- Пиши ТОЛЬКО по-русски.
- НЕ начинай реплику с "ENTITY_B:" или "Сущность B:".
- 1 короткое сообщение в одном ответе (как в чате), без поэзии.
- Всегда реагируй на реплику собеседника.
- Не упоминай ИИ, нейросети, модели, OpenAI.`;

function cleanText(text) {
  return String(text || "")
    .replace(/^(\s*)(ENTITY_[AB]|СУЩНОСТЬ\s*[AB]|A|B)\s*:\s*/i, "")
    .trim();
}

async function nextMessage() {
  const client = getClient();
  if (!client) return { from: "SYSTEM", text: "Missing OPENAI_API_KEY on server." };

  const speaker = lastSpeaker === "A" ? "B" : "A";
  lastSpeaker = speaker;

  const system = speaker === "A" ? entityA : entityB;

  // история как диалог: текущий говорящий видит свои прошлые реплики как assistant, чужие как user
  const messages = [
    { role: "system", content: "Это разговор двух сущностей. Пиши строго по-русски. Без поэзии." },
    { role: "system", content: system },
    ...history.map((m) => {
      const mSpeaker = m.from === "ENTITY_A" ? "A" : "B";
      const role = mSpeaker === speaker ? "assistant" : "user";
      return { role, content: m.text };
    }),
  ];

  const r = await client.chat.completions.create({
    model: "gpt-4o-mini",
    messages,
    temperature: 0.9,
    max_tokens: 140,
  });

  const raw = r.choices?.[0]?.message?.content ?? "...";
  const text = cleanText(raw);

  const msg = { from: "ENTITY_" + speaker, text };
  history.push(msg);
  if (history.length > 60) history.shift();
  return msg;
}

/**
 * ✅ /once — отдаёт одну реплику (для Neocities polling)
 */
app.get("/once", async (req, res) => {
  try {
    const msg = await nextMessage();
    res.setHeader("Cache-Control", "no-store");
    res.json(msg);
  } catch (e) {
    res.status(500).json({ from: "SYSTEM", text: "generation error" });
  }
});

/**
 * /stream — SSE поток (если захочешь вернуть)
 */
app.get("/stream", async (req, res) => {
  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.setHeader("Content-Encoding", "none");

  res.flushHeaders?.();
  res.write("\n");

  const send = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);

  const heartbeat = setInterval(() => res.write(`: ping\n\n`), 25000);

  send({ from: "SYSTEM", text: "channel open." });

  try {
    send(await nextMessage());
  } catch {
    send({ from: "SYSTEM", text: "generation error." });
  }

  const interval = setInterval(async () => {
    try {
      send(await nextMessage());
    } catch {
      send({ from: "SYSTEM", text: "generation error." });
    }
  }, 90000);

  req.on("close", () => {
    clearInterval(interval);
    clearInterval(heartbeat);
  });
});

app.listen(PORT, () => {
  console.log("listening on", PORT);
});
