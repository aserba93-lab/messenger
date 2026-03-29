import { MessagesQuerySchema, ThreadQuerySchema, SendMessageInputSchema, ToggleReactionInputSchema, EditMessageInputSchema, DeleteMessageInputSchema, } from "./schemas.js";
import { z } from "zod";
function requireViewer(ctx) {
    if (!ctx?.viewer)
        throw new Error("Unauthorized");
    return ctx.viewer;
}
export const messagesResolvers = {
    Query: {
        messages: async (_p, args, ctx) => {
            const viewer = requireViewer(ctx);
            const input = MessagesQuerySchema.parse({ channelId: args.channelId, cursor: args.cursor ?? undefined, limit: args.limit ?? 50 });
            return ctx.messagesService.listMessages(viewer, input);
        },
        thread: async (_p, args, ctx) => {
            const viewer = requireViewer(ctx);
            const input = ThreadQuerySchema.parse({ parentMessageId: args.parentMessageId, limit: args.limit ?? 50 });
            return ctx.messagesService.listThread(viewer, input);
        },
        searchMessages: async (_p, args, ctx) => {
            const viewer = requireViewer(ctx);
            const query = String(args.query ?? "");
            const limit = Number(args.limit ?? 50);
            return ctx.messagesService.searchMessages(viewer, { query, limit });
        },
    },
    Mutation: {
        sendMessage: async (_p, args, ctx) => {
            const viewer = requireViewer(ctx);
            const input = SendMessageInputSchema.parse(args.input);
            return ctx.messagesService.sendMessage(viewer, input);
        },
        sendFileMessage: async (_p, args, ctx) => {
            const viewer = requireViewer(ctx);
            const input = z
                .object({
                channelId: z.string().min(1),
                fileId: z.string().min(1),
                kind: z.enum(["file", "voice"]),
            })
                .parse(args.input);
            return ctx.messagesService.sendFileMessage(viewer, input);
        },
        editMessage: async (_p, args, ctx) => {
            const viewer = requireViewer(ctx);
            const input = EditMessageInputSchema.parse(args.input);
            return ctx.messagesService.editMessage(viewer, input);
        },
        deleteMessage: async (_p, args, ctx) => {
            const viewer = requireViewer(ctx);
            const input = DeleteMessageInputSchema.parse(args.input);
            return ctx.messagesService.deleteMessage(viewer, input);
        },
        toggleReaction: async (_p, args, ctx) => {
            const viewer = requireViewer(ctx);
            const input = ToggleReactionInputSchema.parse(args.input);
            return ctx.messagesService.toggleReaction(viewer, input);
        },
    },
};
