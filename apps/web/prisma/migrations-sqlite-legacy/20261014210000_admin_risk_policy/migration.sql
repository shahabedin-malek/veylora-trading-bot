CREATE TABLE "RiskPolicySettings" (
    "id" TEXT NOT NULL PRIMARY KEY DEFAULT 'global',
    "maxRiskPerTradePercent" TEXT NOT NULL DEFAULT '1',
    "maxOpenExposurePercent" TEXT NOT NULL DEFAULT '25',
    "dailyLossHaltPercent" TEXT NOT NULL DEFAULT '2',
    "maxTradesPerDay" INTEGER NOT NULL DEFAULT 10,
    "defaultMaxLeverage" TEXT NOT NULL DEFAULT '1',
    "minimumVerifiedBalanceUsd" TEXT NOT NULL DEFAULT '20',
    "first24HourExposureUsd" TEXT NOT NULL DEFAULT '20',
    "approvedSymbolsJson" TEXT NOT NULL DEFAULT '[]',
        "killSwitchActive" BOOLEAN NOT NULL DEFAULT false,
    "updatedByUserId" TEXT,
    "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "RiskPolicySettings_updatedByUserId_fkey" FOREIGN KEY ("updatedByUserId") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE INDEX "RiskPolicySettings_updatedByUserId_idx" ON "RiskPolicySettings"("updatedByUserId");