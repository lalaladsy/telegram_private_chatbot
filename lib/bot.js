// Cloudflare Worker：Telegram 双向机器人 v5.3

// --- 配置常量 ---
const CONFIG = {
    VERIFY_ID_LENGTH: 12,
    VERIFY_EXPIRE_SECONDS: 300,         // 5分钟
    VERIFIED_EXPIRE_SECONDS: 2592000,   // 30天
    MEDIA_GROUP_EXPIRE_SECONDS: 60,
    MEDIA_GROUP_DELAY_MS: 3000,         // 3秒（从2秒增加）
    PENDING_MAX_MESSAGES: 10,           // 验证期间最多暂存的消息数
    ADMIN_CACHE_TTL_SECONDS: 300,       // 管理员权限缓存 5 分钟
    NEEDS_REVERIFY_TTL_SECONDS: 600,    // 标记需重新验证的 TTL（用于并发兜底）
    RATE_LIMIT_MESSAGE: 45,
    RATE_LIMIT_VERIFY: 3,
    RATE_LIMIT_WINDOW: 60,
    BUTTON_COLUMNS: 2,
    MAX_TITLE_LENGTH: 128,
    MAX_NAME_LENGTH: 30,
    API_TIMEOUT_MS: 10000,
    CLEANUP_BATCH_SIZE: 10,
    MAX_CLEANUP_DISPLAY: 20,
    CLEANUP_LOCK_TTL_SECONDS: 1800,     // /cleanup 防并发锁 30 分钟
    MAX_RETRY_ATTEMPTS: 3,
    THREAD_HEALTH_TTL_MS: 60000,
    // 动态人机验证
    CHALLENGE_TTL_SECONDS: 90,          // 单轮挑战有效期 90 秒
    CHALLENGE_ROUNDS_REQUIRED: 2,       // 需连续通过 2 轮不同题型
    CHALLENGE_MAX_FAILS: 3,             // 累计失败 3 次进入冷却
    CHALLENGE_COOLDOWN_SECONDS: 600,    // 冷却 10 分钟
    CHALLENGE_MIN_ANSWER_MS: 1000,      // 答题快于 1 秒视为机器人行为
    // 私人转发模式
    FWD_MAP_TTL_SECONDS: 2592000        // fwd 映射保留 30 天
};

// 线程健康检查缓存，减少频繁探测请求
const threadHealthCache = new Map();
// 同一实例内的并发保护：避免同一用户短时间内重复创建话题
const topicCreateInFlight = new Map();
// 管理员权限缓存（实例内）
const adminStatusCache = new Map();

// --- 动态验证素材池（运行时程序化生成题目，不使用固定题库） ---
const CHALLENGE_EMOJIS = [
    "🍎", "🍌", "🍇", "🍓", "🍊", "🍉", "🍑", "🍒", "🥝", "🍍",
    "🐶", "🐱", "🐰", "🦊", "🐼", "🐸", "🐵", "🦁", "🐷", "🐔",
    "🚗", "✈️", "🚲", "🚀", "⛵", "🚂", "⚽", "🏀", "🎾", "🏈",
    "⭐", "❤️", "🔥", "💧", "🌙", "☀️", "⚡", "🎈", "🎁", "🔔"
];

// --- 辅助工具函数 ---

// 结构化日志系统
const Logger = {
    /**
     * 记录信息级别日志
     * @param {string} action - 操作名称
     * @param {object} data - 附加数据
     */
    info(action, data = {}) {
        const log = {
            timestamp: new Date().toISOString(),
            level: 'INFO',
            action,
            ...data
        };
        console.log(JSON.stringify(log));
    },

    /**
     * 记录警告级别日志
     * @param {string} action - 操作名称
     * @param {object} data - 附加数据
     */
    warn(action, data = {}) {
        const log = {
            timestamp: new Date().toISOString(),
            level: 'WARN',
            action,
            ...data
        };
        console.warn(JSON.stringify(log));
    },

    /**
     * 记录错误级别日志
     * @param {string} action - 操作名称
     * @param {Error|string} error - 错误对象或消息
     * @param {object} data - 附加数据
     */
    error(action, error, data = {}) {
        const log = {
            timestamp: new Date().toISOString(),
            level: 'ERROR',
            action,
            error: error instanceof Error ? error.message : String(error),
            stack: error instanceof Error ? error.stack : undefined,
            ...data
        };
        console.error(JSON.stringify(log));
    },

    /**
     * 记录调试级别日志
     * @param {string} action - 操作名称
     * @param {object} data - 附加数据
     */
    debug(action, data = {}) {
        const log = {
            timestamp: new Date().toISOString(),
            level: 'DEBUG',
            action,
            ...data
        };
        console.log(JSON.stringify(log));
    }
};

// 加密安全的随机数生成
function secureRandomInt(min, max) {
    const range = max - min;
    const bytes = new Uint32Array(1);
    crypto.getRandomValues(bytes);
    return min + (bytes[0] % range);
}

function secureRandomId(length = 12) {
    const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
    const bytes = new Uint8Array(length);
    crypto.getRandomValues(bytes);
    return Array.from(bytes).map(b => chars[b % chars.length]).join('');
}

// 安全的 JSON 获取
async function safeGetJSON(env, key, defaultValue = null) {
    try {
        const data = await env.TOPIC_MAP.get(key, { type: "json" });
        if (data === null || data === undefined) {
            return defaultValue;
        }
        if (typeof data !== 'object') {
            Logger.warn('kv_invalid_type', { key, type: typeof data });
            return defaultValue;
        }
        return data;
    } catch (e) {
        Logger.error('kv_parse_failed', e, { key });
        return defaultValue;
    }
}

function normalizeTgDescription(description) {
    return (description || "").toString().toLowerCase();
}

function isTopicMissingOrDeleted(description) {
    const desc = normalizeTgDescription(description);
    return desc.includes("thread not found") ||
           desc.includes("topic not found") ||
           desc.includes("message thread not found") ||
           desc.includes("topic deleted") ||
           desc.includes("thread deleted") ||
           desc.includes("forum topic not found") ||
           desc.includes("topic closed permanently");
}

function isTestMessageInvalid(description) {
    const desc = normalizeTgDescription(description);
    return desc.includes("message text is empty") ||
           desc.includes("bad request: message text is empty");
}

async function getOrCreateUserTopicRec(from, key, env, userId) {
    const existing = await safeGetJSON(env, key, null);
    if (existing && existing.thread_id) return existing;

    const inflight = topicCreateInFlight.get(String(userId));
    if (inflight) return await inflight;

    const p = (async () => {
        // 并发下二次确认，避免已被其他请求创建却读到旧值
        const again = await safeGetJSON(env, key, null);
        if (again && again.thread_id) return again;
        return await createTopic(from, key, env, userId);
    })();

    topicCreateInFlight.set(String(userId), p);
    try {
        return await p;
    } finally {
        if (topicCreateInFlight.get(String(userId)) === p) {
            topicCreateInFlight.delete(String(userId));
        }
    }
}

function withMessageThreadId(body, threadId) {
    if (threadId === undefined || threadId === null) return body;
    return { ...body, message_thread_id: threadId };
}

async function probeForumThread(env, expectedThreadId, { userId, reason, doubleCheckOnMissingThreadId = true } = {}) {
    const attemptOnce = async () => {
        const res = await tgCall(env, "sendMessage", {
            chat_id: env.SUPERGROUP_ID,
            message_thread_id: expectedThreadId,
            text: "🔎"
        });

        const actualThreadId = res.result?.message_thread_id;
        const probeMessageId = res.result?.message_id;

        // 尽可能清理探测消息（无论落到哪个话题/General）
        if (res.ok && probeMessageId) {
            try {
                await tgCall(env, "deleteMessage", {
                    chat_id: env.SUPERGROUP_ID,
                    message_id: probeMessageId
                });
            } catch (e) {
                // 删除失败不影响主流程
            }
        }

        if (!res.ok) {
            if (isTopicMissingOrDeleted(res.description)) {
                return { status: "missing", description: res.description };
            }
            if (isTestMessageInvalid(res.description)) {
                return { status: "probe_invalid", description: res.description };
            }
            return { status: "unknown_error", description: res.description };
        }

        // 关键：有些情况下 Telegram 会返回 ok 但不带 message_thread_id（常见于 General）
        if (actualThreadId === undefined || actualThreadId === null) {
            return { status: "missing_thread_id" };
        }

        if (Number(actualThreadId) !== Number(expectedThreadId)) {
            return { status: "redirected", actualThreadId };
        }

        return { status: "ok" };
    };

    const first = await attemptOnce();
    if (first.status !== "missing_thread_id" || !doubleCheckOnMissingThreadId) return first;

    // 二次探测：避免偶发字段缺失导致误判并触发重建
    const second = await attemptOnce();
    if (second.status === "missing_thread_id") {
        Logger.warn('thread_probe_missing_thread_id', { userId, expectedThreadId, reason });
    }
    return second;
}

