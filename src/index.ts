import "./shims";
import { makeSigner } from "./signer";
import type { ScheduledController, ExecutionContext } from '@cloudflare/workers-types';

export interface Env {
  TOKENS_KV: KVNamespace;
  TIKTOK_CLIENT_KEY: string;
  TIKTOK_CLIENT_SECRET: string;
  OAUTH_REDIRECT_URL: string;
  SCOPES: string;
  AUTHORIZE_URL: string;
  TOKEN_URL: string;
  POST_INIT_URL: string;
  POST_API_KEY?: string;
  R2_ACCESS_KEY_ID: string;
  R2_SECRET_ACCESS_KEY: string;
  R2_BUCKET: string;
  CUSTOM_MEDIA_HOST: string;
}

const SITE_HOME = "https://tryr2media.zerotosixtycreative.co.uk";

// top-level (safe)
let BUILD: { ts: string; nonce: string } | undefined;

function getBuildMeta() {
  if (!BUILD) {
    // This runs the first time you call it from inside fetch()
    const uuid = (globalThis.crypto as any)?.randomUUID?.() ??
                 `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    BUILD = {
      ts: new Date().toISOString(),
      nonce: uuid,
    };
  }
  return BUILD;
}
export default {
  async fetch(req, env, ctx) {
    // If you need it for a route (e.g. /__version):
    const url = new URL(req.url);
    if (url.pathname === "/__version") {
      const b = getBuildMeta();
      return new Response("ok", {
        headers: {
          "x-build-ts": b.ts,
          "x-build-nonce": b.nonce,
        }
      });
    }

    if (url.pathname === "/login") return login(url, env);
    if (url.pathname === "/callback") return callback(url, env);
    if (url.pathname === "/connected-success") return connectedSuccessPage(); 
    if (url.pathname === "/post" && req.method === "POST") return webhook(req, env);
    if (url.pathname === "/keys/new" && req.method === "GET") return newKeyForm();
    if (url.pathname === "/keys/new" && req.method === "POST") return createKey(req, env);
    if (url.pathname === "/health") return json({ ok: true });
    if (url.pathname === "/webhook" && req.method === "POST") {
      const dry = url.searchParams.get("dry") === "1" || req.headers.get("X-Dry-Run") === "1";
      return webhook(req, env, { dry });
    }

    if (url.pathname === "/preflight" && req.method === "POST") {
      const { testUrl } = await req.json().catch(() => ({}));
      if (!testUrl) return json({ ok:false, error:"missing testUrl" }, 400);
      const head = await fetch(testUrl, { method: "HEAD" });  // ok if 403, we’ll try range GET too
      const range = await fetch(testUrl, { headers: { Range: "bytes=0-0" }});
      return json({
        ok: (head.ok || range.status === 206),
        head: {
          status: head.status,
          "content-type": head.headers.get("content-type"),
          "content-length": head.headers.get("content-length"),
          "accept-ranges": head.headers.get("accept-ranges")
        },
        range: { status: range.status }
      });
    }

    if (url.pathname === "/debug-signer") {
      try {
        const id = url.searchParams.get("id") || undefined;
        const rawUrl = url.searchParams.get("url") || undefined;
        if (!id && !rawUrl) return json({ error: "pass id= or url=" }, 400);

        const signer = makeSigner({
          R2_ACCESS_KEY_ID: env.R2_ACCESS_KEY_ID,
          R2_SECRET_ACCESS_KEY: env.R2_SECRET_ACCESS_KEY,
          R2_BUCKET: env.R2_BUCKET,
          CUSTOM_MEDIA_HOST: env.CUSTOM_MEDIA_HOST,
        });

        const signed = await signer.resolveAndSign({ id, url: rawUrl });
        return json({ ok: true, signed });
      } catch (e: any) {
        return json({ ok: false, error: String(e), stack: e?.stack }, 500);
      }
    }

    return new Response("ok");
  },

async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(purgeSelective(env));
  }
};

async function purgeSelective(env: Env) {
  const dryRun = (env as any).PURGE_DRY_RUN === "true";
  const rmUnmatched = (env as any).PURGE_REMOVE_UNMATCHED !== "false";
  const maxPendingHours = parseInt((env as any).PURGE_PENDING_MAX_HOURS || "24", 10);

  const now = Date.now();
  const maxPendingAgeMs = maxPendingHours * 3600 * 1000;

  let cursor: string | undefined;
  let totalChecked = 0;
  let totalDelete = 0;

  do {
    const page = await env.TOKENS_KV.list({ prefix: "api:", cursor });
    cursor = page.cursor || undefined;

    for (const k of page.keys) {
      totalChecked++;
      const key = k.name;

      // Read value
      const raw = await env.TOKENS_KV.get(key);
      if (!raw) continue;

      let meta: any;
      try { meta = JSON.parse(raw); } catch { continue; }

      const status = meta.status as string | undefined;
      const openId = meta.open_id as string | undefined;
      const createdAt = typeof meta.created_at === "number" ? meta.created_at : 0;

      let shouldDelete = false;
      let reason = "";

      // (1) Pending older than threshold
      if (status === "pending") {
        if (now - createdAt > maxPendingAgeMs) {
          shouldDelete = true;
          reason = `pending>${maxPendingHours}h`;
        }
      }

      // (2) Active but unmatched (no corresponding tok:open:<open_id>)
      if (!shouldDelete && rmUnmatched && status === "active" && openId) {
        const tok = await env.TOKENS_KV.get(`tok:open:${openId}`);
        if (!tok) {
          shouldDelete = true;
          reason = "active_unmatched";
        }
      }

      if (shouldDelete) {
        totalDelete++;
        if (dryRun) {
          console.log(`DRY: would delete ${key} (${reason})`);
        } else {
          await env.TOKENS_KV.delete(key);
          console.log(`Deleted ${key} (${reason})`);
        }
      }
    }
  } while (cursor);

  console.log(`Purge done. Checked=${totalChecked} Deleted=${totalDelete} DryRun=${(env as any).PURGE_DRY_RUN}`);
}

function json(data: unknown, status = 200, build?: { ts: string; nonce: string }) {
  const b = build ?? getBuildMeta(); // lazy init inside handler
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      "content-type": "application/json",
      "cache-control": "no-store, no-cache, must-revalidate",
      "x-build-ts": b.ts,
      "x-build-nonce": b.nonce,
    },
  });
}

function html(markup: string, status = 200) {
  return new Response(markup, {
    status,
    headers: { "content-type": "text/html; charset=UTF-8" }
  });
}

function b64url(u8: Uint8Array) {
  return btoa(String.fromCharCode(...u8))
    .replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

async function sha256Base64Url(s: string) {
  const enc = new TextEncoder().encode(s);
  const buf = await crypto.subtle.digest("SHA-256", enc);
  return b64url(new Uint8Array(buf));
}

async function mintApiToken() {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return `rk_live_${b64url(bytes)}`; // shown once, we only store a hash
}

async function login(url: URL, env: Env) {
  const show = url.searchParams.get("show") || "";
  if (!show) {
    // No one-time key in play → send them to create one first
    return Response.redirect("/keys/new", 302);
  }

  const state = crypto.randomUUID();
  await env.TOKENS_KV.put(`state:${state}`, JSON.stringify({ show }), { expirationTtl: 300 });

  const auth = new URL(env.AUTHORIZE_URL);
  auth.searchParams.set("client_key", env.TIKTOK_CLIENT_KEY);
  auth.searchParams.set("response_type", "code");
  auth.searchParams.set("redirect_uri", env.OAUTH_REDIRECT_URL);
  auth.searchParams.set("scope", env.SCOPES);
  auth.searchParams.set("state", state);

  return Response.redirect(auth.toString(), 302);
}

function newKeyForm() {
  const page = `<!doctype html><html><head>
<meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Create API key • R2 TikTok Upload</title>
<script src="https://cdn.tailwindcss.com"></script>
<script>tailwind.config={theme:{extend:{colors:{offwhite:'#fdf7ed',brandred:'#e6372e'},boxShadow:{soft:'0 10px 30px rgba(0,0,0,.06)'}}}}</script>
</head>
<body class="bg-offwhite min-h-screen flex items-center justify-center p-6">
  <form method="POST" class="w-full max-w-md bg-white rounded-2xl p-6 shadow">
    <div class="flex items-center justify-between mb-3">
      <h1 class="text-2xl font-bold">Create your API key</h1>
    </div>
    <p class="text-black/70 mb-4">We’ll generate a secure key and show it once. Then you’ll connect TikTok.</p>
    <button class="w-full rounded bg-brandred text-white px-4 py-2">Create key</button>
    <div class="flex items-center justify-center mt-2">
      <a href="${SITE_HOME}" class="text-sm text-center text-brandred  hover:underline">Back to site</a>
    </div>
  </form>

  <script>
    // Listen for the TikTok popup message and redirect this tab
    window.addEventListener("message", (event) => {
      if (event.data?.type === "tiktok-auth" && event.data.ok) {
        location.href = "/connected-success";
      }
    });
  </script>
</body></html>`;
  return html(page);
}

async function createKey(req: Request, env: Env) {
  const ip = getClientIp(req);
  const rl = await enforceRate(env, `rk:newkey:${ip}`, 5, 3600);
  if (!rl.allowed) return ratelimitedJson(rl);
  const raw = await mintApiToken();
  const hash = await sha256Base64Url(raw);
  const showId = crypto.randomUUID();
  const now = Date.now();

  // mark pending
  await env.TOKENS_KV.put(`api:${hash}`, JSON.stringify({ status: "pending", created_at: now }));
  // one-time stash to show again on callback
  await env.TOKENS_KV.put(`showkey:${showId}`, raw, { expirationTtl: 600 });

  const page = `<!doctype html><html><head>
<meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Your API key • R2 TikTok Upload</title>
<script src="https://cdn.tailwindcss.com"></script>
<script>tailwind.config={theme:{extend:{colors:{offwhite:'#fdf7ed',brandred:'#e6372e'}}}}</script>
</head>
<body class="bg-offwhite min-h-screen flex items-center justify-center p-6">
  <div class="w-full max-w-xl bg-white rounded-2xl p-6 shadow">
    <h1 class="text-2xl font-bold">API key created</h1>
    <p class="text-black/70 mt-2">Copy and store this key securely. You’ll use it as the <code>X-Api-Key</code> header.</p>
    <pre class="mt-4 rounded bg-black/90 text-white p-4 select-all text-sm overflow-x-auto">${raw}</pre>
    <p class="mt-1 text-xs text-black/60">Shown once. We only store a secure hash.</p>
    <div class="mt-6 flex gap-3">
      <a class="rounded bg-brandred text-white px-4 py-2"
         href="/login?show=${encodeURIComponent(showId)}" target="_blank" rel="noopener">Connect TikTok</a>
      <a class="rounded border border-brandred text-brandred px-4 py-2" href="${SITE_HOME}">Back to home</a>
    </div>
  </div>
  <script>
    window.addEventListener("message", (event) => {
      if (event.data?.type === "tiktok-auth" && event.data.ok) {
        // redirect within the same Worker
        location.href = "/connected-success";
      }
    });
  </script>
</body></html>`;
  return html(page);
}

function connectedSuccessPage() {
  const page = `<!doctype html><html><head>
<meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Connected • R2 TikTok Upload</title>
<script src="https://cdn.tailwindcss.com"></script>
<script>tailwind.config={theme:{extend:{colors:{offwhite:'#fdf7ed',brandred:'#e6372e'},boxShadow:{soft:'0 10px 30px rgba(0,0,0,.06)'}}}}</script>
</head>
<body class="bg-offwhite min-h-screen flex items-center justify-center p-6">
  <div class="bg-white p-8 rounded-2xl shadow text-center max-w-md w-full">
    <h1 class="text-2xl font-bold text-brandred">🎉 Connected to TikTok!</h1>
    <p class="mt-3 text-black/70">Your TikTok account is now linked. You can safely close this window after putting your API key somewhere safe.</p>
    <div class="mt-6">
      <a href="${SITE_HOME}" class="rounded bg-brandred text-white px-4 py-2">Back to home</a>
    </div>
  </div>
</body></html>`;
  return html(page);
}

async function callback(url: URL, env: Env) {
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  if (!code || !state) {
    return renderCallbackPage({ ok:false, title:"Missing info", message:"Code/state missing.", details:"Try Connect TikTok again." }, 400);
  }

  const stateRaw = await env.TOKENS_KV.get(`state:${state}`);
  if (!stateRaw) {
    return renderCallbackPage({ ok:false, title:"Session expired", message:"Sign-in session expired.", details:"Try Connect TikTok again." }, 400);
  }
  let info: { show?: string } = {};
  try { info = JSON.parse(stateRaw || "{}"); } catch {}

  const body = new URLSearchParams({
    client_key: env.TIKTOK_CLIENT_KEY,
    client_secret: env.TIKTOK_CLIENT_SECRET,
    code,
    grant_type: "authorization_code",
    redirect_uri: env.OAUTH_REDIRECT_URL
  });

  const r = await fetch(env.TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body
  });

  if (!r.ok) {
    const detail = await safeText(r);
    return renderCallbackPage({ ok:false, title:"Couldn’t connect to TikTok", message:"The token exchange failed.", details: detail || "Please try again." }, 500);
  }

  const data = await r.json(); // access_token, refresh_token, open_id, expires_in
  // store tokens per TikTok account
  await env.TOKENS_KV.put(`tok:open:${data.open_id}`, JSON.stringify({ ...data, obtained_at: Date.now() }));

  // If we carried a show-id, reveal key once more and activate it
  let showKey = "";
  if (info.show) {
    showKey = await env.TOKENS_KV.get(`showkey:${info.show}`) || "";
    if (showKey) {
      await env.TOKENS_KV.delete(`showkey:${info.show}`);
      const hash = await sha256Base64Url(showKey);
      await env.TOKENS_KV.put(`api:${hash}`, JSON.stringify({
        status: "active",
        open_id: data.open_id,
        created_at: Date.now()
      }));
    }
  }

  return renderCallbackPage({
    ok: true,
    title: "Connected to TikTok",
    message: "You can close this window now.",
    details: "",
    apiKeyOnce: showKey
  });
}

function renderCallbackPage(
  opts: { ok: boolean; title: string; message: string; details?: string; apiKeyOnce?: string },
  status = 200
) {
  const ok = opts.ok ? "true" : "false";
  const keyBlock = opts.apiKeyOnce
    ? `<h2 class="text-lg font-semibold mt-6">Your API key (save this)</h2>
       <pre class="mt-2 rounded bg-black/90 text-white p-3 select-all text-sm">${opts.apiKeyOnce}</pre>
       <p class="text-xs text-black/60 mt-1">Shown once. We only store a secure hash.</p>`
    : "";

  const markup = `<!DOCTYPE html><html lang="en"><head>
<meta charset="UTF-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>${opts.ok ? "Connected" : "Error"} • R2 TikTok Upload</title>
<script src="https://cdn.tailwindcss.com"></script>
<script>tailwind.config={theme:{extend:{colors:{offwhite:'#fdf7ed',brandred:'#e6372e'},boxShadow:{soft:'0 10px 30px rgba(0,0,0,.06)'}}}}</script>
</head>
<body class="bg-offwhite text-[#1a1a1a] font-sans min-h-screen flex items-center justify-center p-6">
  <div class="w-full max-w-md rounded-2xl bg-white shadow-soft p-8 text-center">
    <div class="mx-auto mb-4 h-12 w-12 rounded-full flex items-center justify-center ${opts.ok ? 'bg-brandred/10 text-brandred' : 'bg-red-100 text-brandred'}">
      ${opts.ok
        ? '<svg xmlns="http://www.w3.org/2000/svg" class="h-7 w-7" viewBox="0 0 24 24" fill="currentColor"><path d="M9 16.2 4.8 12l-1.4 1.4L9 19 21 7l-1.4-1.4z"/></svg>'
        : '<svg xmlns="http://www.w3.org/2000/svg" class="h-7 w-7" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20Zm1 14h-2v-2h2v2Zm0-4h-2V6h2v6Z"/></svg>'}
    </div>
    <h1 class="text-2xl font-bold">${opts.title}</h1>
    <p class="mt-2 text-black/70">${opts.message}</p>
    ${opts.details ? `<pre class="mt-4 text-left whitespace-pre-wrap break-words rounded bg-black/5 p-3 text-sm text-black/70">${opts.details}</pre>` : ''}
    ${keyBlock}
    <div class="mt-6 flex flex-col items-center gap-2">
      <a href="${SITE_HOME}" class="rounded-lg bg-brandred px-4 py-2 text-white hover:opacity-90 transition">Back to home</a>
    </div>
  </div>
  <script>
    // Notify the opener, but do NOT auto-close this window.
    try { window.opener && window.opener.postMessage({ type: "tiktok-auth", ok: ${ok} }, "*"); } catch(e) {}
  </script>
</body></html>`;
  return html(markup, status);
}

async function webhook(req: Request, env: Env, opts: { dry?: boolean } = {}) {
  // API key auth (no usernames)
  const apiKey = req.headers.get("X-Api-Key") || "";
  if (!apiKey) return json({ ok:false, error:"missing X-Api-Key" }, 401);
  const hash = await sha256Base64Url(apiKey);
  const rl = await enforceRate(env, `rk:webhook:${hash}`, 60, 60);
  if (!rl.allowed) return ratelimitedJson(rl);
  const apiMetaRaw = await env.TOKENS_KV.get(`api:${hash}`);
  if (!apiMetaRaw) return json({ ok:false, error:"unauthorised" }, 401);
  const apiMeta = tryParse(apiMetaRaw) || {};
  if (apiMeta.status !== "active" || !apiMeta.open_id) {
    return json({ ok:false, error:"api key not activated (connect TikTok first)" }, 401);
  }
  const openId: string = apiMeta.open_id;

  // 2) Parse body (accept id OR url/r2Url; caption + idempotencyKey optional)
  const body = await req.json().catch(() => ({}));
  const { id, r2Url, url, caption, idempotencyKey, mode } = body;
  const cleanCaption = (caption ?? "").replace(/\u0000/g, ""); // strip NULs
  const publishMode = (mode ?? "publish").toLowerCase();

  

  if (!id && !r2Url && !url) {
    return json({ ok: false, error: "Provide 'id' or 'r2Url'/'url'" }, 400);
  }

  // 3) Idempotency (keep your existing logic)
  if (idempotencyKey) {
    const existed = await env.TOKENS_KV.get(`idem:${openId}:${idempotencyKey}`);
    if (existed) return json(JSON.parse(existed));
  }

  try {
    // 4) Resolve to a 7-day URL on your custom domain (or pass-through if already custom)
    // build the signed URL up front
    const signer = makeSigner({
      R2_ACCESS_KEY_ID: env.R2_ACCESS_KEY_ID,
      R2_SECRET_ACCESS_KEY: env.R2_SECRET_ACCESS_KEY,
      R2_BUCKET: env.R2_BUCKET,
      CUSTOM_MEDIA_HOST: env.CUSTOM_MEDIA_HOST
    });

    const videoUrl = await signer.resolveAndSign({ id, url: r2Url ?? url });

    // 5) TikTok call (build post_info from mode)
    const access = await getAccessTokenFor(env, `tok:open:${openId}`);

    const post_info: Record<string, any> = {
      title: cleanCaption,
      privacy_level: "SELF_ONLY",
      disable_duet: false,
      disable_stitch: false,
      disable_comment: false,
      brand_content_toggle: false,
      brand_organic_toggle: false,
      ...(publishMode === "draft" ? { is_draft: true } : {})
    };
    const source_info = { source: "PULL_FROM_URL", video_url: videoUrl };

    if (opts.dry) {
      // Don’t call TikTok—just show what we’d send
      return json({
        ok: true,
        dryRun: true,
        request: { post_info, source_info }
      });
    }

    const initResp = await fetch(env.POST_INIT_URL, {
      method: "POST",
      headers: {
        authorization: `Bearer ${access}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        post_info,
        source_info: { source: "PULL_FROM_URL", video_url: videoUrl },
      }),
    });

    const bodyText = await safeText(initResp);
    const payload = tryParse(bodyText);

    let result: any;
    if (initResp.ok) {
      result = {
        ok: true,
        status: publishMode === "draft" ? "draft_accepted" : "accepted",
        tiktok: payload ?? { raw: bodyText },
      };
    } else {
      const err = payload?.error ?? payload ?? { message: bodyText };
      result = {
        ok: false,
        status: "failed",
        error: {
          code: err.code ?? "unknown_error",
          message: err.message ?? String(bodyText),
          log_id: payload?.log_id,
        },
      };
    }

    if (idempotencyKey) {
      await env.TOKENS_KV.put(
        `idem:${openId}:${idempotencyKey}`,
        JSON.stringify(result),
        { expirationTtl: 86400 }
      );
    }
    return json(result, initResp.ok ? 200 : 400);

  } catch (err: any) {
    const result = { ok: false, error: String(err) };
    if (idempotencyKey) {
      await env.TOKENS_KV.put(
        `idem:${openId}:${idempotencyKey}`,
        JSON.stringify(result),
        { expirationTtl: 86400 }
      );
    }
    return json(result, 500);
  }
}

