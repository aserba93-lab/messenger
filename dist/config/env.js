import { z } from "zod";
function envBool(defaultValue) {
    return z.preprocess((v) => {
        if (typeof v === "boolean")
            return v;
        if (typeof v === "number")
            return v !== 0;
        if (typeof v === "string") {
            const s = v.trim().toLowerCase();
            if (["true", "1", "yes", "y", "on"].includes(s))
                return true;
            if (["false", "0", "no", "n", "off"].includes(s))
                return false;
        }
        return v;
    }, z.boolean().default(defaultValue));
}
const EnvSchema = z.object({
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
    PORT: z.coerce.number().int().positive().default(3000),
    // Разрешённые Origin для CORS (через запятую), напр.: "https://sf-communication.ru,https://www.sf-communication.ru,http://localhost:5173"
    CLIENT_URL: z.string().min(1).default("https://sf-communication.ru"),
    APP_NAME: z.string().default("CorpMessenger"),
    TOTP_ISSUER: z.string().default("CorpMessenger"),
    DATABASE_URL: z.string().min(1),
    REDIS_URL: z.string().min(1).default("redis://localhost:6379"),
    ENABLE_SOCKET_REDIS_ADAPTER: envBool(false),
    JWT_ACCESS_SECRET: z.string().min(32),
    JWT_REFRESH_SECRET: z.string().min(32),
    JWT_ACCESS_TTL_SECONDS: z.coerce.number().int().positive().default(900),
    JWT_REFRESH_TTL_SECONDS: z.coerce.number().int().positive().default(60 * 60 * 24 * 30),
    COOKIE_DOMAIN: z.string().min(1).optional(),
    REFRESH_COOKIE_NAME: z.string().default("refreshToken"),
    COOKIE_SAMESITE: z.enum(["lax", "strict", "none"]).default("lax"),
    COOKIE_SECURE: envBool(true),
    // Used to encrypt TOTP secrets at rest.
    TOTP_ENCRYPTION_KEY: z.string().min(32),
    // MinIO (S3-compatible)
    MINIO_ENDPOINT: z.string().url(),
    MINIO_REGION: z.string().default("us-east-1"),
    MINIO_BUCKET: z.string().min(1).default("sf-attachments"),
    MINIO_ACCESS_KEY: z.string().min(1),
    MINIO_SECRET_KEY: z.string().min(1),
    MINIO_FORCE_PATH_STYLE: envBool(true),
    /** Если задан, presigned URL (upload/download) для браузера подписываются с этим host (напр. https://sf-communication.ru),
     * а MINIO_ENDPOINT остаётся внутренним (http://127.0.0.1:9000). Нужен nginx proxy с основного домена на MinIO. */
    MINIO_PRESIGN_ENDPOINT: z.preprocess((v) => (v === "" || v === undefined || v === null ? undefined : v), z.string().url().optional()),
    // Files
    FILES_AUTO_MARK_CLEAN: envBool(false),
    FILES_SCAN_PROVIDER: z.enum(["none", "clamd"]).default("none"),
    CLAMD_HOST: z.string().min(1).default("127.0.0.1"),
    CLAMD_PORT: z.coerce.number().int().positive().default(3310),
    CLAMD_TIMEOUT_MS: z.coerce.number().int().positive().default(60_000),
    // Auth hardening
    EMAIL_VERIFY_TOKEN_TTL_SECONDS: z.coerce.number().int().positive().default(60 * 60), // 1h
    LOGIN_MAX_FAILED_ATTEMPTS: z.coerce.number().int().positive().default(5),
    LOGIN_LOCKOUT_SECONDS: z.coerce.number().int().positive().default(15 * 60), // 15m
    MESSAGE_EDIT_WINDOW_SECONDS: z.coerce.number().int().positive().default(48 * 60 * 60),
    /** off — только пароль (+ TOTP если включён); on — после пароля код на email (если нет TOTP). */
    LOGIN_EMAIL_OTP: z.enum(["off", "on"]).default("off"),
    LOGIN_EMAIL_OTP_TTL_SECONDS: z.coerce.number().int().positive().default(600),
    /** Ссылка «сброс пароля» из письма, действует ограниченное время */
    PASSWORD_RESET_TTL_SECONDS: z.coerce.number().int().positive().default(60 * 60),
    /** Legacy FCM server key (Firebase Console → Cloud Messaging) для push на iOS/Android вне приложения */
    FCM_SERVER_KEY: z.string().min(1).optional(),
});
export const env = EnvSchema.parse(process.env);