async function resetUserVerificationAndRequireReverify(env, { userId, userKey, oldThreadId, pendingMsgId, reason }) {
    // 清理旧映射与验证状态：用户需要重新做人机验证
    await env.TOPIC_MAP.delete(`verified:${userId}`);
    await env.TOPIC_MAP.put(`needs_verify:${userId}`, "1", { expirationTtl: CONFIG.NEEDS_REVERIFY_TTL_SECONDS });
    await env.TOPIC_MAP.delete(`retry:${userId}`);

    if (userKey) {
        await env.TOPIC_MAP.delete(userKey);
    }

    if (oldThreadId !== undefined && oldThreadId !== null) {
        await env.TOPIC_MAP.delete(`thread:${oldThreadId}`);
        await env.TOPIC_MAP.delete(`thread_ok:${oldThreadId}`);
        threadHealthCache.delete(oldThreadId);
    }

    Logger.info('verification_reset_due_to_topic_loss', {
        userId,
        oldThreadId,
        pendingMsgId,
        reason
    });

    await sendVerificationChallenge(userId, env, pendingMsgId || null);
}

function parseAdminIdAllowlist(env) {
    const raw = (env.ADMIN_IDS || "").toString().trim();
    if (!raw) return null;
    const ids = raw.split(/[,;\s]+/g).map(s => s.trim()).filter(Boolean);
    const set = new Set();
    for (const id of ids) {
        const n = Number(id);
        if (!Number.isFinite(n)) continue;
        set.add(String(n));
    }
    return set.size > 0 ? set : null;
}

async function isAdminUser(env, userId) {
    const allowlist = parseAdminIdAllowlist(env);
    if (allowlist && allowlist.has(String(userId))) return true;

    const cacheKey = String(userId);
    const now = Date.now();
    const cached = adminStatusCache.get(cacheKey);
    if (cached && (now - cached.ts < CONFIG.ADMIN_CACHE_TTL_SECONDS * 1000)) {
        return cached.isAdmin;
    }

    const kvKey = `admin:${userId}`;
    const kvVal = await env.TOPIC_MAP.get(kvKey);
    if (kvVal === "1" || kvVal === "0") {
        const isAdmin = kvVal === "1";
        adminStatusCache.set(cacheKey, { ts: now, isAdmin });
        return isAdmin;
    }

    try {
        const res = await tgCall(env, "getChatMember", {
            chat_id: env.SUPERGROUP_ID,
            user_id: userId
        });

        const status = res.result?.status;
        const isAdmin = res.ok && (status === "creator" || status === "administrator");
        await env.TOPIC_MAP.put(kvKey, isAdmin ? "1" : "0", { expirationTtl: CONFIG.ADMIN_CACHE_TTL_SECONDS });
        adminStatusCache.set(cacheKey, { ts: now, isAdmin });
        return isAdmin;
    } catch (e) {
        Logger.warn('admin_check_failed', { userId });
        return false;
    }
}

// 获取所有 KV keys（处理分页）
async function getAllKeys(env, prefix) {
    const allKeys = [];
    let cursor = undefined;

    do {
        const result = await env.TOPIC_MAP.list({ prefix, cursor });
        allKeys.push(...result.keys);
        cursor = result.list_complete ? undefined : result.cursor;
    } while (cursor);

    return allKeys;
}

// Fisher-Yates 洗牌算法
function shuffleArray(arr) {
    const array = [...arr];
    for (let i = array.length - 1; i > 0; i--) {
        const j = secureRandomInt(0, i + 1);
        [array[i], array[j]] = [array[j], array[i]];
    }
    return array;
}

// 速率限制检查
async function checkRateLimit(userId, env, action = 'message', limit = 20, window = 60) {
    const key = `ratelimit:${action}:${userId}`;
    const countStr = await env.TOPIC_MAP.get(key);
    const count = parseInt(countStr || "0");

    if (count >= limit) {
        return { allowed: false, remaining: 0 };
    }

    await env.TOPIC_MAP.put(key, String(count + 1), { expirationTtl: window });
    return { allowed: true, remaining: limit - count - 1 };
}

export default {
  async fetch(request, env, ctx) {
    // 环境自检：群话题模式需要 SUPERGROUP_ID；私人模式（设置了 OWNER_ID）只需要 BOT_TOKEN + OWNER_ID
    if (!env.TOPIC_MAP) return new Response("Error: KV 'TOPIC_MAP' not bound.");
    if (!env.BOT_TOKEN) return new Response("Error: BOT_TOKEN not set.");
    const ownerMode = isOwnerMode(env);
    if (!ownerMode && !env.SUPERGROUP_ID) return new Response("Error: SUPERGROUP_ID not set.");

    // 【修复 #7】规范化环境变量，统一为字符串类型
    const normalizedEnv = {
        ...env,
        SUPERGROUP_ID: env.SUPERGROUP_ID ? String(env.SUPERGROUP_ID) : "",
        OWNER_ID: ownerMode ? String(env.OWNER_ID) : "",
        BOT_TOKEN: String(env.BOT_TOKEN)
    };

    // 验证 SUPERGROUP_ID 格式（仅群话题模式）
    if (!ownerMode && !normalizedEnv.SUPERGROUP_ID.startsWith("-100")) {
        return new Response("Error: SUPERGROUP_ID must start with -100");
    }

    if (request.method !== "POST") return new Response("OK");

    // 验证 Content-Type
    const contentType = request.headers.get("content-type") || "";
    if (!contentType.includes("application/json")) {
        Logger.warn('invalid_content_type', { contentType });
        return new Response("OK");
    }

    let update;
    try {
      update = await request.json();

      // 验证基本结构
      if (!update || typeof update !== 'object') {
          Logger.warn('invalid_json_structure', { update: typeof update });
          return new Response("OK");
      }
    } catch (e) {
      Logger.error('json_parse_failed', e);
      return new Response("OK");
    }

    if (update.callback_query) {
      await handleCallbackQuery(update.callback_query, normalizedEnv, ctx);
      return new Response("OK");
    }

    const msg = update.message;
    if (!msg) return new Response("OK");

    ctx.waitUntil(flushExpiredMediaGroups(normalizedEnv, Date.now()));

    if (msg.chat && msg.chat.type === "private") {
      // 私人模式：机主的私聊走机主处理（回信/指令），不走普通用户验证流程
      if (ownerMode && String(msg.chat.id) === normalizedEnv.OWNER_ID) {
        try {
          await handleOwnerMessage(msg, normalizedEnv, ctx);
        } catch (e) {
          Logger.error('owner_message_failed', e, { userId: msg.chat.id });
        }
        return new Response("OK");
      }
      try {
        await handlePrivateMessage(msg, normalizedEnv, ctx);
      } catch (e) {
        // 不向用户泄露技术细节
        const errText = `⚠️ 系统繁忙，请稍后再试。`;
        await tgCall(normalizedEnv, "sendMessage", { chat_id: msg.chat.id, text: errText });
        Logger.error('private_message_failed', e, { userId: msg.chat.id });
      }
      return new Response("OK");
    }

    // 【修复 #7】使用字符串比较
    if (msg.chat && String(msg.chat.id) === normalizedEnv.SUPERGROUP_ID) {
        if (msg.forum_topic_closed && msg.message_thread_id) {
            await updateThreadStatus(msg.message_thread_id, true, normalizedEnv);
            return new Response("OK");
        }
        if (msg.forum_topic_reopened && msg.message_thread_id) {
            await updateThreadStatus(msg.message_thread_id, false, normalizedEnv);
            return new Response("OK");
        }
        // 【修复】支持 General 话题和普通话题
        // General 话题的 message_thread_id 可能不存在，或者等于 1
        const text = (msg.text || "").trim();
        const isCommand = !!text && text.startsWith("/");
        if (msg.message_thread_id || isCommand) {
            await handleAdminReply(msg, normalizedEnv, ctx);
            return new Response("OK");
        }
    }

    return new Response("OK");
  },
};

// ---------------- 核心业务逻辑 ----------------

async function handlePrivateMessage(msg, env, ctx) {
  const userId = msg.chat.id;
  const key = `user:${userId}`;

  // 速率限制检查
  const rateLimit = await checkRateLimit(userId, env, 'message', CONFIG.RATE_LIMIT_MESSAGE, CONFIG.RATE_LIMIT_WINDOW);
  if (!rateLimit.allowed) {
      await tgCall(env, "sendMessage", {
          chat_id: userId,
          text: "⚠️ 发送过于频繁，请稍后再试。"
      });
      return;
  }

  // 拦截普通用户发送的指令
  if (msg.text && msg.text.startsWith("/") && msg.text.trim() !== "/start") {
      return;
  }

  const isBanned = await env.TOPIC_MAP.get(`banned:${userId}`);
  if (isBanned) return;

  const verified = await env.TOPIC_MAP.get(`verified:${userId}`);

  if (!verified) {
    const isStart = msg.text && msg.text.trim() === "/start";
    const pendingMsgId = isStart ? null : msg.message_id;
    await sendVerificationChallenge(userId, env, pendingMsgId);
    return;
  }

  await forwardUserMessage(msg, userId, key, env, ctx);
}

