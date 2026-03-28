function requireViewer(ctx) {
    if (!ctx?.viewer)
        throw new Error("Unauthorized");
    return ctx.viewer;
}
export const notificationsResolvers = {
    Query: {
        notifications: async (_p, args, ctx) => {
            const viewer = requireViewer(ctx);
            return ctx.notificationsService.list(viewer, Number(args.limit ?? 50));
        },
        notificationPreference: async (_p, args, ctx) => {
            const viewer = requireViewer(ctx);
            return ctx.notificationsService.getPreference(viewer, {
                channelId: args.channelId ?? null,
                groupChatId: args.groupChatId ?? null,
                directChatId: args.directChatId ?? null,
            });
        },
    },
    Mutation: {
        markNotificationRead: async (_p, args, ctx) => {
            const viewer = requireViewer(ctx);
            return ctx.notificationsService.markRead(viewer, String(args.notificationId));
        },
        setNotificationPreference: async (_p, args, ctx) => {
            const viewer = requireViewer(ctx);
            return ctx.notificationsService.setPreference(viewer, args.input);
        },
    },
};
