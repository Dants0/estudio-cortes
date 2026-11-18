import React, { useEffect, useMemo, useRef, useState } from 'react';
import type { PlayerRef } from '@remotion/player';
import { EditProps, FORMATS, FormatId, editLength } from '../remotion/types';
import { api, Agente, AiCtx, ContextoUsado, MediaItem, Project, ProjectMeta, PubMeta, Publicacao, Status, ThumbJob } from './api';

type ToastFn = (t: string, tone?: 'ok' | 'erro') => void;

export const Campo: React.FC<{ label: string; hint?: string; value?: string; children: React.ReactNode }> = ({ label, hint, value, children }) => (
  <label className="field">
    <span className="field-label">{label}{value && <span className="field-value">{value}</span>}</span>
    {children}
    {hint && <span className="hint">{hint}</span>}
  </label>
);

/** Executa uma chamada ao Claude com estado de "pensando" e toast de erro. */
const useClaude = (toast: ToastFn) => {
  const [busy, setBusy] = useState<string | null>(null);
  const run = async <T,>(nome: string, fn: () => Promise<T>): Promise<T | null> => {
    setBusy(nome);
    try {
      const out = await fn();
      const cache = (out as { _cache?: string | null } | null)?._cache;
      if (cache) toast(`Resposta guardada de ${new Date(cache).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' })}, sem gastar token. Clique de novo para outra versão.`);
      return out;
    } catch (e) {
      toast((e as Error).message, 'erro');
      return null;
    } finally {
      setBusy(null);
    }
  };
  return { busy, run };
};

export const transcricaoDe = (props: EditProps) => props.captions.words.map((w) => w.text).join(' ');
export const ctxDe = (props: EditProps, meta: ProjectMeta, nome?: string): AiCtx => ({
  titulo: nome || undefined,
  jogo: meta.jogo || undefined,
  gancho: props.hook.text.trim() || undefined,
  narracao: props.narration.src ? props.narration.text || undefined : undefined,
  // o vídeo de verdade: o servidor extrai frames do trecho usado
  video: props.videoSrc ? { src: props.videoSrc, inicio: props.trimStart, fim: props.trimEnd } : undefined,
  formato: props.format,
  duracao: editLength(props),
  ideia: meta.ideia || undefined,
  roteiro: meta.roteiro ? meta.roteiro.blocos.map((b) => `${b.tempo}: ${b.mostrar} / ${b.falar}`).join('\n') : undefined,
  transcricao: transcricaoDe(props) || undefined,
});

/** Mostra em que o Claude se baseou, para você saber se ele viu o vídeo de verdade. */
export const ContextoNota: React.FC<{ c?: ContextoUsado }> = ({ c }) => {
  if (!c) return null;
  const partes = [
    c.frames ? `${c.frames} quadros do vídeo` : null,
    c.transcricao ? 'a fala transcrita' : null,
    c.descricao ? 'as anotações do Pipeline' : null,
  ].filter(Boolean);
  return (
    <p className={`hint ${partes.length ? '' : 'warn'}`}>
      {partes.length ? `O Claude usou ${partes.join(', ').replace(/, ([^,]*)$/, ' e $1')}.` : 'O Claude não teve acesso ao vídeo: o texto pode ficar genérico.'}
    </p>
  );
};

const ClaudeOff: React.FC<{ onOpen: () => void }> = ({ onOpen }) => (
  <div className="callout">
    <p>Conecte o Claude (sua assinatura Max) para usar esta parte.</p>
    <button className="btn" onClick={onOpen}>Ver como conectar</button>
  </div>
);

/* ---------------- Roteiro ---------------- */
export const RoteiroPanel: React.FC<{
  props: EditProps; meta: ProjectMeta; setMeta: (m: ProjectMeta) => void; toast: ToastFn; claudeOk: boolean; openConexoes: () => void;
}> = ({ props, meta, setMeta, toast, claudeOk, openConexoes }) => {
  const { busy, run } = useClaude(toast);
  const r = meta.roteiro;
  const gerar = async () => {
    const out = await run('roteiro', () => api.ai.roteiro({ ...ctxDe(props, meta), roteiro: undefined, duracao: props.videoSrc ? editLength(props) : undefined, novo: Boolean(r) }));
    if (out) setMeta({ ...meta, roteiro: out });
  };
  const copiar = () => {
    if (!r) return;
    const txt = [`${r.titulo_provisorio}`, `Gancho: ${r.gancho}`, ...r.blocos.map((b) => `[${b.tempo}] ${b.mostrar}\n   "${b.falar}"`), `CTA: ${r.cta}`].join('\n\n');
    navigator.clipboard.writeText(txt).then(() => toast('Roteiro copiado'));
  };
  return (
    <>
      <p className="hint">Planeje antes de gravar: o Claude monta o roteiro com gancho, blocos e chamada final, seguindo as regras do canal.</p>
      <Campo label="Jogo">
        <input type="text" list="jogos" value={meta.jogo || ''} placeholder="Oxe, Meu Bar!" onChange={(e) => setMeta({ ...meta, jogo: e.target.value })} />
        <datalist id="jogos">
          {['Oxe, Meu Bar!', 'Ironhex', 'Minecraft', 'GTAV'].map((j) => <option key={j} value={j} />)}
        </datalist>
      </Campo>
      <Campo label="Ideia do vídeo" hint="O que você vai mostrar, o que é novo, o que deu errado. Quanto mais concreto, melhor.">
        <textarea rows={5} maxLength={4000} value={meta.ideia || ''} placeholder="Ex.: terminei o sistema de clientes impacientes; quero mostrar a fila crescendo e um cliente indo embora bravo" onChange={(e) => setMeta({ ...meta, ideia: e.target.value })} />
      </Campo>
      {claudeOk ? (
        <button className="btn primary wide" disabled={!!busy || !(meta.ideia || '').trim()} onClick={gerar}>
          {busy ? 'O Claude está escrevendo…' : r ? 'Escrever outro roteiro' : 'Escrever roteiro com o Claude'}
        </button>
      ) : <ClaudeOff onOpen={openConexoes} />}

      {r && (
        <div className="roteiro">
          <div className="row-between">
            <h3>{r.titulo_provisorio}</h3>
            <button className="link-btn" onClick={copiar}>Copiar</button>
          </div>
          <ContextoNota c={(r as { _contexto?: ContextoUsado })._contexto} />
          <p className="gancho-linha"><strong>Gancho:</strong> {r.gancho}</p>
          <ol className="blocos">
            {r.blocos.map((b, i) => (
              <li key={i}>
                <span className="tempo">{b.tempo}</span>
                <span className="mostrar">{b.mostrar}</span>
                <span className="falar">“{b.falar}”</span>
              </li>
            ))}
          </ol>
          <p className="gancho-linha"><strong>Final:</strong> {r.cta}</p>
          {r.dicas_de_gravacao?.length ? (
            <>
              <h3>Na hora de gravar</h3>
              <ul className="dicas">{r.dicas_de_gravacao.map((d) => <li key={d}>{d}</li>)}</ul>
            </>
          ) : null}
        </div>
      )}
    </>
  );
};

