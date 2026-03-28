import { RegisterOrganizationInput, LoginInput, RefreshInput, TwoFaVerifyInput, UpdateUserInput, InviteUserInput, CreateOrganizationUserInput, AcceptInviteInput, VerifyEmailInput, SetUserPasswordInput, DeactivateUserInput, RevokeInviteInput, SetUserRoleInput, UpdateOrganizationSettingsInput, } from "./schemas.js";
import { getCookieValue } from "../../web/cookies.js";
function requireViewer(ctx) {
    if (!ctx?.viewer)
        throw new Error("Unauthorized");
    return ctx.viewer;
}
function mapUserWithMember(member) {
    // member: OrganizationMember include user
    return {
        id: member.user.id,
        email: member.user.email,
        firstName: member.user.firstName,
        lastName: member.user.lastName,
        avatarUrl: member.user.avatarUrl,
        phone: member.user.phone,
        status: member.status,
        statusEmoji: member.user.statusEmoji,
        statusText: member.user.statusText,
        title: member.title,
        department: member.department,
        role: member.role,
        lastSeen: member.user.lastSeen,
    };
}
export const authResolvers = {
    Query: {
        organization: async (_p, args, ctx) => {
            const viewer = requireViewer(ctx);
            if (viewer.organizationId !== args.organizationId)
                throw new Error("Forbidden");
            return ctx.authService.getOrganization(viewer, args.organizationId);
        },
        users: async (_parent, args, ctx) => {
            const viewer = requireViewer(ctx);
            if (viewer.organizationId !== args.organizationId)
                throw new Error("Forbidden");
            const result = await ctx.authService.listUsers({
                viewer,
                role: args.role ?? undefined,
                department: args.department ?? undefined,
                status: args.status ?? undefined,
            });
            return result;
        },
        organizationInvites: async (_p, args, ctx) => {
            const viewer = requireViewer(ctx);
            if (viewer.organizationId !== args.organizationId)
                throw new Error("Forbidden");
            const invites = await ctx.authService.listOrganizationInvites(viewer, {
                role: args.role ?? undefined,
                status: args.status ?? undefined,
                query: args.query?.trim() || undefined,
                limit: typeof args.limit === "number" ? Math.max(1, Math.min(200, args.limit)) : 50,
                offset: typeof args.offset === "number" ? Math.max(0, args.offset) : 0,
            });
            return invites.map((invite) => ({
                id: invite.id,
                email: invite.email,
                role: invite.role,
                department: invite.department,
                createdAt: invite.createdAt,
                expiresAt: invite.expiresAt,
                acceptedAt: invite.acceptedAt,
                revokedAt: invite.revokedAt,
                inviteToken: null,
            }));
        },
        me: async (_p, _a, ctx) => {
            const viewer = requireViewer(ctx);
            const member = await ctx.authService.getMe(viewer);
            if (!member)
                throw new Error("Not found");
            return mapUserWithMember(member);
        },
        user: async (_p, args, ctx) => {
            const viewer = requireViewer(ctx);
            if (viewer.organizationId !== args.organizationId)
                throw new Error("Forbidden");
            const member = await ctx.authService.getUser(viewer, args.id);
            return mapUserWithMember(member);
        },
    },
    Mutation: {
        registerOrganization: async (_p, args, ctx) => {
            const input = RegisterOrganizationInput.parse(args.input);
            const out = await ctx.authService.registerOrganization(input);
            return {
                viewer: out.viewer,
                organizationId: out.organizationId,
            };
        },
        login: async (_p, args, ctx) => {
            const input = LoginInput.parse(args.input);
            const loginRes = await ctx.authService.login(input);
            return ctx.authService.finalizeLogin({
                userId: loginRes.user.id,
                organizationId: input.organizationId,
                role: loginRes.membership.role,
                refreshToken: loginRes.refresh.refreshToken,
                refreshTokenHash: loginRes.refresh.refreshTokenHash,
                sessionId: loginRes.refresh.sessionId,
                expiresAt: loginRes.refresh.expiresAt,
                userAgent: ctx?.request?.headers?.get?.("user-agent") ?? ctx?.request?.headers?.["user-agent"],
                ip: ctx?.request?.headers?.get?.("x-forwarded-for") ?? ctx?.request?.headers?.["x-forwarded-for"],
                response: ctx.response,
            });
        },
        logout: async (_p, _a, ctx) => {
            const refreshToken = getCookieValue(ctx.request, ctx.env.REFRESH_COOKIE_NAME);
            if (!refreshToken)
                return true;
            await ctx.authService.logout({ refreshToken, response: ctx.response });
            return true;
        },
        refresh: async (_p, args, ctx) => {
            const input = RefreshInput.parse(args.input);
            const refreshToken = getCookieValue(ctx.request, ctx.env.REFRESH_COOKIE_NAME);
            if (!refreshToken)
                throw new Error("Refresh cookie missing");
            return ctx.authService.refresh({
                organizationId: input.organizationId,
                refreshToken,
                response: ctx.response,
                userAgent: ctx?.request?.headers?.get?.("user-agent") ?? ctx?.request?.headers?.["user-agent"],
                ip: ctx?.request?.headers?.get?.("x-forwarded-for") ?? ctx?.request?.headers?.["x-forwarded-for"],
            });
        },
        twoFaSetup: async (_p, _a, ctx) => {
            const viewer = requireViewer(ctx);
            return ctx.authService.twoFaSetup({ viewer, response: ctx.response });
        },
        twoFaVerify: async (_p, args, ctx) => {
            const viewer = requireViewer(ctx);
            const input = TwoFaVerifyInput.parse({ code: args.code });
            return ctx.authService.twoFaVerify({ viewer, code: input.code });
        },
        updateUser: async (_p, args, ctx) => {
            const viewer = requireViewer(ctx);
            const input = UpdateUserInput.parse(args.input);
            const out = await ctx.authService.updateUser(viewer, {
                userId: input.userId,
                firstName: input.firstName,
                lastName: input.lastName,
                avatarUrl: input.avatarUrl,
                phone: input.phone,
                status: input.status,
                statusEmoji: input.statusEmoji,
                statusText: input.statusText,
                department: input.department,
                title: input.title,
            });
            return {
                id: out.user.id,
                email: out.user.email,
                firstName: out.user.firstName,
                lastName: out.user.lastName,
                avatarUrl: out.user.avatarUrl,
                phone: out.user.phone,
                status: out.member.status,
                department: out.member.department,
                title: out.member.title,
                role: out.member.role,
                lastSeen: out.user.lastSeen,
            };
        },
        inviteUser: async (_p, args, ctx) => {
            const viewer = requireViewer(ctx);
            const input = InviteUserInput.parse(args.input);
            if (input.organizationId !== viewer.organizationId)
                throw new Error("Forbidden");
            const { invite, inviteToken } = await ctx.authService.inviteUser(viewer, {
                email: input.email,
                role: input.role,
                department: input.department,
            });
            return {
                id: invite.id,
                email: invite.email,
                role: invite.role,
                department: invite.department,
                expiresAt: invite.expiresAt,
                inviteToken,
            };
        },
        createOrganizationUser: async (_p, args, ctx) => {
            const viewer = requireViewer(ctx);
            const input = CreateOrganizationUserInput.parse(args.input);
            if (input.organizationId !== viewer.organizationId)
                throw new Error("Forbidden");
            const member = await ctx.authService.createOrganizationUser(viewer, {
                email: input.email,
                fullName: input.fullName,
                password: input.password,
                role: input.role ?? "employee",
                department: input.department,
            });
            return mapUserWithMember(member);
        },
        setUserPassword: async (_p, args, ctx) => {
            const viewer = requireViewer(ctx);
            const input = SetUserPasswordInput.parse(args.input);
            if (input.organizationId !== viewer.organizationId)
                throw new Error("Forbidden");
            return ctx.authService.setUserPassword(viewer, {
                userId: input.userId,
                password: input.password,
            });
        },
        acceptInvite: async (_p, args, ctx) => {
            const input = AcceptInviteInput.parse(args.input);
            const acceptRes = await ctx.authService.acceptInvite({
                organizationId: input.organizationId,
                token: input.token,
                password: input.password,
                firstName: input.firstName,
                lastName: input.lastName,
            });
            return ctx.authService.finalizeLogin({
                userId: acceptRes.user.id,
                organizationId: input.organizationId,
                role: acceptRes.membership.role,
                refreshToken: acceptRes.refresh.refreshToken,
                refreshTokenHash: acceptRes.refresh.refreshTokenHash,
                sessionId: acceptRes.refresh.sessionId,
                expiresAt: acceptRes.refresh.expiresAt,
                userAgent: ctx?.request?.headers?.get?.("user-agent") ?? ctx?.request?.headers?.["user-agent"],
                ip: ctx?.request?.headers?.get?.("x-forwarded-for") ?? ctx?.request?.headers?.["x-forwarded-for"],
                response: ctx.response,
            });
        },
        requestEmailVerification: async (_p, _a, ctx) => {
            const viewer = requireViewer(ctx);
            return ctx.authService.requestEmailVerification({ viewer });
        },
        verifyEmail: async (_p, args, ctx) => {
            const input = VerifyEmailInput.parse(args.input);
            return ctx.authService.verifyEmail({ organizationId: input.organizationId, token: input.token });
        },
        deactivateUser: async (_p, args, ctx) => {
            const viewer = requireViewer(ctx);
            const input = DeactivateUserInput.parse(args.input);
            if (input.organizationId !== viewer.organizationId)
                throw new Error("Forbidden");
            await ctx.authService.deactivateUser(viewer, { userId: input.userId });
            return true;
        },
        revokeInvite: async (_p, args, ctx) => {
            const viewer = requireViewer(ctx);
            const input = RevokeInviteInput.parse(args.input);
            if (input.organizationId !== viewer.organizationId)
                throw new Error("Forbidden");
            return ctx.authService.revokeInvite(viewer, { inviteId: input.inviteId });
        },
        setUserRole: async (_p, args, ctx) => {
            const viewer = requireViewer(ctx);
            const input = SetUserRoleInput.parse(args.input);
            if (input.organizationId !== viewer.organizationId)
                throw new Error("Forbidden");
            const member = await ctx.authService.setUserRole(viewer, { userId: input.userId, role: input.role });
            return mapUserWithMember(member);
        },
        updateOrganizationSettings: async (_p, args, ctx) => {
            const viewer = requireViewer(ctx);
            const input = UpdateOrganizationSettingsInput.parse(args.input);
            if (input.organizationId !== viewer.organizationId)
                throw new Error("Forbidden");
            return ctx.authService.updateOrganizationSettings(viewer, {
                name: input.name,
                logoUrl: input.logoUrl,
                settings: input.settings ?? undefined,
            });
        },
    },
};
