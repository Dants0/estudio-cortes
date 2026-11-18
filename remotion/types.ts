export type FormatId = 'vertical' | 'horizontal' | 'square';

export const FORMATS: Record<FormatId, { width: number; height: number; label: string; targets: string }> = {
  vertical: { width: 1080, height: 1920, label: '9:16', targets: 'TikTok, Reels e Shorts' },
  horizontal: { width: 1920, height: 1080, label: '16:9', targets: 'YouTube' },
  square: { width: 1080, height: 1080, label: '1:1', targets: 'Feed do Instagram' },
};

export const FPS = 30;

export type Word = { text: string; start: number; end: number };

export type CaptionStyle = 'destaque' | 'limpa' | 'caixa';

export type EditProps = {
  format: FormatId;
  videoSrc: string | null;
  videoDuration: number;
  trimStart: number;
  trimEnd: number;
  fit: 'cover' | 'contain';
  zoom: number;
  originalVolume: number;
  hook: { text: string; duration: number };
  captions: {
    enabled: boolean;
    source: 'video' | 'narracao';
    words: Word[];
    style: CaptionStyle;
    position: number; // 0 = topo, 1 = base
    color: string;
    wordsPerLine: number;
  };
  narration: {
    src: string | null;
    duration: number;
    startAt: number;
    volume: number;
    words: Word[];
    text?: string;
  };
  music: { src: string | null; volume: number };
  cta?: { enabled: boolean; preset: 'shorts' | 'longo'; color: string };
  /** edição dinâmica do Claude, em segundos do vídeo (videoSrc) */
  efeitos?: Efeitos;
};

export type Efeitos = {
  zooms: { tipo: 'punch' | 'zoom_lento' | 'tremor' | 'foco'; inicio: number; dur: number; escala: number; x: number; y: number }[];
  textos: { inicio: number; dur: number; texto: string; estilo: 'impacto' | 'etiqueta' | 'meme' | 'alerta'; posicao: 'topo' | 'centro' | 'base' }[];
  transicoes: { em: number; tipo: 'flash' | 'zoom' | 'whip' | 'glitch' }[];
  sons: { inicio: number; src: string; volume: number; tipo?: string }[];
  destaques: string[];
  barra: boolean;
};

export const CTA_TEXTOS = {
  shorts: { titulo: 'SEGUE PRA VER O PRÓXIMO UPDATE! 👀', sub: 'dantas-dev.com', duracao: 3 },
  longo: { titulo: 'SE INSCREVE NO CANAL!', sub: 'Toda semana tem novidade do jogo 🔔', duracao: 9 },
} as const;

export const defaultProps: EditProps = {
  format: 'vertical',
  videoSrc: null,
  videoDuration: 10,
  trimStart: 0,
  trimEnd: 10,
  fit: 'cover',
  zoom: 1,
  originalVolume: 1,
  hook: { text: '', duration: 2.5 },
  captions: {
    enabled: true,
    source: 'video',
    words: [],
    style: 'destaque',
    position: 0.72,
    color: '#FFD43B',
    wordsPerLine: 3,
  },
  narration: { src: null, duration: 0, startAt: 0, volume: 1, words: [] },
  music: { src: null, volume: 0.15 },
  cta: { enabled: false, preset: 'shorts', color: '#FFD43B' },
};

export const editLength = (p: EditProps) => {
  const clip = Math.max(0.5, p.trimEnd - p.trimStart);
  const narrationEnd = p.narration.src ? p.narration.startAt + p.narration.duration : 0;
  return Math.max(clip, narrationEnd);
};