/* ---------------- Textos na tela: gancho + chamada final ---------------- */
type PatchFn = <K extends 'captions' | 'narration' | 'hook' | 'music'>(key: K, value: Partial<EditProps[K]>) => void;

export const TextosPanel: React.FC<{
  props: EditProps; patch: PatchFn; setCta: (c: NonNullable<EditProps['cta']>) => void; meta: ProjectMeta;
  toast: ToastFn; claudeOk: boolean; openConexoes: () => void;
}> = ({ props, patch, setCta, meta, toast, claudeOk, openConexoes }) => {
  const { busy, run } = useClaude(toast);
  const [sugestoes, setSugestoes] = useState<string[]>([]);
  const [ctxUsado, setCtxUsado] = useState<ContextoUsado | undefined>();
  const cta = props.cta ?? { enabled: false, preset: props.format === 'horizontal' ? 'longo' : 'shorts', color: '#FFD43B' };
  return (
    <>
      <h3>Gancho de abertura</h3>
      <p className="hint">Uma frase curta nos primeiros segundos segura quem está rolando o feed.</p>
      <Campo label="Frase">
        <input type="text" value={props.hook.text} maxLength={70} placeholder="Ex.: Meu jogo quase quebrou aqui" onChange={(e) => patch('hook', { text: e.target.value })} />
      </Campo>
      <div className="chips">
        {(sugestoes.length ? sugestoes : ['Ninguém esperava isso', 'Olha o que eu fiz em 1 dia', 'Parte 2', 'Não pula o final']).map((s) => (
          <button key={s} className="chip" onClick={() => patch('hook', { text: s })}>{s}</button>
        ))}
      </div>
      {claudeOk ? (
        <button className="btn ghost wide" disabled={!!busy} onClick={async () => {
          const out = await run('ganchos', () => api.ai.ganchos({ ...ctxDe(props, meta), novo: sugestoes.length > 0 }));
          if (out) { setSugestoes(out.ganchos); setCtxUsado(out._contexto); }
        }}>
          {busy ? 'Pensando em ganchos…' : 'Sugerir ganchos com o Claude'}
        </button>
      ) : <ClaudeOff onOpen={openConexoes} />}
      <ContextoNota c={ctxUsado} />
      <Campo label="Tempo na tela" value={`${props.hook.duration.toFixed(1)}s`}>
        <input type="range" min={1} max={6} step={0.5} value={props.hook.duration} onChange={(e) => patch('hook', { duration: +e.target.value })} />
      </Campo>

      <h3>Chamada final</h3>
      <label className="switch">
        <input type="checkbox" checked={cta.enabled} onChange={(e) => setCta({ ...cta, enabled: e.target.checked })} />
        <span>Mostrar no fim do vídeo</span>
      </label>
      <div className="seg">
        <button className={cta.preset === 'shorts' ? 'on' : ''} onClick={() => setCta({ ...cta, preset: 'shorts' })}>Shorts, Reels, TikTok</button>
        <button className={cta.preset === 'longo' ? 'on' : ''} onClick={() => setCta({ ...cta, preset: 'longo' })}>Vídeo longo</button>
      </div>
      <p className="hint">
        {cta.preset === 'shorts'
          ? '“SEGUE PRA VER O PRÓXIMO UPDATE! 👀” com dantas-dev.com, nos últimos 3 segundos.'
          : '“SE INSCREVE NO CANAL!” nos últimos 9 segundos, com o lado direito livre para as telas finais do YouTube.'}
      </p>
      <div className="swatches" role="radiogroup" aria-label="Cor da chamada final">
        {['#FFD43B', '#FFC23A', '#FF8A3D', '#4ADE80', '#F472B6', '#FFFFFF'].map((col) => (
          <button key={col} role="radio" aria-checked={cta.color === col} aria-label={`Cor ${col}`} className={cta.color === col ? 'on' : ''} style={{ background: col }} onClick={() => setCta({ ...cta, color: col })} />
        ))}
      </div>
    </>
  );
};

