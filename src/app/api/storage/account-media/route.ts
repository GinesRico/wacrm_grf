import { NextResponse } from "next/server";
import { z } from "zod";
import { getCurrentDbAccount } from "@/lib/auth/current-account";
import { toErrorResponse } from "@/lib/auth/errors";
import { deleteObject, publicObjectUrl, putObject } from "@/lib/storage/alarik";
import { buildMediaPath, MEDIA_MAX_BYTES } from "@/lib/storage/upload-media";

const ALLOWED_BUCKETS = ["avatars", "chat-media", "flow-media"] as const;
const ALLOWED_UPLOADS: Record<(typeof ALLOWED_BUCKETS)[number], Record<string, string[]>> = {
  avatars: {
    "image/jpeg": ["jpg", "jpeg"],
    "image/png": ["png"],
    "image/webp": ["webp"],
  },
  "chat-media": {
    "image/jpeg": ["jpg", "jpeg"],
    "image/png": ["png"],
    "image/webp": ["webp"],
    "video/mp4": ["mp4"],
    "video/3gpp": ["3gp"],
    "audio/aac": ["aac"],
    "audio/amr": ["amr"],
    "audio/mpeg": ["mp3"],
    "audio/mp4": ["m4a", "mp4"],
    "audio/ogg": ["ogg"],
    "application/pdf": ["pdf"],
    "application/msword": ["doc"],
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document": ["docx"],
    "application/vnd.ms-excel": ["xls"],
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": ["xlsx"],
    "application/vnd.ms-powerpoint": ["ppt"],
    "application/vnd.openxmlformats-officedocument.presentationml.presentation": ["pptx"],
    "text/plain": ["txt"],
  },
  "flow-media": {
    "image/jpeg": ["jpg", "jpeg"],
    "image/png": ["png"],
    "image/webp": ["webp"],
    "video/mp4": ["mp4"],
    "audio/mpeg": ["mp3"],
    "audio/ogg": ["ogg"],
    "application/pdf": ["pdf"],
  },
};

const DeleteSchema = z.object({
  bucket: z.enum(ALLOWED_BUCKETS),
  path: z.string().min(1),
});

function normalizeBucket(value: FormDataEntryValue | null) {
  return ALLOWED_BUCKETS.find((bucket) => bucket === value) ?? null;
}

function fileExtension(fileName: string): string {
  return fileName.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1] ?? "";
}

function isAllowedUpload(bucket: (typeof ALLOWED_BUCKETS)[number], file: File): boolean {
  const mimeType = file.type.toLowerCase().split(";")[0].trim();
  const allowedExtensions = ALLOWED_UPLOADS[bucket][mimeType];
  if (!allowedExtensions) return false;
  return allowedExtensions.includes(fileExtension(file.name));
}

function objectKey(bucket: string, path: string): string {
  return `${bucket}/${path}`;
}

export async function POST(request: Request) {
  try {
    const { accountId } = await getCurrentDbAccount();

    const form = await request.formData();
    const bucket = normalizeBucket(form.get("bucket"));
    const file = form.get("file");
    if (!bucket || !(file instanceof File)) {
      return NextResponse.json(
        { error: "bucket and file are required" },
        { status: 400 },
      );
    }
    if (file.size <= 0) {
      return NextResponse.json({ error: "File is empty" }, { status: 400 });
    }
    if (file.size > MEDIA_MAX_BYTES) {
      return NextResponse.json({ error: "File is too large" }, { status: 413 });
    }
    if (!isAllowedUpload(bucket, file)) {
      return NextResponse.json({ error: "File type is not allowed" }, { status: 415 });
    }

    const path = buildMediaPath(accountId, file.name);
    const key = objectKey(bucket, path);
    await putObject({
      key,
      body: Buffer.from(await file.arrayBuffer()),
      contentType: file.type || "application/octet-stream",
      cacheControl: "3600",
    });

    return NextResponse.json({ path, publicUrl: publicObjectUrl(key) });
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function DELETE(request: Request) {
  try {
    const { accountId } = await getCurrentDbAccount();

    const parsed = DeleteSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) {
      return NextResponse.json({ error: "Invalid delete request" }, { status: 400 });
    }

    if (!parsed.data.path.startsWith(`account-${accountId}/`)) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    await deleteObject(objectKey(parsed.data.bucket, parsed.data.path));
    return NextResponse.json({ ok: true });
  } catch (err) {
    return toErrorResponse(err);
  }
}
