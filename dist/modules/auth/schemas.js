import { z } from "zod";
export const RegisterOrganizationInput = z.object({
    organizationName: z.string().min(2).max(120),
    email: z.string().email(),
    password: z.string().min(8).max(200),
    // Optional override; if missing, derived from email domain.
    domain: z.string().min(1).max(200).optional(),
    firstName: z.string().max(80).optional(),
    lastName: z.string().max(80).optional(),
});
export const LoginInput = z.object({
    email: z.string().email(),
    password: z.string().min(1).max(200),
    organizationId: z.string().min(1),
    twoFactorCode: z.string().regex(/^[0-9]{6}$/).optional(),
    backupCode: z.string().min(6).max(64).optional(),
});
export const RefreshInput = z.object({
    organizationId: z.string().min(1),
});
export const TwoFaSetupInput = z.object({}).strict();
export const TwoFaVerifyInput = z.object({
    code: z.string().regex(/^[0-9]{6}$/),
});
export const UpdateUserInput = z.object({
    userId: z.string().min(1),
    firstName: z.string().max(80).optional(),
    lastName: z.string().max(80).optional(),
    avatarUrl: z.string().url().optional(),
    phone: z.string().max(40).optional(),
    status: z.enum(["online", "offline", "away", "dnd"]).optional(),
    statusEmoji: z.string().max(16).optional(),
    statusText: z.string().max(80).optional(),
    title: z.string().max(120).optional(),
    department: z.string().max(120).optional(),
});
export const InviteUserInput = z.object({
    organizationId: z.string().min(1),
    email: z.string().email(),
    role: z.enum(["owner", "admin", "manager", "employee", "guest"]).default("employee"),
    department: z.string().max(120).optional(),
});
export const CreateOrganizationUserInput = z.object({
    organizationId: z.string().min(1),
    email: z.string().email(),
    fullName: z.string().max(160).optional(),
    password: z.string().min(8).max(200),
    role: z.enum(["owner", "admin", "manager", "employee", "guest"]).default("employee"),
    department: z.string().max(120).optional(),
});
export const AcceptInviteInput = z.object({
    organizationId: z.string().min(1),
    token: z.string().min(10),
    password: z.string().min(8).max(200),
    firstName: z.string().max(80).optional(),
    lastName: z.string().max(80).optional(),
});
export const VerifyEmailInput = z.object({
    organizationId: z.string().min(1),
    token: z.string().min(10),
});
export const DeactivateUserInput = z.object({
    organizationId: z.string().min(1),
    userId: z.string().min(1),
});
export const RevokeInviteInput = z.object({
    organizationId: z.string().min(1),
    inviteId: z.string().min(1),
});
export const SetUserRoleInput = z.object({
    organizationId: z.string().min(1),
    userId: z.string().min(1),
    role: z.enum(["owner", "admin", "manager", "employee", "guest"]),
});
export const UpdateOrganizationSettingsInput = z.object({
    organizationId: z.string().min(1),
    name: z.string().min(2).max(120).optional(),
    logoUrl: z.string().url().optional(),
    settings: z
        .object({
        retentionDays: z.number().int().nonnegative().optional(),
        fileSizeLimit: z.number().int().positive().optional(),
        allowedAuthMethods: z.array(z.string()).optional(),
    })
        .partial()
        .optional(),
});