async function forwardToTopic(msg, userId, key, env, ctx) {
    // 并发兜底：如果已被标记为需要重新验证，直接发起验证并暂停转发/建话题
    const needsVerify = await env.TOPIC_MAP.get(`needs_verify:${userId}`);
    if (needsVerify) {
        await sendVerificationChallenge(userId, env, msg.message_id || null);
        return;
    }

    // 【修复 #4】使用安全的 JSON 解析
    let rec = await safeGetJSON(env, key, null);

    if (rec && rec.closed) {
        await tgCall(env, "sendMessage", { chat_id: userId, text: "🚫 当前对话已被管理员关闭。" });
        return;
    }

    // 【修复 #5】重试计数器，防止无限循环
    const retryKey = `retry:${userId}`;
    let retryCount = parseInt(await env.TOPIC_MAP.get(retryKey) || "0");

    if (retryCount > CONFIG.MAX_RETRY_ATTEMPTS) {
        await tgCall(env, "sendMessage", {
            chat_id: userId,
            text: "❌ 系统繁忙，请稍后再试。"
        });
        await env.TOPIC_MAP.delete(retryKey);
        return;
    }

    if (!rec || !rec.thread_id) {
        rec = await getOrCreateUserTopicRec(msg.from, key, env, userId);
        if (!rec || !rec.thread_id) {
            throw new Error("创建话题失败");
        }
    }

    // 补建 thread->user 映射（兼容旧数据）
    if (rec && rec.thread_id) {
        const mappedUser = await env.TOPIC_MAP.get(`thread:${rec.thread_id}`);
        if (!mappedUser) {
            await env.TOPIC_MAP.put(`thread:${rec.thread_id}`, String(userId));
        }
    }

    // 【修复1】验证话题是否仍然存在（带缓存，降低探测频率）
    // 当话题被删除后，KV中的thread_id仍然存在，但实际话题已不可用
    if (rec && rec.thread_id) {
        const cacheKey = rec.thread_id;
        const now = Date.now();
        const cached = threadHealthCache.get(cacheKey);
        const withinTTL = cached && (now - cached.ts < CONFIG.THREAD_HEALTH_TTL_MS);

        if (!withinTTL) {
            // 跨节点缓存：避免由于 Workers 多 PoP 导致每次都做健康探测
            const kvHealthKey = `thread_ok:${rec.thread_id}`;
            const kvHealthOk = await env.TOPIC_MAP.get(kvHealthKey);
            if (kvHealthOk === "1") {
                threadHealthCache.set(cacheKey, { ts: now, ok: true });
            } else {
            const probe = await probeForumThread(env, rec.thread_id, { userId, reason: "health_check" });

            if (probe.status === "redirected" || probe.status === "missing" || probe.status === "missing_thread_id") {
                    await resetUserVerificationAndRequireReverify(env, {
                        userId,
                        userKey: key,
                        oldThreadId: rec.thread_id,
                        pendingMsgId: msg.message_id,
                        reason: `health_check:${probe.status}`
                    });
                    return;
            } else if (probe.status === "probe_invalid") {
                Logger.warn('topic_health_probe_invalid_message', {
                    userId,
                    threadId: rec.thread_id,
                    errorDescription: probe.description
                });

                // 仍然设置短 TTL，避免每条消息都探测（并误触发重建）
                threadHealthCache.set(cacheKey, { ts: now, ok: true });
                await env.TOPIC_MAP.put(kvHealthKey, "1", { expirationTtl: Math.ceil(CONFIG.THREAD_HEALTH_TTL_MS / 1000) });
            } else if (probe.status === "unknown_error") {
                Logger.warn('topic_test_failed_unknown', {
                    userId,
                    threadId: rec.thread_id,
                    errorDescription: probe.description
                });
            } else {
                await env.TOPIC_MAP.delete(retryKey);
                threadHealthCache.set(cacheKey, { ts: now, ok: true });
                await env.TOPIC_MAP.put(kvHealthKey, "1", { expirationTtl: Math.ceil(CONFIG.THREAD_HEALTH_TTL_MS / 1000) });
            }
            }
        }
    }

    if (msg.media_group_id) {
        await handleMediaGroup(msg, env, ctx, {
            direction: "p2t",
            targetChat: env.SUPERGROUP_ID,
            threadId: rec.thread_id
        });
        return;
    }

    const res = await tgCall(env, "forwardMessage", {
        chat_id: env.SUPERGROUP_ID,
        from_chat_id: userId,
        message_id: msg.message_id,
        message_thread_id: rec.thread_id,
    });

    // 检测 Telegram 静默重定向到 General 的情况
    const resThreadId = res.result?.message_thread_id;
    if (res.ok && resThreadId !== undefined && resThreadId !== null && Number(resThreadId) !== Number(rec.thread_id)) {
        Logger.warn('forward_redirected_to_general', {
            userId,
            expectedThreadId: rec.thread_id,
            actualThreadId: resThreadId
        });

        // 删除误投到 General 的消息
        if (res.result?.message_id) {
            try {
                await tgCall(env, "deleteMessage", {
                    chat_id: env.SUPERGROUP_ID,
                    message_id: res.result.message_id
                });
            } catch (e) {
                // 删除失败不影响重发
            }
        }
        await resetUserVerificationAndRequireReverify(env, {
            userId,
            userKey: key,
            oldThreadId: rec.thread_id,
            pendingMsgId: msg.message_id,
            reason: "forward_redirected_to_general"
        });
        return;
    }

    // 兜底：部分情况下 Telegram 返回 ok 但不带 message_thread_id（可能已落入 General）
    if (res.ok && (resThreadId === undefined || resThreadId === null)) {
        const probe = await probeForumThread(env, rec.thread_id, { userId, reason: "forward_result_missing_thread_id" });
        if (probe.status !== "ok") {
            Logger.warn('forward_suspected_redirect_or_missing', {
                userId,
                expectedThreadId: rec.thread_id,
                probeStatus: probe.status,
                probeDescription: probe.description
            });

            // 尽量删除误投消息（通常在 General）
            if (res.result?.message_id) {
                try {
                    await tgCall(env, "deleteMessage", {
                        chat_id: env.SUPERGROUP_ID,
                        message_id: res.result.message_id
                    });
                } catch (e) {
                    // 删除失败不影响重发
                }
            }
            await resetUserVerificationAndRequireReverify(env, {
                userId,
                userKey: key,
                oldThreadId: rec.thread_id,
                pendingMsgId: msg.message_id,
                reason: `forward_missing_thread_id:${probe.status}`
            });
            return;
        }
    }

    // 【修复2】增强错误处理，双重保险
    // 如果上面的测试没有捕获到，这里再次检测
    if (!res.ok) {
        const desc = normalizeTgDescription(res.description);
        if (isTopicMissingOrDeleted(desc)) {
            Logger.warn('forward_failed_topic_missing', {
                userId,
                threadId: rec.thread_id,
                errorDescription: res.description
            });
            await resetUserVerificationAndRequireReverify(env, {
                userId,
                userKey: key,
                oldThreadId: rec.thread_id,
                pendingMsgId: msg.message_id,
                reason: "forward_failed_topic_missing"
            });
            return;
        }

        if (desc.includes("chat not found")) throw new Error(`群组ID错误: ${env.SUPERGROUP_ID}`);
        if (desc.includes("not enough rights")) throw new Error("机器人权限不足 (需 Manage Topics)");

        // 如果forwardMessage失败，尝试使用copyMessage作为降级方案
        await tgCall(env, "copyMessage", {
            chat_id: env.SUPERGROUP_ID,
            from_chat_id: userId,
            message_id: msg.message_id,
            message_thread_id: rec.thread_id
        });
    }
}

// ---------------- 私人转发模式（OWNER_ID） ----------------

// 是否启用私人模式：设置了 OWNER_ID 即启用，消息转发给机主个人号而非话题群
function isOwnerMode(env) {
    return !!(env && env.OWNER_ID && String(env.OWNER_ID).trim() !== "");
}

// 统一转发入口：按模式分发（验证通过后的消息、验证期间暂存的消息都走这里）
async function forwardUserMessage(msg, userId, key, env, ctx) {
    if (isOwnerMode(env)) {
        return forwardToOwner(msg, userId, key, env, ctx);
    }
    return forwardToTopic(msg, userId, key, env, ctx);
}

// 构建发给机主的信息头文本（纯文本发送，避免昵称中的 Markdown 字符导致解析失败）
function buildUserHeaderText(from, userId) {
    const name = [from?.first_name, from?.last_name].filter(Boolean).join(" ").trim() || "未知";
    const username = from?.username ? `@${from.username}` : "无";
    return `👤 来自用户的消息\n昵称: ${name}\n用户名: ${username}\nID: ${userId}\n\n💡 回复本条或下面转发的消息即可回信`;
}

// 记录机主侧消息 -> 用户的映射，供机主回复时反查
async function putFwdMapping(env, ownerMessageId, userId) {
    if (!ownerMessageId) return;
    await env.TOPIC_MAP.put(`fwd:${ownerMessageId}`, String(userId), { expirationTtl: CONFIG.FWD_MAP_TTL_SECONDS });
}

