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
    usage: ["欠 A 飲料 80", "分帳 1280 我 A B C", "/欠", "/欠明細 A", "/刪欠 D3", "說明"]
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

  const text = normalizeIncomingText(event.message.text);
  const userId = event.source.userId || "unknown";
  const reply = await runCommand(text, userId);

  if (!reply) {
    return;
  }

  return client.replyMessage({
    replyToken: event.replyToken,
    messages: [toLineTextMessage(reply)]
  });
}

async function runCommand(text, userId) {
  const store = await readStore();
  const now = new Date().toISOString();

  if (isHelp(text)) {
    return {
      text: helpText(),
      quickReply: quickHelpItems()
    };
  }

  if (text === "/") {
    return {
      text: "想做什麼？可以直接點下面按鈕：",
      quickReply: quickHelpItems()
    };
  }

  const debtReply = await handleDebtCommand(text, userId, store, now);
  if (debtReply) {
    return debtReply;
  }

  const scheduleReply = await handleScheduleCommand(text, userId, store, now);
  if (scheduleReply) {
    return scheduleReply;
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

  return null;
}

function isHelp(text) {
  return /^(?:\/)?(說明|help|指令)$/i.test(text);
}

function normalizeIncomingText(text) {
  return text
    .replace(/\u3000/g, " ")
    .replace(/^／/, "/")
    .replace(/^\/\s+/, "/")
    .trim();
}

function toLineTextMessage(reply) {
  if (typeof reply === "string") {
    return { type: "text", text: reply };
  }

  const message = { type: "text", text: reply.text };
  if (reply.quickReply && reply.quickReply.length > 0) {
    message.quickReply = {
      items: reply.quickReply.map((item) => ({
        type: "action",
        action: {
          type: "message",
          label: item.label,
          text: item.text
        }
      }))
    };
  }
  return message;
}

function quickHelpItems() {
  return [
    { label: "欠款總表", text: "/欠" },
    { label: "欠款明細", text: "/欠明細" },
    { label: "行程", text: "/行程" },
    { label: "今天行程", text: "/行程 今天" },
    { label: "記帳範例", text: "欠 A 飲料 80" },
    { label: "行程範例", text: "明天 19:00 吃飯" }
  ];
}

function helpText() {
  return [
    "LINE 秘書指令：",
    "",
    "1. 欠款記錄",
    "欠 對象 備註 金額",
    "例：欠 A 飲料 80",
    "例：欠A1000-300-20-30+300",
    "例：A 欠我 電影票 280",
    "例：A欠我500",
    "例：還 A 300",
    "例：還A300",
    "例：A還我200",
    "",
    "2. 查欠款",
    "/欠",
    "/欠 A",
    "/欠明細",
    "/欠明細 A",
    "/刪欠 D3",
    "/結清 A",
    "",
    "3. 分帳",
    "分帳 總金額 人1 人2 人3",
    "例：分帳 1280 我 A B C",
    "沒寫「我」時，會預設你也有一起分。",
    "",
    "4. 記錄行程",
    "日期 時間 內容",
    "例：今天 15:30 拿包裹",
    "例：明天 19:00 吃飯",
    "例：8/10 19.看牙醫",
    "例：2026/8/10 19:30 看牙醫",
    "例：12/15-22 福岡",
    "",
    "5. 查行程",
    "/行程",
    "/行程 今天",
    "/行程 明天",
    "/行程 本週",
    "/行程 看牙醫",
    "/刪行程 2",
    "/完成行程 E2",
    "/改行程 E2 8/12 20:00 吃飯",
    "",
    "6. 記錄事情",
    "記 對象 事項",
    "例：記 A 明天報價要回覆",
    "",
    "7. 查某個對象",
    "查 對象",
    "例：查 A",
    "",
    "8. 看全部待辦",
    "全部",
    "",
    "9. 完成事項",
    "完成 編號",
    "例：完成 3"
  ].join("\n");
}

async function handleDebtCommand(text, userId, store, now) {
  if (/^\/欠$/.test(text)) {
    const debts = activeDebts(store, userId);
    return formatDebtSummary(debts);
  }

  const contactSummaryMatch = text.match(/^\/欠\s+(.+)$/);
  if (contactSummaryMatch) {
    const contact = contactSummaryMatch[1].trim();
    const debts = activeDebts(store, userId).filter((debt) => debt.contact === contact);
    return formatContactDebt(debts, contact);
  }

  const debtDetailsMatch = text.match(/^\/欠明細(?:\s+(.+))?$/);
  if (debtDetailsMatch) {
    const contact = debtDetailsMatch[1] ? debtDetailsMatch[1].trim() : "";
    const debts = activeDebts(store, userId).filter((debt) => !contact || debt.contact === contact);
    return formatDebtDetails(debts);
  }

  const deleteDebtMatch = text.match(/^\/刪欠\s+#?D?(\d+)$/i);
  if (deleteDebtMatch) {
    const id = Number(deleteDebtMatch[1]);
    const debt = store.debts.find((item) => item.userId === userId && item.id === id && item.status !== "deleted");
    if (!debt) {
      return `找不到 #D${id} 這筆帳。`;
    }
    debt.status = "deleted";
    debt.deletedAt = now;
    await writeStore(store);
    return [
      `已刪除帳務 #D${id}`,
      `${describeDebt(debt)} ${formatMoney(debt.amount)}`,
      debt.note ? `備註：${debt.note}` : ""
    ].filter(Boolean).join("\n");
  }

  const settleMatch = text.match(/^\/結清\s+(.+)$/);
  if (settleMatch) {
    return settleDebt(store, userId, settleMatch[1].trim(), now);
  }

  const splitMatch = text.match(/^分帳\s+([0-9+\-*/().\s]+)\s+(.+)$/);
  if (splitMatch) {
    return splitBill(store, userId, splitMatch[1].trim(), splitMatch[2].trim(), now);
  }

  const spacedMeOwes = text.match(/^我?欠\s+(\S+)\s+(.+)$/);
  if (spacedMeOwes) {
    const parsed = parseDebtTail(spacedMeOwes[2]);
    if (!parsed) return "欠款格式請用：欠 對象 備註 金額，例如：欠 A 飲料 80";
    return addDebt(store, {
      userId,
      contact: spacedMeOwes[1].trim(),
      expression: parsed.expression,
      note: parsed.note,
      direction: "me_owes_contact",
      type: "debt",
      now
    });
  }

  const spacedContactOwes = text.match(/^(\S+)\s+欠我\s+(.+)$/);
  if (spacedContactOwes) {
    const parsed = parseDebtTail(spacedContactOwes[2]);
    if (!parsed) return "欠款格式請用：對象 欠我 備註 金額，例如：A 欠我 電影票 280";
    return addDebt(store, {
      userId,
      contact: spacedContactOwes[1].trim(),
      expression: parsed.expression,
      note: parsed.note,
      direction: "contact_owes_me",
      type: "debt",
      now
    });
  }

  const spacedMePaid = text.match(/^我?還\s+(\S+)\s+(.+)$/);
  if (spacedMePaid) {
    const parsed = parseDebtTail(spacedMePaid[2]);
    if (!parsed) return "還款格式請用：還 對象 金額，例如：還 A 300";
    return addDebt(store, {
      userId,
      contact: spacedMePaid[1].trim(),
      expression: parsed.expression,
      note: parsed.note,
      direction: "me_paid_contact",
      type: "payment",
      now
    });
  }

  const spacedContactPaid = text.match(/^(\S+)\s+還我\s+(.+)$/);
  if (spacedContactPaid) {
    const parsed = parseDebtTail(spacedContactPaid[2]);
    if (!parsed) return "還款格式請用：對象 還我 金額，例如：A 還我 200";
    return addDebt(store, {
      userId,
      contact: spacedContactPaid[1].trim(),
      expression: parsed.expression,
      note: parsed.note,
      direction: "contact_paid_me",
      type: "payment",
      now
    });
  }

  const meOwesMatch = text.match(/^我?欠([^\d\s]+)\s*([0-9+\-*/().\s]+)(?:\s+(.+))?$/);
  if (meOwesMatch) {
    return addDebt(store, {
      userId,
      contact: meOwesMatch[1].trim(),
      expression: meOwesMatch[2].trim(),
      note: meOwesMatch[3] ? meOwesMatch[3].trim() : "",
      direction: "me_owes_contact",
      type: "debt",
      now
    });
  }

  const contactOwesMatch = text.match(/^(.+?)欠我\s*([0-9+\-*/().\s]+)(?:\s+(.+))?$/);
  if (contactOwesMatch) {
    return addDebt(store, {
      userId,
      contact: contactOwesMatch[1].trim(),
      expression: contactOwesMatch[2].trim(),
      note: contactOwesMatch[3] ? contactOwesMatch[3].trim() : "",
      direction: "contact_owes_me",
      type: "debt",
      now
    });
  }

  const mePaidMatch = text.match(/^我?還([^\d\s]+)\s*([0-9+\-*/().\s]+)(?:\s+(.+))?$/);
  if (mePaidMatch) {
    return addDebt(store, {
      userId,
      contact: mePaidMatch[1].trim(),
      expression: mePaidMatch[2].trim(),
      note: mePaidMatch[3] ? mePaidMatch[3].trim() : "",
      direction: "me_paid_contact",
      type: "payment",
      now
    });
  }

  const contactPaidMatch = text.match(/^(.+?)還我\s*([0-9+\-*/().\s]+)(?:\s+(.+))?$/);
  if (contactPaidMatch) {
    return addDebt(store, {
      userId,
      contact: contactPaidMatch[1].trim(),
      expression: contactPaidMatch[2].trim(),
      note: contactPaidMatch[3] ? contactPaidMatch[3].trim() : "",
      direction: "contact_paid_me",
      type: "payment",
      now
    });
  }

  return null;
}

function activeDebts(store, userId) {
  return store.debts.filter((debt) => debt.userId === userId && debt.status !== "deleted");
}

function parseDebtTail(text) {
  const parts = text.trim().split(/\s+/);
  let amountIndex = -1;
  for (let index = parts.length - 1; index >= 0; index -= 1) {
    if (/^[0-9+\-*/().]+$/.test(parts[index]) && /\d/.test(parts[index])) {
      amountIndex = index;
      break;
    }
  }

  if (amountIndex === -1) {
    return null;
  }

  const expression = parts[amountIndex];
  const note = [...parts.slice(0, amountIndex), ...parts.slice(amountIndex + 1)].join(" ").trim();
  return { expression, note };
}

async function splitBill(store, userId, expression, peopleText, now) {
  let total;

  try {
    total = evaluateAmount(expression);
  } catch (error) {
    return `分帳金額看不懂：${error.message}`;
  }

  const people = peopleText
    .split(/[,\s，、]+/)
    .map((person) => person.trim())
    .filter(Boolean);

  if (people.length === 0) {
    return "分帳格式請用：分帳 總金額 我 對象1 對象2，例如：分帳 1280 我 A B C";
  }

  const uniquePeople = [...new Set(people)];
  const hasMe = uniquePeople.includes("我");
  const participants = hasMe ? uniquePeople : ["我", ...uniquePeople];
  const payers = participants.filter((person) => person !== "我");
  const share = roundMoney(total / participants.length);

  if (payers.length === 0) {
    return "分帳至少要有一個對象，例如：分帳 1280 我 A";
  }

  const splitBillRecord = {
    id: nextSplitBillId(store),
    userId,
    expression,
    total,
    share,
    participants,
    createdAt: now
  };

  store.splitBills.push(splitBillRecord);

  const createdDebts = [];
  for (const contact of payers) {
    const debt = {
      id: nextDebtId(store),
      userId,
      contact,
      expression: String(share),
      amount: share,
      signedAmount: -share,
      direction: "contact_owes_me",
      type: "split",
      note: `分帳 #S${splitBillRecord.id}`,
      splitBillId: splitBillRecord.id,
      createdAt: now
    };
    store.debts.push(debt);
    createdDebts.push(debt);
  }

  await writeStore(store);

  return [
    `已分帳 #S${splitBillRecord.id}`,
    `總金額：${formatMoney(total)}`,
    `人數：${participants.length}（${participants.join("、")}）`,
    `每人：${formatMoney(share)}`,
    "",
    ...createdDebts.map((debt) => `${debt.contact} 欠你：${formatMoney(debt.amount)}（#D${debt.id}）`)
  ].join("\n");
}

async function settleDebt(store, userId, contact, now) {
  const debts = activeDebts(store, userId);
  const total = sumDebtForContact(debts, userId, contact);

  if (Math.abs(total) < 0.0001) {
    return `你跟 ${contact} 目前已結清。`;
  }

  const direction = total > 0 ? "me_paid_contact" : "contact_paid_me";
  const amount = Math.abs(total);
  return addDebt(store, {
    userId,
    contact,
    expression: String(amount),
    note: "結清",
    direction,
    type: "settlement",
    now
  });
}

async function addDebt(store, input) {
  let amount;

  try {
    amount = evaluateAmount(input.expression);
  } catch (error) {
    return `金額算式看不懂：${error.message}`;
  }

  if (amount <= 0) {
    return "金額要大於 0。";
  }

  const signedAmount = toSignedDebtAmount(input.direction, amount);
  const debt = {
    id: nextDebtId(store),
    userId: input.userId,
    contact: input.contact,
    expression: input.expression,
    amount,
    signedAmount,
    direction: input.direction,
    type: input.type,
    note: input.note,
    createdAt: input.now
  };

  store.debts.push(debt);
  await writeStore(store);

  const total = sumDebtForContact(store.debts, input.userId, input.contact);
  return [
    `已記錄帳務 #D${debt.id}`,
    `${describeDebt(debt)}：${formatMoney(amount)}`,
    input.expression === String(amount) ? "" : `算式：${input.expression} = ${formatMoney(amount)}`,
    input.note ? `備註：${input.note}` : "",
    `時間：${formatDateTime(debt.createdAt)}`,
    `目前結算：${formatDebtBalance(input.contact, total)}`
  ].filter(Boolean).join("\n");
}

function toSignedDebtAmount(direction, amount) {
  if (direction === "me_owes_contact") return amount;
  if (direction === "contact_owes_me") return -amount;
  if (direction === "me_paid_contact") return -amount;
  if (direction === "contact_paid_me") return amount;
  return amount;
}

function describeDebt(debt) {
  if (debt.direction === "me_owes_contact") return `你欠 ${debt.contact}`;
  if (debt.direction === "contact_owes_me") return `${debt.contact} 欠你`;
  if (debt.direction === "me_paid_contact") return `你還 ${debt.contact}`;
  if (debt.direction === "contact_paid_me") return `${debt.contact} 還你`;
  return debt.contact;
}

function formatDebtSummary(debts) {
  if (debts.length === 0) {
    return "目前沒有欠款紀錄。";
  }

  const totals = new Map();
  for (const debt of debts) {
    totals.set(debt.contact, (totals.get(debt.contact) || 0) + debt.signedAmount);
  }

  const lines = [...totals.entries()]
    .filter(([, total]) => Math.abs(total) > 0.0001)
    .sort((a, b) => a[0].localeCompare(b[0], "zh-Hant"))
    .map(([contact, total]) => formatDebtBalance(contact, total));

  return lines.length === 0 ? "目前都結清了。" : ["欠款總表：", "", ...lines].join("\n");
}

function formatContactDebt(debts, contact) {
  if (debts.length === 0) {
    return `${contact} 目前沒有欠款紀錄。`;
  }

  const total = debts.reduce((sum, debt) => sum + debt.signedAmount, 0);
  return [
    formatDebtBalance(contact, total),
    "",
    formatDebtDetails(debts, contact)
  ].join("\n");
}

function formatDebtDetails(debts, contact = "") {
  if (debts.length === 0) {
    return contact ? `${contact} 目前沒有欠款明細。` : "目前沒有欠款明細。";
  }

  const header = contact ? `${contact} 欠款明細：` : "欠款明細：";
  const details = debts
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
    .slice(0, 30)
    .map((debt) => {
      return [
        `#D${debt.id} ${describeDebt(debt)} ${formatMoney(debt.amount)}`,
        `時間：${formatDateTime(debt.createdAt)}`,
        debt.expression ? `算式：${debt.expression}` : "",
        debt.note ? `備註：${debt.note}` : ""
      ].filter(Boolean).join("\n");
    })
    .join("\n\n");

  return `${header}\n\n${details}`;
}

function sumDebtForContact(debts, userId, contact) {
  return debts
    .filter((debt) => debt.userId === userId && debt.contact === contact)
    .reduce((total, debt) => total + debt.signedAmount, 0);
}

function formatDebtBalance(contact, total) {
  if (total > 0) return `你欠 ${contact}：${formatMoney(total)}`;
  if (total < 0) return `${contact} 欠你：${formatMoney(Math.abs(total))}`;
  return `你跟 ${contact}：已結清`;
}

function evaluateAmount(expression) {
  const normalized = expression.replace(/\s+/g, "");
  if (!/^[0-9+\-*/().]+$/.test(normalized)) {
    throw new Error("只能輸入數字跟 + - * / ( )");
  }

  if (!/\d/.test(normalized)) {
    throw new Error("沒有看到數字");
  }

  // The expression is restricted to arithmetic characters before evaluation.
  const result = Function(`"use strict"; return (${normalized});`)();
  if (!Number.isFinite(result)) {
    throw new Error("算出來不是有效數字");
  }

  return roundMoney(result);
}

async function handleScheduleCommand(text, userId, store, now) {
  const scheduleListMatch = text.match(/^\/行程(?:\s+(.+))?$/);
  if (scheduleListMatch) {
    const filter = scheduleListMatch[1] ? scheduleListMatch[1].trim() : "";
    const events = activeEvents(store, userId);
    return formatEvents(filterEvents(events, filter, now), filter);
  }

  const deleteMatch = text.match(/^\/刪行程\s+#?E?(\d+)$/i);
  if (deleteMatch) {
    const id = Number(deleteMatch[1]);
    const event = store.events.find((item) => item.userId === userId && item.id === id);
    if (!event) {
      return `找不到 #E${id} 這筆行程。`;
    }
    event.status = "cancelled";
    event.cancelledAt = now;
    await writeStore(store);
    return `已刪除行程 #E${id}：${event.title}`;
  }

  const doneMatch = text.match(/^\/完成行程\s+#?E?(\d+)$/i);
  if (doneMatch) {
    const id = Number(doneMatch[1]);
    const event = store.events.find((item) => item.userId === userId && item.id === id && item.status !== "cancelled");
    if (!event) {
      return `找不到 #E${id} 這筆行程。`;
    }
    event.status = "done";
    event.completedAt = now;
    await writeStore(store);
    return `已完成行程 #E${id}：${event.title}`;
  }

  const editMatch = text.match(/^\/改行程\s+#?E?(\d+)\s+(.+)$/i);
  if (editMatch) {
    const id = Number(editMatch[1]);
    const event = store.events.find((item) => item.userId === userId && item.id === id && item.status !== "cancelled");
    if (!event) {
      return `找不到 #E${id} 這筆行程。`;
    }

    const parsed = parseScheduleText(editMatch[2].trim(), now);
    if (!parsed) {
      return "改行程格式請用：/改行程 E2 8/12 20:00 吃飯";
    }

    event.title = parsed.title;
    event.startsAt = parsed.startsAt;
    event.endsAt = parsed.endsAt || null;
    event.updatedAt = now;
    await writeStore(store);

    return [
      `已修改行程 #E${event.id}`,
      `時間：${formatEventTime(event)}`,
      `事項：${event.title}`
    ].join("\n");
  }

  const parsed = parseScheduleText(text, now);
  if (!parsed) {
    return null;
  }

  const event = {
    id: nextEventId(store),
    userId,
    title: parsed.title,
    startsAt: parsed.startsAt,
    endsAt: parsed.endsAt || null,
    originalText: text,
    status: "open",
    createdAt: now,
    cancelledAt: null
  };

  store.events.push(event);
  await writeStore(store);

  return [
    `已記錄行程 #E${event.id}`,
    `時間：${formatEventTime(event)}`,
    `事項：${event.title}`
  ].join("\n");
}

function parseScheduleText(text, now) {
  const rangeMatch = text.match(/^(?:(\d{4})[/-])?(\d{1,2})[/-](\d{1,2})\s*[-~到至]\s*(?:(\d{1,2})[/-])?(\d{1,2})\s+(.+)$/);
  if (rangeMatch) {
    const nowDate = new Date(now);
    const today = taipeiDateParts(nowDate);
    let year = rangeMatch[1] ? Number(rangeMatch[1]) : today.year;
    const startMonth = Number(rangeMatch[2]);
    const startDay = Number(rangeMatch[3]);
    const endMonth = rangeMatch[4] ? Number(rangeMatch[4]) : startMonth;
    const endDay = Number(rangeMatch[5]);
    const title = rangeMatch[6].trim();

    if (!title || startMonth < 1 || startMonth > 12 || endMonth < 1 || endMonth > 12 || startDay < 1 || startDay > 31 || endDay < 1 || endDay > 31) {
      return null;
    }

    let endYear = year;
    if (endMonth < startMonth) {
      endYear += 1;
    }

    let startsAt = taipeiDateToIso(year, startMonth, startDay, 0, 0);
    let endsAt = taipeiDateToIso(endYear, endMonth, endDay, 23, 59);
    if (!rangeMatch[1] && new Date(endsAt) < nowDate) {
      year += 1;
      endYear += 1;
      startsAt = taipeiDateToIso(year, startMonth, startDay, 0, 0);
      endsAt = taipeiDateToIso(endYear, endMonth, endDay, 23, 59);
    }

    if (!isValidEventDate(new Date(startsAt)) || !isValidEventDate(new Date(endsAt)) || new Date(endsAt) < new Date(startsAt)) {
      return null;
    }

    return { title, startsAt, endsAt };
  }

  const relativeMatch = text.match(/^(今天|明天|後天|大後天)\s+(\d{1,2})(?:[:.](\d{1,2}))?[.\s]*(.+)$/);
  if (relativeMatch) {
    const nowDate = new Date(now);
    const offsetMap = { "今天": 0, "明天": 1, "後天": 2, "大後天": 3 };
    const today = taipeiDateParts(nowDate);
    const startsAt = taipeiDateToIso(
      today.year,
      today.month,
      today.day + offsetMap[relativeMatch[1]],
      Number(relativeMatch[2]),
      relativeMatch[3] ? Number(relativeMatch[3]) : 0
    );
    const title = relativeMatch[4].trim();

    if (!isValidEventDate(new Date(startsAt)) || !title) {
      return null;
    }

    return { title, startsAt };
  }

  const match = text.match(/^(?:(\d{4})[/-])?(\d{1,2})[/-](\d{1,2})\s+(\d{1,2})(?:[:.](\d{1,2}))?[.\s]*(.+)$/);
  if (!match) {
    return null;
  }

  const nowDate = new Date(now);
  const year = match[1] ? Number(match[1]) : nowDate.getFullYear();
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = match[5] ? Number(match[5]) : 0;
  const title = match[6].trim();

  if (!title || month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59) {
    return null;
  }

  let startsAt = taipeiDateToIso(year, month, day, hour, minute);
  if (!match[1] && new Date(startsAt) < nowDate) {
    startsAt = taipeiDateToIso(year + 1, month, day, hour, minute);
  }

  return {
    title,
    startsAt
  };
}

function activeEvents(store, userId) {
  return store.events.filter((event) => {
    return event.userId === userId && event.status !== "cancelled" && event.status !== "done";
  });
}

function filterEvents(events, filter, now) {
  if (!filter) {
    return events;
  }

  if (filter === "今天") {
    return events.filter((event) => isSameTaipeiDate(event.startsAt, now, 0));
  }

  if (filter === "明天") {
    return events.filter((event) => isSameTaipeiDate(event.startsAt, now, 1));
  }

  if (filter === "本週") {
    return events.filter((event) => isInTaipeiWeek(event.startsAt, now));
  }

  return events.filter((event) => event.title.includes(filter));
}

function formatEvents(events, filter = "") {
  if (events.length === 0) {
    return filter ? `目前沒有「${filter}」相關行程。` : "目前沒有行程。";
  }

  const title = filter ? `行程（${filter}）：` : "行程：";
  const rows = events
    .sort((a, b) => new Date(a.startsAt) - new Date(b.startsAt))
    .map((event) => `#E${event.id} ${formatEventTime(event)}\n${event.title}`)
    .join("\n\n");

  return `${title}\n\n${rows}`;
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
      tasks: Array.isArray(parsed.tasks) ? parsed.tasks : [],
      debts: Array.isArray(parsed.debts) ? parsed.debts : [],
      events: Array.isArray(parsed.events) ? parsed.events : [],
      splitBills: Array.isArray(parsed.splitBills) ? parsed.splitBills : []
    };
  } catch (error) {
    if (error.code === "ENOENT") {
      return { tasks: [], debts: [], events: [], splitBills: [] };
    }
    throw error;
  }
}

function nextDebtId(store) {
  const lastId = store.debts.reduce((max, debt) => Math.max(max, debt.id || 0), 0);
  return lastId + 1;
}

function nextEventId(store) {
  const lastId = store.events.reduce((max, event) => Math.max(max, event.id || 0), 0);
  return lastId + 1;
}

function nextSplitBillId(store) {
  const lastId = store.splitBills.reduce((max, splitBill) => Math.max(max, splitBill.id || 0), 0);
  return lastId + 1;
}

function roundMoney(value) {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

function isValidEventDate(date) {
  return date instanceof Date && !Number.isNaN(date.getTime());
}

function taipeiDateToIso(year, month, day, hour, minute) {
  return new Date(Date.UTC(year, month - 1, day, hour - 8, minute, 0, 0)).toISOString();
}

function formatMoney(value) {
  return roundMoney(value).toLocaleString("zh-TW", {
    maximumFractionDigits: 2
  });
}

function formatDateTime(value) {
  return new Intl.DateTimeFormat("zh-TW", {
    timeZone: "Asia/Taipei",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  }).format(new Date(value));
}

function formatDate(value) {
  return new Intl.DateTimeFormat("zh-TW", {
    timeZone: "Asia/Taipei",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(new Date(value));
}

function formatEventTime(event) {
  if (event.endsAt) {
    return `${formatDate(event.startsAt)} - ${formatDate(event.endsAt)}`;
  }

  return formatDateTime(event.startsAt);
}

function taipeiDateParts(value) {
  const parts = new Intl.DateTimeFormat("zh-TW", {
    timeZone: "Asia/Taipei",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    weekday: "short"
  }).formatToParts(new Date(value));

  const picked = {};
  for (const part of parts) {
    if (part.type !== "literal") {
      picked[part.type] = part.value;
    }
  }

  return {
    year: Number(picked.year),
    month: Number(picked.month),
    day: Number(picked.day),
    weekday: picked.weekday
  };
}

function taipeiDayKey(value) {
  const parts = taipeiDateParts(value);
  return `${parts.year}-${String(parts.month).padStart(2, "0")}-${String(parts.day).padStart(2, "0")}`;
}

function shiftedTaipeiDate(value, offsetDays) {
  const parts = taipeiDateParts(value);
  return taipeiDateToIso(parts.year, parts.month, parts.day + offsetDays, 12, 0);
}

function isSameTaipeiDate(eventValue, now, offsetDays) {
  return taipeiDayKey(eventValue) === taipeiDayKey(shiftedTaipeiDate(now, offsetDays));
}

function isInTaipeiWeek(eventValue, now) {
  const weekdays = { "週一": 1, "週二": 2, "週三": 3, "週四": 4, "週五": 5, "週六": 6, "週日": 0, "周一": 1, "周二": 2, "周三": 3, "周四": 4, "周五": 5, "周六": 6, "周日": 0 };
  const today = taipeiDateParts(now);
  const weekdayNumber = weekdays[today.weekday] ?? new Date(now).getUTCDay();
  const mondayOffset = weekdayNumber === 0 ? -6 : 1 - weekdayNumber;
  const keys = new Set();

  for (let offset = 0; offset < 7; offset += 1) {
    keys.add(taipeiDayKey(shiftedTaipeiDate(now, mondayOffset + offset)));
  }

  return keys.has(taipeiDayKey(eventValue));
}

async function writeStore(store) {
  await fs.mkdir(path.dirname(dataFile), { recursive: true });
  await fs.writeFile(dataFile, JSON.stringify(store, null, 2));
}

app.listen(port, () => {
  console.log(`LINE secretary bot is listening on port ${port}`);
});
