import "./shims";
import { makeSigner } from "./signer";

export interface Env {
  TOKENS_KV: KVNamespace;
  TIKTOK_CLIENT_KEY: string;
  TIKTOK_CLIENT_SECRET: string;
  OAUTH_REDIRECT_URL: string;
  SCOPES: string;
  AUTHORIZE_URL: string;
  TOKEN_URL: string;
  POST_INIT_URL: string;
  POST_API_KEY?: string; // shared secret for webhook/post
  R2_ACCESS_KEY_ID: string;
  R2_SECRET_ACCESS_KEY: string;
  R2_BUCKET: string;
  CUSTOM_MEDIA_HOST: string;
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);

    if (url.pathname === "/login") return login(url, env);
    if (url.pathname === "/callback") return callback(url, env);
    if (url.pathname === "/webhook" && req.method === "POST") return webhook(req, env);
    if (url.pathname === "/post" && req.method === "POST") return webhook(req, env);

    // 👇 Add this block here
    if (url.pathname === "/debug-auth") {
      return new Response(JSON.stringify({
        redirect_uri: env.OAUTH_REDIRECT_URL,
        authorize_url: env.AUTHORIZE_URL,
      }, null, 2), {
        headers: { "content-type": "application/json" }
      });
    }

    return new Response("ok");
  }
};

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { "content-type": "application/json" }
  });
}

async function login(_url: URL, env: Env) {
  const state = crypto.randomUUID();
  await env.TOKENS_KV.put(`state:${state}`, "1", { expirationTtl: 300 });

  const auth = new URL(env.AUTHORIZE_URL);
  auth.searchParams.set("client_key", env.TIKTOK_CLIENT_KEY);
  auth.searchParams.set("response_type", "code");
  auth.searchParams.set("redirect_uri", env.OAUTH_REDIRECT_URL);
  auth.searchParams.set("scope", env.SCOPES);
  auth.searchParams.set("state", state);

  return Response.redirect(auth.toString(), 302);
}

async function callback(url: URL, env: Env) {
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  if (!code || !state) return json({ error: "missing code/state" }, 400);

  const okState = await env.TOKENS_KV.get(`state:${state}`);
  if (!okState) return json({ error: "invalid state" }, 400);

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

  if (!r.ok) return json({ error: "token exchange failed", detail: await safeText(r) }, 500);
  const data = await r.json(); // includes access_token, refresh_token, open_id, expires_in
  await env.TOKENS_KV.put("tiktok_tokens", JSON.stringify({ ...data, obtained_at: Date.now() }));
  return new Response("Authorised. You can close this tab.");
}

async function webhook(req: Request, env: Env) {
  // 1) Simple auth (as you had)
  if (env.POST_API_KEY && req.headers.get("X-Api-Key") !== env.POST_API_KEY) {
    return json({ ok: false, error: "unauthorised" }, 401);
  }

  // 2) Parse body (accept id OR url/r2Url; caption + idempotencyKey optional)
  const body = await req.json().catch(() => ({}));
  const { id, r2Url, url, caption, idempotencyKey } = body;

  if (!id && !r2Url && !url) {
    return json({ ok: false, error: "Provide 'id' or 'r2Url'/'url'" }, 400);
  }

  // 3) Idempotency (keep your existing logic)
  if (idempotencyKey) {
    const existed = await env.TOKENS_KV.get(`idem:${idempotencyKey}`);
    if (existed) return json(JSON.parse(existed));
  }

  try {
    // 4) Resolve to a 7-day URL on your custom domain (or pass-through if already custom)
    const signer = makeSigner({
      R2_ACCESS_KEY_ID: env.R2_ACCESS_KEY_ID,
      R2_SECRET_ACCESS_KEY: env.R2_SECRET_ACCESS_KEY,
      R2_BUCKET: env.R2_BUCKET,
      CUSTOM_MEDIA_HOST: env.CUSTOM_MEDIA_HOST
    });

    const videoUrl = await signer.resolveAndSign({
      id,
      url: r2Url ?? url
    });

    // 5) TikTok call (unchanged except we use videoUrl from above)
    const access = await getAccessToken(env);
    const initResp = await fetch(env.POST_INIT_URL, {
      method: "POST",
      headers: {
        "authorization": `Bearer ${access}`,
        "content-type": "application/json"
      },
      body: JSON.stringify({
        post_info: { title: caption ?? "" },
        source_info: { source: "PULL_FROM_URL", video_url: videoUrl }
      })
    });

    const bodyText = await safeText(initResp);
    const payload = tryParse(bodyText);
    const success = initResp.ok;

    const result = {
      ok: success,
      status: success ? "accepted" : "failed",
      tiktok: payload || bodyText
    };

    if (idempotencyKey) {
      await env.TOKENS_KV.put(`idem:${idempotencyKey}`, JSON.stringify(result), { expirationTtl: 86400 });
    }
    return json(result, success ? 200 : 400);
  } catch (err: any) {
    const result = { ok: false, error: String(err) };
    if (idempotencyKey) {
      await env.TOKENS_KV.put(`idem:${idempotencyKey}`, JSON.stringify(result), { expirationTtl: 86400 });
    }
    return json(result, 500);
  }
}

async function getAccessToken(env: Env): Promise<string> {
  const raw = await env.TOKENS_KV.get("tiktok_tokens");
  if (!raw) throw new Error("Not authorised. Visit /login first.");
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
  tok = { ...data, obtained_at: Date.now() };
  await env.TOKENS_KV.put("tiktok_tokens", JSON.stringify(tok));
  return tok.access_token;
}

function tryParse(s: string) {
  try { return JSON.parse(s); } catch { return null; }
}
async function safeText(r: Response) {
  try { return await r.text(); } catch { return ""; }
}