// 私人模式转发：信息头 + copyMessage 发给机主，并记录 fwd 映射（不建论坛话题）
async function forwardToOwner(msg, userId, key, env, ctx) {
    const ownerId = Number(env.OWNER_ID);

    // 并发兜底：被标记为需要重新验证时先发起验证（与话题模式一致）
    const needsVerify = await env.TOPIC_MAP.get(`needs_verify:${userId}`);
    if (needsVerify) {
        await sendVerificationChallenge(userId, env, msg.message_id || null);
        return;
    }

    let rec = await safeGetJSON(env, key, null);
    if (rec && rec.closed) {
        await tgCall(env, "sendMessage", { chat_id: userId, text: "🚫 当前对话已被管理员关闭。" });
        return;
    }
    if (!rec) {
        // 私人模式不建话题，只保留状态记录（closed/title 供 /info 使用）
        rec = { closed: false, title: buildTopicTitle(msg.from || {}) };
        await env.TOPIC_MAP.put(key, JSON.stringify(rec));
    }

    // 媒体组（相册）：整组只发一次信息头，组内消息由 handleMediaGroup 聚合后发送并记录映射
    if (msg.media_group_id) {
        const hdrKey = `mghdr:${msg.media_group_id}`;
        const hdrSent = await env.TOPIC_MAP.get(hdrKey);
        if (!hdrSent) {
            await env.TOPIC_MAP.put(hdrKey, "1", { expirationTtl: CONFIG.MEDIA_GROUP_EXPIRE_SECONDS });
            const headerRes = await tgCall(env, "sendMessage", { chat_id: ownerId, text: buildUserHeaderText(msg.from, userId) });
            if (headerRes.ok) await putFwdMapping(env, headerRes.result?.message_id, userId);
        }
        await handleMediaGroup(msg, env, ctx, {
            direction: "p2o",
            targetChat: ownerId,
            threadId: undefined,
            mapUserId: userId
        });
        return;
    }

    const headerRes = await tgCall(env, "sendMessage", { chat_id: ownerId, text: buildUserHeaderText(msg.from, userId) });
    if (headerRes.ok) await putFwdMapping(env, headerRes.result?.message_id, userId);

    const copyRes = await tgCall(env, "copyMessage", { chat_id: ownerId, from_chat_id: userId, message_id: msg.message_id });
    if (copyRes.ok) {
        await putFwdMapping(env, copyRes.result?.message_id, userId);
    } else {
        Logger.error('forward_to_owner_failed', copyRes.description || 'copyMessage failed', { userId, messageId: msg.message_id });
    }
}

// 机主私聊处理：回复机器人转发的消息 -> 回信给对应用户；回复 + 指令 -> 对该用户执行管理操作
async function handleOwnerMessage(msg, env, ctx) {
    const ownerId = Number(env.OWNER_ID);
    const replyTo = msg.reply_to_message;

    if (!replyTo) {
        // 相册的后续条目可能不带回复引用：靠 media_group_id 找回上下文后继续聚合
        if (msg.media_group_id) {
            const targetUserId = await env.TOPIC_MAP.get(`mgctx:${msg.media_group_id}`);
            if (targetUserId) {
                await handleMediaGroup(msg, env, ctx, { direction: "o2p", targetChat: Number(targetUserId), threadId: undefined });
            }
        }
        // 没有回复引用的普通消息直接忽略（不报错、不转发）
        return;
    }

    const mappedUserId = await env.TOPIC_MAP.get(`fwd:${replyTo.message_id}`);
    if (!mappedUserId) {
        await tgCall(env, "sendMessage", { chat_id: ownerId, text: "⚠️ 只能回复机器人转发的消息才能回信。" });
        return;
    }
    const userId = Number(mappedUserId);
    const text = (msg.text || "").trim();

    // 指令：回复某条转发消息时发送 /ban 等指令，作用到该用户
    if (text.startsWith("/")) {
        await handleOwnerCommand(text, userId, env);
        return;
    }

    // 媒体组回信：首条带回复引用时记录相册上下文，后续条目靠 media_group_id 续传
    if (msg.media_group_id) {
        await env.TOPIC_MAP.put(`mgctx:${msg.media_group_id}`, String(userId), { expirationTtl: CONFIG.MEDIA_GROUP_EXPIRE_SECONDS });
        await handleMediaGroup(msg, env, ctx, { direction: "o2p", targetChat: userId, threadId: undefined });
        return;
    }

    await tgCall(env, "copyMessage", { chat_id: userId, from_chat_id: ownerId, message_id: msg.message_id });
}

// 机主指令：语义与 handleAdminReply 中的同名指令一致，确认回执发回机主私聊（不涉及话题开关）
async function handleOwnerCommand(text, userId, env) {
    const ownerId = Number(env.OWNER_ID);
    const reply = (t) => tgCall(env, "sendMessage", { chat_id: ownerId, text: t, parse_mode: "Markdown" });
    const key = `user:${userId}`;

    if (text === "/close") {
        let rec = await safeGetJSON(env, key, null);
        if (!rec) rec = { closed: false };
        rec.closed = true;
        await env.TOPIC_MAP.put(key, JSON.stringify(rec));
        await reply("🚫 **对话已强制关闭**");
        return;
    }

    if (text === "/open") {
        let rec = await safeGetJSON(env, key, null);
        if (!rec) rec = { closed: false };
        rec.closed = false;
        await env.TOPIC_MAP.put(key, JSON.stringify(rec));
        await reply("✅ **对话已恢复**");
        return;
    }

    if (text === "/reset") {
        await env.TOPIC_MAP.delete(`verified:${userId}`);
        await reply("🔄 **验证重置**");
        return;
    }

    if ((text === "/trust" || text === "/bai")) {
        await env.TOPIC_MAP.put(`verified:${userId}`, "trusted");
        await env.TOPIC_MAP.delete(`needs_verify:${userId}`);
        await reply("🌟 **已设置永久信任**");
        return;
    }

    if ((text === "/ban" || text === "/hei")) {
        await env.TOPIC_MAP.put(`banned:${userId}`, "1");
        await reply("🚫 **用户已封禁**");
        return;
    }

    if ((text === "/unban" || text === "/jiehei")) {
        await env.TOPIC_MAP.delete(`banned:${userId}`);
        await reply("✅ **用户已解封**");
        return;
    }

    if ((text === "/info" || text === "/cd")) {
        const userRec = await safeGetJSON(env, key, null);
        const verifyStatus = await env.TOPIC_MAP.get(`verified:${userId}`);
        const banStatus = await env.TOPIC_MAP.get(`banned:${userId}`);
        const info = `👤 **用户信息**\nUID: \`${userId}\`\n昵称: ${userRec?.title || "未知"}\n验证状态: ${verifyStatus ? (verifyStatus === 'trusted' ? '🌟 永久信任' : '✅ 已验证') : '❌ 未验证'}\n封禁状态: ${banStatus ? '🚫 已封禁' : '✅ 正常'}\nLink: [点击私聊](tg://user?id=${userId})`;
        await reply(info);
        return;
    }

    // 未知指令不转发给用户，直接忽略
    Logger.debug('owner_unknown_command_ignored', { userId, text });
}

