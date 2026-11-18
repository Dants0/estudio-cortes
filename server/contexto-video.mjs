// Monta o contexto REAL do vídeo para o Claude: frames do arquivo, fala transcrita e
// a descrição que o Pipeline deixa ao lado das gravações (…_descricao.md).
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createRequire } from 'node:module';

const run = promisify(execFile);
const require = createRequire(import.meta.url);

// usa o ffmpeg/ffprobe que já vêm com o Remotion
const compositorDir = (() => {
  const pkgs = ['linux-x64-gnu', 'linux-arm64-gnu', 'linux-x64-musl', 'linux-arm64-musl', 'win32-x64-msvc', 'darwin-arm64', 'darwin-x64'];
  for (const p of pkgs) {
    try {
      return path.dirname(require.resolve(`@remotion/compositor-${p}/package.json`));
    } catch {}
  }
  return null;
})();
const bin = (name) => {
  if (!compositorDir) throw new Error('ffmpeg do Remotion não encontrado');
  const exe = path.join(compositorDir, process.platform === 'win32' ? `${name}.exe` : name);
  return exe;
};
const toolEnv = () => ({ ...process.env, LD_LIBRARY_PATH: [compositorDir, process.env.LD_LIBRARY_PATH].filter(Boolean).join(':') });
export { run, bin, toolEnv, compositorDir };

export async function duracao(file) {
  const { stdout } = await run(bin('ffprobe'), ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file], { cwd: compositorDir, env: toolEnv() });
  const d = Number(stdout.trim());
  if (!Number.isFinite(d)) throw new Error('Não consegui ler a duração do vídeo');
  return d;
}

/** n frames JPEG (base64) distribuídos entre inicio e fim. */
export async function frames(file, { inicio = 0, fim, n = 6, largura = 768, tempos: escolhidos } = {}) {
  const total = fim ?? (await duracao(file));
  const span = Math.max(0.5, total - inicio);
  // tempos escolhidos (ex.: picos de ação) ou distribuídos por igual
  const tempos = escolhidos?.length ? [...escolhidos].sort((x, y) => x - y) : Array.from({ length: n }, (_, i) => inicio + (span * (i + 0.5)) / n);
  const out = [];
  for (const t of tempos) {
    const { stdout } = await run(
      bin('ffmpeg'),
      ['-v', 'error', '-ss', t.toFixed(2), '-i', file, '-frames:v', '1', '-vf', `scale=${largura}:-2`, '-q:v', '5', '-f', 'image2pipe', '-vcodec', 'mjpeg', 'pipe:1'],
      { cwd: compositorDir, env: toolEnv(), encoding: 'buffer', maxBuffer: 20 * 1024 * 1024 },
    );
    if (stdout.length) out.push({ t, base64: stdout.toString('base64') });
  }
  return out;
}

/** Áudio do trecho em mp3 mono (para a transcrição sair barata e rápida). */
async function audioDoTrecho(file, inicio, fim, destino) {
  const args = ['-v', 'error', '-y'];
  if (inicio) args.push('-ss', String(inicio));
  args.push('-i', file);
  if (fim) args.push('-t', String(Math.max(0.5, fim - (inicio || 0))));
  args.push('-vn', '-ac', '1', '-ar', '22050', '-b:a', '64k', destino);
  await run(bin('ffmpeg'), args, { cwd: compositorDir, env: toolEnv() });
}

/**
 * Transcrição com cache. `transcrever(audioPath)` faz a chamada à ElevenLabs e devolve o texto.
 */
export async function transcricao(file, { inicio = 0, fim, cacheDir, transcrever }) {
  const st = await fsp.stat(file);
  const key = crypto.createHash('sha1').update(`${file}|${st.size}|${st.mtimeMs}|${inicio}|${fim ?? ''}`).digest('hex');
  const cacheFile = path.join(cacheDir, `${key}.json`);
  try { return JSON.parse(await fsp.readFile(cacheFile, 'utf8')).texto; } catch {}
  const tmp = path.join(cacheDir, `${key}.mp3`);
  await audioDoTrecho(file, inicio, fim, tmp);
  try {
    const texto = await transcrever(tmp);
    await fsp.writeFile(cacheFile, JSON.stringify({ texto, criadoEm: Date.now() }));
    return texto;
  } finally {
    await fsp.rm(tmp, { force: true });
  }
}

