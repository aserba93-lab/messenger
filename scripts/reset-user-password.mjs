/**
 * Сброс пароля пользователя по email (argon2, как в приложении).
 * Запуск на сервере из корня проекта:
 *   set -a && source .env && set +a
 *   node scripts/reset-user-password.mjs "user@mail.ru" "НовыйПароль"
 */
import argon2 from "argon2";
import pg from "pg";
import { readFileSync, existsSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");

function loadDatabaseUrl() {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  const envPath = join(root, ".env");
  if (!existsSync(envPath)) throw new Error("Нет DATABASE_URL и файла .env");
  const raw = readFileSync(envPath, "utf8");
  const m = raw.match(/^\s*DATABASE_URL\s*=\s*"?([^"\n]+)"?\s*$/m);
  if (!m) throw new Error("В .env не найден DATABASE_URL");
  return m[1].trim();
}

const email = process.argv[2];
const newPassword = process.argv[3];
if (!email || !newPassword) {
  console.error('Использование: node scripts/reset-user-password.mjs "email@mail.ru" "новый_пароль"');
  process.exit(1);
}

const databaseUrl = loadDatabaseUrl();
const hash = await argon2.hash(newPassword);
const client = new pg.Client({ connectionString: databaseUrl });
await client.connect();
try {
  const res = await client.query(
    `UPDATE "User" SET "passwordHash" = $1 WHERE lower(email) = lower($2) RETURNING id, email`,
    [hash, email],
  );
  if (res.rowCount === 0) {
    console.error("Пользователь с таким email не найден.");
    process.exit(2);
  }
  console.log("Пароль обновлён:", res.rows[0]);
} finally {
  await client.end();
}
