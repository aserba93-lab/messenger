import { z } from "zod";
export const CreateWorkspaceInputSchema = z.object({
    name: z.string().min(1).max(120),
    description: z.string().max(500).optional(),
    avatarUrl: z.string().url().optional(),
});
export const UpdateWorkspaceInputSchema = z.object({
    workspaceId: z.string().min(1),
    name: z.string().min(1).max(120).optional(),
    description: z.string().max(500).optional(),
    avatarUrl: z.string().url().optional(),
});
export const ArchiveWorkspaceInputSchema = z.object({
    workspaceId: z.string().min(1),
    isArchived: z.boolean(),
});
export const DeleteWorkspaceInputSchema = z.object({
    workspaceId: z.string().min(1),
});
export const WorkspaceAddMemberInputSchema = z.object({
    workspaceId: z.string().min(1),
    userId: z.string().min(1),
    role: z.enum(["admin", "member", "observer"]),
});
export const WorkspaceRemoveMemberInputSchema = z.object({
    workspaceId: z.string().min(1),
    userId: z.string().min(1),
});
