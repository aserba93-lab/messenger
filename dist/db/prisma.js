import prismaPkg from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
const { PrismaClient } = prismaPkg;
export const prisma = globalThis.__prisma ??
    new PrismaClient({
        adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }),
        log: process.env.NODE_ENV === "development" ? ["query", "warn", "error"] : ["warn", "error"],
    });
if (process.env.NODE_ENV !== "production")
    globalThis.__prisma = prisma;
