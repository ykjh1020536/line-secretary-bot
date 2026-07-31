require("dotenv").config();

const fs = require("fs");
const path = require("path");
const express = require("express");
const line = require("@line/bot-sdk");
const { createClient } = require("@supabase/supabase-js");

const PORT = process.env.PORT || 3000;
const DATA_FILE = path.join(__dirname, "data", "tasks.json");
const STORE_ID = process.env.SUPABASE_STORE_ID || "line-secretary-bot";
const TZ = "Asia/Taipei";

const lineConfig = {
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.LINE_CHANNEL_SECRET,
};

const client = new line.messagingApi.MessagingApiClient({
  channelAccessToken: lineConfig.channelAccessToken || "missing-token",
});

const supabase =
  process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY
    ? createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY)
    : null;

const app = express();

function emptyStore() {
  return { scopes: {}, nextDebtId: 1, nextEventId: 1, nextTaskId: 1 };
}

async function loadStore() {
  if (supabase) {
    const { data, error } = await supabase
      .from("line_secretary_store")
      .select("data")
      .eq("id", STORE_ID)
      .maybeSingle();
    if (error) throw error;
    return normalizeStore(data?.data || emptyStore());
  }

  if (!fs.existsSync(DATA_FILE)) return emptyStore();
  return normalizeStore(JSON.parse(fs.readFileSync(DATA_FILE, "utf8")));
}

async function saveStore(store) {
  if (supabase) {
    const { error } = await supabase.from("line_secretary_store").upsert({
      id: STORE_ID,
      data: store,
      updated_at: new Date().toISOString(),
    });
    if (error) throw error;
    return;
  }

  fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
  fs.writeFileSync(DATA_FILE, JSON.stringify(store, null, 2));
}

function normalizeStore(store) {
  return {
    scopes: store.scopes || {},
    nextDebtId: store.nextDebtId || 1,
    nextEventId: store.nextEventId || 1,
    nextTaskId: store.nextTaskId || 1,
  };
}

function scopeId(source) {
  return source.groupId || source.roomId || source.userId || "default";
}

function getScope(store, id) {
  store.scopes[id] ||= { debts: [], events: [], tasks: [], people: {} };
  store.scopes[id].people ||= {};
  return store.scopes[id];
}

function nowParts() {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(new Date());
  const map = Object.fromEntries(parts.map((p) => [p.type, p.value]));
  return {
    year: Number(map.year),
    month: Number(map.month),
    day: Number(map.day),
    hour: Number(map.hour),
    minute: Number(map.minute),
  };
}

function dateOnly(date) {
  return `${date.getFullYear()}/${pad(date.getMonth() + 1)}/${pad(date.getDate())}`;
}

function pad(n) {
  return String(n).padStart(2, "0");
}

function addDays(base, days) {
  const date = new Date(base.getFullYear(), base.getMonth(), base.getDate());
  date.setDate(date.getDate() + days);
  return date;
}

function taipeiToday() {
  const n = nowParts();
  return new Date(n.year, n.month - 1, n.day);
}

function normalizeInput(text) {
  return text.trim().replace(/^／/, "/").replace(/\s+/g, " ");
}

function commandName(text) {
  return normalizeInput(text).replace(/^\/\s*/, "/");
}

function safeEvalAmount(expr) {
  const clean = expr.replace(/,/g, "").trim();
  if (!/^[\d+\-*/().\s]+$/.test(clean)) return null;
  try {
    const value = Function(`"use strict"; return (${clean});`)();
    return Number.isFinite(value) ? Math.round(value) : null;
  } catch {
    return null;
  }
}

function formatMoney(n) {
  return Number(n).toLocaleString("zh-TW");
}

function parseAmount(raw) {
  const match = raw.match(/([\d,]+(?:\s*[+\-*/]\s*[\d,]+)*)/);
  if (!match) return null;
  const amount = safeEvalAmount(match[1]);
  if (amount === null) return null;
  return { amount, expression: match[1], note: raw.replace(match[1], "").trim() };
}

