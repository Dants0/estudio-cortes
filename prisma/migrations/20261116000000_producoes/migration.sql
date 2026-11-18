-- CreateTable
CREATE TABLE "producoes" (
    "id" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "dados" JSONB NOT NULL,
    "criadoEm" TIMESTAMP(3) NOT NULL,
    "atualizadoEm" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "producoes_pkey" PRIMARY KEY ("id")
);
