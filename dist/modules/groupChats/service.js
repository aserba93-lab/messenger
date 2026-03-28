import { emitToRoom } from "../../socket/emitter.js";
import { GroupChatsRepository } from "./repository.js";
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
function mapMessage(row, viewerId) {
    return {
        id: row.id,
        channelId: row.channelId,
        fileId: row.fileId ?? null,
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
        parentMessageId: row.parentMessageId,
        isDeleted: row.isDeleted,
        editedAt: row.editedAt,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
        reactions: mapReactionsForViewer(row.reactions ?? [], viewerId),
    };
}
export class GroupChatsService {
    repo;
    notifications;
    constructor(repo = new GroupChatsRepository(), notifications = new NotificationsService()) {
        this.repo = repo;
        this.notifications = notifications;
    }
    requireCanMassMention(viewer, content) {
        const hasEveryone = /(^|\s)@everyone(\s|$)/i.test(content);
        const hasChannel = /(^|\s)@channel(\s|$)/i.test(content);
        if (!hasEveryone && !hasChannel)
            return;
        const orgCan = viewer.role === "owner" || viewer.role === "admin" || viewer.role === "manager";
        if (!orgCan)
            throw new Error("Forbidden");
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
    async listGroupChats(viewer) {
        const groups = await this.repo.listGroupChatsForUser({ organizationId: viewer.organizationId, userId: viewer.userId });
        return groups.map((g) => ({
            id: g.id,
            name: g.name,
            memberIds: g.members.map((m) => m.userId),
        }));
    }
    async createGroupChat(viewer, input) {
        if (!viewer.emailVerified)
            throw new Error("Email not verified");
        const group = await this.repo.createGroupChat({
            organizationId: viewer.organizationId,
            createdByUserId: viewer.userId,
            name: input.name,
            memberIds: input.memberIds,
        });
        for (const m of group.members) {
            if (m.userId === viewer.userId)
                continue;
            await this.notifications.createSystem({
                organizationId: viewer.organizationId,
                userId: m.userId,
                type: "groupchat:added",
                payload: { groupChatId: group.id, addedByUserId: viewer.userId, name: group.name },
                groupChatId: group.id,
            });
        }
        return { id: group.id, name: group.name, memberIds: group.members.map((m) => m.userId) };
    }
    async listMessages(viewer, input) {
        const member = await this.repo.isGroupMember({ groupChatId: input.groupChatId, userId: viewer.userId });
        if (!member)
            throw new Error("Forbidden");
        const rows = await this.repo.listGroupMessages({
            organizationId: viewer.organizationId,
            groupChatId: input.groupChatId,
            limit: input.limit,
        });
        return rows.map((r) => mapMessage(r, viewer.userId));
    }
    async sendMessage(viewer, input) {
        if (!viewer.emailVerified)
            throw new Error("Email not verified");
        this.requireCanMassMention(viewer, input.content);
        const member = await this.repo.isGroupMember({ groupChatId: input.groupChatId, userId: viewer.userId });
        if (!member)
            throw new Error("Forbidden");
        if (input.parentMessageId) {
            const parent = await prisma.message.findUnique({ where: { id: input.parentMessageId }, select: { id: true, organizationId: true, groupChatId: true } });
            if (!parent || parent.organizationId !== viewer.organizationId || parent.groupChatId !== input.groupChatId)
                throw new Error("Invalid parentMessageId");
        }
        const row = await this.repo.createGroupMessage({
            organizationId: viewer.organizationId,
            groupChatId: input.groupChatId,
            authorId: viewer.userId,
            content: input.content,
            parentMessageId: input.parentMessageId,
        });
        const msg = mapMessage(row, viewer.userId);
        emitToRoom(`group:${input.groupChatId}`, "message:new", { ...msg, groupChatId: input.groupChatId });
        const mentioned = this.extractMentionedEmails(input.content);
        if (mentioned.length) {
            const users = await prisma.user.findMany({ where: { email: { in: mentioned } }, select: { id: true } });
            for (const u of users) {
                if (u.id === viewer.userId)
                    continue;
                const isMember = await this.repo.isGroupMember({ groupChatId: input.groupChatId, userId: u.id });
                if (!isMember)
                    continue;
                const pref = await this.notifications.getPreferenceForUser({
                    organizationId: viewer.organizationId,
                    userId: u.id,
                    groupChatId: input.groupChatId,
                });
                if (pref?.mode === "none")
                    continue;
                await this.notifications.createMention({
                    organizationId: viewer.organizationId,
                    mentionedUserId: u.id,
                    actorUserId: viewer.userId,
                    messageId: row.id,
                    groupChatId: input.groupChatId,
                    snippet: input.content.slice(0, 140),
                });
            }
        }
        return { ...msg, groupChatId: input.groupChatId };
    }
    async sendFileMessage(viewer, input) {
        if (!viewer.emailVerified)
            throw new Error("Email not verified");
        const member = await this.repo.isGroupMember({ groupChatId: input.groupChatId, userId: viewer.userId });
        if (!member)
            throw new Error("Forbidden");
        const file = await prisma.file.findUnique({ where: { id: input.fileId } });
        if (!file || file.organizationId !== viewer.organizationId)
            throw new Error("File not found");
        if (file.avStatus !== "clean")
            throw new Error("File not available");
        const row = await prisma.message.create({
            data: {
                organizationId: viewer.organizationId,
                groupChatId: input.groupChatId,
                authorId: viewer.userId,
                content: file.originalName ?? "",
                type: input.kind,
                fileId: file.id,
            },
            include: { author: true, reactions: true },
        });
        const msg = mapMessage(row, viewer.userId);
        emitToRoom(`group:${input.groupChatId}`, "message:new", { ...msg, groupChatId: input.groupChatId });
        return { ...msg, groupChatId: input.groupChatId };
    }

    async editGroupChatMessage(viewer, input) {
        if (!viewer.emailVerified)
            throw new Error("Email not verified");
        const member = await this.repo.isGroupMember({ groupChatId: input.groupChatId, userId: viewer.userId });
        if (!member)
            throw new Error("Forbidden");
        const row0 = await prisma.message.findUnique({ where: { id: input.messageId }, select: { id: true, organizationId: true, groupChatId: true, authorId: true, isDeleted: true, createdAt: true } });
        if (!row0 || row0.organizationId !== viewer.organizationId || row0.groupChatId !== input.groupChatId)
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
            include: { author: true, reactions: true },
        });
        const msg = mapMessage(row, viewer.userId);
        emitToRoom(`group:${input.groupChatId}`, "message:update", { ...msg, groupChatId: input.groupChatId });
        return { ...msg, groupChatId: input.groupChatId };
    }

    async deleteGroupChatMessage(viewer, input) {
        if (!viewer.emailVerified)
            throw new Error("Email not verified");
        const member = await this.repo.isGroupMember({ groupChatId: input.groupChatId, userId: viewer.userId });
        if (!member)
            throw new Error("Forbidden");
        const row0 = await prisma.message.findUnique({ where: { id: input.messageId }, select: { id: true, organizationId: true, groupChatId: true, authorId: true, isDeleted: true } });
        if (!row0 || row0.organizationId !== viewer.organizationId || row0.groupChatId !== input.groupChatId)
            throw new Error("Not found");
        if (row0.authorId !== viewer.userId && viewer.role !== "owner" && viewer.role !== "admin")
            throw new Error("Forbidden");
        if (row0.isDeleted)
            return true;
        await prisma.message.update({ where: { id: input.messageId }, data: { isDeleted: true, content: "" } });
        emitToRoom(`group:${input.groupChatId}`, "message:delete", { id: input.messageId, groupChatId: input.groupChatId });
        return true;
    }
}
