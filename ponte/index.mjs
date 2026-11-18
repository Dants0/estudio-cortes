// Ponte PhotoCraft: roda no Windows (fora do Docker), porque o PhotoCraft é um .exe.
// O painel (no container) chama http://host.docker.internal:3101 e esta ponte usa o
// Claude Agent SDK com o MCP do PhotoCraft para montar as thumbnails.
//
//   npm run ponte        (ou ponte\iniciar-ponte.bat)
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { editarNoFilmCraft } from './filmcraft.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// lê o .env da raiz (sem dependência extra)
const envFile = path.join(ROOT, '.env');
const INICIO = Date.now();
// .env alterado depois que a ponte abriu (ex.: token novo): ela precisa ser reaberta
const envMudou = () => { try { return fs.statSync(envFile).mtimeMs > INICIO + 1000; } catch { return false; } };
if (fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, 'utf8').split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (m && !(m[1] in process.env) && m[2] !== '') process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

const PORT = Number(process.env.PONTE_PORT || 3101);
const TOKEN = process.env.PONTE_TOKEN || '';
const DATA = path.resolve(process.env.PONTE_DATA_DIR || path.join(ROOT, 'data'));
const PHOTOCRAFT = process.env.PHOTOCRAFT_CLI || 'D:\\PhotoCraft\\PhotoCraft\\photocraft-cli.exe';
const MODEL = process.env.CLAUDE_MODEL || 'claude-opus-5-5';
const FILMCRAFT = process.env.FILMCRAFT_CLI || 'D:\\FilmCraft\\FilmCraft\\filmcraft-cli.exe';
// a mesma pasta D:\Videos que o painel monta em /videos
const VIDEOS = path.resolve(process.env.VIDEOS_HOST_DIR || 'D:/Videos');

if (!TOKEN) {
  console.error('Defina PONTE_TOKEN no .env (o mesmo valor que o painel usa).');
  process.exit(1);
}
if (!fs.existsSync(PHOTOCRAFT)) console.warn(`PhotoCraft não encontrado em ${PHOTOCRAFT}: thumbnails desligadas. Ajuste PHOTOCRAFT_CLI no .env.`);
if (!fs.existsSync(FILMCRAFT)) console.warn(`FilmCraft não encontrado em ${FILMCRAFT}: edição automática desligada. Ajuste FILMCRAFT_CLI no .env.`);

// instruções do seu agente thumbnail-designer, sem o cabeçalho
const designerFile = path.join(os.homedir(), '.claude', 'agents', 'thumbnail-designer.md');
const designer = fs.existsSync(designerFile)
  ? fs.readFileSync(designerFile, 'utf8').replace(/^---[\s\S]*?---\s*/, '')
  : 'Você é designer de thumbnails de YouTube (1280x720) com foco em CTR.';

const SYSTEM = `${designer}

## Regras deste painel (têm prioridade sobre as de cima)
- Use só as ferramentas do PhotoCraft que você tem aqui (mcp__photocraft__*). Não há FilmCraft, Runway, shell nem acesso a outras pastas.
- O PhotoCraft só lê e grava dentro de ${DATA}. Use caminhos absolutos dentro dessa pasta.
- O frame do vídeo já foi exportado em resolução cheia pelo painel; use os frames informados no pedido.
- Salve cada variação como JPG 1280x720 com menos de 2 MB, exatamente nos caminhos pedidos. Salve também o .pcraft de trabalho na mesma pasta.
- Não pergunte nada: decida e explique na resposta final.`;

const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['variacoes', 'recomendada', 'conferir'],
  properties: {
    variacoes: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['letra', 'arquivo', 'testa'],
        properties: { letra: { type: 'string' }, arquivo: { type: 'string' }, testa: { type: 'string' } },
      },
    },
    recomendada: { type: 'string' },
    motivo: { type: 'string' },
    conferir: { type: 'array', items: { type: 'string' } },
  },
};

const inData = (p) => {
  const abs = path.resolve(DATA, p);
  if (!abs.startsWith(DATA + path.sep)) throw new Error('Caminho fora da pasta de dados');
  return abs;
};

const jobs = new Map();
const fcJobs = new Map();
let fcFila = Promise.resolve();

/** { raiz: 'dados' | 'videos', rel } → caminho absoluto, sem sair da pasta */
const resolverMidia = (m) => {
  const raiz = m?.raiz === 'videos' ? VIDEOS : m?.raiz === 'dados' ? DATA : null;
  if (!raiz || typeof m.rel !== 'string') throw new Error('Mídia inválida');
  const abs = path.resolve(raiz, m.rel);
  if (!abs.startsWith(raiz + path.sep)) throw new Error('Caminho fora da pasta permitida');
  if (!fs.existsSync(abs)) throw new Error(`Arquivo não encontrado: ${m.rel}`);
  return abs;
};

