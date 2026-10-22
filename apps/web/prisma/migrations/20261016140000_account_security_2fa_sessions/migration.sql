-- Phase 10: the owner's account on its own terms — scoped two-factor, and
-- sessions that can be listed and ended one at a time.
--
-- Four tables, and what each one is for:
--
--   * `AuthSession` — one row per signed-in device. Until now a session was a
--     signed cookie naming the account and the account's `sessionVersion`, which
--     can only end *every* session at once. The cookie now also names a row here,
--     resolved on every request, so a revoked row stops that one device on its
--     next use and the others are untouched. `deviceLabel` is what the owner
--     recognises in the list; `userAgent` and `ipAddress` are the observations
--     behind it. `totpVerifiedAt` / `totpLastStep` record the last code accepted
--     in that session and which time step it was, which is what stops one code
--     being presented twice.
--
--   * `TotpCredential` — one authenticator per account. The secret is sealed with
--     the deployment's AES-256-GCM key under its own associated data, so a
--     ciphertext cannot be moved between this purpose and the venue-credential
--     vault. `lastUsedStep` is replay protection; `failedAttempts` / `lockedUntil`
--     are the lockout, both cleared by any accepted code.
--
--   * `TotpBackupCode` — digests only, so the codes are readable exactly once,
--     when they are issued. `usedAt` is what makes each one single-use.
--
--   * `SecurityPolicySettings` — the three scope switches, how long a verification
--     counts, and the lockout numbers, all as data the owner edits. Every default
--     is off or permissive: this phase adds no requirement that cannot be turned
--     off, and a deployment that never writes this row behaves as if the scopes
--     were off, which is what they default to.
--
-- No enum anywhere, for the same reason no other state column here is one:
-- `scripts/dev-database.mjs` refuses to derive the SQLite development schema from
-- a file containing an enum, so the scope names and revocation reasons live in
-- `src/lib/auth/security-policy.ts` and `src/lib/auth/session-record.ts`.
--
-- Rollback: drop the four tables. Sign-in returns to the phase 07/09 behaviour —
-- a stateless cookie, no 2FA requirement, no session list.

-- CreateTable
CREATE TABLE "AuthSession" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "walletIdentityId" TEXT NOT NULL,
    "chainNamespace" TEXT NOT NULL,
    "chainReference" TEXT NOT NULL,
    "deviceLabel" TEXT NOT NULL,
    "userAgent" TEXT,
    "ipAddress" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "totpVerifiedAt" TIMESTAMP(3),
    "totpLastStep" INTEGER,
    "revokedAt" TIMESTAMP(3),
    "revokedReason" TEXT,

    CONSTRAINT "AuthSession_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TotpCredential" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "secretCiphertext" TEXT NOT NULL,
    "secretIv" TEXT NOT NULL,
    "secretAuthTag" TEXT NOT NULL,
    "digits" INTEGER NOT NULL DEFAULT 6,
    "periodSeconds" INTEGER NOT NULL DEFAULT 30,
    "algorithm" TEXT NOT NULL DEFAULT 'SHA1',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "activatedAt" TIMESTAMP(3),
    "lastUsedAt" TIMESTAMP(3),
    "lastUsedStep" INTEGER,
    "failedAttempts" INTEGER NOT NULL DEFAULT 0,
    "lockedUntil" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),

    CONSTRAINT "TotpCredential_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TotpBackupCode" (
    "id" TEXT NOT NULL,
    "credentialId" TEXT NOT NULL,
    "codeHash" TEXT NOT NULL,
    "issuedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "usedAt" TIMESTAMP(3),

    CONSTRAINT "TotpBackupCode_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SecurityPolicySettings" (
    "id" TEXT NOT NULL DEFAULT 'global',
    "requireTotpForSignIn" BOOLEAN NOT NULL DEFAULT false,
    "requireTotpForTrading" BOOLEAN NOT NULL DEFAULT false,
    "requireTotpForFunding" BOOLEAN NOT NULL DEFAULT false,
    "stepUpMinutes" INTEGER NOT NULL DEFAULT 15,
    "maxFailedAttempts" INTEGER NOT NULL DEFAULT 5,
    "lockoutMinutes" INTEGER NOT NULL DEFAULT 15,
    "updatedByUserId" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SecurityPolicySettings_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AuthSession_userId_revokedAt_idx" ON "AuthSession"("userId", "revokedAt");

-- CreateIndex
CREATE INDEX "AuthSession_expiresAt_idx" ON "AuthSession"("expiresAt");

-- CreateIndex
CREATE INDEX "TotpCredential_userId_revokedAt_idx" ON "TotpCredential"("userId", "revokedAt");

-- CreateIndex
CREATE UNIQUE INDEX "TotpBackupCode_credentialId_codeHash_key" ON "TotpBackupCode"("credentialId", "codeHash");

-- CreateIndex
CREATE INDEX "TotpBackupCode_credentialId_usedAt_idx" ON "TotpBackupCode"("credentialId", "usedAt");

-- CreateIndex
CREATE INDEX "SecurityPolicySettings_updatedByUserId_idx" ON "SecurityPolicySettings"("updatedByUserId");

-- AddForeignKey
ALTER TABLE "AuthSession" ADD CONSTRAINT "AuthSession_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TotpCredential" ADD CONSTRAINT "TotpCredential_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TotpBackupCode" ADD CONSTRAINT "TotpBackupCode_credentialId_fkey" FOREIGN KEY ("credentialId") REFERENCES "TotpCredential"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SecurityPolicySettings" ADD CONSTRAINT "SecurityPolicySettings_updatedByUserId_fkey" FOREIGN KEY ("updatedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
