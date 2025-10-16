import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

export function makeSigner(env: {
  R2_ACCESS_KEY_ID: string;
  R2_SECRET_ACCESS_KEY: string;
  R2_BUCKET: string;
  CUSTOM_MEDIA_HOST: string;   // e.g. r2media.example.com (bucket-bound to this bucket)
}) {
  // Normalize CUSTOM_MEDIA_HOST to a bare host (no scheme, no trailing slash)
  const host = (env.CUSTOM_MEDIA_HOST || "")
    .replace(/^https?:\/\//i, "")
    .replace(/\/+$/, "")
    .trim();

  if (!host) {
    throw new Error("CUSTOM_MEDIA_HOST is empty after normalization");
  }

  // Because your custom domain is already bucket-bound, requests should be:
  //   https://<custom-domain>/<key>
  const endpoint = `https://${host}`;

  const client = new S3Client({
    region: "auto",
    endpoint,              // string endpoint (safer than EndpointV2 here)
    forcePathStyle: false, // path is just /<key>; no /<bucket>/ prefix
    credentials: {
      accessKeyId: env.R2_ACCESS_KEY_ID,
      secretAccessKey: env.R2_SECRET_ACCESS_KEY,
    },
  });

  function describe() {
    return {
      endpoint,
      host,
      bucket: env.R2_BUCKET,
      forcePathStyle: false,
    };
  }

  /**
   * If someone provides an old-style R2 URL (r2.cloudflarestorage.com/<bucket>/<key>)
   * or even your custom domain with an accidental "/<bucket>/..." prefix,
   * strip the bucket segment so we end up with just "<key>".
   */
  function extractKeyFromUrl(rawUrl: string) {
    const u = new URL(rawUrl);
    let path = decodeURIComponent(u.pathname.replace(/^\/+/, ""));
    const bucketPrefix = env.R2_BUCKET + "/";
    if (path.startsWith(bucketPrefix)) path = path.slice(bucketPrefix.length);
    return path;
  }

  async function signKey(key: string) {
    // Even though the endpoint is bucket-bound, the command still includes Bucket/Key
    const cmd = new GetObjectCommand({ Bucket: env.R2_BUCKET, Key: key });
    // 7 days (SigV4 max)
    return await getSignedUrl(client, cmd, { expiresIn: 60 * 60 * 24 * 7 });
  }

  /** Accepts an ID (uses `${id}.mp4`) or any R2 URL (old or custom host). */
  async function resolveAndSign(input: { id?: string; url?: string }) {
    let key: string | undefined;
    if (input?.id) key = `${input.id}.mp4`;
    else if (input?.url) key = extractKeyFromUrl(input.url);
    if (!key) throw new Error("Provide either 'id' or 'url'");
    return signKey(key);
  }

  return { resolveAndSign, extractKeyFromUrl, describe };
}