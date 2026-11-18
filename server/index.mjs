import Fastify from 'fastify';
import multipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { bundle } from '@remotion/bundler';
import { renderMedia, renderStill, selectComposition } from '@remotion/renderer';
import { runClaude, claudeStatus, claudeModel } from './claude.mjs';
import { createYouTube, validarMeta } from './youtube.mjs';
import { frames, transcricao, transcricaoPalavras, transcricaoComTempo, salvarQuadro, descricoesDoPipeline, duracao as duracaoVideo } from './contexto-video.mjs';
import { createDrive } from './drive.mjs';
import { energiaAudio, mudancasDeCena, momentosDoTrecho, textoDosMomentos, prepararSons, SONS } from './analise-video.mjs';
import { prisma, projetos, publicacoes, comCache, chaveDe, sugestoesCortes, planos, producoes, importarJsonAntigos } from './db.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA = path.resolve(process.env.DATA_DIR || path.join(ROOT, 'data'));
// configurações (chave da ElevenLabs, token do YouTube) ficam FORA da pasta de mídia e nunca são servidas
const CONFIG = path.resolve(process.env.CONFIG_DIR || path.join(ROOT, 'config'));
// pasta de gravações do Windows (D:\Videos), montada só para leitura
const VIDEOS = process.env.VIDEOS_DIR ? path.resolve(process.env.VIDEOS_DIR) : null;
const PORT = Number(process.env.PORT || 3100);
const HOST = process.env.HOST || '127.0.0.1';
const PUBLIC_URL = (process.env.PUBLIC_URL || `http://localhost:${PORT}`).replace(/\/$/, '');
const PONTE_URL = (process.env.PONTE_URL || 'http://host.docker.internal:3101').replace(/\/$/, '');
const DIRS = {
  uploads: path.join(DATA, 'uploads'),
  audio: path.join(DATA, 'audio'),
  renders: path.join(DATA, 'renders'),
  thumbs: path.join(DATA, 'thumbs'),
  // vídeos editados pelo FilmCraft (a ponte grava aqui) e os projetos .fcproj em editados/projetos
  editados: path.join(DATA, 'editados'),
  // efeitos sonoros da edição (gerados na primeira vez; troque por arquivos seus com o mesmo nome)
  sfx: path.join(DATA, 'sfx'),
};
for (const d of [...Object.values(DIRS), CONFIG]) fs.mkdirSync(d, { recursive: true });
const SETTINGS_FILE = path.join(CONFIG, 'settings.json');
const CANAL_FILE = path.join(CONFIG, 'canal.md');
if (!fs.existsSync(CANAL_FILE)) fs.copyFileSync(path.join(ROOT, 'server', 'canal-padrao.md'), CANAL_FILE);
// agentes especialistas (roteirista, social media, marketing): editáveis em config/agentes
const AGENTES_DIR = path.join(CONFIG, 'agentes');
fs.mkdirSync(AGENTES_DIR, { recursive: true });
for (const n of fs.readdirSync(path.join(ROOT, 'server', 'agentes'))) {
  if (!fs.existsSync(path.join(AGENTES_DIR, n))) fs.copyFileSync(path.join(ROOT, 'server', 'agentes', n), path.join(AGENTES_DIR, n));
}

const EL = 'https://api.elevenlabs.io';
const TTS_MODEL = process.env.ELEVENLABS_TTS_MODEL || 'eleven_flash_v2_5';
const STT_MODEL = process.env.ELEVENLABS_STT_MODEL || 'scribe_v2';
const TTS_MAX_CHARS = Number(process.env.TTS_MAX_CHARS || 2500);
const FORMAT_IDS = ['vertical', 'horizontal', 'square'];

const readSettings = () => {
  try { return JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')); } catch { return {}; }
};
const apiKey = () => process.env.ELEVENLABS_API_KEY || readSettings().elevenlabsKey || '';

const fail = (statusCode, message) => Object.assign(new Error(message), { statusCode });

const app = Fastify({ logger: { level: process.env.LOG_LEVEL || 'info' }, bodyLimit: 20 * 1024 * 1024 });

app.setErrorHandler((err, req, reply) => {
  if (err.validation) {
    return reply.status(400).send({ error: `Dados inválidos: ${err.message}` });
  }
  const status = err.statusCode && err.statusCode >= 400 ? err.statusCode : 500;
  if (status >= 500) req.log.error(err);
  reply.status(status).send({ error: err.message || 'Erro inesperado' });
});

await app.register(multipart, { limits: { fileSize: 4 * 1024 ** 3, files: 1 } });

// mídia: só as três subpastas, nunca a pasta data inteira
const mediaDirs = ['uploads', 'audio', 'renders', 'thumbs', 'editados', 'sfx'];
const MEDIA_ROOTS = Object.fromEntries(mediaDirs.map((d) => [d, DIRS[d]]));
if (VIDEOS && fs.existsSync(VIDEOS)) MEDIA_ROOTS.biblioteca = VIDEOS;
for (const [i, [sub, root]] of Object.entries(MEDIA_ROOTS).entries()) {
  await app.register(fastifyStatic, {
    root,
    prefix: `/media/${sub}/`,
    decorateReply: i === 0,
    index: false,
    list: false,
    dotfiles: 'deny',
  });
}

const SONS_ARQ = prepararSons(DIRS.sfx, app.log);

const VIDEO_EXT = /\.(mp4|mov|webm|mkv|m4v)$/i;
const AUDIO_EXT = /\.(mp3|wav|m4a|aac|ogg)$/i;
const safeName = (n) => n.normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^\w.-]+/g, '-').replace(/-+/g, '-').slice(-80);

/* ---------- Status e configurações ---------- */
const ponteFetch = async (p, init = {}) => {
  if (!process.env.PONTE_TOKEN) throw fail(400, 'Defina PONTE_TOKEN no .env para usar o PhotoCraft.');
  const r = await fetch(PONTE_URL + p, {
    ...init,
    headers: { Authorization: `Bearer ${process.env.PONTE_TOKEN}`, 'Content-Type': 'application/json', ...(init.headers || {}) },
    signal: AbortSignal.timeout(init.timeout || 8000),
  }).catch(() => {
    throw fail(503, 'A ponte do Windows (PhotoCraft e FilmCraft) não está rodando. Abra ponte\\iniciar-ponte.bat.');
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw fail(r.status, j.error || `Ponte respondeu ${r.status}`);
  return j;
};

app.get('/api/status', async () => ({
  elevenlabs: Boolean(apiKey()),
  keyFromEnv: Boolean(process.env.ELEVENLABS_API_KEY),
  claude: { ...claudeStatus(), modelo: claudeModel() },
  youtube: await youtube.status(),
  drive: await drive.status(),
  banco: await prisma.$queryRaw`SELECT 1`.then(() => true).catch(() => false),
  ...(await ponteFetch('/status', { timeout: 1500 })
    .then((s) => ({ photocraft: s.photocraft !== false, filmcraft: Boolean(s.filmcraft), ponteReabrir: Boolean(s.reabrir) || !(s.versao >= 3) }))
    .catch(() => ({ photocraft: false, filmcraft: false }))),
  biblioteca: Boolean(MEDIA_ROOTS.biblioteca),
}));

app.put('/api/settings', {
  schema: {
    body: {
      type: 'object',
      additionalProperties: false,
      required: ['elevenlabsKey'],
      properties: { elevenlabsKey: { type: 'string', maxLength: 200, pattern: '^[A-Za-z0-9_\\-]*$' } },
    },
  },
}, async (req) => {
  if (process.env.ELEVENLABS_API_KEY) throw fail(409, 'A chave vem do .env do servidor. Edite o .env para trocá-la.');
  const s = readSettings();
  s.elevenlabsKey = req.body.elevenlabsKey.trim();
  await fsp.writeFile(SETTINGS_FILE, JSON.stringify(s, null, 2), { mode: 0o600 });
  return { elevenlabs: Boolean(apiKey()) };
});

/* ---------- Mídia ---------- */
const listDir = async (dir, sub, kind) => {
  const names = await fsp.readdir(dir).catch(() => []);
  const items = await Promise.all(names.filter((n) => !n.startsWith('.')).map(async (n) => {
    const st = await fsp.stat(path.join(dir, n));
    return { name: n, url: `/media/${sub}/${encodeURIComponent(n)}`, kind, size: st.size, createdAt: st.mtimeMs };
  }));
  return items.sort((a, b) => b.createdAt - a.createdAt);
};
app.get('/api/media', async () => ({
  videos: await listDir(DIRS.uploads, 'uploads', 'video'),
  audio: await listDir(DIRS.audio, 'audio', 'audio'),
  renders: (await listDir(DIRS.renders, 'renders', 'render')).map((r) => {
    const info = lerRenders()[r.name];
    return { ...r, projeto: info?.projeto || null, origem: info?.videoSrc || null, drive: info?.drive || null };
  }),
}));

app.post('/api/upload', async (req) => {
  const data = await req.file();
  if (!data) throw fail(400, 'Envie um vídeo (mp4, mov, webm) ou áudio (mp3, wav, m4a).');
  const original = data.filename || 'arquivo';
  const isAudio = AUDIO_EXT.test(original);
  if (!isAudio && !VIDEO_EXT.test(original)) {
    data.file.resume();
    throw fail(400, 'Formato não suportado. Envie mp4, mov, webm, mkv, mp3, wav ou m4a.');
  }
  const sub = isAudio ? 'audio' : 'uploads';
  const name = `${Date.now().toString(36)}-${safeName(original)}`;
  const dest = path.join(DIRS[sub], name);
  await pipeline(data.file, fs.createWriteStream(dest));
  if (data.file.truncated) {
    await fsp.rm(dest, { force: true });
    throw fail(413, 'Arquivo acima de 4 GB.');
  }
  return { name, url: `/media/${sub}/${encodeURIComponent(name)}`, kind: isAudio ? 'audio' : 'video' };
});

app.delete('/api/media/:sub/:name', {
  schema: { params: { type: 'object', properties: { sub: { type: 'string', enum: mediaDirs }, name: { type: 'string', maxLength: 200 } } } },
}, async (req) => {
  await fsp.rm(path.join(DIRS[req.params.sub], path.basename(req.params.name)), { force: true });
  return { ok: true };
});

const mediaPathFromUrl = (url) => {
  const m = /^\/media\/([a-z]+)\/(.+)$/.exec(url || '');
  const root = m && MEDIA_ROOTS[m[1]];
  if (!root) throw fail(400, 'Arquivo de mídia inválido');
  const rel = decodeURIComponent(m[2]).split('/').filter(Boolean);
  const file = path.resolve(root, ...rel);
  if (!file.startsWith(root + path.sep) || rel.some((p) => p === '..')) throw fail(400, 'Caminho inválido');
  if (!fs.existsSync(file)) throw fail(404, 'Arquivo não encontrado');
  return file;
};
const urlFor = (sub, rel) => `/media/${sub}/${rel.split(/[\\/]/).map(encodeURIComponent).join('/')}`;

/* ---------- Biblioteca (D:\Videos, só leitura) ---------- */
const bloqueadaContentId = (rel) =>
  /_bloqueadas|zephiramusic|velariomusic/i.test(rel) || /-\d{5,}\.mp3$/i.test(path.basename(rel));

const walk = async (root, rel = '', depth = 0, out = []) => {
  if (depth > 6 || out.length > 2000) return out;
  const entries = await fsp.readdir(path.join(root, rel), { withFileTypes: true }).catch(() => []);
  for (const e of entries) {
    if (e.name.startsWith('.') || e.name === 'thumb-edit') continue;
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) await walk(root, r, depth + 1, out);
    else if (VIDEO_EXT.test(e.name) || AUDIO_EXT.test(e.name)) {
      const st = await fsp.stat(path.join(root, r)).catch(() => null);
      if (st) out.push({ rel: r, size: st.size, mtime: st.mtimeMs });
    }
  }
  return out;
};
let bibliotecaCache = { at: 0, items: [] };
app.get('/api/biblioteca', async (req) => {
  if (!MEDIA_ROOTS.biblioteca) return { disponivel: false, videos: [], musicas: [] };
  if (req.query.atualizar || Date.now() - bibliotecaCache.at > 60_000) {
    bibliotecaCache = { at: Date.now(), items: await walk(VIDEOS) };
  }
  const items = bibliotecaCache.items;
  return {
    disponivel: true,
    videos: items
      .filter((i) => VIDEO_EXT.test(i.rel))
      .sort((a, b) => b.mtime - a.mtime)
      .map((i) => ({ name: path.basename(i.rel), pasta: path.dirname(i.rel), url: urlFor('biblioteca', i.rel), kind: 'video', size: i.size, createdAt: i.mtime })),
    musicas: items
      .filter((i) => AUDIO_EXT.test(i.rel) && /m[uú]sica/i.test(i.rel))
      .map((i) => ({ name: path.basename(i.rel), url: urlFor('biblioteca', i.rel), bloqueada: bloqueadaContentId(i.rel) })),
  };
});

// remove um vídeo de D:\Videos pelo painel. Não apaga de vez: move para D:\Videos\.lixeira-painel
// (a pasta começa com ponto, então some da lista), de onde dá para recuperar ou esvaziar à mão.
app.delete('/api/biblioteca', {
  schema: {
    querystring: {
      type: 'object', additionalProperties: false, required: ['url'],
      properties: { url: { type: 'string', maxLength: 600, pattern: '^/media/biblioteca/' }, forcar: { type: 'boolean', default: false } },
    },
  },
}, async (req) => {
  if (!MEDIA_ROOTS.biblioteca) throw fail(400, 'A pasta de vídeos não está montada.');
  const file = mediaPathFromUrl(req.query.url);
  if (!VIDEO_EXT.test(file)) throw fail(400, 'Por aqui só dá para remover vídeos.');
  if (!req.query.forcar) {
    const usados = (await projetos.listar()).filter((p) => p.props?.videoSrc === req.query.url);
    if (usados.length) throw fail(409, `Este vídeo é usado em ${usados.length} corte(s) (${usados.slice(0, 3).map((p) => p.name).join(', ')}). Confirme para remover mesmo assim.`);
  }
  const lixeira = path.join(VIDEOS, '.lixeira-painel');
  await fsp.mkdir(lixeira, { recursive: true });
  const rel = path.relative(VIDEOS, file);
  const destino = path.join(lixeira, `${Date.now().toString(36)}-${rel.replace(/[\\/]/g, '__')}`);
  try {
    await fsp.rename(file, destino);
  } catch (e) {
    if (e.code === 'EROFS' || e.code === 'EACCES' || e.code === 'EPERM') {
      throw fail(403, 'A pasta de vídeos está montada só para leitura. Tire o ":ro" dela no docker-compose.yml e recrie o container.');
    }
    throw e;
  }
  bibliotecaCache = { at: 0, items: [] };
  req.log.info({ de: rel, para: path.relative(VIDEOS, destino) }, 'vídeo movido para a lixeira do painel');
  return { ok: true, lixeira: `.lixeira-painel/${path.basename(destino)}` };
});

/* ---------- Projetos ---------- */
// os dados ficam no Postgres; na 1ª vez, o que estava nos JSON de data/ é importado
await importarJsonAntigos(DATA, app.log);

const idParams = { type: 'object', properties: { id: { type: 'string', pattern: '^[a-f0-9-]{1,40}$' } } };

app.get('/api/projects', async () => projetos.listar()); // mais novos primeiro
app.post('/api/projects', {
  schema: { body: { type: 'object', required: ['props'], properties: { name: { type: 'string', maxLength: 120 }, props: { type: 'object' } } } },
}, async (req) => {
  const p = { id: crypto.randomUUID().slice(0, 8), name: req.body.name || 'Novo corte', props: req.body.props, createdAt: Date.now(), updatedAt: Date.now() };
  return projetos.salvar(p);
});
app.put('/api/projects/:id', {
  schema: { params: idParams, body: { type: 'object', properties: { name: { type: 'string', maxLength: 120 }, props: { type: 'object' }, meta: { type: 'object' } } } },
}, async (req) => {
  const cur = await projetos.obter(req.params.id);
  if (!cur) throw fail(404, 'Projeto não encontrado');
  const p = {
    ...cur,
    name: req.body.name ?? cur.name,
    props: req.body.props ?? cur.props,
    meta: req.body.meta ? { ...(cur.meta || {}), ...req.body.meta } : cur.meta,
    updatedAt: Date.now(),
  };
  return projetos.salvar(p);
});
app.delete('/api/projects/:id', { schema: { params: idParams } }, async (req) => {
  await projetos.remover(req.params.id);
  return { ok: true };
});

/* ---------- ElevenLabs ---------- */
const el = async (pathname, init = {}) => {
  const key = apiKey();
  if (!key) throw fail(400, 'Adicione sua chave da ElevenLabs em Configurações para usar vozes e legendas automáticas.');
  const r = await fetch(EL + pathname, { ...init, headers: { 'xi-api-key': key, ...(init.headers || {}) } });
  if (!r.ok) {
    const body = await r.text();
    let msg = body;
    try { const j = JSON.parse(body); msg = j.detail?.message || j.detail?.status || (typeof j.detail === 'string' ? j.detail : body); } catch {}
    throw fail(r.status === 401 ? 401 : 502, `ElevenLabs recusou o pedido (${r.status}): ${String(msg).slice(0, 300)}`);
  }
  return r;
};

app.get('/api/voices', async () => {
  const r = await el('/v1/voices');
  const j = await r.json();
  return j.voices.map((v) => ({ id: v.voice_id, name: v.name, category: v.category, preview: v.preview_url, labels: v.labels || {} }));
});

const alignmentToWords = (al) => {
  const words = [];
  let cur = null;
  al.characters.forEach((ch, i) => {
    if (/\s/.test(ch)) {
      if (cur) words.push(cur);
      cur = null;
      return;
    }
    if (!cur) cur = { text: '', start: al.character_start_times_seconds[i], end: 0 };
    cur.text += ch;
    cur.end = al.character_end_times_seconds[i];
  });
  if (cur) words.push(cur);
  return words;
};

app.post('/api/tts', {
  schema: {
    body: {
      type: 'object',
      additionalProperties: false,
      required: ['text', 'voiceId'],
      properties: {
        text: { type: 'string', minLength: 1, maxLength: TTS_MAX_CHARS },
        voiceId: { type: 'string', pattern: '^[A-Za-z0-9]{8,40}$' },
        stability: { type: 'number', minimum: 0, maximum: 1, default: 0.5 },
        similarity: { type: 'number', minimum: 0, maximum: 1, default: 0.75 },
        style: { type: 'number', minimum: 0, maximum: 1, default: 0 },
        speed: { type: 'number', minimum: 0.7, maximum: 1.2, default: 1 },
      },
    },
  },
}, async (req) => {
  const { text, voiceId, stability, similarity, style, speed } = req.body;
  if (!text.trim()) throw fail(400, 'Escreva o roteiro da narração.');
  const r = await el(`/v1/text-to-speech/${voiceId}/with-timestamps?output_format=mp3_44100_128`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      text,
      model_id: TTS_MODEL,
      voice_settings: { stability, similarity_boost: similarity, style, speed, use_speaker_boost: true },
    }),
  });
  const j = await r.json();
  const name = `narracao-${Date.now().toString(36)}.mp3`;
  await fsp.writeFile(path.join(DIRS.audio, name), Buffer.from(j.audio_base64, 'base64'));
  const al = j.normalized_alignment || j.alignment;
  return {
    url: `/media/audio/${name}`,
    duration: al ? al.character_end_times_seconds.at(-1) : 0,
    words: al ? alignmentToWords(al) : [],
  };
});