async function gerar(job) {
  const { frames, titulo, texto, jogo, pasta, quantidade, briefing } = job.pedido;
  const outDir = inData(pasta);
  fs.mkdirSync(outDir, { recursive: true });
  const letras = ['A', 'B', 'C'].slice(0, quantidade);
  const alvos = letras.map((l) => path.join(outDir, `thumbnail ${l}.jpg`));
  const prompt = [
    `Crie ${quantidade} variações de thumbnail para este vídeo do YouTube.`,
    `Título do vídeo: ${titulo}`,
    jogo ? `Jogo: ${jogo}` : null,
    briefing ? `Briefing (o Claude do painel já assistiu o vídeo e escolheu os frames):
${briefing}` : null,
    texto ? `Texto sugerido para a thumbnail (até 3 palavras): ${texto}` : 'Escolha você o texto da thumbnail (até 3 palavras, complementando o título).',
    `Frames disponíveis (resolução cheia):\n${frames.map((f) => `- ${inData(f)}`).join('\n')}`,
    `Salve as variações em:\n${alvos.map((a, i) => `- ${letras[i]}: ${a}`).join('\n')}`,
    'Na resposta, o campo "arquivo" de cada variação é o caminho absoluto salvo.',
  ].filter(Boolean).join('\n\n');

  const run = query({
    prompt,
    options: {
      model: MODEL,
      systemPrompt: SYSTEM,
      tools: [],
      settingSources: [],
      mcpServers: {
        photocraft: {
          type: 'stdio',
          command: PHOTOCRAFT,
          args: ['mcp', '--automation-read-root', DATA, '--automation-write-root', DATA],
        },
      },
      allowedTools: ['mcp__photocraft__*'],
      permissionMode: 'dontAsk',
      maxTurns: 80,
      outputFormat: { type: 'json_schema', schema: SCHEMA },
      abortController: job.abort,
      env: { ...process.env },
    },
  });

  for await (const msg of run) {
    if (msg.type === 'assistant') {
      const uso = msg.message?.content?.filter((b) => b.type === 'tool_use').map((b) => b.name.replace('mcp__photocraft__', '')) || [];
      if (uso.length) job.etapas.push(...uso);
    }
    if (msg.type !== 'result') continue;
    const texto = String(msg.result || '');
    if (/failed to authenticate|token (revoked|expired)|please log in|invalid api key|oauth/i.test(texto) && !msg.structured_output) {
      throw new Error('O token do Claude da ponte é inválido ou foi revogado. Atualize CLAUDE_CODE_OAUTH_TOKEN no .env e reabra a ponte (iniciar-ponte.bat).');
    }
    let out = msg.structured_output;
    // às vezes o JSON vem só no texto final
    if (!out && msg.subtype === 'success') {
      try { out = JSON.parse((texto.match(/\{[\s\S]*\}/) || [])[0]); } catch {}
    }
    if (!out?.variacoes) throw new Error(`O Claude não terminou (${msg.subtype})${texto ? `: ${texto.slice(0, 200)}` : ''}.`);
    // devolve caminhos relativos à pasta de dados, e só os que existem de verdade
    out.variacoes = out.variacoes
      .map((v) => ({ ...v, arquivo: path.relative(DATA, path.resolve(v.arquivo)).split(path.sep).join('/') }))
      .filter((v) => !v.arquivo.startsWith('..') && fs.existsSync(path.join(DATA, v.arquivo)));
    if (!out.variacoes.length) throw new Error('Nenhuma thumbnail foi salva.');
    return out;
  }
  throw new Error('O Claude encerrou sem resposta.');
}

const send = (res, status, body) => {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
};

