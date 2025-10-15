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

function html(markup: string, status = 200) {
  return new Response(markup, {
    status,
    headers: { "content-type": "text/html; charset=UTF-8" }
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
  if (!code || !state) {
    return renderCallbackPage({
      ok: false,
      title: "Missing info",
      message: "We couldn’t complete sign-in (code/state missing).",
      details: "Please try again from the Connect TikTok button."
    }, 400);
  }

  const okState = await env.TOKENS_KV.get(`state:${state}`);
  if (!okState) {
    return renderCallbackPage({
      ok: false,
      title: "Session expired",
      message: "Your sign-in session expired or is invalid.",
      details: "Please try again from the Connect TikTok button."
    }, 400);
  }

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
    return renderCallbackPage({
      ok: false,
      title: "Couldn’t connect to TikTok",
      message: "The token exchange failed.",
      details: detail || "Please try again in a moment."
    }, 500);
  }

  const data = await r.json(); // access_token, refresh_token, open_id, expires_in
  await env.TOKENS_KV.put("tiktok_tokens", JSON.stringify({ ...data, obtained_at: Date.now() }));

  return renderCallbackPage({
    ok: true,
    title: "Connected to TikTok",
    message: "You can close this window now.",
    details: ""
  });
}

function renderCallbackPage(
  opts: { ok: boolean; title: string; message: string; details?: string },
  status = 200
) {
  const ok = opts.ok ? "true" : "false";
  const markup = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0"/>
<title>${opts.ok ? "Connected" : "Error"} • R2 TikTok Upload</title>
<script src="https://cdn.tailwindcss.com"></script>
<script>
  tailwind.config = {
    theme: {
      extend: {
        colors: { offwhite: '#fdf7ed', brandred: '#e6372e' },
        boxShadow: { soft: '0 10px 30px rgba(0,0,0,0.06)' },
        fontFamily: { sans: ['Inter','system-ui','-apple-system','Segoe UI','Roboto','Helvetica','Arial','sans-serif'] }
      }
    }
  }
</script>
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
    ${opts.details ? `<pre class="mt-4 text-left whitespace-pre-wrap break-words rounded bg-black/5 p-3 text-sm text-black/70">${escapeHtml(opts.details)}</pre>` : ''}

    <div class="mt-6 flex flex-col items-center gap-2">
      <button id="closeBtn" class="rounded-lg bg-brandred px-4 py-2 text-white hover:opacity-90 transition">Close</button>
      <p class="text-xs text-black/50">This window will close automatically.</p>
    </div>
  </div>

  <script>
    // Notify opener (if any) and auto-close
    try { window.opener && window.opener.postMessage({ type: "tiktok-auth", ok: ${ok} }, "*"); } catch(e) {}
    document.getElementById('closeBtn').addEventListener('click', () => window.close());
    setTimeout(() => { try { window.close(); } catch(e) {} }, 2500);
  </script>
</body>
</html>`;
  return html(markup, status);
}

// tiny HTML escaper for details block
function escapeHtml(s = "") {
  return s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

async function webhook(req: Request, env: Env) {
  // 1) Simple auth (as you had)
  if (env.POST_API_KEY && req.headers.get("X-Api-Key") !== env.POST_API_KEY) {
    return json({ ok: false, error: "unauthorised" }, 401);
  }

  // 2) Parse body (accept id OR url/r2Url; caption + idempotencyKey optional)
  const body = await req.json().catch(() => ({}));
  const { id, r2Url, url, caption, idempotencyKey, mode } = body;
  const publishMode = (mode ?? "publish").toLowerCase(); // "publish" | "draft"

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

    // 5) TikTok call (build post_info from mode)
    const access = await getAccessToken(env);

    // Force private in unaudited/sandbox; allow a draft toggle
    const post_info: Record<string, any> = {
      title: caption ?? "",
      privacy_level: "SELF_ONLY", // required for unaudited clients
    };
    if (publishMode === "draft") {
      post_info.is_draft = true; // harmless if the tenant ignores it
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
      await env.TOKENS_KV.put(`idem:${idempotencyKey}`, JSON.stringify(result), {
        expirationTtl: 86400,
      });
    }
    return json(result, initResp.ok ? 200 : 400);
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