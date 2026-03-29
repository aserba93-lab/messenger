-- Синхронизация БД со схемой: профиль пользователя и аватары чатов
-- (ранее поля были только в schema.prisma без миграции)

ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "middleName" TEXT;
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "birthDate" TIMESTAMP(3);
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "emailVerifiedAt" TIMESTAMP(3);
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "failedLoginAttempts" INTEGER DEFAULT 0;
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "lockedUntil" TIMESTAMP(3);

ALTER TABLE "Channel" ADD COLUMN IF NOT EXISTS "avatarUrl" TEXT;
ALTER TABLE "Channel" ADD COLUMN IF NOT EXISTS "description" TEXT;
ALTER TABLE "Channel" ADD COLUMN IF NOT EXISTS "isSystem" BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "GroupChat" ADD COLUMN IF NOT EXISTS "avatarUrl" TEXT;
