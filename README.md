# LINE Secretary Bot

生活用 LINE 秘書機器人，支援群組共用帳務與行程。

## 指令

```text
/說明
/

欠 A 飲料 80
欠@A 250
@A 要給200
A 要給我120
@A 要給我120
給@A 500
我要給A300
@A 已還800
A已還700
已還350
欠A1000-300-20-30+300
A 欠我 電影票 280
還 A 300
A 還我 200
分帳 1280 我 A B C

/欠
/欠 A
/欠明細
/欠明細 A
/改欠 D3 300
/刪欠 D3
/結清 A

今天 15:30 拿包裹
明天 19:00 吃飯
8/10 19.看牙醫
12/15-22 福岡

/行程
/行程 今天
/行程 明天
/行程 本週
/行程 福岡
/改行程 E2 8/12 20:00 吃飯
/完成行程 E2
/刪行程 E2
```

一般聊天不會回覆，避免太吵。

## Supabase

在 Supabase SQL Editor 執行：

```sql
create table if not exists public.line_secretary_store (
  id text primary key,
  data jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

alter table public.line_secretary_store enable row level security;

grant all on table public.line_secretary_store to service_role;
```

Render 環境變數新增：

```text
SUPABASE_URL
SUPABASE_SERVICE_ROLE_KEY
SUPABASE_STORE_ID=line-secretary-bot
```

`SUPABASE_SERVICE_ROLE_KEY` 只能放 Render 後端環境變數，不要放到前端或公開給別人。

## Render

```text
Build Command: npm install
Start Command: npm start
```

如果 Render 顯示 Supabase 無法存取 `line_secretary_store`，到 Supabase 的 Data API 設定確認這張表有開放給 API。
