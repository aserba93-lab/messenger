import { z } from "zod";
function requireViewer(ctx) {
    if (!ctx?.viewer)
        throw new Error("Unauthorized");
    return ctx.viewer;
}
export const filesResolvers = {
    Query: {
        file: async (_p, args, ctx) => {
            const viewer = requireViewer(ctx);
            const id = z.string().min(1).parse(args.id);
            const { file, downloadUrl } = await ctx.filesService.getFileForViewer(viewer, id);
            return {
                id: file.id,
                mimeType: file.mimeType,
                size: file.size,
                originalName: file.originalName,
                downloadUrl: downloadUrl ?? null,
                avStatus: file.avStatus,
                avCheckedAt: file.avCheckedAt,
                blockedReason: file.blockedReason,
            };
        },
    },
    Mutation: {
        createPresignedUpload: async (_p, args, ctx) => {
            const viewer = requireViewer(ctx);
            const input = z
                .object({
                mimeType: z.string().min(1),
                size: z.number().int().positive(),
                originalName: z.string().min(1).max(500).optional(),
            })
                .parse(args.input);
            return ctx.filesService.createPresignedUpload(viewer, input);
        },
        confirmFileUploaded: async (_p, args, ctx) => {
            const viewer = requireViewer(ctx);
            const fileId = z.string().min(1).parse(args.fileId);
            return ctx.filesService.confirmFileUploaded(viewer, fileId);
        },
        uploadFileBase64: async (_p, args, ctx) => {
            const viewer = requireViewer(ctx);
            const input = z
                .object({
                fileId: z.string().min(1),
                base64: z.string().min(1),
                mimeType: z.string().min(1).optional(),
            })
                .parse(args);
            const body = Buffer.from(input.base64, "base64");
            await ctx.filesService.uploadByProxy(viewer, input.fileId, body, input.mimeType);
            return true;
        },
        markFileScanned: async (_p, args, ctx) => {
            const viewer = requireViewer(ctx);
            if (ctx.env.NODE_ENV === "production")
                throw new Error("Forbidden");
            const input = z
                .object({
                fileId: z.string().min(1),
                status: z.enum(["pending", "clean", "infected", "error", "blocked"]),
                blockedReason: z.string().max(500).optional(),
            })
                .parse(args.input);
            const file = await ctx.prisma.file.findUnique({ where: { id: input.fileId } });
            if (!file || file.organizationId !== viewer.organizationId)
                throw new Error("Not found");
            await ctx.prisma.file.update({
                where: { id: input.fileId },
                data: { avStatus: input.status, avCheckedAt: new Date(), blockedReason: input.blockedReason ?? null },
            });
            return true;
        },
    },
};