async function handleAdminReply(msg, env, ctx) {
  const threadId = msg.message_thread_id;
  const text = (msg.text || "").trim();
  const senderId = msg.from?.id;

  // 仅允许管理员在群内操作与回信，防止任意群成员向用户私聊注入消息
  if (!senderId || !(await isAdminUser(env, senderId))) {
      return;
  }

  // 【修复】允许在任何话题执行 /cleanup 命令
  if (text === "/cleanup") {
      // /cleanup 可能处理较久，使用 waitUntil 防止 webhook 请求超时导致“卡住”
      ctx.waitUntil(handleCleanupCommand(threadId, env));
      return;
  }

  // 优先通过 thread 映射快速反查用户，缺失时再降级全量扫描
  let userId = null;
  const mappedUser = await env.TOPIC_MAP.get(`thread:${threadId}`);
  if (mappedUser) {
      userId = Number(mappedUser);
  } else {
      const allKeys = await getAllKeys(env, "user:");
      for (const { name } of allKeys) {
          const rec = await safeGetJSON(env, name, null);
          if (rec && Number(rec.thread_id) === Number(threadId)) {
              userId = Number(name.slice(5));
              break;
          }
      }
  }

  // 如果找不到用户，说明可能是在普通话题，或者数据丢失，直接返回
  if (!userId) return; 

  // --- 指令区域 ---

  if (text === "/close") {
      const key = `user:${userId}`;
      let rec = await safeGetJSON(env, key, null);
      if (rec) {
          rec.closed = true;
          await env.TOPIC_MAP.put(key, JSON.stringify(rec));
          await tgCall(env, "closeForumTopic", { chat_id: env.SUPERGROUP_ID, message_thread_id: threadId });
          await tgCall(env, "sendMessage", { chat_id: env.SUPERGROUP_ID, message_thread_id: threadId, text: "🚫 **对话已强制关闭**", parse_mode: "Markdown" });
      }
      return;
  }

  if (text === "/open") {
      const key = `user:${userId}`;
      let rec = await safeGetJSON(env, key, null);
      if (rec) {
          rec.closed = false;
          await env.TOPIC_MAP.put(key, JSON.stringify(rec));
          await tgCall(env, "reopenForumTopic", { chat_id: env.SUPERGROUP_ID, message_thread_id: threadId });
          await tgCall(env, "sendMessage", { chat_id: env.SUPERGROUP_ID, message_thread_id: threadId, text: "✅ **对话已恢复**", parse_mode: "Markdown" });
      }
      return;
  }

  if (text === "/reset") {
      await env.TOPIC_MAP.delete(`verified:${userId}`);
      await tgCall(env, "sendMessage", { chat_id: env.SUPERGROUP_ID, message_thread_id: threadId, text: "🔄 **验证重置**", parse_mode: "Markdown" });
      return;
  }

  if ((text === "/trust" || text === "/bai")) {
      await env.TOPIC_MAP.put(`verified:${userId}`, "trusted");
      await env.TOPIC_MAP.delete(`needs_verify:${userId}`);
      await tgCall(env, "sendMessage", { chat_id: env.SUPERGROUP_ID, message_thread_id: threadId, text: "🌟 **已设置永久信任**", parse_mode: "Markdown" });
      return;
  }

  if ((text === "/ban" || text === "/hei")) {
      await env.TOPIC_MAP.put(`banned:${userId}`, "1");
      await tgCall(env, "sendMessage", { chat_id: env.SUPERGROUP_ID, message_thread_id: threadId, text: "🚫 **用户已封禁**", parse_mode: "Markdown" });
      return;
  }

  if ((text === "/unban" || text === "/jiehei")) {
      await env.TOPIC_MAP.delete(`banned:${userId}`);
      await tgCall(env, "sendMessage", { chat_id: env.SUPERGROUP_ID, message_thread_id: threadId, text: "✅ **用户已解封**", parse_mode: "Markdown" });
      return;
  }

  if ((text === "/info" || text === "/cd")) {
      const userKey = `user:${userId}`;
      const userRec = await safeGetJSON(env, userKey, null);
      const verifyStatus = await env.TOPIC_MAP.get(`verified:${userId}`);
      const banStatus = await env.TOPIC_MAP.get(`banned:${userId}`);

      const info = `👤 **用户信息**\nUID: \`${userId}\`\nTopic ID: \`${threadId}\`\n话题标题: ${userRec?.title || "未知"}\n验证状态: ${verifyStatus ? (verifyStatus === 'trusted' ? '🌟 永久信任' : '✅ 已验证') : '❌ 未验证'}\n封禁状态: ${banStatus ? '🚫 已封禁' : '✅ 正常'}\nLink: [点击私聊](tg://user?id=${userId})`;
      await tgCall(env, "sendMessage", { chat_id: env.SUPERGROUP_ID, message_thread_id: threadId, text: info, parse_mode: "Markdown" });
      return;
  }

  // 转发管理员消息给用户
  if (msg.media_group_id) {
    await handleMediaGroup(msg, env, ctx, { direction: "t2p", targetChat: userId, threadId: undefined });
    return;
  }
  await tgCall(env, "copyMessage", { chat_id: userId, from_chat_id: env.SUPERGROUP_ID, message_id: msg.message_id });
}

// ---------------- 验证模块 (动态生成) ----------------

// 挑战题型生成器：全部在运行时程序化随机生成，不使用固定题库
function pickDistinctEmojis(n) {
    return shuffleArray([...CHALLENGE_EMOJIS]).slice(0, n);
}

// ① 找不同：一组相同 emoji 里混一个不同的，点不同的那个
function genOddOneOutChallenge() {
    const [base, odd] = pickDistinctEmojis(2);
    const total = secureRandomInt(6, 9); // 6~8 个按钮
    const options = new Array(total).fill(base);
    const answerIndex = secureRandomInt(0, total);
    options[answerIndex] = odd;
    return {
        type: "odd",
        text: `🔍 **找不同**\n\n下面大部分是 ${base}，其中混了一个不一样的，请点出那个不同的。`,
        options,
        answerIndex,
        columns: 4
    };
}

// ② 数数：随机 emoji 串，数某个 emoji 出现的次数，选项为近似数字
function genCountChallenge() {
    const [target, filler] = pickDistinctEmojis(2);
    const count = secureRandomInt(3, 10); // 目标出现 3~9 次
    const fillerCount = secureRandomInt(2, 8);
    const seq = shuffleArray([
        ...new Array(count).fill(target),
        ...new Array(fillerCount).fill(filler)
    ]);
    const optionSet = new Set([count]);
    for (const d of shuffleArray([-2, -1, 1, 2, 3])) {
        if (optionSet.size >= 4) break;
        if (count + d > 0) optionSet.add(count + d);
    }
    const options = shuffleArray([...optionSet]).map(String);
    return {
        type: "count",
        text: `🔢 **数一数**\n\n${seq.join(" ")}\n\n请问 ${target} 一共有几个？`,
        options,
        answerIndex: options.indexOf(String(count)),
        columns: 2
    };
}

// ③ 指令定位：按钮单行排列，点击从左数第 N 个
function genPositionChallenge() {
    const options = pickDistinctEmojis(5);
    const n = secureRandomInt(1, 6); // 1~5
    return {
        type: "position",
        text: `👉 **按指令点击**\n\n请点击从左数第 **${n}** 个按钮。`,
        options,
        answerIndex: n - 1,
        columns: options.length
    };
}

// ④ 顺序记忆：题干给出 3 个 emoji 的序列，选出完全一致的选项
function genSequenceChallenge() {
    const seq = pickDistinctEmojis(3);
    const correct = seq.join(" ");
    const optionSet = new Set([correct]);
    let guard = 0;
    while (optionSet.size < 4 && guard < 50) {
        guard++;
        optionSet.add(shuffleArray([...seq]).join(" "));
    }
    // 兜底：随机打乱凑不够不同排列时，用逆序/轮换补齐
    if (optionSet.size < 4) optionSet.add([...seq].reverse().join(" "));
    if (optionSet.size < 4) optionSet.add([seq[1], seq[2], seq[0]].join(" "));
    const options = shuffleArray([...optionSet]);
    return {
        type: "sequence",
        text: `🧠 **顺序记忆**\n\n请记住这个顺序：\n\n${correct}\n\n下面哪个选项和它完全一致？`,
        options,
        answerIndex: options.indexOf(correct),
        columns: 1
    };
}

const CHALLENGE_GENERATORS = {
    odd: genOddOneOutChallenge,
    count: genCountChallenge,
    position: genPositionChallenge,
    sequence: genSequenceChallenge
};

// 随机生成一轮挑战（可排除已用题型，保证同一轮验证内题型不重复）
function generateChallenge(excludeTypes = []) {
    let types = Object.keys(CHALLENGE_GENERATORS).filter(t => !excludeTypes.includes(t));
    if (types.length === 0) types = Object.keys(CHALLENGE_GENERATORS);
    const type = types[secureRandomInt(0, types.length)];
    return CHALLENGE_GENERATORS[type]();
}

// 按钮使用短 ID（挑战 ID + 选项序号），避免回调数据截断
function buildChallengeKeyboard(challengeId, options, columns) {
    const buttons = options.map((opt, idx) => ({
        text: opt,
        callback_data: `verify:${challengeId}:${idx}`
    }));
    const keyboard = [];
    const cols = columns || CONFIG.BUTTON_COLUMNS;
    for (let i = 0; i < buttons.length; i += cols) {
        keyboard.push(buttons.slice(i, i + cols));
    }
    return { inline_keyboard: keyboard };
}

// 累计一次验证失败；达到上限时进入 10 分钟冷却。返回 true 表示已进入冷却
async function registerChallengeFail(env, userId) {
    const key = `verify_fails:${userId}`;
    const count = parseInt(await env.TOPIC_MAP.get(key) || "0") + 1;
    if (count >= CONFIG.CHALLENGE_MAX_FAILS) {
        await env.TOPIC_MAP.put(`verify_cooldown:${userId}`, "1", { expirationTtl: CONFIG.CHALLENGE_COOLDOWN_SECONDS });
        await env.TOPIC_MAP.delete(key);
        Logger.warn('verification_cooldown_started', { userId, failCount: count });
        return true;
    }
    await env.TOPIC_MAP.put(key, String(count), { expirationTtl: CONFIG.CHALLENGE_COOLDOWN_SECONDS });
    return false;
}

// 清理进行中的挑战状态
async function clearChallengeState(env, userId) {
    await env.TOPIC_MAP.delete(`challenge:${userId}`);
    await env.TOPIC_MAP.delete(`user_challenge:${userId}`);
}

