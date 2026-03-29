import { emitToUser } from "./emitter.js";
const REDIS_CHANNEL = "events:fileStatus";
export function setupFileStatusBridge(redis) {
    const sub = redis.duplicate({ enableOfflineQueue: true });
    sub.on("error", (err) => {
        // eslint-disable-next-line no-console
        console.warn("[fileStatusBridge] redis error:", err?.message ?? err);
    });
    sub.subscribe(REDIS_CHANNEL).catch((e) => {
        // eslint-disable-next-line no-console
        console.warn("[fileStatusBridge] subscribe failed:", e?.message ?? e);
    });
    sub.on("message", (_channel, message) => {
        try {
            const evt = JSON.parse(message);
            if (!evt?.uploadedByUserId || !evt?.fileId)
                return;
            emitToUser(evt.uploadedByUserId, "file:status", evt);
        }
        catch {
            // ignore malformed message
        }
    });
}
export { REDIS_CHANNEL };
