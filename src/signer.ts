// src/signer.ts
//
// Presigns GET URLs for a bucket-bound custom R2 domain using SigV4.
// Works in Cloudflare Workers (WebCrypto). No AWS SDK needed.

type EnvBits = {
  R2_ACCESS_KEY_ID: string;
  R2_SECRET_ACCESS_KEY: string;
  R2_BUCKET: string;          // bucket name (only used to strip legacy /bucket/ from URLs)
  CUSTOM_MEDIA_HOST: string;  // e.g. "r2media.example.com" OR "https://r2media.example.com"
};

export function makeSigner(env: EnvBits) {
  // Normalize to a full origin like "https://r2media.example.com"
  const origin = normalizeOrigin(env.CUSTOM_MEDIA_HOST);

  function normalizeOrigin(hostOrUrl: string): string {
    const hasScheme = /^(https?:)?\/\//i.test(hostOrUrl);
    const u = new URL(hasScheme ? hostOrUrl : `https://${hostOrUrl}`);
    // Important: just scheme + host (no trailing slash, no path)
    return `${u.protocol}//${u.host}`;
  }

  // Encode each path segment but preserve slashes
  function encodePathPreservingSlashes(p: string) {
    return p.split("/").map(encodeURIComponent).join("/");
  }

  // AWS date formats
  function toAmzDate(d = new Date()) {
    const YYYY = d.getUTCFullYear();
    const MM = String(d.getUTCMonth() + 1).padStart(2, "0");
    const DD = String(d.getUTCDate()).padStart(2, "0");
    const hh = String(d.getUTCHours()).padStart(2, "0");
    const mm = String(d.getUTCMinutes()).padStart(2, "0");
    const ss = String(d.getUTCSeconds()).padStart(2, "0");
    return {
      date: `${YYYY}${MM}${DD}`,
      datetime: `${YYYY}${MM}${DD}T${hh}${mm}${ss}Z`,
    };
  }

  // ---------- crypto helpers (typed to avoid linting issues) ----------
  type BytesLike = string | ArrayBuffer | ArrayBufferView;
  const _enc = new TextEncoder();

  function toU8(x: BytesLike): Uint8Array {
    if (typeof x === "string") return _enc.encode(x);
    if (ArrayBuffer.isView(x)) {
      return new Uint8Array(x.buffer, x.byteOffset, x.byteLength);
    }
    return new Uint8Array(x); // ArrayBuffer
  }

  async function hmac(key: BytesLike, data: BytesLike): Promise<Uint8Array> {
    const cryptoKey = await crypto.subtle.importKey(
      "raw",
      toU8(key), // BufferSource
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"]
    );
    const sig = await crypto.subtle.sign("HMAC", cryptoKey, toU8(data));
    return new Uint8Array(sig);
  }

  async function sha256Hex(s: string) {
    const buf = await crypto.subtle.digest("SHA-256", _enc.encode(s));
    return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
  }

  function hex(u8: Uint8Array) {
    return [...u8].map((b) => b.toString(16).padStart(2, "0")).join("");
  }

  // ---------- core presign ----------
  async function presignGet({ key, expires = 60 * 60 * 24 * 7 }: { key: string; expires?: number }) {
    if (!key) throw new Error("key is required");
    if (expires > 604800) throw new Error("expires must be <= 604800 (7 days)");

    const { date, datetime } = toAmzDate(new Date());
    const service = "s3";
    const region = "auto"; // Cloudflare R2 region magic
    const credentialScope = `${date}/${region}/${service}/aws4_request`;
    const credential = `${env.R2_ACCESS_KEY_ID}/${credentialScope}`;

    // Only "host" is signed
    const host = new URL(origin).host;
    const signedHeaders = "host";

    // Canonical request
    const method = "GET";
    const canonicalUri = "/" + encodePathPreservingSlashes(key);

    // IMPORTANT: Values here are *raw*. We URL-encode when building the canonical query.
    const baseQuery: Record<string, string> = {
      "X-Amz-Algorithm": "AWS4-HMAC-SHA256",
      "X-Amz-Credential": credential,
      "X-Amz-Date": datetime,
      "X-Amz-Expires": String(expires),
      "X-Amz-SignedHeaders": signedHeaders,
      // Optional helper (harmless extra query param)
      "x-id": "GetObject",
    };

    // Canonical query string: keys alpha-sorted, each k/v URL-encoded.
    const sortedKeys = Object.keys(baseQuery).sort();
    const canonicalQuery = sortedKeys
      .map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(baseQuery[k])}`)
      .join("&");

    const canonicalHeaders = `host:${host}\n`;
    const payloadHash = "UNSIGNED-PAYLOAD";

    const canonicalRequest = [
      method,
      canonicalUri,
      canonicalQuery,
      canonicalHeaders,
      signedHeaders,
      payloadHash,
    ].join("\n");

    const stringToSign = [
      "AWS4-HMAC-SHA256",
      datetime,
      credentialScope,
      await sha256Hex(canonicalRequest),
    ].join("\n");

    // Derive signing key
    const kDate = await hmac("AWS4" + env.R2_SECRET_ACCESS_KEY, date);
    const kRegion = await hmac(kDate, region);
    const kService = await hmac(kRegion, service);
    const kSigning = await hmac(kService, "aws4_request");
    const signature = hex(await hmac(kSigning, stringToSign));

    // Final URL
    return `${origin}${canonicalUri}?${canonicalQuery}&X-Amz-Signature=${signature}`;
  }

  // Accepts either an ID (we append ".mp4") or a raw R2 URL (legacy or custom host)
  async function resolveAndSign(input: { id?: string; url?: string }) {
    let key: string | undefined;

    if (input.id) {
      key = `${input.id}.mp4`; // your convention
    } else if (input.url) {
      key = extractKeyFromUrl(input.url);
    }

    if (!key) throw new Error("Provide either 'id' or 'url'");
    return presignGet({ key });
  }

  // Convert any R2 object URL → just the object key (strip a leading "<bucket>/")
  function extractKeyFromUrl(rawUrl: string) {
    const u = new URL(rawUrl);
    let path = decodeURIComponent(u.pathname.replace(/^\/+/, "")); // rm leading slash(es)

    // If the pasted URL had "/<bucket>/key", drop the bucket segment
    const bucketPrefix = env.R2_BUCKET + "/";
    if (path.startsWith(bucketPrefix)) path = path.slice(bucketPrefix.length);

    return path;
  }

  return { resolveAndSign, extractKeyFromUrl };
}