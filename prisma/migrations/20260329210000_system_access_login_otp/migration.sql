-- CreateEnum
CREATE TYPE "SystemAccessLevel" AS ENUM ('platform', 'organization', 'basic');

-- AlterTable
ALTER TABLE "User" ADD COLUMN "systemAccessLevel" "SystemAccessLevel" NOT NULL DEFAULT 'organization';

-- CreateIndex (unique phone — несколько NULL допустимо в PostgreSQL)
CREATE UNIQUE INDEX IF NOT EXISTS "User_phone_key" ON "User"("phone");

-- CreateTable
CREATE TABLE "LoginEmailOtpChallenge" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "codeHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LoginEmailOtpChallenge_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "LoginEmailOtpChallenge_userId_createdAt_idx" ON "LoginEmailOtpChallenge"("userId", "createdAt");
CREATE INDEX "LoginEmailOtpChallenge_organizationId_createdAt_idx" ON "LoginEmailOtpChallenge"("organizationId", "createdAt");

ALTER TABLE "LoginEmailOtpChallenge" ADD CONSTRAINT "LoginEmailOtpChallenge_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