function cleanPersonName(person) {
  return person.trim().replace(/^@+/, "");
}

function mentionTargets(text, mention) {
  return (mention?.mentionees || [])
    .filter((m) => m.type === "user" && m.userId && !m.isSelf)
    .map((m) => {
      const label = text.slice(m.index, m.index + m.length);
      return { label, name: cleanPersonName(label), userId: m.userId };
    });
}

function rememberPerson(scope, person, userId) {
  if (!person || !userId) return;
  scope.people[person] = { userId, name: person, updatedAt: new Date().toISOString() };
}

function attachMention(scope, parsed, targets) {
  if (!parsed || parsed.type === "split" || !parsed.person) return parsed;
  const hit = targets.find((t) => t.name === parsed.person || t.label === parsed.person || `@${t.name}` === parsed.person);
  if (hit) {
    parsed.mentionUserId = hit.userId;
    rememberPerson(scope, parsed.person, hit.userId);
  } else if (scope.people[parsed.person]?.userId) {
    parsed.mentionUserId = scope.people[parsed.person].userId;
  }
  return parsed;
}

function personUserId(scope, name) {
  return scope.people?.[name]?.userId || null;
}

function parseDebt(text) {
  const input = normalizeInput(text);
  if (input.startsWith("分帳 ")) return parseSplit(input);

  let m = input.match(/^欠\s*([^\s\d+\-*/]+)\s*(.*)$/);
  if (m) {
    const parsed = parseAmount(m[2]);
    if (parsed) return { type: "debt", person: cleanPersonName(m[1]), direction: "me_owe", ...parsed };
  }

  m = input.match(/^我\s*(?:要給|給|還)\s*([^\s\d+\-*/]+)\s*(.*)$/);
  if (m) {
    const parsed = parseAmount(m[2]);
    if (parsed) return { type: "payment", person: cleanPersonName(m[1]), direction: "paid_to_them", ...parsed };
  }

  m = input.match(/^@?([^\s]+)\s*(?:要給我|要還我|要給|欠我)\s*(.*)$/);
  if (m) {
    const parsed = parseAmount(m[2]);
    if (parsed) return { type: "debt", person: cleanPersonName(m[1]), direction: "they_owe", ...parsed };
  }

  m = input.match(/^([^\s]+)\s*欠我\s*(.*)$/);
  if (m) {
    const parsed = parseAmount(m[2]);
    if (parsed) return { type: "debt", person: cleanPersonName(m[1]), direction: "they_owe", ...parsed };
  }

  m = input.match(/^還\s*([^\s\d+\-*/]+)\s*(.*)$/);
  if (m) {
    const parsed = parseAmount(m[2]);
    if (parsed) return { type: "payment", person: cleanPersonName(m[1]), direction: "paid_to_them", ...parsed };
  }

  m = input.match(/^給\s*([^\s\d+\-*/]+)\s*(.*)$/);
  if (m) {
    const parsed = parseAmount(m[2]);
    if (parsed) return { type: "payment", person: cleanPersonName(m[1]), direction: "paid_to_them", ...parsed };
  }

  m = input.match(/^@?([^\s\d+\-*/]+)\s*已\s*還\s*(.*)$/);
  if (m) {
    const parsed = parseAmount(m[2]);
    if (parsed) return { type: "payment", person: cleanPersonName(m[1]), direction: "they_paid_me", ...parsed };
  }

  m = input.match(/^([^\s]+)\s*還我\s*(.*)$/);
  if (m) {
    const parsed = parseAmount(m[2]);
    if (parsed) return { type: "payment", person: cleanPersonName(m[1]), direction: "they_paid_me", ...parsed };
  }

  return null;
}

function parseBarePaid(text) {
  const m = normalizeInput(text).match(/^已\s*還\s*(.*)$/);
  if (!m) return null;
  const parsed = parseAmount(m[1]);
  return parsed ? { type: "payment", direction: "paid_to_them", ...parsed } : null;
}

