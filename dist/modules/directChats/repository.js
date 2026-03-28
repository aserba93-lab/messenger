import { prisma } from "../../db/prisma.js";
export class DirectChatsRepository {
    async listDirectChatsForUser(params) {
        return prisma.directChat.findMany({
            where: {
                organizationId: params.organizationId,
                members: { some: { userId: params.userId } },
            },
            include: { members: true },
            orderBy: { createdAt: "desc" },
        });
    }
    async findDirectChatBetweenUsers(params) {
        // Find chat that has both members.
        return prisma.directChat.findFirst({
            where: {
                organizationId: params.organizationId,
                AND: [
                    { members: { some: { userId: params.userA } } },
                    { members: { some: { userId: params.userB } } },
                ],
            },
            include: { members: true },
            orderBy: { createdAt: "desc" },
        });
    }
    async upsertDirectChat(params) {
        const existing = await this.findDirectChatBetweenUsers(params);
        if (existing)
            return existing;
        return prisma.$transaction(async (tx) => {
            const chat = await tx.directChat.create({
                data: { organizationId: params.organizationId },
            });
            await tx.directChatMember.createMany({
                data: [
                    { directChatId: chat.id, userId: params.userA },
                    { directChatId: chat.id, userId: params.userB },
                ],
                skipDuplicates: true,
            });
            const full = await tx.directChat.findUnique({ where: { id: chat.id }, include: { members: true } });
            if (!full)
                throw new Error("Direct chat not found after create");
            return full;
        });
    }
    async isMember(params) {
        return prisma.directChatMember.findUnique({ where: { directChatId_userId: { directChatId: params.directChatId, userId: params.userId } } });
    }
    async listMessages(params) {
        return prisma.message.findMany({
            where: { organizationId: params.organizationId, directChatId: params.directChatId },
            orderBy: [{ createdAt: "asc" }, { id: "asc" }],
            take: params.limit,
            include: { author: true, reactions: true, file: true },
        });
    }
    async createMessage(params) {
        return prisma.message.create({
            data: {
                organizationId: params.organizationId,
                directChatId: params.directChatId,
                authorId: params.authorId,
                content: params.content,
                type: (params.type ?? "text"),
                fileId: params.fileId ?? null,
                parentMessageId: params.parentMessageId ?? null,
            },
            include: { author: true, reactions: true, file: true },
        });
    }
}
