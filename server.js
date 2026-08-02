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
const ARCHIVE_GRACE_MINUTES = 30;

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
  store.scopes[id].events ||= [];
  for (const event of store.scopes[id].events) {
    event.reminders ||= [];
    event.reminderOptOut ||= false;
  }
  return store.scopes[id];
}

function clearScope(store, id) {
  store.scopes[id] = { debts: [], events: [], tasks: [], people: {}, actorName: null, actorUserId: null };
  store.nextDebtId = 1;
  store.nextEventId = 1;
  store.nextTaskId = 1;
  return store.scopes[id];
}

function updateActor(scope, source) {
  if (!source.userId) return;
  scope.actorUserId = source.userId;
  scope.actorName ||= "你";
}

async function hydrateActorName(scope, source) {
  if (!source.userId || scope.people?.[scope.actorName]?.userId === source.userId) return;
  try {
    let profile = null;
    if (source.groupId) {
      profile = await client.getGroupMemberProfile(source.groupId, source.userId);
    } else if (source.roomId) {
      profile = await client.getRoomMemberProfile(source.roomId, source.userId);
    } else {
      profile = await client.getProfile(source.userId);
    }
    if (profile?.displayName) {
      scope.actorName = profile.displayName;
      rememberPerson(scope, profile.displayName, source.userId);
    }
  } catch {
    // Profile access can fail if permissions or membership are unavailable; keep a readable fallback.
  }
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

function taipeiNowDate() {
  const n = nowParts();
  return new Date(n.year, n.month - 1, n.day, n.hour, n.minute);
}

function parseTaipeiDateTime(value, fallbackHour = 9, fallbackMinute = 0) {
  const [datePart, timePart] = value.split(" ");
  const [year, month, day] = datePart.split("/").map(Number);
  if (!timePart) return new Date(year, month - 1, day, fallbackHour, fallbackMinute);
  const [hour, minute] = timePart.split(":").map(Number);
  return new Date(year, month - 1, day, hour, minute || 0);
}

function dateTimeString(date) {
  return `${date.getFullYear()}/${pad(date.getMonth() + 1)}/${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
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
  if ((clean.match(/\d+/g) || []).some((part) => part.length > 9)) return null;
  try {
    const value = Function(`"use strict"; return (${clean});`)();
    if (!Number.isFinite(value)) return null;
    const amount = Math.round(value);
    return amount > 0 && amount <= 999999999 ? amount : null;
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

function amountErrorMessage(text, mention = null) {
  if (!/^\s*(?:欠|給|還|我\s*(?:要給|給|還)|@?\S+\s*(?:要給我|要還我|要給|欠我|已\s*還|還我)|已\s*還)/.test(inputWithMentionAliases(text, mention))) {
    return null;
  }
  const numbers = text.match(/\d+/g) || [];
  if (numbers.some((part) => part.length > 9)) return "金額太大或格式異常，沒有記帳。請輸入 999,999,999 以下的金額。";
  if (/\d/.test(text)) return "看起來像帳務，但金額格式讀不到。例：欠@A 100";
  return null;
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

function inputWithMentionAliases(text, mention) {
  let input = normalizeInput(text);
  const targets = mentionTargets(text, mention).sort((a, b) => b.label.length - a.label.length);
  for (const target of targets) {
    input = input.split(target.label).join(`@${target.name} `);
  }
  return normalizeInput(input);
}

function parseDebt(text, mention) {
  const input = inputWithMentionAliases(text, mention);
  if (input.startsWith("分帳 ")) return parseSplit(input);

  let m = input.match(/^欠\s*(@?[^\s\d+\-*/]+)\s*(.*)$/);
  if (m) {
    const parsed = parseAmount(m[2]);
    if (parsed) return { type: "debt", person: cleanPersonName(m[1]), direction: "me_owe", ...parsed };
  }

  m = input.match(/^我\s*(?:要給|給|還)\s*(@?[^\s\d+\-*/]+)\s*(.*)$/);
  if (m) {
    const parsed = parseAmount(m[2]);
    if (parsed) return { type: "payment", person: cleanPersonName(m[1]), direction: "paid_to_them", ...parsed };
  }

  m = input.match(/^(@?[^\s\d+\-*/]+)\s*(?:要給我|要還我|要給|欠我)\s*(.*)$/);
  if (m) {
    const parsed = parseAmount(m[2]);
    if (parsed) return { type: "debt", person: cleanPersonName(m[1]), direction: "they_owe", ...parsed };
  }

  m = input.match(/^(@?[^\s\d+\-*/]+)\s*欠我\s*(.*)$/);
  if (m) {
    const parsed = parseAmount(m[2]);
    if (parsed) return { type: "debt", person: cleanPersonName(m[1]), direction: "they_owe", ...parsed };
  }

  m = input.match(/^還\s*(@?[^\s\d+\-*/]+)\s*(.*)$/);
  if (m) {
    const parsed = parseAmount(m[2]);
    if (parsed) return { type: "payment", person: cleanPersonName(m[1]), direction: "paid_to_them", ...parsed };
  }

  m = input.match(/^給\s*(@?[^\s\d+\-*/]+)\s*(.*)$/);
  if (m) {
    const parsed = parseAmount(m[2]);
    if (parsed) return { type: "payment", person: cleanPersonName(m[1]), direction: "paid_to_them", ...parsed };
  }

  m = input.match(/^(@?[^\s\d+\-*/]+)\s*已\s*還\s*(.*)$/);
  if (m) {
    const parsed = parseAmount(m[2]);
    if (parsed) return { type: "payment", person: cleanPersonName(m[1]), direction: "they_paid_me", ...parsed };
  }

  m = input.match(/^(@?[^\s\d+\-*/]+)\s*還我\s*(.*)$/);
  if (m) {
    const parsed = parseAmount(m[2]);
    if (parsed) return { type: "payment", person: cleanPersonName(m[1]), direction: "they_paid_me", ...parsed };
  }

  return null;
}

function splitKnownPerson(scope, person, rest) {
  const clean = cleanPersonName(person);
  const names = Object.keys(scope.people || {}).sort((a, b) => b.length - a.length);
  const hit = names.find((name) => clean.startsWith(name) && clean.length > name.length);
  if (!hit) return { person: clean, rest };
  return { person: hit, rest: `${clean.slice(hit.length)}${rest || ""}` };
}

function normalizeParsedDebtPerson(scope, parsed) {
  if (!parsed || parsed.type === "split" || !parsed.person) return parsed;
  if (personUserId(scope, parsed.person)) return parsed;
  const split = splitKnownPerson(scope, parsed.person, parsed.note ? `${parsed.note}${parsed.expression}` : parsed.expression);
  if (split.person === parsed.person) return parsed;
  const reparsed = parseAmount(split.rest);
  if (!reparsed) return parsed;
  return { ...parsed, person: split.person, ...reparsed };
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
  const people = [...new Set(parts.slice(2).map(cleanPersonName))];
  return { type: "split", amount, people };
}

function applyDebt(store, scope, parsed, raw) {
  if (parsed.type === "split") {
    const others = parsed.people.filter((p) => p !== "我" && p !== scope.actorName && personUserId(scope, p) !== scope.actorUserId);
    if (!others.length) return textMessage("這筆沒有分帳：名單裡只有自己。");
    const participants = ["我", ...others];
    const share = Math.round(parsed.amount / participants.length);
    const created = [];
    for (const person of others) {
      const item = newDebt(store, {
        person,
        amount: share,
        direction: "they_owe",
        note: `分帳 ${formatMoney(parsed.amount)}`,
        expression: String(share),
        raw,
        mentionUserId: personUserId(scope, person),
        actorName: scope.actorName,
        actorUserId: scope.actorUserId,
      });
      scope.debts.push(item);
      created.push(item);
    }
    return debtTextMessage(scope, [
      "已分帳",
      `總金額：${formatMoney(parsed.amount)}`,
      `分帳人數：${participants.length}（含付款人）`,
      `每人：${formatMoney(share)}`,
      "",
      ...others.map((p) => `${mentionToken(scope, p)} 欠 ${actorToken(scope)} ${formatMoney(share)}`),
    ].join("\n"));
  }

  const selfCheck = selfDebtReason(scope, parsed);
  if (selfCheck) return textMessage(selfCheck);

  const item = newDebt(store, { ...parsed, raw, actorName: scope.actorName, actorUserId: scope.actorUserId });
  scope.debts.push(item);
  const offset = autoOffsetDebt(scope, item);
  const offsetText = offset ? `\n已自動抵消：${displayDebtRef(scope, offset)}` : "";
  return debtTextMessage(scope, `已記錄 ${displayDebtRef(scope, item)}\n${formatDebtLine(item, scope)}${item.note ? `\n備註：${item.note}` : ""}\n時間：${formatDateTime(item.createdAt)}${offsetText}`);
}

function selfDebtReason(scope, parsed) {
  const parsedUserId = parsed.mentionUserId || personUserId(scope, parsed.person);
  if (parsed.person === scope.actorName || (parsedUserId && parsedUserId === scope.actorUserId)) {
    return "這筆沒有記帳：不能記自己欠自己。請標記對方，例如：欠@A 100";
  }
  return null;
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
    actorName: fields.actorName || null,
    actorUserId: fields.actorUserId || null,
    offsetBy: null,
    createdAt: new Date().toISOString(),
    deleted: false,
  };
}

function debtSigned(item) {
  if (item.offsetBy) return 0;
  if (item.direction === "they_owe") return item.amount;
  if (item.direction === "me_owe") return -item.amount;
  if (item.direction === "they_paid_me") return -item.amount;
  if (item.direction === "paid_to_them") return item.amount;
  return 0;
}

function debtSummary(scope, person) {
  reconcileOffsets(scope);
  const target = cleanPersonName(person || "");
  const rows = scope.debts.filter((d) => !d.deleted && !d.offsetBy && (!target || d.person === target));
  const totals = new Map();
  for (const row of rows) {
    const actor = debtActorName(scope, row);
    const key = `${actor}\u0000${row.person}`;
    const current = totals.get(key) || { actor, person: row.person, value: 0 };
    current.value += debtSigned(row);
    totals.set(key, current);
  }
  const entries = [...totals.entries()].filter(([, entry]) => entry.value !== 0);
  if (!entries.length) return textMessage(target ? `${target} 目前沒有欠款紀錄` : "目前沒有欠款");
  return debtTextMessage(scope, entries
    .map(([, entry]) => {
      const actor = mentionToken(scope, entry.actor);
      const personToken = mentionToken(scope, entry.person);
      if (entry.value > 0) return `${personToken} 欠 ${actor} ${formatMoney(entry.value)}`;
      if (entry.value < 0) return `${actor} 欠 ${personToken} ${formatMoney(Math.abs(entry.value))}`;
      return null;
    })
    .filter(Boolean)
    .join("\n"));
}

function debtDetails(scope, person) {
  reconcileOffsets(scope);
  const target = cleanPersonName(person || "");
  const rows = scope.debts.filter((d) => !d.deleted && !d.offsetBy && (!target || d.person === target)).slice(-30);
  if (!rows.length) return textMessage(target ? `${target} 沒有明細` : "目前沒有欠款明細");
  return debtTextMessage(scope, rows.map((d) => `${displayDebtRef(scope, d)}｜${formatDebtLine(d, scope)}${d.note ? `\n備註：${d.note}` : ""}\n時間：${formatDateTime(d.createdAt)}`).join("\n\n"));
}

function activeDebtRows(scope) {
  reconcileOffsets(scope);
  return scope.debts.filter((d) => !d.deleted && !d.offsetBy);
}

function displayDebtRef(scope, debt) {
  const index = activeDebtRows(scope).findIndex((d) => d.id === debt.id);
  return `#${index >= 0 ? index + 1 : debt.id}`;
}

function findDebtByRef(scope, ref) {
  const raw = ref.trim();
  const clean = raw.replace(/^D/i, "").replace(/^#/, "");
  if (!clean) return null;
  const active = activeDebtRows(scope);
  if (!/^D/i.test(raw)) {
    const byDisplay = active[Number(clean) - 1];
    if (byDisplay) return byDisplay;
  }
  return scope.debts.find((d) => String(d.id) === clean && !d.deleted);
}

function editDebt(scope, item, rest, mention = null, targets = []) {
  const parsedDebt = parseDebt(rest, mention);
  if (parsedDebt && parsedDebt.type !== "split") {
    const normalizedDebt = normalizeParsedDebtPerson(scope, parsedDebt);
    attachMention(scope, normalizedDebt, targets);
    const nextItem = {
      ...item,
      person: normalizedDebt.person,
      amount: normalizedDebt.amount,
      direction: normalizedDebt.direction,
      expression: normalizedDebt.expression,
      note: normalizedDebt.note || item.note,
      mentionUserId: normalizedDebt.mentionUserId || personUserId(scope, normalizedDebt.person),
    };
    if (selfDebtReason(scope, nextItem)) return false;
    item.person = normalizedDebt.person;
    item.amount = normalizedDebt.amount;
    item.direction = normalizedDebt.direction;
    item.expression = normalizedDebt.expression;
    item.note = normalizedDebt.note || item.note;
    item.mentionUserId = normalizedDebt.mentionUserId || personUserId(scope, normalizedDebt.person);
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

function actorToken(scope) {
  return mentionToken(scope, scope.actorName || "你");
}

function debtActorName(scope, debt) {
  return debt.actorName || scope.actorName || "你";
}

function personKey(person) {
  return `u_${Buffer.from(person).toString("hex").slice(0, 18)}`;
}

function textMessage(text) {
  return { type: "text", text };
}

function reminderMessage(event, reminder) {
  return {
    type: "text",
    text: `行程提醒\n${formatEvent(event)}\n提醒：${reminder.label}`,
    quickReply: {
      items: ["知道了", "10分鐘後", "1小時後", "今天晚上", "不再提醒"].map((label) => ({
        type: "action",
        action: { type: "message", label, text: label },
      })),
    },
  };
}

function outboundMessage(message) {
  if (!message || message.type !== "textV2") return message;
  const { fallbackText: _fallbackText, ...clean } = message;
  return clean;
}

function fallbackMessage(message) {
  if (!message || message.type !== "textV2") return null;
  return textMessage(message.fallbackText || message.text);
}

function debtTextMessage(scope, text) {
  const substitution = {};
  let fallbackText = text;
  for (const [name, person] of Object.entries(scope.people || {})) {
    const key = personKey(name);
    if (!text.includes(`{${key}}`) || !person.userId) continue;
    substitution[key] = { type: "mention", mentionee: { type: "user", userId: person.userId } };
    fallbackText = fallbackText.split(`{${key}}`).join(name);
  }
  if (!Object.keys(substitution).length) return textMessage(text);
  return { type: "textV2", text, substitution, fallbackText };
}

function formatDebtLine(d, scope) {
  const person = mentionToken(scope, d.person);
  const actor = mentionToken(scope, debtActorName(scope, d));
  if (d.direction === "me_owe") return `${actor} 欠 ${person} ${formatMoney(d.amount)}`;
  if (d.direction === "they_owe") return `${person} 欠${actor} ${formatMoney(d.amount)}`;
  if (d.direction === "paid_to_them") return `${actor} 還 ${person} ${formatMoney(d.amount)}`;
  return `${person} 還${actor} ${formatMoney(d.amount)}`;
}

function oppositeDirections(a, b) {
  return (
    (a.direction === "me_owe" && b.direction === "they_paid_me") ||
    (a.direction === "they_paid_me" && b.direction === "me_owe") ||
    (a.direction === "they_owe" && b.direction === "paid_to_them") ||
    (a.direction === "paid_to_them" && b.direction === "they_owe")
  );
}

function autoOffsetDebt(scope, item) {
  const match = scope.debts.find((d) =>
    d.id !== item.id &&
    !d.deleted &&
    !d.offsetBy &&
    debtActorName(scope, d) === debtActorName(scope, item) &&
    d.person === item.person &&
    d.amount === item.amount &&
    oppositeDirections(d, item)
  );
  if (!match) return null;
  match.offsetBy = item.id;
  item.offsetBy = match.id;
  return match;
}

function reconcileOffsets(scope) {
  let changed = false;
  const rows = scope.debts.filter((d) => !d.deleted && !d.offsetBy);
  for (const item of rows) {
    if (item.offsetBy) continue;
    const match = scope.debts.find((d) =>
      d.id !== item.id &&
      !d.deleted &&
      !d.offsetBy &&
      debtActorName(scope, d) === debtActorName(scope, item) &&
      d.person === item.person &&
      d.amount === item.amount &&
      oppositeDirections(d, item)
    );
    if (match) {
      item.offsetBy = match.id;
      match.offsetBy = item.id;
      changed = true;
    }
  }
  return changed;
}

function applyBarePaid(store, scope, parsed, raw) {
  const balances = new Map();
  for (const debt of scope.debts.filter((d) => !d.deleted && debtActorName(scope, d) === scope.actorName)) {
    balances.set(debt.person, (balances.get(debt.person) || 0) + debtSigned(debt));
  }
  const candidates = [...balances.entries()].filter(([, balance]) => balance < 0);
  if (candidates.length === 1) {
    const item = newDebt(store, {
      ...parsed,
      person: candidates[0][0],
      direction: "paid_to_them",
      raw,
      actorName: scope.actorName,
      actorUserId: scope.actorUserId,
    });
    scope.debts.push(item);
    const offset = autoOffsetDebt(scope, item);
    const offsetText = offset ? `\n已自動抵消：${displayDebtRef(scope, offset)}` : "";
    return { changed: true, reply: debtTextMessage(scope, `已記錄 ${displayDebtRef(scope, item)}\n${formatDebtLine(item, scope)}${item.note ? `\n備註：${item.note}` : ""}\n時間：${formatDateTime(item.createdAt)}${offsetText}`) };
  }
  if (!candidates.length) {
    return { changed: false, reply: `${scope.actorName || "你"}目前沒有欠別人的帳。請改成：已還@A 350` };
  }
  const list = candidates.map(([person, balance]) => `${person}：${scope.actorName || "你"}欠 ${formatMoney(Math.abs(balance))}`).join("\n");
  return { changed: false, reply: `請補人名，避免記錯。\n例：已還@A ${formatMoney(parsed.amount)}\n\n目前${scope.actorName || "你"}欠：\n${list}` };
}

function parseEvent(text, options = {}) {
  const reminderConfig = parseReminderConfig(text);
  const input = stripReminderConfig(normalizeInput(text));
  let m = input.match(/^(今天|明天|後天)\s+(\d{1,2})[:.：](\d{0,2})\s*(.+)$/);
  if (m) {
    const base = addDays(taipeiToday(), { 今天: 0, 明天: 1, 後天: 2 }[m[1]]);
    return withReminderConfig(eventFromParts(base.getFullYear(), base.getMonth() + 1, base.getDate(), Number(m[2]), Number(m[3] || 0), m[4]), reminderConfig);
  }

  m = input.match(/^(今天|明天|後天)\s+(.+)$/);
  if (m) {
    const base = addDays(taipeiToday(), { 今天: 0, 明天: 1, 後天: 2 }[m[1]]);
    return withReminderConfig({
      start: dateOnly(base),
      end: null,
      title: m[2].trim(),
      done: false,
    }, reminderConfig);
  }

  m = input.match(/^(\d{1,2})\/(\d{1,2})-(\d{1,2})\s+(.+)$/);
  if (m) {
    const year = nowParts().year;
    return withReminderConfig({
      start: `${year}/${pad(m[1])}/${pad(m[2])}`,
      end: `${year}/${pad(m[1])}/${pad(m[3])}`,
      title: m[4].trim(),
      done: false,
    }, reminderConfig);
  }

  m = input.match(/^(?:(\d{4})\/)?(\d{1,2})\/(\d{1,2})\s+(\d{1,2})[:.：](\d{1,2})(?:\s+(.+))?$/);
  if (m) {
    if (!m[6] && !options.allowMissingTitle) return null;
    const year = Number(m[1] || nowParts().year);
    return withReminderConfig(eventFromParts(year, Number(m[2]), Number(m[3]), Number(m[4]), Number(m[5]), m[6] || ""), reminderConfig);
  }

  m = input.match(/^(?:(\d{4})\/)?(\d{1,2})\/(\d{1,2})\s+(.+)$/);
  if (m) {
    const year = Number(m[1] || nowParts().year);
    return withReminderConfig({
      start: `${year}/${pad(m[2])}/${pad(m[3])}`,
      end: null,
      title: m[4].trim(),
      done: false,
    }, reminderConfig);
  }

  return null;
}

function parseChineseNumber(value) {
  if (!value) return null;
  if (/^\d+$/.test(value)) return Number(value);
  const digits = { 零: 0, 〇: 0, 一: 1, 二: 2, 兩: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
  if (value === "十") return 10;
  let m = value.match(/^十([一二兩三四五六七八九])$/);
  if (m) return 10 + digits[m[1]];
  m = value.match(/^([一二兩三四五六七八九])十$/);
  if (m) return digits[m[1]] * 10;
  m = value.match(/^([一二兩三四五六七八九])十([一二兩三四五六七八九])$/);
  if (m) return digits[m[1]] * 10 + digits[m[2]];
  if (value.length === 1 && value in digits) return digits[value];
  return null;
}

function parseReminderConfig(text) {
  const input = normalizeInput(text);
  if (/不提醒/.test(input)) return { mode: "none" };
  let m = input.match(/提醒\s*([0-9零〇一二兩三四五六七八九十]+)\s*(?:分鐘|分)/);
  if (m) return { mode: "before", minutes: parseChineseNumber(m[1]) };
  m = input.match(/提醒\s*([0-9零〇一二兩三四五六七八九十]+)\s*(?:小時|hr|h)/i);
  if (m) return { mode: "before", minutes: parseChineseNumber(m[1]) * 60 };
  if (/提醒前一天|前一天晚上提醒|前一天提醒/.test(input)) return { mode: "preset", preset: "day_before" };
  if (/提醒當天早上|當天早上提醒/.test(input)) return { mode: "preset", preset: "morning" };
  m = input.match(/提醒我?(?:早上|上午)?\s*(\d{1,2})[:.：點]?(\d{0,2})/);
  if (m) return { mode: "clock", hour: Number(m[1]), minute: Number(m[2] || 0) };
  return null;
}

function stripReminderConfig(text) {
  return text
    .replace(/\s*不提醒\s*$/, "")
    .replace(/\s*提醒\s*[0-9零〇一二兩三四五六七八九十]+\s*(?:分鐘|分)\s*$/, "")
    .replace(/\s*提醒\s*[0-9零〇一二兩三四五六七八九十]+\s*(?:小時|hr|h)\s*$/i, "")
    .replace(/\s*(?:提醒前一天|前一天晚上提醒|前一天提醒|提醒當天早上|當天早上提醒)\s*$/, "")
    .replace(/\s*提醒我?(?:早上|上午)?\s*\d{1,2}[:.：點]?\d{0,2}\s*$/, "")
    .trim();
}

function withReminderConfig(event, config) {
  event.reminderConfig = config || null;
  return event;
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
  autoArchiveEvents(scope);
  const item = { id: `E${store.nextEventId++}`, ...parsed, createdAt: new Date().toISOString() };
  item.reminders = buildReminders(item);
  item.reminderOptOut = item.reminderConfig?.mode === "none";
  scope.events.push(item);
  return `已記錄行程 ${displayEventRef(scope, item)}\n${formatEvent(item)}\n提醒：${formatReminderSummary(item)}`;
}

function eventList(scope, filter) {
  autoArchiveEvents(scope);
  let events = scope.events.filter((e) => !e.deleted && !e.done && !e.archived);
  const today = taipeiToday();
  const key = filter?.trim();
  if (key === "今天") events = events.filter((e) => e.start.startsWith(dateOnly(today)));
  else if (key === "明天") events = events.filter((e) => e.start.startsWith(dateOnly(addDays(today, 1))));
  else if (key === "本週") {
    const end = addDays(today, 7);
    events = events.filter((e) => new Date(e.start.replace(/\//g, "-")) <= end);
  } else if (key && /^\d{1,2}\/\d{1,2}/.test(key)) {
    const m = key.match(/^(\d{1,2})\/(\d{1,2})(?:\s+(.+))?/);
    const year = nowParts().year;
    const day = `${year}/${pad(m[1])}/${pad(m[2])}`;
    const keyword = (m[3] || "").trim();
    events = events.filter((e) => e.start.startsWith(day) && (!keyword || e.title.includes(keyword)));
    if (!events.length && keyword) {
      const sameDayEvents = scope.events.filter((e) => !e.deleted && !e.done && e.start.startsWith(day));
      if (sameDayEvents.length) {
        sameDayEvents.sort((a, b) => eventSortValue(a).localeCompare(eventSortValue(b)) || String(a.id).localeCompare(String(b.id)));
        return `8/${Number(m[2])} 沒有「${keyword}」\n\n當天有：\n${sameDayEvents.slice(0, 10).map(formatEvent).join("\n\n")}`;
      }
    }
  } else if (key) {
    events = events.filter((e) => e.title.includes(key));
  }
  events.sort((a, b) => eventSortValue(a).localeCompare(eventSortValue(b)) || String(a.id).localeCompare(String(b.id)));
  if (!events.length) return key ? `${key} 沒有行程` : "目前沒有行程";
  return events.slice(0, 30).map(formatEvent).join("\n\n");
}

function autoArchiveEvents(scope) {
  const now = taipeiNowDate();
  let changed = false;
  for (const event of scope.events || []) {
    if (event.deleted || event.done || event.archived) continue;
    const end = event.end ? parseTaipeiDateTime(event.end, 23, 59) : parseTaipeiDateTime(event.start, event.start.includes(" ") ? 0 : 23, event.start.includes(" ") ? 0 : 59);
    const archiveAfter = new Date(end.getTime() + ARCHIVE_GRACE_MINUTES * 60000);
    if (archiveAfter < now) {
      event.archived = true;
      changed = true;
    }
  }
  return changed;
}

function buildReminders(event) {
  if (event.reminderConfig?.mode === "none") return [];
  const start = parseTaipeiDateTime(event.start);
  const hasTime = event.start.includes(" ");
  const reminders = [];
  const add = (date, label) => {
    if (date >= taipeiNowDate()) reminders.push({ at: dateTimeString(date), label, sent: false });
  };

  if (event.reminderConfig?.mode === "before") {
    add(new Date(start.getTime() - event.reminderConfig.minutes * 60000), `前 ${event.reminderConfig.minutes} 分鐘`);
  } else if (event.reminderConfig?.mode === "clock") {
    const date = new Date(start.getFullYear(), start.getMonth(), start.getDate(), event.reminderConfig.hour, event.reminderConfig.minute);
    add(date, "指定時間");
  } else if (event.reminderConfig?.preset === "day_before") {
    add(new Date(start.getFullYear(), start.getMonth(), start.getDate() - 1, 21, 0), "前一天晚上");
  } else if (event.reminderConfig?.preset === "morning") {
    add(new Date(start.getFullYear(), start.getMonth(), start.getDate(), 9, 0), "當天早上");
  } else {
    const title = event.title;
    if (/福岡|日本|旅行|旅遊|機票|出國|住宿/.test(title) || event.end) {
      add(new Date(start.getFullYear(), start.getMonth(), start.getDate() - 7, 9, 0), "前 7 天");
      add(new Date(start.getFullYear(), start.getMonth(), start.getDate() - 1, 21, 0), "前一天晚上");
      add(new Date(start.getFullYear(), start.getMonth(), start.getDate(), 8, 0), "當天早上");
    } else if (/牙醫|醫生|醫院|體檢|看診|回診|領藥/.test(title)) {
      add(new Date(start.getFullYear(), start.getMonth(), start.getDate() - 1, 21, 0), "前一天晚上");
      if (hasTime) add(new Date(start.getTime() - 120 * 60000), "前 2 小時");
      else add(new Date(start.getFullYear(), start.getMonth(), start.getDate(), 9, 0), "當天早上");
    } else if (/上班|開會|面試|考試|報告|交作業/.test(title)) {
      add(new Date(start.getFullYear(), start.getMonth(), start.getDate() - 1, 22, 0), "前一天晚上");
      add(new Date(start.getFullYear(), start.getMonth(), start.getDate(), 7, 0), "當天早上");
    } else if (hasTime) {
      add(new Date(start.getTime() - 120 * 60000), "前 2 小時");
    } else {
      add(new Date(start.getFullYear(), start.getMonth(), start.getDate(), 9, 0), "當天早上");
    }
  }

  return reminders.sort((a, b) => a.at.localeCompare(b.at));
}

function formatReminderSummary(event) {
  if (event.reminderOptOut || !event.reminders?.length) return "不提醒";
  const pending = event.reminders.filter((r) => !r.sent);
  if (!pending.length) return "已無待提醒";
  return pending.map((r) => `${r.at} ${r.label}`).join("、");
}

function formatEvent(e) {
  const range = e.end ? `${formatEventDateTime(e.start)} - ${formatEventDateTime(e.end)}` : formatEventDateTime(e.start);
  return `${e.id}｜${range}\n${e.title}`;
}

function displayEventRef(_scope, event) {
  return event.id;
}

function eventSortValue(event) {
  return event.start.includes(" ") ? event.start : `${event.start} 99:99`;
}

function formatEventDateTime(value) {
  return value.includes(" ") ? value : `${value} 全天`;
}

function reminderList(scope) {
  autoArchiveEvents(scope);
  ensureEventReminders(scope);
  const events = scope.events.filter((e) => !e.deleted && !e.done && !e.archived);
  const rows = events.filter((e) => e.reminders?.length || e.reminderOptOut);
  if (!rows.length) return "目前沒有提醒";
  return rows
    .sort((a, b) => eventSortValue(a).localeCompare(eventSortValue(b)))
    .map((e) => `${e.id}｜${e.title}\n${formatReminderSummary(e)}`)
    .join("\n\n");
}

function ensureEventReminders(scope) {
  let changed = false;
  for (const event of scope.events || []) {
    if (event.deleted || event.done || event.archived) continue;
    if (!event.reminders || (!event.reminders.length && !event.reminderOptOut)) {
      event.reminders = buildReminders(event);
      event.reminderGenerated = true;
      changed = true;
    }
  }
  return changed;
}

function handleReminderAction(scope, input) {
  if (!["知道了", "10分鐘後", "1小時後", "今天晚上", "不再提醒"].includes(input)) return null;
  const event = scope.events.find((e) => e.id === scope.lastReminderEventId && !e.deleted && !e.done && !e.archived);
  if (!event) return { changed: false, reply: "目前沒有可延後的提醒" };
  if (input === "知道了") return { changed: false, reply: "好，已知道。" };
  if (input === "不再提醒") {
    event.reminderOptOut = true;
    event.reminders = [];
    return { changed: true, reply: `已關閉 ${event.id} 的提醒` };
  }
  const now = taipeiNowDate();
  let at = null;
  if (input === "10分鐘後") at = new Date(now.getTime() + 10 * 60000);
  if (input === "1小時後") at = new Date(now.getTime() + 60 * 60000);
  if (input === "今天晚上") at = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 20, 0);
  if (at <= now) at = new Date(now.getTime() + 10 * 60000);
  event.reminderOptOut = false;
  event.reminders ||= [];
  event.reminders.push({ at: dateTimeString(at), label: input, sent: false });
  event.reminders.sort((a, b) => a.at.localeCompare(b.at));
  return { changed: true, reply: `已延後提醒：${dateTimeString(at)}` };
}

function updateEventReminder(event, rest) {
  const config = parseReminderConfig(rest);
  if (!config) return false;
  event.reminderConfig = config;
  event.reminderOptOut = config.mode === "none";
  event.reminders = buildReminders(event);
  return true;
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
      "/全部清除",
      "",
      "行程",
      "今天 15:30 拿包裹",
      "明天 19:00 吃飯",
      "8/10 19.看牙醫",
      "12/15-22 福岡",
      "8/10 19:00 看牙醫 提醒30分",
      "/行程",
      "/行程 今天",
      "/提醒",
      "/改提醒 E2 不提醒",
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
  updateActor(scope, source);
  await hydrateActorName(scope, source);

  let reply = null;
  let changed = false;

  if (input === "/" || input === "/說明" || input === "說明" || input === "/ 說明") {
    return helpMessage();
  }

  const reminderAction = handleReminderAction(scope, input);
  if (reminderAction) {
    if (reminderAction.changed) await saveStore(store);
    return textMessage(reminderAction.reply);
  }

  if (input === "/全部清除") {
    clearScope(store, scopeId(source));
    await saveStore(store);
    return textMessage("已清除這個聊天室的全部資料。");
  }

  if (input.startsWith("/欠明細")) {
    reply = debtDetails(scope, input.replace("/欠明細", "").trim());
  } else if (input.startsWith("/欠")) {
    reply = debtSummary(scope, input.replace("/欠", "").trim());
  } else if (input.startsWith("/改欠")) {
    const editMatch = input.match(/^\/改欠\s*(#?D?\d+)\s*(.+)$/i);
    const rawId = editMatch?.[1];
    const rest = editMatch?.[2]?.trim() || "";
    const item = rawId ? findDebtByRef(scope, rawId) : null;
    if (!rawId || !rest) reply = "用法：/改欠 D3 300";
    else if (!item) reply = `找不到 ${rawId}`;
    else if (!editDebt(scope, item, rest, message.mention, targets)) reply = "改不了這筆，例：/改欠 D3 300";
    else {
      reply = debtTextMessage(scope, `已修改 ${displayDebtRef(scope, item)}\n${formatDebtLine(item, scope)}`);
      changed = true;
    }
  } else if (input.startsWith("/刪欠")) {
    const ref = input.replace("/刪欠", "").trim();
    const item = findDebtByRef(scope, ref);
    reply = item ? `已刪除 ${displayDebtRef(scope, item)}` : `找不到 ${ref}`;
    if (item) {
      item.deleted = true;
      changed = true;
    }
  } else if (input.startsWith("/結清")) {
    const person = cleanPersonName(input.replace("/結清", "").trim());
    const balance = scope.debts
      .filter((d) => !d.deleted && debtActorName(scope, d) === scope.actorName && d.person === person)
      .reduce((sum, d) => sum + debtSigned(d), 0);
    if (!person) reply = "用法：/結清 A";
    else if (balance === 0) reply = `${person} 已經是結清狀態`;
    else {
      const item = newDebt(store, {
        person,
        amount: Math.abs(balance),
        direction: balance > 0 ? "they_paid_me" : "paid_to_them",
        note: "結清",
        raw: input,
        actorName: scope.actorName,
        actorUserId: scope.actorUserId,
      });
      scope.debts.push(item);
      reconcileOffsets(scope);
      reply = debtTextMessage(scope, `已結清 ${mentionToken(scope, person)}`);
      changed = true;
    }
  } else if (input.startsWith("/提醒")) {
    reply = reminderList(scope);
  } else if (input.startsWith("/改提醒")) {
    const m = input.match(/^\/改提醒\s*(E\d+)\s*(.+)$/i);
    const id = m?.[1]?.toUpperCase();
    const rest = m?.[2]?.trim() || "";
    const item = scope.events.find((e) => e.id.toUpperCase() === id && !e.deleted);
    if (!id || !rest) reply = "用法：/改提醒 E2 提醒30分";
    else if (!item) reply = `找不到 ${id}`;
    else if (!updateEventReminder(item, rest)) reply = "改不了提醒，例：/改提醒 E2 提醒30分";
    else {
      reply = `已修改提醒 ${item.id}\n${formatEvent(item)}\n提醒：${formatReminderSummary(item)}`;
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
    const parsed = parseEvent(rest.join(" "), { allowMissingTitle: true });
    if (!item) reply = `找不到 ${id || ""}`;
    else if (!parsed) reply = "用法：/改行程 E2 8/12 20:00 吃飯";
    else {
      if (!parsed.title) parsed.title = item.title;
      Object.assign(item, parsed);
      item.reminders = buildReminders(item);
      item.reminderOptOut = item.reminderConfig?.mode === "none";
      reply = `已修改 ${item.id}\n${formatEvent(item)}`;
      changed = true;
    }
  } else {
    const debt = parseDebt(message.text, message.mention);
    if (debt) {
      const normalizedDebt = normalizeParsedDebtPerson(scope, debt);
      attachMention(scope, normalizedDebt, targets);
      reply = applyDebt(store, scope, normalizedDebt, input);
      changed = true;
    } else {
      const barePaid = parseBarePaid(input);
      if (barePaid) {
        const result = applyBarePaid(store, scope, barePaid, input);
        reply = result.reply;
        changed = result.changed;
      }

      if (!reply) {
        reply = amountErrorMessage(message.text, message.mention);
      }

      const event = reply ? null : parseEvent(input);
      if (event) {
        reply = applyEvent(store, scope, event);
        changed = true;
      }
    }
  }

  if (scope.events?.some((e) => e.archived && !e.archiveSaved)) {
    for (const event of scope.events) {
      if (event.archived) event.archiveSaved = true;
    }
    changed = true;
  }

  if (scope.events?.some((e) => e.reminderGenerated && !e.reminderSaved)) {
    for (const event of scope.events) {
      if (event.reminderGenerated) event.reminderSaved = true;
    }
    changed = true;
  }

  if (changed) await saveStore(store);
  if (!reply) return null;
  return typeof reply === "string" ? textMessage(reply) : reply;
}

app.get("/", (_req, res) => {
  res.send("LINE secretary bot is running.");
});

app.get("/reminders", async (_req, res) => {
  try {
    const store = await loadStore();
    const now = dateTimeString(taipeiNowDate());
    const pushes = [];
    const stats = { scopes: 0, events: 0, reminders: 0, due: 0, archived: 0 };
    for (const [id, scope] of Object.entries(store.scopes || {})) {
      if (id === "default") continue;
      stats.scopes += 1;
      ensureEventReminders(scope);
      for (const event of scope.events || []) {
        if (!event.deleted && !event.done && !event.archived) stats.events += 1;
        if (event.deleted || event.done || event.archived || event.reminderOptOut) continue;
        for (const reminder of event.reminders || []) {
          if (!reminder.sent) stats.reminders += 1;
          if (reminder.sent || reminder.at > now) continue;
          stats.due += 1;
          pushes.push({ to: id, scope, event, reminder });
        }
      }
      if (autoArchiveEvents(scope)) stats.archived += 1;
    }

    let sent = 0;
    for (const push of pushes) {
      await client.pushMessage({
        to: push.to,
        messages: [reminderMessage(push.event, push.reminder)],
      });
      push.reminder.sent = true;
      push.reminder.sentAt = now;
      push.scope.lastReminderEventId = push.event.id;
      sent += 1;
    }

    await saveStore(store);
    res.json({ ok: true, now, sent, ...stats });
  } catch (error) {
    console.error(error);
    res.status(500).json({ ok: false, error: error.message });
  }
});

app.post("/webhook", line.middleware(lineConfig), async (req, res) => {
  await Promise.all(
    req.body.events.map(async (event) => {
      if (event.type !== "message" || event.message.type !== "text") return;
      const reply = await handleText(event.message, event.source);
      if (!reply) return;
      try {
        await client.replyMessage({ replyToken: event.replyToken, messages: [outboundMessage(reply)] });
      } catch (error) {
        const fallback = fallbackMessage(reply);
        if (!fallback) throw error;
        await client.replyMessage({ replyToken: event.replyToken, messages: [fallback] });
      }
    })
  );
  res.status(200).end();
});

app.listen(PORT, () => {
  console.log(`LINE secretary bot is listening on port ${PORT}`);
});
