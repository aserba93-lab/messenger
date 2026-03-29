-- Телефон и статусы в профиле (синхрон с GraphQL / updateUser)
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "phone" TEXT;
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "statusEmoji" TEXT;
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "statusText" TEXT;
