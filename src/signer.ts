import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

export function makeSigner(env: {
  R2_ACCESS_KEY_ID: string;
  R2_SECRET_ACCESS_KEY: string;
  R2_BUCKET: string;
  CUSTOM_MEDIA_HOST: string;
}) {
  // Normalize host → absolute URL once
  const endpoint = env.CUSTOM_MEDIA_HOST.startsWith("http")
    ? env.CUSTOM_MEDIA_HOST
    : `https://${env.CUSTOM_MEDIA_HOST}`;

  const client = new S3Client({
    region: "auto",
    endpoint,
    credentials: {
      accessKeyId: env.R2_ACCESS_KEY_ID,
      secretAccessKey: env.R2_SECRET_ACCESS_KEY,
    },
    // Custom domain is already mapped to a single bucket
    bucketEndpoint: true,
    forcePathStyle: false,
  });

  async function signKey(key: string) {
    const cmd = new GetObjectCommand({ Bucket: env.R2_BUCKET, Key: key });
    return getSignedUrl(client, cmd, { expiresIn: 60 * 60 * 24 * 7 });
  }

  function extractKeyFromUrl(rawUrl: string) {
    const u = new URL(rawUrl);
    let path = decodeURIComponent(u.pathname.replace(/^\/+/, ""));
    const bucketPrefix = env.R2_BUCKET + "/";
    if (path.startsWith(bucketPrefix)) path = path.slice(bucketPrefix.length);
    return path;
  }

  async function resolveAndSign(input: { id?: string; url?: string }) {
    let key: string | undefined;
    if (input.id) key = `${input.id}.mp4`;
    else if (input.url) key = extractKeyFromUrl(input.url);
    if (!key) throw new Error("Provide either 'id' or 'url'");
    return signKey(key);
  }

  return { resolveAndSign, extractKeyFromUrl };
}