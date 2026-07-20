import {
  DeleteObjectCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

let s3Client: S3Client | null = null;

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required for Alarik/S3 storage.`);
  return value;
}

export function getObjectStorageClient(): S3Client {
  if (!s3Client) {
    s3Client = new S3Client({
      endpoint: required("S3_ENDPOINT"),
      region: process.env.S3_REGION ?? "auto",
      forcePathStyle: process.env.S3_FORCE_PATH_STYLE !== "false",
      credentials: {
        accessKeyId: required("S3_ACCESS_KEY_ID"),
        secretAccessKey: required("S3_SECRET_ACCESS_KEY"),
      },
    });
  }
  return s3Client;
}

export function storageBucket(): string {
  return required("S3_BUCKET");
}

export async function putObject(input: {
  key: string;
  body: Buffer | Uint8Array | string;
  contentType?: string;
  cacheControl?: string;
}) {
  await getObjectStorageClient().send(
    new PutObjectCommand({
      Bucket: storageBucket(),
      Key: input.key,
      Body: input.body,
      ContentType: input.contentType,
      CacheControl: input.cacheControl,
    }),
  );
}

export async function deleteObject(key: string) {
  await getObjectStorageClient().send(
    new DeleteObjectCommand({
      Bucket: storageBucket(),
      Key: key,
    }),
  );
}

export async function listObjectKeys(prefix: string): Promise<string[]> {
  const keys: string[] = [];
  let continuationToken: string | undefined;

  do {
    const response = await getObjectStorageClient().send(
      new ListObjectsV2Command({
        Bucket: storageBucket(),
        Prefix: prefix,
        ContinuationToken: continuationToken,
      }),
    );
    for (const object of response.Contents ?? []) {
      if (object.Key) keys.push(object.Key);
    }
    continuationToken = response.NextContinuationToken;
  } while (continuationToken);

  return keys;
}

export async function signedObjectUrl(key: string, expiresIn = 60 * 10) {
  return getSignedUrl(
    getObjectStorageClient(),
    new GetObjectCommand({
      Bucket: storageBucket(),
      Key: key,
    }),
    { expiresIn },
  );
}

export function publicObjectUrl(key: string): string {
  const base = process.env.S3_PUBLIC_BASE_URL;
  if (!base) {
    throw new Error("S3_PUBLIC_BASE_URL is required for public object URLs.");
  }
  return `${base.replace(/\/$/, "")}/${key.replace(/^\//, "")}`;
}
