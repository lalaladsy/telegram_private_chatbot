# 改动说明：私人转发模式 + 动态人机验证

仅修改 `lib/bot.js` 一个文件（`api/setup.js`、`lib/kv.js` 未动）。`node --check` 通过，并用 mock KV + mock Telegram API 做了端到端冒烟测试（私人模式全流程、群模式回归、200 次随机抽题答案正确性）。

## 改造一：私人转发模式（与群话题模式共存，环境变量切换）

- 新增 `env.OWNER_ID`（机主个人 Telegram 数字 ID）。设置后启用私人模式（`isOwnerMode()` 判断）；不设置时原群话题模式行为完全不变。
- `fetch` 环境自检放宽：私人模式只要求 `BOT_TOKEN` + `OWNER_ID`，不再要求 `SUPERGROUP_ID` 必填，`-100` 格式校验也只在群模式执行。
- 分流点：`fetch` 中 `chat.type === 'private'` 且 `chat.id === OWNER_ID` 时走新增的 `handleOwnerMessage`，其余私聊仍走原 `handlePrivateMessage`。转发统一走新增的 `forwardUserMessage` 分发器（验证通过、验证期间暂存消息的补发都已切换）。
- 用户侧流程不变（限速、封禁检查、人机验证、closed 关闭状态都保留）。验证通过后走新增的 `forwardToOwner`，不建话题：
  - 先给机主发信息头（昵称、@username 或「无」、用户 ID，纯文本发送避免 Markdown 解析问题）；
  - 再 `copyMessage` 把原消息复制给机主；
  - 信息头和复制消息的机主侧 `message_id` 都写入映射 `fwd:<机主侧message_id>` → userId（TTL 30 天，`FWD_MAP_TTL_SECONDS`）；
  - 用户记录 `user:<id>` 只保留 `closed`、`title` 等状态字段，不依赖 `thread_id`。
- 相册（media_group_id）：复用 `handleMediaGroup`/`delaySend`，新增可选参数 `mapUserId`。用户→机主方向（`p2o`，无 thread）整组只发一次信息头（`mghdr:<groupId>` 防重复），相册发出后为每条消息写 `fwd:` 映射；提取不到媒体的降级 `copyMessage` 同样写映射。
- 机主回信（`handleOwnerMessage`）：
  - 带 `reply_to_message` 时用被回复消息的 `message_id` 查 `fwd:` 映射；查不到回提示「⚠️ 只能回复机器人转发的消息才能回信。」；
  - 文本为 `/ban /unban /trust /close /open /reset /info` 时走新增的 `handleOwnerCommand`，语义与 `handleAdminReply` 中同名指令一致（不含话题开关动作），执行后给机主一条确认回执；
  - 其他内容（文本/图片/文件）用 `copyMessage` 转发给目标用户；媒体组回信时用 `mgctx:<media_group_id>` 记录目标用户，聚合方向为 `o2p`（相册后续条目常不带回复引用，靠该上下文续传）；
  - 机主无回复引用的普通消息直接忽略，不报错、不转发。

## 改造二：动态人机验证（替换静态题库）

- 删除静态题库 `LOCAL_QUESTIONS`，改为运行时程序化生成。状态保存在 `challenge:<userId>` 的 JSON 中（含轮次、题型、正确答案下标、选项、签发时间、暂存消息），`user_challenge:<userId>` 保留为进行中指针。回调 data 沿用短 ID 形式 `verify:<挑战ID>:<选项序号>`。
- 4 种题型每次随机抽取（`CHALLENGE_GENERATORS`）：
  1. 找不同：一组相同 emoji 混一个不同的，点不同的那个；
  2. 数数：随机 emoji 串，数指定 emoji 出现次数，选项为正确答案 ±1/±2/±3 的近似数字；
  3. 指令定位：「点击从左数第 N 个按钮」，5 个随机 emoji 单行排列；
  4. 顺序记忆：题干给出 3 个 emoji 的序列，4 个选项为其不同排列，选完全一致的。
- 必须连过 2 轮（`CHALLENGE_ROUNDS_REQUIRED`）才通过，且两轮题型不同（用 `usedTypes` 排除）；第二轮通过编辑同一条题目消息呈现。按钮位置每次随机打乱（选项生成时 shuffle）。
- 防刷规则：
  - 单轮 90 秒过期（`CHALLENGE_TTL_SECONDS`，KV TTL + `issuedAt` 双保险）；
  - 答题用时 < 1 秒（`CHALLENGE_MIN_ANSWER_MS`）视为机器人：作废当前挑战、累计一次失败、立即下发新题；
  - 答错同样作废重发并累计（`verify_fails:<userId>`）；累计 3 次（`CHALLENGE_MAX_FAILS`）进入 10 分钟冷却（`verify_cooldown:<userId>`，带 TTL），冷却中只提示不下发新题；
  - 通过后沿用原逻辑：`verified:<userId>` 30 天免验证，`/trust` 永久信任不变；验证期间暂存消息在通过后自动补发。

## 改动的原有函数

- `fetch`（环境自检放宽、OWNER_ID 规范化、私聊分流加机主分支）
- `handlePrivateMessage`（尾部转发改走 `forwardUserMessage` 分发）
- `handleMediaGroup`（新增可选 `mapUserId` 参数，降级 copy 路径也写映射）
- `delaySend`（相册发送成功后按 `rec.mapUserId` 批量写 `fwd:` 映射）
- `sendVerificationChallenge`、`handleCallbackQuery`（整段重写为动态验证状态机）
- `CONFIG` 新增：`CHALLENGE_TTL_SECONDS`、`CHALLENGE_ROUNDS_REQUIRED`、`CHALLENGE_MAX_FAILS`、`CHALLENGE_COOLDOWN_SECONDS`、`CHALLENGE_MIN_ANSWER_MS`、`FWD_MAP_TTL_SECONDS`
- 新增函数：`isOwnerMode`、`forwardUserMessage`、`forwardToOwner`、`buildUserHeaderText`、`putFwdMapping`、`handleOwnerMessage`、`handleOwnerCommand`、题型生成器一组、`generateChallenge`、`buildChallengeKeyboard`、`registerChallengeFail`、`clearChallengeState`、`startChallengeRound`、`failChallengeAttempt`

## 部署注意（本次未改动的文件）

- Cloudflare 部署：直接给 Worker 加环境变量 `OWNER_ID` 即可切换私人模式。
- Vercel 部署：`api/webhook.js` 目前组装 env 时没有透传 `OWNER_ID`，需要在其 env 对象里加一行 `OWNER_ID: process.env.OWNER_ID || ""`（本次按约束未动该文件），并在 Vercel 项目环境变量中设置 `OWNER_ID`。
