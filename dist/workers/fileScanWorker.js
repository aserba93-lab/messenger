import "dotenv/config";
import { Worker } from "bullmq";
import net from "net";
import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { env } from "../config/env.js";
import { prisma } from "../db/prisma.js";
import { redis } from "../db/redis.js";
import { FILE_SCAN_QUEUE_NAME } from "../queues/fileScanQueue.js";
import { REDIS_CHANNEL } from "../socket/fileStatusBridge.js";
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
async function clamdScanStream(readable) {
    const socket = new net.Socket();
    socket.setTimeout(env.CLAMD_TIMEOUT_MS);
    const response = await new Promise((resolve, reject) => {
        const chunks = [];
        const onError = (e) => reject(e);
        const onTimeout = () => reject(new Error("clamd timeout"));
        socket.once("error", onError);
        socket.once("timeout", onTimeout);
        socket.connect(env.CLAMD_PORT, env.CLAMD_HOST, () => {
            // INSTREAM command (note leading 'z' for zipped stream is not needed; protocol accepts 'zINSTREAM' too,
            // but we use plain INSTREAM).
            socket.write("INSTREAM\0");
            readable.on("data", (chunk) => {
                const b = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
                const len = Buffer.alloc(4);
                len.writeUInt32BE(b.length, 0);
                socket.write(len);
                socket.write(b);
            });
            readable.once("end", () => {
                const zero = Buffer.alloc(4);
                zero.writeUInt32BE(0, 0);
                socket.write(zero);
            });
            readable.once("error", (e) => reject(e));
        });
        socket.on("data", (d) => chunks.push(Buffer.from(d)));
        socket.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
        socket.on("close", () => resolve(Buffer.concat(chunks).toString("utf8")));
    }).finally(() => {
        try {
            socket.destroy();
        }
        catch {
            // ignore
        }
    });
    const text = String(response || "").trim();
    // Typical responses:
    // "stream: OK"
    // "stream: Eicar-Test-Signature FOUND"
    if (/:\s*OK$/i.test(text))
        return { ok: true };
    if (/:\s*(.+)\s+FOUND$/i.test(text))
        return { ok: false, reason: text };
    return { ok: false, reason: text || "clamd unknown response" };
}
async function scanFile(fileId) {
    const file = await prisma.file.findUnique({ where: { id: fileId } });
    if (!file)
        return;
    // only scan pending files
    if (file.avStatus !== "pending")
        return;
    try {
        const out = await s3().send(new GetObjectCommand({ Bucket: file.bucket, Key: file.key }));
        const body = out.Body;
        if (!body || typeof body.on !== "function")
            throw new Error("S3 body stream unavailable");
        const res = await clamdScanStream(body);
        if (res.ok) {
            const updated = await prisma.file.update({
                where: { id: fileId },
                data: { avStatus: "clean", avCheckedAt: new Date(), blockedReason: null },
            });
            const evt = {
                fileId,
                organizationId: updated.organizationId,
                uploadedByUserId: updated.uploadedByUserId,
                avStatus: updated.avStatus,
                avCheckedAt: updated.avCheckedAt ? updated.avCheckedAt.toISOString() : null,
                blockedReason: updated.blockedReason,
            };
            await redis.publish(REDIS_CHANNEL, JSON.stringify(evt));
        }
        else {
            const updated = await prisma.file.update({
                where: { id: fileId },
                data: { avStatus: "infected", avCheckedAt: new Date(), blockedReason: res.reason.slice(0, 500) },
            });
            const evt = {
                fileId,
                organizationId: updated.organizationId,
                uploadedByUserId: updated.uploadedByUserId,
                avStatus: updated.avStatus,
                avCheckedAt: updated.avCheckedAt ? updated.avCheckedAt.toISOString() : null,
                blockedReason: updated.blockedReason,
            };
            await redis.publish(REDIS_CHANNEL, JSON.stringify(evt));
        }
    }
    catch (e) {
        const updated = await prisma.file.update({
            where: { id: fileId },
            data: { avStatus: "error", avCheckedAt: new Date(), blockedReason: String(e?.message ?? e).slice(0, 500) },
        });
        const evt = {
            fileId,
            organizationId: updated.organizationId,
            uploadedByUserId: updated.uploadedByUserId,
            avStatus: updated.avStatus,
            avCheckedAt: updated.avCheckedAt ? updated.avCheckedAt.toISOString() : null,
            blockedReason: updated.blockedReason,
        };
        await redis.publish(REDIS_CHANNEL, JSON.stringify(evt));
    }
}
if (env.FILES_SCAN_PROVIDER !== "clamd") {
    // eslint-disable-next-line no-console
    console.log("[fileScanWorker] FILES_SCAN_PROVIDER is not clamd; exiting.");
    process.exit(0);
}
// Ensure Redis connection for BullMQ.
redis.connect().catch(() => { });
// eslint-disable-next-line no-console
console.log(`[fileScanWorker] starting (clamd ${env.CLAMD_HOST}:${env.CLAMD_PORT})`);
new Worker(FILE_SCAN_QUEUE_NAME, async (job) => {
    const fileId = String(job.data?.fileId ?? "");
    if (!fileId)
        return;
    await scanFile(fileId);
}, { connection: redis });
