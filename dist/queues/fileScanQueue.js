import { Queue } from "bullmq";
import { env } from "../config/env.js";
import { redis } from "../db/redis.js";
export const FILE_SCAN_QUEUE_NAME = "file-scan";
function queueConnection() {
    // BullMQ expects node-redis options shape, but it also accepts an ioredis instance.
    return redis;
}
export const fileScanQueue = new Queue(FILE_SCAN_QUEUE_NAME, {
    connection: queueConnection(),
    defaultJobOptions: {
        removeOnComplete: { age: 60 * 60, count: 1000 },
        removeOnFail: { age: 24 * 60 * 60, count: 1000 },
    },
});
export async function enqueueFileScan(fileId) {
    if (env.FILES_SCAN_PROVIDER !== "clamd")
        return;
    await fileScanQueue.add("scan", { fileId }, {
        jobId: `file:${fileId}`,
    });
}
