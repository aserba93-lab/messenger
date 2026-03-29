import { prisma } from "../../db/prisma.js";
export class ChannelsRepository {
    async getChannelById(channelId) {
        return prisma.channel.findUnique({ where: { id: channelId } });
    }
    async getWorkspaceById(workspaceId) {
        return prisma.workspace.findUnique({ where: { id: workspaceId } });
    }
    async listChannelsForViewer(params) {
        // Accessible:
        // - public channels for any workspace member
        // - broadcast channels for any workspace member
        // - private channels only for channel members
        return prisma.channel.findMany({
            where: {
                workspaceId: params.workspaceId,
                isArchived: false,
                OR: [
                    { type: "public" },
                    { type: "broadcast" },
                    { type: "private", members: { some: { userId: params.userId } } },
                ],
            },
            orderBy: { createdAt: "desc" },
        });
    }
    async createChannel(params) {
        return prisma.$transaction(async (tx) => {
            const channel = await tx.channel.create({
                data: {
                    organizationId: params.organizationId,
                    workspaceId: params.workspaceId,
                    name: params.name,
                    type: params.type,
                    description: params.description ?? null,
                    isSystem: params.isSystem ?? false,
                    createdByUserId: params.createdByUserId,
                },
            });
            if (params.type === "private") {
                await tx.channelMember.create({
                    data: { channelId: channel.id, userId: params.createdByUserId },
                });
            }
            await tx.auditLog.create({
                data: {
                    organizationId: params.organizationId,
                    actorUserId: params.createdByUserId,
                    action: "CHANNEL_CREATED",
                    entityType: "Channel",
                    entityId: channel.id,
                    metadata: { name: params.name, type: params.type, isSystem: params.isSystem ?? false },
                },
            });
            return channel;
        });
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
    async listChannelMembers(params) {
        const members = await prisma.channelMember.findMany({
            where: { channelId: params.channelId },
            include: { user: true },
        });
        const ids = members.map((m) => m.userId);
        const orgMembers = await prisma.organizationMember.findMany({
            where: { organizationId: params.organizationId, userId: { in: ids } },
            select: { userId: true, role: true, department: true, title: true, status: true },
        });
        const orgByUserId = new Map(orgMembers.map((m) => [m.userId, m]));
        return members.map((m) => {
            const org = orgByUserId.get(m.userId);
            return {
                id: m.user.id,
                email: m.user.email,
                firstName: m.user.firstName,
                lastName: m.user.lastName,
                avatarUrl: m.user.avatarUrl,
                status: (org?.status ?? m.user.status),
                title: org?.title ?? null,
                department: org?.department ?? null,
                role: (org?.role ?? "employee"),
                lastSeen: m.user.lastSeen,
            };
        });
    }
    async addChannelMember(params) {
        return prisma.$transaction(async (tx) => {
            const channel = await tx.channel.findUnique({ where: { id: params.channelId } });
            if (!channel)
                throw new Error("Channel not found");
            if (channel.organizationId !== params.organizationId || channel.workspaceId !== params.workspaceId)
                throw new Error("Forbidden");
            if (channel.isArchived)
                throw new Error("Channel is archived");
            if (channel.type !== "private")
                throw new Error("Cannot add members to public channel");
            const actorWorkspaceMember = await tx.workspaceMember.findUnique({
                where: { workspaceId_userId: { workspaceId: params.workspaceId, userId: params.actorUserId } },
            });
            if (!actorWorkspaceMember || actorWorkspaceMember.role !== "admin")
                throw new Error("Forbidden");
            const targetWorkspaceMember = await tx.workspaceMember.findUnique({
                where: { workspaceId_userId: { workspaceId: params.workspaceId, userId: params.userId } },
            });
            if (!targetWorkspaceMember)
                throw new Error("User must be workspace member");
            const upserted = await tx.channelMember.upsert({
                where: { channelId_userId: { channelId: params.channelId, userId: params.userId } },
                update: {},
                create: { channelId: params.channelId, userId: params.userId },
            });
            await tx.auditLog.create({
                data: {
                    organizationId: params.organizationId,
                    actorUserId: params.actorUserId,
                    action: "CHANNEL_MEMBER_ADDED",
                    entityType: "ChannelMember",
                    entityId: `${params.channelId}:${params.userId}`,
                },
            });
            return upserted;
        });
    }
    async removeChannelMember(params) {
        return prisma.$transaction(async (tx) => {
            const channel = await tx.channel.findUnique({ where: { id: params.channelId } });
            if (!channel)
                throw new Error("Channel not found");
            if (channel.organizationId !== params.organizationId || channel.workspaceId !== params.workspaceId)
                throw new Error("Forbidden");
            if (channel.isArchived)
                throw new Error("Channel is archived");
            if (channel.type !== "private")
                throw new Error("Cannot remove members from public channel");
            const actorWorkspaceMember = await tx.workspaceMember.findUnique({
                where: { workspaceId_userId: { workspaceId: params.workspaceId, userId: params.actorUserId } },
            });
            if (!actorWorkspaceMember || actorWorkspaceMember.role !== "admin")
                throw new Error("Forbidden");
            if (params.userId === params.actorUserId) {
                // Allow removing yourself as participant, but prevent locking everyone out is out of scope.
            }
            await tx.channelMember.delete({
                where: { channelId_userId: { channelId: params.channelId, userId: params.userId } },
            });
            await tx.auditLog.create({
                data: {
                    organizationId: params.organizationId,
                    actorUserId: params.actorUserId,
                    action: "CHANNEL_MEMBER_REMOVED",
                    entityType: "ChannelMember",
                    entityId: `${params.channelId}:${params.userId}`,
                },
            });
        });
    }
    async archiveChannel(params) {
        return prisma.$transaction(async (tx) => {
            const channel = await tx.channel.findUnique({ where: { id: params.channelId } });
            if (!channel)
                throw new Error("Channel not found");
            if (channel.organizationId !== params.organizationId || channel.workspaceId !== params.workspaceId)
                throw new Error("Forbidden");
            const actorWorkspaceMember = await tx.workspaceMember.findUnique({
                where: { workspaceId_userId: { workspaceId: params.workspaceId, userId: params.actorUserId } },
            });
            if (!actorWorkspaceMember || actorWorkspaceMember.role !== "admin")
                throw new Error("Forbidden");
            const updated = await tx.channel.update({
                where: { id: params.channelId },
                data: { isArchived: true },
            });
            await tx.auditLog.create({
                data: {
                    organizationId: params.organizationId,
                    actorUserId: params.actorUserId,
                    action: "CHANNEL_ARCHIVED",
                    entityType: "Channel",
                    entityId: updated.id,
                },
            });
            return updated;
        });
    }
    async deleteChannel(params) {
        return prisma.$transaction(async (tx) => {
            const channel = await tx.channel.findUnique({ where: { id: params.channelId } });
            if (!channel)
                throw new Error("Channel not found");
            if (channel.organizationId !== params.organizationId || channel.workspaceId !== params.workspaceId)
                throw new Error("Forbidden");
            const actorWorkspaceMember = await tx.workspaceMember.findUnique({
                where: { workspaceId_userId: { workspaceId: params.workspaceId, userId: params.actorUserId } },
            });
            if (!actorWorkspaceMember || actorWorkspaceMember.role !== "admin")
                throw new Error("Forbidden");
            const deleted = await tx.channel.delete({ where: { id: params.channelId } });
            await tx.auditLog.create({
                data: {
                    organizationId: params.organizationId,
                    actorUserId: params.actorUserId,
                    action: "CHANNEL_DELETED",
                    entityType: "Channel",
                    entityId: deleted.id,
                    metadata: { name: deleted.name },
                },
            });
            return deleted;
        });
    }
    async updateChannelFields(params) {
        const data = {};
        if (params.name !== undefined)
            data.name = String(params.name).trim();
        if (params.avatarUrl !== undefined)
            data.avatarUrl = params.avatarUrl || null;
        return prisma.channel.update({ where: { id: params.channelId }, data });
    }
}