app.post('/api/transcribe', {
  schema: {
    body: {
      type: 'object',
      additionalProperties: false,
      required: ['url'],
      properties: { url: { type: 'string', maxLength: 300 }, language: { type: 'string', pattern: '^[a-z]{2,3}$' } },
    },
  },
}, async (req) => {
  const file = mediaPathFromUrl(req.body.url);
  const form = new FormData();
  form.append('model_id', STT_MODEL);
  form.append('file', await fs.openAsBlob(file), path.basename(file));
  form.append('timestamps_granularity', 'word');
  form.append('tag_audio_events', 'false');
  if (req.body.language) form.append('language_code', req.body.language);
  const r = await el('/v1/speech-to-text', { method: 'POST', body: form });
  const j = await r.json();
  const words = (j.words || [])
    .filter((w) => w.type === 'word')
    .map((w) => ({ text: w.text.trim(), start: w.start, end: w.end }))
    .filter((w) => w.text);
  return { words, language: j.language_code, text: j.text };
});

/* ---------- Renderização (independente do framework) ---------- */
let bundlePromise = null;
const getBundle = () => {
  if (!bundlePromise) {
    bundlePromise = bundle({ entryPoint: path.join(ROOT, 'remotion', 'index.ts') }).catch((e) => {
      bundlePromise = null;
      throw e;
    });
  }
  return bundlePromise;
};

// vídeos grandes do D:Videos chegam devagar pela montagem do Docker no Windows
const RENDER_TIMEOUT = Number(process.env.RENDER_TIMEOUT_MS || 300_000);

const explicarErroMidia = (e) => {
  const msg = String(e?.message || e);
  if (/moov atom not found|Invalid data found/i.test(msg)) {
    return 'O vídeo de origem está incompleto ou corrompido (talvez ainda esteja sendo exportado). Espere a exportação terminar ou escolha outro arquivo.';
  }
  return msg.split('\n')[0].slice(0, 400);
};

const jobs = new Map();
const queue = [];
let running = false;

const absolutize = (props) => {
  const base = `http://127.0.0.1:${PORT}`;
  const abs = (u) => (u && u.startsWith('/') ? base + u : u);
  return {
    ...props,
    videoSrc: abs(props.videoSrc),
    narration: { ...props.narration, src: abs(props.narration?.src) },
    music: { ...props.music, src: abs(props.music?.src) },
    // efeitos sonoros: só os da pasta de efeitos
    ...(props.efeitos ? { efeitos: { ...props.efeitos, sons: (props.efeitos.sons || []).filter((s) => String(s.src || '').startsWith('/media/sfx/')).map((s) => ({ ...s, src: abs(s.src) })) } } : {}),
  };
};

const runQueue = async () => {
  if (running) return;
  running = true;
  while (queue.length) {
    const job = queue.shift();
    job.status = 'renderizando';
    try {
      const serveUrl = await getBundle();
      const inputProps = absolutize(job.props);
      const composition = await selectComposition({ serveUrl, id: 'Edicao', inputProps, timeoutInMilliseconds: RENDER_TIMEOUT });
      await renderMedia({
        serveUrl,
        composition,
        inputProps,
        codec: 'h264',
        crf: 18,
        audioBitrate: '192k',
        outputLocation: path.join(DIRS.renders, job.file),
        concurrency: Number(process.env.RENDER_CONCURRENCY) || null,
        chromiumOptions: { gl: 'swangle' },
        timeoutInMilliseconds: RENDER_TIMEOUT,
        onProgress: ({ progress }) => { job.progress = progress; },
      });
      job.status = 'pronto';
      job.progress = 1;
      job.url = `/media/renders/${encodeURIComponent(job.file)}`;
      // registra de qual corte e de qual gravação veio este arquivo (o Publicar usa isso, não o nome)
      await registrarRender(job.file, {
        projeto: job.projeto || null, videoSrc: job.props.videoSrc, trimStart: job.props.trimStart, trimEnd: job.props.trimEnd,
        formato: job.format, criadoEm: Date.now(),
      });
    } catch (e) {
      app.log.error(e);
      job.status = 'erro';
      job.error = explicarErroMidia(e);
    }
    job.finishedAt = Date.now();
  }
  running = false;
};

const localMedia = { type: ['string', 'null'], maxLength: 600, pattern: '^/media/(uploads|audio|biblioteca|editados)/' };

// registro das exportações: arquivo → corte de origem (data/renders.json, fora da pasta servida)
const RENDERS_INDEX = path.join(DATA, 'renders.json');
const lerRenders = () => { try { return JSON.parse(fs.readFileSync(RENDERS_INDEX, 'utf8')); } catch { return {}; } };
let registroFila = Promise.resolve();
const registrarRender = (file, info) => (registroFila = registroFila.then(async () => {
  const r = lerRenders();
  r[file] = info;
  await fsp.writeFile(`${RENDERS_INDEX}.tmp`, JSON.stringify(r, null, 2));
  await fsp.rename(`${RENDERS_INDEX}.tmp`, RENDERS_INDEX);
}));

app.post('/api/render', {
  schema: {
    body: {
      type: 'object',
      additionalProperties: false,
      required: ['props', 'formats'],
      properties: {
        name: { type: 'string', maxLength: 120, default: 'corte' },
        projeto: { type: 'string', maxLength: 40 },
        formats: { type: 'array', minItems: 1, maxItems: 3, uniqueItems: true, items: { type: 'string', enum: FORMAT_IDS } },
        props: {
          type: 'object',
          required: ['videoSrc', 'trimStart', 'trimEnd'],
          properties: {
            videoSrc: { ...localMedia, type: 'string' },
            trimStart: { type: 'number', minimum: 0 },
            trimEnd: { type: 'number', exclusiveMinimum: 0 },
            narration: { type: 'object', properties: { src: localMedia } },
            music: { type: 'object', properties: { src: localMedia } },
          },
        },
      },
    },
  },
}, async (req) => {
  const { props, formats, name, projeto } = req.body;
  if (props.trimEnd <= props.trimStart) throw fail(400, 'O fim do trecho precisa vir depois do início.');
  return enfileirarRender({ props, formats, name, projeto });
});

function enfileirarRender({ props, formats, name = 'corte', projeto }) {
  const created = formats.map((format) => {
    const id = crypto.randomUUID().slice(0, 8);
    const label = { vertical: '9x16', horizontal: '16x9', square: '1x1' }[format];
    const job = {
      id, format, name, projeto, status: 'na fila', progress: 0, createdAt: Date.now(),
      file: `${safeName(name)}-${label}-${id}.mp4`,
      props: { ...props, format },
    };
    jobs.set(id, job);
    queue.push(job);
    return job;
  });
  runQueue();
  return created.map(({ props: _p, ...j }) => j);
}

app.get('/api/jobs', async () =>
  [...jobs.values()].sort((a, b) => b.createdAt - a.createdAt).map(({ props: _p, ...j }) => j));

/* ---------- Claude (assinatura via Agent SDK) ---------- */
const canal = () => fs.readFileSync(CANAL_FILE, 'utf8');
const AGENTE_IDS = ['roteirista', 'social-media', 'marketing', 'editor'];
const lerAgente = (id) => {
  try { return fs.readFileSync(path.join(AGENTES_DIR, `${id}.md`), 'utf8'); } catch { return ''; }
};
const corpoAgente = (id) => lerAgente(id).replace(/^---[\s\S]*?---\s*/, '');
// cada função do painel usa o especialista certo; as regras do canal valem para todos
const SYSTEM_BASE = (...ids) => [
  'Você trabalha para um dev indie brasileiro que grava vídeos dos próprios jogos para YouTube, Shorts, TikTok e Reels. Responda só com o JSON pedido.',
  ...(ids.length ? ids : ['roteirista', 'social-media']).map(corpoAgente).filter(Boolean),
  `# Regras do canal (prioridade máxima)\n${canal()}`,
].join('\n\n---\n\n');

app.get('/api/agentes', async () => AGENTE_IDS.map((id) => {
  const txt = lerAgente(id);
  const fm = /^---([\s\S]*?)---/.exec(txt)?.[1] || '';
  return { id, nome: /nome:\s*(.+)/.exec(fm)?.[1]?.trim() || id, usadoEm: /usado_em:\s*(.+)/.exec(fm)?.[1]?.trim() || '', texto: txt };
}));
app.put('/api/agentes/:id', {
  schema: { params: { type: 'object', properties: { id: { type: 'string', enum: AGENTE_IDS } } }, body: { type: 'object', required: ['texto'], properties: { texto: { type: 'string', maxLength: 30000 } } } },
}, async (req) => {
  await fsp.writeFile(path.join(AGENTES_DIR, `${req.params.id}.md`), req.body.texto);
  return { ok: true };
});
app.post('/api/agentes/:id/restaurar', { schema: { params: { type: 'object', properties: { id: { type: 'string', enum: AGENTE_IDS } } } } }, async (req) => {
  await fsp.copyFile(path.join(ROOT, 'server', 'agentes', `${req.params.id}.md`), path.join(AGENTES_DIR, `${req.params.id}.md`));
  return { texto: lerAgente(req.params.id) };
});
const contexto = (c = {}) => [
  c.titulo && `Nome do corte: ${c.titulo}`,
  c.jogo && `Jogo: ${c.jogo}`,
  c.formato && `Formato: ${c.formato === 'vertical' ? 'vertical 9:16 (Shorts/TikTok/Reels)' : c.formato === 'horizontal' ? 'horizontal 16:9 (YouTube)' : 'quadrado 1:1 (feed)'}`,
  c.duracao && `Duração do corte: ${Math.round(c.duracao)} s`,
  c.arquivoNome && `Arquivo de origem: ${c.arquivoNome}`,
  c.gancho && `Texto de abertura que aparece na tela: "${c.gancho}"`,
  c.ideia && `Ideia/anotações do criador: ${c.ideia}`,
  c.roteiro && `Roteiro planejado:\n${c.roteiro}`,
  c.transcricao && `Fala do vídeo (transcrição real do áudio):\n${c.transcricao.slice(0, 12000)}`,
  c.narracao && `Narração (voz em off) do corte:\n${c.narracao}`,
  c.descricaoPipeline && `Anotações do Pipeline sobre esta gravação (descrições geradas quando o vídeo foi editado; use como contexto, não copie):\n${c.descricaoPipeline}`,
].filter(Boolean).join('\n\n');

const FIEL_AO_VIDEO = `REGRA PRINCIPAL: escreva sobre ESTE vídeo. Baseie-se no que aparece nos frames, no que é falado na transcrição/narração e nas anotações. Cite coisas concretas que dá para ver ou ouvir (o que acontece, números na tela, lugares, personagens, mecânicas). Não invente recursos, eventos ou resultados que não aparecem. Se faltar informação, seja mais genérico em vez de inventar.`;

const ctxSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    titulo: { type: 'string', maxLength: 120 },
    jogo: { type: 'string', maxLength: 80 },
    formato: { type: 'string', enum: FORMAT_IDS },
    duracao: { type: 'number', minimum: 0, maximum: 7200 },
    ideia: { type: 'string', maxLength: 4000 },
    roteiro: { type: 'string', maxLength: 8000 },
    transcricao: { type: 'string', maxLength: 30000 },
    narracao: { type: 'string', maxLength: 6000 },
    gancho: { type: 'string', maxLength: 120 },
    tom: { type: 'string', maxLength: 200 },
    // o vídeo de verdade: o painel extrai frames e transcreve o áudio
    video: {
      type: 'object', additionalProperties: false, required: ['src'],
      properties: { src: { type: 'string', maxLength: 600, pattern: '^/media/' }, inicio: { type: 'number', minimum: 0 }, fim: { type: 'number', minimum: 0 } },
    },
    origem: { type: 'string', maxLength: 600, pattern: '^/media/' },
    transcrever: { type: 'boolean', default: false },
    // true = o usuário pediu outra versão: ignora a resposta guardada e gasta token de novo
    novo: { type: 'boolean', default: false },
  },
};

const CACHE_DIR = path.join(DATA, 'cache');
fs.mkdirSync(CACHE_DIR, { recursive: true });

const transcreverTexto = async (audioFile) => {
  const form = new FormData();
  form.append('model_id', STT_MODEL);
  form.append('file', await fs.openAsBlob(audioFile), path.basename(audioFile));
  form.append('tag_audio_events', 'false');
  const r = await el('/v1/speech-to-text', { method: 'POST', body: form });
  return ((await r.json()).text || '').trim();
};

/** Junta frames, fala e anotações do vídeo real. Nada aqui é obrigatório: o que falhar, fica de fora. */
const montarContexto = async (c, log) => {
  const usado = { frames: 0, transcricao: false, descricao: false };
  const ctx = { ...c };
  let images = [];
  if (c.video?.src) {
    const file = mediaPathFromUrl(c.video.src);
    const bibRoot = MEDIA_ROOTS.biblioteca;
    ctx.arquivoNome = bibRoot && file.startsWith(bibRoot + path.sep) ? path.relative(bibRoot, file) : path.basename(file);
    const fs6 = await frames(file, { inicio: c.video.inicio || 0, fim: c.video.fim, n: 6 }).catch((e) => { log.warn(e, 'frames'); return []; });
    images = fs6.map((f, i) => ({ legenda: `Frame ${i + 1} de ${fs6.length} (${Math.round(f.t - (c.video.inicio || 0))} s do corte):`, base64: f.base64 }));
    usado.frames = images.length;
    if (!c.transcricao && c.transcrever && apiKey()) {
      ctx.transcricao = await transcricao(file, { inicio: c.video.inicio, fim: c.video.fim, cacheDir: CACHE_DIR, transcrever: transcreverTexto })
        .catch((e) => { log.warn(e, 'transcrição'); return ''; });
    }
  }
  usado.transcricao = Boolean(ctx.transcricao);
  const origem = c.origem || c.video?.src;
  if (origem) {
    try {
      ctx.descricaoPipeline = await descricoesDoPipeline(mediaPathFromUrl(origem), MEDIA_ROOTS.biblioteca);
      usado.descricao = Boolean(ctx.descricaoPipeline);
    } catch {}
  }
  return { ctx, images, usado };
};

// identifica a versão do arquivo: se o vídeo for exportado de novo, a chave do cache muda
const assinaturaArquivo = async (src) => {
  if (!src) return null;
  try {
    const st = await fsp.stat(mediaPathFromUrl(src));
    return `${st.size}-${Math.round(st.mtimeMs)}`;
  } catch { return null; }
};

const AI_BUILDERS = {};
const aiRoute = (url, build) => {
  AI_BUILDERS[url] = build;
  app.post(url, { schema: { body: ctxSchema } }, async (req) => {
    const { novo, ...entrada } = req.body;
    return executarAi(url, entrada, { novo, log: req.log });
  });
};
/** roda um pedido de IA (com cache no banco) fora de uma rota: a produção automática usa */
async function executarAi(url, entrada, { novo = false, log }) {
  const build = AI_BUILDERS[url];
  const req = { log };
  const { prompt, schema, agentes = ['roteirista'] } = build(entrada);
  const system = SYSTEM_BASE(...agentes);
  // mesma entrada + mesmas instruções (canal e agentes) + mesmo modelo = mesma resposta, sem chamar o Claude
  const chave = chaveDe(url, claudeModel(), system, prompt, entrada, await assinaturaArquivo(entrada.video?.src), await assinaturaArquivo(entrada.origem));
  const { resultado, doCache } = await comCache({
    tipo: url.replace('/api/ai/', ''),
    chave,
    modelo: claudeModel(),
    novo,
    gerar: async () => {
      const { ctx, images, usado } = await montarContexto(entrada, req.log);
      const out = await runClaude({ system, prompt: `${prompt}\n\n${FIEL_AO_VIDEO}\n\n${contexto(ctx)}`, images, schema, log: req.log });
      return { ...out, _contexto: usado };
    },
  });
  if (doCache) req.log.info({ rota: url }, 'resposta do Claude reaproveitada do banco (0 tokens)');
  return { ...resultado, _cache: doCache };
}

