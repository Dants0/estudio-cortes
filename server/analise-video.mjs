// Análise barata do trecho (sem token): energia do áudio e mudanças bruscas de imagem.
// Serve para o Claude achar os MOMENTOS BONS (gritos, explosões, risadas, viradas) e
// para escolher em que instantes olhar os quadros.
// O ffmpeg do Remotion é reduzido (sem filtros de análise nem geradores), então a conta é feita aqui.
import fs from 'node:fs';
import path from 'node:path';
import { run, bin, toolEnv, compositorDir } from './contexto-video.mjs';

const JANELA = 0.25; // segundos por medida de energia

/** PCM 16 bits de dentro de um WAV (pula o cabeçalho até o bloco "data") */
const pcmDoWav = (buf) => {
  let i = 12;
  while (i + 8 <= buf.length) {
    const id = buf.toString('ascii', i, i + 4);
    const tam = buf.readUInt32LE(i + 4);
    if (id === 'data') return buf.subarray(i + 8, Math.min(buf.length, i + 8 + (tam || buf.length)));
    i += 8 + tam;
  }
  return Buffer.alloc(0);
};

/** volume (dB) a cada 0,25 s do trecho: [{ t, db }] com t em segundos da gravação */
export async function energiaAudio(file, ini, fim) {
  const taxa = 8000;
  const { stdout } = await run(
    bin('ffmpeg'),
    ['-v', 'error', '-ss', String(ini), '-i', file, '-t', String(Math.max(0.5, fim - ini)), '-vn', '-ac', '1', '-ar', String(taxa), '-c:a', 'pcm_s16le', '-f', 'wav', 'pipe:1'],
    { cwd: compositorDir, env: toolEnv(), encoding: 'buffer', maxBuffer: 400 * 1024 * 1024 },
  ).catch(() => ({ stdout: Buffer.alloc(0) })); // sem faixa de áudio
  const pcm = stdout.length > 44 ? pcmDoWav(stdout) : Buffer.alloc(0);
  const porJanela = Math.round(taxa * JANELA);
  const amostras = Math.floor(pcm.length / 2);
  const out = [];
  for (let i = 0; i + porJanela <= amostras; i += porJanela) {
    let soma = 0;
    for (let k = i; k < i + porJanela; k++) { const v = pcm.readInt16LE(k * 2) / 32768; soma += v * v; }
    const rms = Math.sqrt(soma / porJanela);
    out.push({ t: ini + i / taxa, db: rms > 1e-5 ? 20 * Math.log10(rms) : -100 });
  }
  return out;
}

/** instantes (s da gravação) em que a imagem muda de repente: corte de câmera, explosão, tela nova */
export async function mudancasDeCena(file, ini, fim) {
  const dur = Math.max(0.5, fim - ini);
  const fps = dur > 300 ? 2 : 5;
  const W = 32, H = 18, N = W * H;
  const { stdout } = await run(
    bin('ffmpeg'),
    ['-v', 'error', '-ss', String(ini), '-i', file, '-t', String(dur), '-an', '-r', String(fps), '-vf', `scale=${W}:${H}`, '-pix_fmt', 'gray', '-c:v', 'rawvideo', '-f', 'image2pipe', 'pipe:1'],
    { cwd: compositorDir, env: toolEnv(), encoding: 'buffer', maxBuffer: 200 * 1024 * 1024 },
  ).catch(() => ({ stdout: Buffer.alloc(0) }));
  const quadros = Math.floor(stdout.length / N);
  const difs = [];
  for (let q = 1; q < quadros; q++) {
    let s = 0;
    for (let k = 0; k < N; k++) s += Math.abs(stdout[q * N + k] - stdout[(q - 1) * N + k]);
    difs.push({ t: ini + q / fps, d: s / N });
  }
  if (!difs.length) return [];
  const med = mediana(difs.map((x) => x.d));
  const limiar = Math.max(22, med * 4);
  const tempos = difs.filter((x) => x.d > limiar).map((x) => x.t);
  // junta mudanças muito próximas (efeito piscando conta como uma só)
  return tempos.filter((t, i) => i === 0 || t - tempos[i - 1] > 0.8);
}

const mediana = (xs) => { const s = [...xs].sort((a, b) => a - b); return s[Math.floor(s.length / 2)] ?? -100; };

/**
 * Resume a análise para o prompt: picos de áudio, silêncios, mudanças de cena e uma
 * "curva de energia" com um dígito (0–9) por segundo.
 */
