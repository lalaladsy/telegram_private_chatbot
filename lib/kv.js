// Upstash Redis REST client with a Cloudflare KV-compatible surface.
// Implements the subset of KV used by bot.js: get / put / delete / list.

export function createKV(url, token) {
  if (!url || !token) return null;

  async function cmd(...args) {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(args),
    });
    if (!res.ok) throw new Error(`Upstash HTTP ${res.status}`);
    const data = await res.json();
    if (data.error) throw new Error(`Upstash: ${data.error}`);
    return data.result;
  }

  return {
    async get(key, opts) {
      const val = await cmd("GET", key);
      if (val === null || val === undefined) return null;
      if (opts && opts.type === "json") {
        try {
          return JSON.parse(val);
        } catch {
          return val;
        }
      }
      return val;
    },

    async put(key, value, opts) {
      const v = typeof value === "string" ? value : JSON.stringify(value);
      if (opts && opts.expirationTtl) {
        return cmd("SET", key, v, "EX", String(Math.max(1, Math.floor(opts.expirationTtl))));
      }
      return cmd("SET", key, v);
    },

    async delete(key) {
      return cmd("DEL", key);
    },

    // Cloudflare KV list: { keys: [{name}], list_complete, cursor }
    // Backed by Redis SCAN with MATCH prefix*.
    async list(opts = {}) {
      const prefix = opts.prefix || "";
      const cursor = opts.cursor || "0";
      const [next, keys] = await cmd("SCAN", cursor, "MATCH", `${prefix}*`, "COUNT", "200");
      const complete = next === "0";
      return {
        keys: keys.map((name) => ({ name })),
        list_complete: complete,
        cursor: complete ? "" : next,
      };
    },
  };
}
