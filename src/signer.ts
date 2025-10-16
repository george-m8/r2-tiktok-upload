import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

export function makeSigner(env: {
  R2_ACCESS_KEY_ID: string;
  R2_SECRET_ACCESS_KEY: string;
  R2_BUCKET: string;
  CUSTOM_MEDIA_HOST: string;   // e.g. r2media.example.com (bucket-bound)
}) {
  // Normalize the host and build a real URL for the endpoint
  const host = (env.CUSTOM_MEDIA_HOST || "")
    .trim()
    .replace(/^https?:\/\//i, "")
    .replace(/\/+$/g, "");
  if (!host) throw new Error("CUSTOM_MEDIA_HOST is empty");

  // IMPORTANT: pass a string; bad strings trigger “Invalid URL string.”
  const endpoint = `https://${host}`;

  const client = new S3Client({
    region: "auto",
    endpoint,              // string endpoint
    bucketEndpoint: true,  // custom host is bucket-bound
    forcePathStyle: false, // no /<bucket> prefix in the path
    credentials: {
      accessKeyId: env.R2_ACCESS_KEY_ID,
      secretAccessKey: env.R2_SECRET_ACCESS_KEY,
    },
  });

  function describe() {
    return {
      endpoint: endpoint.toString(),
      bucket: env.R2_BUCKET,
      host,
      flags: { bucketEndpoint: true, forcePathStyle: false },
    };
  }

  async function signKey(key: string) {
    // Result: https://<custom-domain>/<key>?X-Amz-...
    const cmd = new GetObjectCommand({ Bucket: env.R2_BUCKET, Key: key });
    return await getSignedUrl(client, cmd, { expiresIn: 60 * 60 * 24 * 7 }); // 7 days
  }

  function extractKeyFromUrl(rawUrl: string) {
    const u = new URL(rawUrl);
    let path = decodeURIComponent(u.pathname.replace(/^\/+/, ""));
    // Strip leading bucket/ if someone pasted an R2 endpoint URL
    const bucketPrefix = env.R2_BUCKET + "/";
    if (path.startsWith(bucketPrefix)) path = path.slice(bucketPrefix.length);
    return path;
  }

  async function resolveAndSign(input: { id?: string; url?: string }) {
    let key: string | undefined;
    if (input?.id) key = `${input.id}.mp4`;        // your convention
    else if (input?.url) key = extractKeyFromUrl(input.url);
    if (!key) throw new Error("Provide either 'id' or 'url'");
    return signKey(key);
  }

  return { resolveAndSign, extractKeyFromUrl, describe };
}