import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

/**
 * Signs URLs that always resolve to your custom domain bound to the bucket,
 * e.g. https://r2media.example.com/<key>
 */
export function makeSigner(env: {
  R2_ACCESS_KEY_ID: string;
  R2_SECRET_ACCESS_KEY: string;
  R2_BUCKET: string;
  CUSTOM_MEDIA_HOST: string;   // e.g. r2media.example.com (bucket-bound)
}) {
  // Ensure scheme on endpoint
  const endpointUrl = env.CUSTOM_MEDIA_HOST.startsWith("http")
    ? env.CUSTOM_MEDIA_HOST
    : `https://${env.CUSTOM_MEDIA_HOST}`;

  const client = new S3Client({
    region: "auto",
    endpoint: endpointUrl,   // points directly at the bucket via custom domain
    bucketEndpoint: true,    // treat endpoint as bucket-bound (no bucket in path)
    forcePathStyle: false,   // don't add /<bucket> in the URL path
    credentials: {
      accessKeyId: env.R2_ACCESS_KEY_ID,
      secretAccessKey: env.R2_SECRET_ACCESS_KEY,
    },
  });

  function normalizeKeyFromPath(pathname: string) {
    // decode & drop any leading slash
    let path = decodeURIComponent(pathname.replace(/^\/+/, ""));
    // If someone pasted a URL that includes the bucket segment, strip it.
    const bucketPrefix = env.R2_BUCKET + "/";
    if (path.startsWith(bucketPrefix)) path = path.slice(bucketPrefix.length);
    return path;
  }

  async function signKey(key: string) {
    // Final: https://<custom-domain>/<key>?X-Amz-...
    const cmd = new GetObjectCommand({ Bucket: env.R2_BUCKET, Key: key });
    return await getSignedUrl(client, cmd, { expiresIn: 60 * 60 * 24 * 7 });
  }

  function extractKeyFromUrl(rawUrl: string) {
    const u = new URL(rawUrl);
    return normalizeKeyFromPath(u.pathname);
  }

  async function resolveAndSign(input: { id?: string; url?: string }) {
    let key: string | undefined;
    if (input?.id) key = `${input.id}.mp4`;      // your convention: id -> id.mp4 at bucket root
    else if (input?.url) key = extractKeyFromUrl(input.url);

    if (!key) throw new Error("Provide either 'id' or 'url'");
    return signKey(key);
  }

  // small helper for /debug-signer
  function describe() {
    return {
      endpoint: endpointUrl,
      host: new URL(endpointUrl).host,
      bucketEndpoint: true,
      forcePathStyle: false,
      bucket: env.R2_BUCKET,
    };
  }

  return { resolveAndSign, extractKeyFromUrl, describe };
}