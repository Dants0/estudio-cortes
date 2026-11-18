import type { EditProps, FormatId, Word } from '../remotion/types';

export type MediaItem = { name: string; url: string; kind: 'video' | 'audio' | 'render'; size: number; createdAt: number; projeto?: string | null; origem?: string | null };
export type Project = { id: string; name: string; props: EditProps; meta?: ProjectMeta; createdAt: number; updatedAt: number };
export type Voice = { id: string; name: string; category: string; preview: string; labels: Record<string, string> };
export type Job = {
  id: string; format: FormatId; name: string; status: 'na fila' | 'renderizando' | 'pronto' | 'erro';
  progress: number; url?: string; error?: string; createdAt: number; projeto?: string;
};

const req = async <T,>(url: string, init?: RequestInit): Promise<T> => {
  const r = await fetch(url, {
    ...init,
    headers: init?.body && !(init.body instanceof FormData) ? { 'Content-Type': 'application/json' } : undefined,
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || `Falha na requisição (${r.status})`);
  return j as T;
};

export type Status = {
  elevenlabs: boolean;
  keyFromEnv: boolean;
  claude: { ok: boolean; via: string | null; modelo: string };
  youtube: { configurado: boolean; conectado: boolean; canal: { id: string; nome: string } | null };
  banco: boolean;
  photocraft: boolean;
  filmcraft: boolean;
  /** a ponte está com código ou .env antigos: precisa ser reaberta */
  ponteReabrir?: boolean;
  drive: { configurado: boolean; conectado: boolean; conta: { nome: string; email: string } | null; auto: boolean; pasta?: string | null };
  biblioteca: boolean;
};
export type BibItem = MediaItem & { pasta: string };
export type Musica = { name: string; url: string; bloqueada: boolean };
export type AiCtx = {
  titulo?: string; jogo?: string; formato?: FormatId; duracao?: number; ideia?: string; roteiro?: string; transcricao?: string;
  narracao?: string; gancho?: string; tom?: string; video?: { src: string; inicio?: number; fim?: number }; origem?: string; transcrever?: boolean;
  /** true = pedir outra versão ao Claude (ignora a resposta guardada no banco) */
  novo?: boolean;
};
/** data (ISO) em que a resposta foi gerada, quando veio do banco sem gastar token */
export type DoCache = { _cache?: string | null };
export type ContextoUsado = { frames: number; transcricao: boolean; descricao: boolean };
export type Roteiro = {
  titulo_provisorio: string; gancho: string; duracao_alvo_s?: number; cta: string;
  blocos: { tempo: string; mostrar: string; falar: string }[]; dicas_de_gravacao?: string[];
};
export type TextosPub = {
  o_que_o_video_mostra?: string; _contexto?: ContextoUsado;
  titulos: string[]; texto_thumbnail?: string; descricao_youtube: string; tags: string[];
  legenda_curta: string; hashtags: string[]; comentario_fixado: string;
};
export type ProjectMeta = {
  /** exportação escolhida para publicar (url em /media/renders) */
  arquivoPublicar?: string;
  /** thumbnail escolhida na aba Thumbnail (vai para o YouTube na publicação) */
  thumbnail?: string;
  jogo?: string; ideia?: string; roteiro?: Roteiro; textos?: TextosPub;
  /** última edição automática (Claude + FilmCraft) */
  edicao?: { editadoEm: number; musica: string | null; projetoFilmCraft: string; segmentos: { inicio: number; fim: number; velocidade: number; motivo: string }[]; plano: { resumo: string } };
};
export type FaseEdicao = 'fala' | 'plano' | 'filmcraft' | 'remotion';
export type EdicaoJob = {
  id: string; projeto: string; nome: string; status: 'na fila' | 'editando' | 'pronto' | 'erro';
  fase: FaseEdicao | null; fases: { id: FaseEdicao; nome: string }[]; etapa: string;
  progresso: number; eta: number | null; criadoEm: number; inicio?: number; fim?: number; erro?: string; doCache?: string | null;
  resultado?: { duracao: number; segmentos: number; musica: string | null };
  renders?: { id: string; format: FormatId; url?: string }[];
  drive?: EnvioDrive[];
};
export type EnvioDrive = { id: string; arquivo: string; url: string; status: 'na fila' | 'enviando' | 'pronto' | 'erro'; progresso: number; link?: string; erro?: string; criadoEm: number };
export type PubMeta = {
  titulo: string; descricao: string; tags: string[]; categoria: string; privacidade: 'private' | 'unlisted' | 'public';
  publicarEm: string | null; playlistId: string | null; paraCriancas: boolean; conteudoSintetico: boolean;
  notificar: boolean; formato?: FormatId; legenda?: string;
  modo?: 'manual'; capaS?: number; agendarEm?: string | null;
  /** TikTok/Instagram: o vídeo e a legenda já estão prontos para postar à mão */
  pronto?: boolean; titulosAlternativos?: string[]; textoThumbnail?: string | null; comentarioFixado?: string | null;
};
export type Publicacao = {
  id: string; plataforma: 'youtube' | 'tiktok' | 'instagram'; projeto?: string; arquivo: string; thumbnail: string | null;
  meta: PubMeta; status: 'na fila' | 'enviando' | 'processando' | 'enviado' | 'agendado' | 'publicado' | 'no rascunho' | 'erro' | 'para postar' | 'postado' | 'aguardando aprovação';
  etapa?: string | null; nota?: string; producao?: string;
  enviado: number; erro?: string | null; avisos?: string[]; link?: string; videoId?: string; criadoEm: number;
};
export type ThumbJob = {
  id: string; status: 'exportando frames' | 'o Claude está assistindo o vídeo' | 'exportando os quadros escolhidos' | 'desenhando no PhotoCraft' | 'pronto' | 'erro'; erro?: string;
  // aba Thumbnail (pedido automático)
  auto?: boolean; fonte?: string; projeto?: string | null; nome?: string; criadoEm?: number; fim?: number;
  plano?: { o_que_o_video_mostra: string; titulo_sugerido: string; texto_thumbnail: string; conceitos: string[]; momentos: { t: number; por_que: string }[] };
  frames?: string[]; etapas: string[]; variacoes: { letra: string; arquivo: string; url: string; testa: string }[];
  recomendada?: string; motivo?: string; conferir?: string[];
};

export type CorteSugerido = {
  inicio: number; fim: number; titulo: string; gancho: string; motivo: string; miniatura?: string; palavras: Word[];
};
export type SugestaoJob = {
  id: string; src: string; status: 'lendo a gravação' | 'transcrevendo a fala' | 'olhando os quadros' | 'o Claude está assistindo' | 'pronto' | 'erro';
  erro?: string; resumo?: string; duracao?: number; cortes: CorteSugerido[];
  usado: { quadros?: number; palavras?: number; descricao?: boolean };
  _cache?: string | null;
};

export type Agente = { id: 'roteirista' | 'social-media' | 'marketing'; nome: string; usadoEm: string; texto: string };
export type IdeiaHoje = {
  titulo: string; jogo: string; formato: 'short' | 'longo'; gancho: string; o_que_gravar: string; por_que: string;
  plataformas: string[]; melhor_horario?: string; esforco?: 'rápido' | 'médio' | 'grande';
};
export type SugestoesHoje = {
  resumo: string; geradoEm: string; foco?: string | null;
  tendencias: { tema: string; por_que_importa: string; fonte?: string; link?: string }[];
  ideias: IdeiaHoje[];
  agenda: { quando: string; plataforma: string; o_que: string; observacao?: string }[];
  pendencias: string[];
};
export type SituacaoCanal = {
  hoje: string; diaSemana: string;
  brutos?: { arquivo: string; url: string; gravadoEm: string; tamanhoMB: number }[];
  cronograma?: string | null;
  publicacoes: { id: string; plataforma: Publicacao['plataforma']; status: Publicacao['status']; titulo: string; projeto?: string; link: string | null; quando: string }[];
  cortesSemPublicar: { id: string; nome: string; formato: FormatId }[];
  meuCanal?: { inscritos: number | null; videos: { titulo: string; publicadoEm: string; views: number; likes: number; comentarios: number; privacidade: string }[] } | null;
  emAlta?: { titulo: string; canal: string; views: number }[] | null;
};
export type Hoje = { situacao: SituacaoCanal; sugestoes: SugestoesHoje | null; gerando: { etapa: string; inicio: number } | null; erro: string | null };

export const api = {
  hoje: () => req<Hoje>('/api/hoje'),
  gerarHoje: (foco?: string) => req<{ status: string }>('/api/hoje', { method: 'POST', body: JSON.stringify({ foco: foco || undefined }) }),
  agentes: () => req<Agente[]>('/api/agentes'),
  salvarAgente: (id: Agente['id'], texto: string) => req(`/api/agentes/${id}`, { method: 'PUT', body: JSON.stringify({ texto }) }),
  restaurarAgente: (id: Agente['id']) => req<{ texto: string }>(`/api/agentes/${id}/restaurar`, { method: 'POST' }),
  status: () => req<Status>('/api/status'),
  /** o Claude planeja a edição, o FilmCraft executa e o Remotion finaliza */
  editarCorte: (id: string, opcoes: { novo?: boolean; formatos?: FormatId[] } = {}) =>
    req<EdicaoJob>(`/api/projects/${id}/editar`, { method: 'POST', body: JSON.stringify(opcoes) }),
  edicoes: () => req<EdicaoJob[]>('/api/edicoes'),
  biblioteca: (atualizar = false) => req<{ disponivel: boolean; videos: BibItem[]; musicas: Musica[] }>(`/api/biblioteca${atualizar ? '?atualizar=1' : ''}`),
  ai: {
    roteiro: (c: AiCtx) => req<Roteiro & DoCache & { _contexto?: ContextoUsado }>('/api/ai/roteiro', { method: 'POST', body: JSON.stringify(c) }),
    narracao: (c: AiCtx) => req<DoCache & { texto: string; observacao?: string; _contexto?: ContextoUsado }>('/api/ai/narracao', { method: 'POST', body: JSON.stringify(c) }),
    ganchos: (c: AiCtx) => req<DoCache & { ganchos: string[]; _contexto?: ContextoUsado }>('/api/ai/ganchos', { method: 'POST', body: JSON.stringify(c) }),
    publicacao: (c: AiCtx) => req<TextosPub & DoCache>('/api/ai/publicacao', { method: 'POST', body: JSON.stringify(c) }),
  },
  canal: () => req<{ texto: string }>('/api/canal'),
  saveCanal: (texto: string) => req('/api/canal', { method: 'PUT', body: JSON.stringify({ texto }) }),
  saveMeta: (id: string, meta: ProjectMeta) => req<Project>(`/api/projects/${id}`, { method: 'PUT', body: JSON.stringify({ meta }) }),
  ytLogout: () => req('/api/youtube/logout', { method: 'POST' }),
  driveEnviar: (url: string) => req<EnvioDrive>('/api/drive/enviar', { method: 'POST', body: JSON.stringify({ url }) }),
  driveEnvios: () => req<EnvioDrive[]>('/api/drive/envios'),
  driveConfig: (auto: boolean) => req<Status['drive']>('/api/drive/config', { method: 'PUT', body: JSON.stringify({ auto }) }),
  logout: (rede: 'youtube' | 'drive') => req(`/api/${rede}/logout`, { method: 'POST' }),
  playlists: () => req<{ id: string; nome: string }[]>('/api/youtube/playlists'),
  publicacoes: (projeto?: string) => req<Publicacao[]>(`/api/publicacoes${projeto ? `?projeto=${projeto}` : ''}`),
  publicar: (body: { plataforma: Publicacao['plataforma']; projeto?: string; arquivo: string; thumbnail?: string | null; meta: PubMeta }) =>
    req<Publicacao>('/api/publicacoes', { method: 'POST', body: JSON.stringify(body) }),
  pubAcao: (id: string, acao: 'tentar' | 'postado' | 'pendente' | 'remover' | 'excluir-youtube') => req<Publicacao>(`/api/publicacoes/${id}/${acao}`, { method: 'POST' }),
  thumbnails: (body: { props: EditProps; tempos: number[]; titulo: string; texto?: string; jogo?: string; quantidade?: number }) =>
    req<ThumbJob>('/api/thumbnails', { method: 'POST', body: JSON.stringify(body) }),
  thumbJob: (id: string) => req<ThumbJob>(`/api/thumbnails/${id}`),
  thumbAuto: (body: { fonte: string; projeto?: string; titulo?: string; texto?: string; jogo?: string; pedido?: string; quantidade?: number; novo?: boolean }) =>
    req<ThumbJob>('/api/thumbnails/auto', { method: 'POST', body: JSON.stringify(body) }),
  thumbsRecentes: () => req<ThumbJob[]>('/api/thumbnails'),
  producoes: () => req<Producao[]>('/api/producao'),
  produzir: (body: { src: string; jogo?: string; quantidade: number; minS: number; maxS: number; orientacao?: string; longo: boolean; youtube: { modo: 'agora' | 'programado'; primeiro?: string | null; intervaloH?: number }; base: unknown }) =>
    req<Producao>('/api/producao', { method: 'POST', body: JSON.stringify(body) }),
  retomarProducao: (id: string) => req<Producao>(`/api/producao/${id}/retomar`, { method: 'POST' }),
  removerProducao: (id: string) => req<{ ok: true }>(`/api/producao/${id}`, { method: 'DELETE' }),
  aprovarPublicacao: (id: string, body: { titulo?: string; descricao?: string; publicarEm?: string | null }) =>
    req<Publicacao>(`/api/publicacoes/${id}/aprovar`, { method: 'POST', body: JSON.stringify(body) }),
  sugerirCortes: (body: { src: string; jogo?: string; quantidade?: number; minS?: number; maxS?: number; orientacao?: string; evitarGanchos?: string[]; novo?: boolean }) =>
    req<SugestaoJob>('/api/ai/sugerir-cortes', { method: 'POST', body: JSON.stringify(body) }),
  sugestao: (id: string) => req<SugestaoJob>(`/api/ai/sugerir-cortes/${id}`),
  saveKey: (elevenlabsKey: string) => req<{ elevenlabs: boolean }>('/api/settings', { method: 'PUT', body: JSON.stringify({ elevenlabsKey }) }),
  media: () => req<{ videos: MediaItem[]; audio: MediaItem[]; renders: MediaItem[] }>('/api/media'),
  /** move um vídeo de D:\Videos para a lixeira do painel (D:\Videos\.lixeira-painel) */
  removerDaBiblioteca: (url: string) => req<{ ok: boolean; lixeira: string }>(`/api/biblioteca?url=${encodeURIComponent(url)}&forcar=true`, { method: 'DELETE' }),
  removeMedia: (sub: string, name: string) => req(`/api/media/${sub}/${encodeURIComponent(name)}`, { method: 'DELETE' }),
  projects: () => req<Project[]>('/api/projects'),
  createProject: (name: string, props: EditProps) => req<Project>('/api/projects', { method: 'POST', body: JSON.stringify({ name, props }) }),
  saveProject: (id: string, data: Partial<Pick<Project, 'name' | 'props'>>) =>
    req<Project>(`/api/projects/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
  removeProject: (id: string) => req(`/api/projects/${id}`, { method: 'DELETE' }),
  voices: () => req<Voice[]>('/api/voices'),
  tts: (body: { text: string; voiceId: string; stability: number; similarity: number; speed: number }) =>
    req<{ url: string; duration: number; words: Word[] }>('/api/tts', { method: 'POST', body: JSON.stringify(body) }),
  transcribe: (url: string, language?: string) =>
    req<{ words: Word[]; language: string }>('/api/transcribe', { method: 'POST', body: JSON.stringify({ url, language }) }),
  render: (name: string, props: EditProps, formats: FormatId[], projeto?: string) =>
    req<Job[]>('/api/render', { method: 'POST', body: JSON.stringify({ name, props, formats, projeto }) }),
  jobs: () => req<Job[]>('/api/jobs'),
};

export const uploadFile = (file: File, onProgress: (p: number) => void) =>
  new Promise<MediaItem>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    const form = new FormData();
    form.append('file', file);
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress(e.loaded / e.total);
    xhr.onload = () => {
      const j = JSON.parse(xhr.responseText || '{}');
      xhr.status < 300 ? resolve(j) : reject(new Error(j.error || 'Falha no envio'));
    };
    xhr.onerror = () => reject(new Error('Conexão perdida durante o envio'));
    xhr.open('POST', '/api/upload');
    xhr.send(form);
  });

export const probeMedia = (url: string, kind: 'video' | 'audio') =>
  new Promise<{ duration: number; width: number; height: number }>((resolve, reject) => {
    const el = document.createElement(kind);
    el.preload = 'metadata';
    el.onloadedmetadata = () =>
      resolve({
        duration: el.duration,
        width: (el as HTMLVideoElement).videoWidth || 0,
        height: (el as HTMLVideoElement).videoHeight || 0,
      });
    el.onerror = () => reject(new Error('Não consegui ler esse arquivo'));
    el.src = url;
  });

export type ItemProducao = {
  projeto: string; titulo: string; gancho?: string; miniatura?: string | null;
  status: 'na fila' | 'editando' | 'publicando' | 'pronto' | 'erro'; etapa?: string; erro?: string | null;
  progresso: number; eta: number | null; render?: string; duracao?: number; publicarEm?: string | null;
  publicacoes?: Partial<Record<'youtube' | 'tiktok' | 'instagram', Publicacao | null>>;
};
export type Producao = {
  id: string; criadoEm: number; fim?: number; status: 'rodando' | 'pronto' | 'com erros' | 'erro' | 'interrompido'; etapa?: string; erro?: string | null;
  fonte: { url: string; nome: string }; jogo: string; resumo?: string;
  config: { quantidade: number; minS: number; maxS: number; longo: boolean; youtube: { modo: 'agora' | 'programado'; primeiro: string | null; intervaloH: number } };
  shorts: ItemProducao[]; longo: ItemProducao | null;
};
