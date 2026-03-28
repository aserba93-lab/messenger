import crypto from "crypto";
const ALGO = "aes-256-gcm";
export function encryptString(plainText, key) {
    const iv = crypto.randomBytes(12);
    const k = crypto.createHash("sha256").update(key).digest();
    const cipher = crypto.createCipheriv(ALGO, k, iv);
    const encrypted = Buffer.concat([cipher.update(plainText, "utf8"), cipher.final()]);
    const tag = cipher.getAuthTag();
    // Format: base64(iv).base64(tag).base64(ciphertext)
    return `${iv.toString("base64")}.${tag.toString("base64")}.${encrypted.toString("base64")}`;
}
export function decryptString(payload, key) {
    const [ivB64, tagB64, dataB64] = payload.split(".");
    if (!ivB64 || !tagB64 || !dataB64)
        throw new Error("Invalid encrypted payload");
    const iv = Buffer.from(ivB64, "base64");
    const tag = Buffer.from(tagB64, "base64");
    const data = Buffer.from(dataB64, "base64");
    const k = crypto.createHash("sha256").update(key).digest();
    const decipher = crypto.createDecipheriv(ALGO, k, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(data), decipher.final()]).toString("utf8");
}
