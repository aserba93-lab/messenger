import { prisma } from "../../db/prisma.js";
export class MessagesRepository {
    async getChannelById(channelId) {
        return prisma.channel.findUnique({ where: { id: channelId } });
    }
    async isWorkspaceMember(params) {
        return prisma.workspaceMember.findUnique({
            where: { workspaceId_userId: { workspaceId: params.workspaceId, userId: params.userId } },
        });
    }
    async isChannelMember(params) {
        return prisma.channelMember.findUnique({
            where: { channelId_userId: { channelId: params.channelId, userId: params.userId } },
        });
    }
    async getMessageById(messageId) {
        return prisma.message.findUnique({ where: { id: messageId } });
    }
    async getMessageByIdWithAuthor(messageId) {
        return prisma.message.findUnique({ where: { id: messageId }, include: { author: true, reactions: true } });
    }
    async pinMessage(params) {
        return prisma.messagePin.upsert({
            where: { messageId: params.messageId },
            update: { pinnedByUserId: params.pinnedByUserId, pinnedAt: new Date() },
            create: {
                organizationId: params.organizationId,
                messageId: params.messageId,
                pinnedByUserId: params.pinnedByUserId,
            },
        });
    }
    async unpinMessage(messageId) {
        await prisma.messagePin.delete({ where: { messageId } }).catch(() => null);
    }
    async listPinnedMessageIdsByChannel(params) {
        const pins = await prisma.messagePin.findMany({
            where: { organizationId: params.organizationId, message: { channelId: params.channelId } },
            orderBy: { pinnedAt: "desc" },
            take: params.limit,
            select: { messageId: true },
        });
        return pins.map((p) => p.messageId);
    }
    async saveMessage(params) {
        return prisma.messageSave.upsert({
            where: { userId_messageId: { userId: params.userId, messageId: params.messageId } },
            update: {},
            create: { userId: params.userId, messageId: params.messageId },
        });
    }
    async unsaveMessage(params) {
        await prisma.messageSave.delete({ where: { userId_messageId: { userId: params.userId, messageId: params.messageId } } }).catch(() => null);
    }
    async listSavedMessageIds(params) {
        const rows = await prisma.messageSave.findMany({
            where: { userId: params.userId },
            orderBy: { createdAt: "desc" },
            take: params.limit,
            select: { messageId: true },
        });
        return rows.map((r) => r.messageId);
    }
    async listMessages(params) {
        const take = params.limit + 1;
        const rows = await prisma.message.findMany({
            where: { channelId: params.channelId },
            orderBy: [{ createdAt: "desc" }, { id: "desc" }],
            ...(params.cursor
                ? {
                    cursor: { id: params.cursor },
                    skip: 1,
                }
                : {}),
            take,
            include: {
                author: true,
                reactions: true,
            },
        });
        const hasMore = rows.length > params.limit;
        const items = hasMore ? rows.slice(0, params.limit) : rows;
        const nextCursor = hasMore ? items[items.length - 1]?.id ?? null : null;
        return { items, nextCursor };
    }
    async listThread(params) {
        return prisma.message.findMany({
            where: { parentMessageId: params.parentMessageId },
            orderBy: [{ createdAt: "asc" }, { id: "asc" }],
            take: params.limit,
            include: { author: true, reactions: true },
        });
    }
    async createMessage(params) {
        return prisma.message.create({
            data: {
                organizationId: params.organizationId,
                channelId: params.channelId,
                authorId: params.authorId,
                content: params.content,
                type: (params.type ?? "text"),
                parentMessageId: params.parentMessageId ?? null,
                fileId: params.fileId ?? null,
            },
            include: { author: true, reactions: true },
        });
    }
    async editMessage(params) {
        return prisma.message.update({
            where: { id: params.messageId },
            data: { content: params.content, editedAt: new Date() },
            include: { author: true, reactions: true },
        });
    }
    async softDeleteMessage(params) {
        return prisma.message.update({
            where: { id: params.messageId },
            data: { isDeleted: true, content: "" },
        });
    }
    async toggleReaction(params) {
        return prisma.$transaction(async (tx) => {
            const existing = await tx.reaction.findUnique({
                where: { messageId_userId_emoji: { messageId: params.messageId, userId: params.userId, emoji: params.emoji } },
            });
            if (existing) {
                await tx.reaction.delete({ where: { id: existing.id } });
            }
            else {
                await tx.reaction.create({ data: { messageId: params.messageId, userId: params.userId, emoji: params.emoji } });
            }
            return tx.reaction.findMany({ where: { messageId: params.messageId } });
        });
    }
    async searchChannelMessages(params) {
        const limit = Math.max(1, Math.min(200, params.limit));
        const rows = await prisma.$queryRaw `
      SELECT m.*
      FROM "Message" m
      JOIN "Channel" c ON c.id = m."channelId"
      JOIN "WorkspaceMember" wsm
        ON wsm."workspaceId" = c."workspaceId"
       AND wsm."userId" = ${params.viewerUserId}
      LEFT JOIN "ChannelMember" cm
        ON cm."channelId" = c.id
       AND cm."userId" = ${params.viewerUserId}
      JOIN "User" au ON au.id = m."authorId"
      WHERE
        m."organizationId" = ${params.organizationId}
        AND m."channelId" IS NOT NULL
        AND m."isDeleted" = false
        AND (c."type" <> 'private' OR cm."userId" IS NOT NULL)
        AND (${params.hasFile ? true : false} = false OR m."fileId" IS NOT NULL)
        AND (${params.before ?? null}::timestamp IS NULL OR m."createdAt" < ${params.before ?? null}::timestamp)
        AND (${params.fromEmail ?? null}::text IS NULL OR lower(au.email) = lower(${params.fromEmail ?? null}::text))
        AND (${params.inChannelName ?? null}::text IS NULL OR lower(c.name) = lower(${params.inChannelName ?? null}::text))
        AND to_tsvector('simple', coalesce(m.content, '')) @@ websearch_to_tsquery('simple', ${params.queryText})
      ORDER BY m."createdAt" DESC, m.id DESC
      LIMIT ${limit};
    `;
        return rows;
    }
    async searchAllMessages(params) {
        const limit = Math.max(1, Math.min(200, params.limit));
        const rows = await prisma.$queryRaw `
      (
        SELECT m.*
        FROM "Message" m
        JOIN "Channel" c ON c.id = m."channelId"
        JOIN "WorkspaceMember" wsm
          ON wsm."workspaceId" = c."workspaceId"
         AND wsm."userId" = ${params.viewerUserId}
        LEFT JOIN "ChannelMember" cm
          ON cm."channelId" = c.id
         AND cm."userId" = ${params.viewerUserId}
        JOIN "User" au ON au.id = m."authorId"
        WHERE
          m."organizationId" = ${params.organizationId}
          AND m."channelId" IS NOT NULL
          AND m."isDeleted" = false
          AND (c."type" <> 'private' OR cm."userId" IS NOT NULL)
          AND (${params.hasFile ? true : false} = false OR m."fileId" IS NOT NULL)
          AND (${params.before ?? null}::timestamp IS NULL OR m."createdAt" < ${params.before ?? null}::timestamp)
          AND (${params.fromEmail ?? null}::text IS NULL OR lower(au.email) = lower(${params.fromEmail ?? null}::text))
          AND (${params.inChannelName ?? null}::text IS NULL OR lower(c.name) = lower(${params.inChannelName ?? null}::text))
          AND to_tsvector('simple', coalesce(m.content, '')) @@ websearch_to_tsquery('simple', ${params.queryText})
      )
      UNION ALL
      (
        SELECT m.*
        FROM "Message" m
        JOIN "GroupChatMember" gcm
          ON gcm."groupChatId" = m."groupChatId"
         AND gcm."userId" = ${params.viewerUserId}
        JOIN "User" au ON au.id = m."authorId"
        WHERE
          m."organizationId" = ${params.organizationId}
          AND m."groupChatId" IS NOT NULL
          AND m."isDeleted" = false
          AND (${params.hasFile ? true : false} = false OR m."fileId" IS NOT NULL)
          AND (${params.before ?? null}::timestamp IS NULL OR m."createdAt" < ${params.before ?? null}::timestamp)
          AND (${params.fromEmail ?? null}::text IS NULL OR lower(au.email) = lower(${params.fromEmail ?? null}::text))
          AND to_tsvector('simple', coalesce(m.content, '')) @@ websearch_to_tsquery('simple', ${params.queryText})
      )
      UNION ALL
      (
        SELECT m.*
        FROM "Message" m
        JOIN "DirectChatMember" dcm
          ON dcm."directChatId" = m."directChatId"
         AND dcm."userId" = ${params.viewerUserId}
        JOIN "User" au ON au.id = m."authorId"
        WHERE
          m."organizationId" = ${params.organizationId}
          AND m."directChatId" IS NOT NULL
          AND m."isDeleted" = false
          AND (${params.hasFile ? true : false} = false OR m."fileId" IS NOT NULL)
          AND (${params.before ?? null}::timestamp IS NULL OR m."createdAt" < ${params.before ?? null}::timestamp)
          AND (${params.fromEmail ?? null}::text IS NULL OR lower(au.email) = lower(${params.fromEmail ?? null}::text))
          AND to_tsvector('simple', coalesce(m.content, '')) @@ websearch_to_tsquery('simple', ${params.queryText})
      )
      ORDER BY "createdAt" DESC, id DESC
      LIMIT ${limit};
    `;
        return rows;
    }
}
