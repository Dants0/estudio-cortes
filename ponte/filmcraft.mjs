// Executor do FilmCraft: recebe um PLANO DE EDIÇÃO (decidido pelo Claude no painel) e o aplica
// de forma determinística no FilmCraft sem interface (filmcraft-cli mcp). Nenhum token é gasto aqui.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const TICKS = 254016000000; // por segundo
const t = (s) => Math.round(s * TICKS);

/** Cliente MCP mínimo (JSON-RPC, uma mensagem por linha) para o filmcraft-cli. */
function abrirFilmCraft(cli) {
  const proc = spawn(cli, ['mcp'], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  let buf = '';
  let seq = 0;
  const pendentes = new Map();
  let stderr = '';
  proc.stderr.on('data', (d) => { stderr = (stderr + d).slice(-4000); });
  proc.stdout.on('data', (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const linha = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!linha) continue;
      let msg;
      try { msg = JSON.parse(linha); } catch { continue; }
      const p = msg.id != null && pendentes.get(msg.id);
      if (!p) continue;
      pendentes.delete(msg.id);
      if (msg.error) p.reject(new Error(msg.error.message || JSON.stringify(msg.error)));
      else p.resolve(msg.result);
    }
  });
  const falhaGeral = (e) => { for (const p of pendentes.values()) p.reject(e); pendentes.clear(); };
  proc.on('exit', (code) => falhaGeral(new Error(`O FilmCraft fechou (código ${code}). ${stderr.slice(-400)}`)));
  proc.on('error', falhaGeral);

  const rpc = (method, params, timeoutMs = 120_000) => new Promise((resolve, reject) => {
    const id = ++seq;
    const timer = setTimeout(() => { pendentes.delete(id); reject(new Error(`O FilmCraft não respondeu a ${method}.`)); }, timeoutMs);
    pendentes.set(id, { resolve: (v) => { clearTimeout(timer); resolve(v); }, reject: (e) => { clearTimeout(timer); reject(e); } });
    proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });

  /** chama uma ferramenta do MCP e devolve o JSON do resultado (erro vira exceção) */
  const tool = async (name, args, timeoutMs) => {
    const r = await rpc('tools/call', { name, arguments: args }, timeoutMs);
    const txt = (r.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('\n');
    if (r.isError) throw new Error(`${args?.id || name}: ${txt.slice(0, 400)}`);
    try { return JSON.parse(txt); } catch { return txt; }
  };
  const cmd = (id, params, timeoutMs) => tool('command_run', { id, params: params ?? null }, timeoutMs);

  return {
    async iniciar() {
      await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'mesa-de-corte-ponte', version: '1.0.0' } });
      proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
    },
    tool,
    cmd,
    fechar() { try { proc.kill(); } catch {} },
  };
}

/**
 * pedido = {
 *   fonte: caminho absoluto do vídeo (Windows),
 *   segmentos: [{ inicio, fim, velocidade (%), zoom?: { escala, x, y } }],   // tempos da fonte, em segundos
 *   musicas?: [{ arquivo: caminho absoluto, db, de, ate }],   // trilha por partes, em s do vídeo final
 *   ducking: bool,
 *   saida: caminho absoluto do .mp4, projeto: caminho absoluto do .fcproj
 * }
 */
