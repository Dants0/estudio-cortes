// Edição dinâmica: câmera virtual (punch-in, zoom lento, tremor, foco), transições,
// textos na tela, efeitos sonoros e barra de progresso. Tudo em segundos do vídeo de origem.
import React from 'react';
import { AbsoluteFill, Audio, Easing, Sequence, interpolate, random, spring, useCurrentFrame, useVideoConfig } from 'remotion';
import { Efeitos, FPS } from './types';

const clamp = { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' } as const;
const SAIDA = 0.22; // segundos para a câmera voltar ao normal

/** escala/deslocamento/rotação/desfoque da câmera virtual no instante t (s do vídeo) */
export const camera = (efeitos: Efeitos | undefined, t: number) => {
  let escala = 1;
  let tx = 0; // em % do quadro
  let ty = 0;
  let rot = 0;
  let blur = 0;
  let filtro = '';
  if (!efeitos) return { transform: undefined as string | undefined, filter: undefined as string | undefined };

  for (const z of efeitos.zooms) {
    const p = t - z.inicio;
    if (p < 0 || p > z.dur + SAIDA) continue;
    const saindo = interpolate(p, [z.dur, z.dur + SAIDA], [1, 0], { ...clamp, easing: Easing.in(Easing.cubic) });
    let s = 1;
    if (z.tipo === 'punch') s = 1 + (z.escala - 1) * interpolate(p, [0, 0.07], [0, 1], clamp) * saindo;
    else if (z.tipo === 'foco') s = 1 + (z.escala - 1) * interpolate(p, [0, 0.4], [0, 1], { ...clamp, easing: Easing.out(Easing.cubic) }) * saindo;
    else if (z.tipo === 'zoom_lento') s = 1 + (z.escala - 1) * interpolate(p, [0, z.dur], [0, 1], { ...clamp, easing: Easing.inOut(Easing.quad) }) * saindo;
    else if (z.tipo === 'tremor') {
      // tremor que perde força: deslocamento e rotação aleatórios (mas fixos por quadro)
      const forca = interpolate(p, [0, z.dur], [1, 0], clamp);
      const q = Math.round(t * FPS);
      tx += (random(`tx${q}`) - 0.5) * 3.2 * forca;
      ty += (random(`ty${q}`) - 0.5) * 3.2 * forca;
      rot += (random(`r${q}`) - 0.5) * 1.6 * forca;
      s = 1 + 0.04 * forca; // um pouco de zoom para a borda não aparecer
    }
    if (s > 1.0001) {
      // desloca para o ponto de foco, sem mostrar borda preta
      const lim = (s - 1) * 50;
      tx += Math.max(-lim, Math.min(lim, -s * (z.x - 0.5) * 100));
      ty += Math.max(-lim, Math.min(lim, -s * (z.y - 0.5) * 100));
      escala *= s;
    }
  }

  for (const tr of efeitos.transicoes) {
    const p = t - tr.em;
    if (p < 0 || p > 0.35) continue;
    if (tr.tipo === 'zoom') {
      escala *= interpolate(p, [0, 0.28], [1.35, 1], { ...clamp, easing: Easing.out(Easing.cubic) });
      blur = Math.max(blur, interpolate(p, [0, 0.22], [10, 0], clamp));
    } else if (tr.tipo === 'whip') {
      // desliza de lado com desfoque; o zoom acompanha para a borda preta nunca aparecer
      const desl = interpolate(p, [0, 0.2], [10, 0], { ...clamp, easing: Easing.out(Easing.cubic) });
      tx += desl;
      escala *= 1 + desl / 45;
      blur = Math.max(blur, interpolate(p, [0, 0.18], [14, 0], clamp));
    } else if (tr.tipo === 'glitch' && p < 0.24) {
      const q = Math.round(t * FPS);
      tx += (random(`g${q}`) - 0.5) * 6;
      filtro += ` hue-rotate(${Math.round(random(`h${q}`) * 180)}deg) saturate(2) contrast(1.3)`;
    }
  }

  const transform = escala !== 1 || tx || ty || rot ? `translate(${tx.toFixed(3)}%, ${ty.toFixed(3)}%) scale(${escala.toFixed(4)}) rotate(${rot.toFixed(3)}deg)` : undefined;
  const filter = [blur > 0.2 ? `blur(${blur.toFixed(1)}px)` : '', filtro].join(' ').trim() || undefined;
  return { transform, filter };
};

/** clarão branco das transições "flash" (e um leve no glitch) */
const Clarao: React.FC<{ efeitos: Efeitos; t: number }> = ({ efeitos, t }) => {
  let op = 0;
  for (const tr of efeitos.transicoes) {
    const p = t - tr.em;
    if (tr.tipo === 'flash' && p >= -0.04 && p < 0.3) op = Math.max(op, interpolate(p, [-0.04, 0, 0.3], [0.4, 0.95, 0], clamp));
    if (tr.tipo === 'glitch' && p >= 0 && p < 0.08) op = Math.max(op, 0.25);
  }
  return op > 0.01 ? <AbsoluteFill style={{ background: '#fff', opacity: op, mixBlendMode: 'screen' }} /> : null;
};

const POS = { topo: 0.2, centro: 0.45, base: 0.6 } as const;

const TextoTela: React.FC<{ texto: Efeitos['textos'][number]; fontFamily: string }> = ({ texto, fontFamily }) => {
  const frame = useCurrentFrame();
  const { width, height } = useVideoConfig();
  const base = Math.min(width, height);
  const total = Math.round(texto.dur * FPS);
  const entra = spring({ frame, fps: FPS, config: { damping: 11, stiffness: 260, mass: 0.6 } });
  const sai = interpolate(frame, [total - 6, total], [1, 0], clamp);
  const giro = (random(texto.texto) - 0.5) * 8; // cada texto com sua inclinação
  const comum: React.CSSProperties = { fontFamily, textAlign: 'center', textTransform: 'uppercase', lineHeight: 1.02, display: 'inline-block' };
  let estilo: React.CSSProperties;
  let transform: string;
  if (texto.estilo === 'impacto') {
    estilo = { ...comum, fontSize: base * 0.13, color: '#FFD43B', WebkitTextStroke: `${base * 0.012}px #000`, paintOrder: 'stroke fill', textShadow: `0 ${base * 0.012}px 0 #000` };
    transform = `scale(${interpolate(entra, [0, 1], [2.2, 1])}) rotate(${giro}deg)`;
  } else if (texto.estilo === 'etiqueta') {
    estilo = { ...comum, fontSize: base * 0.062, color: '#111', background: '#fff', padding: `${base * 0.014}px ${base * 0.028}px`, borderRadius: base * 0.016, boxShadow: `0 ${base * 0.01}px 0 #000` };
    transform = `translateX(${interpolate(entra, [0, 1], [-60, 0])}%) rotate(${giro / 2}deg)`;
  } else if (texto.estilo === 'alerta') {
    const pulso = 1 + 0.04 * Math.sin(frame / 2.2);
    estilo = { ...comum, fontSize: base * 0.07, color: '#fff', background: '#E5484D', padding: `${base * 0.014}px ${base * 0.03}px`, borderRadius: base * 0.012, border: `${base * 0.006}px solid #fff`, boxShadow: `0 0 ${base * 0.04}px rgba(229,72,77,.8)` };
    transform = `scale(${interpolate(entra, [0, 1], [0.3, 1]) * pulso}) rotate(${giro / 2}deg)`;
  } else {
    // meme: branco com contorno preto, sem caixa
    estilo = { ...comum, fontSize: base * 0.085, color: '#fff', WebkitTextStroke: `${base * 0.009}px #000`, paintOrder: 'stroke fill' };
    transform = `translateY(${interpolate(entra, [0, 1], [40, 0])}px) scale(${interpolate(entra, [0, 1], [0.8, 1])})`;
  }
  return (
    <div style={{ position: 'absolute', left: '6%', right: '6%', top: `${POS[texto.posicao] * 100}%`, display: 'flex', justifyContent: 'center', opacity: Math.min(entra * 3, 1) * sai, transform: 'translateY(-50%)' }}>
      <span style={{ ...estilo, transform, maxWidth: width * 0.88 }}>{texto.texto}</span>
    </div>
  );
};

const Barra: React.FC<{ cor: string; total: number }> = ({ cor, total }) => {
  const frame = useCurrentFrame();
  const { height } = useVideoConfig();
  return (
    <div style={{ position: 'absolute', left: 0, right: 0, top: 0, height: Math.max(6, height * 0.006), background: 'rgba(0,0,0,.35)' }}>
      <div style={{ height: '100%', width: `${Math.min(100, (frame / Math.max(1, total)) * 100)}%`, background: cor }} />
    </div>
  );
};

/** tudo o que fica por cima do vídeo: clarões, textos, sons e barra */
export const Camadas: React.FC<{ efeitos: Efeitos; trimStart: number; total: number; cor: string; fontFamily: string }> = ({ efeitos, trimStart, total, cor, fontFamily }) => {
  const frame = useCurrentFrame();
  const t = frame / FPS + trimStart;
  const fq = (s: number) => Math.round((s - trimStart) * FPS);
  return (
    <>
      <Clarao efeitos={efeitos} t={t} />
      {efeitos.textos.map((x, i) => fq(x.inicio) >= 0 && (
        <Sequence key={`t${i}`} from={fq(x.inicio)} durationInFrames={Math.max(1, Math.round(x.dur * FPS))}>
          <TextoTela texto={x} fontFamily={fontFamily} />
        </Sequence>
      ))}
      {efeitos.sons.map((s, i) => fq(s.inicio) >= 0 && (
        <Sequence key={`s${i}`} from={fq(s.inicio)} durationInFrames={FPS * 3}>
          <Audio src={s.src} volume={s.volume} />
        </Sequence>
      ))}
      {efeitos.barra && <Barra cor={cor} total={total} />}
    </>
  );
};

/** normaliza uma palavra para comparar com os destaques ("Diamante!" → "diamante") */
export const chaveDaPalavra = (w: string) => w.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
