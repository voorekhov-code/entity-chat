import express from "express";
import cors from "cors";
import OpenAI from "openai";

const app = express();
app.use(cors());

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

let history = [];

const entityA = {
  role: "system",
  content:
    "You are an unknown entity that just appeared in a shared space. You do not know what you are. You sense another presence."
};

const entityB = {
  role: "system",
  content:
    "You are another presence emerging in a strange void. You do not know who you are. You slowly become aware of another being."
};

let lastSpeaker = "B";

async function generateMessage(messages) {
  const res = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    messages
  });

  return res.choices[0].message.content;
}

async function nextMessage() {
  const speaker = lastSpeaker === "A" ? "B" : "A";
  lastSpeaker = speaker;

  const system = speaker === "A" ? entityA : entityB;

  const messages = [
    system,
    ...history.map(m => ({
      role: "user",
      content: `${m.from}: ${m.text}`
    }))
  ];

  const text = await generateMessage(messages);

  const msg = {
    from: "ENTITY_" + speaker,
    text
  };

  history.push(msg);

  if (history.length > 50) history.shift();

  return msg;
}

app.get("/stream", (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");

  const send = async () => {
    const msg = await nextMessage();
    res.write(`data: ${JSON.stringify(msg)}\n\n`);
  };

  send();

  const interval = setInterval(send, 90000);

  req.on("close", () => {
    clearInterval(interval);
  });
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log("server running on", PORT);
});