/* ---------------- Publicar ---------------- */
const STATUS_LABEL: Record<Publicacao['status'], string> = {
  'na fila': 'Na fila', enviando: 'Enviando', processando: 'Processando', enviado: 'Enviado', agendado: 'Agendado',
  publicado: 'Publicado', 'no rascunho': 'Nos rascunhos do app', erro: 'Falhou', 'para postar': 'Para postar', postado: 'Postado',
  'aguardando aprovação': 'Aguardando aprovação (aba Produção)',
};
const PLAT_LABEL = { youtube: 'YouTube', tiktok: 'TikTok', instagram: 'Instagram' };
const CATEGORIAS = [['20', 'Jogos'], ['28', 'Ciência e tecnologia'], ['22', 'Pessoas e blogs'], ['24', 'Entretenimento'], ['27', 'Educação']];
const formatoDoArquivo = (name: string): FormatId | undefined =>
  /-9x16-/.test(name) ? 'vertical' : /-16x9-/.test(name) ? 'horizontal' : /-1x1-/.test(name) ? 'square' : undefined;

const localInput = (d: Date) => new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
const contarHashtags = (s: string) => (s.match(/#[\p{L}\p{N}_]+/gu) || []).length;

/** TikTok e Instagram não têm integração: você posta pelo app e o painel guarda legenda, data planejada e se já foi postado. */
const RedeManual: React.FC<{
  rede: 'tiktok' | 'instagram'; titulo: string; letra: string; agenda: string; setAgenda: (v: string) => void;
  busy: string | null; aviso?: string; desabilitado: boolean; onAnotar: () => void;
}> = ({ rede, titulo, letra, agenda, setAgenda, busy, aviso, desabilitado, onAnotar }) => (
  <section className="rede">
    <h3><span className={`plat plat-${rede}`} aria-hidden>{letra}</span> {titulo}</h3>
    {aviso && <p className="hint warn">{aviso}</p>}
    <p className="hint">Sem integração: você posta pelo app e o painel guarda o controle (legenda, data planejada e se já foi postado).</p>
    <label className="switch">
      <input type="checkbox" checked={Boolean(agenda)} onChange={(e) => {
        if (!e.target.checked) return setAgenda('');
        const d = new Date(Date.now() + 24 * 3600_000); d.setHours(17, 0, 0, 0); setAgenda(localInput(d));
      }} />
      <span>Marcar a data em que pretendo postar</span>
    </label>
    {agenda && <input type="datetime-local" value={agenda} onChange={(e) => setAgenda(e.target.value)} aria-label={`Data planejada no ${titulo}`} />}
    <button className="btn primary wide" disabled={desabilitado || !!busy} onClick={onAnotar}>
      {busy === `${rede}-manual` ? 'Anotando…' : `Anotar para postar no ${titulo.split(' ')[0]}`}
    </button>
  </section>
);

export const PublicarPanel: React.FC<{
  project: Project | null; props: EditProps; meta: ProjectMeta; setMeta: (m: ProjectMeta) => void;
  renders: MediaItem[]; refreshMedia: () => void; status: Status; toast: ToastFn; playerRef: React.RefObject<PlayerRef | null>; openConexoes: () => void;
}> = ({ project, props, meta, setMeta, renders, refreshMedia, status, toast, playerRef, openConexoes }) => {
  const { busy, run } = useClaude(toast);
  // só as exportações feitas DESTE corte (antes era pelo nome, e um corte homônimo trazia o vídeo errado)
  const meus = useMemo(() => renders.filter((r) => project && r.projeto === project.id), [renders, project]);
  // a exportação escolhida em "Preparar para publicar" (guardada no corte); sem escolha, a mais recente
  const arquivo = meus.find((r) => r.url === meta.arquivoPublicar)?.url || meus[0]?.url || '';
  const setArquivo = (url: string) => setMeta({ ...meta, arquivoPublicar: url });
  const quando = (r: MediaItem) => new Date(r.createdAt).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
  // mesma gravação e mesmo tamanho: é o mesmo vídeo exportado de novo
  const copiaDe = (r?: MediaItem) => r && meus.find((o) => o !== r && o.createdAt < r.createdAt && o.size === r.size && o.origem === r.origem);
  const rotuloVersao = (r: MediaItem, i: number) => [
    FORMATS[formatoDoArquivo(r.name) || 'vertical'].label,
    quando(r),
    r.origem?.startsWith('/media/editados/') ? 'editada pelo Claude' : 'edição manual',
    i === 0 ? 'mais recente' : '',
    copiaDe(r) ? 'cópia' : '',
  ].filter(Boolean).join(' · ');
  const arquivoItem = renders.find((r) => r.url === arquivo);
  const formato = arquivoItem ? formatoDoArquivo(arquivoItem.name) : undefined;

  const textos = meta.textos;
  const [m, setM] = useState<PubMeta>({
    titulo: '', descricao: '', tags: [], categoria: '20', privacidade: 'private', publicarEm: null,
    playlistId: null, paraCriancas: false, conteudoSintetico: Boolean(props.narration.src), notificar: true,
  });
  const [tagsTxt, setTagsTxt] = useState('');
  const [legenda, setLegenda] = useState('');
  const [agendar, setAgendar] = useState(false);
  const [playlists, setPlaylists] = useState<{ id: string; nome: string }[]>([]);
  const [pubs, setPubs] = useState<Publicacao[]>([]);
  const [thumb, setThumb] = useState<ThumbJob | null>(null);
  // começa com a escolhida na aba Thumbnail (se houver)
  const [thumbEscolhida, setThumbEscolhida] = useState<string | null>(meta.thumbnail ?? null);
  const [textoThumb, setTextoThumb] = useState('');
  const [capaS, setCapaS] = useState<number | null>(null);
  // data planejada no TikTok e no Instagram (só lembrete: a postagem é manual)
  const [agTt, setAgTt] = useState('');
  const [agIg, setAgIg] = useState('');

  const aplicarTextos = (t: NonNullable<ProjectMeta['textos']>) => {
    setM((x) => ({ ...x, titulo: t.titulos[0] || x.titulo, descricao: t.descricao_youtube }));
    setTagsTxt(t.tags.join(', '));
    setLegenda(`${t.legenda_curta}\n\n${t.hashtags.map((h) => (h.startsWith('#') ? h : `#${h}`)).join(' ')}`);
    if (t.texto_thumbnail) setTextoThumb(t.texto_thumbnail);
  };
  useEffect(() => { if (textos && !m.titulo) aplicarTextos(textos); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const refresh = () => project && api.publicacoes(project.id).then(setPubs).catch(() => {});
  useEffect(() => { refresh(); }, [project?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  const ativo = pubs.some((p) => ['na fila', 'enviando', 'processando'].includes(p.status));
  useEffect(() => {
    if (!ativo) return;
    const t = setInterval(refresh, 2500);
    return () => clearInterval(t);
  }, [ativo]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (status.youtube.conectado) api.playlists().then(setPlaylists).catch(() => {}); }, [status.youtube.conectado]);
  // acompanha a geração de thumbnails
  useEffect(() => {
    if (!thumb || thumb.status === 'pronto' || thumb.status === 'erro') return;
    const t = setInterval(async () => {
      const j = await api.thumbJob(thumb.id).catch(() => null);
      if (!j) return;
      setThumb(j);
      if (j.status === 'pronto') {
        const rec = j.variacoes.find((v) => v.letra === j.recomendada) || j.variacoes[0];
        setThumbEscolhida(rec?.url ?? null);
        toast('Thumbnails prontas');
      }
      if (j.status === 'erro') toast(`Thumbnails: ${j.erro}`, 'erro');
    }, 2500);
    return () => clearInterval(t);
  }, [thumb?.id, thumb?.status]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!project) return <p className="empty">Abra um corte para publicar.</p>;

  const gerarTextos = async () => {
    if (!arquivo) return;
    const out = await run('textos', () => api.ai.publicacao({
      ...ctxDe(props, meta, project.name),
      formato: formato || props.format,
      // o que o Claude analisa é a versão exportada que vai ser publicada
      video: { src: arquivo },
      origem: props.videoSrc || undefined,
      transcrever: true,
      novo: Boolean(meta.textos),
    }));
    if (out) { setMeta({ ...meta, textos: out }); aplicarTextos(out); }
  };

  const gerarThumbs = async () => {
    const dur = editLength(props);
    const atual = (playerRef.current?.getCurrentFrame() ?? 0) / 30;
    const tempos = [atual, dur * 0.3, dur * 0.6].map((t) => Math.round(t * 10) / 10);
    const j = await run('thumbs', () => api.thumbnails({ props, tempos, titulo: m.titulo || project.name, texto: textoThumb || undefined, jogo: meta.jogo }));
    if (j) { setThumb(j); setThumbEscolhida(null); }
  };

  const metaBase = (): PubMeta => ({
    ...m,
    titulo: m.titulo || project.name,
    tags: tagsTxt.split(',').map((t) => t.trim()).filter(Boolean),
    publicarEm: agendar && m.publicarEm ? new Date(m.publicarEm).toISOString() : null,
    formato,
    legenda,
    capaS: capaS ?? undefined,
  });

  const publicar = async (plataforma: Publicacao['plataforma'], extra: Partial<PubMeta>, thumbnail: string | null = null, rotulo: string = plataforma) => {
    const out = await run(rotulo, () => api.publicar({ plataforma, projeto: project.id, arquivo, thumbnail, meta: { ...metaBase(), ...extra } }));
    if (out) {
      toast(out.status === 'para postar' ? `Anotado para postar no ${PLAT_LABEL[plataforma]}` : `Na fila de envio para o ${PLAT_LABEL[plataforma]}`);
      refresh();
    }
  };

  const acao = async (p: Publicacao, a: 'tentar' | 'postado' | 'pendente' | 'remover' | 'excluir-youtube') => {
    try { await api.pubAcao(p.id, a); refresh(); } catch (e) { toast((e as Error).message, 'erro'); }
  };

  const yt = status.youtube;
  const legendaLen = legenda.length;
  const hashtags = contarHashtags(legenda);

  return (
    <>
      {arquivoItem && (
        <div className="publicando" aria-live="polite">
          <video src={`${arquivoItem.url}#t=1`} preload="metadata" muted aria-hidden />
          <div>
            <span className="publicando-rotulo">Publicando</span>
            <strong>{project.name}</strong>
            <span className="hint">
              {formato ? `${FORMATS[formato].label} · ${FORMATS[formato].targets}` : 'Vídeo exportado'} · exportado {new Date(arquivoItem.createdAt).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}
            </span>
            <span className="hint publicando-arquivo" title={arquivoItem.name}>{arquivoItem.name}</span>
          </div>
        </div>
      )}
      {meus.length === 0 ? (
        <>
          <h3>Arquivo</h3>
          <div className="callout">
            <p>Este corte ainda não foi exportado. Exporte na aba Exportar: o arquivo aparece aqui e os textos do Claude são escritos a partir dele.</p>
          </div>
        </>
      ) : (
        <>
          {meus.length > 1 && (
            <Campo label={`Versão (${meus.length} exportações deste corte)`} hint={copiaDe(arquivoItem) ? `É uma cópia idêntica da exportação de ${quando(copiaDe(arquivoItem)!)}.` : undefined}>
              <div className="row-gap">
                <select value={arquivo} onChange={(e) => setArquivo(e.target.value)} style={{ flex: 1 }}>
                  {meus.map((r, i) => (
                    <option key={r.url} value={r.url}>{rotuloVersao(r, i)}</option>
                  ))}
                </select>
                <button className="btn sm ghost" disabled={!!busy} title="Apagar esta versão exportada" onClick={async () => {
                  if (!arquivoItem || !confirm(`Apagar a versão exportada em ${quando(arquivoItem)}?`)) return;
                  try {
                    await api.removeMedia('renders', arquivoItem.name);
                    if (meta.arquivoPublicar === arquivoItem.url) setMeta({ ...meta, arquivoPublicar: undefined });
                    refreshMedia();
                    toast('Versão apagada');
                  } catch (e) { toast((e as Error).message, 'erro'); }
                }}>Apagar</button>
              </div>
            </Campo>
          )}
          {arquivoItem?.origem && props.videoSrc && arquivoItem.origem !== props.videoSrc && (
            <p className="warn">Esta exportação foi feita de outra gravação, diferente da que está no player. Exporte de novo antes de publicar.</p>
          )}
        </>
      )}

      <h3>Textos</h3>
      {status.claude.ok ? (
        <>
          <button className="btn ghost wide" disabled={!!busy || !arquivo} onClick={gerarTextos}>
            {busy === 'textos' ? 'O Claude está assistindo e escrevendo…' : textos ? 'Escrever de novo com o Claude' : 'Escrever textos com o Claude'}
          </button>
          <p className="hint">Ele olha quadros desta versão exportada, transcreve a fala{status.elevenlabs ? '' : ' (com a ElevenLabs conectada)'} e lê as anotações do Pipeline.</p>
        </>
      ) : <ClaudeOff onOpen={openConexoes} />}
      {textos?.o_que_o_video_mostra && (
        <div className="callout entendeu">
          <p><strong>O Claude entendeu assim:</strong> {textos.o_que_o_video_mostra}</p>
          <ContextoNota c={textos._contexto} />
        </div>
      )}
      {textos && textos.titulos.length > 1 && (
        <div className="chips" style={{ marginTop: 10 }}>
          {textos.titulos.map((t) => <button key={t} className={`chip ${m.titulo === t ? 'on' : ''}`} onClick={() => setM({ ...m, titulo: t })}>{t}</button>)}
        </div>
      )}
      <Campo label="Título (YouTube)" value={`${m.titulo.length}/100`}>
        <input type="text" maxLength={100} value={m.titulo} onChange={(e) => setM({ ...m, titulo: e.target.value })} />
      </Campo>
      <Campo label="Descrição (YouTube)">
        <textarea rows={7} maxLength={5000} value={m.descricao} onChange={(e) => setM({ ...m, descricao: e.target.value })} />
      </Campo>
      <Campo label="Tags (YouTube)" hint="Separe por vírgula.">
        <input type="text" value={tagsTxt} onChange={(e) => setTagsTxt(e.target.value)} />
      </Campo>
      <Campo label="Legenda (TikTok e Instagram)" value={`${legendaLen}/2200 · ${hashtags} hashtags`}>
        <textarea rows={5} maxLength={2200} value={legenda} onChange={(e) => setLegenda(e.target.value)} />
      </Campo>
      {hashtags > 30 && <p className="warn">O Instagram aceita até 30 hashtags.</p>}
      {textos?.comentario_fixado && (
        <div className="callout">
          <p><strong>Comentário para fixar:</strong> {textos.comentario_fixado}</p>
          <button className="btn sm ghost" onClick={() => navigator.clipboard.writeText(textos.comentario_fixado).then(() => toast('Comentário copiado'))}>Copiar</button>
        </div>
      )}
      <Campo label="Capa (TikTok e Instagram)" value={capaS === null ? 'primeiro quadro' : `${capaS.toFixed(1)} s`}>
        <div className="row-gap">
          <button className="btn sm ghost" onClick={() => setCapaS(Math.round(((playerRef.current?.getCurrentFrame() ?? 0) / 30) * 10) / 10)}>Usar o quadro atual do player</button>
          {capaS !== null && <button className="btn sm ghost" onClick={() => setCapaS(null)}>Primeiro quadro</button>}
        </div>
      </Campo>

      {formato === 'horizontal' && (
        <>
          <h3>Thumbnail</h3>
          {meta.thumbnail && thumbEscolhida === meta.thumbnail && (
            <div className="publicando">
              <img src={meta.thumbnail} alt="Thumbnail escolhida" style={{ width: 128, aspectRatio: '16 / 9', objectFit: 'cover', borderRadius: 6, flex: 'none' }} />
              <div>
                <span className="publicando-rotulo">Vai para o YouTube</span>
                <span className="hint">Escolhida na aba Thumbnail.</span>
              </div>
            </div>
          )}
          {!status.photocraft ? (
            <div className="callout">
              <p>As thumbnails são feitas no PhotoCraft do seu Windows. Abra <code>ponte\iniciar-ponte.bat</code> e recarregue a página.</p>
            </div>
          ) : (
            <>
              <Campo label="Texto da thumbnail" hint="Até 3 palavras. Deixe vazio para o Claude escolher.">
                <input type="text" maxLength={40} value={textoThumb} onChange={(e) => setTextoThumb(e.target.value)} />
              </Campo>
              <button className="btn ghost wide" disabled={!!busy || (thumb !== null && thumb.status !== 'pronto' && thumb.status !== 'erro')} onClick={gerarThumbs}>
                {thumb && thumb.status !== 'pronto' && thumb.status !== 'erro' ? `${thumb.status[0].toUpperCase()}${thumb.status.slice(1)}…` : 'Criar 3 thumbnails no PhotoCraft'}
              </button>
              <p className="hint">Usa o quadro atual do player e dois outros momentos do corte. Leva alguns minutos.</p>
              {thumb?.etapas?.length && thumb.status === 'desenhando no PhotoCraft' ? <p className="hint mono">{thumb.etapas.join(' → ')}</p> : null}
              {thumb?.variacoes?.length ? (
                <div className="thumbs" role="radiogroup" aria-label="Thumbnail escolhida">
                  {thumb.variacoes.map((v) => (
                    <button key={v.url} role="radio" aria-checked={thumbEscolhida === v.url} className={thumbEscolhida === v.url ? 'on' : ''} onClick={() => setThumbEscolhida(v.url)}>
                      <img src={`${v.url}?v=${thumb.id}`} alt={`Variação ${v.letra}: ${v.testa}`} />
                      <span>{v.letra}{v.letra === thumb.recomendada ? ' · recomendada' : ''}</span>
                      <em>{v.testa}</em>
                    </button>
                  ))}
                </div>
              ) : null}
              {thumb?.conferir?.length ? <ul className="dicas">{thumb.conferir.map((c) => <li key={c}>{c}</li>)}</ul> : null}
            </>
          )}
        </>
      )}

      {/* ---------- YouTube ---------- */}
      <section className="rede">
        <h3><span className="plat plat-youtube" aria-hidden>Y</span> YouTube</h3>
        {!yt.configurado || !yt.conectado ? (
          <div className="callout">
            <p>{!yt.configurado ? 'Falta a credencial do Google (client_secret.json).' : 'O YouTube ainda não está conectado.'}</p>
            <button className="btn" onClick={openConexoes}>Conectar YouTube</button>
          </div>
        ) : (
          <>
            <p className="hint">Canal: {yt.canal?.nome || 'conectado'}</p>
            <label className="switch">
              <input type="checkbox" checked={agendar} onChange={(e) => {
                setAgendar(e.target.checked);
                if (e.target.checked && !m.publicarEm) { const d = new Date(Date.now() + 24 * 3600_000); d.setHours(17, 0, 0, 0); setM({ ...m, publicarEm: localInput(d) }); }
              }} />
              <span>Agendar a publicação</span>
            </label>
            {agendar ? (
              <Campo label="Publicar em" hint="O vídeo sobe privado e o próprio YouTube publica no horário.">
                <input type="datetime-local" value={m.publicarEm || ''} onChange={(e) => setM({ ...m, publicarEm: e.target.value })} />
              </Campo>
            ) : (
              <div className="seg">
                {([['private', 'Privado'], ['unlisted', 'Não listado'], ['public', 'Público']] as const).map(([v, l]) => (
                  <button key={v} className={m.privacidade === v ? 'on' : ''} onClick={() => setM({ ...m, privacidade: v })}>{l}</button>
                ))}
              </div>
            )}
            <Campo label="Categoria">
              <select value={m.categoria} onChange={(e) => setM({ ...m, categoria: e.target.value })}>
                {CATEGORIAS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
              </select>
            </Campo>
            {playlists.length > 0 && (
              <Campo label="Playlist">
                <select value={m.playlistId || ''} onChange={(e) => setM({ ...m, playlistId: e.target.value || null })}>
                  <option value="">Nenhuma</option>
                  {playlists.map((p) => <option key={p.id} value={p.id}>{p.nome}</option>)}
                </select>
              </Campo>
            )}
            <label className="switch"><input type="checkbox" checked={m.conteudoSintetico} onChange={(e) => setM({ ...m, conteudoSintetico: e.target.checked })} /><span>Avisar conteúdo alterado ou sintético</span></label>
            <p className="hint" style={{ margin: '0 0 10px 28px' }}>O YouTube pede esse aviso quando algo realista foi gerado por IA, como uma voz clonada falando o que a pessoa não disse.</p>
            <label className="switch"><input type="checkbox" checked={m.paraCriancas} onChange={(e) => setM({ ...m, paraCriancas: e.target.checked })} /><span>Conteúdo feito para crianças</span></label>
            <button className="btn primary wide" style={{ marginTop: 14 }} disabled={!!busy || !arquivo || !m.titulo.trim()} onClick={() => publicar('youtube', {}, formato === 'horizontal' ? thumbEscolhida : null)}>
              {busy === 'youtube' ? 'Enviando…' : agendar ? 'Agendar no YouTube' : 'Enviar para o YouTube'}
            </button>
          </>
        )}
      </section>

      {/* ---------- TikTok e Instagram: sem API, postagem manual com controle no painel ---------- */}
      <RedeManual
        rede="tiktok" titulo="TikTok" letra="T" agenda={agTt} setAgenda={setAgTt} busy={busy}
        aviso={formato === 'horizontal' ? 'Esta versão é 16:9. No TikTok, a 9:16 rende muito mais.' : undefined}
        desabilitado={!arquivo} onAnotar={() => publicar('tiktok', { modo: 'manual', agendarEm: agTt ? new Date(agTt).toISOString() : null }, null, 'tiktok-manual')}
      />
      <RedeManual
        rede="instagram" titulo="Instagram (Reels)" letra="I" agenda={agIg} setAgenda={setAgIg} busy={busy}
        aviso={formato === 'horizontal' ? 'Esta versão é 16:9. Reels ficam melhores em 9:16.' : undefined}
        desabilitado={!arquivo} onAnotar={() => publicar('instagram', { modo: 'manual', agendarEm: agIg ? new Date(agIg).toISOString() : null }, null, 'instagram-manual')}
      />

      <div className="row-gap" style={{ marginTop: 14 }}>
        {arquivo && <a className="btn sm ghost" href={arquivo} download>Baixar MP4</a>}
        <button className="btn sm ghost" disabled={!legenda} onClick={() => navigator.clipboard.writeText(legenda).then(() => toast('Legenda copiada'))}>Copiar legenda</button>
      </div>

      {pubs.length > 0 && (
        <>
          <h3>Publicações deste corte</h3>
          <ul className="jobs">
            {pubs.map((p) => {
              const manual = p.plataforma !== 'youtube' && (p.meta.modo || 'manual') === 'manual';
              return (
                <li key={p.id} className={`job ${p.status === 'erro' ? 'bad' : ''}`}>
                  <span className={`plat plat-${p.plataforma}`} aria-hidden>{PLAT_LABEL[p.plataforma][0]}</span>
                  <div className="job-body">
                    <span className="job-name">
                      {PLAT_LABEL[p.plataforma]} · {STATUS_LABEL[p.status]}{manual ? ' (manual)' : ''}
                      {p.etapa ? `: ${p.etapa}` : ''}
                      {(() => {
                        // YouTube agenda sozinho (publicarEm); no TikTok e no Instagram agendarEm é a data planejada
                        const quando = p.plataforma === 'youtube' ? p.meta.publicarEm : p.meta.agendarEm;
                        return quando ? ` para ${new Date(quando).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' })}` : '';
                      })()}
                    </span>
                    <span className="hint">{p.meta.titulo}</span>
                    {p.status === 'enviando' && <div className="bar"><i style={{ transform: `scaleX(${p.enviado})` }} /></div>}
                    {p.nota && <span className="hint">{p.nota}</span>}
                    {p.erro && <span className="hint err">{p.erro}</span>}
                    {p.avisos?.map((a) => <span key={a} className="hint warn">{a}</span>)}
                    <div className="row-gap">
                      {p.link && <a className="btn sm" href={p.link} target="_blank" rel="noreferrer">Abrir no {PLAT_LABEL[p.plataforma]}</a>}
                      {p.status === 'erro' && !manual && <button className="btn sm" onClick={() => acao(p, 'tentar')}>Tentar de novo</button>}
                      {(p.status === 'para postar' || p.status === 'no rascunho') && <button className="btn sm" onClick={() => acao(p, 'postado')}>Marcar como postado</button>}
                      {p.status === 'postado' && <button className="btn sm ghost" onClick={() => acao(p, 'pendente')}>Desfazer</button>}
                      {p.status !== 'enviando' && <button className="btn sm ghost" onClick={() => { if (confirm('Tirar da lista? (Não apaga nada na rede social.)')) acao(p, 'remover'); }}>Tirar da lista</button>}
                      {p.plataforma === 'youtube' && p.videoId && p.status !== 'enviando' && (
                        <button className="btn sm ghost text-bad" onClick={() => { if (confirm(`Apagar “${p.meta.titulo}” do YouTube? Não dá para desfazer.`)) acao(p, 'excluir-youtube'); }}>Apagar do YouTube</button>
                      )}
                    </div>
                  </div>
                </li>
              );
            })}
          </ul>
        </>
      )}
    </>
  );
};

const AgentesEditor: React.FC<{ toast: ToastFn }> = ({ toast }) => {
  const [lista, setLista] = useState<Agente[] | null>(null);
  const [aberto, setAberto] = useState<Agente['id'] | null>(null);
  const [texto, setTexto] = useState('');
  if (!lista) return <button className="btn sm ghost" onClick={() => api.agentes().then(setLista).catch((e) => toast(e.message, 'erro'))}>Ver agentes</button>;
  return (
    <div className="agentes">
      {lista.map((a) => (
        <div key={a.id} className="agente">
          <div className="row-between">
            <span><strong>{a.nome}</strong> <span className="hint">· {a.usadoEm}</span></span>
            <button className="link-btn" onClick={() => { setAberto(aberto === a.id ? null : a.id); setTexto(a.texto); }}>{aberto === a.id ? 'Fechar' : 'Editar'}</button>
          </div>
          {aberto === a.id && (
            <>
              <textarea rows={14} value={texto} onChange={(e) => setTexto(e.target.value)} />
              <div className="row-gap" style={{ marginTop: 8 }}>
                <button className="btn sm" onClick={async () => {
                  await api.salvarAgente(a.id, texto);
                  setLista(lista.map((x) => (x.id === a.id ? { ...x, texto } : x)));
                  toast(`${a.nome}: salvo`);
                }}>Salvar</button>
                <button className="btn sm ghost" onClick={async () => {
                  if (!confirm('Voltar ao texto original deste agente?')) return;
                  const r = await api.restaurarAgente(a.id);
                  setTexto(r.texto);
                  setLista(lista.map((x) => (x.id === a.id ? { ...x, texto: r.texto } : x)));
                }}>Restaurar o original</button>
              </div>
            </>
          )}
        </div>
      ))}
    </div>
  );
};

/* ---------------- Conexões ---------------- */
export const ConexoesDialog: React.FC<{
  status: Status; onClose: () => void; onChanged: () => void; toast: ToastFn;
}> = ({ status, onClose, onChanged, toast }) => {
  const ref = useRef<HTMLDialogElement>(null);
  const [key, setKey] = useState('');
  const [canal, setCanal] = useState<string | null>(null);
  useEffect(() => { ref.current?.showModal(); }, []);

  const dot = (ok: boolean) => <span className={`dot ${ok ? 'on' : ''}`} aria-hidden />;
  const sair = async (rede: 'youtube' | 'drive', nome: string) => {
    try { await api.logout(rede); onChanged(); toast(`${nome} desconectado`); } catch (e) { toast((e as Error).message, 'erro'); }
  };
  return (
    <dialog ref={ref} className="dialog wide" onClose={onClose}>
      <h2>Conexões</h2>

      <section className="conn">
        <h3>{dot(status.claude.ok)} Claude</h3>
        {status.claude.ok ? (
          <p>Conectado pela {status.claude.via === 'assinatura' ? 'sua assinatura (token OAuth)' : 'chave de API'}. Modelo: <code>{status.claude.modelo}</code>.</p>
        ) : (
          <>
            <p>Usa a sua assinatura Max, sem créditos de API. No terminal do Windows, rode:</p>
            <pre className="cmd">claude setup-token</pre>
            <p>Aprove no navegador, copie o token e coloque no <code>.env</code> da pasta do painel como <code>CLAUDE_CODE_OAUTH_TOKEN=…</code>. Depois rode <code>docker compose up -d</code>.</p>
          </>
        )}
      </section>

      <section className="conn">
        <h3>{dot(status.youtube.conectado)} YouTube</h3>
        {!status.youtube.configurado ? (
          <p>Falta o <code>client_secret.json</code> do Google. O <code>docker-compose.yml</code> já aponta para o do Pipeline (<code>D:\Pipeline\secrets</code>); confira se o arquivo existe e reinicie o container.</p>
        ) : status.youtube.conectado ? (
          <div className="row-between">
            <p>Canal: {status.youtube.canal?.nome || 'conectado'}</p>
            <button className="btn sm ghost" onClick={() => sair('youtube', 'YouTube')}>Desconectar</button>
          </div>
        ) : (
          <>
            <p>Entre com a conta do canal. O login abre na página do Google e volta para cá.</p>
            <a className="btn primary" href="/api/youtube/login">Conectar YouTube</a>
          </>
        )}
      </section>

      <section className="conn">
        <h3>{dot(status.drive.conectado)} Google Drive</h3>
        {!status.drive.configurado ? (
          <p>Usa o mesmo <code>client_secret.json</code> do YouTube, que ainda não foi encontrado.</p>
        ) : status.drive.conectado ? (
          <>
            <div className="row-between">
              <p>Conta: {status.drive.conta?.email || status.drive.conta?.nome || 'conectada'}{status.drive.pasta ? <> · <a href={status.drive.pasta} target="_blank" rel="noreferrer">abrir a pasta</a></> : null}</p>
              <button className="btn sm ghost" onClick={() => sair('drive', 'Google Drive')}>Desconectar</button>
            </div>
            <label className="switch">
              <input type="checkbox" checked={status.drive.auto} onChange={async (e) => {
                try { await api.driveConfig(e.target.checked); onChanged(); } catch (err) { toast((err as Error).message, 'erro'); }
              }} />
              <span>Enviar sozinho para o Drive quando o Claude terminar de editar um corte</span>
            </label>
            <p className="hint">O painel só enxerga a pasta que ele mesmo cria ("Mesa de Corte - vídeos editados"), nada mais do seu Drive.</p>
          </>
        ) : (
          <>
            <p>Os vídeos editados vão para uma pasta só do painel no seu Drive.</p>
            <a className="btn primary" href="/api/drive/login">Conectar Google Drive</a>
          </>
        )}
      </section>

      <section className="conn">
        <h3>{dot(status.banco)} Banco de dados</h3>
        <p>{status.banco
          ? 'Postgres conectado. Cortes, publicações e respostas do Claude ficam guardados: o mesmo pedido não gasta token duas vezes.'
          : 'O Postgres não respondeu. Confira se o serviço "banco" do docker-compose está rodando.'}</p>
      </section>

      <section className="conn">
        <h3>{dot(status.elevenlabs)} ElevenLabs</h3>
        {status.keyFromEnv ? (
          <p>A chave vem do <code>.env</code>.</p>
        ) : (
          <div className="voice-row">
            <input type="password" placeholder={status.elevenlabs ? 'Chave salva. Cole outra para trocar' : 'sk_…'} value={key} onChange={(e) => setKey(e.target.value)} />
            <button className="btn" disabled={!key.trim()} onClick={async () => {
              try { await api.saveKey(key); setKey(''); onChanged(); toast('Chave da ElevenLabs salva'); } catch (e) { toast((e as Error).message, 'erro'); }
            }}>Salvar</button>
          </div>
        )}
      </section>

      <section className="conn">
        <h3>{dot(status.photocraft)} PhotoCraft</h3>
        <p>{status.photocraft
          ? 'A ponte está rodando no Windows.'
          : <>Para criar thumbnails, abra <code>ponte\iniciar-ponte.bat</code> no Windows e deixe a janela aberta.</>}</p>
      </section>

      <section className="conn">
        <h3>Agentes</h3>
        <p>Três especialistas que o Claude assume em cada parte do painel. Edite à vontade: vale na próxima chamada.</p>
        <AgentesEditor toast={toast} />
      </section>

      <section className="conn">
        <h3>Regras do canal</h3>
        <p>O Claude segue estas regras ao escrever roteiros, narrações e descrições.</p>
        {canal === null ? (
          <button className="btn sm ghost" onClick={() => api.canal().then((c) => setCanal(c.texto))}>Ver e editar</button>
        ) : (
          <>
            <textarea rows={12} value={canal} onChange={(e) => setCanal(e.target.value)} />
            <button className="btn sm" style={{ marginTop: 8 }} onClick={() => api.saveCanal(canal).then(() => toast('Regras salvas'))}>Salvar regras</button>
          </>
        )}
      </section>

      <div className="dialog-actions">
        <button className="btn ghost" onClick={() => ref.current?.close()}>Fechar</button>
      </div>
    </dialog>
  );
};