function parseSplit(input) {
  const parts = input.split(" ");
  if (parts.length < 4) return null;
  const amount = safeEvalAmount(parts[1]);
  if (!amount) return null;
  const people = parts.slice(2);
  const share = Math.round(amount / people.length);
  return { type: "split", amount, people, share };
}

function applyDebt(store, scope, parsed, raw) {
  if (parsed.type === "split") {
    const others = parsed.people.filter((p) => p !== "我");
    const created = [];
    for (const person of others) {
      const item = newDebt(store, {
        person,
        amount: parsed.share,
        direction: "they_owe",
        note: `分帳 ${formatMoney(parsed.amount)}`,
        expression: String(parsed.share),
        raw,
        mentionUserId: personUserId(scope, person),
      });
      scope.debts.push(item);
      created.push(item);
    }
    return debtTextMessage(scope, `已分帳\n總金額：${formatMoney(parsed.amount)}\n人數：${parsed.people.length}\n每人：${formatMoney(parsed.share)}\n已記錄：${others.map((p) => `${mentionToken(scope, p)} 欠你 ${formatMoney(parsed.share)}`).join("、")}`);
  }

  const item = newDebt(store, { ...parsed, raw });
  scope.debts.push(item);
  return debtTextMessage(scope, `已記錄 D${item.id}\n${formatDebtLine(item, scope)}\n時間：${formatDateTime(item.createdAt)}`);
}

function newDebt(store, fields) {
  return {
    id: store.nextDebtId++,
    person: fields.person,
    amount: fields.amount,
    direction: fields.direction,
    note: fields.note || "",
    expression: fields.expression || String(fields.amount),
    raw: fields.raw || "",
    mentionUserId: fields.mentionUserId || null,
    createdAt: new Date().toISOString(),
    deleted: false,
  };
}

function debtSigned(item) {
  if (item.direction === "they_owe") return item.amount;
  if (item.direction === "me_owe") return -item.amount;
  if (item.direction === "they_paid_me") return -item.amount;
  if (item.direction === "paid_to_them") return item.amount;
  return 0;
}

function debtSummary(scope, person) {
  const rows = scope.debts.filter((d) => !d.deleted && (!person || d.person === person));
  const totals = new Map();
  for (const row of rows) totals.set(row.person, (totals.get(row.person) || 0) + debtSigned(row));
  if (!totals.size) return textMessage(person ? `${person} 目前沒有欠款紀錄` : "目前沒有欠款");
  return debtTextMessage(scope, [...totals.entries()]
    .map(([name, value]) => {
      const token = mentionToken(scope, name);
      if (value > 0) return `${token} 欠你 ${formatMoney(value)}`;
      if (value < 0) return `你欠 ${token} ${formatMoney(Math.abs(value))}`;
      return `${token} 已互相結清`;
    })
    .join("\n"));
}

function debtDetails(scope, person) {
  const rows = scope.debts.filter((d) => !d.deleted && (!person || d.person === person)).slice(-30);
  if (!rows.length) return textMessage(person ? `${person} 沒有明細` : "目前沒有欠款明細");
  return debtTextMessage(scope, rows.map((d) => `D${d.id} ${formatDebtLine(d, scope)}\n${formatDateTime(d.createdAt)}${d.note ? `\n註記：${d.note}` : ""}`).join("\n\n"));
}

function editDebt(scope, item, rest, targets = []) {
  const parsedDebt = parseDebt(rest);
  if (parsedDebt && parsedDebt.type !== "split") {
    attachMention(scope, parsedDebt, targets);
    item.person = parsedDebt.person;
    item.amount = parsedDebt.amount;
    item.direction = parsedDebt.direction;
    item.expression = parsedDebt.expression;
    item.note = parsedDebt.note || item.note;
    item.mentionUserId = parsedDebt.mentionUserId || personUserId(scope, parsedDebt.person);
    return true;
  }

  const parsedAmount = parseAmount(rest);
  if (!parsedAmount) return false;
  item.amount = parsedAmount.amount;
  item.expression = parsedAmount.expression;
  if (parsedAmount.note) item.note = parsedAmount.note;
  return true;
}

