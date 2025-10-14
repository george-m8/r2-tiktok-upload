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
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname === "/login") return login(url, env);
    if (url.pathname === "/callback") return callback(url, env);
    if (url.pathname === "/webhook" && req.method === "POST") return webhook(req, env);
    if (url.pathname === "/post" && req.method === "POST") return webhook(req, env);
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
  if (env.POST_API_KEY && req.headers.get("X-Api-Key") !== env.POST_API_KEY) {
    return json({ ok: false, error: "unauthorised" }, 401);
  }

  const { videoUrl, caption, idempotencyKey } = await req.json().catch(() => ({}));
  if (!videoUrl) return json({ ok: false, error: "videoUrl required" }, 400);

  // Idempotency to handle Zapier retries
  if (idempotencyKey) {
    const existed = await env.TOKENS_KV.get(`idem:${idempotencyKey}`);
    if (existed) return json(JSON.parse(existed));
  }

  try {
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