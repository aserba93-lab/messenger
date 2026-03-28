import { CreateWorkspaceInputSchema, UpdateWorkspaceInputSchema, ArchiveWorkspaceInputSchema, DeleteWorkspaceInputSchema, WorkspaceAddMemberInputSchema, WorkspaceRemoveMemberInputSchema, } from "./schemas.js";
function requireViewer(ctx) {
    if (!ctx?.viewer)
        throw new Error("Unauthorized");
    return ctx.viewer;
}
export const workspacesResolvers = {
    Query: {
        workspaces: async (_p, _a, ctx) => {
            const viewer = requireViewer(ctx);
            return ctx.workspacesService.listWorkspaces(viewer);
        },
        workspaceMembers: async (_p, args, ctx) => {
            const viewer = requireViewer(ctx);
            return ctx.workspacesService.listWorkspaceMembers(viewer, args.workspaceId);
        },
    },
    Mutation: {
        createWorkspace: async (_p, args, ctx) => {
            const viewer = requireViewer(ctx);
            const input = CreateWorkspaceInputSchema.parse(args.input);
            return ctx.workspacesService.createWorkspace(viewer, input);
        },
        updateWorkspace: async (_p, args, ctx) => {
            const viewer = requireViewer(ctx);
            const input = UpdateWorkspaceInputSchema.parse(args.input);
            return ctx.workspacesService.updateWorkspace(viewer, input);
        },
        archiveWorkspace: async (_p, args, ctx) => {
            const viewer = requireViewer(ctx);
            const input = ArchiveWorkspaceInputSchema.parse(args.input);
            return ctx.workspacesService.setWorkspaceArchived(viewer, input);
        },
        deleteWorkspace: async (_p, args, ctx) => {
            const viewer = requireViewer(ctx);
            const input = DeleteWorkspaceInputSchema.parse(args.input);
            return ctx.workspacesService.deleteWorkspace(viewer, input);
        },
        workspaceAddMember: async (_p, args, ctx) => {
            const viewer = requireViewer(ctx);
            const input = WorkspaceAddMemberInputSchema.parse(args.input);
            return ctx.workspacesService.addWorkspaceMember(viewer, input);
        },
        workspaceRemoveMember: async (_p, args, ctx) => {
            const viewer = requireViewer(ctx);
            const input = WorkspaceRemoveMemberInputSchema.parse(args.input);
            return ctx.workspacesService.removeWorkspaceMember(viewer, input);
        },
    },
};
