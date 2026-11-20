// Vercel Edge Function entry: adapts the Cloudflare Worker bot to Vercel.
// Telegram webhook URL: https://<your-project>.vercel.app/api/webhook

import { waitUntil } from "@vercel/functions";
import bot from "../lib/bot.js";
import { createKV } from "../lib/kv.js";

export const config = { runtime: "edge" };

export default async function handler(request) {
  const env = {
    TOPIC_MAP: createKV(
      process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL,
      process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN
    ),
    BOT_TOKEN: process.env.BOT_TOKEN,
    OWNER_ID: process.env.OWNER_ID || "",
    SUPERGROUP_ID: process.env.SUPERGROUP_ID,
    ADMIN_IDS: process.env.ADMIN_IDS || "",
    API_BASE: process.env.API_BASE || "",
  };
  const ctx = {
    waitUntil: (p) => {
      try {
        waitUntil(p);
      } catch {
        // Outside Vercel (local dev): fire and forget.
        Promise.resolve(p).catch(() => {});
      }
    },
  };
  return bot.fetch(request, env, ctx);
}
