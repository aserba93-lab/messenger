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
import { FilesService, inferMimeFromName } from "./modules/files/service.js";
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
        const storedMime = (file.mimeType || "").trim();
        const inferred = inferMimeFromName(file.originalName);
        const contentType =
            storedMime && storedMime !== "application/octet-stream"
                ? storedMime
                : inferred !== "application/octet-stream"
                  ? inferred
                  : storedMime || "application/octet-stream";
        res.setHeader("content-type", contentType);
        res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
        return res.status(200).send(body);
    }
    catch (e) {
        return res.status(500).json({ error: e?.message ?? "Read file failed" });
    }
});
app.get("/files/access/:fileId", async (req, res) => {
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
        const user = await prisma.user.findUnique({ where: { id: payload.sub }, select: { emailVerifiedAt: true } });
        const viewer = {
            userId: payload.sub,
            organizationId: payload.orgId,
            role: membership.role,
            systemAccessLevel: payload.sal ?? "organization",
            emailVerified: env.NODE_ENV !== "production" ? true : !!user?.emailVerifiedAt,
        };
        if (env.NODE_ENV === "production" && !viewer.emailVerified)
            return res.status(403).json({ error: "Email not verified" });
        const fileId = String(req.params.fileId ?? "");
        if (!fileId)
            return res.status(400).json({ error: "fileId required" });
        const { stream, contentType, file } = await filesService.openDownloadStream(viewer, fileId);
        res.setHeader("content-type", contentType);
        res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
        res.setHeader("Content-Disposition", file.originalName
            ? `inline; filename*=UTF-8''${encodeURIComponent(file.originalName)}`
            : "inline");
        stream.on("error", () => {
            if (!res.headersSent)
                res.status(500).json({ error: "Stream failed" });
        });
        stream.pipe(res);
    }
    catch (e) {
        const msg = e?.message ?? String(e);
        if (msg === "Not found")
            return res.status(404).json({ error: "Not found" });
        if (msg === "File not available")
            return res.status(403).json({ error: msg });
        return res.status(500).json({ error: msg || "Read file failed" });
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
            systemAccessLevel: payload.sal ?? "organization",
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
        const rawAuth = request?.headers?.get?.("authorization") ?? request?.headers?.get?.("Authorization") ?? "";
        const token = /^Bearer\s+/i.test(String(rawAuth))
            ? String(rawAuth).replace(/^Bearer\s+/i, "").trim() || undefined
            : undefined;
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
                    systemAccessLevel: payload.sal ?? "organization",
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
/** Локальный счётчик сокетов (одна нода). При ENABLE_SOCKET_REDIS_ADAPTER используется Redis — см. ниже. */
const presenceSocketState = new Map();
const PRESENCE_SOCK_KEY = (userId) => `presence:sockcount:${userId}`;
const PRESENCE_ORG_KEY = (userId) => `presence:org:${userId}`;
const PRESENCE_OFFLINE_MS = 12000;
/** Таймеры отложенного offline только на этой ноде; итог проверяется по Redis или памяти. */
const presenceRedisOfflineTimers = new Map();
function presenceEmitOffline(userId, orgId) {
    prisma.user
        .update({ where: { id: userId }, data: { status: "offline", lastSeen: new Date() } })
        .then(() => {
        io.to(`org:${orgId}`).emit("presence:update", {
            userId,
            status: "offline",
            lastSeen: new Date().toISOString(),
        });
    })
        .catch(() => { });
}
function presenceRegisterSocketMemory(userId, orgId) {
    let rec = presenceSocketState.get(userId);
    if (!rec) {
        rec = { count: 0, orgId, offlineTimer: null };
        presenceSocketState.set(userId, rec);
    }
    if (rec.offlineTimer) {
        clearTimeout(rec.offlineTimer);
        rec.offlineTimer = null;
    }
    const firstSocket = rec.count === 0;
    rec.count += 1;
    rec.orgId = orgId;
    return { firstSocket };
}
function presenceUnregisterSocketMemory(userId) {
    const rec = presenceSocketState.get(userId);
    if (!rec || rec.count <= 0)
        return;
    rec.count -= 1;
    if (rec.count > 0)
        return;
    const orgId = rec.orgId;
    rec.offlineTimer = setTimeout(() => {
        const r = presenceSocketState.get(userId);
        if (!r || r.count > 0)
            return;
        presenceSocketState.delete(userId);
        presenceEmitOffline(userId, orgId);
    }, PRESENCE_OFFLINE_MS);
}
async function presenceRegisterSocketRedis(userId, orgId) {
    const t = presenceRedisOfflineTimers.get(userId);
    if (t) {
        clearTimeout(t);
        presenceRedisOfflineTimers.delete(userId);
    }
    const count = await redis.incr(PRESENCE_SOCK_KEY(userId));
    await redis.set(PRESENCE_ORG_KEY(userId), orgId);
    return { firstSocket: count === 1 };
}
async function presenceUnregisterSocketRedis(userId) {
    const sockKey = PRESENCE_SOCK_KEY(userId);
    const v = await redis.decr(sockKey);
    if (v < 0) {
        await redis.set(sockKey, "0");
    }
    if (v > 0)
        return;
    const orgId = await redis.get(PRESENCE_ORG_KEY(userId));
    if (!orgId)
        return;
    const timer = setTimeout(() => {
        presenceRedisOfflineTimers.delete(userId);
        void (async () => {
            const raw = await redis.get(sockKey);
            const n = parseInt(String(raw ?? "0"), 10);
            if (n > 0)
                return;
            presenceEmitOffline(userId, orgId);
        })();
    }, PRESENCE_OFFLINE_MS);
    presenceRedisOfflineTimers.set(userId, timer);
}
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
            systemAccessLevel: payload.sal ?? "organization",
            emailVerified: env.NODE_ENV !== "production" ? true : !!user?.emailVerifiedAt,
        };
        return next();
    }
    catch {
        return next(new Error("Unauthorized"));
    }
});
io.on("connection", async (socket) => {
    const viewer = socket.data.viewer;
    socket.join(`org:${viewer.organizationId}`);
    socket.join(`user:${viewer.userId}`);
    socket.emit("server:hello", { ok: true, userId: viewer.userId });
    let firstSocket = false;
    try {
        if (env.ENABLE_SOCKET_REDIS_ADAPTER) {
            firstSocket = (await presenceRegisterSocketRedis(viewer.userId, viewer.organizationId)).firstSocket;
        }
        else {
            firstSocket = presenceRegisterSocketMemory(viewer.userId, viewer.organizationId).firstSocket;
        }
    }
    catch (e) {
        // eslint-disable-next-line no-console
        console.warn("[presence] register failed, memory fallback:", e?.message ?? e);
        firstSocket = presenceRegisterSocketMemory(viewer.userId, viewer.organizationId).firstSocket;
    }

    /** Актуальные статусы всех участников орг. из БД — иначе клиент видит «не в сети», пока кто-то снова не переподключится. */
    prisma.organizationMember
        .findMany({
        where: { organizationId: viewer.organizationId, deactivatedAt: null },
        select: { user: { select: { id: true, status: true, lastSeen: true } } },
    })
        .then((members) => {
        socket.emit("presence:snapshot", {
            items: members.map((m) => ({
                userId: m.user.id,
                status: m.user.status,
                lastSeen: m.user.lastSeen ? m.user.lastSeen.toISOString() : null,
            })),
        });
    })
        .catch(() => { });

    // Presence: в БД «online» при каждом подключении; в чат рассылаем «online» только при первом сокете (меньше шума).
    prisma.user
        .update({ where: { id: viewer.userId }, data: { status: "online", lastSeen: new Date() } })
        .then(() => {
        if (firstSocket) {
            io.to(`org:${viewer.organizationId}`).emit("presence:update", {
                userId: viewer.userId,
                status: "online",
                lastSeen: new Date().toISOString(),
            });
        }
    })
        .catch(() => { });

    socket.on("disconnect", () => {
        if (env.ENABLE_SOCKET_REDIS_ADAPTER) {
            void presenceUnregisterSocketRedis(viewer.userId).catch((e) => {
                // eslint-disable-next-line no-console
                console.warn("[presence] unregister redis failed:", e?.message ?? e);
            });
        }
        else {
            presenceUnregisterSocketMemory(viewer.userId);
        }
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
    async function assertSameOrganizationPeer(targetUserId) {
        if (!targetUserId || targetUserId === viewer.userId)
            return false;
        const peer = await prisma.organizationMember.findFirst({
            where: {
                organizationId: viewer.organizationId,
                userId: targetUserId,
                deactivatedAt: null,
            },
        });
        return !!peer;
    }
    /** Уведомление участников группы о начале созвона (без SDP): ссылка и toast на клиенте */
    socket.on("groupCall:invite", async (data) => {
        const groupChatId = String(data?.groupChatId ?? "");
        const audioOnly = Boolean(data?.audioOnly);
        const inviteUrl = String(data?.inviteUrl ?? "");
        if (!groupChatId)
            return;
        try {
            const member = await prisma.groupChatMember.findUnique({
                where: { groupChatId_userId: { groupChatId, userId: viewer.userId } },
            });
            if (!member)
                return;
            socket.to(`group:${groupChatId}`).emit("groupCall:invite", {
                fromUserId: viewer.userId,
                groupChatId,
                audioOnly,
                inviteUrl,
            });
        }
        catch {
            /* ignore */
        }
    });
    /** WebRTC сигналинг (1:1): клиент шлёт targetUserId + SDP/ICE, сервер пересылает адресату */
    socket.on("call:signal", async (data) => {
        const targetUserId = String(data?.targetUserId ?? "");
        const payload = data?.payload;
        if (!targetUserId || payload == null)
            return;
        try {
            if (!(await assertSameOrganizationPeer(targetUserId)))
                return;
        }
        catch {
            return;
        }
        const out = {
            fromUserId: viewer.userId,
            payload,
        };
        const gcid = data?.groupChatId;
        if (gcid != null && String(gcid).trim())
            out.groupChatId = String(gcid);
        io.to(`user:${targetUserId}`).emit("call:signal", out);
    });
    socket.on("call:end", async (data) => {
        const targetUserId = String(data?.targetUserId ?? "");
        if (!targetUserId)
            return;
        try {
            if (!(await assertSameOrganizationPeer(targetUserId)))
                return;
        }
        catch {
            return;
        }
        io.to(`user:${targetUserId}`).emit("call:end", { fromUserId: viewer.userId });
    });
    /** Поднять руку в созвоне (1:1): пересылаем собеседнику */
    socket.on("call:hand", async (data) => {
        const targetUserId = String(data?.targetUserId ?? "");
        if (!targetUserId)
            return;
        try {
            if (!(await assertSameOrganizationPeer(targetUserId)))
                return;
        }
        catch {
            return;
        }
        const raised = Boolean(data?.raised);
        io.to(`user:${targetUserId}`).emit("call:hand", {
            fromUserId: viewer.userId,
            raised,
        });
    });
    /** Поднять руку в групповом созвоне: всем в комнате группы, кроме отправителя */
    socket.on("groupCall:hand", async (data) => {
        const groupChatId = String(data?.groupChatId ?? "");
        const raised = Boolean(data?.raised);
        if (!groupChatId)
            return;
        try {
            const member = await prisma.groupChatMember.findUnique({
                where: { groupChatId_userId: { groupChatId, userId: viewer.userId } },
            });
            if (!member)
                return;
            socket.to(`group:${groupChatId}`).emit("groupCall:hand", {
                fromUserId: viewer.userId,
                groupChatId,
                raised,
            });
        }
        catch {
            /* ignore */
        }
    });
});
server.listen(env.PORT, () => {
    // eslint-disable-next-line no-console
    console.log(`API listening on :${env.PORT}`);
});
