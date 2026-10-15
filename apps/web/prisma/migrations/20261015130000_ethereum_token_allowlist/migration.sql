CREATE TABLE "EvmTokenAllowlistEntry" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "chainId" INTEGER NOT NULL,
    "contractAddress" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EvmTokenAllowlistEntry_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "EvmTokenAllowlistEntry_userId_chainId_contractAddress_key"
ON "EvmTokenAllowlistEntry"("userId", "chainId", "contractAddress");

CREATE INDEX "EvmTokenAllowlistEntry_userId_chainId_createdAt_idx"
ON "EvmTokenAllowlistEntry"("userId", "chainId", "createdAt");

ALTER TABLE "EvmTokenAllowlistEntry"
ADD CONSTRAINT "EvmTokenAllowlistEntry_userId_fkey"
FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "EvmPortfolioNetwork" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "chainId" INTEGER NOT NULL,
    "enabledAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EvmPortfolioNetwork_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "EvmPortfolioNetwork_userId_chainId_key"
ON "EvmPortfolioNetwork"("userId", "chainId");

CREATE INDEX "EvmPortfolioNetwork_userId_enabledAt_idx"
ON "EvmPortfolioNetwork"("userId", "enabledAt");

ALTER TABLE "EvmPortfolioNetwork"
ADD CONSTRAINT "EvmPortfolioNetwork_userId_fkey"
FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;