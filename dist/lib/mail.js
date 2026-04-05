import { env } from "../config/env.js";
export function maskEmail(email) {
    const e = String(email ?? "");
    const at = e.indexOf("@");
    if (at <= 0)
        return "***";
    const local = e.slice(0, at);
    const domain = e.slice(at + 1);
    const vis = local.slice(0, Math.min(2, local.length));
    return `${vis}***@${domain}`;
}
/**
 * Отправка кода входа на почту. Без SMTP в development код пишется в лог.
 */
export async function sendLoginOtpEmail(to, code) {
    const subject = `${env.APP_NAME}: код подтверждения входа`;
    const text = `Ваш код входа: ${code}\n\nКод действует 10 минут. Если вы не входили в сервис, смените пароль.`;
    const host = process.env.SMTP_HOST;
    if (!host) {
        console.warn(`[mail] SMTP_HOST не задан — код входа для ${to}: ${code}`);
        return;
    }
    const nodemailer = await import("nodemailer");
    const port = Number(process.env.SMTP_PORT || 587);
    const secure = String(process.env.SMTP_SECURE || "").toLowerCase() === "true" || port === 465;
    const transporter = nodemailer.createTransport({
        host,
        port,
        secure,
        auth: process.env.SMTP_USER
            ? { user: String(process.env.SMTP_USER), pass: String(process.env.SMTP_PASS ?? "") }
            : undefined,
    });
    const from = process.env.SMTP_FROM || process.env.SMTP_USER || "noreply@localhost";
    await transporter.sendMail({ from, to, subject, text });
}
/** Письмо со ссылкой сброса пароля. Без SMTP — URL в лог (как код входа). */
export async function sendPasswordResetEmail(to, resetUrl) {
    const subject = `${env.APP_NAME}: сброс пароля`;
    const text = `Чтобы задать новый пароль, откройте ссылку в браузере (один раз, срок действия ограничен):\n\n${resetUrl}\n\nЕсли вы не запрашивали сброс, проигнорируйте это письмо.`;
    const host = process.env.SMTP_HOST;
    if (!host) {
        console.warn(`[mail] SMTP_HOST не задан — ссылка сброса пароля для ${to}:\n${resetUrl}`);
        return;
    }
    const nodemailer = await import("nodemailer");
    const port = Number(process.env.SMTP_PORT || 587);
    const secure = String(process.env.SMTP_SECURE || "").toLowerCase() === "true" || port === 465;
    const transporter = nodemailer.createTransport({
        host,
        port,
        secure,
        auth: process.env.SMTP_USER
            ? { user: String(process.env.SMTP_USER), pass: String(process.env.SMTP_PASS ?? "") }
            : undefined,
    });
    const from = process.env.SMTP_FROM || process.env.SMTP_USER || "noreply@localhost";
    await transporter.sendMail({ from, to, subject, text });
}
