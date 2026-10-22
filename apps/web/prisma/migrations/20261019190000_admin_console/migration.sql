-- Phase 34: saved admin-console views are per owner.
CREATE TABLE "AdminSavedView" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "section" TEXT NOT NULL,
    "filtersJson" TEXT NOT NULL DEFAULT '{}',
    "columnsJson" TEXT NOT NULL DEFAULT '[]',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AdminSavedView_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "AdminSavedView_userId_section_name_key" ON "AdminSavedView"("userId", "section", "name");
CREATE INDEX "AdminSavedView_userId_createdAt_idx" ON "AdminSavedView"("userId", "createdAt");

ALTER TABLE "AdminSavedView" ADD CONSTRAINT "AdminSavedView_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
