import { emitToRoom } from "../../socket/emitter.js";
import { DirectChatsRepository } from "./repository.js";
import { prisma } from "../../db/prisma.js";
import { NotificationsService } from "../notifications/service.js";
import { env } from "../../config/env.js";
function mapReactionsForViewer(reactions, viewerId) {
    const byEmoji = new Map();
    for (const r of reactions ?? []) {
        const cur = byEmoji.get(r.emoji) ?? { emoji: r.emoji, count: 0, viewerHasReacted: false };
        cur.count += 1;
        if (r.userId === viewerId)
            cur.viewerHasReacted = true;
        byEmoji.set(r.emoji, cur);
    }
    return Array.from(byEmoji.values()).sort((a, b) => a.emoji.localeCompare(b.emoji));
}
function requireVerified(viewer) {
    if (!viewer.emailVerified)
        throw new Error("Email not verified");
}
function mapMessage(row, viewerId) {
    return {
        id: row.id,
        directChatId: row.directChatId,
        author: {
            id: row.author.id,
            email: row.author.email,
            firstName: row.author.firstName,
            lastName: row.author.lastName,
            avatarUrl: row.author.avatarUrl,
            lastSeen: row.author.lastSeen,
        },
        content: row.isDeleted ? "" : row.content,
        type: row.type,
        parentMessageId: row.parentMessageId ?? null,
        reactions: mapReactionsForViewer(row.reactions ?? [], viewerId),
        file: row.file
            ? {
                id: row.file.id,
                mimeType: row.file.mimeType,
                size: row.file.size,
                originalName: row.file.originalName ?? null,
                avStatus: row.file.avStatus,
                avCheckedAt: row.file.avCheckedAt,
                blockedReason: row.file.blockedReason ?? null,
            }
            : null,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
        editedAt: row.editedAt ?? null,
    };
}
export class DirectChatsService {
    repo;
    notifications;
    constructor(repo = new DirectChatsRepository(), notifications = new NotificationsService()) {
        this.repo = repo;
        this.notifications = notifications;
    }
    extractMentionedEmails(content) {
        const emails = new Set();
        const re = /@([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/g;
        let m;
        // eslint-disable-next-line no-cond-assign
        while ((m = re.exec(content))) {
            const v = m[1];
            if (v)
                emails.add(v.toLowerCase());
            if (emails.size >= 20)
                break;
        }
        return Array.from(emails);
    }
    async listDirectChats(viewer) {
        const chats = await this.repo.listDirectChatsForUser({ organizationId: viewer.organizationId, userId: viewer.userId });
        return chats.map((c) => ({ id: c.id, userIds: c.members.map((m) => m.userId) }));
    }
    async listMessages(viewer, input) {
        const isMember = await this.repo.isMember({ directChatId: input.directChatId, userId: viewer.userId });
        if (!isMember)
            throw new Error("Forbidden");
        const rows = await this.repo.listMessages({ organizationId: viewer.organizationId, directChatId: input.directChatId, limit: input.limit });
        return rows.map((r) => mapMessage(r, viewer.userId));
    }

    async ensureDirectChat(viewer, input) {
        requireVerified(viewer);
        if (input.userId === viewer.userId) {
            const chat = await this.repo.upsertSelfDirectChat({ organizationId: viewer.organizationId, userId: viewer.userId });
            return { id: chat.id, userIds: chat.members.map((m) => m.userId) };
        }
        const chat = await this.repo.upsertDirectChat({ organizationId: viewer.organizationId, userA: viewer.userId, userB: input.userId });
        return { id: chat.id, userIds: chat.members.map((m) => m.userId) };
    }
    async sendDirectMessage(viewer, input) {
        requireVerified(viewer);
        const chat = input.userId === viewer.userId
            ? await this.repo.upsertSelfDirectChat({ organizationId: viewer.organizationId, userId: viewer.userId })
            : await this.repo.upsertDirectChat({ organizationId: viewer.organizationId, userA: viewer.userId, userB: input.userId });
        if (input.parentMessageId) {
            const parent = await prisma.message.findUnique({
                where: { id: input.parentMessageId },
                select: { id: true, organizationId: true, directChatId: true },
            });
            if (!parent || parent.organizationId !== viewer.organizationId || parent.directChatId !== chat.id)
                throw new Error("Invalid parentMessageId");
        }
        const row = await this.repo.createMessage({
            organizationId: viewer.organizationId,
            directChatId: chat.id,
            authorId: viewer.userId,
            content: input.content,
            parentMessageId: input.parentMessageId,
        });
        const msg = mapMessage(row, viewer.userId);
        emitToRoom(`dm:${chat.id}`, "message:new", msg);
        const mentioned = this.extractMentionedEmails(input.content);
        if (mentioned.length) {
            const users = await prisma.user.findMany({ where: { email: { in: mentioned } }, select: { id: true } });
            for (const u of users) {
                if (u.id === viewer.userId)
                    continue;
                const isMember = await this.repo.isMember({ directChatId: chat.id, userId: u.id });
                if (!isMember)
                    continue;
                const pref = await this.notifications.getPreferenceForUser({
                    organizationId: viewer.organizationId,
                    userId: u.id,
                    directChatId: chat.id,
                });
                if (pref?.mode === "none")
                    continue;
                await this.notifications.createMention({
                    organizationId: viewer.organizationId,
                    mentionedUserId: u.id,
                    actorUserId: viewer.userId,
                    messageId: row.id,
                    directChatId: chat.id,
                    snippet: input.content.slice(0, 140),
                });
            }
        }
        return msg;
    }

    async sendDirectFileMessage(viewer, input) {
        requireVerified(viewer);
        const isMember = await this.repo.isMember({ directChatId: input.directChatId, userId: viewer.userId });
        if (!isMember)
            throw new Error("Forbidden");
        const file = await prisma.file.findUnique({ where: { id: input.fileId } });
        if (!file || file.organizationId !== viewer.organizationId)
            throw new Error("Not found");
        if (file.avStatus !== "clean")
            throw new Error("File not available");
        const row = await this.repo.createMessage({
            organizationId: viewer.organizationId,
            directChatId: input.directChatId,
            authorId: viewer.userId,
            content: "",
            type: input.kind,
            fileId: input.fileId,
        });
        const msg = mapMessage(row, viewer.userId);
        emitToRoom(`dm:${input.directChatId}`, "message:new", msg);
        return msg;
    }

    async editDirectMessage(viewer, input) {
        requireVerified(viewer);
        const isMember = await this.repo.isMember({ directChatId: input.directChatId, userId: viewer.userId });
        if (!isMember)
            throw new Error("Forbidden");
        const row0 = await prisma.message.findUnique({ where: { id: input.messageId }, select: { id: true, organizationId: true, directChatId: true, authorId: true, isDeleted: true, createdAt: true } });
        if (!row0 || row0.organizationId !== viewer.organizationId || row0.directChatId !== input.directChatId)
            throw new Error("Not found");
        if (row0.isDeleted)
            throw new Error("Cannot edit deleted message");
        if (row0.authorId !== viewer.userId && viewer.role !== "owner" && viewer.role !== "admin")
            throw new Error("Forbidden");
        if (row0.authorId === viewer.userId) {
            const ageMs = Date.now() - new Date(row0.createdAt).getTime();
            if (ageMs > env.MESSAGE_EDIT_WINDOW_SECONDS * 1000)
                throw new Error("Edit window expired");
        }
        const row = await prisma.message.update({
            where: { id: input.messageId },
            data: { content: input.content, editedAt: new Date() },
            include: { author: true, reactions: true, file: true },
        });
        const msg = mapMessage(row, viewer.userId);
        emitToRoom(`dm:${input.directChatId}`, "message:update", msg);
        return msg;
    }

    async deleteDirectMessage(viewer, input) {
        requireVerified(viewer);
        const isMember = await this.repo.isMember({ directChatId: input.directChatId, userId: viewer.userId });
        if (!isMember)
            throw new Error("Forbidden");
        const row0 = await prisma.message.findUnique({ where: { id: input.messageId }, select: { id: true, organizationId: true, directChatId: true, authorId: true, isDeleted: true } });
        if (!row0 || row0.organizationId !== viewer.organizationId || row0.directChatId !== input.directChatId)
            throw new Error("Not found");
        if (row0.authorId !== viewer.userId && viewer.role !== "owner" && viewer.role !== "admin")
            throw new Error("Forbidden");
        if (row0.isDeleted)
            return true;
        await prisma.message.update({ where: { id: input.messageId }, data: { isDeleted: true, content: "" } });
        emitToRoom(`dm:${input.directChatId}`, "message:delete", { id: input.messageId, directChatId: input.directChatId });
        return true;
    }
}
