import React, { useMemo } from 'react';
import {
  AbsoluteFill,
  Audio,
  OffthreadVideo,
  Sequence,
  interpolate,
  spring,
  useCurrentFrame,
  useVideoConfig,
} from 'remotion';
import { loadFont } from '@remotion/google-fonts/Anton';
import { EditProps, Word, FPS, CTA_TEXTOS, editLength } from './types';
import { Camadas, camera, chaveDaPalavra } from './Dinamica';

const { fontFamily } = loadFont('normal', { weights: ['400'], subsets: ['latin', 'latin-ext'] });

type Chunk = { words: Word[]; start: number; end: number };

const chunkWords = (words: Word[], perLine: number): Chunk[] => {
  const chunks: Chunk[] = [];
  let current: Word[] = [];
  for (const w of words) {
    current.push(w);
    const endsSentence = /[.!?…]$/.test(w.text);
    if (current.length >= perLine || endsSentence) {
      chunks.push({ words: current, start: current[0].start, end: current[current.length - 1].end });
      current = [];
    }
  }
  if (current.length) chunks.push({ words: current, start: current[0].start, end: current[current.length - 1].end });
  // estende cada bloco até o próximo para a legenda não piscar entre palavras
  return chunks.map((c, i) => ({ ...c, end: Math.max(c.end, Math.min((chunks[i + 1]?.start ?? c.end + 0.6), c.end + 0.6)) }));
};

const Captions: React.FC<{ props: EditProps }> = ({ props }) => {
  const frame = useCurrentFrame();
  const { width, height } = useVideoConfig();
  const t = frame / FPS;
  const { captions, narration, trimStart } = props;

  const timeline = useMemo(() => {
    const offset = captions.source === 'video' ? -trimStart : narration.startAt;
    const src = captions.source === 'video' ? captions.words : narration.words;
    const shifted = src
      .map((w) => ({ ...w, start: w.start + offset, end: w.end + offset }))
      .filter((w) => w.end > 0);
    return chunkWords(shifted, Math.max(1, captions.wordsPerLine));
  }, [captions.source, captions.words, captions.wordsPerLine, narration.words, narration.startAt, trimStart]);

  const destaques = useMemo(() => new Set(props.efeitos?.destaques || []), [props.efeitos?.destaques]);
  const chunk = timeline.find((c) => t >= c.start && t < c.end);
  if (!chunk) return null;

  const base = Math.min(width, height);
  const size = captions.style === 'limpa' ? base * 0.06 : base * 0.085;
  const enter = spring({ frame: frame - Math.round(chunk.start * FPS), fps: FPS, config: { damping: 18, stiffness: 220 } });

  return (
    <div
      style={{
        position: 'absolute',
        left: '6%',
        right: '6%',
        top: `${captions.position * 100}%`,
        transform: `translateY(-50%) scale(${interpolate(enter, [0, 1], [0.9, 1])})`,
        opacity: enter,
        display: 'flex',
        flexWrap: 'wrap',
        justifyContent: 'center',
        gap: `0 ${size * 0.4}px`,
        fontFamily,
        fontSize: size,
        lineHeight: 1.1,
        textAlign: 'center',
        textTransform: captions.style === 'limpa' ? 'none' : 'uppercase',
      }}
    >
      {chunk.words.map((w, i) => {
        const active = t >= w.start && t < w.end + 0.05;
        const destaque = destaques.has(chaveDaPalavra(w.text));
        const said = t >= w.start;
        const color =
          captions.style === 'limpa' ? '#fff' : active ? captions.color : said || captions.style === 'caixa' ? '#fff' : 'rgba(255,255,255,.85)';
        return (
          <span
            key={i}
            style={{
              color: captions.style === 'caixa' && active ? '#111' : destaque && t >= w.start ? '#5BE37D' : color,
              background: captions.style === 'caixa' && active ? captions.color : 'transparent',
              padding: captions.style === 'caixa' ? `0 ${size * 0.15}px` : 0,
              // a palavra em destaque cresce: abre espaço para não cobrir as vizinhas
              fontSize: destaque ? size * 1.2 : undefined,
              borderRadius: size * 0.12,
              WebkitTextStroke: captions.style === 'destaque' ? `${size * 0.09}px #000` : undefined,
              paintOrder: 'stroke fill',
              textShadow: captions.style === 'limpa' ? '0 2px 12px rgba(0,0,0,.7)' : `0 ${size * 0.06}px 0 rgba(0,0,0,.45)`,
              transform: destaque && t >= w.start ? `scale(${active ? 1.06 : 1}) rotate(-3deg)` : active && captions.style === 'destaque' ? 'scale(1.08)' : 'none',
              display: 'inline-block',
            }}
          >
            {w.text}
          </span>
        );
      })}
    </div>
  );
};

