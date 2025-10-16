import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

export function makeSigner(env: {
  R2_ACCESS_KEY_ID: string;
  R2_SECRET_ACCESS_KEY: string;
  R2_BUCKET: string;
  CUSTOM_MEDIA_HOST: string;
}) {
  const client = new S3Client({
    region: "auto",
    endpoint: `https://${env.CUSTOM_MEDIA_HOST}`, // sign on your custom domain
    forcePathStyle: true,
    credentials: {
      accessKeyId: env.R2_ACCESS_KEY_ID,
      secretAccessKey: env.R2_SECRET_ACCESS_KEY,
    },
  });

  async function signKey(key: string) {
    const cmd = new GetObjectCommand({ Bucket: env.R2_BUCKET, Key: key });
    // 7 days = 604800 seconds (SigV4 max)
    return await getSignedUrl(client, cmd, { expiresIn: 60 * 60 * 24 * 7 });
  }

  function extractKeyFromUrl(rawUrl: string) {
    const u = new URL(rawUrl);
    let path = decodeURIComponent(u.pathname.replace(/^\/+/, ""));

    // Remove the bucket segment if it's there (works for both .r2.cloudflarestorage.com and custom domains)
    const bucketPrefix = env.R2_BUCKET + "/";
    if (path.startsWith(bucketPrefix)) {
        path = path.slice(bucketPrefix.length);
    }

    return path;
  }

  /** Accepts an ID (uses `${id}.mp4`) or any R2 URL (old or custom host). */
  async function resolveAndSign(input: { id?: string; url?: string }) {
    let key: string | undefined;

    if (input.id) key = `${input.id}.mp4`;
    else if (input.url) key = extractKeyFromUrl(input.url);

    if (!key) throw new Error("Provide either 'id' or 'url'");

    return await signKey(key);
  }

  return { resolveAndSign, extractKeyFromUrl };
}