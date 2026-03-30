import { S3Client, PutObjectCommand, GetObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { env } from "../../config/env.js";
import { prisma } from "../../db/prisma.js";
import { enqueueFileScan } from "../../queues/fileScanQueue.js";
import { emitToUser } from "../../socket/emitter.js";
import crypto from "crypto";
import path from "path";
import fs from "node:fs/promises";
import { createReadStream } from "node:fs";
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
export function inferMimeFromName(name) {
    const n = String(name ?? "").toLowerCase();
    if (n.endsWith(".torrent"))
        return "application/x-bittorrent";
    if (n.endsWith(".jpg") || n.endsWith(".jpeg"))
        return "image/jpeg";
    if (n.endsWith(".png"))
        return "image/png";
    if (n.endsWith(".gif"))
        return "image/gif";
    if (n.endsWith(".webp"))
        return "image/webp";
    if (n.endsWith(".bmp"))
        return "image/bmp";
    if (n.endsWith(".svg"))
        return "image/svg+xml";
    if (n.endsWith(".heic") || n.endsWith(".heif"))
        return "image/heic";
    if (n.endsWith(".avif"))
        return "image/avif";
    if (n.endsWith(".webm"))
        return "audio/webm";
    if (n.endsWith(".m4a") || n.endsWith(".mp4"))
        return "audio/mp4";
    if (n.endsWith(".mp3"))
        return "audio/mpeg";
    if (n.endsWith(".ogg") || n.endsWith(".opus"))
        return "audio/ogg";
    if (n.endsWith(".wav"))
        return "audio/wav";
    return "application/octet-stream";
}
function s3Credentials() {
    return {
        accessKeyId: env.MINIO_ACCESS_KEY,
        secretAccessKey: env.MINIO_SECRET_KEY,
    };
}
/** Прямое подключение к MinIO (upload с бэкенда, worker). */
function s3() {
    return new S3Client({
        region: env.MINIO_REGION,
        endpoint: env.MINIO_ENDPOINT,
        forcePathStyle: env.MINIO_FORCE_PATH_STYLE,
        credentials: s3Credentials(),
    });
}
/** Подпись URL для браузера: host должен совпадать с TLS-сертификатом (часто основной домен за nginx → MinIO). */
function s3ForPresignedUrls() {
    const endpoint = env.MINIO_PRESIGN_ENDPOINT ?? env.MINIO_ENDPOINT;
    return new S3Client({
        region: env.MINIO_REGION,
        endpoint,
        forcePathStyle: env.MINIO_FORCE_PATH_STYLE,
        credentials: s3Credentials(),
    });
}
/** Событие как у fileScanWorker → клиент с socket ждёт file:status в waitForFileClean */
function notifyFileAvStatus(file) {
    if (!file?.uploadedByUserId)
        return;
    emitToUser(file.uploadedByUserId, "file:status", {
        fileId: file.id,
        organizationId: file.organizationId,
        uploadedByUserId: file.uploadedByUserId,
        avStatus: file.avStatus,
        avCheckedAt: file.avCheckedAt ? file.avCheckedAt.toISOString() : null,
        blockedReason: file.blockedReason,
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
        const url = await getSignedUrl(s3ForPresignedUrls(), new PutObjectCommand({
            Bucket: env.MINIO_BUCKET,
            Key: key,
            ContentType: mimeResolved,
        }), { expiresIn: 60 * 5 });
        return { fileId: file.id, key, uploadUrl: url };
    }
    /** Метаданные + URL скачивания только если clean (для pending — downloadUrl null). */
    async getFileForViewer(viewer, fileId) {
        const file = await prisma.file.findUnique({ where: { id: fileId } });
        if (!file || file.organizationId !== viewer.organizationId)
            throw new Error("Not found");
        if (file.avStatus !== "clean")
            return { file, downloadUrl: null };
        /** Прокси на API: presigned MinIO часто открывается как SPA при неверном nginx. */
        return { file, downloadUrl: `/files/access/${file.id}` };
    }
    /** Поток файла для GET /files/access/:fileId (после JWT). */
    async openDownloadStream(viewer, fileId) {
        const file = await prisma.file.findUnique({ where: { id: fileId } });
        if (!file || file.organizationId !== viewer.organizationId)
            throw new Error("Not found");
        if (file.avStatus !== "clean")
            throw new Error("File not available");
        const storedMime = (file.mimeType || "").trim();
        const inferred = inferMimeFromName(file.originalName);
        const contentType =
            storedMime && storedMime !== "application/octet-stream"
                ? storedMime
                : inferred !== "application/octet-stream"
                    ? inferred
                    : storedMime || "application/octet-stream";
        if (file.url && file.url.startsWith("/files/local/")) {
            const diskPath = path.resolve(process.cwd(), ".local_uploads", file.id);
            const stream = createReadStream(diskPath);
            return { stream, contentType, file };
        }
        const out = await s3().send(new GetObjectCommand({
            Bucket: file.bucket,
            Key: file.key,
        }));
        const body = out.Body;
        if (!body)
            throw new Error("Empty body");
        return { stream: body, contentType, file };
    }
    async getDownloadUrl(viewer, fileId) {
        const { file, downloadUrl } = await this.getFileForViewer(viewer, fileId);
        if (file.avStatus !== "clean" || !downloadUrl)
            throw new Error("File not available");
        return { file, downloadUrl };
    }
    async confirmFileUploaded(viewer, fileId) {
        const file = await prisma.file.findUnique({ where: { id: fileId } });
        if (!file || file.organizationId !== viewer.organizationId)
            throw new Error("Not found");
        if (file.uploadedByUserId !== viewer.userId)
            throw new Error("Forbidden");
        if (env.FILES_AUTO_MARK_CLEAN || env.NODE_ENV !== "production") {
            const updated = await prisma.file.update({
                where: { id: fileId },
                data: { avStatus: "clean", avCheckedAt: new Date(), blockedReason: null },
            });
            notifyFileAvStatus(updated);
            return true;
        }
        // enqueueFileScan при FILES_SCAN_PROVIDER !== "clamd" ничего не делает — без этого файл вечно pending.
        if (env.FILES_SCAN_PROVIDER !== "clamd") {
            const updated = await prisma.file.update({
                where: { id: fileId },
                data: { avStatus: "clean", avCheckedAt: new Date(), blockedReason: null },
            });
            notifyFileAvStatus(updated);
            return true;
        }
        try {
            await enqueueFileScan(fileId);
        }
        catch (e) {
            // Dev fallback: when Redis/queue is unavailable, don't block uploads.
            // In production, configure Redis + scanner and keep strict flow.
            if (env.NODE_ENV !== "production") {
                const updated = await prisma.file.update({
                    where: { id: fileId },
                    data: { avStatus: "clean", avCheckedAt: new Date(), blockedReason: "scan-bypass:redis-unavailable" },
                });
                notifyFileAvStatus(updated);
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
