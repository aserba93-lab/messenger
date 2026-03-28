import crypto from "crypto";
import { env } from "../../config/env.js";
import { AuthRepository, sha256Hex } from "./repository.js";
import { decryptTotpSecret, encryptTotpSecret, buildOtpAuthUrl, verifyTotpCode, generateTotpSecret, buildQrDataUri } from "../../security/totp.js";
import { hashPassword, verifyPassword } from "../../security/password.js";
import { issueAccessToken, issueRefreshToken, verifyRefreshToken } from "../../security/jwt.js";
import { setRefreshCookie } from "../../web/cookies.js";
export class AuthService {
    repo;
    constructor(repo = new AuthRepository()) {
        this.repo = repo;
    }
    async registerOrganization(params) {
        const emailLower = params.email.toLowerCase();
        const derivedDomain = emailLower.split("@")[1] ?? "";
        const domain = (params.domain ?? derivedDomain).toLowerCase();
        if (!derivedDomain || derivedDomain !== domain) {
            throw new Error("Email domain must match organization domain");
        }
        const passwordHash = await hashPassword(params.password);
        // Check email uniqueness (User.email unique)
        const existingUser = await this.repo.findUserByEmail(emailLower);
        if (existingUser)
            throw new Error("Email already registered");
        const { organization, user, workspace, generalChannelId } = await this.repo.createOrganizationWithFirstAdmin({
            organizationName: params.organizationName,
            email: emailLower,
            passwordHash,
            domain,
            firstName: params.firstName,
            lastName: params.lastName,
        });
        await this.repo.audit({
            organizationId: organization.id,
            actorUserId: user.id,
            action: "ORG_REGISTER",
            entityType: "Organization",
            entityId: organization.id,
        });
        // Email verification token (dev returns token via requestEmailVerification)
        // We don't auto-verify; unverified users have read-only access until verification.
        return {
            organizationId: organization.id,
            viewer: { userId: user.id, organizationId: organization.id, role: "owner" },
            workspaceId: workspace.id,
            channelId: generalChannelId,
        };
    }
    async listUsers(params) {
        if (!params.viewer)
            throw new Error("Unauthorized");
        return this.repo.listUsers({
            organizationId: params.viewer.organizationId,
            role: params.role,
            department: params.department,
            status: params.status,
        });
    }
    async getOrganization(viewer, organizationId) {
        if (viewer.organizationId !== organizationId)
            throw new Error("Forbidden");
        const org = await this.repo.getOrganizationById(organizationId);
        if (!org)
            throw new Error("Not found");
        return {
            id: org.id,
            name: org.name,
            domain: org.domain,
            logoUrl: org.logoUrl,
            settings: org.settings,
        };
    }
    async getMe(viewer) {
        const member = await this.repo.getUserInOrganization({ organizationId: viewer.organizationId, userId: viewer.userId });
        if (!member)
            throw new Error("Not found");
        return member;
    }
    async getUser(viewer, targetUserId) {
        if (viewer.userId !== targetUserId && viewer.role !== "admin")
            throw new Error("Forbidden");
        const member = await this.repo.getUserInOrganization({ organizationId: viewer.organizationId, userId: targetUserId });
        if (!member)
            throw new Error("Not found");
        return member;
    }
    async listOrganizationInvites(viewer, input) {
        if (viewer.role !== "owner" && viewer.role !== "admin") {
            throw new Error("Forbidden");
        }
        return this.repo.listOrganizationInvites({
            organizationId: viewer.organizationId,
            role: input?.role,
            status: input?.status,
            query: input?.query,
            limit: input?.limit,
            offset: input?.offset,
        });
    }
    async updateUser(viewer, input) {
        if (input.userId !== viewer.userId && viewer.role !== "admin")
            throw new Error("Forbidden");
        const out = await this.repo.updateUserProfile({
            organizationId: viewer.organizationId,
            actorUserId: viewer.userId,
            targetUserId: input.userId,
            patch: {
                firstName: input.firstName,
                lastName: input.lastName,
                avatarUrl: input.avatarUrl,
                phone: input.phone,
                statusEmoji: input.statusEmoji,
                statusText: input.statusText,
                status: input.status,
                department: input.department,
                title: input.title,
            },
        });
        return out;
    }
    async inviteUser(viewer, input) {
        if (viewer.role !== "owner" && viewer.role !== "admin")
            throw new Error("Forbidden");
        const inviteToken = crypto.randomBytes(24).toString("hex");
        const tokenHash = sha256Hex(inviteToken);
        const expiresAt = new Date(Date.now() + 1000 * 60 * 60 * 24 * 7); // 7 days
        const invite = await this.repo.createInvite({
            organizationId: viewer.organizationId,
            email: input.email,
            role: input.role,
            department: input.department ?? null,
            createdByUserId: viewer.userId,
            expiresAt,
            tokenHash,
        });
        return { invite, inviteToken };
    }
    async createOrganizationUser(viewer, input) {
        if (viewer.role !== "owner" && viewer.role !== "admin")
            throw new Error("Forbidden");
        const name = String(input.fullName ?? "").trim();
        const parts = name ? name.split(/\s+/g) : [];
        const firstName = parts[0] || undefined;
        const lastName = parts.length > 1 ? parts.slice(1).join(" ") : undefined;
        const passwordHash = await hashPassword(input.password);
        return this.repo.createOrganizationUser({
            organizationId: viewer.organizationId,
            actorUserId: viewer.userId,
            email: input.email,
            passwordHash,
            firstName,
            lastName,
            role: input.role ?? "employee",
            department: input.department ?? null,
        });
    }
    async setUserPassword(viewer, input) {
        if (viewer.role !== "owner" && viewer.role !== "admin")
            throw new Error("Forbidden");
        const target = await this.repo.getUserInOrganization({ organizationId: viewer.organizationId, userId: input.userId });
        if (!target || target.deactivatedAt)
            throw new Error("Not a member");
        if (viewer.role === "admin") {
            if (target.role === "owner" || target.role === "admin") {
                throw new Error("Forbidden");
            }
        }
        const passwordHash = await hashPassword(input.password);
        await this.repo.updateUserPasswordHash({
            organizationId: viewer.organizationId,
            userId: input.userId,
            passwordHash,
            actorUserId: viewer.userId,
        });
        return true;
    }
    async revokeInvite(viewer, input) {
        if (viewer.role !== "owner" && viewer.role !== "admin")
            throw new Error("Forbidden");
        await this.repo.revokeInvite({ organizationId: viewer.organizationId, inviteId: input.inviteId, actorUserId: viewer.userId });
        return true;
    }
    async deactivateUser(viewer, input) {
        if (viewer.role !== "owner" && viewer.role !== "admin")
            throw new Error("Forbidden");
        await this.repo.deactivateUser({ organizationId: viewer.organizationId, userId: input.userId });
        return true;
    }
    async setUserRole(viewer, input) {
        if (viewer.role !== "owner" && viewer.role !== "admin")
            throw new Error("Forbidden");
        if (input.userId === viewer.userId) {
            throw new Error("You cannot change your own role");
        }
        const target = await this.repo.getUserInOrganization({ organizationId: viewer.organizationId, userId: input.userId });
        if (!target || target.deactivatedAt) {
            throw new Error("Not a member");
        }
        if (viewer.role === "admin") {
            if (target.role === "owner" || target.role === "admin") {
                throw new Error("Forbidden");
            }
            if (input.role === "owner" || input.role === "admin") {
                throw new Error("Forbidden");
            }
        }
        return this.repo.setUserRole({
            organizationId: viewer.organizationId,
            actorUserId: viewer.userId,
            userId: input.userId,
            role: input.role,
        });
    }
    async updateOrganizationSettings(viewer, input) {
        if (viewer.role !== "owner" && viewer.role !== "admin")
            throw new Error("Forbidden");
        return this.repo.updateOrganizationSettings({
            organizationId: viewer.organizationId,
            patch: {
                name: input.name,
                logoUrl: input.logoUrl,
                settings: input.settings,
            },
        });
    }
    async login(params) {
        const emailLower = params.email.toLowerCase();
        const user = await this.repo.findUserByEmail(emailLower);
        if (!user)
            throw new Error("Invalid credentials");
        if (user.lockedUntil && user.lockedUntil.getTime() > Date.now()) {
            throw new Error("Account locked. Try later.");
        }
        const membership = await this.repo.findActiveMembership({
            organizationId: params.organizationId,
            userId: user.id,
        });
        if (!membership || membership.deactivatedAt)
            throw new Error("Not a member of this organization");
        const ok = await verifyPassword(user.passwordHash, params.password);
        if (!ok) {
            await this.repo.bumpFailedLogin({
                userId: user.id,
                maxAttempts: env.LOGIN_MAX_FAILED_ATTEMPTS,
                lockoutSeconds: env.LOGIN_LOCKOUT_SECONDS,
            });
            throw new Error("Invalid credentials");
        }
        await this.repo.resetFailedLogin(user.id);
        const twoFactor = await this.repo.getTwoFactorByUserId(user.id);
        if (twoFactor?.enabledAt) {
            if (params.backupCode) {
                const ok = await this.repo.consumeBackupCode({ userId: user.id, codeHash: sha256Hex(params.backupCode) });
                if (!ok)
                    throw new Error("Invalid backup code");
            }
            else {
                if (!params.twoFactorCode)
                    throw new Error("2FA code required");
                const secret = await decryptTotpSecret(twoFactor.secretEncrypted);
                const valid = verifyTotpCode(secret, params.twoFactorCode);
                if (!valid)
                    throw new Error("Invalid 2FA code");
            }
        }
        // Create refresh session
        const sessionId = crypto.randomBytes(24).toString("hex");
        const expiresAt = new Date(Date.now() + env.JWT_REFRESH_TTL_SECONDS * 1000);
        const refreshToken = issueRefreshToken({ sub: user.id, sid: sessionId });
        const refreshTokenHash = sha256Hex(refreshToken);
        return {
            user,
            membership,
            refresh: { sessionId, refreshToken, refreshTokenHash, expiresAt },
        };
    }
    async requestEmailVerification(params) {
        const member = await this.repo.getUserInOrganization({ organizationId: params.viewer.organizationId, userId: params.viewer.userId });
        if (!member)
            throw new Error("Not a member");
        if (member.user.emailVerifiedAt)
            return { ok: true, token: null };
        const token = crypto.randomBytes(24).toString("hex");
        const tokenHash = sha256Hex(token);
        const expiresAt = new Date(Date.now() + env.EMAIL_VERIFY_TOKEN_TTL_SECONDS * 1000);
        await this.repo.createEmailVerificationToken({
            organizationId: params.viewer.organizationId,
            userId: params.viewer.userId,
            tokenHash,
            expiresAt,
        });
        // TODO: send email with verification link/code.
        // For now we return token in development to unblock testing.
        return { ok: true, token: env.NODE_ENV === "development" ? token : null };
    }
    async verifyEmail(params) {
        const tokenHash = sha256Hex(params.token);
        const used = await this.repo.useEmailVerificationToken({ tokenHash });
        if (!used)
            throw new Error("Invalid or expired token");
        if (used.organizationId !== params.organizationId)
            throw new Error("Invalid token");
        return true;
    }
    async acceptInvite(params) {
        const { user, membership } = await this.repo.acceptInviteAndCreateUser({
            organizationId: params.organizationId,
            token: params.token,
            password: params.password,
            firstName: params.firstName,
            lastName: params.lastName,
        });
        const sessionId = crypto.randomBytes(24).toString("hex");
        const expiresAt = new Date(Date.now() + env.JWT_REFRESH_TTL_SECONDS * 1000);
        const refreshToken = issueRefreshToken({ sub: user.id, sid: sessionId });
        const refreshTokenHash = sha256Hex(refreshToken);
        return {
            user,
            membership,
            refresh: { sessionId, refreshToken, refreshTokenHash, expiresAt },
        };
    }
    async finalizeLogin(params) {
        await this.repo.createRefreshSession({
            userId: params.userId,
            sessionId: params.sessionId,
            refreshTokenHash: params.refreshTokenHash,
            expiresAt: params.expiresAt,
            userAgent: params.userAgent,
            ip: params.ip,
        });
        const accessToken = issueAccessToken({
            sub: params.userId,
            orgId: params.organizationId,
            role: params.role,
            sessionId: params.sessionId,
        });
        // Set refresh token cookie (httpOnly)
        setRefreshCookie(params.response, params.refreshToken);
        return {
            accessToken,
            viewer: { userId: params.userId, organizationId: params.organizationId, role: params.role },
        };
    }
    async logout(params) {
        const payload = verifyRefreshToken(params.refreshToken);
        if (!payload)
            return true;
        await this.repo.revokeRefreshSession({ sessionId: payload.sid });
        // Clear cookie
        setRefreshCookie(params.response, params.refreshToken, { revoked: true });
        return true;
    }
    async refresh(params) {
        const payload = verifyRefreshToken(params.refreshToken);
        if (!payload)
            throw new Error("Invalid refresh token");
        const session = await this.repo.findRefreshSessionBySessionId({ sessionId: payload.sid });
        if (!session || session.revokedAt || session.expiresAt <= new Date())
            throw new Error("Refresh session expired");
        const hash = sha256Hex(params.refreshToken);
        if (hash !== session.refreshTokenHash)
            throw new Error("Refresh token mismatch");
        // Ensure membership exists (and not deactivated)
        const membership = await this.repo.findActiveMembership({ organizationId: params.organizationId, userId: payload.sub });
        if (!membership || membership.deactivatedAt)
            throw new Error("Not a member of this organization");
        // Rotate refresh token
        await this.repo.revokeRefreshSession({ sessionId: payload.sid });
        const newSessionId = crypto.randomBytes(24).toString("hex");
        const expiresAt = new Date(Date.now() + env.JWT_REFRESH_TTL_SECONDS * 1000);
        const newRefreshToken = issueRefreshToken({ sub: payload.sub, sid: newSessionId });
        const newHash = sha256Hex(newRefreshToken);
        await this.repo.createRefreshSession({
            userId: payload.sub,
            sessionId: newSessionId,
            refreshTokenHash: newHash,
            expiresAt,
            userAgent: params.userAgent,
            ip: params.ip,
        });
        const accessToken = issueAccessToken({
            sub: payload.sub,
            orgId: params.organizationId,
            role: membership.role,
            sessionId: newSessionId,
        });
        setRefreshCookie(params.response, newRefreshToken);
        return {
            accessToken,
            viewer: { userId: payload.sub, organizationId: params.organizationId, role: membership.role },
        };
    }
    async twoFaSetup(params) {
        // Setup doesn't require 2FA enabled, but must be logged in.
        const user = await this.repo.getUserById(params.viewer.userId);
        if (!user?.email)
            throw new Error("User not found");
        const totpSecret = generateTotpSecret();
        const otpAuthUrl = buildOtpAuthUrl(totpSecret, user.email);
        const qrDataUri = await buildQrDataUri(otpAuthUrl);
        const encrypted = await encryptTotpSecret(totpSecret);
        // Save encrypted secret; enableAt stays null until verify.
        await this.repo.setTwoFactorSecret({ userId: params.viewer.userId, encryptedSecret: encrypted });
        // The frontend needs the otpauth URL; we return it and let it build QR.
        return { otpAuthUrl, qrDataUri };
    }
    async twoFaVerify(params) {
        const twoFactor = await this.repo.getTwoFactorByUserId(params.viewer.userId);
        if (!twoFactor?.secretEncrypted)
            throw new Error("2FA not setup");
        const secret = await decryptTotpSecret(twoFactor.secretEncrypted);
        const valid = verifyTotpCode(secret, params.code);
        if (!valid)
            throw new Error("Invalid 2FA code");
        await this.repo.enableTwoFactor({ userId: params.viewer.userId });
        const backupCodes = Array.from({ length: 10 }).map(() => crypto.randomBytes(5).toString("hex"));
        await this.repo.replaceBackupCodes({
            userId: params.viewer.userId,
            codeHashes: backupCodes.map((c) => sha256Hex(c)),
        });
        await this.repo.audit({
            organizationId: params.viewer.organizationId,
            actorUserId: params.viewer.userId,
            action: "TWOFA_ENABLED",
            entityType: "TwoFactor",
            entityId: params.viewer.userId,
        });
        return { ok: true, backupCodes: env.NODE_ENV === "development" ? backupCodes : [] };
    }
}
