-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateTable
CREATE TABLE "projetos" (
    "id" TEXT NOT NULL,
    "nome" TEXT NOT NULL,
    "dados" JSONB NOT NULL,
    "criadoEm" TIMESTAMP(3) NOT NULL,
    "atualizadoEm" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "projetos_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "publicacoes" (
    "id" TEXT NOT NULL,
    "plataforma" TEXT NOT NULL,
    "projetoId" TEXT,
    "status" TEXT NOT NULL,
    "agendarEm" TIMESTAMP(3),
    "dados" JSONB NOT NULL,
    "criadoEm" TIMESTAMP(3) NOT NULL,
    "atualizadoEm" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "publicacoes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "respostas_ia" (
    "chave" TEXT NOT NULL,
    "tipo" TEXT NOT NULL,
    "modelo" TEXT NOT NULL,
    "resultado" JSONB NOT NULL,
    "usos" INTEGER NOT NULL DEFAULT 0,
    "criadoEm" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ultimoUsoEm" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "respostas_ia_pkey" PRIMARY KEY ("chave")
);

-- CreateTable
CREATE TABLE "sugestoes_cortes" (
    "id" TEXT NOT NULL,
    "chave" TEXT NOT NULL,
    "src" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "dados" JSONB NOT NULL,
    "criadoEm" TIMESTAMP(3) NOT NULL,
    "atualizadoEm" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "sugestoes_cortes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "planos_dia" (
    "dia" TEXT NOT NULL,
    "dados" JSONB NOT NULL,
    "geradoEm" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "planos_dia_pkey" PRIMARY KEY ("dia")
);

-- CreateIndex
CREATE INDEX "publicacoes_projetoId_idx" ON "publicacoes"("projetoId");

-- CreateIndex
CREATE INDEX "publicacoes_status_idx" ON "publicacoes"("status");

-- CreateIndex
CREATE INDEX "respostas_ia_tipo_idx" ON "respostas_ia"("tipo");

-- CreateIndex
CREATE INDEX "sugestoes_cortes_chave_idx" ON "sugestoes_cortes"("chave");

