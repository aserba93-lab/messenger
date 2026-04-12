import { MessagesRepository } from "./repository.js";
import { emitToChannel, emitToRoom, emitDmToMemberUsers } from "../../socket/emitter.js";
import { prisma } from "../../db/prisma.js";
import { env } from "../../config/env.js";
import { NotificationsService } from "../notifications/service.js";
import fs from "node:fs/promises";
import path from "node:path";
function mapReactionsForViewer(reactions, viewerId) {
    const byEmoji = new Map();
    for (const r of reactions) {
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
        groupChatId: row.groupChatId,
        directChatId: row.directChatId,
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
export class MessagesService {
    repo;
    notifications;
    constructor(repo = new MessagesRepository(), notifications = new NotificationsService()) {
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
    requireVerified(viewer) {
        if (!viewer.emailVerified)
            throw new Error("Email not verified");
    }
    requireCanMassMentionInChannel(viewer, content, channel) {
        const hasEveryone = /(^|\s)@everyone(\s|$)/i.test(content);
        const hasChannel = /(^|\s)@channel(\s|$)/i.test(content);
        if (!hasEveryone && !hasChannel)
            return;
        const orgCan = viewer.role === "owner" || viewer.role === "admin" || viewer.role === "manager";
        if (orgCan)
            return;
        // For non-org-admin roles allow only workspace admins
        // (extra lookup is fine for now)
        return this.repo.isWorkspaceMember({ workspaceId: channel.workspaceId, userId: viewer.userId }).then((ws) => {
            if (ws?.role === "admin")
                return;
            throw new Error("Forbidden");
        });
    }
    async requireCanAccessChannel(viewer, channelId) {
        const channel = await this.repo.getChannelById(channelId);
        if (!channel)
            throw new Error("Not found");
        if (channel.organizationId !== viewer.organizationId)
            throw new Error("Forbidden");
        if (channel.isArchived)
            throw new Error("Channel is archived");
        const wsMember = await this.repo.isWorkspaceMember({ workspaceId: channel.workspaceId, userId: viewer.userId });
        if (!wsMember)
            throw new Error("Forbidden");
        if (channel.type === "private") {
            const cm = await this.repo.isChannelMember({ channelId, userId: viewer.userId });
            if (!cm)
                throw new Error("Forbidden");
        }
        return channel;
    }
    async requireCanPostToChannel(viewer, channelId) {
        const channel = await this.requireCanAccessChannel(viewer, channelId);
        if (channel.type === "broadcast") {
            const wsMember = await this.repo.isWorkspaceMember({ workspaceId: channel.workspaceId, userId: viewer.userId });
            const wsIsAdmin = wsMember?.role === "admin";
            const orgCanPost = viewer.role === "owner" || viewer.role === "admin" || viewer.role === "manager";
            if (!wsIsAdmin && !orgCanPost)
                throw new Error("Forbidden");
        }
        return channel;
    }
    async listMessages(viewer, input) {
        await this.requireCanAccessChannel(viewer, input.channelId);
        const { items, nextCursor } = await this.repo.listMessages(input);
        return {
            items: items.map((m) => mapMessage(m, viewer.userId)),
            nextCursor,
        };
    }
    async listThread(viewer, input) {
        const parent = await this.repo.getMessageById(input.parentMessageId);
        if (!parent)
            throw new Error("Not found");
        if (parent.channelId) {
            await this.requireCanAccessChannel(viewer, parent.channelId);
        }
        else if (parent.groupChatId) {
            const m = await prisma.groupChatMember.findUnique({
                where: { groupChatId_userId: { groupChatId: parent.groupChatId, userId: viewer.userId } },
                include: { groupChat: { select: { organizationId: true } } },
            });
            if (!m || m.groupChat.organizationId !== viewer.organizationId)
                throw new Error("Forbidden");
        }
        else if (parent.directChatId) {
            const m = await prisma.directChatMember.findUnique({
                where: { directChatId_userId: { directChatId: parent.directChatId, userId: viewer.userId } },
                include: { directChat: { select: { organizationId: true } } },
            });
            if (!m || m.directChat.organizationId !== viewer.organizationId)
                throw new Error("Forbidden");
        }
        else {
            throw new Error("Not found");
        }
        const rows = await this.repo.listThread(input);
        return rows.map((m) => mapMessage(m, viewer.userId));
    }
    async sendMessage(viewer, input) {
        this.requireVerified(viewer);
        const channel = await this.requireCanPostToChannel(viewer, input.channelId);
        await this.requireCanMassMentionInChannel(viewer, input.content, channel);
        if (input.parentMessageId) {
            const parent = await this.repo.getMessageByIdWithAuthor(input.parentMessageId);
            if (!parent || parent.channelId !== input.channelId)
                throw new Error("Invalid parentMessageId");
        }
        const row = await this.repo.createMessage({
            organizationId: viewer.organizationId,
            channelId: input.channelId,
            authorId: viewer.userId,
            content: input.content,
            parentMessageId: input.parentMessageId,
        });
        const msg = mapMessage(row, viewer.userId);
        emitToChannel(input.channelId, "message:new", msg);
        // Thread reply notification (author of parent message)
        if (input.parentMessageId) {
            const parent = await this.repo.getMessageByIdWithAuthor(input.parentMessageId);
            if (parent?.authorId && parent.authorId !== viewer.userId) {
                const pref = await this.notifications.getPreferenceForUser({
                    organizationId: viewer.organizationId,
                    userId: parent.authorId,
                    channelId: input.channelId,
                });
                if (pref?.mode !== "none") {
                    await this.notifications.createThreadReply({
                        organizationId: viewer.organizationId,
                        notifiedUserId: parent.authorId,
                        actorUserId: viewer.userId,
                        messageId: row.id,
                        parentMessageId: input.parentMessageId,
                        channelId: input.channelId,
                        snippet: input.content.slice(0, 140),
                    });
                }
            }
        }
        // @user mentions by email (MVP)
        const mentioned = this.extractMentionedEmails(input.content);
        if (mentioned.length) {
            const users = await prisma.user.findMany({ where: { email: { in: mentioned } }, select: { id: true, email: true } });
            for (const u of users) {
                if (u.id === viewer.userId)
                    continue;
                // Only notify if user is in org
                const mem = await prisma.organizationMember.findUnique({
                    where: { organizationId_userId: { organizationId: viewer.organizationId, userId: u.id } },
                });
                if (!mem || mem.deactivatedAt)
                    continue;
                const pref = await this.notifications.getPreferenceForUser({
                    organizationId: viewer.organizationId,
                    userId: u.id,
                    channelId: input.channelId,
                });
                if (pref?.mode === "none")
                    continue;
                await this.notifications.createMention({
                    organizationId: viewer.organizationId,
                    mentionedUserId: u.id,
                    actorUserId: viewer.userId,
                    messageId: row.id,
                    channelId: input.channelId,
                    snippet: input.content.slice(0, 140),
                });
            }
        }
        return msg;
    }
    async sendFileMessage(viewer, input) {
        this.requireVerified(viewer);
        await this.requireCanPostToChannel(viewer, input.channelId);
        // Ensure file belongs to org
        const file = await prisma.file.findUnique({ where: { id: input.fileId } });
        if (!file || file.organizationId !== viewer.organizationId)
            throw new Error("File not found");
        if (file.avStatus !== "clean")
            throw new Error("File not available");
        const row = await this.repo.createMessage({
            organizationId: viewer.organizationId,
            channelId: input.channelId,
            authorId: viewer.userId,
            content: file.originalName ?? "",
            type: input.kind,
            fileId: file.id,
        });
        const msg = mapMessage(row, viewer.userId);
        emitToChannel(input.channelId, "message:new", msg);
        return msg;
    }
    async editMessage(viewer, input) {
        const row0 = await this.repo.getMessageById(input.messageId);
        if (!row0 || !row0.channelId)
            throw new Error("Not found");
        const channel = await this.requireCanAccessChannel(viewer, row0.channelId);
        if (row0.authorId !== viewer.userId && viewer.role !== "owner" && viewer.role !== "admin")
            throw new Error("Forbidden");
        if (row0.isDeleted)
            throw new Error("Cannot edit deleted message");
        if (row0.authorId === viewer.userId) {
            const ageMs = Date.now() - new Date(row0.createdAt).getTime();
            if (ageMs > env.MESSAGE_EDIT_WINDOW_SECONDS * 1000) {
                throw new Error("Edit window expired");
            }
        }
        const row = await this.repo.editMessage({ messageId: input.messageId, content: input.content });
        const msg = mapMessage(row, viewer.userId);
        emitToChannel(channel.id, "message:update", msg);
        return msg;
    }
    async deleteMessage(viewer, input) {
        const row0 = await this.repo.getMessageById(input.messageId);
        if (!row0 || !row0.channelId)
            throw new Error("Not found");
        const channel = await this.requireCanAccessChannel(viewer, row0.channelId);
        if (row0.authorId !== viewer.userId && viewer.role !== "owner" && viewer.role !== "admin")
            throw new Error("Forbidden");
        if (row0.isDeleted)
            return true;
        await this.repo.softDeleteMessage({ messageId: input.messageId });
        emitToChannel(channel.id, "message:delete", { id: input.messageId });
        return true;
    }
    async toggleReaction(viewer, input) {
        const msg = await this.repo.getMessageById(input.messageId);
        if (!msg)
            throw new Error("Not found");
        // ACL: must be able to access message container
        if (msg.channelId) {
            await this.requireCanAccessChannel(viewer, msg.channelId);
        }
        else if (msg.groupChatId) {
            const m = await prisma.groupChatMember.findUnique({
                where: { groupChatId_userId: { groupChatId: msg.groupChatId, userId: viewer.userId } },
                include: { groupChat: { select: { organizationId: true } } },
            });
            if (!m || m.groupChat.organizationId !== viewer.organizationId)
                throw new Error("Forbidden");
        }
        else if (msg.directChatId) {
            const m = await prisma.directChatMember.findUnique({
                where: { directChatId_userId: { directChatId: msg.directChatId, userId: viewer.userId } },
                include: { directChat: { select: { organizationId: true } } },
            });
            if (!m || m.directChat.organizationId !== viewer.organizationId)
                throw new Error("Forbidden");
        }
        else {
            throw new Error("Not found");
        }
        const reactions = await this.repo.toggleReaction({ messageId: input.messageId, userId: viewer.userId, emoji: input.emoji });
        const aggregated = mapReactionsForViewer(reactions, viewer.userId);
        if (msg.channelId) {
            emitToChannel(msg.channelId, "reaction:update", { messageId: input.messageId, channelId: msg.channelId, reactions: aggregated });
        }
        else if (msg.groupChatId) {
            emitToRoom(`group:${msg.groupChatId}`, "reaction:update", { messageId: input.messageId, groupChatId: msg.groupChatId, reactions: aggregated });
        }
        else if (msg.directChatId) {
            await emitDmToMemberUsers(msg.directChatId, "reaction:update", { messageId: input.messageId, directChatId: msg.directChatId, reactions: aggregated });
        }
        return aggregated;
    }
    async searchMessages(viewer, input) {
        const raw = String(input.query ?? "").trim();
        if (!raw)
            return [];
        // Parse operators: from:, in:#channel, before:YYYY-MM-DD, has:file
        const tokens = raw.split(/\s+/g);
        let fromEmail = null;
        let inChannelName = null;
        let before = null;
        let hasFile = false;
        const rest = [];
        for (const t of tokens) {
            if (t.startsWith("from:")) {
                fromEmail = t.slice("from:".length) || null;
                continue;
            }
            if (t.startsWith("in:")) {
                const v = t.slice("in:".length);
                inChannelName = v.startsWith("#") ? v.slice(1) : v;
                inChannelName = inChannelName || null;
                continue;
            }
            if (t.startsWith("before:")) {
                const v = t.slice("before:".length);
                const d = new Date(`${v}T00:00:00.000Z`);
                if (!Number.isNaN(d.getTime()))
                    before = d;
                continue;
            }
            if (t === "has:file") {
                hasFile = true;
                continue;
            }
            rest.push(t);
        }
        const queryText = rest.join(" ").trim();
        if (!queryText)
            return [];
        const scopeChannelId = input.scopeChannelId ? String(input.scopeChannelId) : null;
        const scopeGroupChatId = input.scopeGroupChatId ? String(input.scopeGroupChatId) : null;
        const scopeDirectChatId = input.scopeDirectChatId ? String(input.scopeDirectChatId) : null;
        const nScopes = [scopeChannelId, scopeGroupChatId, scopeDirectChatId].filter(Boolean).length;
        if (nScopes > 1)
            throw new Error("Invalid search scope");
        if (scopeChannelId)
            await this.requireCanAccessChannel(viewer, scopeChannelId);
        if (scopeGroupChatId) {
            const m = await prisma.groupChatMember.findUnique({
                where: { groupChatId_userId: { groupChatId: scopeGroupChatId, userId: viewer.userId } },
                include: { groupChat: { select: { organizationId: true } } },
            });
            if (!m || m.groupChat.organizationId !== viewer.organizationId)
                throw new Error("Forbidden");
        }
        if (scopeDirectChatId) {
            const m = await prisma.directChatMember.findUnique({
                where: { directChatId_userId: { directChatId: scopeDirectChatId, userId: viewer.userId } },
                include: { directChat: { select: { organizationId: true } } },
            });
            if (!m || m.directChat.organizationId !== viewer.organizationId)
                throw new Error("Forbidden");
        }
        const rows = await this.repo.searchAllMessages({
            organizationId: viewer.organizationId,
            viewerUserId: viewer.userId,
            queryText,
            fromEmail,
            inChannelName,
            before,
            hasFile,
            limit: input.limit,
            scopeChannelId,
            scopeGroupChatId,
            scopeDirectChatId,
        });
        // Hydrate with author/reactions for GraphQL Message type mapping
        const ids = rows.map((r) => r.id);
        const hydrated = await Promise.all(ids.map((id) => this.repo.getMessageByIdWithAuthor(id)));
        const byId = new Map();
        for (const h of hydrated)
            if (h)
                byId.set(h.id, h);
        return ids.map((id) => byId.get(id)).filter(Boolean).map((m) => mapMessage(m, viewer.userId));
    }
    async pinMessage(viewer, input) {
        this.requireVerified(viewer);
        const msg = await this.repo.getMessageById(input.messageId);
        if (!msg)
            throw new Error("Not found");
        if (msg.channelId) {
            await this.requireCanAccessChannel(viewer, msg.channelId);
        }
        else if (msg.groupChatId) {
            const m = await prisma.groupChatMember.findUnique({
                where: { groupChatId_userId: { groupChatId: msg.groupChatId, userId: viewer.userId } },
                include: { groupChat: { select: { organizationId: true } } },
            });
            if (!m || m.groupChat.organizationId !== viewer.organizationId)
                throw new Error("Forbidden");
        }
        else if (msg.directChatId) {
            const m = await prisma.directChatMember.findUnique({
                where: { directChatId_userId: { directChatId: msg.directChatId, userId: viewer.userId } },
                include: { directChat: { select: { organizationId: true } } },
            });
            if (!m || m.directChat.organizationId !== viewer.organizationId)
                throw new Error("Forbidden");
        }
        else {
            throw new Error("Not found");
        }
        await this.repo.pinMessage({ organizationId: viewer.organizationId, messageId: input.messageId, pinnedByUserId: viewer.userId });
        return true;
    }
    async unpinMessage(viewer, input) {
        this.requireVerified(viewer);
        const msg = await this.repo.getMessageById(input.messageId);
        if (!msg)
            throw new Error("Not found");
        if (msg.channelId) {
            await this.requireCanAccessChannel(viewer, msg.channelId);
        }
        else if (msg.groupChatId) {
            const m = await prisma.groupChatMember.findUnique({
                where: { groupChatId_userId: { groupChatId: msg.groupChatId, userId: viewer.userId } },
                include: { groupChat: { select: { organizationId: true } } },
            });
            if (!m || m.groupChat.organizationId !== viewer.organizationId)
                throw new Error("Forbidden");
        }
        else if (msg.directChatId) {
            const m = await prisma.directChatMember.findUnique({
                where: { directChatId_userId: { directChatId: msg.directChatId, userId: viewer.userId } },
                include: { directChat: { select: { organizationId: true } } },
            });
            if (!m || m.directChat.organizationId !== viewer.organizationId)
                throw new Error("Forbidden");
        }
        else {
            throw new Error("Not found");
        }
        await this.repo.unpinMessage(input.messageId);
        return true;
    }
    async pinnedMessages(viewer, input) {
        const limit = Math.min(Math.max(Number(input.limit ?? 10), 1), 50);
        const channelId = input.channelId ?? null;
        const groupChatId = input.groupChatId ?? null;
        const directChatId = input.directChatId ?? null;
        const n = (channelId ? 1 : 0) + (groupChatId ? 1 : 0) + (directChatId ? 1 : 0);
        if (n !== 1)
            throw new Error("Specify exactly one of channelId, groupChatId, directChatId");
        let ids;
        if (channelId) {
            await this.requireCanAccessChannel(viewer, channelId);
            ids = await this.repo.listPinnedMessageIdsByChannel({
                organizationId: viewer.organizationId,
                channelId,
                limit,
            });
        }
        else if (groupChatId) {
            const m = await prisma.groupChatMember.findUnique({
                where: { groupChatId_userId: { groupChatId, userId: viewer.userId } },
                include: { groupChat: { select: { organizationId: true } } },
            });
            if (!m || m.groupChat.organizationId !== viewer.organizationId)
                throw new Error("Forbidden");
            ids = await this.repo.listPinnedMessageIdsByGroupChat({
                organizationId: viewer.organizationId,
                groupChatId,
                limit,
            });
        }
        else {
            const m = await prisma.directChatMember.findUnique({
                where: { directChatId_userId: { directChatId, userId: viewer.userId } },
                include: { directChat: { select: { organizationId: true } } },
            });
            if (!m || m.directChat.organizationId !== viewer.organizationId)
                throw new Error("Forbidden");
            ids = await this.repo.listPinnedMessageIdsByDirectChat({
                organizationId: viewer.organizationId,
                directChatId,
                limit,
            });
        }
        const rows = await Promise.all(ids.map((id) => this.repo.getMessageByIdWithAuthor(id)));
        return rows.filter(Boolean).map((m) => mapMessage(m, viewer.userId));
    }
    async saveMessage(viewer, messageId) {
        this.requireVerified(viewer);
        const msg = await this.repo.getMessageById(messageId);
        if (!msg)
            throw new Error("Not found");
        if (msg.channelId) {
            await this.requireCanAccessChannel(viewer, msg.channelId);
        }
        else if (msg.groupChatId) {
            const m = await prisma.groupChatMember.findUnique({
                where: { groupChatId_userId: { groupChatId: msg.groupChatId, userId: viewer.userId } },
                include: { groupChat: { select: { organizationId: true } } },
            });
            if (!m || m.groupChat.organizationId !== viewer.organizationId)
                throw new Error("Forbidden");
        }
        else if (msg.directChatId) {
            const m = await prisma.directChatMember.findUnique({
                where: { directChatId_userId: { directChatId: msg.directChatId, userId: viewer.userId } },
                include: { directChat: { select: { organizationId: true } } },
            });
            if (!m || m.directChat.organizationId !== viewer.organizationId)
                throw new Error("Forbidden");
        }
        else {
            throw new Error("Not found");
        }
        await this.repo.saveMessage({ userId: viewer.userId, messageId });
        return true;
    }
    async unsaveMessage(viewer, messageId) {
        this.requireVerified(viewer);
        await this.repo.unsaveMessage({ userId: viewer.userId, messageId });
        return true;
    }
    async savedMessages(viewer, input) {
        const ids = await this.repo.listSavedMessageIds({ userId: viewer.userId, limit: input.limit });
        const rows = await Promise.all(ids.map((id) => this.repo.getMessageByIdWithAuthor(id)));
        const out = [];
        for (const row of rows) {
            if (!row)
                continue;
            try {
                if (row.channelId) {
                    await this.requireCanAccessChannel(viewer, row.channelId);
                }
                else if (row.groupChatId) {
                    const m = await prisma.groupChatMember.findUnique({
                        where: { groupChatId_userId: { groupChatId: row.groupChatId, userId: viewer.userId } },
                        include: { groupChat: { select: { organizationId: true } } },
                    });
                    if (!m || m.groupChat.organizationId !== viewer.organizationId)
                        continue;
                }
                else if (row.directChatId) {
                    const m = await prisma.directChatMember.findUnique({
                        where: { directChatId_userId: { directChatId: row.directChatId, userId: viewer.userId } },
                        include: { directChat: { select: { organizationId: true } } },
                    });
                    if (!m || m.directChat.organizationId !== viewer.organizationId)
                        continue;
                }
                else {
                    continue;
                }
                out.push(mapMessage(row, viewer.userId));
            }
            catch {
                // skip inaccessible
            }
        }
        return out;
    }

    async savedMessageIds(viewer, input) {
        const limit = Math.max(1, Math.min(500, Number(input.limit ?? 200)));
        return this.repo.listSavedMessageIds({ userId: viewer.userId, limit });
    }
    async forwardMessages(viewer, input) {
        this.requireVerified(viewer);
        const targetChannelId = input.channelId ?? null;
        const targetGroupChatId = input.groupChatId ?? null;
        const targetDirectChatId = input.directChatId ?? null;
        const targets = [!!targetChannelId, !!targetGroupChatId, !!targetDirectChatId].filter(Boolean).length;
        if (targets !== 1)
            throw new Error("Specify exactly one target: channelId | groupChatId | directChatId");
        const channel = targetChannelId ? await this.requireCanPostToChannel(viewer, targetChannelId) : null;
        if (targetGroupChatId) {
            const m = await prisma.groupChatMember.findUnique({
                where: { groupChatId_userId: { groupChatId: targetGroupChatId, userId: viewer.userId } },
                include: { groupChat: { select: { organizationId: true } } },
            });
            if (!m || m.groupChat.organizationId !== viewer.organizationId)
                throw new Error("Forbidden");
        }
        if (targetDirectChatId) {
            const m = await prisma.directChatMember.findUnique({
                where: { directChatId_userId: { directChatId: targetDirectChatId, userId: viewer.userId } },
                include: { directChat: { select: { organizationId: true } } },
            });
            if (!m || m.directChat.organizationId !== viewer.organizationId)
                throw new Error("Forbidden");
        }
        for (const messageId of input.messageIds.slice(0, 50)) {
            const src = await this.repo.getMessageByIdWithAuthor(messageId);
            if (!src)
                continue;
            if (src.isDeleted)
                continue;
            // Verify viewer can read source container
            if (src.channelId) {
                await this.requireCanAccessChannel(viewer, src.channelId);
            }
            else if (src.groupChatId) {
                const m = await prisma.groupChatMember.findUnique({
                    where: { groupChatId_userId: { groupChatId: src.groupChatId, userId: viewer.userId } },
                    include: { groupChat: { select: { organizationId: true } } },
                });
                if (!m || m.groupChat.organizationId !== viewer.organizationId)
                    throw new Error("Forbidden");
            }
            else if (src.directChatId) {
                const m = await prisma.directChatMember.findUnique({
                    where: { directChatId_userId: { directChatId: src.directChatId, userId: viewer.userId } },
                    include: { directChat: { select: { organizationId: true } } },
                });
                if (!m || m.directChat.organizationId !== viewer.organizationId)
                    throw new Error("Forbidden");
            }
            else {
                continue;
            }
            const isFileLike = (src.type === "file" || src.type === "voice") && !!src.fileId;
            let forwardType = "text";
            let forwardContent = "";
            let forwardFileId = null;
            if (isFileLike) {
                const file = await prisma.file.findUnique({ where: { id: src.fileId } });
                if (!file || file.organizationId !== viewer.organizationId)
                    throw new Error("File not found");
                if (file.avStatus !== "clean")
                    throw new Error("File not available");
                forwardType = src.type;
                forwardFileId = file.id;
                forwardContent = (src.content ?? file.originalName ?? "").slice(0, 4000);
            }
            else {
                const prefix = input.hideAuthor ? "FWD: " : `FWD from ${src.author.email}: `;
                forwardType = "text";
                forwardContent = `${prefix}${src.content ?? ""}`.slice(0, 4000);
            }

            if (channel) {
                const row = await this.repo.createMessage({
                    organizationId: viewer.organizationId,
                    channelId: channel.id,
                    authorId: viewer.userId,
                    content: forwardContent,
                    type: forwardType,
                    fileId: forwardFileId ?? undefined,
                });
                emitToChannel(channel.id, "message:new", mapMessage(row, viewer.userId));
                continue;
            }
            if (targetGroupChatId) {
                const row = await prisma.message.create({
                    data: {
                        organizationId: viewer.organizationId,
                        groupChatId: targetGroupChatId,
                        authorId: viewer.userId,
                        content: forwardContent,
                        type: forwardType,
                        fileId: forwardFileId,
                    },
                    include: { author: true, reactions: true },
                });
                emitToRoom(`group:${targetGroupChatId}`, "message:new", { ...mapMessage(row, viewer.userId), groupChatId: targetGroupChatId });
                continue;
            }
            if (targetDirectChatId) {
                const row = await prisma.message.create({
                    data: {
                        organizationId: viewer.organizationId,
                        directChatId: targetDirectChatId,
                        authorId: viewer.userId,
                        content: forwardContent,
                        type: forwardType,
                        fileId: forwardFileId,
                    },
                    include: { author: true, reactions: true },
                });
                await emitDmToMemberUsers(targetDirectChatId, "message:new", mapMessage(row, viewer.userId));
            }
        }
        return true;
    }
    async requireCanAccessMessageThread(viewer, msg) {
        if (msg.channelId) {
            await this.requireCanAccessChannel(viewer, msg.channelId);
            return;
        }
        if (msg.groupChatId) {
            const m = await prisma.groupChatMember.findUnique({
                where: { groupChatId_userId: { groupChatId: msg.groupChatId, userId: viewer.userId } },
                include: { groupChat: { select: { organizationId: true } } },
            });
            if (!m || m.groupChat.organizationId !== viewer.organizationId)
                throw new Error("Forbidden");
            return;
        }
        if (msg.directChatId) {
            const m = await prisma.directChatMember.findUnique({
                where: { directChatId_userId: { directChatId: msg.directChatId, userId: viewer.userId } },
                include: { directChat: { select: { organizationId: true } } },
            });
            if (!m || m.directChat.organizationId !== viewer.organizationId)
                throw new Error("Forbidden");
            return;
        }
        throw new Error("Not found");
    }
    async mapUsersForOrg(users, organizationId) {
        if (!users.length)
            return [];
        return Promise.all(users.map(async (u) => {
            const org = await prisma.organizationMember.findUnique({
                where: { organizationId_userId: { organizationId, userId: u.id } },
                select: { role: true, department: true, title: true, status: true },
            });
            return {
                id: u.id,
                email: u.email,
                firstName: u.firstName,
                lastName: u.lastName,
                middleName: u.middleName,
                birthDate: u.birthDate,
                avatarUrl: u.avatarUrl,
                phone: null,
                status: u.status ?? org?.status ?? "offline",
                statusEmoji: null,
                statusText: null,
                title: org?.title ?? null,
                department: org?.department ?? null,
                role: (org?.role ?? "employee"),
                lastSeen: u.lastSeen,
            };
        }));
    }
    async markThreadRead(viewer, input) {
        const channelId = input.channelId ? String(input.channelId) : null;
        const groupChatId = input.groupChatId ? String(input.groupChatId) : null;
        const directChatId = input.directChatId ? String(input.directChatId) : null;
        const n = [channelId, groupChatId, directChatId].filter(Boolean).length;
        if (n !== 1)
            throw new Error("Specify exactly one of channelId, groupChatId, directChatId");
        const threadKey = channelId ? `c:${channelId}` : groupChatId ? `g:${groupChatId}` : `d:${directChatId}`;
        if (channelId)
            await this.requireCanAccessChannel(viewer, channelId);
        if (groupChatId) {
            const m = await prisma.groupChatMember.findUnique({
                where: { groupChatId_userId: { groupChatId, userId: viewer.userId } },
                include: { groupChat: { select: { organizationId: true } } },
            });
            if (!m || m.groupChat.organizationId !== viewer.organizationId)
                throw new Error("Forbidden");
        }
        if (directChatId) {
            const m = await prisma.directChatMember.findUnique({
                where: { directChatId_userId: { directChatId, userId: viewer.userId } },
                include: { directChat: { select: { organizationId: true } } },
            });
            if (!m || m.directChat.organizationId !== viewer.organizationId)
                throw new Error("Forbidden");
        }
        const row = await this.repo.upsertThreadRead({
            organizationId: viewer.organizationId,
            userId: viewer.userId,
            threadKey,
            lastReadAt: new Date(),
        });
        const payload = {
            channelId,
            groupChatId,
            directChatId,
            readerUserId: viewer.userId,
            lastReadAt: row.lastReadAt.toISOString(),
        };
        if (channelId)
            emitToChannel(channelId, "thread:read", payload);
        else if (groupChatId)
            emitToRoom(`group:${groupChatId}`, "thread:read", payload);
        else if (directChatId)
            await emitDmToMemberUsers(directChatId, "thread:read", payload);
        return true;
    }
    async threadReadStates(viewer, input) {
        const channelId = input.channelId ? String(input.channelId) : null;
        const groupChatId = input.groupChatId ? String(input.groupChatId) : null;
        const directChatId = input.directChatId ? String(input.directChatId) : null;
        const n = [channelId, groupChatId, directChatId].filter(Boolean).length;
        if (n !== 1)
            throw new Error("Specify exactly one of channelId, groupChatId, directChatId");
        const threadKey = channelId ? `c:${channelId}` : groupChatId ? `g:${groupChatId}` : `d:${directChatId}`;
        if (channelId)
            await this.requireCanAccessChannel(viewer, channelId);
        if (groupChatId) {
            const m = await prisma.groupChatMember.findUnique({
                where: { groupChatId_userId: { groupChatId, userId: viewer.userId } },
                include: { groupChat: { select: { organizationId: true } } },
            });
            if (!m || m.groupChat.organizationId !== viewer.organizationId)
                throw new Error("Forbidden");
        }
        if (directChatId) {
            const m = await prisma.directChatMember.findUnique({
                where: { directChatId_userId: { directChatId, userId: viewer.userId } },
                include: { directChat: { select: { organizationId: true } } },
            });
            if (!m || m.directChat.organizationId !== viewer.organizationId)
                throw new Error("Forbidden");
        }
        return this.repo.listThreadReadStatesByThreadKey(threadKey);
    }
    async messageReaders(viewer, messageId) {
        const msg = await this.repo.getMessageById(messageId);
        if (!msg)
            throw new Error("Not found");
        if (msg.authorId !== viewer.userId)
            return [];
        await this.requireCanAccessMessageThread(viewer, msg);
        const users = await this.repo.listUsersWhoReadMessage(messageId);
        return await this.mapUsersForOrg(users, viewer.organizationId);
    }
    /**
     * Транскрипция голосового файла через OpenAI Whisper (ключ OPENAI_API_KEY на сервере).
     */
    async transcribeVoiceMessage(viewer, messageId) {
        const id = String(messageId ?? "").trim();
        if (!id)
            throw new Error("messageId required");
        const msg = await prisma.message.findUnique({
            where: { id },
            include: { file: true },
        });
        if (!msg || msg.organizationId !== viewer.organizationId)
            throw new Error("Not found");
        if (msg.type !== "voice")
            throw new Error("Это не голосовое сообщение");
        if (!msg.fileId || !msg.file)
            throw new Error("Файл недоступен");
        await this.requireCanAccessMessageThread(viewer, msg);
        const av = String(msg.file.avStatus ?? "");
        if (av !== "clean")
            throw new Error("Дождитесь проверки файла антивирусом");
        const url = String(msg.file.url ?? "");
        if (!url.startsWith("/files/local/"))
            throw new Error("Транскрипция поддерживается только для файлов в локальном хранилище сервера");
        const diskPath = path.resolve(process.cwd(), ".local_uploads", msg.fileId);
        let buf;
        try {
            buf = await fs.readFile(diskPath);
        }
        catch {
            throw new Error("Не удалось прочитать аудиофайл на сервере");
        }
        const apiKey = String(process.env.OPENAI_API_KEY ?? "").trim();
        if (!apiKey)
            throw new Error("Транскрипция не настроена: задайте переменную окружения OPENAI_API_KEY на сервере (OpenAI API).");
        const mime = String(msg.file.mimeType || "audio/webm");
        const fname = String(msg.file.originalName || "voice.webm").replace(/[^\w.\-()+]/g, "_") || "voice.webm";
        const form = new FormData();
        form.append("file", new Blob([buf], { type: mime }), fname);
        form.append("model", "whisper-1");
        form.append("language", "ru");
        const r = await fetch("https://api.openai.com/v1/audio/transcriptions", {
            method: "POST",
            headers: { Authorization: `Bearer ${apiKey}` },
            body: form,
        });
        if (!r.ok) {
            const t = await r.text();
            throw new Error(`Транскрипция: ${t.slice(0, 280)}`);
        }
        const j = (await r.json());
        const text = typeof j.text === "string" ? j.text : "";
        if (!text.trim())
            throw new Error("Пустой результат распознавания");
        return text.trim();
    }
}
