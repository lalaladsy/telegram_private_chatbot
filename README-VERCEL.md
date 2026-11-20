# Vercel 版部署说明（telegram_private_chatbot）

本分支把原 Cloudflare Workers 版机器人移植到 Vercel Edge Functions。
业务代码 `lib/bot.js` 与原版 `worker.js` 完全一致，只换了运行环境和存储层：

- 入口：`api/webhook.js`（Edge Function），Telegram Webhook 地址为 `https://<项目域名>/api/webhook`
- 存储：`lib/kv.js` 用 Upstash Redis（REST）模拟 Cloudflare KV 的 get/put/delete/list
- 一次性激活：`api/setup.js`，部署后访问 `/api/setup?key=<SETUP_SECRET>` 注册 Webhook

## Vercel 环境变量

| 变量 | 说明 |
| :--- | :--- |
| `BOT_TOKEN` | BotFather 给的机器人 Token |
| `SUPERGROUP_ID` | 管理员话题群 ID，以 `-100` 开头 |
| `ADMIN_IDS` | 管理员用户 ID，逗号分隔（可选） |
| `UPSTASH_REDIS_REST_URL` | Upstash Redis 的 REST URL |
| `UPSTASH_REDIS_REST_TOKEN` | Upstash Redis 的 REST Token |
| `SETUP_SECRET` | 自定义一串随机字符，保护 /api/setup |

## 步骤

1. 在 Vercel 导入本仓库、选 `vercel` 分支部署
2. 在 Upstash 创建一个 Redis 数据库（免费），把 REST URL / Token 填入环境变量
3. 填好其余环境变量后重新部署一次
4. 访问 `/api/setup?key=<SETUP_SECRET>`，返回 Telegram `ok: true` 即激活完成
5. 在 BotFather 关闭该机器人的 Group Privacy，并把机器人拉进管理员群设为管理员（需管理话题权限）