const Hook: React.FC<{ text: string; duration: number }> = ({ text, duration }) => {
  const frame = useCurrentFrame();
  const { width, height } = useVideoConfig();
  const total = Math.round(duration * FPS);
  const enter = spring({ frame, fps: FPS, config: { damping: 14, stiffness: 180 } });
  const exit = interpolate(frame, [total - 8, total], [1, 0], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
  const base = Math.min(width, height);
  return (
    <div
      style={{
        position: 'absolute',
        top: height > width ? '14%' : '10%',
        left: '7%',
        right: '7%',
        display: 'flex',
        justifyContent: 'center',
        opacity: exit,
        transform: `translateY(${interpolate(enter, [0, 1], [-40, 0])}px) rotate(-2deg)`,
      }}
    >
      <span
        style={{
          fontFamily,
          fontSize: base * 0.075,
          lineHeight: 1.05,
          color: '#111',
          background: '#fff',
          padding: `${base * 0.018}px ${base * 0.032}px`,
          borderRadius: base * 0.018,
          textAlign: 'center',
          textTransform: 'uppercase',
          boxShadow: `0 ${base * 0.012}px 0 #000`,
        }}
      >
        {text}
      </span>
    </div>
  );
};

const EndCard: React.FC<{ preset: 'shorts' | 'longo'; color: string }> = ({ preset, color }) => {
  const frame = useCurrentFrame();
  const { width, height } = useVideoConfig();
  const t = CTA_TEXTOS[preset];
  const base = Math.min(width, height);
  const enter = spring({ frame, fps: FPS, config: { damping: 16, stiffness: 160 } });
  const longo = preset === 'longo';
  const stroke = (s: number) => ({ WebkitTextStroke: `${s}px #000`, paintOrder: 'stroke fill' as const, textShadow: `0 ${s}px 0 rgba(0,0,0,.5)` });
  return (
    <AbsoluteFill
      style={{
        background: `linear-gradient(${longo ? '90deg' : '0deg'}, rgba(0,0,0,.65), rgba(0,0,0,0) ${longo ? '55%' : '60%'})`,
        opacity: enter,
        // vídeo longo: lado direito livre para as telas finais do YouTube
        alignItems: longo ? 'flex-start' : 'center',
        justifyContent: longo ? 'center' : 'flex-end',
        padding: longo ? `0 0 0 ${width * 0.06}px` : `0 ${width * 0.06}px ${height * 0.16}px`,
      }}
    >
      <div style={{ maxWidth: longo ? width * 0.48 : '100%', textAlign: longo ? 'left' : 'center', transform: `translateY(${interpolate(enter, [0, 1], [30, 0])}px)` }}>
        <div style={{ fontFamily, fontSize: base * (longo ? 0.11 : 0.085), lineHeight: 1.02, color, ...stroke(base * 0.01) }}>{t.titulo}</div>
        <div style={{ fontFamily, fontSize: base * (longo ? 0.045 : 0.05), marginTop: base * 0.02, color: '#fff', ...stroke(base * 0.006) }}>{t.sub}</div>
      </div>
    </AbsoluteFill>
  );
};

export const Edit: React.FC<EditProps> = (props) => {
  const { videoSrc, trimStart, trimEnd, fit, zoom, originalVolume, hook, captions, narration, music, efeitos } = props;
  const clipFrames = Math.max(1, Math.round((trimEnd - trimStart) * FPS));
  const frame = useCurrentFrame();
  const cam = camera(efeitos, frame / FPS + trimStart);

  return (
    <AbsoluteFill style={{ backgroundColor: '#000' }}>
      {videoSrc ? (
        <>
          {fit === 'contain' && (
            <AbsoluteFill style={{ filter: 'blur(40px) brightness(.55)', transform: 'scale(1.2)' }}>
              <Sequence durationInFrames={clipFrames}>
                <OffthreadVideo
                  src={videoSrc}
                  trimBefore={Math.round(trimStart * FPS)}
                  muted
                  style={{ width: '100%', height: '100%', objectFit: 'cover' }}
                />
              </Sequence>
            </AbsoluteFill>
          )}
          <Sequence durationInFrames={clipFrames}>
            <AbsoluteFill style={{ transform: [cam.transform, `scale(${zoom})`].filter(Boolean).join(' '), filter: cam.filter }}>
              <OffthreadVideo
                src={videoSrc}
                trimBefore={Math.round(trimStart * FPS)}
                volume={originalVolume}
                style={{ width: '100%', height: '100%', objectFit: fit }}
              />
            </AbsoluteFill>
          </Sequence>
        </>
      ) : (
        <AbsoluteFill style={{ alignItems: 'center', justifyContent: 'center', color: '#666', fontFamily, fontSize: 60 }}>
          Escolha um vídeo
        </AbsoluteFill>
      )}

      {narration.src && (
        <Sequence from={Math.round(narration.startAt * FPS)}>
          <Audio src={narration.src} volume={narration.volume} />
        </Sequence>
      )}
      {music.src && <Audio src={music.src} volume={music.volume} loop />}

      {efeitos && <Camadas efeitos={efeitos} trimStart={trimStart} total={Math.round(editLength(props) * FPS)} cor={captions.color} fontFamily={fontFamily} />}

      {captions.enabled && <Captions props={props} />}

      {props.cta?.enabled && (
        <Sequence from={Math.max(0, Math.round((editLength(props) - CTA_TEXTOS[props.cta.preset].duracao) * FPS))}>
          <EndCard preset={props.cta.preset} color={props.cta.color} />
        </Sequence>
      )}

      {hook.text.trim() && (
        <Sequence durationInFrames={Math.max(1, Math.round(hook.duration * FPS))}>
          <Hook text={hook.text} duration={hook.duration} />
        </Sequence>
      )}
    </AbsoluteFill>
  );
};
