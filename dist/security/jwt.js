import jwt from "jsonwebtoken";
import { env } from "../config/env.js";
export function issueAccessToken(payload) {
    return jwt.sign(payload, env.JWT_ACCESS_SECRET, {
        expiresIn: env.JWT_ACCESS_TTL_SECONDS,
        issuer: env.APP_NAME,
    });
}
export function issueRefreshToken(payload) {
    return jwt.sign(payload, env.JWT_REFRESH_SECRET, {
        expiresIn: env.JWT_REFRESH_TTL_SECONDS,
        issuer: env.APP_NAME,
    });
}
export function verifyAccessToken(token) {
    try {
        return jwt.verify(token, env.JWT_ACCESS_SECRET, { issuer: env.APP_NAME });
    }
    catch {
        return null;
    }
}
export function verifyRefreshToken(token) {
    try {
        return jwt.verify(token, env.JWT_REFRESH_SECRET, { issuer: env.APP_NAME });
    }
    catch {
        return null;
    }
}
