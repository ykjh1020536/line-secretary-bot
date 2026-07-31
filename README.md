# LINE 秘書機器人

這是一個可以接到 LINE Messaging API 的小型秘書 Bot。它可以幫你把「跟某個人或客戶有關的事情」記錄起來，之後用 LINE 查詢或標記完成。

## 功能

- `記 小王 明天報價要回覆`：新增一筆事項
- `查 小王`：查某個對象的待辦
- `全部`：列出所有未完成事項
- `完成 3`：把編號 3 的事項標記完成
- `說明`：顯示指令

## 本機啟動

```bash
npm install
cp .env.example .env
npm run dev
```

接著把 `.env` 裡的值改成你的 LINE Channel 資訊：

```bash
LINE_CHANNEL_ACCESS_TOKEN=你的 Channel access token
LINE_CHANNEL_SECRET=你的 Channel secret
PORT=3000
DATA_FILE=./data/tasks.json
```

## LINE 後台設定

1. 到 LINE Developers 建立 Provider 與 Messaging API Channel。
2. 複製 `Channel secret` 到 `.env`。
3. 發行 long-lived `Channel access token`，貼到 `.env`。
4. 部署到 Render、Railway、Vercel 或其他 Node.js 主機。
5. 在 LINE Developers 的 Webhook URL 填入：

```text
https://你的網域/webhook
```

6. 開啟 `Use webhook`。
7. 掃描 Messaging API Channel 的 QR Code，把 Bot 加到 LINE。

## 部署提醒

目前資料存在 `data/tasks.json`，適合先測試。正式使用建議改成資料庫，例如 Supabase、Postgres 或 Google Sheet，避免平台重啟或重新部署時資料消失。

## 指令格式

| 目的 | 指令 | 範例 |
| --- | --- | --- |
| 新增事項 | `記 對象 事項` | `記 小王 明天報價要回覆` |
| 查詢對象 | `查 對象` | `查 小王` |
| 全部待辦 | `全部` | `全部` |
| 完成事項 | `完成 編號` | `完成 3` |
| 看說明 | `說明` | `說明` |
