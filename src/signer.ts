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
    endpoint: `https://${env.CUSTOM_MEDIA_HOST}`, // custom domain mapped to a single bucket
    credentials: {
      accessKeyId: env.R2_ACCESS_KEY_ID,
      secretAccessKey: env.R2_SECRET_ACCESS_KEY,
    },
    // Important: this endpoint ALREADY points at the bucket
    bucketEndpoint: true,   // <- don't add the bucket in path/host
    forcePathStyle: false,  // <- generate host-style for non-bucket endpoints, noop with bucketEndpoint
  });

  async function signKey(key: string) {
    const cmd = new GetObjectCommand({
      // still pass Bucket for signing context, but it won't be added to the URL
      Bucket: env.R2_BUCKET,
      Key: key,
    });
    return await getSignedUrl(client, cmd, { expiresIn: 60 * 60 * 24 * 7 });
  }

  function extractKeyFromUrl(rawUrl: string) {
    const u = new URL(rawUrl);
    let path = decodeURIComponent(u.pathname.replace(/^\/+/, ""));
    // strip leading "<bucket>/" if someone pasted an old path-style URL
    const bucketPrefix = env.R2_BUCKET + "/";
    if (path.startsWith(bucketPrefix)) path = path.slice(bucketPrefix.length);
    return path;
  }

  async function resolveAndSign(input: { id?: string; url?: string }) {
    let key: string | undefined;
    if (input.id) key = `${input.id}.mp4`;
    else if (input.url) key = extractKeyFromUrl(input.url);
    if (!key) throw new Error("Provide either 'id' or 'url'");
    return await signKey(key);
  }

  return { resolveAndSign, extractKeyFromUrl };
}