async function sendVerificationChallenge(userId, env, pendingMsgId) {
    // 冷却中：直接提示，不下发新题
    const inCooldown = await env.TOPIC_MAP.get(`verify_cooldown:${userId}`);
    if (inCooldown) {
        await tgCall(env, "sendMessage", {
            chat_id: userId,
            text: "⏳ **验证失败次数过多**\n\n请 10 分钟后再重新发送消息进行验证。",
            parse_mode: "Markdown"
        });
        return;
    }

    // 已有进行中的挑战：仅将新消息加入待转发队列，避免重复下发题目/触发验证限速
    const existing = await safeGetJSON(env, `challenge:${userId}`, null);
    if (existing && existing.userId === userId) {
        if (pendingMsgId) {
            const pendingIds = Array.isArray(existing.pending_ids) ? existing.pending_ids.slice() : [];
            if (!pendingIds.includes(pendingMsgId)) {
                pendingIds.push(pendingMsgId);
                existing.pending_ids = pendingIds.length > CONFIG.PENDING_MAX_MESSAGES
                    ? pendingIds.slice(pendingIds.length - CONFIG.PENDING_MAX_MESSAGES)
                    : pendingIds;
                await env.TOPIC_MAP.put(`challenge:${userId}`, JSON.stringify(existing), { expirationTtl: CONFIG.CHALLENGE_TTL_SECONDS });
            }
        }
        Logger.debug('verification_duplicate_skipped', { userId, challengeId: existing.id, hasPending: !!pendingMsgId });
        return;
    }

    // 验证请求速率限制：仅在需要创建新挑战时检查
    const verifyLimit = await checkRateLimit(userId, env, 'verify', CONFIG.RATE_LIMIT_VERIFY, 300);
    if (!verifyLimit.allowed) {
        await tgCall(env, "sendMessage", {
            chat_id: userId,
            text: "⚠️ 验证请求过于频繁，请5分钟后再试。"
        });
        return;
    }

    await startChallengeRound(userId, env, {
        round: 1,
        usedTypes: [],
        pendingIds: pendingMsgId ? [pendingMsgId] : []
    });
}

// 下发一轮动态挑战（新建题目消息），并保存状态：轮次/题型/答案下标/签发时间
async function startChallengeRound(userId, env, { round, usedTypes, pendingIds }) {
    const challenge = generateChallenge(usedTypes);
    const challengeId = secureRandomId(CONFIG.VERIFY_ID_LENGTH);
    const state = {
        id: challengeId,
        userId,
        round,
        totalRounds: CONFIG.CHALLENGE_ROUNDS_REQUIRED,
        type: challenge.type,
        answerIndex: challenge.answerIndex,
        options: challenge.options,
        columns: challenge.columns,
        usedTypes: [...usedTypes, challenge.type],
        issuedAt: Date.now(),
        pending_ids: pendingIds
    };

    await env.TOPIC_MAP.put(`challenge:${userId}`, JSON.stringify(state), { expirationTtl: CONFIG.CHALLENGE_TTL_SECONDS });
    // 兼容旧指针键：标记该用户正在验证中
    await env.TOPIC_MAP.put(`user_challenge:${userId}`, challengeId, { expirationTtl: CONFIG.CHALLENGE_TTL_SECONDS });

    Logger.info('verification_sent', {
        userId,
        challengeId,
        round,
        type: challenge.type,
        pendingCount: pendingIds.length
    });

    const res = await tgCall(env, "sendMessage", {
        chat_id: userId,
        text: `🛡️ **人机验证**（第 ${round}/${state.totalRounds} 轮）\n\n${challenge.text}\n\n⏱️ 请在 ${CONFIG.CHALLENGE_TTL_SECONDS} 秒内完成，连对 ${state.totalRounds} 轮即可通过。`,
        parse_mode: "Markdown",
        reply_markup: buildChallengeKeyboard(challengeId, challenge.options, challenge.columns)
    });

    // 记录题目消息 ID，便于后续编辑同一条消息推进轮次
    if (res.ok && res.result?.message_id) {
        state.messageId = res.result.message_id;
        await env.TOPIC_MAP.put(`challenge:${userId}`, JSON.stringify(state), { expirationTtl: CONFIG.CHALLENGE_TTL_SECONDS });
    }
    return state;
}

// 一次失败处理（答错 / 答题过快）：累计次数，未达上限则作废当前挑战并立即下发新挑战（轮次从 1 重来）；达上限进入冷却
async function failChallengeAttempt(env, userId, query, state, alertText) {
    const messageId = query.message?.message_id;
    const cooldown = await registerChallengeFail(env, userId);
    await clearChallengeState(env, userId);

    await tgCall(env, "answerCallbackQuery", {
        callback_query_id: query.id,
        text: alertText,
        show_alert: true
    });

    if (messageId) {
        await tgCall(env, "editMessageText", {
            chat_id: userId,
            message_id: messageId,
            text: cooldown
                ? "⏳ **验证失败次数过多**\n\n请 10 分钟后再重新发送消息进行验证。"
                : "❌ **本轮验证已作废**\n\n请看下方新的验证题目。",
            parse_mode: "Markdown"
        });
    }

    if (!cooldown) {
        const pendingIds = Array.isArray(state.pending_ids) ? state.pending_ids : [];
        await startChallengeRound(userId, env, { round: 1, usedTypes: [], pendingIds });
    }
}

async function handleCallbackQuery(query, env, ctx) {
    try {
        const data = query.data;
        if (!data.startsWith("verify:")) return;

        const parts = data.split(":");
        if (parts.length !== 3) return;

        const challengeId = parts[1];
        const selectedIndex = parseInt(parts[2]);  // 用户选择的索引
        const userId = query.from.id;
        const messageId = query.message?.message_id;

        // 挑战状态按用户存储（challenge:<userId>），挑战 ID 不匹配说明已作废/已换新题
        const state = await safeGetJSON(env, `challenge:${userId}`, null);
        if (!state || state.id !== challengeId) {
            await tgCall(env, "answerCallbackQuery", {
                callback_query_id: query.id,
                text: "❌ 验证已过期，请重发消息",
                show_alert: true
            });
            return;
        }

        // 验证索引有效性
        if (isNaN(selectedIndex) || selectedIndex < 0 || selectedIndex >= state.options.length) {
            await tgCall(env, "answerCallbackQuery", {
                callback_query_id: query.id,
                text: "❌ 无效选项",
                show_alert: true
            });
            return;
        }

        const now = Date.now();
        const elapsed = now - (state.issuedAt || 0);

        // 挑战过期（KV TTL 之外的双保险）
        if (elapsed > CONFIG.CHALLENGE_TTL_SECONDS * 1000) {
            await clearChallengeState(env, userId);
            await tgCall(env, "answerCallbackQuery", {
                callback_query_id: query.id,
                text: "❌ 验证已过期，请重发消息",
                show_alert: true
            });
            if (messageId) {
                await tgCall(env, "editMessageText", {
                    chat_id: userId,
                    message_id: messageId,
                    text: "⌛ **验证已过期**\n\n请重新发送任意消息获取新的验证。",
                    parse_mode: "Markdown"
                });
            }
            return;
        }

        // 答题过快：真人不可能在 1 秒内看清题目并点击，视为机器人行为，作废并累计失败
        if (elapsed < CONFIG.CHALLENGE_MIN_ANSWER_MS) {
            Logger.warn('verification_too_fast', { userId, challengeId, elapsed });
            await failChallengeAttempt(env, userId, query, state, "⚠️ 操作过快，验证已作废");
            return;
        }

        // 答错：累计失败，未冷却则作废重发（轮次从 1 重来）
        if (selectedIndex !== state.answerIndex) {
            Logger.info('verification_failed', {
                userId,
                challengeId,
                selectedIndex,
                correctIndex: state.answerIndex,
                round: state.round,
                type: state.type
            });
            await failChallengeAttempt(env, userId, query, state, "❌ 答案错误");
            return;
        }

        // 本轮答对但未满轮次：编辑同一条消息进入下一轮（题型与之前不同）
        if (state.round < state.totalRounds) {
            await tgCall(env, "answerCallbackQuery", {
                callback_query_id: query.id,
                text: `✅ 第 ${state.round} 轮通过，还剩 ${state.totalRounds - state.round} 轮`
            });

            const next = generateChallenge(state.usedTypes || []);
            const nextState = {
                ...state,
                round: state.round + 1,
                type: next.type,
                answerIndex: next.answerIndex,
                options: next.options,
                columns: next.columns,
                usedTypes: [...(state.usedTypes || []), next.type],
                issuedAt: Date.now()
            };
            await env.TOPIC_MAP.put(`challenge:${userId}`, JSON.stringify(nextState), { expirationTtl: CONFIG.CHALLENGE_TTL_SECONDS });
            await env.TOPIC_MAP.put(`user_challenge:${userId}`, nextState.id, { expirationTtl: CONFIG.CHALLENGE_TTL_SECONDS });

            Logger.info('verification_round_passed', { userId, challengeId, round: state.round, nextType: next.type });

            if (messageId) {
                await tgCall(env, "editMessageText", {
                    chat_id: userId,
                    message_id: messageId,
                    text: `🛡️ **人机验证**（第 ${nextState.round}/${nextState.totalRounds} 轮）\n\n${next.text}\n\n⏱️ 请在 ${CONFIG.CHALLENGE_TTL_SECONDS} 秒内完成。`,
                    parse_mode: "Markdown",
                    reply_markup: buildChallengeKeyboard(nextState.id, next.options, next.columns)
                });
            }
            return;
        }

        // 全部轮次通过
        await tgCall(env, "answerCallbackQuery", {
            callback_query_id: query.id,
            text: "✅ 验证通过"
        });

        Logger.info('verification_passed', {
            userId,
            challengeId,
            rounds: state.totalRounds
        });

        // 30天有效期 - 使用配置常量
        await env.TOPIC_MAP.put(`verified:${userId}`, "1", { expirationTtl: CONFIG.VERIFIED_EXPIRE_SECONDS });
        await env.TOPIC_MAP.delete(`needs_verify:${userId}`);
        await env.TOPIC_MAP.delete(`verify_fails:${userId}`);
        await clearChallengeState(env, userId);

        if (messageId) {
            await tgCall(env, "editMessageText", {
                chat_id: userId,
                message_id: messageId,
                text: "✅ **验证成功**\n\n您现在可以自由对话了。",
                parse_mode: "Markdown"
            });
        }

        // 转发验证期间暂存的消息（走模式分发：话题模式 / 私人模式）
        const pendingIds = Array.isArray(state.pending_ids) ? state.pending_ids.slice() : [];
        if (pendingIds.length > 0) {
            try {
                // 限制一次性转发量，避免用户恶意堆积导致执行超时
                const limitedIds = pendingIds.length > CONFIG.PENDING_MAX_MESSAGES
                    ? pendingIds.slice(pendingIds.length - CONFIG.PENDING_MAX_MESSAGES)
                    : pendingIds;

                let forwardedCount = 0;
                for (const pendingId of limitedIds) {
                    if (!pendingId) continue;
                    const forwardedKey = `forwarded:${userId}:${pendingId}`;
                    const alreadyForwarded = await env.TOPIC_MAP.get(forwardedKey);
                    if (alreadyForwarded) {
                        Logger.info('message_forward_duplicate_skipped', { userId, messageId: pendingId });
                        continue;
                    }

                    const fakeMsg = {
                        message_id: pendingId,
                        chat: { id: userId, type: "private" },
                        from: query.from,
                    };

                    await forwardUserMessage(fakeMsg, userId, `user:${userId}`, env, ctx);
                    await env.TOPIC_MAP.put(forwardedKey, "1", { expirationTtl: 3600 });
                    forwardedCount++;
                }

                if (forwardedCount > 0) {
                    await tgCall(env, "sendMessage", {
                        chat_id: userId,
                        text: `📩 刚才的 ${forwardedCount} 条消息已帮您送达。`
                    });
                }
            } catch (e) {
                Logger.error('pending_message_forward_failed', e, { userId });
                await tgCall(env, "sendMessage", {
                    chat_id: userId,
                    text: "⚠️ 自动发送失败，请重新发送您的消息。"
                });
            }
        }
    } catch (e) {
        Logger.error('callback_query_error', e, {
            userId: query.from?.id,
            callbackData: query.data
        });
        await tgCall(env, "answerCallbackQuery", {
            callback_query_id: query.id,
            text: `⚠️ 系统错误，请重试`,
            show_alert: true
        });
    }
}