function mentionToken(scope, person) {
  return personUserId(scope, person) ? `{${personKey(person)}}` : person;
}

function personKey(person) {
  return `u_${Buffer.from(person).toString("hex").slice(0, 18)}`;
}

function textMessage(text) {
  return { type: "text", text };
}

function debtTextMessage(scope, text) {
  const substitution = {};
  for (const [name, person] of Object.entries(scope.people || {})) {
    const key = personKey(name);
    if (!text.includes(`{${key}}`) || !person.userId) continue;
    substitution[key] = { type: "mention", mentionee: { type: "user", userId: person.userId } };
  }
  if (!Object.keys(substitution).length) return textMessage(text);
  return { type: "textV2", text, substitution };
}

function formatDebtLine(d, scope) {
  const person = mentionToken(scope, d.person);
  if (d.direction === "me_owe") return `你欠 ${person} ${formatMoney(d.amount)}`;
  if (d.direction === "they_owe") return `${person} 欠你 ${formatMoney(d.amount)}`;
  if (d.direction === "paid_to_them") return `你還 ${person} ${formatMoney(d.amount)}`;
  return `${person} 還你 ${formatMoney(d.amount)}`;
}

function applyBarePaid(store, scope, parsed, raw) {
  const balances = new Map();
  for (const debt of scope.debts.filter((d) => !d.deleted)) {
    balances.set(debt.person, (balances.get(debt.person) || 0) + debtSigned(debt));
  }
  const candidates = [...balances.entries()].filter(([, balance]) => balance < 0);
  if (candidates.length === 1) {
    const item = newDebt(store, {
      ...parsed,
      person: candidates[0][0],
      direction: "paid_to_them",
      raw,
    });
    scope.debts.push(item);
    return { changed: true, reply: debtTextMessage(scope, `已記錄 D${item.id}\n${formatDebtLine(item, scope)}\n時間：${formatDateTime(item.createdAt)}`) };
  }
  if (!candidates.length) {
    return { changed: false, reply: "目前沒有你欠別人的帳。請改成：已還@A 350" };
  }
  const list = candidates.map(([person, balance]) => `${person}：你欠 ${formatMoney(Math.abs(balance))}`).join("\n");
  return { changed: false, reply: `請補人名，避免記錯。\n例：已還@A ${formatMoney(parsed.amount)}\n\n目前你欠：\n${list}` };
}

function parseEvent(text) {
  const input = normalizeInput(text);
  let m = input.match(/^(今天|明天|後天)\s+(\d{1,2})[:.：](\d{0,2})\s*(.+)$/);
  if (m) {
    const base = addDays(taipeiToday(), { 今天: 0, 明天: 1, 後天: 2 }[m[1]]);
    return eventFromParts(base.getFullYear(), base.getMonth() + 1, base.getDate(), Number(m[2]), Number(m[3] || 0), m[4]);
  }

  m = input.match(/^(\d{1,2})\/(\d{1,2})-(\d{1,2})\s+(.+)$/);
  if (m) {
    const year = nowParts().year;
    return {
      start: `${year}/${pad(m[1])}/${pad(m[2])}`,
      end: `${year}/${pad(m[1])}/${pad(m[3])}`,
      title: m[4].trim(),
      done: false,
    };
  }

  m = input.match(/^(?:(\d{4})\/)?(\d{1,2})\/(\d{1,2})\s+(\d{1,2})[:.：](\d{0,2})\s*(.+)$/);
  if (m) {
    const year = Number(m[1] || nowParts().year);
    return eventFromParts(year, Number(m[2]), Number(m[3]), Number(m[4]), Number(m[5] || 0), m[6]);
  }

  return null;
}