aiRoute('/api/ai/roteiro', (c) => ({
  prompt: `Escreva o roteiro de GRAVAÇÃO deste vídeo: o que mostrar na tela e o que falar, em blocos curtos e na ordem. Comece com um gancho forte nos 2 primeiros segundos e termine com a CTA do formato.${c.duracao ? '' : ' Sugira a duração ideal para o formato.'}`,
  schema: {
    type: 'object', additionalProperties: false,
    required: ['titulo_provisorio', 'gancho', 'blocos', 'cta'],
    properties: {
      titulo_provisorio: { type: 'string' },
      gancho: { type: 'string' },
      duracao_alvo_s: { type: 'number' },
      blocos: {
        type: 'array',
        items: {
          type: 'object', additionalProperties: false, required: ['tempo', 'mostrar', 'falar'],
          properties: { tempo: { type: 'string' }, mostrar: { type: 'string' }, falar: { type: 'string' } },
        },
      },
      cta: { type: 'string' },
      dicas_de_gravacao: { type: 'array', items: { type: 'string' } },
    },
  },
}));

aiRoute('/api/ai/narracao', (c) => ({
  prompt: `Escreva o texto da narração (voz em off) para este corte, pronto para ser lido por uma voz da ElevenLabs. Ele precisa caber em cerca de ${Math.max(5, Math.round(c.duracao || 30))} segundos de fala (por volta de 2,5 palavras por segundo). Frases curtas, faladas, sem emojis, sem hashtags e sem indicações de cena. Tom: ${c.tom || 'animado e natural'}.`,
  schema: {
    type: 'object', additionalProperties: false, required: ['texto'],
    properties: { texto: { type: 'string' }, observacao: { type: 'string' } },
  },
}));

aiRoute('/api/ai/ganchos', () => ({
  prompt: 'Sugira 6 frases de abertura (gancho) para aparecer escritas na tela nos 2 primeiros segundos. Cada uma com no máximo 6 palavras, sem emojis, variando o tipo: curiosidade, desafio, resultado, erro/fracasso, número.',
  schema: {
    type: 'object', additionalProperties: false, required: ['ganchos'],
    properties: { ganchos: { type: 'array', items: { type: 'string', maxLength: 70 } } },
  },
}));

aiRoute('/api/ai/publicacao', (c) => ({
  agentes: ['social-media', 'marketing'],
  prompt: `Primeiro descreva em 2 ou 3 frases o que este vídeo mostra (campo o_que_o_video_mostra), olhando os frames e a fala. Depois escreva os textos de publicação DESTE vídeo seguindo as regras do canal (CTA na primeira linha, bloco de links, limites do YouTube). A legenda_curta é para TikTok e Reels: até 300 caracteres, com a CTA de Shorts na primeira linha; as hashtags vão à parte (no máximo 8).${c.formato === 'vertical' ? ' É um Short: inclua #Shorts na descrição do YouTube.' : ' É um vídeo longo: se a transcrição permitir, sugira capítulos na descrição com 00:00 no primeiro; se não der para saber os tempos, não invente capítulos.'}`,
  schema: {
    type: 'object', additionalProperties: false,
    required: ['o_que_o_video_mostra', 'titulos', 'descricao_youtube', 'tags', 'legenda_curta', 'hashtags', 'comentario_fixado'],
    properties: {
      o_que_o_video_mostra: { type: 'string' },
      titulos: { type: 'array', items: { type: 'string', maxLength: 100 } },
      texto_thumbnail: { type: 'string' },
      descricao_youtube: { type: 'string' },
      tags: { type: 'array', items: { type: 'string' } },
      legenda_curta: { type: 'string' },
      hashtags: { type: 'array', items: { type: 'string' } },
      comentario_fixado: { type: 'string' },
    },
  },
}));

/* ---------- Sugerir cortes: o Claude assiste à gravação inteira e propõe os Shorts ---------- */
const transcreverPalavras = async (audioFile) => {
  const form = new FormData();
  form.append('model_id', STT_MODEL);
  form.append('file', await fs.openAsBlob(audioFile), path.basename(audioFile));
  form.append('timestamps_granularity', 'word');
  form.append('tag_audio_events', 'false');
  const r = await el('/v1/speech-to-text', { method: 'POST', body: form });
  const j = await r.json();
  return (j.words || [])
    .filter((w) => w.type === 'word')
    .map((w) => ({ text: w.text.trim(), start: w.start, end: w.end }))
    .filter((w) => w.text);
};

const sugestoes = new Map();

const CORTES_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['resumo', 'cortes'],
  properties: {
    resumo: { type: 'string' },
    cortes: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false,
        required: ['inicio_s', 'fim_s', 'titulo', 'gancho', 'motivo'],
        properties: {
          inicio_s: { type: 'number' },
          fim_s: { type: 'number' },
          titulo: { type: 'string' },
          gancho: { type: 'string' },
          motivo: { type: 'string' },
        },
      },
    },
  },
};

app.post('/api/ai/sugerir-cortes', {
  schema: {
    body: {
      type: 'object', additionalProperties: false, required: ['src'],
      properties: {
        src: { type: 'string', maxLength: 600, pattern: '^/media/(uploads|biblioteca)/' },
        jogo: { type: 'string', maxLength: 80 },
        quantidade: { type: 'integer', minimum: 1, maximum: 8, default: 4 },
        minS: { type: 'number', minimum: 5, maximum: 180, default: 90 },
        maxS: { type: 'number', minimum: 10, maximum: 240, default: 150 },
        orientacao: { type: 'string', maxLength: 1000 },
        evitarGanchos: { type: 'array', maxItems: 60, items: { type: 'string', maxLength: 120 } },
        novo: { type: 'boolean', default: false },
      },
    },
  },
}, async (req) => iniciarSugestao(req.body, log));

