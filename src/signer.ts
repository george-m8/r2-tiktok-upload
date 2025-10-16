import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

export function makeSigner(env: {
  R2_ACCESS_KEY_ID: string;
  R2_SECRET_ACCESS_KEY: string;
  R2_BUCKET: string;
  CUSTOM_MEDIA_HOST: string;   // e.g. r2media.example.com (bucket-bound to this bucket)
}) {
  // Sanitize CUSTOM_MEDIA_HOST: strip scheme and trailing slash
  const host = env.CUSTOM_MEDIA_HOST
    .replace(/^https?:\/\//i, "")
    .replace(/\/+$/, "")
    .trim();

  // Use a plain string endpoint; some SDK builds are picky about EndpointV2.protocol
  const endpoint = `https://${host}`;

  const client = new S3Client({
    region: "auto",
    endpoint,              // plain string endpoint
    bucketEndpoint: true,  // host is already bucket-bound
    forcePathStyle: false, // do NOT prefix /Bucket
    tls: true,
    credentials: {
      accessKeyId: env.R2_ACCESS_KEY_ID,
      secretAccessKey: env.R2_SECRET_ACCESS_KEY,
    },
  });

  function describe() {
    return {
      endpoint,
      bucket: env.R2_BUCKET,
      host,
      bucketEndpoint: true,
      forcePathStyle: false,
    };
  }

  function extractKeyFromUrl(rawUrl: string) {
    const u = new URL(rawUrl);
    let path = decodeURIComponent(u.pathname.replace(/^\/+/, ""));
    const bucketPrefix = env.R2_BUCKET + "/";
    if (path.startsWith(bucketPrefix)) path = path.slice(bucketPrefix.length);
    return path;
  }

  async function signKey(key: string) {
    // Bucket is still provided to the command shape, but with bucketEndpoint:true
    // the host stays as CUSTOM_MEDIA_HOST and the path is just /<key>
    const cmd = new GetObjectCommand({ Bucket: env.R2_BUCKET, Key: key });
    return await getSignedUrl(client, cmd, { expiresIn: 60 * 60 * 24 * 7 });
  }

  async function resolveAndSign(input: { id?: string; url?: string }) {
    let key: string | undefined;
    if (input?.id) key = `${input.id}.mp4`;       // your naming convention
    else if (input?.url) key = extractKeyFromUrl(input.url);
    if (!key) throw new Error("Provide either 'id' or 'url'");
    return signKey(key);
  }

  return { resolveAndSign, extractKeyFromUrl, describe };
}