// etapa(texto, progresso 0..1 desta fase do FilmCraft, etaSegundos?)
export async function editarNoFilmCraft(cli, pedido, etapa = () => {}) {
  const fc = abrirFilmCraft(cli);
  try {
    await fc.iniciar();
    etapa('abrindo o FilmCraft', 0.02);
    await fc.cmd('file.newProject', { name: path.basename(pedido.projeto, '.fcproj') });
    const partes = (pedido.musicas || []).filter((m) => m.ate - m.de >= 1);
    const arquivosMusica = [...new Set(partes.map((m) => m.arquivo))];
    const imp = await fc.tool('media_import', { paths: [pedido.fonte, ...arquivosMusica] });
    if (imp.errors?.length) throw new Error(`Não deu para importar: ${JSON.stringify(imp.errors).slice(0, 300)}`);
    const [itemVideo, ...itensMusica] = imp.items;
    const itemDe = new Map(arquivosMusica.map((a, i) => [a, itensMusica[i]]));

    // sequência com as configurações do próprio vídeo (tamanho, fps); ela vem com o vídeo inteiro, que sai
    const seq = await fc.cmd('file.newSequenceFromClip', { items: [itemVideo] });
    await fc.cmd('timeline.select', { clips: seq.clips });
    await fc.cmd('edit.clear');

    let pos = 0;
    let feitos = 0;
    const clipsVideo = [];
    const clipsAudio = [];
    for (const s of pedido.segmentos) {
      etapa(`montando o segmento ${++feitos} de ${pedido.segmentos.length}`, 0.05 + 0.25 * (feitos / pedido.segmentos.length));
      const dur = s.fim - s.inicio;
      const r = await fc.cmd('timeline.place', { item: itemVideo, track: 'V1', audioTrack: 'A1', time: t(pos), sourceIn: t(s.inicio), duration: t(dur) });
      const [v, a] = r.clips;
      const vel = s.velocidade || 100;
      if (vel !== 100) await fc.cmd('clip.speedDuration', { clips: r.clips, speed: vel, ripple: false });
      const durSaida = (dur * 100) / vel;
      // replay em câmera lenta: o som original arrastado fica feio, então sai (fica a música e os efeitos)
      if (s.mudo && a != null) await fc.cmd('clip.audioGain', { clips: [a], mode: 'set', db: -96 }).catch(() => {});
      if (s.zoom && s.zoom.escala > 1.01) {
        // ponto de foco: a posição se desloca para manter o foco no centro do zoom
        const info = await fc.tool('sequence_inspect', {});
        const w = info.settings.width; const h = info.settings.height;
        const fx = Math.min(1, Math.max(0, s.zoom.x ?? 0.5)); const fy = Math.min(1, Math.max(0, s.zoom.y ?? 0.5));
        const esc = s.zoom.escala;
        const alvo = [w / 2 + (0.5 - fx) * w * (esc - 1), h / 2 + (0.5 - fy) * h * (esc - 1)];
        const ini = t(pos); const meio = t(pos + Math.min(0.6, durSaida / 2));
        await fc.cmd('effects.setParam', { clip: v, effect: 'motion', param: 'scale', value: 100, time: ini, keyframe: true });
        await fc.cmd('effects.setParam', { clip: v, effect: 'motion', param: 'scale', value: esc * 100, time: meio, keyframe: true });
        await fc.cmd('effects.setParam', { clip: v, effect: 'motion', param: 'position', value: [w / 2, h / 2], time: ini, keyframe: true });
        await fc.cmd('effects.setParam', { clip: v, effect: 'motion', param: 'position', value: alvo, time: meio, keyframe: true });
      }
      clipsVideo.push(v);
      if (a != null && !s.mudo) clipsAudio.push(a);
      pos += durSaida;
    }

    const musicas = [];
    let trilha = null;
    for (const [n, parte] of partes.entries()) {
      const item = itemDe.get(parte.arquivo);
      const de = Math.min(parte.de, pos);
      const ate = Math.min(parte.ate, pos);
      if (item == null || ate - de < 1) continue;
      etapa(partes.length > 1 ? `colocando a música (parte ${n + 1} de ${partes.length})` : 'colocando a música', 0.32);
      // cada parte repete a música até cobrir o seu pedaço do vídeo
      const daParte = [];
      let cursor = de;
      while (cursor < ate - 0.5 && daParte.length < 40) {
        const r = await fc.cmd('timeline.place', { item, audioTrack: trilha ?? 'new', time: t(cursor), duration: t(ate - cursor), video: false });
        daParte.push(...r.clips);
        const info = await fc.tool('sequence_inspect', {});
        if (trilha == null) trilha = info.audio.find((tr) => tr.items.some((i) => r.clips.includes(i.clip)))?.id ?? null;
        const fim = info.audio.flatMap((tr) => tr.items).filter((i) => r.clips.includes(i.clip)).reduce((m, i) => Math.max(m, i.end), 0) / TICKS;
        if (fim <= cursor || trilha == null) break;
        cursor = fim;
      }
      if (daParte.length) await fc.cmd('clip.audioGain', { clips: daParte, mode: 'set', db: parte.db ?? -16 });
      musicas.push(...daParte);
    }
    if (musicas.length) {
      await fc.cmd('essentialSound.setType', { clips: musicas, type: 'music' });
      if (pedido.ducking && clipsAudio.length) {
        etapa('abaixando a música durante a fala', 0.36);
        await fc.cmd('essentialSound.setType', { clips: clipsAudio, type: 'dialogue' });
        await fc.cmd('essentialSound.generateDucking', { clips: musicas });
      }
    }

    fs.mkdirSync(path.dirname(pedido.saida), { recursive: true });
    fs.mkdirSync(path.dirname(pedido.projeto), { recursive: true });
    await fc.cmd('file.saveAs', { path: pedido.projeto });
    etapa(`exportando ${Math.round(pos)} s de vídeo`, 0.4);
    const exp = await fc.cmd('file.exportMedia', { path: pedido.saida, format: 'h264', crf: 19, hardwareEncoding: 'auto', wait: false });
    // acompanha a exportação pelo jobs.list (progresso e tempo restante de verdade)
    const limite = Date.now() + Math.max(15 * 60_000, pos * 30_000);
    for (;;) {
      await new Promise((r) => setTimeout(r, 1000));
      const lista = await fc.cmd('jobs.list');
      const j = (Array.isArray(lista) ? lista : []).find((x) => x.id === exp.job);
      if (!j) throw new Error('A exportação sumiu da fila do FilmCraft.');
      if (j.offlineMedia?.length) throw new Error('O FilmCraft não achou parte da mídia (offline).');
      if (j.finished) {
        if (!j.result) throw new Error(`A exportação falhou: ${j.status || 'sem detalhe'}`);
        break;
      }
      etapa(`exportando ${Math.round(pos)} s de vídeo`, 0.4 + 0.6 * (j.progress || 0), j.etaSeconds ?? null);
      if (Date.now() > limite) throw new Error('A exportação do FilmCraft demorou demais.');
    }
    if (!fs.existsSync(pedido.saida)) throw new Error('A exportação terminou sem gerar o arquivo.');
    return { duracao: pos, arquivo: pedido.saida, projeto: pedido.projeto };
  } finally {
    fc.fechar();
  }
}
