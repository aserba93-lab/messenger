-- CreateTable
CREATE TABLE "ThreadReadState" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "threadKey" TEXT NOT NULL,
    "lastReadAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ThreadReadState_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ThreadReadState_userId_threadKey_key" ON "ThreadReadState"("userId", "threadKey");

-- CreateIndex
CREATE INDEX "ThreadReadState_threadKey_idx" ON "ThreadReadState"("threadKey");

-- CreateIndex
CREATE INDEX "ThreadReadState_organizationId_idx" ON "ThreadReadState"("organizationId");

-- AddForeignKey
ALTER TABLE "ThreadReadState" ADD CONSTRAINT "ThreadReadState_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
