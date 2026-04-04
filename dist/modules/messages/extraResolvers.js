function requireViewer(ctx) {
    if (!ctx?.viewer)
        throw new Error("Unauthorized");
    return ctx.viewer;
}
export const messagesExtraResolvers = {
    Mutation: {
        markThreadRead: async (_p, args, ctx) => {
            const viewer = requireViewer(ctx);
            return ctx.messagesService.markThreadRead(viewer, args.input ?? {});
        },
        forwardMessages: async (_p, args, ctx) => {
            const viewer = requireViewer(ctx);
            return ctx.messagesService.forwardMessages(viewer, args.input);
        },
        pinMessage: async (_p, args, ctx) => {
            const viewer = requireViewer(ctx);
            return ctx.messagesService.pinMessage(viewer, args.input);
        },
        unpinMessage: async (_p, args, ctx) => {
            const viewer = requireViewer(ctx);
            return ctx.messagesService.unpinMessage(viewer, args.input);
        },
        saveMessage: async (_p, args, ctx) => {
            const viewer = requireViewer(ctx);
            return ctx.messagesService.saveMessage(viewer, String(args.messageId));
        },
        unsaveMessage: async (_p, args, ctx) => {
            const viewer = requireViewer(ctx);
            return ctx.messagesService.unsaveMessage(viewer, String(args.messageId));
        },
    },
    Query: {
        threadReadStates: async (_p, args, ctx) => {
            const viewer = requireViewer(ctx);
            return ctx.messagesService.threadReadStates(viewer, {
                channelId: args.channelId ? String(args.channelId) : null,
                groupChatId: args.groupChatId ? String(args.groupChatId) : null,
                directChatId: args.directChatId ? String(args.directChatId) : null,
            });
        },
        messageReaders: async (_p, args, ctx) => {
            const viewer = requireViewer(ctx);
            return ctx.messagesService.messageReaders(viewer, String(args.messageId ?? ""));
        },
        pinnedMessages: async (_p, args, ctx) => {
            const viewer = requireViewer(ctx);
            return ctx.messagesService.pinnedMessages(viewer, {
                channelId: args.channelId ? String(args.channelId) : null,
                groupChatId: args.groupChatId ? String(args.groupChatId) : null,
                directChatId: args.directChatId ? String(args.directChatId) : null,
                limit: Number(args.limit ?? 10),
            });
        },
        savedMessages: async (_p, args, ctx) => {
            const viewer = requireViewer(ctx);
            return ctx.messagesService.savedMessages(viewer, { limit: Number(args.limit ?? 50) });
        },
        savedMessageIds: async (_p, args, ctx) => {
            const viewer = requireViewer(ctx);
            return ctx.messagesService.savedMessageIds(viewer, { limit: Number(args.limit ?? 200) });
        },
    },
};
