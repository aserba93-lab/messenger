import { Router } from "express";
import { z } from "zod";
import { getCookieValue } from "../web/cookies.js";
import { env } from "../config/env.js";
const LoginBodySchema = z.object({
    email: z.string().email(),
    password: z.string().min(1),
    organizationId: z.string().min(1),
    twoFactorCode: z.string().regex(/^[0-9]{6}$/).optional(),
});
const RefreshBodySchema = z.object({
    organizationId: z.string().min(1),
});
export function createAuthRoutes(authService) {
    const router = Router();
    router.post("/login", async (req, res) => {
        try {
            const body = LoginBodySchema.parse(req.body);
            const loginRes = await authService.login(body);
            const out = await authService.finalizeLogin({
                userId: loginRes.user.id,
                organizationId: body.organizationId,
                role: loginRes.membership.role,
                refreshToken: loginRes.refresh.refreshToken,
                refreshTokenHash: loginRes.refresh.refreshTokenHash,
                sessionId: loginRes.refresh.sessionId,
                expiresAt: loginRes.refresh.expiresAt,
                userAgent: req.headers["user-agent"],
                ip: req.headers["x-forwarded-for"] ?? req.socket.remoteAddress ?? undefined,
                response: res,
            });
            return res.status(200).json(out);
        }
        catch (e) {
            return res.status(400).json({
                error: e?.message ?? "Bad request",
            });
        }
    });
    router.post("/refresh", async (req, res) => {
        try {
            const body = RefreshBodySchema.parse(req.body);
            const refreshToken = getCookieValue(req, env.REFRESH_COOKIE_NAME);
            if (!refreshToken)
                return res.status(401).json({ error: "Refresh cookie missing" });
            const out = await authService.refresh({
                organizationId: body.organizationId,
                refreshToken,
                response: res,
                userAgent: req.headers["user-agent"],
                ip: req.headers["x-forwarded-for"] ?? req.socket.remoteAddress ?? undefined,
            });
            return res.status(200).json(out);
        }
        catch (e) {
            return res.status(401).json({
                error: e?.message ?? "Unauthorized",
            });
        }
    });
    router.post("/logout", async (req, res) => {
        try {
            const refreshToken = getCookieValue(req, env.REFRESH_COOKIE_NAME);
            if (!refreshToken)
                return res.status(200).json({ ok: true });
            await authService.logout({ refreshToken, response: res });
            return res.status(200).json({ ok: true });
        }
        catch {
            return res.status(200).json({ ok: true });
        }
    });
    return router;
}
