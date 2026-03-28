import { Redis } from "ioredis";
import { env } from "../config/env.js";
export const redis = globalThis.__redis ??
    new Redis(env.REDIS_URL, {
        // In dev Redis may be absent; don't crash the API.
        lazyConnect: true,
        maxRetriesPerRequest: null,
        enableOfflineQueue: false,
    });
if (process.env.NODE_ENV !== "production")
    globalThis.__redis = redis;
redis.on("error", (err) => {
    // eslint-disable-next-line no-console
    console.warn("[redis] error:", err?.message ?? err);
});
