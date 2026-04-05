import { Router } from "express";
import { z } from "zod";
import { getCookieValue } from "../web/cookies.js";
import { env } from "../config/env.js";
const LoginBodySchema = z
    .object({
    email: z.string().email().optional(),
    identifier: z.string().min(3).max(200).optional(),
    password: z.string().min(1),
    /** Необязательно: сервер подставит организацию по домену почты или при единственном членстве. */
    organizationId: z.preprocess((v) => (typeof v === "string" && v.trim() === "" ? undefined : v), z.string().min(1).optional()),
    twoFactorCode: z.string().regex(/^[0-9]{6}$/).optional(),
    backupCode: z.string().min(6).max(64).optional(),
})
    .refine((d) => !!(String(d.email ?? "").trim() || String(d.identifier ?? "").trim()), {
    message: "email or identifier required",
});
const ConfirmEmailBodySchema = z.object({
    challengeId: z.string().min(10),
    code: z.string().regex(/^[0-9]{6}$/),
    organizationId: z.string().min(1),
});
const RefreshBodySchema = z.object({
    organizationId: z.string().min(1),
});
const ForgotPasswordBodySchema = z.object({
    email: z.string().min(3).max(200),
});
const ResetPasswordBodySchema = z.object({
    token: z.string().min(16).max(500),
    newPassword: z.string().min(8).max(200),
});
export function createAuthRoutes(authService) {
    const router = Router();
    router.post("/login", async (req, res) => {
        try {
            const body = LoginBodySchema.parse(req.body);
            const loginRes = await authService.login(body);
            if (loginRes.kind === "email_otp") {
                return res.status(200).json({
                    needsEmailOtp: true,
                    challengeId: loginRes.challengeId,
                    emailMasked: loginRes.emailMasked,
                    organizationId: loginRes.organizationId,
                });
            }
            const out = await authService.finalizeLogin({
                userId: loginRes.user.id,
                organizationId: loginRes.organizationId,
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
    router.post("/login/confirm-email", async (req, res) => {
        try {
            const body = ConfirmEmailBodySchema.parse(req.body);
            const loginRes = await authService.confirmLoginEmailOtp({
                challengeId: body.challengeId,
                code: body.code,
                organizationId: body.organizationId,
            });
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
    /** Запрос письма со ссылкой сброса пароля (всегда 200, без утечки «есть ли email»). */
    router.post("/forgot-password", async (req, res) => {
        try {
            const body = ForgotPasswordBodySchema.safeParse(req.body);
            if (body.success) {
                await authService.requestPasswordReset({ email: body.data.email }).catch(() => { });
            }
        }
        catch {
            /* ignore */
        }
        return res.status(200).json({ ok: true });
    });
    router.post("/reset-password", async (req, res) => {
        try {
            const body = ResetPasswordBodySchema.parse(req.body);
            await authService.resetPasswordWithToken({ token: body.token, newPassword: body.newPassword });
            return res.status(200).json({ ok: true });
        }
        catch (e) {
            return res.status(400).json({
                error: e?.message ?? "Bad request",
            });
        }
    });
    return router;
}
