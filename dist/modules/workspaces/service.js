import { WorkspacesRepository } from "./repository.js";
import { ChannelsRepository } from "../channels/repository.js";
import { NotificationsService } from "../notifications/service.js";
export class WorkspacesService {
    repo;
    channelsRepo;
    notifications;
    constructor(repo = new WorkspacesRepository(), channelsRepo = new ChannelsRepository(), notifications = new NotificationsService()) {
        this.repo = repo;
        this.channelsRepo = channelsRepo;
        this.notifications = notifications;
    }
    async listWorkspaces(viewer) {
        return this.repo.listWorkspacesForViewer({ organizationId: viewer.organizationId, userId: viewer.userId });
    }
    async createWorkspace(viewer, input) {
        if (!viewer.emailVerified)
            throw new Error("Email not verified");
        if (viewer.role !== "owner" && viewer.role !== "admin" && viewer.role !== "manager")
            throw new Error("Forbidden");
        const workspace = await this.repo.createWorkspace({
            organizationId: viewer.organizationId,
            name: input.name,
            createdByUserId: viewer.userId,
        });
        // System channels for every workspace
        await this.channelsRepo.createChannel({
            organizationId: viewer.organizationId,
            workspaceId: workspace.id,
            name: "general",
            type: "public",
            description: "General discussion",
            isSystem: true,
            createdByUserId: viewer.userId,
        });
        await this.channelsRepo.createChannel({
            organizationId: viewer.organizationId,
            workspaceId: workspace.id,
            name: "announcements",
            type: "broadcast",
            description: "Announcements (read-only for most members)",
            isSystem: true,
            createdByUserId: viewer.userId,
        });
        return {
            id: workspace.id,
            name: workspace.name,
            createdAt: workspace.createdAt,
            role: "admin",
        };
    }
    async listWorkspaceMembers(viewer, workspaceId) {
        const workspace = await this.repo.getWorkspaceById(workspaceId);
        if (!workspace || workspace.organizationId !== viewer.organizationId)
            throw new Error("Not found");
        const myMembership = await this.repo.getWorkspaceMember({ workspaceId, userId: viewer.userId });
        if (!myMembership)
            throw new Error("Forbidden");
        return this.repo.listWorkspaceMembers({ workspaceId, organizationId: viewer.organizationId });
    }
    async addWorkspaceMember(viewer, input) {
        const myMembership = await this.repo.getWorkspaceMember({ workspaceId: input.workspaceId, userId: viewer.userId });
        if (!myMembership || myMembership.role !== "admin")
            throw new Error("Forbidden");
        await this.repo.addWorkspaceMember({
            organizationId: viewer.organizationId,
            workspaceId: input.workspaceId,
            actorUserId: viewer.userId,
            userId: input.userId,
            role: input.role,
        });
        if (input.userId !== viewer.userId) {
            await this.notifications.createSystem({
                organizationId: viewer.organizationId,
                userId: input.userId,
                type: "workspace:added",
                payload: { workspaceId: input.workspaceId, addedByUserId: viewer.userId, role: input.role },
                // no per-chat scope, falls back to default(all)
            });
        }
        const members = await this.repo.listWorkspaceMembers({ workspaceId: input.workspaceId, organizationId: viewer.organizationId });
        const updated = members.find((m) => m.user.id === input.userId);
        if (!updated)
            throw new Error("Member not found after upsert");
        return updated;
    }
    async removeWorkspaceMember(viewer, input) {
        const myMembership = await this.repo.getWorkspaceMember({ workspaceId: input.workspaceId, userId: viewer.userId });
        if (!myMembership || myMembership.role !== "admin")
            throw new Error("Forbidden");
        await this.repo.removeWorkspaceMember({
            organizationId: viewer.organizationId,
            workspaceId: input.workspaceId,
            actorUserId: viewer.userId,
            userId: input.userId,
        });
        return true;
    }
    async updateWorkspace(viewer, input) {
        if (!viewer.emailVerified)
            throw new Error("Email not verified");
        const myMembership = await this.repo.getWorkspaceMember({ workspaceId: input.workspaceId, userId: viewer.userId });
        if (!myMembership || myMembership.role !== "admin")
            throw new Error("Forbidden");
        return this.repo.updateWorkspace({
            organizationId: viewer.organizationId,
            workspaceId: input.workspaceId,
            patch: {
                name: input.name,
                description: input.description,
                avatarUrl: input.avatarUrl,
            },
        });
    }
    async setWorkspaceArchived(viewer, input) {
        if (!viewer.emailVerified)
            throw new Error("Email not verified");
        const myMembership = await this.repo.getWorkspaceMember({ workspaceId: input.workspaceId, userId: viewer.userId });
        if (!myMembership || myMembership.role !== "admin")
            throw new Error("Forbidden");
        await this.repo.setWorkspaceArchived({ organizationId: viewer.organizationId, workspaceId: input.workspaceId, isArchived: input.isArchived });
        return true;
    }
    async deleteWorkspace(viewer, input) {
        if (!viewer.emailVerified)
            throw new Error("Email not verified");
        if (viewer.role !== "owner")
            throw new Error("Forbidden");
        await this.repo.deleteWorkspaceCascade({ organizationId: viewer.organizationId, workspaceId: input.workspaceId });
        return true;
    }
}
