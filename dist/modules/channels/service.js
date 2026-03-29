import { prisma } from "../../db/prisma.js";
import { ChannelsRepository } from "./repository.js";
import { NotificationsService } from "../notifications/service.js";
export class ChannelsService {
    repo;
    notifications;
    constructor(repo = new ChannelsRepository(), notifications = new NotificationsService()) {
        this.repo = repo;
        this.notifications = notifications;
    }
    requireVerified(viewer) {
        if (!viewer.emailVerified)
            throw new Error("Email not verified");
    }
    async listChannels(viewer, input) {
        const workspace = await this.repo.getWorkspaceById(input.workspaceId);
        if (!workspace || workspace.organizationId !== viewer.organizationId)
            throw new Error("Forbidden");
        // ACL: viewer must be workspace member
        const wsMember = await this.repo.isWorkspaceMember({ workspaceId: input.workspaceId, userId: viewer.userId });
        if (!wsMember)
            throw new Error("Forbidden");
        const channels = await this.repo.listChannelsForViewer({ workspaceId: input.workspaceId, userId: viewer.userId });
        return channels.map((c) => ({
            id: c.id,
            workspaceId: c.workspaceId,
            name: c.name,
            type: c.type,
            description: c.description ?? null,
            avatarUrl: c.avatarUrl ?? null,
            createdByUserId: c.createdByUserId,
            isSystem: c.isSystem,
            isArchived: c.isArchived,
            createdAt: c.createdAt,
        }));
    }
    async createChannel(viewer, input) {
        this.requireVerified(viewer);
        const workspace = await this.repo.getWorkspaceById(input.workspaceId);
        if (!workspace || workspace.organizationId !== viewer.organizationId)
            throw new Error("Forbidden");
        const wsMember = await this.repo.isWorkspaceMember({ workspaceId: input.workspaceId, userId: viewer.userId });
        const isOrgAdmin = viewer.role === "owner" || viewer.role === "admin";
        if ((!wsMember || wsMember.role !== "admin") && !isOrgAdmin)
            throw new Error("Forbidden");
        const channel = await this.repo.createChannel({
            organizationId: viewer.organizationId,
            workspaceId: input.workspaceId,
            name: input.name,
            type: input.type,
            description: input.description ?? null,
            createdByUserId: viewer.userId,
        });
        return {
            id: channel.id,
            workspaceId: channel.workspaceId,
            name: channel.name,
            type: channel.type,
            description: channel.description ?? null,
            avatarUrl: channel.avatarUrl ?? null,
            createdByUserId: channel.createdByUserId,
            isSystem: channel.isSystem,
            isArchived: channel.isArchived,
            createdAt: channel.createdAt,
        };
    }
    async updateChannel(viewer, input) {
        this.requireVerified(viewer);
        const channel = await this.repo.getChannelById(input.channelId);
        if (!channel || channel.organizationId !== viewer.organizationId)
            throw new Error("Not found");
        const wsMember = await this.repo.isWorkspaceMember({ workspaceId: channel.workspaceId, userId: viewer.userId });
        const isOrgAdmin = viewer.role === "owner" || viewer.role === "admin";
        if (!wsMember && !isOrgAdmin)
            throw new Error("Forbidden");
        if (channel.type === "private" && !isOrgAdmin) {
            const inChannel = await this.repo.isChannelMember({ channelId: channel.id, userId: viewer.userId });
            if (!inChannel)
                throw new Error("Forbidden");
        }
        const isCreator = channel.createdByUserId === viewer.userId;
        if (!isCreator && !isOrgAdmin)
            throw new Error("Forbidden");
        if (input.name !== undefined && input.name.trim() !== channel.name) {
            const clash = await prisma.channel.findFirst({
                where: {
                    workspaceId: channel.workspaceId,
                    name: input.name.trim(),
                    id: { not: channel.id },
                },
                select: { id: true },
            });
            if (clash)
                throw new Error("Channel name already exists in workspace");
        }
        const updated = await this.repo.updateChannelFields({
            channelId: channel.id,
            name: input.name,
            avatarUrl: input.avatarUrl,
        });
        return {
            id: updated.id,
            workspaceId: updated.workspaceId,
            name: updated.name,
            type: updated.type,
            description: updated.description ?? null,
            avatarUrl: updated.avatarUrl ?? null,
            createdByUserId: updated.createdByUserId,
            isSystem: updated.isSystem,
            isArchived: updated.isArchived,
            createdAt: updated.createdAt,
        };
    }
    async addChannelMember(viewer, input) {
        const channel = await this.repo.getChannelById(input.channelId);
        if (!channel)
            throw new Error("Not found");
        if (channel.organizationId !== viewer.organizationId)
            throw new Error("Forbidden");
        const wsMember = await this.repo.isWorkspaceMember({ workspaceId: channel.workspaceId, userId: viewer.userId });
        if (!wsMember || wsMember.role !== "admin")
            throw new Error("Forbidden");
        await this.repo.addChannelMember({
            channelId: input.channelId,
            workspaceId: channel.workspaceId,
            organizationId: viewer.organizationId,
            actorUserId: viewer.userId,
            userId: input.userId,
        });
        if (input.userId !== viewer.userId) {
            await this.notifications.createSystem({
                organizationId: viewer.organizationId,
                userId: input.userId,
                type: "channel:added",
                payload: { channelId: input.channelId, workspaceId: channel.workspaceId, addedByUserId: viewer.userId },
                channelId: input.channelId,
            });
        }
        return true;
    }
    async removeChannelMember(viewer, input) {
        const channel = await this.repo.getChannelById(input.channelId);
        if (!channel)
            throw new Error("Not found");
        if (channel.organizationId !== viewer.organizationId)
            throw new Error("Forbidden");
        const wsMember = await this.repo.isWorkspaceMember({ workspaceId: channel.workspaceId, userId: viewer.userId });
        if (!wsMember || wsMember.role !== "admin")
            throw new Error("Forbidden");
        await this.repo.removeChannelMember({
            channelId: input.channelId,
            workspaceId: channel.workspaceId,
            organizationId: viewer.organizationId,
            actorUserId: viewer.userId,
            userId: input.userId,
        });
        return true;
    }
    async archiveChannel(viewer, input) {
        const channel = await this.repo.getChannelById(input.channelId);
        if (!channel)
            throw new Error("Not found");
        if (channel.organizationId !== viewer.organizationId)
            throw new Error("Forbidden");
        if (channel.isSystem)
            throw new Error("Cannot archive system channel");
        const updated = await this.repo.archiveChannel({
            channelId: input.channelId,
            organizationId: viewer.organizationId,
            workspaceId: channel.workspaceId,
            actorUserId: viewer.userId,
        });
        return !!updated;
    }
    async deleteChannel(viewer, input) {
        this.requireVerified(viewer);
        const channel = await this.repo.getChannelById(input.channelId);
        if (!channel)
            throw new Error("Not found");
        if (channel.organizationId !== viewer.organizationId)
            throw new Error("Forbidden");
        if (channel.isSystem)
            throw new Error("Cannot delete system channel");
        await this.repo.deleteChannel({
            channelId: input.channelId,
            organizationId: viewer.organizationId,
            workspaceId: channel.workspaceId,
            actorUserId: viewer.userId,
        });
        return true;
    }
    async listChannelMembers(viewer, input) {
        const channel = await this.repo.getChannelById(input.channelId);
        if (!channel)
            throw new Error("Not found");
        if (channel.organizationId !== viewer.organizationId)
            throw new Error("Forbidden");
        const wsMember = await this.repo.isWorkspaceMember({ workspaceId: channel.workspaceId, userId: viewer.userId });
        if (!wsMember)
            throw new Error("Forbidden");
        if (channel.type === "private") {
            const isMember = await this.repo.isChannelMember({ channelId: channel.id, userId: viewer.userId });
            if (!isMember)
                throw new Error("Forbidden");
        }
        return this.repo.listChannelMembers({ channelId: channel.id, organizationId: viewer.organizationId });
    }
}