/** começa (ou reaproveita do banco) a sugestão de cortes de uma gravação; devolve o job (status muda sozinho) */
async function iniciarSugestao(body, log) {
  if (!claudeStatus().ok) throw fail(400, 'Conecte o Claude primeiro.');
  const { src, jogo, quantidade = 4, minS = 90, orientacao, evitarGanchos = [], novo } = body;
  const maxS = Math.max(minS + 5, body.maxS ?? 150);
  // minS/maxS são a duração FINAL; o trecho bruto é maior porque a edição tira o tempo morto
  const brutoMin = Math.round(minS * 1.2), brutoMax = Math.round(maxS * 1.4);
  const file = mediaPathFromUrl(src);
  // mesma gravação (mesmo arquivo) + mesmos parâmetros = reaproveita a última sugestão pronta.
  // Os ganchos a evitar ficam fora da chave: eles mudam a cada corte criado e invalidariam o cache à toa.
  const chave = chaveDe('sugerir-cortes', claudeModel(), SYSTEM_BASE('roteirista', 'social-media'), src, await assinaturaArquivo(src), jogo || '', quantidade, minS, maxS, orientacao || '');
  if (!novo) {
    const anterior = await sugestoesCortes.reaproveitavel(chave);
    if (anterior) {
      log.info({ id: anterior.id }, 'sugestão de cortes reaproveitada do banco (0 tokens)');
      return { ...anterior, _cache: new Date(anterior.criadoEm).toISOString() };
    }
  }
  const id = crypto.randomUUID().slice(0, 8);
  const job = { id, src, status: 'lendo a gravação', criadoEm: Date.now(), cortes: [], usado: {} };
  sugestoes.set(id, job);
  // grava no banco ao terminar (pronto ou erro): sobrevive a reinício do servidor
  const persistir = () => sugestoesCortes.salvar(chave, job).catch((e) => log.warn(e, 'salvar sugestão'));

  (async () => {
    const dur = await duracaoVideo(file);
    // 1) fala com o tempo de cada palavra (fica em cache: a 2ª vez é instantânea)
    let palavras = [];
    if (apiKey()) {
      job.status = 'transcrevendo a fala';
      palavras = await transcricaoPalavras(file, { cacheDir: CACHE_DIR, transcrever: transcreverPalavras })
        .catch((e) => { log.warn(e, 'transcrição'); return []; });
    }
    // 2) quadros ao longo da gravação inteira (1 a cada ~20 s, entre 12 e 40)
    job.status = 'olhando os quadros';
    const n = Math.max(12, Math.min(40, Math.round(dur / 20)));
    const qs = await frames(file, { inicio: 0, fim: dur, n, largura: 512 });
    const mmss = (s) => `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
    const images = qs.map((f) => ({ legenda: `Quadro em ${mmss(f.t)} (${f.t.toFixed(1)} s):`, base64: f.base64 }));
    const descricao = await descricoesDoPipeline(file, MEDIA_ROOTS.biblioteca).catch(() => '');
    job.usado = { quadros: images.length, palavras: palavras.length, descricao: Boolean(descricao) };

    // 3) o Claude escolhe os trechos
    job.status = 'o Claude está assistindo';
    const bibRoot = MEDIA_ROOTS.biblioteca;
    const nomeArq = bibRoot && file.startsWith(bibRoot + path.sep) ? path.relative(bibRoot, file) : path.basename(file);
    const prompt = [
      `Você é o editor de Shorts do canal. Esta é uma gravação bruta de ${Math.round(dur / 60)} min (${dur.toFixed(1)} s) do arquivo "${nomeArq}"${jogo ? ` do jogo ${jogo}` : ''}.`,
      `Escolha até ${quantidade} trechos CONTÍNUOS que funcionem sozinhos como Shorts/TikTok/Reels, cada um com ${brutoMin} a ${brutoMax} segundos de gravação bruta (depois da edição, que tira o tempo morto, cada Short fica com ${minS} a ${maxS} s). Prefira trechos que contem uma história completa: contexto, tentativa, virada e resultado.`,
      'Critérios: começa já no momento interessante (sem introdução), tem algo acontecendo (ação, reação, resultado, erro engraçado, feature nova, antes/depois), e termina num ponto que fecha a ideia ou deixa vontade de ver mais. Não corte uma fala no meio: use os tempos da transcrição para começar e terminar entre frases. Os trechos não podem se sobrepor. Prefira variedade.',
      'Para cada trecho: inicio_s e fim_s em segundos da gravação, um título curto, um gancho de abertura para aparecer escrito na tela (até 6 palavras, sem emoji) e o motivo da escolha (o que acontece ali, citando o que se vê ou ouve).',
      evitarGanchos.length ? `Não repita estes ganchos já usados: ${evitarGanchos.map((g) => `"${g}"`).join(', ')}.` : null,
      orientacao ? `Pedido do criador: ${orientacao}` : null,
      FIEL_AO_VIDEO,
      palavras.length ? `Fala da gravação, com tempo (mm:ss):\n${transcricaoComTempo(palavras)}` : 'Não há transcrição da fala: decida pelos quadros.',
      descricao ? `Anotações do Pipeline sobre esta gravação:\n${descricao}` : null,
      'No campo resumo, conte em 2 frases o que acontece na gravação.',
    ].filter(Boolean).join('\n\n');

    const out = await runClaude({ system: SYSTEM_BASE('roteirista', 'social-media'), prompt, images, schema: CORTES_SCHEMA, timeoutMs: 420_000, log: log });

    // 4) confere o que veio: dentro do vídeo, duração certa, sem sobrepor
    const ok = [];
    for (const c of out.cortes.sort((a, b) => a.inicio_s - b.inicio_s)) {
      let ini = Math.max(0, Math.min(c.inicio_s, dur - 1));
      let fim = Math.min(dur, Math.max(c.fim_s, ini + 1));
      if (fim - ini > brutoMax) fim = ini + brutoMax;
      if (fim - ini < Math.min(minS, 5)) continue;
      if (ok.some((o) => ini < o.fim && fim > o.inicio)) continue;
      ok.push({ inicio: Math.round(ini * 10) / 10, fim: Math.round(fim * 10) / 10, titulo: c.titulo, gancho: c.gancho, motivo: c.motivo });
    }
    // miniatura de cada sugestão (no meio do trecho)
    const pasta = path.join(DIRS.thumbs, `sug-${id}`);
    fs.mkdirSync(pasta, { recursive: true });
    for (const [i, c] of ok.entries()) {
      const destino = path.join(pasta, `${i + 1}.jpg`);
      await salvarQuadro(file, (c.inicio + c.fim) / 2, destino).catch(() => {});
      if (fs.existsSync(destino)) c.miniatura = urlFor('thumbs', `sug-${id}/${i + 1}.jpg`);
      // as palavras do trecho já viram as legendas do corte
      c.palavras = palavras.filter((w) => w.start >= c.inicio - 0.05 && w.end <= c.fim + 0.3);
    }
    job.resumo = out.resumo;
    job.cortes = ok;
    job.duracao = dur;
    job.status = ok.length ? 'pronto' : 'erro';
    if (!ok.length) job.erro = 'O Claude não encontrou trechos que funcionem como Short nesta gravação.';
  })().catch((e) => {
    log.error(e);
    job.status = 'erro';
    job.erro = explicarErroMidia(e);
  }).finally(persistir);
  return job;
}

app.get('/api/ai/sugerir-cortes/:id', async (req) => {
  const j = sugestoes.get(req.params.id) || await sugestoesCortes.obter(req.params.id);
  if (!j) throw fail(404, 'Sugestão não encontrada. Peça de novo.');
  return j;
});

/* ---------- Edição automática: o Claude faz o plano, o FilmCraft executa, o Remotion finaliza ---------- */
// 1) o Claude vê o trecho (quadros + fala com tempo) e devolve UM plano de edição em JSON (guardado no banco);
// 2) a ponte do Windows aplica o plano no FilmCraft sem gastar token (cortes, velocidade, zoom, música com ducking);
// 3) o corte passa a usar o vídeo editado, com legendas remapeadas, gancho e chamada final, e vai para a fila do Remotion.
const TRANSICOES = ['corte', 'flash', 'zoom', 'whip', 'glitch'];
const TIPOS_EFEITO = ['punch', 'zoom_lento', 'tremor', 'foco'];
const ESTILOS_TEXTO = ['impacto', 'etiqueta', 'meme', 'alerta'];
const num = { type: 'number' };
const PLANO_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['resumo', 'estrutura', 'segmentos', 'efeitos', 'textos', 'sons', 'palavras_destaque', 'barra_progresso', 'gancho', 'gancho_duracao_s', 'trilha', 'capitulos', 'legenda_ativar', 'legenda_estilo', 'palavras_por_linha', 'cta'],
  properties: {
    resumo: { type: 'string' },
    // o arco do vídeo: gancho → tensão → virada → recompensa (e onde cada um está)
    estrutura: { type: 'string' },
    segmentos: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false,
        required: ['inicio_s', 'fim_s', 'velocidade', 'transicao', 'replay', 'motivo'],
        properties: {
          inicio_s: num, fim_s: num, velocidade: num,
          transicao: { type: 'string', enum: TRANSICOES }, // como ESTE segmento entra
          replay: { type: 'boolean' }, // repete um momento que já passou (câmera lenta, sem fala)
          motivo: { type: 'string' },
        },
      },
    },
    efeitos: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false,
        required: ['tipo', 'em_s', 'duracao_s', 'escala', 'foco_x', 'foco_y'],
        properties: { tipo: { type: 'string', enum: TIPOS_EFEITO }, em_s: num, duracao_s: num, escala: num, foco_x: num, foco_y: num },
      },
    },
    textos: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false,
        required: ['em_s', 'duracao_s', 'texto', 'estilo', 'posicao'],
        properties: { em_s: num, duracao_s: num, texto: { type: 'string' }, estilo: { type: 'string', enum: ESTILOS_TEXTO }, posicao: { type: 'string', enum: ['topo', 'centro', 'base'] } },
      },
    },
    sons: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false,
        required: ['em_s', 'tipo', 'volume'],
        properties: { em_s: num, tipo: { type: 'string', enum: Object.keys(SONS) }, volume: num },
      },
    },
    palavras_destaque: { type: 'array', items: { type: 'string' } },
    barra_progresso: { type: 'boolean' },
    gancho: { type: 'string' },
    gancho_duracao_s: num,
    // trilha sonora por partes: cada entrada vale a partir do segmento indicado até a próxima
    // (musica_indice -1 = pausa dramática na música)
    trilha: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false,
        required: ['a_partir_do_segmento', 'musica_indice', 'volume_db', 'motivo'],
        properties: { a_partir_do_segmento: { type: 'integer' }, musica_indice: { type: 'integer' }, volume_db: num, motivo: { type: 'string' } },
      },
    },
    // só em vídeo longo: capítulos (tempo da gravação) para a descrição do YouTube
    capitulos: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['em_s', 'titulo'], properties: { em_s: num, titulo: { type: 'string' } } } },
    legenda_ativar: { type: 'boolean' },
    legenda_estilo: { type: 'string', enum: ['destaque', 'limpa', 'caixa'] },
    palavras_por_linha: { type: 'integer' },
    cta: { type: 'boolean' },
  },
};

const musicasLivres = async () => {
  if (!MEDIA_ROOTS.biblioteca) return [];
  if (Date.now() - bibliotecaCache.at > 60_000) bibliotecaCache = { at: Date.now(), items: await walk(VIDEOS) };
  return bibliotecaCache.items
    .filter((i) => AUDIO_EXT.test(i.rel) && /m[uú]sica/i.test(i.rel) && !bloqueadaContentId(i.rel))
    .map((i) => ({ rel: i.rel, nome: path.basename(i.rel).replace(/\.[^.]+$/, '') }));
};

// /media/biblioteca/x → { raiz: 'videos', rel: 'x' };  /media/uploads/x → { raiz: 'dados', rel: 'uploads/x' }
const midiaParaPonte = (url) => {
  const m = /^\/media\/([a-z]+)\/(.+)$/.exec(url || '');
  if (!m) throw fail(400, 'Vídeo de origem inválido.');
  const rel = decodeURIComponent(m[2]);
  if (m[1] === 'biblioteca') return { raiz: 'videos', rel };
  if (['uploads', 'editados', 'renders'].includes(m[1])) return { raiz: 'dados', rel: `${m[1]}/${rel}` };
  throw fail(400, 'Este tipo de mídia não pode ser editado no FilmCraft.');
};

const limitar = (v, a, b, padrao) => Math.min(b, Math.max(a, Number.isFinite(v) ? v : padrao));
const r2 = (x) => Math.round(x * 100) / 100;

/**
 * Confere o plano do Claude: segmentos dentro do trecho e na ordem do PLANO (o Claude pode
 * reordenar para abrir no clímax); replays podem repetir um momento. Valores em faixas seguras.
 */
const validarPlano = (plano, ini, fim) => {
  const segs = [];
  const usados = [];
  for (const [idx, s] of plano.segmentos.entries()) {
    const a = limitar(s.inicio_s, ini, fim, ini);
    const b = limitar(s.fim_s, a, fim, a);
    if (b - a < 0.3) continue;
    // fora do replay, não repete o mesmo pedaço da gravação
    if (!s.replay && usados.some(([x, y]) => a < y - 0.05 && b > x + 0.05)) continue;
    if (!s.replay) usados.push([a, b]);
    segs.push({
      idx, inicio: r2(a), fim: r2(b),
      velocidade: Math.round(limitar(s.velocidade, s.replay ? 25 : 50, s.replay ? 100 : 400, s.replay ? 50 : 100)),
      transicao: TRANSICOES.includes(s.transicao) ? s.transicao : 'corte',
      replay: Boolean(s.replay),
      motivo: s.motivo,
    });
  }
  if (!segs.length) throw fail(502, 'O plano do Claude não tem nenhum trecho válido.');
  return segs;
};

/** duração final (em s) dos segmentos, já com a velocidade */
const duracaoSaida = (segs) => segs.reduce((a, s) => a + (s.fim - s.inicio) / (s.velocidade / 100), 0);

/**
 * Garante a duração mínima: se o plano ficou curto, cada segmento normal "respira" para o material
 * vizinho que ainda não foi usado (primeiro o final, depois o começo), sem sobrepor outro segmento.
 */
const alongarAteMinimo = (segs, ini, fim, minimo) => {
  let falta = minimo - duracaoSaida(segs);
  if (falta <= 0.5) return segs;
  const normais = () => segs.filter((s) => !s.replay);
  // espaço livre depois/antes de um segmento até o vizinho normal mais próximo
  const livreDepois = (s) => Math.min(fim, ...normais().filter((o) => o !== s && o.inicio >= s.fim - 0.05).map((o) => o.inicio)) - s.fim;
  const livreAntes = (s) => s.inicio - Math.max(ini, ...normais().filter((o) => o !== s && o.fim <= s.inicio + 0.05).map((o) => o.fim));
  for (let volta = 0; volta < 2 && falta > 0.5; volta++) {
    for (const s of normais()) {
      if (falta <= 0.5) break;
      const vel = s.velocidade / 100;
      // na 1ª volta cada segmento cresce no máximo 12 s (espalha); na 2ª, o que precisar
      const teto = volta === 0 ? 12 : Infinity;
      const depois = Math.max(0, Math.min(livreDepois(s), falta * vel, teto));
      s.fim = r2(s.fim + depois);
      falta -= depois / vel;
      if (falta <= 0.5) break;
      const antes = Math.max(0, Math.min(livreAntes(s), falta * vel, teto));
      s.inicio = r2(s.inicio - antes);
      falta -= antes / vel;
    }
  }
  return segs;
};

/**
 * Trilha sonora por partes, no tempo do vídeo final: [{ musica, db, de, ate }].
 * Pausas (-1) ficam sem música; se o plano não trouxer nenhuma, vai a primeira da lista no vídeo inteiro.
 */
const montarTrilha = (plano, segs, musicas) => {
  if (!musicas.length) return [];
  const { lista, total } = criarMapa(segs);
  const posDoSegmento = (n) => (lista.find((s) => s.idx >= n) || { pos: total }).pos;
  const entradas = (plano.trilha || [])
    .map((e) => ({ de: r2(posDoSegmento(Math.max(0, e.a_partir_do_segmento | 0))), m: musicas[e.musica_indice] || null, db: limitar(e.volume_db, -30, -6, -16) }))
    .sort((a, b) => a.de - b.de);
  if (!entradas.length || entradas[0].de > 0.5) entradas.unshift({ de: 0, m: entradas.find((e) => e.m)?.m || musicas[0], db: entradas[0]?.db ?? -16 });
  else entradas[0].de = 0;
  const out = [];
  entradas.forEach((e, i) => {
    const ate = i + 1 < entradas.length ? entradas[i + 1].de : total;
    if (!e.m || ate - e.de < 1) return;
    const ult = out[out.length - 1];
    // mesma música seguida = um pedaço só
    if (ult && ult.musica.rel === e.m.rel && Math.abs(ult.ate - e.de) < 0.05) { ult.ate = r2(ate); return; }
    out.push({ musica: e.m, db: e.db, de: e.de, ate: r2(ate) });
  });
  return out;
};

/** tempo da gravação → tempo do vídeo editado (primeiro segmento normal que contém o instante) */
const criarMapa = (segs) => {
  const lista = [];
  let pos = 0;
  for (const s of segs) {
    const vel = s.velocidade / 100;
    lista.push({ ...s, pos, durSaida: (s.fim - s.inicio) / vel, vel });
    pos += (s.fim - s.inicio) / vel;
  }
  const mapear = (t, folga = 0.35) => {
    const achar = (filtro) => lista.find((s) => filtro(s) && t >= s.inicio - folga && t <= s.fim + folga);
    const s = achar((x) => !x.replay) || achar(() => true);
    if (!s) return null;
    return s.pos + (Math.min(s.fim, Math.max(s.inicio, t)) - s.inicio) / s.vel;
  };
  return { lista, total: pos, mapear };
};

/** leva as palavras do tempo da gravação para o tempo do vídeo editado (replays ficam sem legenda) */
const remapearPalavras = (words, segs) => {
  const { lista, total } = criarMapa(segs);
  const out = [];
  for (const s of lista) {
    if (s.replay) continue;
    for (const w of words) {
      if (w.start < s.inicio - 0.05 || w.end > s.fim + 0.05) continue;
      out.push({ text: w.text, start: s.pos + Math.max(0, w.start - s.inicio) / s.vel, end: s.pos + Math.max(0, Math.min(w.end, s.fim) - s.inicio) / s.vel });
    }
  }
  return { palavras: out, duracao: total };
};

/** efeitos visuais, textos e sons do plano no tempo do vídeo editado (vão para o Remotion) */
const montarEfeitos = (plano, segs, sons) => {
  const { lista, total, mapear } = criarMapa(segs);
  const dentro = (t) => t != null && t >= 0 && t < total;
  const zooms = (plano.efeitos || []).slice(0, 60).map((e) => {
    const inicio = mapear(e.em_s);
    if (!dentro(inicio)) return null;
    return {
      tipo: TIPOS_EFEITO.includes(e.tipo) ? e.tipo : 'punch', inicio: r2(inicio),
      dur: r2(limitar(e.duracao_s, 0.2, e.tipo === 'zoom_lento' ? 12 : 4, 1)),
      escala: r2(limitar(e.escala, 1, 1.8, 1.25)), x: r2(limitar(e.foco_x, 0, 1, 0.5)), y: r2(limitar(e.foco_y, 0, 1, 0.5)),
    };
  }).filter(Boolean);
  const textos = (plano.textos || []).slice(0, 30).map((x) => {
    const inicio = mapear(x.em_s);
    const texto = String(x.texto || '').trim().slice(0, 60);
    if (!dentro(inicio) || !texto) return null;
    return { inicio: r2(inicio), dur: r2(limitar(x.duracao_s, 0.6, 5, 1.6)), texto, estilo: ESTILOS_TEXTO.includes(x.estilo) ? x.estilo : 'impacto', posicao: ['topo', 'centro', 'base'].includes(x.posicao) ? x.posicao : 'centro' };
  }).filter(Boolean);
  // transições entram no começo de cada segmento (menos o primeiro)
  const transicoes = lista.slice(1).filter((s) => s.transicao !== 'corte').map((s) => ({ em: r2(s.pos), tipo: s.transicao }));
  const somDe = (tipo) => (sons[tipo] ? `/media/sfx/${sons[tipo]}` : null);
  const listaSons = (plano.sons || []).slice(0, 80).map((s) => {
    const em = mapear(s.em_s);
    const src = somDe(s.tipo);
    if (!dentro(em) || !src) return null;
    // o riser termina no instante pedido (é a subida até o momento)
    const inicio = s.tipo === 'riser' ? Math.max(0, em - SONS.riser.dur) : em;
    return { inicio: r2(inicio), src, volume: r2(limitar(s.volume, 0.05, 1, 0.6)), tipo: s.tipo };
  }).filter(Boolean);
  // transição sem som perto ganha o som que combina com ela
  const auto = { whip: 'whoosh', zoom: 'whoosh', glitch: 'glitch' };
  for (const t of transicoes) {
    const tipo = auto[t.tipo];
    if (tipo && somDe(tipo) && !listaSons.some((s) => Math.abs(s.inicio - t.em) < 0.35)) {
      listaSons.push({ inicio: r2(Math.max(0, t.em - 0.2)), src: somDe(tipo), volume: 0.45, tipo });
    }
  }
  listaSons.sort((a, b) => a.inicio - b.inicio);
  const destaques = [...new Set((plano.palavras_destaque || []).map((p) => String(p).toLowerCase().replace(/[^\p{L}\p{N}]/gu, '')).filter((p) => p.length > 1))].slice(0, 25);
  return { zooms, textos, transicoes, sons: listaSons, destaques, barra: Boolean(plano.barra_progresso) };
};

/** capítulos no tempo do vídeo final (regras do YouTube: 1º em 0:00, 3 ou mais, cada um com 10 s ou mais) */
const montarCapitulos = (plano, segs) => {
  const { mapear, total } = criarMapa(segs);
  const out = [];
  for (const c of [...(plano.capitulos || [])].sort((a, b) => a.em_s - b.em_s)) {
    let t = mapear(c.em_s, 2);
    const titulo = String(c.titulo || '').trim().slice(0, 80);
    if (t == null || !titulo) continue;
    if (!out.length) t = 0;
    if (out.length && (t - out[out.length - 1].t < 10 || total - t < 10)) continue;
    out.push({ t: Math.round(t), titulo });
  }
  return out.length >= 3 ? out : [];
};
const fmtCapitulo = (t) => {
  const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), sec = Math.floor(t % 60);
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}` : `${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
};

const edicoes = new Map();

// fases da edição e quanto cada uma pesa na barra (somam 1)
const FASES_EDICAO = [
  { id: 'fala', nome: 'Lendo a fala', peso: 0.05 },
  { id: 'plano', nome: 'Claude planejando', peso: 0.2 },
  { id: 'filmcraft', nome: 'FilmCraft editando', peso: 0.45 },
  { id: 'remotion', nome: 'Legendas e finalização', peso: 0.3 },
];
/** marca a fase atual e o avanço dentro dela (0..1); recalcula o total e o tempo que falta */
const avancar = (job, fase, dentro = 0, etapa) => {
  let base = 0;
  for (const f of FASES_EDICAO) {
    if (f.id === fase) break;
    base += f.peso;
  }
  const peso = FASES_EDICAO.find((f) => f.id === fase).peso;
  job.fase = fase;
  if (etapa) job.etapa = etapa;
  job.progresso = Math.max(job.progresso || 0, Math.min(0.999, base + peso * Math.min(1, Math.max(0, dentro))));
  const passou = (Date.now() - (job.inicio || Date.now())) / 1000;
  job.eta = job.progresso > 0.04 && passou > 5 ? Math.round((passou * (1 - job.progresso)) / job.progresso) : null;
};
let filaEdicao = Promise.resolve(); // uma edição por vez (o FilmCraft e o Remotion são pesados)

async function editarProjeto(job, { novo, formatos }, log) {
  const proj = await projetos.obter(job.projeto);
  if (!proj) throw fail(404, 'Corte não encontrado.');
  // reedição parte sempre da gravação original, não do vídeo já editado
  const orig = proj.meta?.edicao?.original || {
    videoSrc: proj.props.videoSrc, trimStart: proj.props.trimStart, trimEnd: proj.props.trimEnd,
    words: proj.props.captions?.source === 'video' ? proj.props.captions.words || [] : [],
  };
  if (!orig.videoSrc) throw fail(400, 'O corte não tem vídeo.');
  let file;
  try { file = mediaPathFromUrl(orig.videoSrc); } catch {
    throw fail(404, `A gravação original deste corte não existe mais (${decodeURIComponent(orig.videoSrc.split('/').pop())}). Ela foi removida da pasta de vídeos? Recupere de D:\\Videos\\.lixeira-painel.`);
  }
  const ini = orig.trimStart || 0;
  const fim = orig.trimEnd || (await duracaoVideo(file));
  const faixa = fim - ini;
  const formato = proj.props.format || 'vertical';
  const curto = formato !== 'horizontal';

  // fala com tempo: a do corte, ou transcrição da gravação (fica em cache)
  avancar(job, 'fala', 0.1, 'lendo a fala');
  let words = orig.words?.length ? orig.words : [];
  if (!words.length && apiKey()) {
    const todas = await transcricaoPalavras(file, { cacheDir: CACHE_DIR, transcrever: transcreverPalavras }).catch((e) => { log.warn(e, 'transcrição'); return []; });
    words = todas.filter((w) => w.start >= ini - 0.05 && w.end <= fim + 0.3);
  }
  // análise sem token: energia do áudio e mudanças de cena (onde estão os momentos fortes)
  avancar(job, 'fala', 0.5, 'procurando os momentos fortes (áudio e imagem)');
  const [energia, cenas] = await Promise.all([
    energiaAudio(file, ini, fim).catch((e) => { log.warn(e, 'energia do áudio'); return []; }),
    mudancasDeCena(file, ini, fim).catch((e) => { log.warn(e, 'mudanças de cena'); return []; }),
  ]);
  const semSom = energia.length > 0 && energia.every((e) => e.db < -70);
  const momentos = momentosDoTrecho(energia, cenas, ini, fim);
  job.analise = { picos: momentos.picos.length, cenas: cenas.length, semSom };
  const musicas = await musicasLivres();
  const mmss = (x) => `${String(Math.floor(x / 60)).padStart(2, '0')}:${(x % 60).toFixed(1).padStart(4, '0')}`;
  // Shorts do canal: de 1:30 a 2:30 (pedido do criador); se o trecho for menor, usa quase tudo
  const SHORT_MIN = 90, SHORT_MAX = 150;
  // vídeo longo: 8 min ou mais libera anúncios no meio (mid-roll) quando o canal for monetizado
  const minimo = curto ? Math.min(SHORT_MIN, faixa * 0.92) : faixa >= 600 ? Math.min(faixa * 0.8, Math.max(480, faixa * 0.45)) : faixa * 0.6;
  const maximo = curto ? Math.min(SHORT_MAX, faixa * 1.15) : faixa * 0.85;
  const mmssCurto = (x) => `${Math.floor(x / 60)}:${String(Math.round(x % 60)).padStart(2, '0')}`;
  const alvo = curto
    ? `entre ${mmssCurto(minimo)} e ${mmssCurto(maximo)} (${Math.round(minimo)} a ${Math.round(maximo)} segundos) — Short/TikTok/Reels do canal. NUNCA menos de ${Math.round(minimo)} s: corte só o tempo morto de verdade (menu, loading, andar sem nada acontecendo) e mantenha a história inteira com começo, meio e fim. Se faltar material forte, use replays em câmera lenta dos melhores momentos em vez de encurtar.`
    : `entre ${mmssCurto(minimo)} e ${mmssCurto(maximo)} — vídeo LONGO para o YouTube (o canal quer ser monetizado). NUNCA menos de ${mmssCurto(minimo)}: corte o tempo morto, mas mantenha o contexto e a progressão.`;
  const system = SYSTEM_BASE('editor', 'roteirista');
  const prompt = [
    `Edite este trecho da gravação "${path.basename(file)}"${proj.meta?.jogo ? ` do jogo ${proj.meta.jogo}` : ''}. Ele vai de ${ini.toFixed(1)} s a ${fim.toFixed(1)} s da gravação (${faixa.toFixed(1)} s).`,
    `Duração final desejada: ${alvo}. Formato final: ${FORMATS_LABEL[formato] || formato}.`,
    proj.meta?.ideia ? `Por que este trecho foi escolhido: ${proj.meta.ideia}` : null,
    curto ? null : VIDEO_LONGO_MONETIZAVEL,
    [
      'COMO DEVOLVER O PLANO (todos os tempos em segundos DA GRAVAÇÃO, dentro do trecho):',
      '- segmentos: na ordem em que vão aparecer no vídeo final (pode abrir com o clímax e depois voltar). velocidade em % (100 normal, até 400 para acelerar deslocamento sem fala). transicao = como o segmento ENTRA (o primeiro é sempre corte). replay=true repete um momento que já apareceu, em câmera lenta (25–60%), sem legenda.',
      '- efeitos (câmera virtual): punch (zoom seco no instante, 1.15–1.4), zoom_lento (aproximação contínua durante a duração, 1.05–1.25), tremor (impacto, explosão, susto; escala 1), foco (zoom suave num detalhe, 1.3–1.8). foco_x/foco_y de 0 a 1 = ponto do quadro que importa.',
      '- textos na tela: curtos (até 5 palavras), em português falado, com humor/opinião, sem repetir a legenda. Estilos: impacto (grande, para reação/clímax), etiqueta (explica/aponta algo), meme (zoeira, ironia), alerta (perigo, erro, "não faça isso").',
      `- sons: efeitos sonoros no instante exato do evento (o riser termina no instante pedido). volume 0.2–0.9. Transições whip/zoom/glitch já ganham som sozinhas. Tipos: ${Object.entries(SONS).map(([k, s]) => `${k} = ${s.nome}`).join('; ')}.`,
      '- palavras_destaque: palavras-chave da fala que ficam coloridas na legenda (números, nomes, palavras de emoção).',
      '- barra_progresso: true em Shorts com mais de 20 s (segura a retenção).',
      '- trilha: a música do vídeo POR PARTES. Cada entrada vale a partir do segmento a_partir_do_segmento (índice 0 = primeiro segmento da sua lista) até a próxima entrada. musica_indice = índice da lista de músicas abaixo; -1 = pausa na música (silêncio dramático de 1–3 s antes do clímax, para o impacto bater mais forte). volume_db de −24 (fundo de fala) a −8 (sem fala, momento épico). Use a música para contar a história: abra com energia, troque de música (ou entre numa pausa) na virada, e solte a mais intensa na recompensa/clímax. Em vídeos de 1:30+ use de 2 a 4 entradas; a primeira começa no segmento 0. As músicas são do próprio canal e livres de direitos autorais: SEMPRE use música (só deixe a trilha vazia se a lista estiver vazia).',
    ].join('\n'),
    musicas.length ? `Músicas liberadas (livres de copyright):\n${musicas.map((m, i) => `${i}. ${m.nome}`).join('\n')}` : 'Não há músicas disponíveis: deixe a trilha vazia.',
    semSom ? 'ATENÇÃO: a gravação NÃO TEM SOM (a faixa de áudio está muda). Todo o áudio do vídeo vai ser a música e os efeitos sonoros: capriche neles, música mais alta (−8 a −12 dB) e legenda_ativar false.' : null,
    textoDosMomentos(momentos, ini) ? `ANÁLISE AUTOMÁTICA DO TRECHO (use para achar os momentos bons):\n${textoDosMomentos(momentos, ini)}` : null,
    FIEL_AO_VIDEO,
    words.length ? `Fala do trecho, com tempo da gravação (mm:ss):\n${transcricaoComTempo(words)}` : 'Não há fala transcrita: decida pelos quadros e deixe legenda_ativar false.',
  ].filter(Boolean).join('\n\n');

  const chave = chaveDe('editar', claudeModel(), system, prompt, await assinaturaArquivo(orig.videoSrc));
  avancar(job, 'plano', 0, 'o Claude está assistindo e planejando');
  // o Claude não informa progresso: a barra anda pela duração típica (~1 s para cada 2 s de trecho, entre 45 s e 4 min)
  const estimativa = Math.min(240, Math.max(45, faixa / 2));
  const t0 = Date.now();
  const relogio = setInterval(() => avancar(job, 'plano', 0.95 * (1 - Math.exp(-((Date.now() - t0) / 1000) / estimativa))), 1000);
  const { resultado: plano, doCache } = await comCache({
    tipo: 'editar', chave, modelo: claudeModel(), novo,
    gerar: async () => {
      // quadros espalhados + nos picos de áudio e nas mudanças de cena (é onde costuma estar o momento bom)
      const n = curto ? Math.max(10, Math.min(22, Math.round(faixa / 3))) : Math.max(16, Math.min(40, Math.round(faixa / 25)));
      const base = Array.from({ length: n }, (_, i) => ini + (faixa * (i + 0.5)) / n);
      const extras = [...momentos.picos.map((p) => p.t), ...cenas.map((t) => t + 0.3)]
        .filter((t) => t > ini && t < fim && base.every((b) => Math.abs(b - t) > faixa / n / 3));
      const tempos = [...base, ...extras.slice(0, (curto ? 32 : 56) - n)];
      const qs = await frames(file, { inicio: ini, fim, tempos, largura: 512 });
      const images = qs.map((f) => ({ legenda: `Quadro em ${mmss(f.t)} (${f.t.toFixed(1)} s da gravação):`, base64: f.base64 }));
      return runClaude({ system, prompt, images, schema: PLANO_SCHEMA, timeoutMs: 420_000, log });
    },
  }).finally(() => clearInterval(relogio));
  job.plano = plano;
  job.doCache = doCache;
  const segs = alongarAteMinimo(validarPlano(plano, ini, fim), ini, fim, minimo);
  const trilha = montarTrilha(plano, segs, musicas);
  const nomesMusicas = [...new Set(trilha.map((x) => x.musica.nome))].join(' → ') || null;
  const capitulos = curto ? [] : montarCapitulos(plano, segs);

  // 2) FilmCraft (ponte do Windows)
  avancar(job, 'filmcraft', 0, doCache ? 'plano reaproveitado (0 tokens); enviando para o FilmCraft' : 'enviando para o FilmCraft');
  const nome = `${proj.id}-${Date.now().toString(36)}`;
  const { id: ponteId } = await ponteFetch('/filmcraft', {
    method: 'POST',
    body: JSON.stringify({
      nome,
      fonte: midiaParaPonte(orig.videoSrc),
      // os efeitos visuais e sonoros ficam no Remotion; no FilmCraft vão os cortes, a velocidade e a música
      segmentos: segs.map((s) => ({ inicio: s.inicio, fim: s.fim, velocidade: s.velocidade, mudo: s.replay })),
      // trilha por partes, em segundos do vídeo final (pausas ficam sem música)
      musicas: trilha.map((x) => ({ arquivo: { raiz: 'videos', rel: x.musica.rel }, db: x.db, de: x.de, ate: x.ate })),
      // ponte antiga (sem trilha por partes) usa só esta: a primeira música no vídeo inteiro
      musica: trilha[0] ? { arquivo: { raiz: 'videos', rel: trilha[0].musica.rel }, db: trilha[0].db } : null,
      ducking: words.length > 0 && !semSom,
    }),
  });
  let r;
  for (;;) {
    await new Promise((res) => setTimeout(res, 3000));
    const s = await ponteFetch(`/filmcraft/${ponteId}`);
    avancar(job, 'filmcraft', s.progresso || 0, s.etapa || s.status);
    if (s.status === 'pronto') { r = s.resultado; break; }
    if (s.status === 'erro') throw fail(502, `FilmCraft: ${s.erro}`);
  }

  // 3) o corte passa a usar o vídeo editado
  const { palavras, duracao } = remapearPalavras(words, segs);
  const editado = urlFor('editados', path.basename(r.arquivo));
  const dur = r.duracao || duracao;
  const props = {
    ...proj.props,
    videoSrc: editado,
    videoDuration: dur,
    trimStart: 0,
    trimEnd: dur,
    zoom: 1,
    music: { ...proj.props.music, src: null }, // a música já está mixada no FilmCraft
    hook: { text: plano.gancho || '', duration: Math.min(5, Math.max(1.5, plano.gancho_duracao_s || 2.5)) },
    captions: {
      ...proj.props.captions,
      enabled: plano.legenda_ativar && palavras.length > 0,
      source: 'video',
      words: palavras,
      style: plano.legenda_estilo,
      wordsPerLine: Math.min(6, Math.max(1, plano.palavras_por_linha || 3)),
    },
    cta: { ...(proj.props.cta || { preset: curto ? 'shorts' : 'longo', color: '#FFD43B' }), enabled: Boolean(plano.cta) },
    efeitos: montarEfeitos(plano, segs, SONS_ARQ),
  };
  const meta = {
    ...(proj.meta || {}),
    edicao: {
      original: orig, plano, segmentos: segs, musica: nomesMusicas, capitulos, trilha: trilha.map((x) => ({ musica: x.musica.nome, de: x.de, ate: x.ate, db: x.db })),
      arquivo: editado, projetoFilmCraft: r.projeto, editadoEm: Date.now(),
    },
  };
  await projetos.salvar({ ...proj, props, meta, updatedAt: Date.now() });

  avancar(job, 'remotion', 0, 'na fila de renderização');
  const criados = enfileirarRender({ props, formats: formatos?.length ? formatos : [formato], name: proj.name, projeto: proj.id });
  // acompanha a renderização final (legendas, gancho, chamada) até o MP4 ficar pronto
  for (;;) {
    await new Promise((res) => setTimeout(res, 2000));
    const rs = criados.map((c) => jobs.get(c.id)).filter(Boolean);
    const media = rs.reduce((a, x) => a + (x.progress || 0), 0) / Math.max(1, rs.length);
    const erro = rs.find((x) => x.status === 'erro');
    if (erro) throw fail(502, `Renderização final: ${erro.error}`);
    avancar(job, 'remotion', media, rs.some((x) => x.status === 'renderizando') ? `renderizando ${Math.round(media * 100)}%` : 'na fila de renderização');
    if (rs.every((x) => x.status === 'pronto')) {
      job.renders = rs.map((x) => ({ id: x.id, format: x.format, url: x.url }));
      break;
    }
  }
  // automação: o vídeo final vai sozinho para o Google Drive (se estiver ligado em Conexões)
  const ds = await drive.status().catch(() => null);
  if (ds?.conectado && ds.auto) {
    job.drive = job.renders.map((x) => {
      try { return enviarProDrive(x.url, log); } catch (e) { log.warn(e, 'drive'); return null; }
    }).filter(Boolean);
  }
  return { duracao: dur, segmentos: segs.length, musica: nomesMusicas };
}

const VIDEO_LONGO_MONETIZAVEL = [
  'VÍDEO LONGO MONETIZÁVEL (diretrizes do Programa de Parcerias do YouTube):',
  '- Conteúdo original e TRANSFORMADOR: não é só a gravação crua acelerada. Você acrescenta valor com estrutura, comentários na tela (textos de contexto, opinião, humor, "o que eu aprendi"), destaques e replays. Gameplay sem nenhum acréscimo corre risco de "conteúdo reutilizado".',
  '- Estrutura: abertura de 10–30 s que promete o que vem (mostre um relance do melhor momento), depois blocos/capítulos com começo e fim claros, um clímax e um fechamento com a CTA.',
  '- capitulos: de 4 a 10, o primeiro no início do primeiro segmento; títulos curtos e concretos (o que acontece ali). Cada capítulo com pelo menos 10 s de vídeo final.',
  '- Ritmo de vídeo longo: menos efeitos que um Short (um texto ou efeito a cada 15–40 s), tempo para o espectador entender; acelere (150–300%) construção e deslocamento repetitivos.',
  '- Seguro para anunciantes: sem palavrões fortes nos textos, sem violência gratuita destacada, nada enganoso no gancho.',
  '- Música só da lista liberada, em partes (trilha) que acompanham os capítulos.',
].join('\n');

const FORMATS_LABEL = { vertical: '9:16 vertical', horizontal: '16:9 horizontal', square: '1:1 quadrado' };

app.post('/api/projects/:id/editar', {
  schema: {
    params: idParams,
    body: {
      type: ['object', 'null'], additionalProperties: false,
      properties: {
        novo: { type: 'boolean', default: false },
        formatos: { type: 'array', maxItems: 3, uniqueItems: true, items: { type: 'string', enum: FORMAT_IDS } },
      },
    },
  },
}, async (req) => iniciarEdicao(req.params.id, req.body || {}, req.log));

/** põe um corte na fila de edição automática (Claude → FilmCraft → Remotion); devolve o job */
async function iniciarEdicao(projetoId, opcoes, log) {
  if (!claudeStatus().ok) throw fail(400, 'Conecte o Claude primeiro.');
  const st = await ponteFetch('/status', { timeout: 2000 });
  if (!st.filmcraft) throw fail(503, 'A ponte está rodando, mas não achou o FilmCraft. Ajuste FILMCRAFT_CLI no .env.');
  const ativo = [...edicoes.values()].find((j) => j.projeto === projetoId && !['pronto', 'erro'].includes(j.status));
  if (ativo) return ativo;
  const id = crypto.randomUUID().slice(0, 8);
  const proj = await projetos.obter(projetoId);
  if (!proj) throw fail(404, 'Corte não encontrado.');
  const job = {
    id, projeto: projetoId, nome: proj.name, status: 'na fila', etapa: 'esperando a vez',
    fase: null, fases: FASES_EDICAO.map(({ id: fid, nome }) => ({ id: fid, nome })), progresso: 0, eta: null, criadoEm: Date.now(),
  };
  edicoes.set(id, job);
  filaEdicao = filaEdicao.then(async () => {
    job.status = 'editando';
    job.inicio = Date.now();
    try {
      job.resultado = await editarProjeto(job, opcoes, log);
      job.status = 'pronto';
      job.etapa = 'pronto';
      job.progresso = 1;
      job.eta = 0;
    } catch (e) {
      log.error(e);
      job.status = 'erro';
      job.erro = explicarErroMidia(e);
    } finally {
      job.fim = Date.now();
    }
  });
  return job;
}
app.get('/api/edicoes', async () => [...edicoes.values()].sort((a, b) => b.criadoEm - a.criadoEm).slice(0, 30));
app.get('/api/edicoes/:id', async (req) => {
  const j = edicoes.get(req.params.id);
  if (!j) throw fail(404, 'Edição não encontrada (o servidor reiniciou?).');
  return j;
});

app.get('/api/canal', async () => ({ texto: canal() }));
app.put('/api/canal', { schema: { body: { type: 'object', required: ['texto'], properties: { texto: { type: 'string', maxLength: 30000 } } } } }, async (req) => {
  await fsp.writeFile(CANAL_FILE, req.body.texto);
  return { ok: true };
});

/* ---------- YouTube ---------- */
const youtube = createYouTube({
  clientSecretPath: process.env.YOUTUBE_CLIENT_SECRET || path.join(CONFIG, 'client_secret.json'),
  tokenPath: path.join(CONFIG, 'youtube_token.json'),
  redirectUri: `${PUBLIC_URL}/`,
  log: app.log,
});

/* ---------- Google Drive (envio dos vídeos editados) ---------- */
const drive = createDrive({
  clientSecretPath: process.env.YOUTUBE_CLIENT_SECRET || path.join(CONFIG, 'client_secret.json'),
  tokenPath: path.join(CONFIG, 'drive_token.json'),
  redirectUri: `${PUBLIC_URL}/`,
  loginHint: process.env.DRIVE_EMAIL || '',
  log: app.log,
});

// o Google volta para a raiz (http://localhost:PORTA/?state=…&code=…), como no app instalado do Pipeline
app.addHook('onRequest', async (req, reply) => {
  if (req.method !== 'GET' || !req.url.startsWith('/?')) return;
  const q = new URLSearchParams(req.url.slice(2));
  const state = q.get('state');
  if (state && drive.isCallback(state)) {
    try {
      if (q.get('error')) throw new Error(q.get('error'));
      const conta = await drive.finishLogin(q.get('code'), state);
      return reply.redirect(`/?conexao=drive&conta=${encodeURIComponent(conta?.email || conta?.nome || '')}`);
    } catch (e) {
      req.log.error(e);
      return reply.redirect(`/?conexao=drive&erro=${encodeURIComponent(e.message)}`);
    }
  }
  if (!state || !youtube.isCallback(state)) return;
  try {
    if (q.get('error')) throw new Error(q.get('error'));
    const canalYt = await youtube.finishLogin(q.get('code'), state);
    return reply.redirect(`/?youtube=conectado&canal=${encodeURIComponent(canalYt?.nome || '')}`);
  } catch (e) {
    req.log.error(e);
    return reply.redirect(`/?youtube=erro&msg=${encodeURIComponent(e.message)}`);
  }
});
app.get('/api/youtube/login', async (_req, reply) => reply.redirect(youtube.authUrl()));

app.get('/api/drive/login', async (_req, reply) => reply.redirect(drive.authUrl()));
app.post('/api/drive/logout', async () => { await drive.logout(); return { ok: true }; });
app.put('/api/drive/config', {
  schema: { body: { type: 'object', additionalProperties: false, required: ['auto'], properties: { auto: { type: 'boolean' } } } },
}, async (req) => { await drive.setAuto(req.body.auto); return drive.status(); });

// envios para o Drive: um por vez, com progresso; o link fica registrado junto do render
const enviosDrive = new Map();
let filaDrive = Promise.resolve();
const marcarDrive = (file, d) => (registroFila = registroFila.then(async () => {
  const r = lerRenders();
  r[file] = { ...(r[file] || {}), drive: d };
  await fsp.writeFile(`${RENDERS_INDEX}.tmp`, JSON.stringify(r, null, 2));
  await fsp.rename(`${RENDERS_INDEX}.tmp`, RENDERS_INDEX);
}));
function enviarProDrive(url, log) {
  const file = mediaPathFromUrl(url);
  if (!file.startsWith(DIRS.renders + path.sep)) throw fail(400, 'Só vídeos exportados vão para o Drive.');
  const nome = path.basename(file);
  const ja = [...enviosDrive.values()].find((e) => e.arquivo === nome && e.status !== 'erro');
  if (ja) return ja;
  const envio = { id: crypto.randomUUID().slice(0, 8), arquivo: nome, url, status: 'na fila', progresso: 0, criadoEm: Date.now() };
  enviosDrive.set(envio.id, envio);
  filaDrive = filaDrive.then(async () => {
    envio.status = 'enviando';
    try {
      const r = await drive.enviar(file, nome, (p) => { envio.progresso = p; });
      envio.status = 'pronto';
      envio.link = r.link;
      await marcarDrive(nome, { id: r.id, link: r.link, enviadoEm: Date.now() });
    } catch (e) {
      log.error(e);
      envio.status = 'erro';
      envio.erro = e.message;
    }
  });
  return envio;
}
app.post('/api/drive/enviar', {
  schema: { body: { type: 'object', additionalProperties: false, required: ['url'], properties: { url: { type: 'string', maxLength: 600, pattern: '^/media/renders/' } } } },
}, async (req) => {
  if (!(await drive.status()).conectado) throw fail(400, 'Conecte o Google Drive em Conexões.');
  return enviarProDrive(req.body.url, req.log);
});
app.get('/api/drive/envios', async () => [...enviosDrive.values()].sort((a, b) => b.criadoEm - a.criadoEm).slice(0, 50));
app.post('/api/youtube/logout', async () => { await youtube.logout(); return { ok: true }; });
app.get('/api/youtube/playlists', async () => youtube.playlists());

/* ---------- Publicações: YouTube (automático); TikTok e Instagram manuais, só como controle ---------- */
const savePub = (p) => publicacoes.salvar(p);
const listPubs = (filtro) => publicacoes.listar(filtro); // mais novas primeiro
const publicView = ({ sessionUrl, ...p }) => p;

// uma fila por plataforma: envios da mesma rede não correm em paralelo
const filas = { youtube: [] };
const rodando = { youtube: false };
const enfileirar = (p) => { filas[p.plataforma].push(p.id); rodarFila(p.plataforma); };

const processar = {
  async youtube(p) {
    const video = await youtube.upload(p, mediaPathFromUrl(p.arquivo), savePub);
    p.videoId = video.id;
    p.link = p.meta.formato === 'vertical' ? `https://youtube.com/shorts/${video.id}` : `https://youtu.be/${video.id}`;
    p.sessionUrl = null;
    p.status = p.meta.publicarEm ? 'agendado' : p.meta.privacidade === 'public' ? 'publicado' : 'enviado';
    p.avisos = [];
    if (p.thumbnail) await youtube.setThumbnail(video.id, mediaPathFromUrl(p.thumbnail)).catch((e) => p.avisos.push(`Thumbnail não aplicada: ${e.message}`));
    if (p.meta.playlistId) await youtube.addToPlaylist(video.id, p.meta.playlistId).catch((e) => p.avisos.push(`Não entrou na playlist: ${e.message}`));
  },

};

const rodarFila = async (plat) => {
  if (rodando[plat]) return;
  rodando[plat] = true;
  while (filas[plat].length) {
    const p = await publicacoes.obter(filas[plat].shift());
    if (!p) continue; // removida enquanto esperava na fila
    p.status = 'enviando';
    p.erro = null;
    await savePub(p);
    try {
      await processar[plat](p);
    } catch (e) {
      app.log.error(e);
      p.status = 'erro';
      p.erro = e.message;
    }
    await savePub(p);
  }
  rodando[plat] = false;
};

// envio interrompido por reinício vira erro com "tentar de novo" (o do YouTube continua de onde parou)
for (const p of await listPubs()) {
  if (p.status === 'enviando' || p.status === 'processando') {
    p.status = 'erro';
    p.erro = p.plataforma === 'youtube' ? 'O envio foi interrompido. Clique em tentar de novo para continuar de onde parou.' : 'O envio foi interrompido. Tente de novo.';
    await savePub(p);
  }
}

// TikTok sem API: envios antigos (agendados, em rascunho, com erro) viram "para postar" à mão, mantendo a data como lembrete
for (const p of await listPubs({ plataforma: 'tiktok' })) {
  if (p.meta.modo === 'manual' && !['agendado', 'na fila', 'enviando', 'processando', 'no rascunho', 'erro'].includes(p.status)) continue;
  if (p.status === 'postado' || p.status === 'publicado') { p.meta.modo = 'manual'; await savePub(p); continue; }
  p.meta.modo = 'manual';
  p.status = 'para postar';
  p.erro = null;
  p.nota = null;
  await savePub(p);
}

const metaSchema = {
  type: 'object', additionalProperties: false,
  required: ['titulo'],
  properties: {
    titulo: { type: 'string', maxLength: 100 },
    descricao: { type: 'string', maxLength: 5000, default: '' },
    tags: { type: 'array', maxItems: 30, items: { type: 'string', maxLength: 100 }, default: [] },
    categoria: { type: 'string', pattern: '^[0-9]{1,3}$', default: '20' },
    privacidade: { type: 'string', enum: ['private', 'unlisted', 'public'], default: 'private' },
    publicarEm: { type: ['string', 'null'], maxLength: 40 },
    playlistId: { type: ['string', 'null'], maxLength: 80 },
    paraCriancas: { type: 'boolean', default: false },
    conteudoSintetico: { type: 'boolean', default: false },
    notificar: { type: 'boolean', default: true },
    formato: { type: 'string', enum: FORMAT_IDS },
    legenda: { type: 'string', maxLength: 2200 },
    // TikTok e Instagram: sempre manual (sem API); agendarEm é só a data planejada
    modo: { type: 'string', enum: ['manual'], default: 'manual' },
    agendarEm: { type: ['string', 'null'], maxLength: 40 },
    capaS: { type: 'number', minimum: 0, maximum: 3600 },
  },
};

app.get('/api/publicacoes', async (req) => {
  const all = await listPubs(req.query.projeto ? { projetoId: String(req.query.projeto) } : {});
  return all.map(publicView);
});

app.post('/api/publicacoes', {
  schema: {
    body: {
      type: 'object', additionalProperties: false,
      required: ['plataforma', 'arquivo', 'meta'],
      properties: {
        plataforma: { type: 'string', enum: ['youtube', 'tiktok', 'instagram'] },
        projeto: { type: 'string', maxLength: 40 },
        arquivo: { type: 'string', maxLength: 400, pattern: '^/media/renders/' },
        thumbnail: { type: ['string', 'null'], maxLength: 400, pattern: '^/media/thumbs/' },
        meta: metaSchema,
      },
    },
  },
}, async (req) => {
  const { plataforma, projeto, arquivo, thumbnail, meta } = req.body;
  // publicarEm é o agendamento do YouTube; nas outras redes quem manda é agendarEm
  if (plataforma !== 'youtube') meta.publicarEm = null;
  const file = mediaPathFromUrl(arquivo);
  let automatico = false;
  if (plataforma === 'youtube') {
    const erros = validarMeta(meta);
    if (erros.length) throw fail(400, erros.join(' '));
    if (!(await youtube.status()).conectado) throw fail(400, 'Conecte o YouTube antes de publicar.');
    automatico = true;
  }
  // TikTok e Instagram: sem integração (as APIs foram retiradas). Fica só o controle manual; agendarEm vira lembrete.
  if (plataforma !== 'youtube') meta.modo = 'manual';
  const p = await savePub({
    id: crypto.randomUUID().slice(0, 8),
    plataforma, projeto, arquivo, thumbnail: plataforma === 'youtube' ? thumbnail || null : null, meta,
    status: automatico ? 'na fila' : 'para postar',
    enviado: 0,
    criadoEm: Date.now(),
  });
  if (automatico) enfileirar(p);
  return publicView(p);
});

app.post('/api/publicacoes/:id/:acao', {
  schema: { params: { type: 'object', properties: { id: { type: 'string', pattern: '^[a-f0-9]{8}$' }, acao: { type: 'string', enum: ['tentar', 'postado', 'pendente', 'remover', 'excluir-youtube'] } } } },
}, async (req) => {
  const p = await publicacoes.obter(req.params.id);
  if (!p) throw fail(404, 'Publicação não encontrada');
  const manual = p.plataforma !== 'youtube' && (p.meta.modo || 'manual') === 'manual';
  switch (req.params.acao) {
    case 'tentar':
      if (manual || p.status !== 'erro') throw fail(409, 'Só dá para tentar de novo um envio automático que falhou.');
      if (p.meta.publicarEm && new Date(p.meta.publicarEm).getTime() < Date.now() + 15 * 60_000) {
        throw fail(400, 'O horário agendado já passou ou está perto demais. Remova e publique de novo com outro horário.');
      }
      p.status = 'na fila';
      await savePub(p);
      enfileirar(p);
      break;
    case 'postado':
    case 'pendente':
      if (!manual) throw fail(409, 'O status deste envio é atualizado sozinho.');
      p.status = req.params.acao === 'postado' ? 'postado' : 'para postar';
      p.postadoEm = req.params.acao === 'postado' ? Date.now() : null;
      await savePub(p);
      break;
    case 'remover':
      if (p.status === 'enviando') throw fail(409, 'Espere o envio terminar.');
      await publicacoes.remover(p.id);
      return { ok: true };
    case 'excluir-youtube':
      // apaga o vídeo do canal e tira da lista (irreversível; a tela pede confirmação)
      if (p.plataforma !== 'youtube' || !p.videoId) throw fail(409, 'Esta publicação não tem vídeo no YouTube.');
      await youtube.excluir(p.videoId);
      await publicacoes.remover(p.id);
      return { ok: true, excluido: p.videoId };
  }
  return publicView(p);
});


// confere a cada 10 min se os agendados já foram ao ar (como o conferir_publicados do Pipeline)
const conferirAgendados = async () => {
  try {
    const st = await youtube.status();
    if (!st.conectado) return;
    const pubs = (await listPubs()).filter((p) => p.plataforma === 'youtube' && p.videoId && ['agendado', 'enviado'].includes(p.status));
    if (!pubs.length) return;
    const statuses = await youtube.statuses(pubs.map((p) => p.videoId));
    for (const p of pubs) {
      const s = statuses[p.videoId];
      if (!s) { p.status = 'erro'; p.erro = 'O vídeo não foi encontrado no canal (apagado?).'; await savePub(p); continue; }
      if (s.privacyStatus === 'public' && p.status !== 'publicado') { p.status = 'publicado'; await savePub(p); }
      if (s.uploadStatus === 'rejected' || s.uploadStatus === 'failed') { p.status = 'erro'; p.erro = `O YouTube marcou o vídeo como ${s.uploadStatus} (${s.rejectionReason || s.failureReason || ''}).`; await savePub(p); }
    }
  } catch (e) { app.log.warn(e, 'falha ao conferir agendados'); }
};
setInterval(conferirAgendados, 10 * 60_000).unref();

/* ---------- Thumbnails (frame pelo Remotion + PhotoCraft pela ponte no Windows) ---------- */
const thumbJobs = new Map();
app.post('/api/thumbnails', {
  schema: {
    body: {
      type: 'object', additionalProperties: false,
      required: ['props', 'tempos', 'titulo'],
      properties: {
        props: { type: 'object', required: ['videoSrc'], properties: { videoSrc: { ...localMedia, type: 'string' } } },
        tempos: { type: 'array', minItems: 1, maxItems: 4, items: { type: 'number', minimum: 0 } },
        titulo: { type: 'string', minLength: 1, maxLength: 100 },
        texto: { type: 'string', maxLength: 40 },
        jogo: { type: 'string', maxLength: 80 },
        quantidade: { type: 'integer', minimum: 1, maximum: 3, default: 3 },
      },
    },
  },
}, async (req) => {
  await ponteFetch('/status', { timeout: 2000 });
  const { props, tempos, titulo, texto, jogo, quantidade } = req.body;
  const id = crypto.randomUUID().slice(0, 8);
  const pasta = `thumbs/${id}`;
  fs.mkdirSync(path.join(DATA, pasta), { recursive: true });
  const job = { id, status: 'exportando frames', criadoEm: Date.now(), variacoes: [], etapas: [] };
  thumbJobs.set(id, job);

  (async () => {
    try {
      // frame limpo: 16:9, sem legenda, gancho nem chamada final
      const clean = absolutize({ ...props, format: 'horizontal', fit: 'cover', hook: { text: '', duration: 1 }, captions: { ...props.captions, enabled: false }, cta: { ...(props.cta || {}), enabled: false } });
      const serveUrl = await getBundle();
      const composition = await selectComposition({ serveUrl, id: 'Edicao', inputProps: clean });
      const frames = [];
      for (const [i, t] of tempos.entries()) {
        const frame = Math.min(composition.durationInFrames - 1, Math.max(0, Math.round(t * 30)));
        const rel = `${pasta}/frame-${i + 1}.png`;
        await renderStill({ serveUrl, composition, inputProps: clean, frame, output: path.join(DATA, rel), imageFormat: 'png', chromiumOptions: { gl: 'swangle' }, timeoutInMilliseconds: RENDER_TIMEOUT });
        frames.push(rel);
      }
      job.frames = frames.map((f) => urlFor('thumbs', f.replace(/^thumbs\//, '')));
      job.status = 'desenhando no PhotoCraft';
      const { id: ponteId } = await ponteFetch('/thumbnails', { method: 'POST', body: JSON.stringify({ frames, titulo, texto, jogo, pasta, quantidade }) });
      for (;;) {
        await new Promise((r) => setTimeout(r, 3000));
        const s = await ponteFetch(`/thumbnails/${ponteId}`);
        job.etapas = s.etapas?.slice(-6) || [];
        if (s.status === 'pronto') {
          job.variacoes = s.resultado.variacoes.map((v) => ({ ...v, url: urlFor('thumbs', v.arquivo.replace(/^thumbs\//, '')) }));
          job.recomendada = s.resultado.recomendada;
          job.motivo = s.resultado.motivo;
          job.conferir = s.resultado.conferir;
          job.status = 'pronto';
          break;
        }
        if (s.status === 'erro') throw new Error(s.erro);
      }
    } catch (e) {
      req.log.error(e);
      job.status = 'erro';
      job.erro = explicarErroMidia(e);
    }
  })();
  return job;
});
/* Aba Thumbnail: você escolhe o vídeo; o Claude assiste, escolhe os melhores momentos e o texto,
   e o Claude da ponte desenha as variações no PhotoCraft. */
const THUMB_PLANO_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['o_que_o_video_mostra', 'titulo_sugerido', 'momentos', 'texto_thumbnail', 'conceitos'],
  properties: {
    o_que_o_video_mostra: { type: 'string' },
    titulo_sugerido: { type: 'string' },
    momentos: {
      type: 'array',
      items: { type: 'object', additionalProperties: false, required: ['t', 'por_que'], properties: { t: { type: 'number' }, por_que: { type: 'string' } } },
    },
    texto_thumbnail: { type: 'string' },
    conceitos: { type: 'array', items: { type: 'string' } },
  },
};

app.post('/api/thumbnails/auto', {
  schema: {
    body: {
      type: 'object', additionalProperties: false, required: ['fonte'],
      properties: {
        fonte: { type: 'string', maxLength: 600, pattern: '^/media/(uploads|biblioteca|editados|renders)/' },
        projeto: { type: 'string', maxLength: 40 },
        titulo: { type: 'string', maxLength: 100 },
        texto: { type: 'string', maxLength: 40 },
        jogo: { type: 'string', maxLength: 80 },
        pedido: { type: 'string', maxLength: 600 },
        quantidade: { type: 'integer', minimum: 1, maximum: 3, default: 3 },
        novo: { type: 'boolean', default: false },
      },
    },
  },
}, async (req) => {
  await ponteFetch('/status', { timeout: 2000 });
  const { fonte, projeto, titulo, texto, jogo, pedido, quantidade, novo } = req.body;
  const file = mediaPathFromUrl(fonte);
  if (!fs.existsSync(file)) throw fail(404, 'Esse vídeo não existe mais.');
  const proj = projeto ? await projetos.obter(projeto) : null;
  const id = crypto.randomUUID().slice(0, 8);
  const pasta = `thumbs/${id}`;
  fs.mkdirSync(path.join(DATA, pasta), { recursive: true });
  const job = {
    id, auto: true, fonte, projeto: projeto || null, nome: proj?.name || prettyNome(fonte),
    status: 'o Claude está assistindo o vídeo', criadoEm: Date.now(), variacoes: [], etapas: [],
  };
  thumbJobs.set(id, job);

  (async () => {
    try {
      const dur = await duracaoVideo(file);
      const jogoF = jogo || proj?.meta?.jogo;
      // 1) o Claude escolhe os momentos e o texto (com cache: pedir de novo o mesmo vídeo não gasta token)
      const [energia, cenas] = await Promise.all([energiaAudio(file, 0, dur).catch(() => []), mudancasDeCena(file, 0, dur).catch(() => [])]);
      const momentos = momentosDoTrecho(energia, cenas, 0, dur);
      const system = SYSTEM_BASE('marketing');
      const prompt = [
        `Vou fazer a thumbnail do YouTube (1280x720) deste vídeo${jogoF ? ` do jogo ${jogoF}` : ''} (${dur.toFixed(1)} s).`,
        titulo || proj?.name ? `Título do vídeo: ${titulo || proj.name}` : 'O vídeo ainda não tem título: sugira um em titulo_sugerido.',
        proj?.meta?.textos?.texto_thumbnail ? `Texto de thumbnail já sugerido antes: ${proj.meta.textos.texto_thumbnail}` : null,
        texto ? `Texto que eu quero na thumbnail: ${texto}` : null,
        pedido ? `O que eu quero nesta thumbnail: ${pedido}` : null,
        `Escolha os ${quantidade + 1} melhores momentos para virar thumbnail (campo t em segundos do vídeo): imagem nítida e legível em tamanho pequeno, com ação, emoção, contraste ou algo curioso no centro. Prefira picos de ação e evite quadros com menu, loading ou borrão de movimento.`,
        `Em conceitos, descreva ${quantidade} ideias DIFERENTES de thumbnail (uma por variação), para testar no "Testar e comparar" do YouTube: composição, o que fica em destaque, cor, seta/círculo, expressão. texto_thumbnail: até 3 palavras que complementam o título, sem repetir.`,
        FIEL_AO_VIDEO,
        textoDosMomentos(momentos, 0) ? `Análise automática (picos de ação):\n${textoDosMomentos(momentos, 0)}` : null,
      ].filter(Boolean).join('\n\n');
      const chave = chaveDe('thumb-plano', claudeModel(), system, prompt, await assinaturaArquivo(fonte));
      const { resultado: plano } = await comCache({
        tipo: 'thumb-plano', chave, modelo: claudeModel(), novo,
        gerar: async () => {
          const n = Math.max(10, Math.min(20, Math.round(dur / 3)));
          const base = Array.from({ length: n }, (_, i) => (dur * (i + 0.5)) / n);
          const extras = momentos.picos.map((p) => p.t).filter((t) => base.every((b) => Math.abs(b - t) > dur / n / 3));
          const qs = await frames(file, { inicio: 0, fim: dur, tempos: [...base, ...extras.slice(0, 26 - n)], largura: 512 });
          const images = qs.map((f) => ({ legenda: `Quadro em ${f.t.toFixed(1)} s:`, base64: f.base64 }));
          return runClaude({ system, prompt, images, schema: THUMB_PLANO_SCHEMA, timeoutMs: 300_000, log: req.log });
        },
      });
      job.plano = plano;
      // 2) os quadros escolhidos em resolução cheia
      job.status = 'exportando os quadros escolhidos';
      const tempos = (plano.momentos || []).map((m) => Math.min(dur - 0.05, Math.max(0, m.t))).slice(0, 4);
      if (!tempos.length) tempos.push(dur * 0.4);
      const quadros = [];
      for (const [i, t] of tempos.entries()) {
        const rel = `${pasta}/frame-${i + 1}.png`;
        await salvarQuadro(file, t, path.join(DATA, rel), 1920);
        quadros.push(rel);
      }
      job.frames = quadros.map((f) => urlFor('thumbs', f.replace(/^thumbs\//, '')));
      // 3) o Claude da ponte desenha no PhotoCraft
      job.status = 'desenhando no PhotoCraft';
      const briefing = [
        plano.o_que_o_video_mostra && `O que o vídeo mostra: ${plano.o_que_o_video_mostra}`,
        plano.momentos?.length && `Por que cada frame foi escolhido:\n${plano.momentos.map((m, i) => `- frame-${i + 1}: ${m.por_que}`).join('\n')}`,
        plano.conceitos?.length && `Uma ideia para cada variação:\n${plano.conceitos.map((c, i) => `- ${'ABC'[i]}: ${c}`).join('\n')}`,
        pedido && `Pedido do dono do canal: ${pedido}`,
      ].filter(Boolean).join('\n\n');
      const { id: ponteId } = await ponteFetch('/thumbnails', {
        method: 'POST',
        body: JSON.stringify({ frames: quadros, titulo: titulo || proj?.name || plano.titulo_sugerido, texto: texto || plano.texto_thumbnail, jogo: jogoF, pasta, quantidade, briefing }),
      });
      for (;;) {
        await new Promise((r) => setTimeout(r, 3000));
        const s = await ponteFetch(`/thumbnails/${ponteId}`);
        job.etapas = s.etapas?.slice(-6) || [];
        if (s.status === 'pronto') {
          job.variacoes = s.resultado.variacoes.map((v) => ({ ...v, url: urlFor('thumbs', v.arquivo.replace(/^thumbs\//, '')) }));
          job.recomendada = s.resultado.recomendada;
          job.motivo = s.resultado.motivo;
          job.conferir = s.resultado.conferir;
          job.status = 'pronto';
          break;
        }
        if (s.status === 'erro') throw new Error(s.erro);
      }
    } catch (e) {
      req.log.error(e);
      job.status = 'erro';
      job.erro = e.statusCode === 401 ? e.message : explicarErroMidia(e);
    } finally {
      job.fim = Date.now();
    }
  })();
  return job;
});
const prettyNome = (url) => decodeURIComponent(String(url).split('/').pop() || 'vídeo').replace(/\.[^.]+$/, '');
app.get('/api/thumbnails', async () => [...thumbJobs.values()].filter((j) => j.auto).sort((a, b) => b.criadoEm - a.criadoEm).slice(0, 20));

app.get('/api/thumbnails/:id', async (req) => {
  const j = thumbJobs.get(req.params.id);
  if (!j) throw fail(404, 'Pedido não encontrado (o servidor reiniciou?)');
  return j;
});

/* ---------- Hoje: o que gravar, tendências e agenda ---------- */
const hojeISO = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(new Date());
let hojeJob = null;
let situacaoCache = null;
let situacaoEmAndamento = null;
const atualizarSituacao = (log) => {
  if (!situacaoEmAndamento) {
    situacaoEmAndamento = situacaoDoCanal(log)
      .then((dados) => { situacaoCache = { em: Date.now(), dados }; })
      .catch((e) => log.warn(e, 'situação do canal'))
      .finally(() => { situacaoEmAndamento = null; });
  }
  return situacaoEmAndamento;
};
// já deixa pronto quando o servidor sobe (depois do listen)
setTimeout(() => atualizarSituacao(app.log), 3000).unref();

const HOJE_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['resumo', 'tendencias', 'ideias', 'agenda', 'pendencias'],
  properties: {
    resumo: { type: 'string' },
    tendencias: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false, required: ['tema', 'por_que_importa'],
        properties: { tema: { type: 'string' }, por_que_importa: { type: 'string' }, fonte: { type: 'string' }, link: { type: 'string' } },
      },
    },
    ideias: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false,
        required: ['titulo', 'jogo', 'formato', 'gancho', 'o_que_gravar', 'por_que', 'plataformas'],
        properties: {
          titulo: { type: 'string' }, jogo: { type: 'string' }, formato: { type: 'string', enum: ['short', 'longo'] },
          gancho: { type: 'string' }, o_que_gravar: { type: 'string' }, por_que: { type: 'string' },
          plataformas: { type: 'array', items: { type: 'string' } }, melhor_horario: { type: 'string' },
          esforco: { type: 'string', enum: ['rápido', 'médio', 'grande'] },
        },
      },
    },
    agenda: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false, required: ['quando', 'plataforma', 'o_que'],
        properties: { quando: { type: 'string' }, plataforma: { type: 'string' }, o_que: { type: 'string' }, observacao: { type: 'string' } },
      },
    },
    pendencias: { type: 'array', items: { type: 'string' } },
  },
};

/** Tudo o que o painel sabe sobre o canal hoje (sem chamar o Claude). */
const situacaoDoCanal = async (log) => {
  const s = { hoje: hojeISO(), diaSemana: new Intl.DateTimeFormat('pt-BR', { weekday: 'long', timeZone: 'America/Sao_Paulo' }).format(new Date()) };
  // gravações brutas esperando edição
  if (MEDIA_ROOTS.biblioteca) {
    const brutos = (await walk(VIDEOS, 'Videos Brutos').catch(() => [])).filter((i) => VIDEO_EXT.test(i.rel));
    s.brutos = brutos.sort((a, b) => b.mtime - a.mtime).slice(0, 20).map((b) => ({
      arquivo: b.rel, url: urlFor('biblioteca', b.rel), gravadoEm: new Date(b.mtime).toISOString(), tamanhoMB: Math.round(b.size / 1e6),
    }));
    s.cronograma = await fsp.readFile(path.join(VIDEOS, 'cronograma_postagens.md'), 'utf8').then((t) => t.slice(0, 8000)).catch(() => null);
  }
  // publicações do painel
  const pubs = await listPubs();
  s.publicacoes = pubs.slice(0, 40).map((p) => ({
    id: p.id, plataforma: p.plataforma, status: p.status, titulo: p.meta.titulo, projeto: p.projeto, link: p.link || null,
    quando: p.meta.publicarEm || p.meta.agendarEm || p.postadoEm && new Date(p.postadoEm).toISOString() || new Date(p.criadoEm).toISOString(),
  }));
  // cortes ainda não publicados
  const comPub = new Set(pubs.map((p) => p.projeto));
  s.cortesSemPublicar = [];
  for (const p of await projetos.listar()) {
    if (p.id && !comPub.has(p.id) && p.props?.videoSrc) s.cortesSemPublicar.push({ id: p.id, nome: p.name, formato: p.props.format });
  }
  // YouTube: seu canal e o que está em alta
  if ((await youtube.status()).conectado) {
    s.meuCanal = await youtube.meusVideos(20).catch((e) => { log.warn(e, 'meus vídeos'); return null; });
    s.emAlta = await youtube.emAlta({}).catch((e) => { log.warn(e, 'em alta'); return null; });
  }
  return s;
};

app.get('/api/hoje', async (req) => {
  // o status é lido ANTES do arquivo: assim nunca aparece "não está gerando" e "sem plano" ao mesmo tempo
  const job = hojeJob;
  // a situação (YouTube + pasta de vídeos) é lenta de montar: a página recebe a última versão
  // na hora e o servidor atualiza em segundo plano
  if (!situacaoCache || req.query.atualizar) await atualizarSituacao(req.log);
  else if (Date.now() - situacaoCache.em > 120_000) atualizarSituacao(req.log);
  const situacao = situacaoCache.dados;
  const salvo = await planos.obter(hojeISO()).catch(() => null);
  return {
    situacao,
    sugestoes: salvo,
    gerando: job && job.status === 'gerando' ? job : null,
    erro: job?.status === 'erro' ? job.erro : null,
  };
});

app.post('/api/hoje', {
  schema: { body: { type: ['object', 'null'], properties: { foco: { type: 'string', maxLength: 500 } } } },
}, async (req) => {
  if (!claudeStatus().ok) throw fail(400, 'Conecte o Claude primeiro.');
  if (hojeJob?.status === 'gerando') return hojeJob;
  hojeJob = { status: 'gerando', etapa: 'juntando os dados do canal', inicio: Date.now() };
  const foco = req.body?.foco;
  (async () => {
    const s = await situacaoDoCanal(req.log);
    hojeJob.etapa = 'o Claude está pesquisando tendências';
    const resumoCanal = s.meuCanal
      ? `Inscritos: ${s.meuCanal.inscritos}. Últimos vídeos (views/likes/comentários):\n${s.meuCanal.videos.map((v) => `- ${v.publicadoEm?.slice(0, 10)} · ${v.titulo} · ${v.views} views · ${v.likes} likes · ${v.comentarios} coment. · ${v.privacidade}`).join('\n')}`
      : 'YouTube não conectado: sem números do canal.';
    const prompt = [
      `Hoje é ${s.diaSemana}, ${s.hoje} (horário de Brasília). Monte o plano do dia do canal: o que gravar hoje e a agenda de postagens dos próximos 7 dias.`,
      'Pesquise na web (WebSearch) o que está em alta AGORA e que tem relação real com os jogos do canal: lançamentos e atualizações (ex.: GTA 6, Minecraft), memes e formatos virais de gamedev/jogos no TikTok e Shorts, datas comemorativas brasileiras próximas. Faça no máximo 6 buscas. Cite a fonte de cada tendência (nome do site e link). Não invente tendências: se não achar fonte, não liste.',
      'Depois proponha de 3 a 6 ideias para gravar HOJE, cada uma concreta (jogo, cena, gancho, formato, redes, melhor horário, esforço). Pelo menos uma deve ser rápida (menos de 1 hora). Use os números do canal para justificar quando puder.',
      'FORMATO DOS CAMPOS (a tela é pequena): resumo com no máximo 3 frases curtas, com a prioridade do dia; os números detalhados vão no por_que de cada ideia. gancho = só a frase que aparece escrita ou é falada, sem marcação de tempo nem descrição de cena (a cena vai em o_que_gravar). jogo = só o nome do jogo (ex.: "Minecraft"). melhor_horario = curto, ex.: "hoje 19h". Na agenda, o_que tem no máximo 80 caracteres e sem caminho de arquivo.',
      'Na agenda, distribua para os próximos 7 dias: os cortes já prontos e ainda não publicados, os horários do cronograma do Pipeline (se houver) e as ideias novas. Use datas ISO com fuso -03:00. Não marque nada em horário já passado.',
      'Em pendências, liste o que está parado: gravações brutas sem edição, cortes sem publicar, publicações com erro.',
      foco ? `Foco pedido pelo criador hoje: ${foco}` : null,
      `## Dados do canal\n${resumoCanal}`,
      s.emAlta ? `## Em alta no YouTube Brasil (Jogos), agora\n${s.emAlta.slice(0, 20).map((v) => `- ${v.titulo} (${v.canal}, ${v.views} views)`).join('\n')}` : null,
      s.brutos?.length ? `## Gravações brutas esperando edição\n${s.brutos.map((b) => `- ${b.arquivo} (gravado ${b.gravadoEm.slice(0, 10)}, ${b.tamanhoMB} MB)`).join('\n')}` : '## Gravações brutas: nenhuma esperando.',
      s.cortesSemPublicar.length ? `## Cortes prontos no painel e ainda não publicados\n${s.cortesSemPublicar.map((c) => `- ${c.nome} (${c.formato})`).join('\n')}` : null,
      s.publicacoes.length ? `## Publicações recentes e agendadas\n${s.publicacoes.map((p) => `- ${p.quando?.slice(0, 16)} · ${p.plataforma} · ${p.status} · ${p.titulo}`).join('\n')}` : null,
      s.cronograma ? `## Cronograma do Pipeline (cronograma_postagens.md)\n${s.cronograma}` : null,
    ].filter(Boolean).join('\n\n');
    const out = await runClaude({ system: SYSTEM_BASE('marketing', 'social-media', 'roteirista'), prompt, schema: HOJE_SCHEMA, web: true, timeoutMs: 600_000, log: req.log });
    const salvo = { ...out, geradoEm: new Date().toISOString(), foco: foco || null };
    await planos.salvar(hojeISO(), salvo);
    hojeJob = { status: 'pronto' };
  })().catch((e) => {
    req.log.error(e);
    hojeJob = { status: 'erro', erro: e.message };
  });
  return hojeJob;
});

/* ---------- Produção automática: gravação bruta → Shorts publicados sozinhos + vídeo longo aguardando aprovação ---------- */
// Shorts: o Claude escolhe os trechos, edita cada um e, quando o MP4 fica pronto, gera os textos e publica no YouTube
// (na hora ou programado). TikTok e Instagram não têm API: a publicação fica marcada como "pronta para postar".
// Vídeo longo: editado com as regras de monetização e fica "aguardando aprovação" até o criador aprovar.
const producaoRodando = new Set();
const esperar = (ms) => new Promise((r) => setTimeout(r, ms));

const salvarProducao = (prod) => producoes.salvar(prod).catch((e) => app.log.warn(e, 'salvar produção'));

/** próximo horário livre para um Short programado (pula os que já passaram) */
const horarioDoShort = (cfg, indice) => {
  if (cfg.modo !== 'programado') return null;
  const passo = Math.max(1, cfg.intervaloH || 24) * 3600_000;
  let t = new Date(cfg.primeiro).getTime() + indice * passo;
  if (!Number.isFinite(t)) t = Date.now() + 3600_000;
  while (t < Date.now() + 20 * 60_000) t += passo;
  return new Date(t).toISOString();
};

const limparTexto = (x, max) => String(x || '').replace(/[<>]/g, '').trim().slice(0, max);
const tagsQueCabem = (tags) => {
  const out = [];
  for (const t of tags || []) {
    const tag = limparTexto(t, 60).replace(/^#/, '');
    if (!tag || [...out, tag].join(',').length > 480) continue;
    out.push(tag);
  }
  return out.slice(0, 25);
};
const hashtagsTexto = (hs) => (hs || []).slice(0, 8).map((h) => `#${String(h).replace(/^#/, '').replace(/\s+/g, '')}`).join(' ');

/** textos de publicação (Claude, com cache) a partir do vídeo final */
async function textosDePublicacao(prod, proj, render, formato) {
  const words = proj.props.captions?.words || [];
  const out = await executarAi('/api/ai/publicacao', {
    titulo: proj.name, jogo: prod.jogo || undefined, formato, duracao: proj.props.videoDuration,
    gancho: proj.props.hook?.text || undefined, ideia: proj.meta?.ideia || undefined,
    transcricao: words.map((w) => w.text).join(' ').slice(0, 20000) || undefined,
    video: { src: render }, origem: prod.fonte.url,
  }, { log: app.log });
  return out;
}

async function publicarShort(prod, item, indice) {
  const proj = await projetos.obter(item.projeto);
  if (!(await youtube.status()).conectado) throw new Error('Conecte o YouTube (Conexões) para publicar os Shorts.');
  item.etapa = 'o Claude está escrevendo título e descrição';
  await salvarProducao(prod);
  const t = await textosDePublicacao(prod, proj, item.render, 'vertical');
  const publicarEm = horarioDoShort(prod.config.youtube, indice);
  let descricao = limparTexto(t.descricao_youtube, 4800);
  if (!/#shorts/i.test(descricao)) descricao += '\n\n#Shorts';
  const titulo = limparTexto(t.titulos?.[0] || proj.name, 100);
  const meta = {
    titulo, descricao, tags: tagsQueCabem(t.tags), categoria: '20',
    privacidade: 'public', publicarEm, playlistId: null, paraCriancas: false, conteudoSintetico: false, notificar: true,
    formato: 'vertical',
  };
  const erros = validarMeta(meta);
  if (erros.length) throw new Error(erros.join(' '));
  const base = { projeto: item.projeto, arquivo: item.render, enviado: 0, criadoEm: Date.now(), producao: prod.id };
  const yt = await savePub({ ...base, id: crypto.randomUUID().slice(0, 8), plataforma: 'youtube', thumbnail: null, meta, status: 'na fila' });
  enfileirar(yt);
  // TikTok e Instagram: prontos para postar à mão, com a legenda já escrita
  const legenda = `${limparTexto(t.legenda_curta, 1900)}\n\n${hashtagsTexto(t.hashtags)}`.trim();
  const manual = (plataforma) => savePub({
    ...base, id: crypto.randomUUID().slice(0, 8), plataforma, thumbnail: null, status: 'para postar',
    meta: { titulo, descricao: '', tags: [], legenda, formato: 'vertical', modo: 'manual', agendarEm: publicarEm, pronto: true },
  });
  const tt = await manual('tiktok');
  const ig = await manual('instagram');
  item.pubs = { youtube: yt.id, tiktok: tt.id, instagram: ig.id };
  item.publicarEm = publicarEm;
  item.titulo = titulo;
  await projetos.salvar({ ...proj, meta: { ...(proj.meta || {}), arquivoPublicar: item.render }, updatedAt: Date.now() });
}

async function prepararLongo(prod, item) {
  const proj = await projetos.obter(item.projeto);
  item.etapa = 'o Claude está escrevendo título, descrição e capítulos';
  await salvarProducao(prod);
  const t = await textosDePublicacao(prod, proj, item.render, 'horizontal');
  let descricao = limparTexto(t.descricao_youtube, 4500);
  // capítulos do plano de edição (tempo real do vídeo final) substituem os que o texto inventar
  const caps = proj.meta?.edicao?.capitulos || [];
  if (caps.length >= 3) {
    descricao = descricao.split('\n').filter((l) => !/^\s*\d{1,2}:\d{2}(:\d{2})?\s/.test(l)).join('\n').trim();
    descricao += `\n\nCapítulos:\n${caps.map((c) => `${fmtCapitulo(c.t)} ${limparTexto(c.titulo, 80)}`).join('\n')}`;
  }
  const meta = {
    titulo: limparTexto(t.titulos?.[0] || proj.name, 100), titulosAlternativos: (t.titulos || []).slice(1, 4).map((x) => limparTexto(x, 100)),
    descricao, tags: tagsQueCabem(t.tags), categoria: '20',
    privacidade: 'public', publicarEm: null, playlistId: null, paraCriancas: false, conteudoSintetico: false, notificar: true,
    formato: 'horizontal', textoThumbnail: t.texto_thumbnail || null, comentarioFixado: t.comentario_fixado || null,
  };
  const pub = await savePub({
    id: crypto.randomUUID().slice(0, 8), plataforma: 'youtube', projeto: item.projeto, arquivo: item.render,
    thumbnail: proj.meta?.thumbnail || null, meta, status: 'aguardando aprovação', enviado: 0, criadoEm: Date.now(), producao: prod.id,
  });
  item.pubs = { youtube: pub.id };
  item.titulo = meta.titulo;
  await projetos.salvar({ ...proj, meta: { ...(proj.meta || {}), arquivoPublicar: item.render }, updatedAt: Date.now() });
}

/** cria os cortes a partir da sugestão do Claude (uma vez) */
async function criarCortesDaProducao(prod) {
  prod.etapa = 'o Claude está assistindo à gravação e escolhendo os Shorts';
  await salvarProducao(prod);
  const todos = await projetos.listar();
  const evitarGanchos = todos.map((p) => p.props?.hook?.text).filter(Boolean).slice(0, 60);
  let sug = await iniciarSugestao({
    src: prod.fonte.url, jogo: prod.jogo, quantidade: prod.config.quantidade, minS: prod.config.minS, maxS: prod.config.maxS,
    orientacao: prod.config.orientacao, evitarGanchos,
  }, app.log);
  while (!['pronto', 'erro'].includes(sug.status)) {
    await esperar(3000);
    sug = sugestoes.get(sug.id) || sug;
    prod.etapa = `o Claude está assistindo à gravação (${sug.status})`;
  }
  if (sug.status === 'erro') throw new Error(sug.erro || 'O Claude não conseguiu sugerir cortes.');
  prod.resumo = sug.resumo;
  const base = prod.base || {};
  const dur = sug.duracao || 0;
  for (const c of sug.cortes) {
    const props = {
      ...base, format: 'vertical', videoSrc: prod.fonte.url, videoDuration: dur, trimStart: c.inicio, trimEnd: c.fim,
      fit: 'contain', zoom: 1, hook: { text: c.gancho, duration: 2.5 },
      captions: { ...(base.captions || {}), enabled: c.palavras.length > 0, source: 'video', words: c.palavras },
      cta: { enabled: true, preset: 'shorts', color: '#FFD43B' },
    };
    const proj = await projetos.salvar({ id: crypto.randomUUID().slice(0, 8), name: c.titulo, props, meta: { jogo: prod.jogo || undefined, ideia: c.motivo, producao: prod.id }, createdAt: Date.now(), updatedAt: Date.now() });
    prod.shorts.push({ projeto: proj.id, titulo: c.titulo, gancho: c.gancho, miniatura: c.miniatura || null, status: 'na fila', etapa: 'esperando a edição' });
  }
  if (prod.config.longo && !prod.longo) {
    const props = {
      ...base, format: 'horizontal', videoSrc: prod.fonte.url, videoDuration: dur, trimStart: 0, trimEnd: dur,
      fit: 'cover', zoom: 1, hook: { text: '', duration: 2.5 },
      captions: { ...(base.captions || {}), enabled: false, source: 'video', words: [] },
      cta: { enabled: true, preset: 'longo', color: '#FFD43B' },
    };
    const nome = `${prod.jogo ? `${prod.jogo} — ` : ''}${prod.fonte.nome} (longo)`;
    const proj = await projetos.salvar({ id: crypto.randomUUID().slice(0, 8), name: nome.slice(0, 110), props, meta: { jogo: prod.jogo || undefined, ideia: sug.resumo, producao: prod.id }, createdAt: Date.now(), updatedAt: Date.now() });
    prod.longo = { projeto: proj.id, titulo: nome, status: 'na fila', etapa: 'esperando a edição (depois dos Shorts)' };
  }
  prod.cortesCriados = true;
  await salvarProducao(prod);
}

/** acompanha a edição de um item; quando o MP4 fica pronto, publica (Short) ou prepara para aprovação (longo) */
async function avancarItem(prod, item, tipo, indice) {
  if (['pronto', 'erro'].includes(item.status)) return;
  if (!item.render) {
    let job = item.edicao ? edicoes.get(item.edicao) : null;
    if (!job) {
      job = await iniciarEdicao(item.projeto, { formatos: [tipo === 'short' ? 'vertical' : 'horizontal'] }, app.log);
      item.edicao = job.id;
    }
    item.status = job.status === 'na fila' ? 'na fila' : 'editando';
    item.etapa = job.status === 'na fila' ? 'esperando a vez na edição' : job.etapa;
    item.progresso = job.progresso || 0;
    if (job.status === 'erro') { item.status = 'erro'; item.erro = job.erro; return; }
    if (job.status !== 'pronto') return;
    item.render = job.renders?.[0]?.url;
    item.duracao = job.resultado?.duracao;
    if (!item.render) { item.status = 'erro'; item.erro = 'A edição terminou sem gerar o MP4.'; return; }
  }
  item.status = 'publicando';
  try {
    if (tipo === 'short') await publicarShort(prod, item, indice);
    else await prepararLongo(prod, item);
    item.status = 'pronto';
    item.etapa = tipo === 'short' ? (item.publicarEm ? 'programado no YouTube' : 'enviado ao YouTube') : 'aguardando sua aprovação';
  } catch (e) {
    app.log.error(e);
    item.status = 'erro';
    item.erro = e.message;
  }
}

async function rodarProducao(prod) {
  if (producaoRodando.has(prod.id)) return;
  producaoRodando.add(prod.id);
  prod.status = 'rodando';
  prod.erro = null;
  try {
    if (!prod.cortesCriados) await criarCortesDaProducao(prod);
    for (;;) {
      const itens = [...prod.shorts.map((x, i) => [x, 'short', i]), ...(prod.longo ? [[prod.longo, 'longo', 0]] : [])];
      for (const [item, tipo, i] of itens) await avancarItem(prod, item, tipo, i);
      const ativos = itens.filter(([x]) => !['pronto', 'erro'].includes(x.status));
      const fazendo = ativos.find(([x]) => x.status === 'editando') || ativos[0];
      prod.etapa = fazendo ? `${fazendo[1] === 'short' ? 'Short' : 'Vídeo longo'}: ${fazendo[0].titulo} — ${fazendo[0].etapa || fazendo[0].status}` : 'pronto';
      await salvarProducao(prod);
      if (!ativos.length) break;
      await esperar(4000);
    }
    const falhas = [...prod.shorts, ...(prod.longo ? [prod.longo] : [])].filter((x) => x.status === 'erro');
    prod.status = falhas.length ? 'com erros' : 'pronto';
  } catch (e) {
    app.log.error(e);
    prod.status = 'erro';
    prod.erro = explicarErroMidia(e);
  } finally {
    prod.fim = Date.now();
    producaoRodando.delete(prod.id);
    await salvarProducao(prod);
  }
}

// reinício do servidor: o que estava rodando fica "interrompido" (retomar refaz só o que faltou; o plano do Claude está no cache)
for (const prod of await producoes.listar().catch(() => [])) {
  if (prod.status === 'rodando') {
    prod.status = 'interrompido';
    for (const x of [...prod.shorts, ...(prod.longo ? [prod.longo] : [])]) {
      if (!['pronto', 'erro'].includes(x.status) && !x.render) { x.edicao = null; x.status = 'na fila'; x.etapa = 'interrompido; clique em retomar'; }
    }
    await salvarProducao(prod);
  }
}

/** situação ao vivo: progresso das edições e status das publicações */
const producaoAoVivo = async (prod) => {
  const pubs = new Map((await listPubs()).filter((p) => p.producao === prod.id).map((p) => [p.id, publicView(p)]));
  const vivo = (x) => {
    const job = x.edicao ? edicoes.get(x.edicao) : null;
    const out = { ...x, progresso: job && !x.render ? job.progresso || 0 : x.render ? 1 : 0, eta: job?.eta ?? null };
    if (x.pubs) out.publicacoes = Object.fromEntries(Object.entries(x.pubs).map(([k, id]) => [k, pubs.get(id) || null]));
    return out;
  };
  const { base: _b, ...resto } = prod;
  return { ...resto, shorts: prod.shorts.map(vivo), longo: prod.longo ? vivo(prod.longo) : null };
};

app.get('/api/producao', async () => Promise.all((await producoes.listar()).map(producaoAoVivo)));

app.post('/api/producao', {
  schema: {
    body: {
      type: 'object', additionalProperties: false, required: ['src', 'base'],
      properties: {
        src: { type: 'string', maxLength: 600, pattern: '^/media/(uploads|biblioteca)/' },
        jogo: { type: 'string', maxLength: 80 },
        quantidade: { type: 'integer', minimum: 1, maximum: 6, default: 3 },
        minS: { type: 'number', minimum: 30, maximum: 180, default: 90 },
        maxS: { type: 'number', minimum: 45, maximum: 180, default: 150 },
        orientacao: { type: 'string', maxLength: 1000 },
        longo: { type: 'boolean', default: true },
        youtube: {
          type: 'object', additionalProperties: false, required: ['modo'],
          properties: {
            modo: { type: 'string', enum: ['agora', 'programado'] },
            primeiro: { type: ['string', 'null'], maxLength: 40 },
            intervaloH: { type: 'number', minimum: 1, maximum: 168, default: 24 },
          },
        },
        // props padrão do Remotion (o servidor não importa o TypeScript)
        base: { type: 'object' },
      },
    },
  },
}, async (req) => {
  if (!claudeStatus().ok) throw fail(400, 'Conecte o Claude primeiro.');
  const st = await ponteFetch('/status', { timeout: 2000 }).catch(() => null);
  if (!st?.filmcraft) throw fail(503, 'A ponte do Windows com o FilmCraft precisa estar aberta para editar.');
  if (!(await youtube.status()).conectado) throw fail(400, 'Conecte o YouTube (Conexões) para publicar os Shorts.');
  const b = req.body;
  const yt = b.youtube || { modo: 'agora' };
  if (yt.modo === 'programado' && !Number.isFinite(new Date(yt.primeiro).getTime())) throw fail(400, 'Escolha o horário do primeiro Short.');
  const file = mediaPathFromUrl(b.src);
  const prod = {
    id: crypto.randomUUID().slice(0, 8), criadoEm: Date.now(), status: 'rodando', etapa: 'começando',
    fonte: { url: b.src, nome: path.basename(file).replace(/\.[^.]+$/, '') }, jogo: b.jogo || '',
    config: { quantidade: b.quantidade, minS: b.minS, maxS: Math.max(b.minS + 15, b.maxS), orientacao: b.orientacao || '', longo: b.longo, youtube: { modo: yt.modo, primeiro: yt.primeiro || null, intervaloH: yt.intervaloH || 24 } },
    base: b.base, shorts: [], longo: null, cortesCriados: false,
  };
  await salvarProducao(prod);
  rodarProducao(prod);
  return producaoAoVivo(prod);
});

app.post('/api/producao/:id/retomar', async (req) => {
  const prod = await producoes.obter(req.params.id);
  if (!prod) throw fail(404, 'Produção não encontrada.');
  if (producaoRodando.has(prod.id)) return producaoAoVivo(prod);
  // itens com erro voltam para a fila (a edição reaproveita o plano do Claude guardado no banco)
  for (const x of [...prod.shorts, ...(prod.longo ? [prod.longo] : [])]) {
    if (x.status === 'erro') { x.status = 'na fila'; x.erro = null; if (!x.render) x.edicao = null; }
  }
  rodarProducao(prod);
  return producaoAoVivo(prod);
});

app.delete('/api/producao/:id', async (req) => {
  if (producaoRodando.has(req.params.id)) throw fail(409, 'Espere a produção terminar (ou falhar) para tirar da lista.');
  await producoes.remover(req.params.id);
  return { ok: true };
});

// vídeo longo: o criador revisa e aprova; aí ele vai para a fila do YouTube (na hora ou programado)
app.post('/api/publicacoes/:id/aprovar', {
  schema: {
    body: {
      type: 'object', additionalProperties: false,
      properties: {
        titulo: { type: 'string', minLength: 1, maxLength: 100 },
        descricao: { type: 'string', maxLength: 5000 },
        publicarEm: { type: ['string', 'null'], maxLength: 40 },
      },
    },
  },
}, async (req) => {
  const p = await publicacoes.obter(req.params.id);
  if (!p) throw fail(404, 'Publicação não encontrada');
  if (p.status !== 'aguardando aprovação') throw fail(409, 'Esta publicação não está aguardando aprovação.');
  if (!(await youtube.status()).conectado) throw fail(400, 'Conecte o YouTube antes de publicar.');
  const b = req.body || {};
  if (b.titulo) p.meta.titulo = b.titulo;
  if (b.descricao != null) p.meta.descricao = b.descricao;
  p.meta.publicarEm = b.publicarEm || null;
  p.meta.privacidade = 'public';
  const erros = validarMeta(p.meta);
  if (erros.length) throw fail(400, erros.join(' '));
  // a thumbnail escolhida na aba Thumbnail ("Usar na publicação") vale na hora de aprovar
  const proj = p.projeto ? await projetos.obter(p.projeto) : null;
  if (proj?.meta?.thumbnail) p.thumbnail = proj.meta.thumbnail;
  p.status = 'na fila';
  p.aprovadoEm = Date.now();
  await savePub(p);
  enfileirar(p);
  return publicView(p);
});

/* ---------- Front-end ---------- */
const dist = path.join(ROOT, 'dist');
const hasDist = fs.existsSync(dist);
if (hasDist) {
  await app.register(fastifyStatic, { root: dist, prefix: '/', decorateReply: false, wildcard: false });
}
app.setNotFoundHandler((req, reply) => {
  if (hasDist && req.method === 'GET' && !req.url.startsWith('/api') && !req.url.startsWith('/media')) {
    return reply.type('text/html').send(fs.createReadStream(path.join(dist, 'index.html')));
  }
  reply.status(404).send({ error: 'Rota não encontrada' });
});

await app.listen({ port: PORT, host: HOST });
app.log.info(`Mesa de Corte em http://localhost:${PORT}`);
getBundle().then(() => app.log.info('Bundle do Remotion pronto')).catch((e) => app.log.error(e, 'Falha no bundle'));
