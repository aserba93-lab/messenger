import { emitDmToMemberUsers } from "../../socket/emitter.js";
import { DirectChatsRepository } from "./repository.js";
import { prisma } from "../../db/prisma.js";
import { NotificationsService } from "../notifications/service.js";
import { env } from "../../config/env.js";
import { loadMembersMap, managerCanReachPeer, isDeptRestrictedRole } from "../../lib/departmentAccess.js";
import { sendPushToUsers } from "../../lib/pushNotify.js";
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
        const me = await prisma.organizationMember.findUnique({
            where: { organizationId_userId: { organizationId: viewer.organizationId, userId: viewer.userId } },
            select: { department: true, role: true },
        });
        const restricted = me && isDeptRestrictedRole(me.role);
        const out = [];
        for (const c of chats) {
            const uids = c.members.map((m) => m.userId);
            if (!restricted) {
                out.push({ id: c.id, userIds: uids });
                continue;
            }
            const others = uids.filter((id) => id !== viewer.userId);
            if (others.length === 0) {
                out.push({ id: c.id, userIds: uids });
                continue;
            }
            const mmap = await loadMembersMap(viewer.organizationId, [...uids]);
            let ok = true;
            for (const oid of others) {
                const peer = mmap.get(oid);
                if (!peer) {
                    ok = false;
                    break;
                }
                const pass = await managerCanReachPeer({
                    organizationId: viewer.organizationId,
                    managerId: viewer.userId,
                    managerDept: me.department,
                    managerRole: me.role,
                    peerId: oid,
                    peerDept: peer.department,
                    peerRole: peer.role,
                });
                if (!pass) {
                    ok = false;
                    break;
                }
            }
            if (ok)
                out.push({ id: c.id, userIds: uids });
        }
        return out;
    }
    async listMessages(viewer, input) {
        const isMember = await this.repo.isMember({ directChatId: input.directChatId, userId: viewer.userId });
        if (!isMember)
            throw new Error("Forbidden");
        const chatRow = await prisma.directChat.findUnique({
            where: { id: input.directChatId },
            include: { members: true },
        });
        if (!chatRow || chatRow.organizationId !== viewer.organizationId)
            throw new Error("Not found");
        const me = await prisma.organizationMember.findUnique({
            where: { organizationId_userId: { organizationId: viewer.organizationId, userId: viewer.userId } },
            select: { department: true, role: true },
        });
        if (me && isDeptRestrictedRole(me.role)) {
            const mmap = await loadMembersMap(viewer.organizationId, chatRow.members.map((m) => m.userId));
            for (const oid of chatRow.members.map((m) => m.userId)) {
                if (oid === viewer.userId)
                    continue;
                const peer = mmap.get(oid);
                if (!peer)
                    continue;
                const ok = await managerCanReachPeer({
                    organizationId: viewer.organizationId,
                    managerId: viewer.userId,
                    managerDept: me.department,
                    managerRole: me.role,
                    peerId: oid,
                    peerDept: peer.department,
                    peerRole: peer.role,
                });
                if (!ok)
                    throw new Error("Forbidden");
            }
        }
        const rows = await this.repo.listMessages({ organizationId: viewer.organizationId, directChatId: input.directChatId, limit: input.limit });
        return rows.map((r) => mapMessage(r, viewer.userId));
    }

    async ensureDirectChat(viewer, input) {
        requireVerified(viewer);
        if (input.userId === viewer.userId) {
            const chat = await this.repo.upsertSelfDirectChat({ organizationId: viewer.organizationId, userId: viewer.userId });
            return { id: chat.id, userIds: chat.members.map((m) => m.userId) };
        }
        const me = await prisma.organizationMember.findUnique({
            where: { organizationId_userId: { organizationId: viewer.organizationId, userId: viewer.userId } },
            select: { department: true, role: true },
        });
        const peer = await prisma.organizationMember.findUnique({
            where: { organizationId_userId: { organizationId: viewer.organizationId, userId: input.userId } },
            select: { department: true, role: true },
        });
        if (!peer)
            throw new Error("Пользователь не в организации");
        if (me && isDeptRestrictedRole(me.role)) {
            const ok = await managerCanReachPeer({
                organizationId: viewer.organizationId,
                managerId: viewer.userId,
                managerDept: me.department,
                managerRole: me.role,
                peerId: input.userId,
                peerDept: peer.department,
                peerRole: peer.role,
            });
            if (!ok)
                throw new Error("Менеджер может переписываться только внутри своего отдела или по доступу от администратора");
        }
        const chat = await this.repo.upsertDirectChat({ organizationId: viewer.organizationId, userA: viewer.userId, userB: input.userId });
        return { id: chat.id, userIds: chat.members.map((m) => m.userId) };
    }
    async sendDirectMessage(viewer, input) {
        requireVerified(viewer);
        if (input.userId !== viewer.userId) {
            const me = await prisma.organizationMember.findUnique({
                where: { organizationId_userId: { organizationId: viewer.organizationId, userId: viewer.userId } },
                select: { department: true, role: true },
            });
            const peer = await prisma.organizationMember.findUnique({
                where: { organizationId_userId: { organizationId: viewer.organizationId, userId: input.userId } },
                select: { department: true, role: true },
            });
            if (!peer)
                throw new Error("Пользователь не в организации");
            if (me && isDeptRestrictedRole(me.role)) {
                const ok = await managerCanReachPeer({
                    organizationId: viewer.organizationId,
                    managerId: viewer.userId,
                    managerDept: me.department,
                    managerRole: me.role,
                    peerId: input.userId,
                    peerDept: peer.department,
                    peerRole: peer.role,
                });
                if (!ok)
                    throw new Error("Менеджер может переписываться только внутри своего отдела или по доступу от администратора");
            }
        }
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
        await emitDmToMemberUsers(chat.id, "message:new", msg);
        const peerIds = chat.members.map((m) => m.userId).filter((id) => id !== viewer.userId);
        if (peerIds.length)
            await sendPushToUsers({
                userIds: peerIds,
                title: msg.author?.firstName ? `${msg.author.firstName}` : "Сообщение",
                body: (input.content ?? "").slice(0, 120) || "Новое сообщение",
                data: { kind: "dm", directChatId: chat.id },
            });
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
        const chatRow = await prisma.directChat.findUnique({
            where: { id: input.directChatId },
            include: { members: true },
        });
        if (!chatRow || chatRow.organizationId !== viewer.organizationId)
            throw new Error("Not found");
        const me = await prisma.organizationMember.findUnique({
            where: { organizationId_userId: { organizationId: viewer.organizationId, userId: viewer.userId } },
            select: { department: true, role: true },
        });
        if (me && isDeptRestrictedRole(me.role)) {
            const mmap = await loadMembersMap(viewer.organizationId, chatRow.members.map((m) => m.userId));
            for (const oid of chatRow.members.map((m) => m.userId)) {
                if (oid === viewer.userId)
                    continue;
                const peer = mmap.get(oid);
                if (!peer)
                    continue;
                const ok = await managerCanReachPeer({
                    organizationId: viewer.organizationId,
                    managerId: viewer.userId,
                    managerDept: me.department,
                    managerRole: me.role,
                    peerId: oid,
                    peerDept: peer.department,
                    peerRole: peer.role,
                });
                if (!ok)
                    throw new Error("Менеджер может переписываться только внутри своего отдела или по доступу от администратора");
            }
        }
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
        await emitDmToMemberUsers(input.directChatId, "message:new", msg);
        const peerIds = chatRow.members.map((m) => m.userId).filter((id) => id !== viewer.userId);
        if (peerIds.length)
            await sendPushToUsers({
                userIds: peerIds,
                title: "Файл",
                body: file.originalName ?? "Вложение",
                data: { kind: "dm", directChatId: input.directChatId },
            });
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
        await emitDmToMemberUsers(input.directChatId, "message:update", msg);
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
        await emitDmToMemberUsers(input.directChatId, "message:delete", { id: input.messageId, directChatId: input.directChatId });
        return true;
    }
}
