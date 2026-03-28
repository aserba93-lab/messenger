import { env } from "../config/env.js";
export function getCookieValue(req, name) {
    // With cookie-parser, express Request has `cookies`.
    const cookies = req?.cookies;
    if (cookies && typeof cookies[name] === "string")
        return cookies[name];
    const header = req?.headers?.cookie;
    if (!header)
        return undefined;
    // Simple cookie parse: key=value; key2=value2
    const parts = header.split(";").map((p) => p.trim());
    for (const part of parts) {
        const [k, ...rest] = part.split("=");
        if (k === name)
            return decodeURIComponent(rest.join("="));
    }
    return undefined;
}
export function setRefreshCookie(response, value, opts) {
    const domain = env.COOKIE_DOMAIN ? env.COOKIE_DOMAIN : undefined;
    const expires = opts?.revoked ? new Date(0) : undefined;
    const cookie = [
        `${env.REFRESH_COOKIE_NAME}=${encodeURIComponent(value)}`,
        "HttpOnly",
        "Path=/",
        domain ? `Domain=${domain}` : "",
        `SameSite=${env.COOKIE_SAMESITE.charAt(0).toUpperCase()}${env.COOKIE_SAMESITE.slice(1)}`,
        env.COOKIE_SECURE ? "Secure" : "",
        expires ? `Expires=${expires.toUTCString()}` : "",
    ]
        .filter(Boolean)
        .join("; ");
    // Yoga provides WHATWG Response-like object with headers.
    if (typeof response?.headers?.set === "function") {
        response.headers.append("Set-Cookie", cookie);
    }
    else if (typeof response?.setHeader === "function") {
        const prev = response.getHeader("Set-Cookie");
        const nextVal = prev ? [].concat(prev, cookie) : cookie;
        response.setHeader("Set-Cookie", nextVal);
    }
    else {
        // Some GraphQL contexts (custom playground/fetch) may not expose mutable response headers.
        // Do not fail auth flow in this case; access token is still returned in payload.
        // eslint-disable-next-line no-console
        console.warn("Cannot set refresh cookie: response headers not available");
    }
}
