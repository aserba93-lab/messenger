import { CreateChannelInputSchema, ChannelAddMemberInputSchema, ChannelRemoveMemberInputSchema, ArchiveChannelInputSchema, DeleteChannelInputSchema, } from "./schemas.js";
function requireViewer(ctx) {
    if (!ctx?.viewer)
        throw new Error("Unauthorized");
    return ctx.viewer;
}
export const channelsResolvers = {
    Query: {
        channels: async (_p, args, ctx) => {
            const viewer = requireViewer(ctx);
            return ctx.channelsService.listChannels(viewer, { workspaceId: args.workspaceId });
        },
        channelMembers: async (_p, args, ctx) => {
            const viewer = requireViewer(ctx);
            return ctx.channelsService.listChannelMembers(viewer, { channelId: args.channelId });
        },
    },
    Mutation: {
        createChannel: async (_p, args, ctx) => {
            const viewer = requireViewer(ctx);
            const input = CreateChannelInputSchema.parse(args.input);
            return ctx.channelsService.createChannel(viewer, input);
        },
        channelAddMember: async (_p, args, ctx) => {
            const viewer = requireViewer(ctx);
            const input = ChannelAddMemberInputSchema.parse(args.input);
            return ctx.channelsService.addChannelMember(viewer, input);
        },
        channelRemoveMember: async (_p, args, ctx) => {
            const viewer = requireViewer(ctx);
            const input = ChannelRemoveMemberInputSchema.parse(args.input);
            return ctx.channelsService.removeChannelMember(viewer, input);
        },
        archiveChannel: async (_p, args, ctx) => {
            const viewer = requireViewer(ctx);
            const input = ArchiveChannelInputSchema.parse(args.input);
            return ctx.channelsService.archiveChannel(viewer, input);
        },
        deleteChannel: async (_p, args, ctx) => {
            const viewer = requireViewer(ctx);
            const input = DeleteChannelInputSchema.parse(args.input);
            return ctx.channelsService.deleteChannel(viewer, input);
        },
    },
};