// ---------------- 辅助函数 ----------------

/**
 * 【修复 #8】批量清理命令处理函数（优化并发性能）
 *
 * 功能说明：
 * 1. 检查所有用户的话题记录
 * 2. 找出话题ID已不存在（被删除）的用户
 * 3. 删除这些用户的KV存储记录和验证状态
 * 4. 让他们下次发消息时重新验证并创建新话题
 *
 * 使用场景：
 * - 管理员手动删除了多个用户话题后
 * - 需要批量重置这些用户的状态
 *
 * @param {number} threadId - 当前话题ID（通常在General话题中调用）
 * @param {object} env - 环境变量对象
 */
async function handleCleanupCommand(threadId, env) {
    const lockKey = "cleanup:lock";
    const locked = await env.TOPIC_MAP.get(lockKey);
    if (locked) {
        await tgCall(env, "sendMessage", withMessageThreadId({
            chat_id: env.SUPERGROUP_ID,
            text: "⏳ **已有清理任务正在运行，请稍后再试。**",
            parse_mode: "Markdown"
        }, threadId));
        return;
    }

    await env.TOPIC_MAP.put(lockKey, "1", { expirationTtl: CONFIG.CLEANUP_LOCK_TTL_SECONDS });

    // 发送处理中的消息
    await tgCall(env, "sendMessage", withMessageThreadId({
        chat_id: env.SUPERGROUP_ID,
        text: "🔄 **正在扫描需要清理的用户...**",
        parse_mode: "Markdown"
    }, threadId));

    let cleanedCount = 0;
    let errorCount = 0;
    const cleanedUsers = [];
    let scannedCount = 0;

    try {
        // 逐页扫描，避免一次性拉取全部 keys 导致超时/内存膨胀
        let cursor = undefined;
        do {
            const result = await env.TOPIC_MAP.list({ prefix: "user:", cursor });
            const names = (result.keys || []).map(k => k.name);
            scannedCount += names.length;

            // 批量并发处理（限制并发数）
            for (let i = 0; i < names.length; i += CONFIG.CLEANUP_BATCH_SIZE) {
                const batch = names.slice(i, i + CONFIG.CLEANUP_BATCH_SIZE);

                const results = await Promise.allSettled(
                    batch.map(async (name) => {
                        const rec = await safeGetJSON(env, name, null);
                    if (!rec || !rec.thread_id) return null;

                    const userId = name.slice(5);
                    const topicThreadId = rec.thread_id;

                    // 检测话题是否存在：尝试向话题发送测试消息
                    const probe = await probeForumThread(env, topicThreadId, {
                        userId,
                        reason: "cleanup_check",
                        doubleCheckOnMissingThreadId: false
                    });

                    // cleanup 要求更保守：仅在明确缺失/重定向时清理，避免误删有效记录
                    if (probe.status === "redirected" || probe.status === "missing") {
                            await env.TOPIC_MAP.delete(name);
                            await env.TOPIC_MAP.delete(`verified:${userId}`);
                            await env.TOPIC_MAP.delete(`thread:${topicThreadId}`);

                            return {
                                userId,
                                threadId: topicThreadId,
                                title: rec.title || "未知"
                            };
                    } else if (probe.status === "probe_invalid") {
                        Logger.warn('cleanup_probe_invalid_message', {
                            userId,
                            threadId: topicThreadId,
                            errorDescription: probe.description
                        });
                    } else if (probe.status === "unknown_error") {
                        Logger.warn('cleanup_probe_failed_unknown', {
                            userId,
                            threadId: topicThreadId,
                            errorDescription: probe.description
                        });
                    } else if (probe.status === "missing_thread_id") {
                        Logger.warn('cleanup_probe_missing_thread_id', { userId, threadId: topicThreadId });
                    }

                    return null;
                })
            );

            // 处理结果
            results.forEach(result => {
                if (result.status === 'fulfilled' && result.value) {
                    cleanedCount++;
                    cleanedUsers.push(result.value);
                    Logger.info('cleanup_user', {
                        userId: result.value.userId,
                        threadId: result.value.threadId
                    });
                } else if (result.status === 'rejected') {
                    errorCount++;
                    Logger.error('cleanup_batch_error', result.reason);
                }
            });

                // 防止速率限制
                if (i + CONFIG.CLEANUP_BATCH_SIZE < names.length) {
                    await new Promise(r => setTimeout(r, 600));
                }
            }

            cursor = result.list_complete ? undefined : result.cursor;

            // 在分页之间让出时间片，降低单次执行压力
            if (cursor) {
                await new Promise(r => setTimeout(r, 200));
            }
        } while (cursor);

        // 生成并发送清理报告
        let reportText = `✅ **清理完成**\n\n`;
        reportText += `📊 **统计信息**\n`;
        reportText += `- 扫描用户数: ${scannedCount}\n`;
        reportText += `- 已清理用户数: ${cleanedCount}\n`;
        reportText += `- 错误数: ${errorCount}\n\n`;

        if (cleanedCount > 0) {
            reportText += `🗑️ **已清理的用户** (话题已删除):\n`;
            for (const user of cleanedUsers.slice(0, CONFIG.MAX_CLEANUP_DISPLAY)) {
                reportText += `- UID: \`${user.userId}\` | 话题: ${user.title}\n`;
            }
            if (cleanedUsers.length > CONFIG.MAX_CLEANUP_DISPLAY) {
                reportText += `\n...(还有 ${cleanedUsers.length - CONFIG.MAX_CLEANUP_DISPLAY} 个用户)\n`;
            }
            reportText += `\n💡 这些用户下次发消息时将重新进行人机验证并创建新话题。`;
        } else {
            reportText += `✨ 没有发现需要清理的用户记录。`;
        }

        Logger.info('cleanup_completed', {
            cleanedCount,
            errorCount,
            totalUsers: scannedCount
        });

        await tgCall(env, "sendMessage", withMessageThreadId({
            chat_id: env.SUPERGROUP_ID,
            text: reportText,
            parse_mode: "Markdown"
        }, threadId));

    } catch (e) {
        Logger.error('cleanup_failed', e, { threadId });
        await tgCall(env, "sendMessage", withMessageThreadId({
            chat_id: env.SUPERGROUP_ID,
            text: `❌ **清理过程出错**\n\n错误信息: \`${e.message}\``,
            parse_mode: "Markdown"
        }, threadId));
    } finally {
        await env.TOPIC_MAP.delete(lockKey);
    }
}

// ---------------- 其他辅助函数 ----------------

