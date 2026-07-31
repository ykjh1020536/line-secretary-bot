require("dotenv").config();

const fs = require("fs/promises");
const path = require("path");
const express = require("express");
const line = require("@line/bot-sdk");

const config = {
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.LINE_CHANNEL_SECRET
};

const dataFile = path.resolve(process.env.DATA_FILE || "./data/tasks.json");
const port = Number(process.env.PORT || 3000);

if (!config.channelAccessToken || !config.channelSecret) {
  console.warn("Missing LINE_CHANNEL_ACCESS_TOKEN or LINE_CHANNEL_SECRET in environment.");
}

const app = express();
const client = new line.messagingApi.MessagingApiClient({
  channelAccessToken: config.channelAccessToken || ""
});

app.get("/", (_req, res) => {
  res.json({
    ok: true,
    name: "line-secretary-bot",
    usage: ["記 小王 明天回報價格", "查 小王", "全部", "完成 3", "說明"]
  });
});

app.post("/webhook", line.middleware(config), async (req, res) => {
  await Promise.all(req.body.events.map(handleEvent));
  res.sendStatus(200);
});

async function handleEvent(event) {
  if (event.type !== "message" || event.message.type !== "text") {
    return;
  }

  const text = event.message.text.trim();
  const userId = event.source.userId || "unknown";
  const reply = await runCommand(text, userId);

  return client.replyMessage({
    replyToken: event.replyToken,
    messages: [{ type: "text", text: reply }]
  });
}

async function runCommand(text, userId) {
  const store = await readStore();
  const now = new Date().toISOString();

  if (isHelp(text)) {
    return helpText();
  }

  const addMatch = text.match(/^(記|新增|紀錄|記錄)\s+(\S+)\s+(.+)$/);
  if (addMatch) {
    const contact = addMatch[2].trim();
    const content = addMatch[3].trim();
    const task = {
      id: nextId(store),
      userId,
      contact,
      content,
      status: "open",
      createdAt: now,
      completedAt: null
    };

    store.tasks.push(task);
    await writeStore(store);

    return [
      `已記錄 #${task.id}`,
      `對象：${task.contact}`,
      `事項：${task.content}`
    ].join("\n");
  }

  const listByContactMatch = text.match(/^(查|查詢|看)\s+(.+)$/);
  if (listByContactMatch) {
    const keyword = listByContactMatch[2].trim();
    const tasks = store.tasks.filter((task) => {
      return task.userId === userId &&
        task.status === "open" &&
        task.contact.includes(keyword);
    });

    return formatTasks(tasks, `「${keyword}」目前沒有待辦事項。`);
  }

  if (/^(全部|待辦|清單)$/.test(text)) {
    const tasks = store.tasks.filter((task) => task.userId === userId && task.status === "open");
    return formatTasks(tasks, "目前沒有待辦事項。");
  }

  const doneMatch = text.match(/^(完成|解決|done)\s+#?(\d+)$/i);
  if (doneMatch) {
    const id = Number(doneMatch[2]);
    const task = store.tasks.find((item) => item.userId === userId && item.id === id);

    if (!task) {
      return `找不到 #${id} 這筆事項。`;
    }

    if (task.status === "done") {
      return `#${id} 已經完成了。`;
    }

    task.status = "done";
    task.completedAt = now;
    await writeStore(store);
    return `已完成 #${id}：${task.contact} - ${task.content}`;
  }

  return [
    "我看不懂這句，先用下面格式：",
    "",
    "記 小王 明天報價要回覆",
    "查 小王",
    "全部",
    "完成 3",
    "",
    "輸入「說明」可以看完整指令。"
  ].join("\n");
}

function isHelp(text) {
  return /^(說明|help|指令)$/i.test(text);
}

function helpText() {
  return [
    "LINE 秘書指令：",
    "",
    "1. 記錄事情",
    "記 對象 事項",
    "例：記 小王 明天報價要回覆",
    "",
    "2. 查某個對象",
    "查 對象",
    "例：查 小王",
    "",
    "3. 看全部待辦",
    "全部",
    "",
    "4. 完成事項",
    "完成 編號",
    "例：完成 3"
  ].join("\n");
}

function formatTasks(tasks, emptyText) {
  if (tasks.length === 0) {
    return emptyText;
  }

  return tasks
    .sort((a, b) => a.id - b.id)
    .map((task) => `#${task.id} ${task.contact}\n${task.content}`)
    .join("\n\n");
}

function nextId(store) {
  const lastId = store.tasks.reduce((max, task) => Math.max(max, task.id || 0), 0);
  return lastId + 1;
}

async function readStore() {
  try {
    const raw = await fs.readFile(dataFile, "utf8");
    const parsed = JSON.parse(raw);
    return {
      tasks: Array.isArray(parsed.tasks) ? parsed.tasks : []
    };
  } catch (error) {
    if (error.code === "ENOENT") {
      return { tasks: [] };
    }
    throw error;
  }
}

async function writeStore(store) {
  await fs.mkdir(path.dirname(dataFile), { recursive: true });
  await fs.writeFile(dataFile, JSON.stringify(store, null, 2));
}

app.listen(port, () => {
  console.log(`LINE secretary bot is listening on port ${port}`);
});