const server = http.createServer(async (req, res) => {
  const auth = req.headers.authorization || '';
  const ok = auth.length === TOKEN.length + 7 && crypto.timingSafeEqual(Buffer.from(auth), Buffer.from(`Bearer ${TOKEN}`));
  if (!ok) return send(res, 401, { error: 'Token da ponte inválido' });

  if (req.method === 'GET' && req.url === '/status') {
    return send(res, 200, { ok: true, photocraft: fs.existsSync(PHOTOCRAFT), filmcraft: fs.existsSync(FILMCRAFT), dados: DATA, versao: 3, reabrir: envMudou() });
  }

  // ---------- FilmCraft: aplica o plano de edição (um corte por vez) ----------
  const mf = /^\/filmcraft\/([a-f0-9]{8})$/.exec(req.url || '');
  if (req.method === 'GET' && mf) {
    const j = fcJobs.get(mf[1]);
    if (!j) return send(res, 404, { error: 'Edição não encontrada (a ponte reiniciou?)' });
    const { pedido, ...pub } = j;
    return send(res, 200, pub);
  }
  if (req.method === 'POST' && req.url === '/filmcraft') {
    if (!fs.existsSync(FILMCRAFT)) return send(res, 503, { error: `FilmCraft não encontrado em ${FILMCRAFT}.` });
    let raw = '';
    for await (const c of req) { raw += c; if (raw.length > 200_000) return send(res, 413, { error: 'Pedido grande demais' }); }
    let p;
    try { p = JSON.parse(raw); } catch { return send(res, 400, { error: 'JSON inválido' }); }
    let pedido;
    try {
      if (!Array.isArray(p.segmentos) || !p.segmentos.length || !/^[a-z0-9-]{1,60}$/.test(p.nome || '')) throw new Error('Faltam segmentos ou nome.');
      pedido = {
        fonte: resolverMidia(p.fonte),
        segmentos: p.segmentos,
        // trilha por partes (tempo do vídeo final); o formato antigo (uma música só) vira uma parte
        musicas: (Array.isArray(p.musicas) ? p.musicas : p.musica ? [{ ...p.musica, de: 0, ate: 1e9 }] : [])
          .slice(0, 12)
          .map((m) => ({ arquivo: resolverMidia(m.arquivo), db: Number(m.db) || -16, de: Math.max(0, Number(m.de) || 0), ate: Number(m.ate) || 1e9 })),
        ducking: Boolean(p.ducking),
        saida: inData(`editados/${p.nome}.mp4`),
        projeto: inData(`editados/projetos/${p.nome}.fcproj`),
      };
    } catch (e) { return send(res, 400, { error: e.message }); }
    const id = crypto.randomBytes(4).toString('hex');
    const job = { id, status: 'na fila', etapa: 'esperando a vez', progresso: 0, eta: null, criadoEm: Date.now(), pedido };
    fcJobs.set(id, job);
    fcFila = fcFila.then(async () => {
      job.status = 'editando';
      try {
        const r = await editarNoFilmCraft(FILMCRAFT, pedido, (e, prog, eta) => {
          job.etapa = e;
          if (prog != null) job.progresso = prog;
          job.eta = eta ?? null;
        });
        job.resultado = { arquivo: `editados/${p.nome}.mp4`, projeto: `editados/projetos/${p.nome}.fcproj`, duracao: r.duracao };
        job.status = 'pronto';
      } catch (e) {
        job.status = 'erro'; job.erro = String(e.message || e).slice(0, 500); console.error(e);
      } finally {
        job.fim = Date.now(); setTimeout(() => fcJobs.delete(id), 6 * 3600_000);
      }
    });
    return send(res, 202, { id });
  }

  const m = /^\/thumbnails\/([a-f0-9]{8})$/.exec(req.url || '');
  if (req.method === 'GET' && m) {
    const j = jobs.get(m[1]);
    if (!j) return send(res, 404, { error: 'Pedido não encontrado' });
    const { abort, pedido, ...pub } = j;
    return send(res, 200, pub);
  }

  if (req.method === 'POST' && req.url === '/thumbnails') {
    let raw = '';
    for await (const c of req) { raw += c; if (raw.length > 100_000) return send(res, 413, { error: 'Pedido grande demais' }); }
    let pedido;
    try { pedido = JSON.parse(raw); } catch { return send(res, 400, { error: 'JSON inválido' }); }
    if (!Array.isArray(pedido.frames) || !pedido.frames.length || !pedido.titulo || !pedido.pasta) {
      return send(res, 400, { error: 'Faltam frames, título ou pasta' });
    }
    pedido.quantidade = Math.min(3, Math.max(1, Number(pedido.quantidade) || 3));
    if ([...jobs.values()].some((j) => j.status === 'gerando')) return send(res, 409, { error: 'Já há thumbnails sendo geradas. Espere terminar.' });
    const id = crypto.randomBytes(4).toString('hex');
    const job = { id, status: 'gerando', etapas: [], criadoEm: Date.now(), abort: new AbortController(), pedido };
    jobs.set(id, job);
    gerar(job)
      .then((r) => { job.status = 'pronto'; job.resultado = r; })
      .catch((e) => { job.status = 'erro'; job.erro = String(e.message || e).slice(0, 400); console.error(e); })
      .finally(() => { job.fim = Date.now(); setTimeout(() => jobs.delete(id), 6 * 3600_000); });
    return send(res, 202, { id });
  }
  send(res, 404, { error: 'Rota não encontrada' });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`Ponte PhotoCraft + FilmCraft em http://127.0.0.1:${PORT} (dados: ${DATA})`);
});