// 为话题建立 thread->user 映射，避免管理员命令时全量 KV 反查
async function createTopic(from, key, env, userId) {
    const title = buildTopicTitle(from);
    if (!env.SUPERGROUP_ID.toString().startsWith("-100")) throw new Error("SUPERGROUP_ID必须以-100开头");
    const res = await tgCall(env, "createForumTopic", { chat_id: env.SUPERGROUP_ID, name: title });
    if (!res.ok) throw new Error(`创建话题失败: ${res.description}`);
    const rec = { thread_id: res.result.message_thread_id, title, closed: false };
    await env.TOPIC_MAP.put(key, JSON.stringify(rec));
    if (userId) {
        await env.TOPIC_MAP.put(`thread:${rec.thread_id}`, String(userId));
    }
    return rec;
}

// 【修复 #2】更新话题状态 - 修复异步操作未等待
async function updateThreadStatus(threadId, isClosed, env) {
    try {
        const mappedUser = await env.TOPIC_MAP.get(`thread:${threadId}`);
        if (mappedUser) {
            const userKey = `user:${mappedUser}`;
            const rec = await safeGetJSON(env, userKey, null);
            if (rec && Number(rec.thread_id) === Number(threadId)) {
                rec.closed = isClosed;
                await env.TOPIC_MAP.put(userKey, JSON.stringify(rec));
                Logger.info('thread_status_updated', { threadId, isClosed, updatedCount: 1 });
                return;
            }

            // 映射失效：清理后降级全量扫描
            await env.TOPIC_MAP.delete(`thread:${threadId}`);
        }

        const allKeys = await getAllKeys(env, "user:");
        const updates = [];

        for (const { name } of allKeys) {
            const rec = await safeGetJSON(env, name, null);
            if (rec && Number(rec.thread_id) === Number(threadId)) {
                rec.closed = isClosed;
                updates.push(env.TOPIC_MAP.put(name, JSON.stringify(rec)));
            }
        }

        await Promise.all(updates);
        Logger.info('thread_status_updated', { threadId, isClosed, updatedCount: updates.length });
    } catch (e) {
        Logger.error('thread_status_update_failed', e, { threadId, isClosed });
        throw e;
    }
}

// 改进的话题标题构建（清理特殊字符）
function buildTopicTitle(from) {
  const firstName = (from.first_name || "").trim().substring(0, CONFIG.MAX_NAME_LENGTH);
  const lastName = (from.last_name || "").trim().substring(0, CONFIG.MAX_NAME_LENGTH);

  // 清理 username
  let username = "";
  if (from.username) {
      username = from.username
          .replace(/[^\w]/g, '')  // 只保留字母数字下划线
          .substring(0, 20);
  }

  // 移除控制字符和换行符
  const cleanName = (firstName + " " + lastName)
      .replace(/[\u0000-\u001F\u007F-\u009F]/g, '')
      .replace(/\s+/g, ' ')
      .trim();

  const name = cleanName || "User";
  const usernameStr = username ? ` @${username}` : "";

  // Telegram 话题标题最大长度为 128 字符
  const title = (name + usernameStr).substring(0, CONFIG.MAX_TITLE_LENGTH);

  return title;
}

// 改进的 Telegram API 调用（添加超时和 HTTPS 强制）
async function tgCall(env, method, body, timeout = CONFIG.API_TIMEOUT_MS) {
  let base = env.API_BASE || "https://api.telegram.org";

  // 【修复 #20】强制 HTTPS
  if (base.startsWith("http://")) {
      Logger.warn('api_http_upgraded', { originalBase: base });
      base = base.replace("http://", "https://");
  }

  // 验证 URL 格式
  try {
      new URL(`${base}/test`);
  } catch (e) {
      Logger.error('api_base_invalid', e, { base });
      base = "https://api.telegram.org";
  }

  // 【修复 #13】添加超时控制
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeout);

  try {
      const resp = await fetch(`${base}/bot${env.BOT_TOKEN}/${method}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
          signal: controller.signal
      });

      clearTimeout(timeoutId);

      if (!resp.ok && resp.status >= 500) {
          Logger.warn('telegram_api_server_error', {
              method,
              status: resp.status
          });
      }

      const result = await resp.json();

      // 记录速率限制
      if (!result.ok && result.description && result.description.includes('Too Many Requests')) {
          const retryAfter = result.parameters?.retry_after || 5;
          Logger.warn('telegram_api_rate_limit', {
              method,
              retryAfter
          });
      }

      return result;
  } catch (e) {
      clearTimeout(timeoutId);

      if (e.name === 'AbortError') {
          Logger.error('telegram_api_timeout', e, { method, timeout });
          return { ok: false, description: 'Request timeout' };
      }

      Logger.error('telegram_api_failed', e, { method });
      throw e;
  }
}

async function handleMediaGroup(msg, env, ctx, { direction, targetChat, threadId, mapUserId }) {
    const groupId = msg.media_group_id;
    const key = `mg:${direction}:${groupId}`;
    const item = extractMedia(msg);
    if (!item) {
        const res = await tgCall(env, "copyMessage", withMessageThreadId({
            chat_id: targetChat,
            from_chat_id: msg.chat.id,
            message_id: msg.message_id
        }, threadId));
        // 私人模式：记录转发映射，机主回复这条消息时可反查用户
        if (mapUserId && res.ok) await putFwdMapping(env, res.result?.message_id, mapUserId);
        return;
    }
    let rec = await safeGetJSON(env, key, null);
    if (!rec) rec = { direction, targetChat, threadId: (threadId === null ? undefined : threadId), mapUserId: mapUserId || undefined, items: [], last_ts: Date.now() };
    rec.items.push({ ...item, msg_id: msg.message_id });
    rec.last_ts = Date.now();
    await env.TOPIC_MAP.put(key, JSON.stringify(rec), { expirationTtl: CONFIG.MEDIA_GROUP_EXPIRE_SECONDS });
    ctx.waitUntil(delaySend(env, key, rec.last_ts));
}

// 【修复 #15, #19】改进的媒体提取（支持更多类型，不修改原数组）
function extractMedia(msg) {
    // 图片
    if (msg.photo && msg.photo.length > 0) {
        const highestResolution = msg.photo[msg.photo.length - 1];  // 不使用 pop()
        return {
            type: "photo",
            id: highestResolution.file_id,
            cap: msg.caption || ""
        };
    }

    // 视频
    if (msg.video) {
        return {
            type: "video",
            id: msg.video.file_id,
            cap: msg.caption || ""
        };
    }

    // 文档
    if (msg.document) {
        return {
            type: "document",
            id: msg.document.file_id,
            cap: msg.caption || ""
        };
    }

    // 音频
    if (msg.audio) {
        return {
            type: "audio",
            id: msg.audio.file_id,
            cap: msg.caption || ""
        };
    }

    // 动图
    if (msg.animation) {
        return {
            type: "animation",
            id: msg.animation.file_id,
            cap: msg.caption || ""
        };
    }

    // 语音和视频消息不支持 media group
    return null;
}

// 【修复 #21】实现媒体组清理
async function flushExpiredMediaGroups(env, now) {
    try {
        const prefix = "mg:";
        const allKeys = await getAllKeys(env, prefix);
        let deletedCount = 0;

        for (const { name } of allKeys) {
            const rec = await safeGetJSON(env, name, null);
            if (rec && rec.last_ts && (now - rec.last_ts > 300000)) { // 超过 5 分钟
                await env.TOPIC_MAP.delete(name);
                deletedCount++;
            }
        }

        if (deletedCount > 0) {
            Logger.info('media_groups_cleaned', { deletedCount });
        }
    } catch (e) {
        Logger.error('media_group_cleanup_failed', e);
    }
}

// 【修复 #12, #28】改进媒体组延迟发送
async function delaySend(env, key, ts) {
    await new Promise(r => setTimeout(r, CONFIG.MEDIA_GROUP_DELAY_MS));

    const rec = await safeGetJSON(env, key, null);

    if (rec && rec.last_ts === ts) {
        // 验证媒体数组
        if (!rec.items || rec.items.length === 0) {
            Logger.warn('media_group_empty', { key });
            await env.TOPIC_MAP.delete(key);
            return;
        }

        const media = rec.items.map((it, i) => {
            if (!it.type || !it.id) {
                Logger.warn('media_group_invalid_item', { key, item: it });
                return null;
            }
            // 【修复 #28】限制 caption 长度
            const caption = i === 0 ? (it.cap || "").substring(0, 1024) : "";
            return { 
                type: it.type,
                media: it.id,
                caption
            };
        }).filter(Boolean);  // 过滤掉无效项

        if (media.length > 0) {
            try {
                const result = await tgCall(env, "sendMediaGroup", withMessageThreadId({
                    chat_id: rec.targetChat,
                    media
                }, rec.threadId));

                if (!result.ok) {
                    Logger.error('media_group_send_failed', result.description, {
                        key,
                        mediaCount: media.length
                    });
                } else {
                    Logger.info('media_group_sent', {
                        key,
                        mediaCount: media.length,
                        targetChat: rec.targetChat
                    });
                    // 私人模式：为相册每条消息记录 fwd 映射，机主回复任意一条即可回信
                    if (rec.mapUserId && Array.isArray(result.result)) {
                        for (const m of result.result) {
                            await putFwdMapping(env, m?.message_id, rec.mapUserId);
                        }
                    }
                }
            } catch (e) {
                Logger.error('media_group_send_exception', e, { key });
            }
        }

        await env.TOPIC_MAP.delete(key);
    }
}