async function getAccessTokenFor(env: Env, kvKey: string): Promise<string> {
  const raw = await env.TOKENS_KV.get(kvKey);
  if (!raw) throw new Error("Not authorised for this account. Connect TikTok first.");
  let tok = JSON.parse(raw);
  const issuedAt = tok.obtained_at ?? Date.now();
  const expiresIn = tok.expires_in ?? 3600;
  const expiresAt = issuedAt + (expiresIn - 120) * 1000; // refresh 2 min early
  if (Date.now() < expiresAt && tok.access_token) return tok.access_token;

  const body = new URLSearchParams({
    client_key: env.TIKTOK_CLIENT_KEY,
    client_secret: env.TIKTOK_CLIENT_SECRET,
    grant_type: "refresh_token",
    refresh_token: tok.refresh_token
  });
  const r = await fetch(env.TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body
  });
  if (!r.ok) throw new Error(`Refresh failed: ${await safeText(r)}`);
  const data = await r.json();
  tok = { ...tok, ...data, obtained_at: Date.now() };
  await env.TOKENS_KV.put(kvKey, JSON.stringify(tok));
  return tok.access_token;
}

function tryParse(s: string) {
  try { return JSON.parse(s); } catch { return null; }
}
async function safeText(r: Response) {
  try { return await r.text(); } catch { return ""; }
}

