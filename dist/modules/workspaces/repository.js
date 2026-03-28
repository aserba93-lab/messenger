import { prisma } from "../../db/prisma.js";
export class WorkspacesRepository {
    async listWorkspacesForViewer(params) {
        const rows = await prisma.workspace.findMany({
            where: {
                organizationId: params.organizationId,
                isArchived: false,
                members: { some: { userId: params.userId } },
            },
            orderBy: { createdAt: "desc" },
            include: {
                members: {
                    where: { userId: params.userId },
                    select: { role: true },
                },
            },
        });
        return rows.map((w) => ({
            id: w.id,
            name: w.name,
            createdAt: w.createdAt,
            role: (w.members[0]?.role ?? "member"),
        }));
    }
    async getWorkspaceById(workspaceId) {
        return prisma.workspace.findUnique({ where: { id: workspaceId } });
    }
    async getWorkspaceMember(params) {
        return prisma.workspaceMember.findUnique({
            where: { workspaceId_userId: { workspaceId: params.workspaceId, userId: params.userId } },
        });
    }
    async createWorkspace(params) {
        return prisma.$transaction(async (tx) => {
            const workspace = await tx.workspace.create({
                data: {
                    organizationId: params.organizationId,
                    name: params.name,
                    createdByUserId: params.createdByUserId,
                },
            });
            await tx.workspaceMember.create({
                data: {
                    workspaceId: workspace.id,
                    userId: params.createdByUserId,
                    role: "admin",
                },
            });
            await tx.auditLog.create({
                data: {
                    organizationId: params.organizationId,
                    actorUserId: params.createdByUserId,
                    action: "WORKSPACE_CREATED",
                    entityType: "Workspace",
                    entityId: workspace.id,
                    metadata: { name: params.name },
                },
            });
            return workspace;
        });
    }
    async updateWorkspace(params) {
        const workspace = await prisma.workspace.findUnique({ where: { id: params.workspaceId } });
        if (!workspace || workspace.organizationId !== params.organizationId)
            throw new Error("Not found");
        return prisma.workspace.update({
            where: { id: params.workspaceId },
            data: {
                name: params.patch.name === undefined ? undefined : params.patch.name,
                description: params.patch.description === undefined ? undefined : params.patch.description,
                avatarUrl: params.patch.avatarUrl === undefined ? undefined : params.patch.avatarUrl,
            },
        });
    }
    async setWorkspaceArchived(params) {
        const workspace = await prisma.workspace.findUnique({ where: { id: params.workspaceId } });
        if (!workspace || workspace.organizationId !== params.organizationId)
            throw new Error("Not found");
        return prisma.workspace.update({ where: { id: params.workspaceId }, data: { isArchived: params.isArchived } });
    }
    async deleteWorkspaceCascade(params) {
        const workspace = await prisma.workspace.findUnique({ where: { id: params.workspaceId } });
        if (!workspace || workspace.organizationId !== params.organizationId)
            throw new Error("Not found");
        return prisma.workspace.delete({ where: { id: params.workspaceId } });
    }
    async listWorkspaceMembers(params) {
        const workspaceMembers = await prisma.workspaceMember.findMany({
            where: { workspaceId: params.workspaceId },
            include: { user: true },
        });
        const userIds = workspaceMembers.map((m) => m.userId);
        const orgMembers = await prisma.organizationMember.findMany({
            where: { organizationId: params.organizationId, userId: { in: userIds } },
            select: { userId: true, role: true, department: true, title: true, status: true },
        });
        const orgByUserId = new Map(orgMembers.map((m) => [m.userId, m]));
        return workspaceMembers.map((m) => {
            const org = orgByUserId.get(m.userId);
            return {
                role: m.role,
                user: {
                    id: m.user.id,
                    email: m.user.email,
                    firstName: m.user.firstName,
                    lastName: m.user.lastName,
                    avatarUrl: m.user.avatarUrl,
                    status: (org?.status ?? m.user.status),
                    department: org?.department ?? null,
                    title: org?.title ?? null,
                    role: (org?.role ?? "employee"),
                    lastSeen: m.user.lastSeen,
                },
            };
        });
    }
    async addWorkspaceMember(params) {
        return prisma.$transaction(async (tx) => {
            const orgMember = await tx.organizationMember.findUnique({
                where: { organizationId_userId: { organizationId: params.organizationId, userId: params.userId } },
            });
            if (!orgMember || orgMember.deactivatedAt)
                throw new Error("User is not active in organization");
            const workspace = await tx.workspace.findUnique({ where: { id: params.workspaceId } });
            if (!workspace || workspace.organizationId !== params.organizationId)
                throw new Error("Workspace not found");
            const upserted = await tx.workspaceMember.upsert({
                where: { workspaceId_userId: { workspaceId: params.workspaceId, userId: params.userId } },
                update: { role: params.role },
                create: { workspaceId: params.workspaceId, userId: params.userId, role: params.role },
            });
            await tx.auditLog.create({
                data: {
                    organizationId: params.organizationId,
                    actorUserId: params.actorUserId,
                    action: "WORKSPACE_MEMBER_ADDED",
                    entityType: "WorkspaceMember",
                    entityId: `${params.workspaceId}:${params.userId}`,
                    metadata: { role: params.role, workspaceId: params.workspaceId, userId: params.userId },
                },
            });
            return upserted;
        });
    }
    async removeWorkspaceMember(params) {
        return prisma.$transaction(async (tx) => {
            const workspace = await tx.workspace.findUnique({ where: { id: params.workspaceId } });
            if (!workspace || workspace.organizationId !== params.organizationId)
                throw new Error("Workspace not found");
            const target = await tx.workspaceMember.findUnique({
                where: { workspaceId_userId: { workspaceId: params.workspaceId, userId: params.userId } },
            });
            if (!target)
                throw new Error("User is not a workspace member");
            if (target.role === "admin") {
                const adminCount = await tx.workspaceMember.count({
                    where: { workspaceId: params.workspaceId, role: "admin", userId: { not: params.userId } },
                });
                if (adminCount === 0)
                    throw new Error("Cannot remove last admin from workspace");
            }
            await tx.workspaceMember.delete({
                where: { workspaceId_userId: { workspaceId: params.workspaceId, userId: params.userId } },
            });
            await tx.auditLog.create({
                data: {
                    organizationId: params.organizationId,
                    actorUserId: params.actorUserId,
                    action: "WORKSPACE_MEMBER_REMOVED",
                    entityType: "WorkspaceMember",
                    entityId: `${params.workspaceId}:${params.userId}`,
                },
            });
        });
    }
}
