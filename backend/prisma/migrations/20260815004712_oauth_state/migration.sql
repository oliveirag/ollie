-- CreateTable
CREATE TABLE "oauth_state" (
    "id" INTEGER NOT NULL DEFAULT 1,
    "client_id" TEXT NOT NULL,
    "client_secret" TEXT,
    "tokens" JSONB,
    "code_verifier" TEXT,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "oauth_state_pkey" PRIMARY KEY ("id")
);
