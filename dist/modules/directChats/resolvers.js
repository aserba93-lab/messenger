import { DirectChatMessagesInputSchema, SendDirectMessageInputSchema } from "./schemas.js";
import { z } from "zod";
function requireViewer(ctx) {
    if (!ctx?.viewer)
        throw new Error("Unauthorized");
    return ctx.viewer;
}
export const directChatsResolvers = {
    Query: {
        dms: async (_p, _a, ctx) => {
            const viewer = requireViewer(ctx);
            return ctx.directChatsService.listDirectChats(viewer);
        },
        directChatMessages: async (_p, args, ctx) => {
            const viewer = requireViewer(ctx);
            const input = DirectChatMessagesInputSchema.parse({ directChatId: args.directChatId, limit: args.limit ?? 50 });
            return ctx.directChatsService.listMessages(viewer, input);
        },
    },
    Mutation: {
        ensureDirectChat: async (_p, args, ctx) => {
            const viewer = requireViewer(ctx);
            const input = z.object({ userId: z.string().min(1) }).parse(args);
            return ctx.directChatsService.ensureDirectChat(viewer, input);
        },
        sendDirectMessage: async (_p, args, ctx) => {
            const viewer = requireViewer(ctx);
            const input = SendDirectMessageInputSchema.parse(args.input);
            return ctx.directChatsService.sendDirectMessage(viewer, input);
        },
        sendDirectFileMessage: async (_p, args, ctx) => {
            const viewer = requireViewer(ctx);
            const input = z.object({
                directChatId: z.string().min(1),
                fileId: z.string().min(1),
                kind: z.enum(["file", "voice"]),
            }).parse(args.input);
            return ctx.directChatsService.sendDirectFileMessage(viewer, input);
        },
        editDirectMessage: async (_p, args, ctx) => {
            const viewer = requireViewer(ctx);
            const input = z.object({
                directChatId: z.string().min(1),
                messageId: z.string().min(1),
                content: z.string().trim().min(1).max(4000),
            }).parse(args);
            return ctx.directChatsService.editDirectMessage(viewer, input);
        },
        deleteDirectMessage: async (_p, args, ctx) => {
            const viewer = requireViewer(ctx);
            const input = z.object({
                directChatId: z.string().min(1),
                messageId: z.string().min(1),
            }).parse(args);
            return ctx.directChatsService.deleteDirectMessage(viewer, input);
        },
    },
};
