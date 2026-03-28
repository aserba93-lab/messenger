import { z } from "zod";
export const CreateChannelInputSchema = z.object({
    workspaceId: z.string().min(1),
    name: z.string().min(1).max(120),
    type: z.enum(["public", "private", "broadcast"]),
    description: z.string().max(500).optional(),
});
export const ChannelAddMemberInputSchema = z.object({
    channelId: z.string().min(1),
    userId: z.string().min(1),
});
export const ChannelRemoveMemberInputSchema = z.object({
    channelId: z.string().min(1),
    userId: z.string().min(1),
});
export const ArchiveChannelInputSchema = z.object({
    channelId: z.string().min(1),
});
export const DeleteChannelInputSchema = z.object({
    channelId: z.string().min(1),
});
