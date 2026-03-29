import { CreateGroupChatInputSchema, GroupChatMessagesInputSchema, SendGroupChatMessageInputSchema } from "./schemas.js";
import { z } from "zod";
function requireViewer(ctx) {
    if (!ctx?.viewer)
        throw new Error("Unauthorized");
    return ctx.viewer;
}
export const groupChatsResolvers = {
    Query: {
        groupChats: async (_p, _a, ctx) => {
            const viewer = requireViewer(ctx);
            return ctx.groupChatsService.listGroupChats(viewer);
        },
        groupChatMessages: async (_p, args, ctx) => {
            const viewer = requireViewer(ctx);
            const input = GroupChatMessagesInputSchema.parse({ groupChatId: args.groupChatId, limit: args.limit ?? 50 });
            return ctx.groupChatsService.listMessages(viewer, input);
        },
    },
    Mutation: {
        createGroupChat: async (_p, args, ctx) => {
            const viewer = requireViewer(ctx);
            const input = CreateGroupChatInputSchema.parse(args.input);
            return ctx.groupChatsService.createGroupChat(viewer, input);
        },
        sendGroupChatMessage: async (_p, args, ctx) => {
            const viewer = requireViewer(ctx);
            const input = SendGroupChatMessageInputSchema.parse(args.input);
            return ctx.groupChatsService.sendMessage(viewer, input);
        },
        sendGroupChatFileMessage: async (_p, args, ctx) => {
            const viewer = requireViewer(ctx);
            const input = z
                .object({
                groupChatId: z.string().min(1),
                fileId: z.string().min(1),
                kind: z.enum(["file", "voice"]),
            })
                .parse(args.input);
            return ctx.groupChatsService.sendFileMessage(viewer, input);
        },
        editGroupChatMessage: async (_p, args, ctx) => {
            const viewer = requireViewer(ctx);
            const input = z.object({
                groupChatId: z.string().min(1),
                messageId: z.string().min(1),
                content: z.string().trim().min(1).max(4000),
            }).parse(args);
            return ctx.groupChatsService.editGroupChatMessage(viewer, input);
        },
        deleteGroupChatMessage: async (_p, args, ctx) => {
            const viewer = requireViewer(ctx);
            const input = z.object({
                groupChatId: z.string().min(1),
                messageId: z.string().min(1),
            }).parse(args);
            return ctx.groupChatsService.deleteGroupChatMessage(viewer, input);
        },
        updateGroupChat: async (_p, args, ctx) => {
            const viewer = requireViewer(ctx);
            const input = z
                .object({
                groupChatId: z.string().min(1),
                name: z.string().min(1).max(120).optional(),
                avatarUrl: z
                    .union([z.string().url(), z.string().refine((s) => s.startsWith("data:"), "data URL"), z.literal("")])
                    .optional(),
            })
                .parse(args.input);
            return ctx.groupChatsService.updateGroupChat(viewer, input);
        },
        groupChatAddMembers: async (_p, args, ctx) => {
            const viewer = requireViewer(ctx);
            const input = z
                .object({
                groupChatId: z.string().min(1),
                userIds: z.array(z.string().min(1)).min(1).max(100),
            })
                .parse(args.input);
            return ctx.groupChatsService.addGroupChatMembers(viewer, input);
        },
    },
};
