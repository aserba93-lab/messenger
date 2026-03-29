import "dotenv/config";
import cors from "cors";
import cookieParser from "cookie-parser";
import express from "express";
import helmet from "helmet";
import http from "http";
import { createYoga } from "graphql-yoga";
import { Server as SocketIOServer } from "socket.io";
import { createAdapter } from "@socket.io/redis-adapter";
import { createSchema } from "graphql-yoga";
import { env } from "./config/env.js";
import { prisma } from "./db/prisma.js";
import { redis } from "./db/redis.js";
import { resolvers } from "./graphql/resolvers.js";
import { typeDefs } from "./graphql/schema.js";
import { verifyAccessToken } from "./security/jwt.js";
import { AuthService } from "./modules/auth/service.js";
import { WorkspacesService } from "./modules/workspaces/service.js";
import { ChannelsService } from "./modules/channels/service.js";
import { MessagesService } from "./modules/messages/service.js";
import { setIo } from "./socket/emitter.js";
import { setupFileStatusBridge } from "./socket/fileStatusBridge.js";
import { renderPlaygroundRuHtml } from "./web/playgroundRu.js";
import { createAuthRoutes } from "./http/authRoutes.js";
import { GroupChatsService } from "./modules/groupChats/service.js";
import { FilesService } from "./modules/files/service.js";
import { DirectChatsService } from "./modules/directChats/service.js";
import { NotificationsService } from "./modules/notifications/service.js";
import fs from "node:fs/promises";
import path from "node:path";
/** Несколько origin из CLIENT_URL + dev-порты Vite */
function buildCorsOriginSet() {
    const set = new Set(String(env.CLIENT_URL || "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean));
    if (env.NODE_ENV !== "production") {
        ["http://localhost:5173", "http://127.0.0.1:5173", "http://localhost:4173", "http://127.0.0.1:4173"].forEach((u) => set.add(u));
    }
    return set;
}
const corsOriginSet = buildCorsOriginSet();
const corsOriginCallback = (origin, cb) => {
    if (!origin)
        return cb(null, true);
    if (corsOriginSet.has(origin))
        return cb(null, true);
    cb(null, false);
};
const authService = new AuthService();
const workspacesService = new WorkspacesService();
const channelsService = new ChannelsService();
const messagesService = new MessagesService();
const groupChatsService = new GroupChatsService();
const filesService = new FilesService();
const directChatsService = new DirectChatsService();
const notificationsService = new NotificationsService();
const app = express();
app.disable("x-powered-by");
// When running behind Nginx/Cloudflare (TLS termination), trust X-Forwarded-* headers.
app.set("trust proxy", 1);
app.use(cors({
    origin: corsOriginCallback,
    credentials: true,
}));
app.use(helmet({
    // GraphiQL for graphql-yoga loads assets from external origins (unpkg/rawgithub).
    // For dev UX we disable CSP. In production you should configure CSP explicitly.
    contentSecurityPolicy: env.NODE_ENV === "production" ? undefined : false,
}));
app.use(express.json({ limit: "1mb" }));
app.use(cookieParser());
app.use("/auth", createAuthRoutes(authService));
app.get("/healthz", (_req, res) => res.status(200).json({ ok: true }));
app.get("/playground-ru", (_req, res) => {
    res.setHeader("content-type", "text/html; charset=utf-8");
    res.status(200).send(renderPlaygroundRuHtml());
});
app.get("/playground-ru/seed-info", async (_req, res) => {
    try {
        const org = await prisma.organization.findFirst({
            where: { domain: "seed.local" },
            orderBy: { createdAt: "desc" },
        });
        if (!org)
            return res.status(404).json({ error: "Seed organization not found" });
        const workspace = await prisma.workspace.findFirst({
            where: { organizationId: org.id, name: "General" },
            orderBy: { createdAt: "desc" },
        });
        const channel = workspace
            ? await prisma.channel.findFirst({
                where: { workspaceId: workspace.id, name: "general" },
                orderBy: { createdAt: "desc" },
            })
            : null;
        return res.status(200).json({
            organizationId: org.id,
            workspaceId: workspace?.id ?? null,
            channelId: channel?.id ?? null,
            adminEmail: "admin@seed.local",
            adminPassword: "SeedPass123!",
        });
    }
    catch (e) {
        return res.status(500).json({ error: e?.message ?? "Internal error" });
    }
});
app.get("/files/local/:fileId", async (req, res) => {
    try {
        const fileId = String(req.params.fileId ?? "");
        if (!fileId)
            return res.status(400).json({ error: "fileId required" });
        const file = await prisma.file.findUnique({ where: { id: fileId } });
        if (!file || !file.url || !file.url.startsWith("/files/local/"))
            return res.status(404).json({ error: "Not found" });
        const diskPath = path.resolve(process.cwd(), ".local_uploads", fileId);
        const body = await fs.readFile(diskPath);
        res.setHeader("content-type", file.mimeType || "application/octet-stream");
        return res.status(200).send(body);
    }
    catch (e) {
        return res.status(500).json({ error: e?.message ?? "Read file failed" });
    }
});
app.put("/files/upload/:fileId", express.raw({ type: "*/*", limit: "200mb" }), async (req, res) => {
    try {
        const authHeader = req.headers.authorization;
        const token = typeof authHeader === "string" && authHeader.startsWith("Bearer ")
            ? authHeader.slice("Bearer ".length)
            : null;
        if (!token)
            return res.status(401).json({ error: "Unauthorized" });
        const payload = verifyAccessToken(token);
        if (!payload)
            return res.status(401).json({ error: "Unauthorized" });
        const membership = await prisma.organizationMember.findUnique({
            where: {
                organizationId_userId: {
                    organizationId: payload.orgId,
                    userId: payload.sub,
                },
            },
        });
        if (!membership || membership.deactivatedAt) {
            return res.status(403).json({ error: "Forbidden" });
        }
        const viewer = {
            userId: payload.sub,
            organizationId: payload.orgId,
            role: membership.role,
            emailVerified: true,
        };
        const fileId = String(req.params.fileId ?? "");
        if (!fileId)
            return res.status(400).json({ error: "fileId required" });
        const contentType = typeof req.headers["content-type"] === "string" ? req.headers["content-type"] : undefined;
        const body = Buffer.isBuffer(req.body) ? req.body : Buffer.from(req.body ?? []);
        await filesService.uploadByProxy(viewer, fileId, body, contentType);
        return res.status(200).json({ ok: true });
    }
    catch (e) {
        return res.status(500).json({ error: e?.message ?? "Upload failed" });
    }
});
const yoga = createYoga({
    schema: createSchema({ typeDefs, resolvers }),
    graphqlEndpoint: "/graphql",
    maskedErrors: {
        maskError: (err) => err,
    },
    context: async ({ request, response }) => {
        const authHeader = request?.headers?.get?.("authorization") ?? undefined;
        const token = authHeader?.startsWith("Bearer ") ? authHeader.slice("Bearer ".length) : undefined;
        const payload = token ? verifyAccessToken(token) : null;
        let viewer = null;
        if (payload) {
            const membership = await prisma.organizationMember.findUnique({
                where: {
                    organizationId_userId: {
                        organizationId: payload.orgId,
                        userId: payload.sub,
                    },
                },
            });
            if (membership && !membership.deactivatedAt) {
                const user = await prisma.user.findUnique({ where: { id: payload.sub }, select: { emailVerifiedAt: true } });
                viewer = {
                    userId: payload.sub,
                    organizationId: payload.orgId,
                    role: payload.role,
                    emailVerified: env.NODE_ENV !== "production" ? true : !!user?.emailVerifiedAt,
                };
            }
        }
        return {
            request,
            response,
            env,
            prisma,
            redis,
            viewer,
            authService,
            workspacesService,
            channelsService,
            messagesService,
            groupChatsService,
            filesService,
            directChatsService,
            notificationsService,
        };
    },
});
app.use(yoga.graphqlEndpoint, yoga);
const server = http.createServer(app);
const io = new SocketIOServer(server, {
    cors: { origin: Array.from(corsOriginSet), credentials: true },
});
setIo(io);
setupFileStatusBridge(redis);
// Socket.io Redis adapter (pub/sub for horizontal scaling)
if (env.ENABLE_SOCKET_REDIS_ADAPTER) {
    const pubClient = redis.duplicate();
    const subClient = redis.duplicate();
    pubClient.on("error", (err) => {
        // eslint-disable-next-line no-console
        console.warn("[redis:pub] error:", err?.message ?? err);
    });
    subClient.on("error", (err) => {
        // eslint-disable-next-line no-console
        console.warn("[redis:sub] error:", err?.message ?? err);
    });
    io.adapter(createAdapter(pubClient, subClient));
}
io.use(async (socket, next) => {
    try {
        const token = typeof socket.handshake.auth?.token === "string" ? socket.handshake.auth.token : undefined;
        if (!token)
            return next(new Error("Unauthorized"));
        const payload = verifyAccessToken(token);
        if (!payload)
            return next(new Error("Unauthorized"));
        const member = await prisma.organizationMember.findUnique({
            where: { organizationId_userId: { organizationId: payload.orgId, userId: payload.sub } },
        });
        if (!member || member.deactivatedAt)
            return next(new Error("Unauthorized"));
        const user = await prisma.user.findUnique({ where: { id: payload.sub }, select: { emailVerifiedAt: true } });
        socket.data.viewer = {
            userId: payload.sub,
            organizationId: payload.orgId,
            role: payload.role,
            emailVerified: env.NODE_ENV !== "production" ? true : !!user?.emailVerifiedAt,
        };
        return next();
    }
    catch {
        return next(new Error("Unauthorized"));
    }
});
io.on("connection", (socket) => {
    const viewer = socket.data.viewer;
    socket.join(`org:${viewer.organizationId}`);
    socket.join(`user:${viewer.userId}`);
    socket.emit("server:hello", { ok: true, userId: viewer.userId });

    // Presence: mark online on connect
    prisma.user
        .update({ where: { id: viewer.userId }, data: { status: "online", lastSeen: new Date() } })
        .then(() => {
        io.to(`org:${viewer.organizationId}`).emit("presence:update", {
            userId: viewer.userId,
            status: "online",
            lastSeen: new Date().toISOString(),
        });
    })
        .catch(() => { });

    socket.on("disconnect", () => {
        prisma.user
            .update({ where: { id: viewer.userId }, data: { status: "offline", lastSeen: new Date() } })
            .then(() => {
            io.to(`org:${viewer.organizationId}`).emit("presence:update", {
                userId: viewer.userId,
                status: "offline",
                lastSeen: new Date().toISOString(),
            });
        })
            .catch(() => { });
    });
    socket.on("channel:join", async (data) => {
        const channelId = String(data?.channelId ?? "");
        if (!channelId)
            return;
        try {
            await messagesService.listMessages(viewer, { channelId, limit: 1 });
            socket.join(`channel:${channelId}`);
            socket.emit("channel:joined", { channelId });
        }
        catch {
            socket.emit("channel:joined", { channelId, ok: false });
        }
    });
    socket.on("group:join", async (data) => {
        const groupChatId = String(data?.groupChatId ?? "");
        if (!groupChatId)
            return;
        try {
            // membership check
            const member = await prisma.groupChatMember.findUnique({
                where: { groupChatId_userId: { groupChatId, userId: viewer.userId } },
            });
            if (!member)
                throw new Error("Forbidden");
            socket.join(`group:${groupChatId}`);
            socket.emit("group:joined", { groupChatId });
        }
        catch {
            socket.emit("group:joined", { groupChatId, ok: false });
        }
    });
    socket.on("dm:join", async (data) => {
        const directChatId = String(data?.directChatId ?? "");
        if (!directChatId)
            return;
        try {
            const member = await prisma.directChatMember.findUnique({
                where: { directChatId_userId: { directChatId, userId: viewer.userId } },
            });
            if (!member)
                throw new Error("Forbidden");
            socket.join(`dm:${directChatId}`);
            socket.emit("dm:joined", { directChatId });
        }
        catch {
            socket.emit("dm:joined", { directChatId, ok: false });
        }
    });
    socket.on("channel:leave", (data) => {
        const channelId = String(data?.channelId ?? "");
        if (!channelId)
            return;
        socket.leave(`channel:${channelId}`);
    });
    socket.on("typing:start", (data) => {
        const channelId = String(data?.channelId ?? "");
        const groupChatId = String(data?.groupChatId ?? "");
        const directChatId = String(data?.directChatId ?? "");
        if (channelId) {
            io.to(`channel:${channelId}`).emit("typing:start", { channelId, userId: viewer.userId });
            return;
        }
        if (groupChatId) {
            // Ensure membership (prevent leaking presence).
            prisma.groupChatMember
                .findUnique({ where: { groupChatId_userId: { groupChatId, userId: viewer.userId } } })
                .then((m) => {
                if (!m)
                    return;
                io.to(`group:${groupChatId}`).emit("typing:start", { groupChatId, userId: viewer.userId });
            })
                .catch(() => { });
            return;
        }
        if (directChatId) {
            prisma.directChatMember
                .findUnique({ where: { directChatId_userId: { directChatId, userId: viewer.userId } } })
                .then((m) => {
                if (!m)
                    return;
                io.to(`dm:${directChatId}`).emit("typing:start", { directChatId, userId: viewer.userId });
            })
                .catch(() => { });
        }
    });
    socket.on("typing:stop", (data) => {
        const channelId = String(data?.channelId ?? "");
        const groupChatId = String(data?.groupChatId ?? "");
        const directChatId = String(data?.directChatId ?? "");
        if (channelId) {
            io.to(`channel:${channelId}`).emit("typing:stop", { channelId, userId: viewer.userId });
            return;
        }
        if (groupChatId) {
            prisma.groupChatMember
                .findUnique({ where: { groupChatId_userId: { groupChatId, userId: viewer.userId } } })
                .then((m) => {
                if (!m)
                    return;
                io.to(`group:${groupChatId}`).emit("typing:stop", { groupChatId, userId: viewer.userId });
            })
                .catch(() => { });
            return;
        }
        if (directChatId) {
            prisma.directChatMember
                .findUnique({ where: { directChatId_userId: { directChatId, userId: viewer.userId } } })
                .then((m) => {
                if (!m)
                    return;
                io.to(`dm:${directChatId}`).emit("typing:stop", { directChatId, userId: viewer.userId });
            })
                .catch(() => { });
        }
    });
});
server.listen(env.PORT, () => {
    // eslint-disable-next-line no-console
    console.log(`API listening on :${env.PORT}`);
});
