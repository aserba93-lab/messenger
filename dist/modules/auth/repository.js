import crypto from "crypto";
import { prisma } from "../../db/prisma.js";
import { hashPassword } from "../../security/password.js";
export function sha256Hex(input) {
    return crypto.createHash("sha256").update(input).digest("hex");
}
export class AuthRepository {
    async createOrganizationWithFirstAdmin(params) {
        return prisma.$transaction(async (tx) => {
            const organization = await tx.organization.create({
                data: {
                    name: params.organizationName,
                    domain: params.domain,
                    settings: {},
                },
            });
            const user = await tx.user.create({
                data: {
                    email: params.email.toLowerCase(),
                    passwordHash: params.passwordHash,
                    firstName: params.firstName ?? null,
                    lastName: params.lastName ?? null,
                },
            });
            await tx.organizationMember.create({
                data: {
                    organizationId: organization.id,
                    userId: user.id,
                    role: "owner",
                    status: "offline",
                },
            });
            // Default workspace + system channels
            const workspace = await tx.workspace.create({
                data: {
                    organizationId: organization.id,
                    name: "Общее",
                    createdByUserId: user.id,
                },
            });
            await tx.workspaceMember.create({
                data: {
                    workspaceId: workspace.id,
                    userId: user.id,
                    role: "admin",
                },
            });
            const general = await tx.channel.create({
                data: {
                    organizationId: organization.id,
                    workspaceId: workspace.id,
                    name: "general",
                    type: "public",
                    description: "Общий канал",
                    isSystem: true,
                    createdByUserId: user.id,
                },
            });
            await tx.channel.create({
                data: {
                    organizationId: organization.id,
                    workspaceId: workspace.id,
                    name: "random",
                    type: "public",
                    description: "Неформальное общение",
                    isSystem: true,
                    createdByUserId: user.id,
                },
            });
            await tx.channel.create({
                data: {
                    organizationId: organization.id,
                    workspaceId: workspace.id,
                    name: "announcements",
                    type: "broadcast",
                    description: "Объявления (писать могут только администраторы)",
                    isSystem: true,
                    createdByUserId: user.id,
                },
            });
            return { organization, user, workspace, generalChannelId: general.id };
        });
    }
    async findUserByEmail(email) {
        return prisma.user.findUnique({
            where: { email },
        });
    }
    async bumpFailedLogin(params) {
        const user = await prisma.user.findUnique({ where: { id: params.userId } });
        if (!user)
            return null;
        const nextAttempts = (user.failedLoginAttempts ?? 0) + 1;
        const shouldLock = nextAttempts >= params.maxAttempts;
        return prisma.user.update({
            where: { id: params.userId },
            data: {
                failedLoginAttempts: nextAttempts,
                lockedUntil: shouldLock ? new Date(Date.now() + params.lockoutSeconds * 1000) : user.lockedUntil,
            },
        });
    }
    async resetFailedLogin(userId) {
        return prisma.user.update({
            where: { id: userId },
            data: { failedLoginAttempts: 0, lockedUntil: null },
        });
    }
    async createEmailVerificationToken(params) {
        return prisma.emailVerificationToken.create({
            data: {
                organizationId: params.organizationId,
                userId: params.userId,
                tokenHash: params.tokenHash,
                expiresAt: params.expiresAt,
            },
        });
    }
    async useEmailVerificationToken(params) {
        const token = await prisma.emailVerificationToken.findUnique({ where: { tokenHash: params.tokenHash } });
        if (!token)
            return null;
        if (token.usedAt)
            return null;
        if (token.expiresAt.getTime() < Date.now())
            return null;
        return prisma.$transaction(async (tx) => {
            const used = await tx.emailVerificationToken.update({
                where: { tokenHash: params.tokenHash },
                data: { usedAt: new Date() },
            });
            await tx.user.update({
                where: { id: used.userId },
                data: { emailVerifiedAt: new Date() },
            });
            return used;
        });
    }
    async findActiveMembership(params) {
        return prisma.organizationMember.findUnique({
            where: {
                organizationId_userId: {
                    organizationId: params.organizationId,
                    userId: params.userId,
                },
            },
        });
    }
    async getTwoFactorByUserId(userId) {
        return prisma.twoFactor.findUnique({ where: { userId } });
    }
    async replaceBackupCodes(params) {
        return prisma.$transaction(async (tx) => {
            await tx.twoFactorBackupCode.deleteMany({ where: { userId: params.userId } });
            if (params.codeHashes.length === 0)
                return;
            await tx.twoFactorBackupCode.createMany({
                data: params.codeHashes.map((codeHash) => ({ userId: params.userId, codeHash })),
            });
        });
    }
    async consumeBackupCode(params) {
        return prisma.$transaction(async (tx) => {
            const code = await tx.twoFactorBackupCode.findUnique({ where: { codeHash: params.codeHash } });
            if (!code || code.userId !== params.userId)
                return null;
            if (code.usedAt)
                return null;
            return tx.twoFactorBackupCode.update({ where: { codeHash: params.codeHash }, data: { usedAt: new Date() } });
        });
    }
    async getUserInOrganization(params) {
        const member = await prisma.organizationMember.findUnique({
            where: {
                organizationId_userId: { organizationId: params.organizationId, userId: params.userId },
            },
            include: { user: true },
        });
        return member;
    }
    async setTwoFactorSecret(params) {
        return prisma.twoFactor.upsert({
            where: { userId: params.userId },
            create: { userId: params.userId, secretEncrypted: params.encryptedSecret, enabledAt: null },
            update: { secretEncrypted: params.encryptedSecret, enabledAt: null },
        });
    }
    async enableTwoFactor(params) {
        return prisma.twoFactor.update({
            where: { userId: params.userId },
            data: { enabledAt: new Date() },
        });
    }
    async createRefreshSession(params) {
        return prisma.refreshSession.create({
            data: {
                userId: params.userId,
                sessionId: params.sessionId,
                refreshTokenHash: params.refreshTokenHash,
                expiresAt: params.expiresAt,
                userAgent: params.userAgent ?? null,
                ip: params.ip ?? null,
            },
        });
    }
    async getUserById(userId) {
        return prisma.user.findUnique({ where: { id: userId } });
    }
    async findRefreshSessionBySessionId(params) {
        return prisma.refreshSession.findUnique({ where: { sessionId: params.sessionId } });
    }
    async revokeRefreshSession(params) {
        return prisma.refreshSession.update({
            where: { sessionId: params.sessionId },
            data: { revokedAt: new Date() },
        });
    }
    async audit(params) {
        return prisma.auditLog.create({
            data: {
                organizationId: params.organizationId,
                actorUserId: params.actorUserId ?? null,
                action: params.action,
                entityType: params.entityType ?? null,
                entityId: params.entityId ?? null,
                metadata: params.metadata ?? {},
            },
        });
    }
    async getOrganizationById(organizationId) {
        return prisma.organization.findUnique({ where: { id: organizationId } });
    }
    async updateUserPasswordHash(params) {
        return prisma.$transaction(async (tx) => {
            const member = await tx.organizationMember.findUnique({
                where: { organizationId_userId: { organizationId: params.organizationId, userId: params.userId } },
            });
            if (!member || member.deactivatedAt)
                throw new Error("Not a member");
            await tx.user.update({
                where: { id: params.userId },
                data: {
                    passwordHash: params.passwordHash,
                    failedLoginAttempts: 0,
                    lockedUntil: null,
                },
            });
            await tx.auditLog.create({
                data: {
                    organizationId: params.organizationId,
                    actorUserId: params.actorUserId,
                    action: "PASSWORD_RESET_BY_ADMIN",
                    entityType: "User",
                    entityId: params.userId,
                    metadata: {},
                },
            });
        });
    }
    async listUsers(params) {
        // Fetch memberships joined with user profile.
        const memberships = await prisma.organizationMember.findMany({
            where: {
                organizationId: params.organizationId,
                deactivatedAt: null,
                ...(params.role ? { role: params.role } : {}),
                ...(params.department ? { department: params.department } : {}),
                ...(params.status ? { status: params.status } : {}),
            },
            include: { user: true },
            orderBy: { createdAt: "desc" },
        });
        return memberships.map((m) => ({
            id: m.user.id,
            email: m.user.email,
            firstName: m.user.firstName,
            middleName: m.user.middleName,
            lastName: m.user.lastName,
            birthDate: m.user.birthDate,
            avatarUrl: m.user.avatarUrl,
            status: m.status,
            department: m.department,
            title: m.title,
            role: m.role,
        }));
    }
    async createOrganizationUser(params) {
        return prisma.$transaction(async (tx) => {
            const email = params.email.toLowerCase();
            let user = await tx.user.findUnique({ where: { email } });
            if (!user) {
                user = await tx.user.create({
                    data: {
                        email,
                        passwordHash: params.passwordHash,
                        firstName: params.firstName ?? null,
                        lastName: params.lastName ?? null,
                        emailVerifiedAt: new Date(),
                    },
                });
            }
            else {
                user = await tx.user.update({
                    where: { id: user.id },
                    data: {
                        passwordHash: params.passwordHash,
                        firstName: params.firstName ?? user.firstName,
                        lastName: params.lastName ?? user.lastName,
                    },
                });
            }
            const member = await tx.organizationMember.upsert({
                where: { organizationId_userId: { organizationId: params.organizationId, userId: user.id } },
                update: {
                    role: params.role,
                    department: params.department ?? undefined,
                    deactivatedAt: null,
                },
                create: {
                    organizationId: params.organizationId,
                    userId: user.id,
                    role: params.role,
                    department: params.department ?? null,
                    status: "offline",
                    title: null,
                },
                include: { user: true },
            });
            await tx.auditLog.create({
                data: {
                    organizationId: params.organizationId,
                    actorUserId: params.actorUserId,
                    action: "USER_CREATED_BY_ADMIN",
                    entityType: "OrganizationMember",
                    entityId: `${params.organizationId}:${user.id}`,
                    metadata: { role: params.role, email },
                },
            });
            return member;
        });
    }
    async listOrganizationInvites(params) {
        const now = new Date();
        const where = {
            organizationId: params.organizationId,
            ...(params.role ? { role: params.role } : {}),
            ...(params.query
                ? {
                    email: {
                        contains: params.query,
                        mode: "insensitive",
                    },
                }
                : {}),
        };
        if (params.status === "accepted") {
            where.acceptedAt = { not: null };
        }
        else if (params.status === "revoked") {
            where.revokedAt = { not: null };
        }
        else if (params.status === "active") {
            where.acceptedAt = null;
            where.revokedAt = null;
            where.expiresAt = { gt: now };
        }
        else if (params.status === "expired") {
            where.acceptedAt = null;
            where.revokedAt = null;
            where.expiresAt = { lte: now };
        }
        return prisma.invite.findMany({
            where,
            orderBy: { createdAt: "desc" },
            take: params.limit ?? 50,
            skip: params.offset ?? 0,
        });
    }
    async updateUserProfile(params) {
        return prisma.$transaction(async (tx) => {
            const member = await tx.organizationMember.findUnique({
                where: { organizationId_userId: { organizationId: params.organizationId, userId: params.targetUserId } },
            });
            if (!member)
                throw new Error("Not a member");
            const updatedUser = await tx.user.update({
                where: { id: params.targetUserId },
                data: {
                    firstName: params.patch.firstName === undefined ? undefined : params.patch.firstName,
                    lastName: params.patch.lastName === undefined ? undefined : params.patch.lastName,
                    middleName: params.patch.middleName === undefined ? undefined : params.patch.middleName,
                    birthDate: params.patch.birthDate === undefined ? undefined : params.patch.birthDate,
                    avatarUrl: params.patch.avatarUrl === undefined ? undefined : params.patch.avatarUrl === "" ? null : params.patch.avatarUrl,
                    phone: params.patch.phone === undefined ? undefined : params.patch.phone,
                    statusEmoji: params.patch.statusEmoji === undefined ? undefined : params.patch.statusEmoji,
                    statusText: params.patch.statusText === undefined ? undefined : params.patch.statusText,
                },
            });
            const updatedMember = await tx.organizationMember.update({
                where: { organizationId_userId: { organizationId: params.organizationId, userId: params.targetUserId } },
                data: {
                    status: params.patch.status === undefined ? undefined : params.patch.status,
                    department: params.patch.department === undefined ? undefined : params.patch.department,
                    title: params.patch.title === undefined ? undefined : params.patch.title,
                },
            });
            return { user: updatedUser, member: updatedMember };
        });
    }
    async createInvite(params) {
        const roleRaw = String(params.role ?? "").toLowerCase();
        const roleCompat = roleRaw === "owner" || roleRaw === "admin" ? roleRaw : "member";
        try {
            return await prisma.invite.create({
                data: {
                    organizationId: params.organizationId,
                    email: params.email.toLowerCase(),
                    role: params.role,
                    department: params.department ?? null,
                    createdByUserId: params.createdByUserId,
                    expiresAt: params.expiresAt,
                    tokenHash: params.tokenHash,
                    revokedAt: null,
                },
            });
        }
        catch (e) {
            const msg = String(e?.message ?? e ?? "");
            // Backward compatibility: some DB schemas still use MemberRole = owner|admin|member.
            if (!msg.includes("Expected MemberRole") && !msg.includes("Invalid value for argument `role`")) {
                throw e;
            }
            return prisma.invite.create({
                data: {
                    organizationId: params.organizationId,
                    email: params.email.toLowerCase(),
                    role: roleCompat,
                    department: params.department ?? null,
                    createdByUserId: params.createdByUserId,
                    expiresAt: params.expiresAt,
                    tokenHash: params.tokenHash,
                    revokedAt: null,
                },
            });
        }
    }
    async revokeInvite(params) {
        return prisma.$transaction(async (tx) => {
            const invite = await tx.invite.findUnique({ where: { id: params.inviteId } });
            if (!invite)
                throw new Error("Not found");
            if (invite.organizationId !== params.organizationId)
                throw new Error("Forbidden");
            if (invite.acceptedAt)
                throw new Error("Invite already used");
            if (invite.revokedAt)
                return invite;
            const updated = await tx.invite.update({ where: { id: params.inviteId }, data: { revokedAt: new Date() } });
            await tx.auditLog.create({
                data: {
                    organizationId: params.organizationId,
                    actorUserId: params.actorUserId,
                    action: "INVITE_REVOKED",
                    entityType: "Invite",
                    entityId: updated.id,
                },
            });
            return updated;
        });
    }
    async acceptInviteAndCreateUser(params) {
        const tokenHash = sha256Hex(params.token);
        return prisma.$transaction(async (tx) => {
            const invite = await tx.invite.findUnique({ where: { tokenHash } });
            if (!invite)
                throw new Error("Invalid invite");
            if (invite.organizationId !== params.organizationId)
                throw new Error("Invalid invite");
            if (invite.acceptedAt)
                throw new Error("Invite already used");
            if (invite.revokedAt)
                throw new Error("Invite revoked");
            if (invite.expiresAt.getTime() < Date.now())
                throw new Error("Invite expired");
            const emailLower = invite.email.toLowerCase();
            let user = await tx.user.findUnique({ where: { email: emailLower } });
            if (!user) {
                const passwordHash = await hashPassword(params.password);
                user = await tx.user.create({
                    data: {
                        email: emailLower,
                        passwordHash,
                        firstName: params.firstName ?? null,
                        lastName: params.lastName ?? null,
                        emailVerifiedAt: new Date(),
                    },
                });
            }
            const membership = await tx.organizationMember.upsert({
                where: { organizationId_userId: { organizationId: invite.organizationId, userId: user.id } },
                update: {
                    role: invite.role,
                    department: invite.department ?? undefined,
                    deactivatedAt: null,
                },
                create: {
                    organizationId: invite.organizationId,
                    userId: user.id,
                    role: invite.role,
                    department: invite.department ?? null,
                    status: "offline",
                    title: null,
                },
            });
            await tx.invite.update({ where: { id: invite.id }, data: { acceptedAt: new Date() } });
            return { user, membership };
        });
    }
    async deactivateUser(params) {
        return prisma.organizationMember.update({
            where: { organizationId_userId: { organizationId: params.organizationId, userId: params.userId } },
            data: { deactivatedAt: new Date(), status: "offline" },
        });
    }
    async setUserRole(params) {
        return prisma.$transaction(async (tx) => {
            const targetMember = await tx.organizationMember.findUnique({
                where: { organizationId_userId: { organizationId: params.organizationId, userId: params.userId } },
                include: { user: true },
            });
            if (!targetMember || targetMember.deactivatedAt) {
                throw new Error("Not a member");
            }
            const updatedMember = await tx.organizationMember.update({
                where: { organizationId_userId: { organizationId: params.organizationId, userId: params.userId } },
                data: { role: params.role },
                include: { user: true },
            });
            await tx.auditLog.create({
                data: {
                    organizationId: params.organizationId,
                    actorUserId: params.actorUserId,
                    action: "MEMBER_ROLE_CHANGED",
                    entityType: "OrganizationMember",
                    entityId: `${params.organizationId}:${params.userId}`,
                    metadata: { role: params.role },
                },
            });
            return updatedMember;
        });
    }
    async updateOrganizationSettings(params) {
        return prisma.$transaction(async (tx) => {
            const current = await tx.organization.findUnique({ where: { id: params.organizationId } });
            const nextSettings = params.patch.settings === undefined
                ? current?.settings ?? {}
                : {
                    ...(current?.settings ?? {}),
                    ...(params.patch.settings ?? {}),
                };
            return tx.organization.update({
                where: { id: params.organizationId },
                data: {
                    name: params.patch.name === undefined ? undefined : params.patch.name,
                    logoUrl: params.patch.logoUrl === undefined ? undefined : params.patch.logoUrl,
                    settings: params.patch.settings === undefined ? undefined : nextSettings,
                },
            });
        });
    }
}
