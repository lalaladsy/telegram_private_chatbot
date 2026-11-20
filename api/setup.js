// One-time webhook activation:
// Visit https://<your-project>.vercel.app/api/setup?key=<SETUP_SECRET>
// It registers /api/webhook on this deployment as the Telegram webhook.

export const config = { runtime: "edge" };

export default async function handler(request) {
  const url = new URL(request.url);
  const secret = process.env.SETUP_SECRET;
  if (!secret || url.searchParams.get("key") !== secret) {
    return new Response("Forbidden", { status: 403 });
  }
  const token = process.env.BOT_TOKEN;
  if (!token) return new Response("BOT_TOKEN not set", { status: 500 });

  const webhookUrl = `${url.origin}/api/webhook`;
  const res = await fetch(`https://api.telegram.org/bot${token}/setWebhook`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      url: webhookUrl,
      allowed_updates: ["message", "callback_query"],
      drop_pending_updates: true,
    }),
  });
  const data = await res.json();
  return new Response(JSON.stringify({ webhook: webhookUrl, telegram: data }, null, 2), {
    headers: { "Content-Type": "application/json" },
  });
}
