import { OTP } from "otplib";
import { env } from "../config/env.js";
import { decryptString, encryptString } from "./crypto.js";
const otp = new OTP({ strategy: "totp" });
export function generateTotpSecret() {
    return otp.generateSecret();
}
export function buildOtpAuthUrl(secret, email) {
    return otp.generateURI({
        issuer: env.TOTP_ISSUER,
        label: email,
        secret,
    });
}
export async function encryptTotpSecret(secret) {
    return encryptString(secret, env.TOTP_ENCRYPTION_KEY);
}
export async function decryptTotpSecret(encrypted) {
    return decryptString(encrypted, env.TOTP_ENCRYPTION_KEY);
}
export function verifyTotpCode(secret, code) {
    const res = otp.verifySync({ secret, token: code, digits: 6, period: 30 });
    return res.valid;
}
export async function buildQrDataUri(otpAuthUrl) {
    // `qrcode` is used for generating QR data URI; types may be missing.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const mod = await import("qrcode");
    const qrcode = mod?.default ?? mod;
    return qrcode.toDataURL(otpAuthUrl);
}
