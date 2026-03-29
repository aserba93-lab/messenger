import { DateTimeScalar, JSONScalar } from "./scalars.js";
import { authResolvers } from "../modules/auth/resolvers.js";
import { workspacesResolvers } from "../modules/workspaces/resolvers.js";
import { channelsResolvers } from "../modules/channels/resolvers.js";
import { messagesResolvers } from "../modules/messages/resolvers.js";
import { stubsResolvers } from "../modules/stubs/resolvers.js";
import { groupChatsResolvers } from "../modules/groupChats/resolvers.js";
import { filesResolvers } from "../modules/files/resolvers.js";
import { directChatsResolvers } from "../modules/directChats/resolvers.js";
import { messagesExtraResolvers } from "../modules/messages/extraResolvers.js";
import { notificationsResolvers } from "../modules/notifications/resolvers.js";
export const resolvers = {
    DateTime: DateTimeScalar,
    JSON: JSONScalar,
    Message: {
        file: async (parent, _args, ctx) => {
            const viewer = ctx?.viewer;
            if (!viewer)
                return null;
            const fileId = parent?.fileId;
            if (!fileId)
                return null;
            const { file, downloadUrl } = await ctx.filesService.getDownloadUrl(viewer, fileId);
            return {
                id: file.id,
                mimeType: file.mimeType,
                size: file.size,
                originalName: file.originalName,
                downloadUrl,
            };
        },
    },
    DirectChatMessage: {
        editedAt: (parent) => parent?.editedAt ?? parent?.updatedAt ?? null,
        updatedAt: (parent) => parent?.updatedAt ?? null,
        file: async (parent, _args, ctx) => {
            const viewer = ctx?.viewer;
            if (!viewer)
                return null;
            const fileId = parent?.fileId ?? parent?.file?.id ?? null;
            if (!fileId)
                return null;
            const { file, downloadUrl } = await ctx.filesService.getDownloadUrl(viewer, fileId);
            return {
                id: file.id,
                mimeType: file.mimeType,
                size: file.size,
                originalName: file.originalName,
                downloadUrl,
                avStatus: file.avStatus,
                avCheckedAt: file.avCheckedAt,
                blockedReason: file.blockedReason,
            };
        },
    },
    Query: {
        health: () => "ok",
        ...authResolvers.Query,
        ...workspacesResolvers.Query,
        ...channelsResolvers.Query,
        ...messagesResolvers.Query,
        ...groupChatsResolvers.Query,
        ...directChatsResolvers.Query,
        ...filesResolvers.Query,
        ...stubsResolvers.Query,
        ...messagesExtraResolvers.Query,
        ...notificationsResolvers.Query,
    },
    Mutation: {
        ...authResolvers.Mutation,
        ...workspacesResolvers.Mutation,
        ...channelsResolvers.Mutation,
        ...messagesResolvers.Mutation,
        ...groupChatsResolvers.Mutation,
        ...directChatsResolvers.Mutation,
        ...filesResolvers.Mutation,
        ...stubsResolvers.Mutation,
        ...messagesExtraResolvers.Mutation,
        ...notificationsResolvers.Mutation,
    },
};
