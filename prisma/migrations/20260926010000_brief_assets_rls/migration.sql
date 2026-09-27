-- Brief assets (uploaded files) + row-level security.
--
-- Applied by hand for the same reason as 20260926000000_briefs_rls: the local
-- migrations directory is behind the live database, and `prisma migrate dev`
-- offers to reset the schema to reconcile it, which would destroy data.

-- CreateIndex
CREATE INDEX "briefs_userId_status_idx" ON "briefs"("userId", "status");

-- CreateTable
CREATE TABLE "brief_assets" (
    "id" TEXT NOT NULL,
    "publicId" TEXT NOT NULL,
    "briefId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "fileName" TEXT NOT NULL,
    "contentType" TEXT NOT NULL,
    "fileSizeBytes" INTEGER NOT NULL,
    "storageKey" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "brief_assets_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "brief_assets_publicId_key" ON "brief_assets"("publicId");

-- CreateIndex
CREATE UNIQUE INDEX "brief_assets_storageKey_key" ON "brief_assets"("storageKey");

-- CreateIndex
CREATE INDEX "brief_assets_userId_createdAt_idx" ON "brief_assets"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "brief_assets_briefId_idx" ON "brief_assets"("briefId");

-- AddForeignKey
ALTER TABLE "brief_assets" ADD CONSTRAINT "brief_assets_briefId_fkey" FOREIGN KEY ("briefId") REFERENCES "briefs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "brief_assets" ADD CONSTRAINT "brief_assets_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Row-level security, identical enforcement to the briefs table. The app
-- connects as the table owner, so FORCE is required for the policy to apply.
ALTER TABLE "brief_assets" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "brief_assets" FORCE ROW LEVEL SECURITY;

CREATE POLICY "brief_assets_owner_isolation" ON "brief_assets"
  FOR ALL
  TO PUBLIC
  USING ("userId" = current_setting('app.current_user_id', true))
  WITH CHECK ("userId" = current_setting('app.current_user_id', true));