// ---- Rate limit helper (KV-based, fixed window) ----
async function enforceRate(
  env: Env,
  key: string,       // e.g. "rk:newkey:IP"
  limit: number,     // max requests per window
  windowSec: number  // window size in seconds (e.g. 3600 = 1h)
): Promise<{ allowed: boolean; remaining: number; resetAt: number }> {
  const now = Math.floor(Date.now() / 1000);
  const windowKey = `${key}:${Math.floor(now / windowSec)}`; // e.g. rk:newkey:1.2.3.4:451234
  const raw = await env.TOKENS_KV.get(windowKey);
  const count = raw ? parseInt(raw, 10) : 0;

  if (count >= limit) {
    const resetAt = (Math.floor(now / windowSec) + 1) * windowSec;
    return { allowed: false, remaining: 0, resetAt };
  }

  // Increment (best-effort; KV is eventually consistent, but good enough here)
  await env.TOKENS_KV.put(windowKey, String(count + 1), { expirationTtl: windowSec });
  const resetAt = (Math.floor(now / windowSec) + 1) * windowSec;
  return { allowed: true, remaining: Math.max(0, limit - (count + 1)), resetAt };
}

// Helper to extract client IP (works on Workers)
function getClientIp(req: Request) {
  return req.headers.get("CF-Connecting-IP") || "0.0.0.0";
}

function ratelimitedJson(limitInfo: { remaining: number; resetAt: number }) {
  const retryAfter = Math.max(0, limitInfo.resetAt - Math.floor(Date.now() / 1000));
  return new Response(JSON.stringify({
    ok: false,
    error: "rate_limited",
    message: "Too many requests. Please try again later."
  }, null, 2), {
    status: 429,
    headers: {
      "content-type": "application/json",
      "retry-after": String(retryAfter),
      "x-rate-remaining": String(limitInfo.remaining),
      "x-rate-reset": String(limitInfo.resetAt)
    }
  });
}