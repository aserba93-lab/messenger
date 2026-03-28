function requireViewer(ctx) {
    if (!ctx?.viewer)
        throw new Error("Unauthorized");
    return ctx.viewer;
}
export const stubsResolvers = {
    Query: {
        globalSearch: async (_p, args, ctx) => {
            const viewer = requireViewer(ctx);
            const raw = String(args?.query ?? "").trim();
            if (!raw)
                return { users: [], channels: [], messages: [], files: [] };
            const q = raw.slice(0, 200);
            const prisma = ctx.prisma;
            const users = await prisma.user.findMany({
                where: {
                    members: {
                        some: { organizationId: viewer.organizationId, deactivatedAt: null },
                    },
                    OR: [
                        { email: { contains: q, mode: "insensitive" } },
                        { firstName: { contains: q, mode: "insensitive" } },
                        { lastName: { contains: q, mode: "insensitive" } },
                    ],
                },
                take: 10,
                orderBy: { createdAt: "desc" },
            });
            const channels = await prisma.channel.findMany({
                where: {
                    organizationId: viewer.organizationId,
                    isArchived: false,
                    name: { contains: q, mode: "insensitive" },
                    workspace: { members: { some: { userId: viewer.userId } } },
                },
                take: 10,
                orderBy: { createdAt: "desc" },
            });
            const messages = await ctx.messagesService.searchMessages(viewer, { query: q, limit: 20 });
            const fileRows = await prisma.file.findMany({
                where: {
                    organizationId: viewer.organizationId,
                    originalName: { contains: q, mode: "insensitive" },
                },
                select: { id: true },
                take: 10,
                orderBy: { createdAt: "desc" },
            });
            const files = await Promise.all(fileRows.map(async (f) => {
                try {
                    const out = await ctx.filesService.getDownloadUrl(viewer, f.id);
                    return { id: f.id, url: out.downloadUrl };
                }
                catch {
                    return { id: f.id, url: "" };
                }
            }));
            return { users, channels, messages, files };
        },
    },
    Mutation: {
        uploadFileStub: async () => {
            throw new Error("Not implemented");
        },
        startCallStub: async () => {
            throw new Error("Not implemented");
        },
        adminExportStub: async () => {
            throw new Error("Not implemented");
        },
    },
};
