import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

export function makeSigner(env: {
  R2_ACCESS_KEY_ID: string;
  R2_SECRET_ACCESS_KEY: string;
  R2_BUCKET: string;
  CUSTOM_MEDIA_HOST: string; // e.g. r2media.example.com  (NO protocol, NO path)
}) {
  // --- Normalize host -> endpoint ------------------------------------------
  // Accept users putting http(s) in by mistake; strip it and any trailing slash.
  const rawHost = (env.CUSTOM_MEDIA_HOST || "").trim();
  const host = rawHost.replace(/^https?:\/\//i, "").replace(/\/+$/, "");
  const endpoint = `https://${host}`;

  // Validate early so we get a clear error if host is malformed.
  try {
    // Throws if invalid
    new URL(endpoint);
  } catch (e: any) {
    throw new Error(
      `Bad CUSTOM_MEDIA_HOST. Built endpoint="${endpoint}" from "${rawHost}". ${e?.message || e}`
    );
  }

  // R2 custom domain must be BUCKET-BOUND. Using bucketEndpoint=true means the
  // client will not prepend "/<bucket>" to the path.
  const client = new S3Client({
    region: "auto",
    endpoint,                 // plain string URL is safest in Workers
    bucketEndpoint: true,     // key path is "/<key>", not "/<bucket>/<key>"
    forcePathStyle: false,    // make sure we don't reintroduce "/<bucket>"
    credentials: {
      accessKeyId: env.R2_ACCESS_KEY_ID,
      secretAccessKey: env.R2_SECRET_ACCESS_KEY,
    },
  });

  function extractKeyFromUrl(rawUrl: string) {
    const u = new URL(rawUrl);
    // Start with decoded path (no leading slash)
    let path = decodeURIComponent(u.pathname.replace(/^\/+/, ""));

    // If someone pasted a URL that includes the bucket segment, strip it.
    const bucketPrefix = env.R2_BUCKET + "/";
    if (path.startsWith(bucketPrefix)) path = path.slice(bucketPrefix.length);

    return path;
  }

  async function signKey(key: string) {
    // For a bucket-bound custom domain, Bucket is still included for signing
    // scope but won’t appear in the URL path.
    const cmd = new GetObjectCommand({ Bucket: env.R2_BUCKET, Key: key });
    // 7 days (AWS SigV4 max)
    return await getSignedUrl(client, cmd, { expiresIn: 60 * 60 * 24 * 7 });
  }

  async function resolveAndSign(input: { id?: string; url?: string }) {
    let key: string | undefined;
    if (input.id) key = `${input.id}.mp4`;     // your convention
    else if (input.url) key = extractKeyFromUrl(input.url);

    if (!key) throw new Error("Provide either 'id' or 'url'");
    return signKey(key);
  }

  // Expose internal bits for /debug-signer
  const _debug = {
    rawHost,
    host,
    endpoint,
    sampleUrlFor: (k: string) => `https://${host}/${encodeURIComponent(k)}`,
  };

  return { resolveAndSign, extractKeyFromUrl, _debug };
}