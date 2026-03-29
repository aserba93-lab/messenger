import { prisma } from "../../db/prisma.js";
export class GroupChatsRepository {
    async listGroupChatsForUser(params) {
        return prisma.groupChat.findMany({
            where: {
                organizationId: params.organizationId,
                members: { some: { userId: params.userId } },
            },
            include: { members: true },
            orderBy: { createdAt: "desc" },
        });
    }
    async createGroupChat(params) {
        return prisma.$transaction(async (tx) => {
            const baseName = String(params.name ?? "").trim() || "Группа";
            let name = baseName;
            let suffix = 1;
            while (await tx.groupChat.findFirst({
                where: { organizationId: params.organizationId, name },
                select: { id: true },
            })) {
                suffix += 1;
                if (suffix > 500)
                    throw new Error("Не удалось подобрать уникальное имя группы");
                name = `${baseName} (${suffix})`;
            }
            const group = await tx.groupChat.create({
                data: {
                    organizationId: params.organizationId,
                    createdByUserId: params.createdByUserId,
                    name,
                },
            });
            const uniqueMemberIds = Array.from(new Set([params.createdByUserId, ...params.memberIds])).slice(0, 200);
            await tx.groupChatMember.createMany({
                data: uniqueMemberIds.map((userId) => ({
                    groupChatId: group.id,
                    userId,
                    role: userId === params.createdByUserId ? "admin" : "member",
                })),
                skipDuplicates: true,
            });
            await tx.auditLog.create({
                data: {
                    organizationId: params.organizationId,
                    actorUserId: params.createdByUserId,
                    action: "GROUPCHAT_CREATED",
                    entityType: "GroupChat",
                    entityId: group.id,
                    metadata: { name: group.name, memberCount: uniqueMemberIds.length },
                },
            });
            const full = await tx.groupChat.findUnique({ where: { id: group.id }, include: { members: true } });
            if (!full)
                throw new Error("Group chat not found after create");
            return full;
        });
    }
    async isGroupMember(params) {
        return prisma.groupChatMember.findUnique({
            where: { groupChatId_userId: { groupChatId: params.groupChatId, userId: params.userId } },
        });
    }
    async getGroupChatById(groupChatId) {
        return prisma.groupChat.findUnique({ where: { id: groupChatId }, include: { members: true } });
    }
    async listGroupMessages(params) {
        return prisma.message.findMany({
            where: {
                organizationId: params.organizationId,
                groupChatId: params.groupChatId,
            },
            orderBy: [{ createdAt: "asc" }, { id: "asc" }],
            take: params.limit,
            include: { author: true, reactions: true },
        });
    }
    async createGroupMessage(params) {
        return prisma.message.create({
            data: {
                organizationId: params.organizationId,
                groupChatId: params.groupChatId,
                authorId: params.authorId,
                content: params.content,
                type: "text",
                parentMessageId: params.parentMessageId ?? null,
            },
            include: { author: true, reactions: true },
        });
    }
    async updateGroupChat(params) {
        const g = await prisma.groupChat.findFirst({
            where: { id: params.groupChatId, organizationId: params.organizationId },
            include: { members: true },
        });
        if (!g)
            throw new Error("Not found");
        const data = {};
        if (params.name !== undefined) {
            const trimmed = String(params.name).trim();
            if (trimmed.length < 1)
                throw new Error("Invalid name");
            if (trimmed !== g.name) {
                const clash = await prisma.groupChat.findFirst({
                    where: { organizationId: params.organizationId, name: trimmed, NOT: { id: g.id } },
                });
                if (clash)
                    throw new Error("Группа с таким именем уже есть");
            }
            data.name = trimmed;
        }
        if (params.avatarUrl !== undefined)
            data.avatarUrl = params.avatarUrl || null;
        return prisma.groupChat.update({ where: { id: g.id }, data, include: { members: true } });
    }
}
