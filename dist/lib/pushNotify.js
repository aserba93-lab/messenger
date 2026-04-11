import { prisma } from "../db/prisma.js";
import { env } from "../config/env.js";

/**
 * Отправка data+notification на зарегистрированные устройства (FCM multicast, legacy API).
 * Нужен FCM_SERVER_KEY в .env и регистрация токена через mutation registerPushDevice.
 */
export async function sendPushToUsers(params) {
    const { userIds, title, body, data } = params;
    const key = env.FCM_SERVER_KEY;
    if (!key || !userIds?.length)
        return;
    const ids = [...new Set(userIds.map((x) => String(x)))];
    const devices = await prisma.pushDevice.findMany({
        where: { userId: { in: ids } },
        select: { token: true },
    });
    const tokens = devices.map((d) => d.token).filter(Boolean);
    if (!tokens.length)
        return;
    const chunkSize = 200;
    for (let i = 0; i < tokens.length; i += chunkSize) {
        const chunk = tokens.slice(i, i + chunkSize);
        try {
            const res = await fetch("https://fcm.googleapis.com/fcm/send", {
                method: "POST",
                headers: {
                    Authorization: `key=${key}`,
                    "Content-Type": "application/json",
                },
                body: JSON.stringify({
                    registration_ids: chunk,
                    notification: title || body ? { title: title ?? "", body: body ?? "" } : undefined,
                    data: data && typeof data === "object" ? Object.fromEntries(Object.entries(data).map(([k, v]) => [k, String(v ?? "")])) : undefined,
                    priority: "high",
                }),
            });
            if (!res.ok) {
                const t = await res.text().catch(() => "");
                console.warn("[push] FCM error", res.status, t.slice(0, 200));
            }
        }
        catch (e) {
            console.warn("[push] FCM request failed", e?.message ?? e);
        }
    }
}
