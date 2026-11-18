// Persistência no Postgres (Prisma). Os objetos continuam com o mesmo formato que o painel já usa:
// cada tabela guarda o objeto inteiro em `dados` e repete à parte só os campos usados em filtros.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { PrismaClient } from '@prisma/client';

export const prisma = new PrismaClient();

const data = (ms) => new Date(Number.isFinite(ms) ? ms : Date.now());
const quando = (iso) => {
  const t = iso ? new Date(iso).getTime() : NaN;
  return Number.isFinite(t) ? new Date(t) : null;
};

/* ---------- Projetos (cortes) ---------- */
export const projetos = {
  async listar() {
    const rows = await prisma.projeto.findMany({ orderBy: { criadoEm: 'desc' } });
    return rows.map((r) => r.dados);
  },
  async obter(id) {
    return (await prisma.projeto.findUnique({ where: { id } }))?.dados ?? null;
  },
  async salvar(p) {
    const row = { nome: p.name || '', dados: p, criadoEm: data(p.createdAt), atualizadoEm: data(p.updatedAt) };
    await prisma.projeto.upsert({ where: { id: p.id }, create: { id: p.id, ...row }, update: row });
    return p;
  },
  async remover(id) {
    await prisma.projeto.deleteMany({ where: { id } });
  },
};

/* ---------- Publicações ---------- */
export const publicacoes = {
  async listar(filtro = {}) {
    const rows = await prisma.publicacao.findMany({ where: filtro, orderBy: { criadoEm: 'desc' } });
    return rows.map((r) => r.dados);
  },
  async obter(id) {
    return (await prisma.publicacao.findUnique({ where: { id } }))?.dados ?? null;
  },
  async salvar(p) {
    p.atualizadoEm = Date.now();
    const row = {
      plataforma: p.plataforma,
      projetoId: p.projeto || null,
      status: p.status,
      agendarEm: quando(p.meta?.agendarEm),
      dados: p,
      criadoEm: data(p.criadoEm),
      atualizadoEm: data(p.atualizadoEm),
    };
    await prisma.publicacao.upsert({ where: { id: p.id }, create: { id: p.id, ...row }, update: row });
    return p;
  },
  async remover(id) {
    await prisma.publicacao.deleteMany({ where: { id } });
  },
};

/* ---------- Cache das respostas do Claude ---------- */
export const chaveDe = (...partes) => crypto.createHash('sha256').update(JSON.stringify(partes)).digest('hex');

/**
 * Devolve a resposta guardada para a mesma `chave`; só chama `gerar()` (e gasta token) se não houver
 * ou se `novo` for true (o usuário pediu outra versão: a nova substitui a guardada).
 */
export async function comCache({ tipo, chave, modelo, novo = false, gerar }) {
  if (!novo) {
    const r = await prisma.respostaIA.findUnique({ where: { chave } });
    if (r) {
      await prisma.respostaIA.update({ where: { chave }, data: { usos: { increment: 1 }, ultimoUsoEm: new Date() } }).catch(() => {});
      return { resultado: r.resultado, doCache: r.criadoEm.toISOString() };
    }
  }
  const resultado = await gerar();
  const row = { tipo, modelo, resultado, criadoEm: new Date(), ultimoUsoEm: new Date() };
  await prisma.respostaIA.upsert({ where: { chave }, create: { chave, ...row }, update: row });
  return { resultado, doCache: null };
}

/* ---------- Sugestões de cortes ---------- */
export const sugestoesCortes = {
  async salvar(chave, job) {
    const row = { chave, src: job.src, status: job.status, dados: job, criadoEm: data(job.criadoEm) };
    await prisma.sugestaoCortes.upsert({ where: { id: job.id }, create: { id: job.id, ...row }, update: row });
  },
  async obter(id) {
    return (await prisma.sugestaoCortes.findUnique({ where: { id } }))?.dados ?? null;
  },
  /** a última sugestão pronta para o mesmo pedido */
  async reaproveitavel(chave) {
    return (await prisma.sugestaoCortes.findFirst({ where: { chave, status: 'pronto' }, orderBy: { criadoEm: 'desc' } }))?.dados ?? null;
  },
};

/* ---------- Plano do dia ---------- */
export const planos = {
  async obter(dia) {
    return (await prisma.planoDia.findUnique({ where: { dia } }))?.dados ?? null;
  },
  async salvar(dia, dados) {
    const row = { dados, geradoEm: quando(dados.geradoEm) || new Date() };
    await prisma.planoDia.upsert({ where: { dia }, create: { dia, ...row }, update: row });
  },
};

/* ---------- Importação única dos JSON antigos (data/projects, data/publicacoes, data/hoje) ---------- */
const lerJsons = async (dir) => {
  if (!fs.existsSync(dir)) return [];
  const nomes = (await fsp.readdir(dir)).filter((n) => n.endsWith('.json'));
  const out = [];
  for (const n of nomes) {
    try { out.push({ nome: n, obj: JSON.parse(await fsp.readFile(path.join(dir, n), 'utf8')) }); } catch {}
  }
  return out;
};

/** Cada tabela só é importada se estiver vazia; os arquivos ficam onde estão, como backup. */
export async function importarJsonAntigos(DATA, log) {
  if (!(await prisma.projeto.count())) {
    const itens = await lerJsons(path.join(DATA, 'projects'));
    for (const { obj } of itens) if (obj?.id) await projetos.salvar(obj);
    if (itens.length) log.info(`${itens.length} cortes importados dos JSON para o Postgres`);
  }
  if (!(await prisma.publicacao.count())) {
    const itens = await lerJsons(path.join(DATA, 'publicacoes'));
    for (const { obj } of itens) {
      if (!obj?.id) continue;
      const atualizadoEm = obj.atualizadoEm;
      await publicacoes.salvar(obj);
      if (atualizadoEm) await prisma.publicacao.update({ where: { id: obj.id }, data: { atualizadoEm: data(atualizadoEm), dados: { ...obj, atualizadoEm } } });
    }
    if (itens.length) log.info(`${itens.length} publicações importadas dos JSON para o Postgres`);
  }
  if (!(await prisma.planoDia.count())) {
    const itens = await lerJsons(path.join(DATA, 'hoje'));
    for (const { nome, obj } of itens) await planos.salvar(nome.replace(/\.json$/, ''), obj);
    if (itens.length) log.info(`${itens.length} planos do dia importados dos JSON para o Postgres`);
  }
}

/* ---------- Produção automática (lotes) ---------- */
export const producoes = {
  async listar() {
    return (await prisma.producao.findMany({ orderBy: { criadoEm: 'desc' }, take: 30 })).map((r) => r.dados);
  },
  async obter(id) {
    return (await prisma.producao.findUnique({ where: { id } }))?.dados ?? null;
  },
  async salvar(p) {
    const row = { status: p.status, dados: p, atualizadoEm: new Date() };
    await prisma.producao.upsert({ where: { id: p.id }, create: { id: p.id, criadoEm: new Date(p.criadoEm), ...row }, update: row });
  },
  async remover(id) {
    await prisma.producao.delete({ where: { id } }).catch(() => {});
  },
};