export function momentosDoTrecho(energia, cenas, ini, fim) {
  const vivos = energia.filter((e) => e.db > -90);
  if (!vivos.length) return { picos: [], silencios: [], cenas, curva: '', base: null };
  const base = mediana(vivos.map((e) => e.db));
  const max = Math.max(...vivos.map((e) => e.db));
  // picos: máximos locais bem acima do volume normal, separados por pelo menos 1,5 s
  const candidatos = energia
    .map((e, i) => ({ ...e, i }))
    .filter((e) => e.db > base + 6 && e.db >= (energia[e.i - 1]?.db ?? -100) && e.db >= (energia[e.i + 1]?.db ?? -100))
    .sort((a, b) => b.db - a.db);
  const picos = [];
  for (const c of candidatos) {
    if (picos.every((p) => Math.abs(p.t - c.t) > 1.5)) picos.push({ t: c.t, acima: Math.round(c.db - base) });
    if (picos.length >= 14) break;
  }
  picos.sort((a, b) => a.t - b.t);
  // silêncios: trechos de 1,2 s ou mais bem abaixo do normal (tempo morto, loading)
  const silencios = [];
  let ini0 = null;
  for (const e of [...energia, { t: fim, db: 100 }]) {
    const quieto = e.db < base - 12;
    if (quieto && ini0 == null) ini0 = e.t;
    if (!quieto && ini0 != null) { if (e.t - ini0 >= 1.2) silencios.push([ini0, e.t]); ini0 = null; }
  }
  // curva: 0 = silêncio, 9 = o momento mais alto do trecho
  let curva = '';
  for (let s = ini; s < fim; s += 1) {
    const js = energia.filter((e) => e.t >= s && e.t < s + 1);
    const v = js.length ? Math.max(...js.map((e) => e.db)) : -100;
    curva += String(Math.max(0, Math.min(9, Math.round(((v - (base - 15)) / Math.max(1, max - (base - 15))) * 9))));
  }
  return { picos, silencios, cenas, curva, base: Math.round(base) };
}

export const textoDosMomentos = ({ picos, silencios, cenas, curva }, ini) => {
  const f = (t) => t.toFixed(1);
  const linhas = [];
  if (curva) {
    const blocos = curva.match(/.{1,10}/g).map((b, i) => `${f(ini + i * 10)}s: ${b}`);
    linhas.push(`Energia do áudio, um dígito por segundo (0 = silêncio, 9 = o mais alto do trecho), em blocos de 10 s:\n${blocos.join('\n')}`);
  }
  if (picos.length) linhas.push(`Picos de áudio (grito, explosão, risada, impacto): ${picos.map((p) => `${f(p.t)}s (+${p.acima} dB)`).join(', ')}`);
  if (silencios.length) linhas.push(`Silêncios (candidatos a corte): ${silencios.map(([a, b]) => `${f(a)}–${f(b)}s`).join(', ')}`);
  if (cenas.length) linhas.push(`Mudanças bruscas de imagem: ${cenas.slice(0, 30).map(f).join(', ')}s`);
  return linhas.join('\n');
};

/* ---------- efeitos sonoros: sintetizados aqui uma vez; dá para trocar pelos seus ---------- */
// Para usar um som seu, coloque um .wav/.mp3 com o nome do tipo na pasta de efeitos (ex.: impacto.mp3).
const TAXA = 44100;
const ruido = (() => { let s = 1234567; return () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return (s / 0x3fffffff) - 1; }; })();
const fase = () => { let p = 0; return (f) => { p += (2 * Math.PI * f) / TAXA; return Math.sin(p); }; };
const passaBaixa = (fc) => { const a = Math.exp((-2 * Math.PI * fc) / TAXA); let y = 0; return (x) => (y = (1 - a) * x + a * y); };
const passaAlta = (fc) => { const lp = passaBaixa(fc); return (x) => x - lp(x); };

