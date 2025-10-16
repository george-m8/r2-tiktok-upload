import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

export function makeSigner(env: {
  R2_ACCESS_KEY_ID: string;
  R2_SECRET_ACCESS_KEY: string;
  R2_BUCKET: string;
  CUSTOM_MEDIA_HOST: string;   // e.g. r2media.example.com (bucket-bound)
}) {
  const client = new S3Client({
    region: "auto",
    endpoint: `https://${env.CUSTOM_MEDIA_HOST}`, // bucket-bound custom domain
    bucketEndpoint: true,                          // <-- key bit
    forcePathStyle: false,                         // <-- don't add /bucket
    credentials: {
      accessKeyId: env.R2_ACCESS_KEY_ID,
      secretAccessKey: env.R2_SECRET_ACCESS_KEY,
    },
  });

  async function signKey(key: string) {
    // URL should end up: https://<custom-domain>/<key>?X-Amz-...
    const cmd = new GetObjectCommand({ Bucket: env.R2_BUCKET, Key: key });
    return await getSignedUrl(client, cmd, { expiresIn: 60 * 60 * 24 * 7 }); // 7 days
  }

  function extractKeyFromUrl(rawUrl: string) {
    const u = new URL(rawUrl);
    // Start with /path, decoded, no leading slash
    let path = decodeURIComponent(u.pathname.replace(/^\/+/, ""));
    // If someone pasted a URL that *includes* the bucket segment, strip it
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

  return { resolveAndSign, extractKeyFromUrl };
}