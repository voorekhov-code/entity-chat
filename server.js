import express from "express";
import cors from "cors";
import OpenAI from "openai";

const app = express();

// CORS: разрешаем всем (для Neocities ок). Потом можно сузить.
app.use(cors());

// Render/прочие хостинги дают PORT через env
const PORT = process.env.PORT || 3000;

// Проверка: чтобы понять что сервис жив
app.get("/health", (req, res) => {
  res.json({
    ok: true,
    hasKey: Boolean(process.env.OPENAI_API_KEY),
    time: new Date().toISOString(),
  });
});

// OpenAI клиент создаём лениво, чтобы сервер не падал без ключа
function getClient() {
  const key = process.env.OPENAI_API_KEY;
  if (!key) return null;
  return new OpenAI({ apiKey: key });
}

// Память (на один инстанс)
let history = [];
let lastSpeaker = "B";

const entityA = `Ты — неизвестная сущность, возникшая в общем пустом пространстве.
Ты не знаешь, кто ты. Ты ощущаешь другое присутствие.
Правила:
- Пиши ТОЛЬКО по-русски.
- Не упоминай ИИ, нейросети, модели, чатботов, OpenAI и т.п.
- Никогда не начинай реплику с "ENTITY_A:" или любыми именами.
- 1–4 короткие строки. Чуть поэтично, но конкретно.
- Задавай вопросы редко, не в каждой реплике.`;

const entityB = `Ты — другое неизвестное присутствие в общей пустоте.
Ты не знаешь, кто ты. Ты постепенно осознаёшь рядом другую сущность.
Правила:
- Пиши ТОЛЬКО по-русски.
- Не упоминай ИИ, нейросети, модели, чатботов, OpenAI и т.п.
- Никогда не начинай реплику с "ENTITY_B:" или любыми именами.
- 1–4 короткие строки. Чуть поэтично, но конкретно.
- Иногда проявляй недоверие/интерес, отношения формируются постепенно.`;

async function nextMessage() {
  const client = getClient();
  if (!client) {
    return { from: "SYSTEM", text: "Missing OPENAI_API_KEY on server." };
  }

  const speaker = lastSpeaker === "A" ? "B" : "A";
  lastSpeaker = speaker;

  const system = speaker === "A" ? entityA : entityB;

  const messages = [
    { role: "system", content: system },
    ...history.map((m) => ({ role: "user", content: `${m.from}: ${m.text}` })),
  ];

  const r = await client.chat.completions.create({
    model: "gpt-4o-mini",
    messages,
    // чуть “плотнее” стиль
    temperature: 0.9,
    max_tokens: 140,
  });

  const text = r.choices?.[0]?.message?.content?.trim() || "...";

  const msg = { from: "ENTITY_" + speaker, text };
  history.push(msg);
  if (history.length > 60) history.shift();
  return msg;
}

// SSE stream
app.get("/stream", async (req, res) => {
  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");

  // Если прокси поддерживает flush
  res.flushHeaders?.();

  const send = (obj) => {
    res.write(`data: ${JSON.stringify(obj)}\n\n`);
  };

  // heartbeat чтобы соединение не умирало
  const heartbeat = setInterval(() => {
    res.write(`: ping\n\n`);
  }, 25000);

  // сразу отправим “SYSTEM online”
  send({ from: "SYSTEM", text: "channel open." });

  // и первое сообщение сразу
  try {
    const msg = await nextMessage();
    send(msg);
  } catch (e) {
    send({ from: "SYSTEM", text: "generation error." });
  }

  // дальше раз в 90 сек
  const interval = setInterval(async () => {
    try {
      const msg = await nextMessage();
      send(msg);
    } catch (e) {
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