/**
 * Transcrição palavra por palavra do arquivo inteiro, com cache.
 * `transcrever(audioPath)` devolve [{ text, start, end }].
 */
export async function transcricaoPalavras(file, { cacheDir, transcrever }) {
  const st = await fsp.stat(file);
  const key = crypto.createHash('sha1').update(`palavras|${file}|${st.size}|${st.mtimeMs}`).digest('hex');
  const cacheFile = path.join(cacheDir, `${key}.json`);
  try { return JSON.parse(await fsp.readFile(cacheFile, 'utf8')).palavras; } catch {}
  const tmp = path.join(cacheDir, `${key}.mp3`);
  await audioDoTrecho(file, 0, undefined, tmp);
  try {
    const palavras = await transcrever(tmp);
    await fsp.writeFile(cacheFile, JSON.stringify({ palavras, criadoEm: Date.now() }));
    return palavras;
  } finally {
    await fsp.rm(tmp, { force: true });
  }
}

/** Junta as palavras em linhas com o tempo, para o Claude achar os momentos: "[01:23] texto". */
export function transcricaoComTempo(palavras, maxChars = 40000) {
  const linhas = [];
  let atual = null;
  for (const w of palavras) {
    if (!atual || w.start - atual.fimT > 1.2 || atual.texto.length > 140 || /[.!?…]$/.test(atual.texto)) {
      if (atual) linhas.push(atual);
      atual = { inicio: w.start, fimT: w.end, texto: w.text };
    } else {
      atual.texto += ` ${w.text}`;
      atual.fimT = w.end;
    }
  }
  if (atual) linhas.push(atual);
  const mmss = (s) => `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
  return linhas.map((l) => `[${mmss(l.inicio)}–${mmss(l.fimT)}] ${l.texto}`).join('\n').slice(0, maxChars);
}

/** Um quadro JPEG salvo em disco (para a miniatura de cada sugestão). */
export async function salvarQuadro(file, t, destino, largura = 480) {
  await run(bin('ffmpeg'), ['-v', 'error', '-y', '-ss', t.toFixed(2), '-i', file, '-frames:v', '1', '-vf', `scale=${largura}:-2`, '-q:v', '4', destino], { cwd: compositorDir, env: toolEnv() });
}

/** Procura os …_descricao.md do Pipeline na pasta da gravação (youtube/ e shorts/ do mesmo dia). */
export async function descricoesDoPipeline(file, raizBiblioteca) {
  if (!raizBiblioteca || !file.startsWith(raizBiblioteca + path.sep)) return '';
  const dir = path.dirname(file);
  const dia = ['youtube', 'shorts', 'bruto'].includes(path.basename(dir)) ? path.dirname(dir) : dir;
  const pastas = [dir, path.join(dia, 'youtube'), path.join(dia, 'shorts')].filter((p, i, a) => a.indexOf(p) === i);
  const base = path.basename(file).replace(/\.[^.]+$/, '');
  const achados = [];
  for (const p of pastas) {
    const nomes = await fsp.readdir(p).catch(() => []);
    for (const n of nomes.filter((x) => x.endsWith('_descricao.md'))) {
      const texto = await fsp.readFile(path.join(p, n), 'utf8').catch(() => '');
      // a descrição do mesmo vídeo vem primeiro
      achados.push({ n, texto, prioridade: texto.includes(base) || p === dir ? 0 : 1 });
    }
  }
  return achados
    .sort((a, b) => a.prioridade - b.prioridade)
    .map((a) => `### ${a.n}\n${a.texto}`)
    .join('\n\n')
    .slice(0, 9000);
}

/** Cópia do vídeo com o índice (moov) no começo, sem recodificar — exigência do Instagram. */
export async function faststart(file, destino) {
  await run(bin('ffmpeg'), ['-v', 'error', '-y', '-i', file, '-c', 'copy', '-movflags', '+faststart', destino], { cwd: compositorDir, env: toolEnv() });
}

export const existe = (f) => fs.existsSync(f);
