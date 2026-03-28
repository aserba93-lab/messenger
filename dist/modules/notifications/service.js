import { prisma } from "../../db/prisma.js";
import { emitToUser } from "../../socket/emitter.js";
export class NotificationsService {
    shouldDeliver(mode, type) {
        if (mode === "none")
            return false;
        if (mode === "all")
            return true;
        // mentions-only
        return type === "mention:user" || type === "thread:reply";
    }
    async shouldDeliverForUser(params) {
        const pref = await this.getPreferenceForUser({
            organizationId: params.organizationId,
            userId: params.userId,
            channelId: params.channelId ?? null,
            groupChatId: params.groupChatId ?? null,
            directChatId: params.directChatId ?? null,
        });
        const mode = pref?.mode ?? "all";
        return this.shouldDeliver(mode, params.type);
    }
    async list(viewer, limit) {
        const rows = await prisma.notification.findMany({
            where: { userId: viewer.userId, organizationId: viewer.organizationId },
            orderBy: { createdAt: "desc" },
            take: Math.max(1, Math.min(200, limit)),
        });
        return rows;
    }
    async markRead(viewer, notificationId) {
        const row = await prisma.notification.findUnique({ where: { id: notificationId } });
        if (!row || row.userId !== viewer.userId || row.organizationId !== viewer.organizationId)
            throw new Error("Not found");
        await prisma.notification.update({ where: { id: notificationId }, data: { isRead: true } });
        return true;
    }
    async getPreference(viewer, scope) {
        const key = {
            organizationId: viewer.organizationId,
            userId: viewer.userId,
            channelId: scope.channelId ?? null,
            groupChatId: scope.groupChatId ?? null,
            directChatId: scope.directChatId ?? null,
        };
        return prisma.notificationPreference.findFirst({
            where: key,
            orderBy: { updatedAt: "desc" },
        });
    }
    async getPreferenceForUser(params) {
        const key = {
            organizationId: params.organizationId,
            userId: params.userId,
            channelId: params.channelId ?? null,
            groupChatId: params.groupChatId ?? null,
            directChatId: params.directChatId ?? null,
        };
        return prisma.notificationPreference.findFirst({
            where: key,
            orderBy: { updatedAt: "desc" },
        });
    }
    async setPreference(viewer, input) {
        const scopeCount = [input.channelId, input.groupChatId, input.directChatId].filter(Boolean).length;
        if (scopeCount !== 1)
            throw new Error("Provide exactly one scope id");
        return prisma.notificationPreference.create({
            data: {
                organizationId: viewer.organizationId,
                userId: viewer.userId,
                channelId: input.channelId ?? null,
                groupChatId: input.groupChatId ?? null,
                directChatId: input.directChatId ?? null,
                mode: input.mode,
            },
        });
    }
    async createMention(params) {
        const ok = await this.shouldDeliverForUser({
            organizationId: params.organizationId,
            userId: params.mentionedUserId,
            type: "mention:user",
            channelId: params.channelId ?? null,
            groupChatId: params.groupChatId ?? null,
            directChatId: params.directChatId ?? null,
        });
        if (!ok)
            return null;
        const notif = await prisma.notification.create({
            data: {
                organizationId: params.organizationId,
                userId: params.mentionedUserId,
                type: "mention:user",
                payload: {
                    actorUserId: params.actorUserId,
                    messageId: params.messageId,
                    channelId: params.channelId ?? null,
                    groupChatId: params.groupChatId ?? null,
                    directChatId: params.directChatId ?? null,
                    snippet: params.snippet ?? null,
                },
            },
        });
        emitToUser(params.mentionedUserId, "notification:new", notif);
        return notif;
    }
    async createThreadReply(params) {
        const ok = await this.shouldDeliverForUser({
            organizationId: params.organizationId,
            userId: params.notifiedUserId,
            type: "thread:reply",
            channelId: params.channelId,
        });
        if (!ok)
            return null;
        const notif = await prisma.notification.create({
            data: {
                organizationId: params.organizationId,
                userId: params.notifiedUserId,
                type: "thread:reply",
                payload: {
                    actorUserId: params.actorUserId,
                    messageId: params.messageId,
                    parentMessageId: params.parentMessageId,
                    channelId: params.channelId,
                    snippet: params.snippet ?? null,
                },
            },
        });
        emitToUser(params.notifiedUserId, "notification:new", notif);
        return notif;
    }
    async createSystem(params) {
        const ok = await this.shouldDeliverForUser({
            organizationId: params.organizationId,
            userId: params.userId,
            type: params.type,
            channelId: params.channelId ?? null,
            groupChatId: params.groupChatId ?? null,
            directChatId: params.directChatId ?? null,
        });
        if (!ok)
            return null;
        const notif = await prisma.notification.create({
            data: {
                organizationId: params.organizationId,
                userId: params.userId,
                type: params.type,
                payload: params.payload ?? {},
            },
        });
        emitToUser(params.userId, "notification:new", notif);
        return notif;
    }
}
