import { NextResponse } from "next/server";
import { z } from "zod";
import { getCurrentDbAccount } from "@/lib/auth/current-account";
import { toErrorResponse } from "@/lib/auth/errors";
import { deleteObject, publicObjectUrl, putObject } from "@/lib/storage/alarik";
import { buildMediaPath, MEDIA_MAX_BYTES } from "@/lib/storage/upload-media";

const DeleteSchema = z.object({
  bucket: z.string().min(1),
  path: z.string().min(1),
});

function objectKey(bucket: string, path: string): string {
  return `${bucket}/${path}`;
}

export async function POST(request: Request) {
  try {
    const { accountId } = await getCurrentDbAccount();

    const form = await request.formData();
    const bucket = String(form.get("bucket") ?? "");
    const file = form.get("file");
    if (!bucket || !(file instanceof File)) {
      return NextResponse.json(
        { error: "bucket and file are required" },
        { status: 400 },
      );
    }
    if (file.size > MEDIA_MAX_BYTES) {
      return NextResponse.json({ error: "File is too large" }, { status: 413 });
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