function eventFromParts(year, month, day, hour, minute, title) {
  return {
    start: `${year}/${pad(month)}/${pad(day)} ${pad(hour)}:${pad(minute)}`,
    end: null,
    title: title.trim(),
    done: false,
  };
}

function applyEvent(store, scope, parsed) {
  const item = { id: `E${store.nextEventId++}`, ...parsed, createdAt: new Date().toISOString() };
  scope.events.push(item);
  return `已記錄行程 ${item.id}\n${formatEvent(item)}`;
}

function eventList(scope, filter) {
  let events = scope.events.filter((e) => !e.deleted && !e.done);
  const today = taipeiToday();
  const key = filter?.trim();
  if (key === "今天") events = events.filter((e) => e.start.startsWith(dateOnly(today)));
  else if (key === "明天") events = events.filter((e) => e.start.startsWith(dateOnly(addDays(today, 1))));
  else if (key === "本週") {
    const end = addDays(today, 7);
    events = events.filter((e) => new Date(e.start.replace(/\//g, "-")) <= end);
  } else if (key) {
    events = events.filter((e) => e.title.includes(key));
  }
  events.sort((a, b) => a.start.localeCompare(b.start));
  if (!events.length) return key ? `${key} 沒有行程` : "目前沒有行程";
  return events.slice(0, 30).map(formatEvent).join("\n\n");
}

function formatEvent(e) {
  const range = e.end ? `${e.start} - ${e.end}` : e.start;
  return `${e.id} ${range}\n${e.title}`;
}

function formatDateTime(iso) {
  return new Intl.DateTimeFormat("zh-TW", {
    timeZone: TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(iso));
}

function helpMessage() {
  return {
    type: "text",
    text: [
      "可以用這些：",
      "",
      "帳務",
      "欠@A 250",
      "@A 要給200",
      "@A 要給我120",
      "給@A 500",
      "我要給A300",
      "@A 已還800",
      "已還350",
      "欠 A 飲料 80",
      "欠A1000-300-20-30+300",
      "A 欠我 電影票 280",
      "還 A 300",
      "A 還我 200",
      "分帳 1280 我 A B C",
      "/欠",
      "/欠明細",
      "/改欠 D3 300",
      "/刪欠 D3",
      "/結清 A",
      "",
      "行程",
      "今天 15:30 拿包裹",
      "明天 19:00 吃飯",
      "8/10 19.看牙醫",
      "12/15-22 福岡",
      "/行程",
      "/行程 今天",
      "/改行程 E2 8/12 20:00 吃飯",
      "/刪行程 E2",
    ].join("\n"),
    quickReply: {
      items: ["/欠", "/欠明細", "/行程", "/行程 今天", "欠@A 250", "@A 要給200"].map((label) => ({
        type: "action",
        action: { type: "message", label: label.slice(0, 20), text: label },
      })),
    },
  };
}

async function handleText(message, source) {
  const input = commandName(message.text);
  const targets = mentionTargets(message.text, message.mention);
  const store = await loadStore();
  const scope = getScope(store, scopeId(source));

  let reply = null;
  let changed = false;

  if (input === "/" || input === "/說明" || input === "說明" || input === "/ 說明") {
    return helpMessage();
  }

  if (input.startsWith("/欠明細")) {
    reply = debtDetails(scope, input.replace("/欠明細", "").trim());
  } else if (input.startsWith("/欠")) {
    reply = debtSummary(scope, input.replace("/欠", "").trim());
  } else if (input.startsWith("/改欠")) {
    const editMatch = input.match(/^\/改欠\s*(D?\d+)\s*(.+)$/i);
    const rawId = editMatch?.[1];
    const rest = editMatch?.[2]?.trim() || "";
    const id = (rawId || "").replace(/^D/i, "");
    const item = scope.debts.find((d) => String(d.id) === id && !d.deleted);
    if (!rawId || !rest) reply = "用法：/改欠 D3 300";
    else if (!item) reply = `找不到 D${id}`;
    else if (!editDebt(scope, item, rest, targets)) reply = "改不了這筆，例：/改欠 D3 300";
    else {
      reply = debtTextMessage(scope, `已修改 D${item.id}\n${formatDebtLine(item, scope)}`);
      changed = true;
    }
  } else if (input.startsWith("/刪欠")) {
    const id = input.replace("/刪欠", "").trim().replace(/^D/i, "");
    const item = scope.debts.find((d) => String(d.id) === id && !d.deleted);
    reply = item ? `已刪除 D${item.id}` : `找不到 D${id}`;
    if (item) {
      item.deleted = true;
      changed = true;
    }
  } else if (input.startsWith("/結清")) {
    const person = input.replace("/結清", "").trim();
    const balance = scope.debts.filter((d) => !d.deleted && d.person === person).reduce((sum, d) => sum + debtSigned(d), 0);
    if (!person) reply = "用法：/結清 A";
    else if (balance === 0) reply = `${person} 已經是結清狀態`;
    else {
      scope.debts.push(newDebt(store, {
        person,
        amount: Math.abs(balance),
        direction: balance > 0 ? "they_paid_me" : "paid_to_them",
        note: "結清",
        raw: input,
      }));
      reply = debtTextMessage(scope, `已結清 ${mentionToken(scope, person)}`);
      changed = true;
    }
  } else if (input.startsWith("/行程")) {
    reply = eventList(scope, input.replace("/行程", "").trim());
  } else if (input.startsWith("/刪行程")) {
    const id = input.replace("/刪行程", "").trim().toUpperCase();
    const item = scope.events.find((e) => e.id.toUpperCase() === id && !e.deleted);
    reply = item ? `已刪除 ${item.id}` : `找不到 ${id}`;
    if (item) {
      item.deleted = true;
      changed = true;
    }
  } else if (input.startsWith("/完成行程")) {
    const id = input.replace("/完成行程", "").trim().toUpperCase();
    const item = scope.events.find((e) => e.id.toUpperCase() === id && !e.deleted);
    reply = item ? `已完成 ${item.id}` : `找不到 ${id}`;
    if (item) {
      item.done = true;
      changed = true;
    }
  } else if (input.startsWith("/改行程")) {
    const [, id, ...rest] = input.split(" ");
    const item = scope.events.find((e) => e.id.toUpperCase() === (id || "").toUpperCase() && !e.deleted);
    const parsed = parseEvent(rest.join(" "));
    if (!item) reply = `找不到 ${id || ""}`;
    else if (!parsed) reply = "用法：/改行程 E2 8/12 20:00 吃飯";
    else {
      Object.assign(item, parsed);
      reply = `已修改 ${item.id}\n${formatEvent(item)}`;
      changed = true;
    }
  } else {
    const debt = parseDebt(input);
    if (debt) {
      attachMention(scope, debt, targets);
      reply = applyDebt(store, scope, debt, input);
      changed = true;
    } else {
      const barePaid = parseBarePaid(input);
      if (barePaid) {
        const result = applyBarePaid(store, scope, barePaid, input);
        reply = result.reply;
        changed = result.changed;
      }

      const event = reply ? null : parseEvent(input);
      if (event) {
        reply = applyEvent(store, scope, event);
        changed = true;
      }
    }
  }

  if (changed) await saveStore(store);
  if (!reply) return null;
  return typeof reply === "string" ? textMessage(reply) : reply;
}

app.get("/", (_req, res) => {
  res.send("LINE secretary bot is running.");
});

app.post("/webhook", line.middleware(lineConfig), async (req, res) => {
  await Promise.all(
    req.body.events.map(async (event) => {
      if (event.type !== "message" || event.message.type !== "text") return;
      const reply = await handleText(event.message, event.source);
      if (!reply) return;
      await client.replyMessage({ replyToken: event.replyToken, messages: [reply] });
    })
  );
  res.status(200).end();
});

app.listen(PORT, () => {
  console.log(`LINE secretary bot is listening on port ${PORT}`);
});
