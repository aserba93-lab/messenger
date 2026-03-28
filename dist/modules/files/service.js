import { S3Client, PutObjectCommand, GetObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { env } from "../../config/env.js";
import { prisma } from "../../db/prisma.js";
import { enqueueFileScan } from "../../queues/fileScanQueue.js";
import crypto from "crypto";
import path from "path";
import fs from "node:fs/promises";
function normalizeExt(ext) {
    const e = ext.trim().toLowerCase();
    if (!e)
        return "";
    return e.startsWith(".") ? e : `.${e}`;
}
function parsePolicy(settings) {
    const maxMb = typeof settings?.maxFileSizeMb === "number" ? settings.maxFileSizeMb : undefined;
    const maxBytes = Math.max(1, (maxMb ?? 100) * 1024 * 1024);
    const blocked = Array.isArray(settings?.blockedExtensions) ? settings.blockedExtensions : [];
    const allowed = Array.isArray(settings?.allowedMimeTypes) ? settings.allowedMimeTypes : null;
    return {
        maxFileSizeBytes: maxBytes,
        blockedExtensions: blocked.map((x) => normalizeExt(String(x))).filter(Boolean),
        allowedMimeTypes: allowed ? allowed.map((x) => String(x).toLowerCase()).filter(Boolean) : null,
    };
}
function inferMimeFromName(name) {
    const n = String(name ?? "").toLowerCase();
    if (n.endsWith(".torrent"))
        return "application/x-bittorrent";
    if (n.endsWith(".webm"))
        return "audio/webm";
    return "application/octet-stream";
}
function s3() {
    return new S3Client({
        region: env.MINIO_REGION,
        endpoint: env.MINIO_ENDPOINT,
        forcePathStyle: env.MINIO_FORCE_PATH_STYLE,
        credentials: {
            accessKeyId: env.MINIO_ACCESS_KEY,
            secretAccessKey: env.MINIO_SECRET_KEY,
        },
    });
}
export class FilesService {
    async createPresignedUpload(viewer, input) {
        const org = await prisma.organization.findUnique({ where: { id: viewer.organizationId } });
        const policy = parsePolicy(org?.settings);
        if (input.size > policy.maxFileSizeBytes)
            throw new Error("File too large");
        const ext = normalizeExt(path.extname(input.originalName ?? ""));
        if (ext && policy.blockedExtensions.includes(ext))
            throw new Error("File type blocked");
        const mimeResolved = String(input.mimeType || inferMimeFromName(input.originalName)).toLowerCase();
        const mimeLower = mimeResolved;
        if (policy.allowedMimeTypes && !policy.allowedMimeTypes.includes(mimeLower))
            throw new Error("Mime type not allowed");
        const key = `${viewer.organizationId}/${viewer.userId}/${Date.now()}-${crypto.randomBytes(8).toString("hex")}`;
        const file = await prisma.file.create({
            data: {
                organizationId: viewer.organizationId,
                bucket: env.MINIO_BUCKET,
                key,
                mimeType: mimeResolved,
                size: input.size,
                originalName: input.originalName ?? null,
                uploadedByUserId: viewer.userId,
                avStatus: "pending",
            },
        });
        const url = await getSignedUrl(s3(), new PutObjectCommand({
            Bucket: env.MINIO_BUCKET,
            Key: key,
            ContentType: mimeResolved,
        }), { expiresIn: 60 * 5 });
        return { fileId: file.id, key, uploadUrl: url };
    }
    async getDownloadUrl(viewer, fileId) {
        const file = await prisma.file.findUnique({ where: { id: fileId } });
        if (!file || file.organizationId !== viewer.organizationId)
            throw new Error("Not found");
        if (file.avStatus !== "clean")
            throw new Error("File not available");
        if (file.url && file.url.startsWith("/files/local/")) {
            return { file, downloadUrl: file.url };
        }
        const url = await getSignedUrl(s3(), new GetObjectCommand({
            Bucket: file.bucket,
            Key: file.key,
        }), { expiresIn: 60 * 10 });
        return { file, downloadUrl: url };
    }
    async confirmFileUploaded(viewer, fileId) {
        const file = await prisma.file.findUnique({ where: { id: fileId } });
        if (!file || file.organizationId !== viewer.organizationId)
            throw new Error("Not found");
        if (file.uploadedByUserId !== viewer.userId)
            throw new Error("Forbidden");
        if (env.FILES_AUTO_MARK_CLEAN || env.NODE_ENV !== "production") {
            await prisma.file.update({
                where: { id: fileId },
                data: { avStatus: "clean", avCheckedAt: new Date(), blockedReason: null },
            });
            return true;
        }
        // Queue background scan (clamd). The file remains pending until scanned.
        try {
            await enqueueFileScan(fileId);
        }
        catch (e) {
            // Dev fallback: when Redis/queue is unavailable, don't block uploads.
            // In production, configure Redis + scanner and keep strict flow.
            if (env.NODE_ENV !== "production") {
                await prisma.file.update({
                    where: { id: fileId },
                    data: { avStatus: "clean", avCheckedAt: new Date(), blockedReason: "scan-bypass:redis-unavailable" },
                });
                return true;
            }
            throw e;
        }
        return true;
    }
    async uploadByProxy(viewer, fileId, body, mimeType) {
        const file = await prisma.file.findUnique({ where: { id: fileId } });
        if (!file || file.organizationId !== viewer.organizationId)
            throw new Error("Not found");
        if (file.uploadedByUserId !== viewer.userId)
            throw new Error("Forbidden");
        try {
            await s3().send(new PutObjectCommand({
                Bucket: file.bucket,
                Key: file.key,
                Body: body,
                ContentType: mimeType || file.mimeType || "application/octet-stream",
            }));
        }
        catch (e) {
            if (env.NODE_ENV !== "production") {
                // Dev fallback when MinIO is unavailable locally:
                // persist file on local disk and expose via backend route.
                const uploadsDir = path.resolve(process.cwd(), ".local_uploads");
                await fs.mkdir(uploadsDir, { recursive: true });
                const diskPath = path.join(uploadsDir, file.id);
                await fs.writeFile(diskPath, body);
                await prisma.file.update({
                    where: { id: file.id },
                    data: { url: `/files/local/${file.id}` },
                });
                return true;
            }
            throw e;
        }
        return true;
    }
}