export const SONS = {
  whoosh: { nome: 'whoosh (passagem rápida, transição)', dur: 0.55, gerar: () => {
    // ruído com filtro que abre e fecha (a "passada" do ar)
    const hp = passaAlta(250); let y = 0; return (t, d) => {
      const p = Math.min(1, t / d); const env = Math.sin(Math.PI * p) ** 2;
      const fc = 400 + 5200 * Math.sin(Math.PI * p); const a = Math.exp((-2 * Math.PI * fc) / TAXA);
      y = (1 - a) * ruido() + a * y; return hp(y) * env; }; } },
  impacto: { nome: 'impacto grave (boom: clímax, revelação, punch-in)', dur: 1.1, gerar: () => {
    const o = fase(); const lp = passaBaixa(1800); return (t) =>
      0.95 * o(45 + 110 * Math.exp(-9 * t)) * Math.exp(-3.2 * t) + lp(0.5 * ruido() * Math.exp(-28 * t)); } },
  pop: { nome: 'pop (texto aparecendo, item surgindo)', dur: 0.14, gerar: () => { const o = fase(); return (t) => 0.8 * o(1100 - 5000 * t) * Math.exp(-26 * t); } },
  ding: { nome: 'ding (acerto, conquista, ideia)', dur: 0.9, gerar: () => {
    const a = fase(), b = fase(), c = fase(); return (t) => 0.45 * a(1568) * Math.exp(-4.5 * t) + 0.3 * b(2349) * Math.exp(-6 * t) + 0.15 * c(3136) * Math.exp(-8 * t); } },
  riser: { nome: 'riser (tensão subindo; termina no momento forte)', dur: 1.6, gerar: () => {
    const o = fase(); const hp = passaAlta(150); return (t, d) => { const p = t / d; return (0.35 * o(180 + 520 * p * p) + hp(0.25 * ruido() * p)) * p * p; }; } },
  glitch: { nome: 'glitch (erro, bug, falha engraçada)', dur: 0.35, gerar: () => {
    const o = fase(); return (t) => (Math.floor(t * 45) % 2 ? 0.5 * Math.sign(o(90 + 400 * (Math.floor(t * 30) % 3))) : 0); } },
  fail: { nome: 'fail (trombone triste: deu errado, vergonha)', dur: 1.5, gerar: () => {
    const o = fase(); const lp = passaBaixa(2200); return (t) => {
      const n = t < 0.35 ? 392 : t < 0.7 ? 370 : t < 1.05 ? 349 : 330 - 25 * (t - 1.05);
      const env = (1 - 0.6 * ((t % 0.35) / 0.35)) * (t > 1.05 ? Math.exp(-1.5 * (t - 1.05)) : 1);
      return lp(0.45 * (o(n) + 0.4 * Math.sign(o(n)))) * env; }; } },
  tic: { nome: 'tic (relógio, contagem, espera)', dur: 0.06, gerar: () => { const o = fase(); return (t) => 0.7 * o(2600) * Math.exp(-90 * t); } },
};

const escreverWav = (arquivo, amostras) => {
  const dados = Buffer.alloc(amostras.length * 4);
  amostras.forEach((v, i) => {
    const s = Math.round(Math.max(-1, Math.min(1, v)) * 32767);
    dados.writeInt16LE(s, i * 4); dados.writeInt16LE(s, i * 4 + 2); // estéreo
  });
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + dados.length, 4); h.write('WAVE', 8);
  h.write('fmt ', 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(2, 22);
  h.writeUInt32LE(TAXA, 24); h.writeUInt32LE(TAXA * 4, 28); h.writeUInt16LE(4, 32); h.writeUInt16LE(16, 34);
  h.write('data', 36); h.writeUInt32LE(dados.length, 40);
  fs.writeFileSync(arquivo, Buffer.concat([h, dados]));
};

/** cria os .wav que faltam em `dir` e devolve { tipo: nomeDoArquivo } (prefere arquivo do usuário) */
export function prepararSons(dir, log) {
  fs.mkdirSync(dir, { recursive: true });
  const existentes = fs.readdirSync(dir);
  const mapa = {};
  for (const [tipo, s] of Object.entries(SONS)) {
    const meu = existentes.find((n) => new RegExp(`^${tipo}\\.(mp3|wav|ogg|m4a)$`, 'i').test(n));
    if (meu) { mapa[tipo] = meu; continue; }
    const gerado = `${tipo}.gerado.wav`;
    if (!existentes.includes(gerado)) {
      try {
        const g = s.gerar();
        const n = Math.round(s.dur * TAXA);
        const am = new Array(n);
        for (let i = 0; i < n; i++) {
          const t = i / TAXA;
          const fade = Math.min(1, (n - i) / (0.01 * TAXA)); // sem estalo no fim
          am[i] = g(t, s.dur) * fade;
        }
        const pico = Math.max(1e-6, ...am.map(Math.abs));
        escreverWav(path.join(dir, gerado), am.map((v) => (v / pico) * 0.85));
      } catch (e) { log?.warn(e, `não deu para gerar o som ${tipo}`); continue; }
    }
    mapa[tipo] = gerado;
  }
  return mapa;
}
