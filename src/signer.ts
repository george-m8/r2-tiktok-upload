import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import type { EndpointV2 } from "@aws-sdk/types";

export function makeSigner(env: {
  R2_ACCESS_KEY_ID: string;
  R2_SECRET_ACCESS_KEY: string;
  R2_BUCKET: string;
  CUSTOM_MEDIA_HOST: string;   // e.g. r2media.example.com (bucket-bound to this bucket)
}) {
  // Use EndpointV2 instead of a URL string to avoid "Invalid URL string" in Workers
  const endpoint: EndpointV2 = {
    protocol: "https",
    hostname: env.CUSTOM_MEDIA_HOST, // this host is already mapped to the bucket
    path: "/",                        // IMPORTANT: no bucket segment here
    port: 443,
  };

  const client = new S3Client({
    region: "auto",
    endpoint,              // <- EndpointV2 object
    bucketEndpoint: true,  // <- tells the SDK the host is already bucket-scoped
    forcePathStyle: false, // <- do NOT prefix /Bucket
    credentials: {
      accessKeyId: env.R2_ACCESS_KEY_ID,
      secretAccessKey: env.R2_SECRET_ACCESS_KEY,
    },
  });

  function describe() {
    return {
      endpoint,
      bucket: env.R2_BUCKET,
      host: env.CUSTOM_MEDIA_HOST,
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