import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Player, PlayerRef } from '@remotion/player';
import { Edit } from '../remotion/Edit';
import { EditProps, FORMATS, FPS, FormatId, defaultProps, editLength, Word } from '../remotion/types';
import { api, uploadFile, probeMedia, MediaItem, Project, Voice, Job, Status, BibItem, Musica, ProjectMeta, EdicaoJob } from './api';
import { BotaoDrive, PainelEdicoes, ProgressoEdicao } from './edicoes';
import { RoteiroPanel, TextosPanel, PublicarPanel, ConexoesDialog, ctxDe } from './panels';
import { SugestoesDialog } from './sugestoes';
import { HojePage } from './hoje';
import { ThumbnailPage } from './thumbnail';
import { ProducaoPage } from './producao';
import { Check, Scissors, Upload, Wand2, X } from 'lucide-react';

type Tab = 'roteiro' | 'enquadrar' | 'legendas' | 'narracao' | 'textos' | 'exportar' | 'publicar';
const TABS: { id: Tab; label: string }[] = [
  { id: 'roteiro', label: 'Roteiro' },
  { id: 'enquadrar', label: 'Corte' },
  { id: 'legendas', label: 'Legendas' },
  { id: 'narracao', label: 'Voz' },
  { id: 'textos', label: 'Textos' },
  { id: 'exportar', label: 'Exportar' },
  { id: 'publicar', label: 'Publicar' },
];

const STATUS_VAZIO: Status = {
  elevenlabs: false, keyFromEnv: false, claude: { ok: false, via: null, modelo: '' },
  youtube: { configurado: false, conectado: false, canal: null },
  banco: false, photocraft: false, filmcraft: false, biblioteca: false,
  drive: { configurado: false, conectado: false, conta: null, auto: false },
};

const fmtTime = (s: number) => {
  if (!isFinite(s)) return '0:00';
  const m = Math.floor(s / 60);
  const sec = s - m * 60;
  return `${m}:${sec.toFixed(1).padStart(4, '0')}`;
};
const fmtSize = (b: number) => (b > 1e9 ? `${(b / 1e9).toFixed(1)} GB` : `${Math.max(1, Math.round(b / 1e6))} MB`);
const prettyName = (n: string) => n.replace(/^[a-z0-9]+-/, '').replace(/\.[^.]+$/, '').replace(/[-_]+/g, ' ');

type Toast = { id: number; text: string; tone: 'ok' | 'erro' };

export const App: React.FC = () => {
  const [status, setStatus] = useState<Status>(STATUS_VAZIO);
  const [bib, setBib] = useState<{ disponivel: boolean; videos: BibItem[]; musicas: Musica[] }>({ disponivel: false, videos: [], musicas: [] });
  const [bibFiltro, setBibFiltro] = useState('');
  const [meta, setMetaState] = useState<ProjectMeta>({});
  const [media, setMedia] = useState<{ videos: MediaItem[]; audio: MediaItem[]; renders: MediaItem[] }>({ videos: [], audio: [], renders: [] });
  const [projects, setProjects] = useState<Project[]>([]);
  const [project, setProject] = useState<Project | null>(null);
  const [props, setProps] = useState<EditProps>(defaultProps);
  const [tab, setTab] = useState<Tab>('enquadrar');
  const [view, setView] = useState<'hoje' | 'producao' | 'editar' | 'thumbnail'>(() => {
    try { return (localStorage.getItem('modo') as 'hoje' | 'producao' | 'editar' | 'thumbnail') || 'hoje'; } catch { return 'hoje'; }
  });
  useEffect(() => { try { localStorage.setItem('modo', view); } catch {} }, [view]);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [uploads, setUploads] = useState<{ name: string; p: number }[]>([]);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [sugerirDe, setSugerirDe] = useState<(MediaItem & { pasta?: string }) | null>(null);
  const [saving, setSaving] = useState<'salvo' | 'salvando' | null>(null);
  const [edicoes, setEdicoes] = useState<EdicaoJob[]>([]);
  const playerRef = useRef<PlayerRef>(null);

  const toast = useCallback((text: string, tone: Toast['tone'] = 'ok') => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t, { id, text, tone }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), tone === 'erro' ? 7000 : 3500);
  }, []);

  const refreshMedia = useCallback(() => api.media().then(setMedia).catch(() => {}), []);
  const refreshStatus = useCallback(() => api.status().then(setStatus).catch(() => {}), []);
  useEffect(() => {
    refreshStatus();
    refreshMedia();
    api.biblioteca().then(setBib).catch(() => {});
    api.projects().then((ps) => {
      setProjects(ps);
      // link direto: /?corte=<id> abre o corte no editor
      const id = new URLSearchParams(location.search).get('corte');
      const alvo = id && ps.find((p) => p.id === id);
      if (alvo) { openProject(alvo); setView('editar'); }
    }).catch(() => {});
    api.jobs().then(setJobs).catch(() => {});
    // volta do login do Google
    const q = new URLSearchParams(location.search);
    if (q.get('youtube') === 'conectado') toast(`YouTube conectado${q.get('canal') ? `: ${q.get('canal')}` : ''}`);
    if (q.get('youtube') === 'erro') toast(`Não deu para conectar o YouTube: ${q.get('msg')}`, 'erro');
    const rede = q.get('conexao');
    if (rede) {
      const nome = rede === 'drive' ? 'Google Drive' : rede;
      if (q.get('erro')) toast(`Não deu para conectar o ${nome}: ${q.get('erro')}`, 'erro');
      else toast(`${nome} conectado${q.get('conta') ? `: ${q.get('conta')}` : ''}`);
    }
    if (q.get('youtube') || rede) history.replaceState(null, '', '/');
  }, [refreshMedia, refreshStatus]); // eslint-disable-line react-hooks/exhaustive-deps

  // metadados do corte (jogo, ideia, roteiro, textos) salvos à parte das props do vídeo
  const metaTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const setMeta = useCallback((m: ProjectMeta) => {
    setMetaState(m);
    clearTimeout(metaTimer.current);
    metaTimer.current = setTimeout(() => {
      setProject((cur) => {
        if (cur) api.saveMeta(cur.id, m).then((s) => setProjects((ps) => ps.map((p) => (p.id === s.id ? s : p)))).catch(() => {});
        return cur;
      });
    }, 600);
  }, []);

  // edições automáticas (Claude + FilmCraft): acompanha o progresso enquanto houver alguma ativa
  const projectIdRef = useRef<string | null>(null);
  const edicaoAtiva = edicoes.some((j) => j.status === 'na fila' || j.status === 'editando');
  const refreshEdicoes = useCallback(() => api.edicoes().then(setEdicoes).catch(() => {}), []);
  useEffect(() => { refreshEdicoes(); }, [refreshEdicoes]);
  useEffect(() => {
    if (!edicaoAtiva) return;
    let anteriores = edicoes;
    const t = setInterval(async () => {
      const next = await api.edicoes().catch(() => null);
      if (!next) return;
      const terminadas = next.filter((j) => {
        const antes = anteriores.find((a) => a.id === j.id);
        return antes && antes.status !== j.status && (j.status === 'pronto' || j.status === 'erro');
      });
      anteriores = next;
      setEdicoes(next);
      if (!terminadas.length) return;
      for (const j of terminadas) {
        if (j.status === 'pronto') toast(`Editado pelo Claude: ${j.nome}${j.doCache ? ' (plano reaproveitado, 0 tokens)' : ''}`);
        else toast(`A edição de ${j.nome} falhou: ${j.erro}`, 'erro');
      }
      // o servidor mudou as props dos cortes editados: recarrega a lista e o corte aberto
      const ps = await api.projects().catch(() => null);
      if (ps) {
        setProjects(ps);
        const aberto = ps.find((p) => p.id === projectIdRef.current);
        if (aberto && terminadas.some((j) => j.projeto === aberto.id && j.status === 'pronto')) openProject(aberto);
      }
      api.jobs().then(setJobs).catch(() => {});
      refreshMedia();
    }, 1500);
    return () => clearInterval(t);
  }, [edicaoAtiva]); // eslint-disable-line react-hooks/exhaustive-deps

  const editarComClaude = async (id: string, novo = false) => {
    try {
      const j = await api.editarCorte(id, { novo });
      setEdicoes((cur) => [j, ...cur.filter((x) => x.id !== j.id)]);
    } catch (e) {
      toast((e as Error).message, 'erro');
    }
  };

  // acompanha exportações em andamento
  const activeJobs = jobs.some((j) => j.status === 'na fila' || j.status === 'renderizando');
  useEffect(() => {
    if (!activeJobs) return;
    const t = setInterval(async () => {
      const next = await api.jobs().catch(() => null);
      if (!next) return;
      setJobs((prev) => {
        next.forEach((j) => {
          const before = prev.find((p) => p.id === j.id);
          if (before && before.status !== j.status && j.status === 'pronto') toast(`Exportado: ${FORMATS[j.format].label} pronto para baixar`);
          if (before && before.status !== j.status && j.status === 'erro') toast(`A exportação ${FORMATS[j.format].label} falhou: ${j.error}`, 'erro');
        });
        return next;
      });
      if (!next.some((j) => j.status === 'na fila' || j.status === 'renderizando')) refreshMedia();
    }, 1000);
    return () => clearInterval(t);
  }, [activeJobs, refreshMedia, toast]);

  // autosave
  const firstLoad = useRef(true);
  useEffect(() => {
    if (!project) return;
    if (firstLoad.current) { firstLoad.current = false; return; }
    setSaving('salvando');
    const t = setTimeout(async () => {
      const saved = await api.saveProject(project.id, { props }).catch(() => null);
      if (saved) {
        setSaving('salvo');
        // atualiza no lugar: a lista não pode mudar de ordem embaixo do mouse
        setProjects((ps) => ps.map((p) => (p.id === saved.id ? saved : p)));
      }
    }, 700);
    return () => clearTimeout(t);
  }, [props, project]);

  const update = useCallback(<K extends keyof EditProps>(key: K, value: EditProps[K]) => setProps((p) => ({ ...p, [key]: value })), []);
  const patch = useCallback(<K extends 'captions' | 'narration' | 'hook' | 'music'>(key: K, value: Partial<EditProps[K]>) =>
    setProps((p) => ({ ...p, [key]: { ...p[key], ...value } })), []);

  const openProject = (p: Project) => {
    firstLoad.current = true;
    projectIdRef.current = p.id;
    setProject(p);
    setProps({ ...defaultProps, ...p.props, captions: { ...defaultProps.captions, ...p.props.captions } });
    setMetaState(p.meta || {});
    setSaving(null);
  };

  // thumbnail da aba Thumbnail vira a do YouTube na publicação daquele corte
  const usarThumbnail = async (projetoId: string, url: string) => {
    if (projetoId === project?.id) { setMeta({ ...meta, thumbnail: url }); return; }
    const p = projects.find((x) => x.id === projetoId);
    if (!p) return;
    const salvo = await api.saveMeta(p.id, { ...(p.meta || {}), thumbnail: url });
    setProjects((ps) => ps.map((x) => (x.id === salvo.id ? salvo : x)));
  };

  // escolhe a exportação que vai ser publicada (abre o corte dela se for outro) e vai para a aba Publicar
  const prepararPublicacao = (projetoId: string, url: string) => {
    if (projetoId === project?.id) setMeta({ ...meta, arquivoPublicar: url });
    else {
      const p = projects.find((x) => x.id === projetoId);
      if (!p) { toast('Esse corte não existe mais.', 'erro'); return; }
      openProject(p);
      setMeta({ ...(p.meta || {}), arquivoPublicar: url });
    }
    setTab('publicar');
    toast('Pronto para publicar');
  };

  // Clicar numa gravação SEMPRE abre um corte novo dela. Antes, com um corte aberto, o vídeo
  // dele era trocado em silêncio (o corte "GTA" passava a mostrar Minecraft).
  const pickVideo = async (item: MediaItem) => {
    try {
      // a gravação já está aberta: não faz nada
      if (project && props.videoSrc === item.url) return;
      const meta = await probeMedia(item.url, 'video');
      const next: EditProps = {
        ...defaultProps,
        videoSrc: item.url,
        videoDuration: meta.duration,
        trimStart: 0,
        trimEnd: meta.duration,
        format: meta.width > meta.height ? 'horizontal' : 'vertical',
      };
      const nome = prettyName(item.name);
      // só aproveita o corte aberto se ele ainda está vazio (sem vídeo)
      if (project && !props.videoSrc) {
        const p = await api.saveProject(project.id, { name: nome, props: next });
        setProjects((ps) => ps.map((x) => (x.id === p.id ? p : x)));
        openProject(p);
        return;
      }
      const p = await api.createProject(nome, next);
      setProjects((ps) => [p, ...ps]);
      openProject(p);
      toast(`Corte novo: ${nome}`);
    } catch (e) {
      toast((e as Error).message, 'erro');
    }
  };

  const newProject = () => {
    setProject(null);
    setProps(defaultProps);
    setMetaState({});
    setSaving(null);
  };

  const onFiles = async (files: FileList | File[]) => {
    for (const file of Array.from(files)) {
      setUploads((u) => [...u, { name: file.name, p: 0 }]);
      try {
        const item = await uploadFile(file, (p) => setUploads((u) => u.map((x) => (x.name === file.name ? { ...x, p } : x))));
        await refreshMedia();
        if (item.kind === 'video' && !props.videoSrc) await pickVideo({ ...item, size: file.size, createdAt: Date.now() } as MediaItem);
        toast(`${file.name} enviado`);
      } catch (e) {
        toast(`${file.name}: ${(e as Error).message}`, 'erro');
      } finally {
        setUploads((u) => u.filter((x) => x.name !== file.name));
      }
    }
  };

  // o que já está feito em cada etapa (mostrado nas abas do inspetor)
  const feito: Record<Tab, boolean> = {
    roteiro: Boolean(meta.roteiro),
    enquadrar: Boolean(props.videoSrc),
    legendas: props.captions.enabled && (props.captions.source === 'video' ? props.captions.words.length > 0 : props.narration.words.length > 0),
    narracao: Boolean(props.narration.src),
    textos: Boolean(props.hook.text.trim() || props.cta?.enabled),
    exportar: Boolean(project) && media.renders.some((r) => r.projeto === project!.id),
    publicar: Boolean(meta.textos),
  };

  const duration = Math.max(1, Math.round(editLength(props) * FPS));
  const f = FORMATS[props.format];

  return (
    <div className={`app ${view !== 'editar' ? 'modo-hoje' : ''}`}>
      <header className="top">
        <div className="brand">
          <span className="brand-mark" aria-hidden />
          Mesa de Corte
        </div>
        <nav className="modos" aria-label="Seção">
          <button className={view === 'hoje' ? 'on' : ''} aria-current={view === 'hoje'} onClick={() => setView('hoje')}>Hoje</button>
          <button className={view === 'producao' ? 'on' : ''} aria-current={view === 'producao'} onClick={() => setView('producao')}>Produção</button>
          <button className={view === 'editar' ? 'on' : ''} aria-current={view === 'editar'} onClick={() => setView('editar')}>Editar</button>
          <button className={view === 'thumbnail' ? 'on' : ''} aria-current={view === 'thumbnail'} onClick={() => setView('thumbnail')}>Thumbnail</button>
        </nav>
        {view !== 'editar' ? <span className="project-hint" /> : project ? (
          <input
            className="project-name"
            value={project.name}
            aria-label="Nome do projeto"
            onChange={(e) => setProject({ ...project, name: e.target.value })}
            onBlur={() => api.saveProject(project.id, { name: project.name }).then((s) => setProjects((ps) => ps.map((p) => (p.id === s.id ? s : p))))}
          />
        ) : (
          <span className="project-hint">Escolha uma gravação para começar um corte</span>
        )}
        <span className="save-state" aria-live="polite">{saving === 'salvando' ? 'Salvando…' : saving === 'salvo' ? 'Salvo' : ''}</span>
        {status.ponteReabrir && status.photocraft && (
          <span className="chip-aviso" title="A ponte foi aberta antes da última mudança no .env (ou está com o código antigo). Feche a janela dela e abra de novo ponteiniciar-ponte.bat.">Reabra a ponte do Windows</span>
        )}
        <button className="key-chip" onClick={() => setSettingsOpen(true)} aria-label="Conexões">
          {([['Claude', status.claude.ok], ['YouTube', status.youtube.conectado], ['Banco', status.banco], ['ElevenLabs', status.elevenlabs], ['PhotoCraft', status.photocraft]] as const).map(([n, ok]) => (
            <span key={n} className="conn-item"><span className={`dot ${ok ? 'on' : ''}`} aria-hidden />{n}</span>
          ))}
        </button>
      </header>

      {view === 'hoje' ? (
        <HojePage
          status={status}
          toast={toast}
          openConexoes={() => setSettingsOpen(true)}
          onSugerirCortes={(v) => setSugerirDe(v)}
          onAbrirCorte={(id) => {
            const p = projects.find((x) => x.id === id);
            if (!p) { toast('Esse corte não existe mais.', 'erro'); return; }
            openProject(p);
            setView('editar');
          }}
          onUsarIdeia={async (i) => {
            try {
              const p = await api.createProject(i.titulo, defaultProps);
              const meta: ProjectMeta = {
                jogo: i.jogo,
                ideia: `${i.o_que_gravar}\nGancho: ${i.gancho}\nFormato: ${i.formato === 'short' ? 'Short (9:16)' : 'vídeo longo (16:9)'}\nPor quê: ${i.por_que}`,
              };
              const salvo = await api.saveMeta(p.id, meta);
              setProjects((ps) => [salvo, ...ps]);
              openProject(salvo);
              setView('editar');
              setTab('roteiro');
              toast('Corte criado. Escreva o roteiro com o Claude e grave.');
            } catch (e) {
              toast((e as Error).message, 'erro');
            }
          }}
        />
      ) : view === 'producao' ? (
        <ProducaoPage
          status={status} gravacoes={media.videos} biblioteca={bib.videos} toast={toast} openConexoes={() => setSettingsOpen(true)}
          onThumbnail={() => setView('thumbnail')}
          onAbrirCorte={async (id) => {
            // os cortes da produção são criados no servidor: busca de novo se ainda não estão na lista
            let p = projects.find((x) => x.id === id);
            if (!p) {
              const ps = await api.projects().catch(() => null);
              if (ps) setProjects(ps);
              p = ps?.find((x) => x.id === id);
            }
            if (!p) { toast('Esse corte não existe mais.', 'erro'); return; }
            openProject(p);
            setView('editar');
          }}
        />
      ) : view === 'thumbnail' ? (
        <ThumbnailPage
          projects={projects} renders={media.renders} gravacoes={media.videos} biblioteca={bib.videos} status={status}
          toast={toast} openConexoes={() => setSettingsOpen(true)} onUsar={usarThumbnail}
        />
      ) : (<>
      <aside className="library">
        <DropZone onFiles={onFiles} uploads={uploads} />
        <section>
          <h2>Gravações</h2>
          {media.videos.length === 0 && <p className="empty">Arraste aqui os vídeos que você gravou. Eles ficam guardados no servidor.</p>}
          <ul className="clips">
            {media.videos.map((v) => (
              <li key={v.name} className={props.videoSrc === v.url ? 'current' : ''}>
                <button className="clip" onClick={() => pickVideo(v)}>
                  <video src={`${v.url}#t=1`} preload="metadata" muted />
                  <span className="clip-name">{prettyName(v.name)}</span>
                  <span className="clip-meta">{fmtSize(v.size)}</span>
                </button>
                <button className="icon-btn sug-btn" style={{ right: 34 }} title="Sugerir cortes com o Claude" aria-label={'Sugerir cortes de ' + v.name} onClick={() => setSugerirDe(v)}><Scissors className="size-3.5" aria-hidden /></button>
                <button
                  className="icon-btn"
                  aria-label={`Apagar ${prettyName(v.name)}`}
                  onClick={async () => {
                    if (!confirm('Apagar esta gravação do servidor?')) return;
                    await api.removeMedia('uploads', v.name);
                    refreshMedia();
                  }}
                >
                  <X className="size-3.5" aria-hidden />
                </button>
              </li>
            ))}
          </ul>
        </section>
        {bib.disponivel && (
          <section>
            <div className="row-between">
              <h2>Pasta D:\Videos</h2>
              <button className="link-btn" onClick={() => api.biblioteca(true).then(setBib)}>Atualizar</button>
            </div>
            <input type="text" className="filtro" placeholder="Filtrar por jogo ou nome" value={bibFiltro} onChange={(e) => setBibFiltro(e.target.value)} aria-label="Filtrar vídeos da pasta" />
            <ul className="clips">
              {bib.videos
                .filter((v) => !bibFiltro || `${v.pasta}/${v.name}`.toLowerCase().includes(bibFiltro.toLowerCase()))
                .slice(0, 40)
                .map((v) => (
                  <li key={v.url} className={props.videoSrc === v.url ? 'current' : ''}>
                    <button className="clip" onClick={() => pickVideo(v)} title={`${v.pasta}/${v.name}`}>
                      <video src={`${v.url}#t=1`} preload="metadata" muted />
                      <span className="clip-name">{v.name.replace(/\.[^.]+$/, '')}</span>
                      <span className="clip-meta">{v.pasta.split('/').slice(-2).join(' / ')} · {fmtSize(v.size)}</span>
                    </button>
                <button className="icon-btn sug-btn" style={{ right: 34 }} title="Sugerir cortes com o Claude" aria-label={'Sugerir cortes de ' + v.name} onClick={() => setSugerirDe(v)}><Scissors className="size-3.5" aria-hidden /></button>
                <button
                  className="icon-btn"
                  title="Remover da pasta (vai para a lixeira do painel)"
                  aria-label={`Remover ${v.name} da pasta`}
                  onClick={async () => {
                    const usados = projects.filter((p) => p.props.videoSrc === v.url);
                    const aviso = usados.length ? `\n\nAtenção: ${usados.length} corte(s) usam este vídeo e vão ficar sem a gravação.` : '';
                    if (!confirm(`Remover "${v.name}" da pasta ${v.pasta}?\n\nEle vai para D:\\Videos\\.lixeira-painel, de onde dá para recuperar.${aviso}`)) return;
                    try {
                      await api.removerDaBiblioteca(v.url);
                      setBib(await api.biblioteca(true));
                      toast('Vídeo movido para a lixeira do painel');
                    } catch (e) {
                      toast((e as Error).message, 'erro');
                    }
                  }}
                >
                  <X className="size-3.5" aria-hidden />
                </button>
                  </li>
                ))}
            </ul>
          </section>
        )}
        <section>
          <div className="row-between">
            <h2>Cortes</h2>
            <button className="link-btn" onClick={newProject}>Novo corte</button>
          </div>
          {projects.length === 0 && <p className="empty">Cada vídeo que você abre vira um corte salvo automaticamente.</p>}
          <ul className="projects">
            {projects.map((p) => (
              <li key={p.id} className={project?.id === p.id ? 'current' : ''}>
                <button onClick={() => openProject(p)}>
                  <span className={`ratio r-${p.props.format}`} aria-hidden />
                  <span className="p-name">{p.name}</span>
                </button>
                {(() => {
                  const ed = edicoes.find((j) => j.projeto === p.id && (j.status === 'na fila' || j.status === 'editando'));
                  return ed ? <div className="edicao-mini"><ProgressoEdicao job={ed} compacto /></div> : null;
                })()}
                <button
                  className="icon-btn"
                  aria-label={`Apagar corte ${p.name}`}
                  onClick={async () => {
                    if (!confirm(`Apagar o corte “${p.name}”?`)) return;
                    await api.removeProject(p.id);
                    setProjects((ps) => ps.filter((x) => x.id !== p.id));
                    if (project?.id === p.id) newProject();
                  }}
                >
                  <X className="size-3.5" aria-hidden />
                </button>
              </li>
            ))}
          </ul>
        </section>
      </aside>

      <main className="stage">
        <div className="formats" role="radiogroup" aria-label="Formato">
          {(Object.keys(FORMATS) as FormatId[]).map((id) => (
            <button key={id} role="radio" aria-checked={props.format === id} className={props.format === id ? 'on' : ''} onClick={() => update('format', id)}>
              <span className={`ratio r-${id}`} aria-hidden />
              <strong>{FORMATS[id].label}</strong>
              <span>{FORMATS[id].targets}</span>
            </button>
          ))}
        </div>
        <div className="screen">
          <div className="frame" style={{ aspectRatio: `${f.width} / ${f.height}`, width: `min(100cqw, calc(100cqh * ${f.width / f.height}))` }}>
            <Player
              ref={playerRef}
              component={Edit}
              inputProps={props}
              durationInFrames={duration}
              fps={FPS}
              compositionWidth={f.width}
              compositionHeight={f.height}
              style={{ width: '100%', height: '100%' }}
              controls
              acknowledgeRemotionLicense
              clickToPlay
            />
          </div>
        </div>
        {props.videoSrc && <TrimBar props={props} setProps={setProps} playerRef={playerRef} />}
        {project && props.videoSrc && status.claude.ok && (() => {
          const ed = edicoes.find((j) => j.projeto === project.id && (j.status === 'na fila' || j.status === 'editando'));
          if (ed) return <div className="editar-ia sug-palco"><strong>O Claude está editando este corte</strong><ProgressoEdicao job={ed} /></div>;
          const jaEditado = Boolean(meta.edicao);
          return (
            <button
              className="btn primary sm sug-palco"
              disabled={!status.filmcraft}
              title={status.filmcraft ? 'O Claude planeja a edição, o FilmCraft executa e o Remotion finaliza' : 'Abra a ponte do Windows (ponte\iniciar-ponte.bat) com o FilmCraft instalado'}
              onClick={() => {
                if (jaEditado && !confirm('Reeditar do zero a partir da gravação original? (gasta tokens de novo)')) return;
                editarComClaude(project.id, jaEditado);
              }}
            >
              <Wand2 className="size-3.5" aria-hidden /> {jaEditado ? 'Reeditar com o Claude' : 'Editar com o Claude'}
            </button>
          );
        })()}
        {props.videoSrc && status.claude.ok && (
          <button className="btn ghost sm sug-palco" onClick={() => {
            const v = [...media.videos, ...bib.videos].find((x) => x.url === props.videoSrc);
            setSugerirDe(v || { name: project?.name || 'gravação', url: props.videoSrc!, kind: 'video', size: 0, createdAt: 0 });
          }}><Scissors className="size-3.5" aria-hidden /> Sugerir cortes desta gravação</button>
        )}
      </main>

      <aside className="inspector">
        <nav className="tabs" role="tablist" aria-label="Etapas do corte">
          {TABS.map((t) => {
            const ok = feito[t.id];
            return (
              <button key={t.id} role="tab" aria-selected={tab === t.id} className={tab === t.id ? 'on' : ''} onClick={() => setTab(t.id)} title={ok ? `${t.label}: feito` : t.label}>
                {ok && <Check className="feito" aria-label="feito" />}
                {t.label}
              </button>
            );
          })}
        </nav>
        <div className="panel">
          {tab === 'roteiro' && <RoteiroPanel props={props} meta={meta} setMeta={setMeta} toast={toast} claudeOk={status.claude.ok} openConexoes={() => setSettingsOpen(true)} />}
          {tab === 'enquadrar' && <FramePanel props={props} update={update} patch={patch} audio={media.audio} musicas={bib.musicas} />}
          {tab === 'legendas' && <CaptionsPanel props={props} patch={patch} toast={toast} hasKey={status.elevenlabs} openSettings={() => setSettingsOpen(true)} />}
          {tab === 'narracao' && <NarrationPanel props={props} patch={patch} toast={toast} hasKey={status.elevenlabs} openSettings={() => setSettingsOpen(true)} refreshMedia={refreshMedia} meta={meta} claudeOk={status.claude.ok} />}
          {tab === 'textos' && <TextosPanel props={props} patch={patch} setCta={(c) => update('cta', c)} meta={meta} toast={toast} claudeOk={status.claude.ok} openConexoes={() => setSettingsOpen(true)} />}
          {tab === 'exportar' && (
            <ExportPanel
              props={props}
              name={project?.name || 'corte'}
              projeto={project?.id}
              projects={projects}
              escolhidos={[meta.arquivoPublicar, ...projects.filter((p) => p.id !== project?.id).map((p) => p.meta?.arquivoPublicar)].filter((u): u is string => Boolean(u))}
              onPreparar={prepararPublicacao}
              jobs={jobs}
              onQueued={(j) => setJobs((prev) => [...j, ...prev])}
              toast={toast}
              driveConectado={status.drive.conectado}
            />
          )}
          {tab === 'publicar' && (
            <PublicarPanel
              key={project?.id || 'nenhum'}
              project={project} props={props} meta={meta} setMeta={setMeta} renders={media.renders} refreshMedia={refreshMedia}
              status={status} toast={toast} playerRef={playerRef} openConexoes={() => setSettingsOpen(true)}
            />
          )}
        </div>
      </aside>
      </>)}

      {sugerirDe && (
        <SugestoesDialog
          video={sugerirDe}
          jogoPadrao={project?.props.videoSrc === sugerirDe.url ? meta.jogo : undefined}
          ganchosUsados={projects.map((p) => p.props.hook?.text).filter((t): t is string => Boolean(t && t.trim()))}
          temElevenLabs={status.elevenlabs}
          onClose={() => setSugerirDe(null)}
          temFilmCraft={status.filmcraft}
          onCriados={(ps) => {
            setProjects((cur) => [...[...ps].reverse(), ...cur]);
            if (ps[0]) openProject(ps[0]);
            api.jobs().then(setJobs).catch(() => {});
            refreshEdicoes();
          }}
          toast={toast}
        />
      )}

      {settingsOpen && (
        <ConexoesDialog status={status} onClose={() => { setSettingsOpen(false); refreshStatus(); }} onChanged={refreshStatus} toast={toast} />
      )}

      <PainelEdicoes
        edicoes={edicoes}
        onAbrir={(id) => {
          const p = projects.find((x) => x.id === id);
          if (p) { openProject(p); setView('editar'); }
        }}
      />

      <div className="toasts" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className={`toast ${t.tone}`}>{t.text}</div>
        ))}
      </div>
    </div>
  );
};

/* ---------------- Peças ---------------- */

const DropZone: React.FC<{ onFiles: (f: FileList) => void; uploads: { name: string; p: number }[] }> = ({ onFiles, uploads }) => {
  const [over, setOver] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  return (
    <div
      className={`drop ${over ? 'over' : ''}`}
      onDragOver={(e) => { e.preventDefault(); setOver(true); }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => { e.preventDefault(); setOver(false); onFiles(e.dataTransfer.files); }}
    >
      <button className="btn primary" onClick={() => input.current?.click()}><Upload className="size-4" aria-hidden /> Enviar vídeos</button>
      <span>ou arraste para cá · mp4, mov, webm, mp3</span>
      <input ref={input} type="file" accept="video/*,audio/*" multiple hidden onChange={(e) => e.target.files && onFiles(e.target.files)} />
      {uploads.map((u) => (
        <div key={u.name} className="up">
          <span>{u.name}</span>
          <div className="bar"><i style={{ transform: `scaleX(${u.p})` }} /></div>
        </div>
      ))}
    </div>
  );
};

const TrimBar: React.FC<{ props: EditProps; setProps: React.Dispatch<React.SetStateAction<EditProps>>; playerRef: React.RefObject<PlayerRef | null> }> = ({ props, setProps, playerRef }) => {
  const track = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<'start' | 'end' | null>(null);
  const D = props.videoDuration || 1;

  const toTime = (clientX: number) => {
    const r = track.current!.getBoundingClientRect();
    return Math.min(D, Math.max(0, ((clientX - r.left) / r.width) * D));
  };
  const move = (e: React.PointerEvent) => {
    if (!drag) return;
    const t = toTime(e.clientX);
    setProps((p) => drag === 'start'
      ? { ...p, trimStart: Math.min(t, p.trimEnd - 0.5) }
      : { ...p, trimEnd: Math.max(t, p.trimStart + 0.5) });
  };
  const currentSourceTime = () => props.trimStart + (playerRef.current?.getCurrentFrame() ?? 0) / FPS;

  return (
    <div className="trim">
      <div className="trim-head">
        <span>Trecho usado</span>
        <span className="mono">{fmtTime(props.trimStart)} – {fmtTime(props.trimEnd)} <em>({fmtTime(props.trimEnd - props.trimStart)})</em></span>
        <div className="trim-actions">
          <button className="btn ghost sm" onClick={() => { const t = currentSourceTime(); setProps((p) => ({ ...p, trimStart: Math.min(t, p.trimEnd - 0.5) })); playerRef.current?.seekTo(0); }}>Começar aqui</button>
          <button className="btn ghost sm" onClick={() => { const t = currentSourceTime(); setProps((p) => ({ ...p, trimEnd: Math.max(t, p.trimStart + 0.5) })); }}>Terminar aqui</button>
          <button className="btn ghost sm" onClick={() => setProps((p) => ({ ...p, trimStart: 0, trimEnd: D }))}>Vídeo inteiro</button>
        </div>
      </div>
      <div
        className="track"
        ref={track}
        onPointerMove={move}
        onPointerUp={() => setDrag(null)}
        onPointerCancel={() => setDrag(null)}
      >
        <div className="sel" style={{ left: `${(props.trimStart / D) * 100}%`, right: `${100 - (props.trimEnd / D) * 100}%` }}>
          {(['start', 'end'] as const).map((h) => (
            <span
              key={h}
              className={`handle ${h}`}
              role="slider"
              tabIndex={0}
              aria-label={h === 'start' ? 'Início do trecho' : 'Fim do trecho'}
              aria-valuemin={0}
              aria-valuemax={D}
              aria-valuenow={h === 'start' ? props.trimStart : props.trimEnd}
              onPointerDown={(e) => { (e.currentTarget.parentElement!.parentElement as HTMLElement).setPointerCapture(e.pointerId); setDrag(h); }}
              onKeyDown={(e) => {
                const step = e.shiftKey ? 1 : 0.1;
                const d = e.key === 'ArrowRight' ? step : e.key === 'ArrowLeft' ? -step : 0;
                if (!d) return;
                e.preventDefault();
                setProps((p) => h === 'start'
                  ? { ...p, trimStart: Math.max(0, Math.min(p.trimStart + d, p.trimEnd - 0.5)) }
                  : { ...p, trimEnd: Math.min(D, Math.max(p.trimEnd + d, p.trimStart + 0.5)) });
              }}
            />
          ))}
        </div>
      </div>
    </div>
  );
};

type PatchFn = <K extends 'captions' | 'narration' | 'hook' | 'music'>(key: K, value: Partial<EditProps[K]>) => void;

const Field: React.FC<{ label: string; hint?: string; children: React.ReactNode; value?: string }> = ({ label, hint, children, value }) => (
  <label className="field">
    <span className="field-label">{label}{value && <span className="field-value">{value}</span>}</span>
    {children}
    {hint && <span className="hint">{hint}</span>}
  </label>
);

const FramePanel: React.FC<{ props: EditProps; update: <K extends keyof EditProps>(k: K, v: EditProps[K]) => void; patch: PatchFn; audio: MediaItem[]; musicas: Musica[] }> = ({ props, update, patch, audio, musicas }) => (
  <>
    <h3>Como o vídeo ocupa a tela</h3>
    <div className="seg">
      <button className={props.fit === 'cover' ? 'on' : ''} onClick={() => update('fit', 'cover')}>Preencher</button>
      <button className={props.fit === 'contain' ? 'on' : ''} onClick={() => update('fit', 'contain')}>Inteiro com fundo desfocado</button>
    </div>
    <Field label="Zoom" value={`${Math.round(props.zoom * 100)}%`}>
      <input type="range" min={1} max={2} step={0.01} value={props.zoom} onChange={(e) => update('zoom', +e.target.value)} />
    </Field>
    <Field label="Som original" value={`${Math.round(props.originalVolume * 100)}%`} hint="Abaixe quando a narração for a voz principal.">
      <input type="range" min={0} max={1} step={0.01} value={props.originalVolume} onChange={(e) => update('originalVolume', +e.target.value)} />
    </Field>
    <h3>Trilha de fundo</h3>
    <Field label="Música" hint="Faixas de “Músicas para Vídeos” no D:\Videos ou enviadas pelo upload. As bloqueadas por Content ID ficam desativadas.">
      <select value={props.music.src ?? ''} onChange={(e) => patch('music', { src: e.target.value || null })}>
        <option value="">Sem música</option>
        {musicas.length > 0 && (
          <optgroup label="D:\Videos">
            {musicas.map((m) => (
              <option key={m.url} value={m.url} disabled={m.bloqueada}>{m.name.replace(/\.[^.]+$/, '')}{m.bloqueada ? ' (bloqueada: Content ID)' : ''}</option>
            ))}
          </optgroup>
        )}
        <optgroup label="Enviadas">
          {audio.filter((a) => !a.name.startsWith('narracao-')).map((a) => <option key={a.name} value={a.url}>{prettyName(a.name)}</option>)}
        </optgroup>
      </select>
    </Field>
    {props.music.src && (
      <Field label="Volume da música" value={`${Math.round(props.music.volume * 100)}%`}>
        <input type="range" min={0} max={1} step={0.01} value={props.music.volume} onChange={(e) => patch('music', { volume: +e.target.value })} />
      </Field>
    )}
  </>
);

const LANGS = [
  ['', 'Detectar idioma'], ['por', 'Português'], ['eng', 'Inglês'], ['spa', 'Espanhol'],
];

const CaptionsPanel: React.FC<{ props: EditProps; patch: PatchFn; toast: (t: string, tone?: 'ok' | 'erro') => void; hasKey: boolean; openSettings: () => void }> = ({ props, patch, toast, hasKey, openSettings }) => {
  const [busy, setBusy] = useState(false);
  const [lang, setLang] = useState('por');
  const c = props.captions;
  const words = c.source === 'video' ? c.words : props.narration.words;

  const transcribe = async () => {
    if (!props.videoSrc) return;
    setBusy(true);
    try {
      const r = await api.transcribe(props.videoSrc, lang || undefined);
      patch('captions', { words: r.words, source: 'video', enabled: true });
      toast(r.words.length ? `${r.words.length} palavras transcritas` : 'Não encontrei fala nesse vídeo', r.words.length ? 'ok' : 'erro');
    } catch (e) {
      toast((e as Error).message, 'erro');
    } finally {
      setBusy(false);
    }
  };

  const editWord = (i: number, text: string) => {
    if (c.source !== 'video') return;
    const next = c.words.map((w, idx) => (idx === i ? { ...w, text } : w)).filter((w) => w.text.trim() !== "");
    patch('captions', { words: next });
  };

  return (
    <>
      <label className="switch">
        <input type="checkbox" checked={c.enabled} onChange={(e) => patch('captions', { enabled: e.target.checked })} />
        <span>Mostrar legendas</span>
      </label>

      <h3>De onde vem o texto</h3>
      <div className="seg">
        <button className={c.source === 'video' ? 'on' : ''} onClick={() => patch('captions', { source: 'video' })}>Fala do vídeo</button>
        <button className={c.source === 'narracao' ? 'on' : ''} onClick={() => patch('captions', { source: 'narracao' })}>Narração gerada</button>
      </div>

      {c.source === 'video' && (
        <div className="callout">
          {!hasKey ? (
            <>
              <p>A transcrição automática usa a ElevenLabs.</p>
              <button className="btn" onClick={openSettings}>Conectar ElevenLabs</button>
            </>
          ) : (
            <>
              <Field label="Idioma falado">
                <select value={lang} onChange={(e) => setLang(e.target.value)}>
                  {LANGS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                </select>
              </Field>
              <button className="btn primary wide" disabled={busy || !props.videoSrc} onClick={transcribe}>
                {busy ? 'Transcrevendo…' : c.words.length ? 'Transcrever de novo' : 'Transcrever fala do vídeo'}
              </button>
              {!props.videoSrc && <span className="hint">Escolha uma gravação primeiro.</span>}
            </>
          )}
        </div>
      )}
      {c.source === 'narracao' && !props.narration.words.length && (
        <p className="empty">Gere uma narração na aba Narração e as legendas acompanham a voz palavra por palavra.</p>
      )}

      <h3>Estilo</h3>
      <div className="styles">
        {([['destaque', 'Destaque'], ['caixa', 'Caixa'], ['limpa', 'Limpa']] as const).map(([id, label]) => (
          <button key={id} className={`style-card s-${id} ${c.style === id ? 'on' : ''}`} onClick={() => patch('captions', { style: id })}>
            <span className="sample" style={{ ['--hl' as string]: c.color }}>
              <b>tá</b> <i>pronto</i>
            </span>
            {label}
          </button>
        ))}
      </div>
      <div className="swatches" role="radiogroup" aria-label="Cor de destaque">
        {['#FFD43B', '#4ADE80', '#38BDF8', '#F472B6', '#FFFFFF'].map((col) => (
          <button key={col} role="radio" aria-checked={c.color === col} aria-label={`Cor ${col}`} className={c.color === col ? 'on' : ''} style={{ background: col }} onClick={() => patch('captions', { color: col })} />
        ))}
      </div>
      <Field label="Palavras por vez" value={String(c.wordsPerLine)}>
        <input type="range" min={1} max={6} step={1} value={c.wordsPerLine} onChange={(e) => patch('captions', { wordsPerLine: +e.target.value })} />
      </Field>
      <Field label="Altura na tela" value={`${Math.round(c.position * 100)}%`}>
        <input type="range" min={0.1} max={0.9} step={0.01} value={c.position} onChange={(e) => patch('captions', { position: +e.target.value })} />
      </Field>

      {words.length > 0 && (
        <>
          <h3>Revisar texto</h3>
          <p className="hint">{c.source === 'video' ? 'Clique numa palavra para corrigir. Apague o texto para remover.' : 'Para mudar o texto, edite o roteiro e gere a narração de novo.'}</p>
          <div className="words">
            {words.map((w, i) => (
              <WordChip key={i} word={w} editable={c.source === 'video'} onChange={(t) => editWord(i, t)} />
            ))}
          </div>
        </>
      )}
    </>
  );
};

const WordChip: React.FC<{ word: Word; editable: boolean; onChange: (t: string) => void }> = ({ word, editable, onChange }) => {
  const [val, setVal] = useState(word.text);
  useEffect(() => setVal(word.text), [word.text]);
  if (!editable) return <span className="word" title={fmtTime(word.start)}>{word.text}</span>;
  return (
    <input
      className="word"
      value={val}
      title={fmtTime(word.start)}
      size={Math.max(2, val.length)}
      onChange={(e) => setVal(e.target.value)}
      onBlur={() => val !== word.text && onChange(val)}
      onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
    />
  );
};

const NarrationPanel: React.FC<{
  props: EditProps; patch: PatchFn; toast: (t: string, tone?: 'ok' | 'erro') => void; hasKey: boolean; openSettings: () => void;
  refreshMedia: () => void; meta: ProjectMeta; claudeOk: boolean;
}> = ({ props, patch, toast, hasKey, openSettings, refreshMedia, meta, claudeOk }) => {
  const [escrevendo, setEscrevendo] = useState(false);
  const [tom, setTom] = useState('animado e natural');
  const [voices, setVoices] = useState<Voice[]>([]);
  const [voiceId, setVoiceId] = useState(() => localStorage.getItem('voz') || '');
  const [text, setText] = useState(() => localStorage.getItem('roteiro') || '');
  const [stability, setStability] = useState(0.45);
  const [speed, setSpeed] = useState(1.05);
  const [busy, setBusy] = useState(false);
  const preview = useRef<HTMLAudioElement | null>(null);

  useEffect(() => {
    if (!hasKey) return;
    api.voices().then((v) => {
      setVoices(v);
      if (!voiceId && v[0]) setVoiceId(v[0].id);
    }).catch((e) => toast(e.message, 'erro'));
  }, [hasKey]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { try { localStorage.setItem('roteiro', text); localStorage.setItem('voz', voiceId); } catch {} }, [text, voiceId]);

  if (!hasKey) {
    return (
      <div className="callout">
        <p>Escreva um roteiro e a ElevenLabs narra com a voz que você escolher, inclusive a sua voz clonada.</p>
        <button className="btn primary" onClick={openSettings}>Conectar ElevenLabs</button>
      </div>
    );
  }

  const voice = voices.find((v) => v.id === voiceId);
  const generate = async () => {
    setBusy(true);
    try {
      const r = await api.tts({ text, voiceId, stability, similarity: 0.8, speed });
      patch('narration', { src: r.url, duration: r.duration, words: r.words, text });
      refreshMedia();
      toast(`Narração gerada: ${fmtTime(r.duration)}`);
    } catch (e) {
      toast((e as Error).message, 'erro');
    } finally {
      setBusy(false);
    }
  };
  const chars = text.length;
  const escrever = async () => {
    setEscrevendo(true);
    try {
      const r = await api.ai.narracao({ ...ctxDe(props, meta), duracao: Math.max(3, props.trimEnd - props.trimStart - props.narration.startAt), tom, narracao: text || undefined, novo: Boolean(text) });
      setText(r.texto);
      if (r.observacao) toast(r.observacao);
    } catch (e) {
      toast((e as Error).message, 'erro');
    } finally {
      setEscrevendo(false);
    }
  };

  return (
    <>
      {claudeOk && (
        <div className="callout">
          <Field label="Tom da narração">
            <input type="text" value={tom} maxLength={200} onChange={(e) => setTom(e.target.value)} />
          </Field>
          <button className="btn wide" disabled={escrevendo} onClick={escrever}>
            {escrevendo ? 'O Claude está escrevendo…' : text ? 'Reescrever com o Claude' : 'Escrever narração com o Claude'}
          </button>
          <span className="hint">Usa o roteiro, a fala transcrita e a duração do trecho.</span>
        </div>
      )}
      <Field label="Texto da narração" hint={`${chars} caracteres · cerca de ${Math.max(1, Math.round(chars / 15))}s de fala`}>
        <textarea rows={7} maxLength={2500} value={text} placeholder="Ex.: Eu passei três meses fazendo esse bar funcionar. Olha o que acontece quando chega o primeiro cliente…" onChange={(e) => setText(e.target.value)} />
      </Field>
      <Field label="Voz">
        <div className="voice-row">
          <select value={voiceId} onChange={(e) => setVoiceId(e.target.value)}>
            {voices.map((v) => <option key={v.id} value={v.id}>{v.name}{v.category === 'cloned' ? ' (sua voz)' : ''}</option>)}
          </select>
          <button
            className="btn ghost"
            disabled={!voice?.preview}
            onClick={() => {
              preview.current?.pause();
              preview.current = new Audio(voice!.preview);
              preview.current.play();
            }}
          >
            Ouvir
          </button>
        </div>
      </Field>
      <Field label="Estabilidade" value={stability < 0.35 ? 'Expressiva' : stability > 0.7 ? 'Constante' : 'Equilibrada'}>
        <input type="range" min={0} max={1} step={0.05} value={stability} onChange={(e) => setStability(+e.target.value)} />
      </Field>
      <Field label="Velocidade" value={`${speed.toFixed(2)}×`}>
        <input type="range" min={0.7} max={1.2} step={0.05} value={speed} onChange={(e) => setSpeed(+e.target.value)} />
      </Field>
      <button className="btn primary wide" disabled={busy || !text.trim() || !voiceId} onClick={generate}>
        {busy ? 'Gerando narração…' : props.narration.src ? 'Gerar narração de novo' : 'Gerar narração'}
      </button>

      {props.narration.src && (
        <>
          <h3>Na linha do tempo</h3>
          <audio controls src={props.narration.src} className="audio" />
          <Field label="Começa em" value={fmtTime(props.narration.startAt)}>
            <input type="range" min={0} max={Math.max(1, props.trimEnd - props.trimStart)} step={0.1} value={props.narration.startAt} onChange={(e) => patch('narration', { startAt: +e.target.value })} />
          </Field>
          <Field label="Volume da narração" value={`${Math.round(props.narration.volume * 100)}%`}>
            <input type="range" min={0} max={1.5} step={0.01} value={props.narration.volume} onChange={(e) => patch('narration', { volume: +e.target.value })} />
          </Field>
          <button className="btn ghost wide" onClick={() => patch('narration', { src: null, words: [], duration: 0 })}>Remover narração do corte</button>
        </>
      )}
    </>
  );
};

const ExportPanel: React.FC<{
  props: EditProps; name: string; projeto?: string; projects: Project[]; jobs: Job[]; onQueued: (j: Job[]) => void;
  toast: (t: string, tone?: 'ok' | 'erro') => void; driveConectado: boolean; escolhidos: string[];
  onPreparar: (projeto: string, url: string) => void;
}> = ({ props: propsAberto, name: nomeAberto, projeto: projetoAberto, projects, jobs, onQueued, toast, driveConectado, escolhidos, onPreparar }) => {
  // qual corte exportar: o aberto no player (com as mudanças ao vivo) ou qualquer outro corte salvo
  const [alvo, setAlvo] = useState<string>(projetoAberto || '');
  useEffect(() => { setAlvo(projetoAberto || ''); }, [projetoAberto]);
  const outro = alvo && alvo !== projetoAberto ? projects.find((p) => p.id === alvo) : undefined;
  const props: EditProps = outro ? { ...defaultProps, ...outro.props, captions: { ...defaultProps.captions, ...outro.props.captions } } : propsAberto;
  const name = outro ? outro.name : nomeAberto;
  const projeto = outro ? outro.id : projetoAberto;

  const [sel, setSel] = useState<FormatId[]>([props.format]);
  useEffect(() => { setSel([props.format]); }, [alvo]); // eslint-disable-line react-hooks/exhaustive-deps
  const [busy, setBusy] = useState(false);
  const toggle = (id: FormatId) => setSel((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]));
  const length = editLength(props);

  const go = async () => {
    setBusy(true);
    try {
      onQueued(await api.render(name, props, sel, projeto));
      toast(sel.length > 1 ? `${sel.length} versões na fila de exportação` : 'Exportação na fila');
    } catch (e) {
      toast((e as Error).message, 'erro');
    } finally {
      setBusy(false);
    }
  };

  const warnings = useMemo(() => {
    const w: string[] = [];
    if (sel.includes('vertical') && length > 180) w.push('Acima de 3 min: o TikTok aceita, mas Shorts não.');
    if (sel.includes('vertical') && length > 90) w.push('Reels com mais de 90s não entram na aba Reels.');
    return w;
  }, [sel, length]);

  const comVideo = projects.filter((p) => p.props.videoSrc);
  return (
    <>
      <h3>Corte para exportar</h3>
      {comVideo.length === 0 && !projetoAberto ? (
        <p className="empty">Abra ou crie um corte com vídeo para exportar.</p>
      ) : (
        <select className="wide" value={alvo} onChange={(e) => setAlvo(e.target.value)} aria-label="Corte para exportar">
          {projetoAberto && <option value={projetoAberto}>{nomeAberto} (aberto no player)</option>}
          {comVideo.filter((p) => p.id !== projetoAberto).map((p) => (
            <option key={p.id} value={p.id}>{p.name}</option>
          ))}
        </select>
      )}
      {outro && <p className="hint">Exporta a última versão salva de “{outro.name}”, sem abrir no player.</p>}

      <h3>Versões para exportar</h3>
      <div className="export-list">
        {(Object.keys(FORMATS) as FormatId[]).map((id) => (
          <label key={id} className={`export-opt ${sel.includes(id) ? 'on' : ''}`}>
            <input type="checkbox" checked={sel.includes(id)} onChange={() => toggle(id)} />
            <span className={`ratio r-${id}`} aria-hidden />
            <span>
              <strong>{FORMATS[id].targets}</strong>
              <em>{FORMATS[id].width}×{FORMATS[id].height} · {FORMATS[id].label}</em>
            </span>
          </label>
        ))}
      </div>
      <p className="hint">Duração do corte: {fmtTime(length)}. Legendas e gancho se ajustam a cada formato.</p>
      {warnings.map((w) => <p key={w} className="warn">{w}</p>)}
      <button className="btn primary wide" disabled={busy || !sel.length || !props.videoSrc} onClick={go}>
        {sel.length > 1 ? `Exportar ${sel.length} versões` : 'Exportar MP4'}
      </button>

      {jobs.length > 0 && (
        <>
          <h3>Exportações</h3>
          <ul className="jobs">
            {jobs.map((j) => (
              <li key={j.id} className={`job ${j.status === 'erro' ? 'bad' : ''}`}>
                <span className={`ratio r-${j.format}`} aria-hidden />
                <div className="job-body">
                  <span className="job-name">{j.name} · {FORMATS[j.format].label}</span>
                  {j.status === 'pronto' && j.url ? (
                    <div className="row-gap">
                      {j.projeto && (escolhidos.includes(j.url) ? (
                        <span className="selo-publicar"><Check className="size-3.5" aria-hidden /> Escolhido para publicar</span>
                      ) : (
                        <button className="btn sm primary" onClick={() => onPreparar(j.projeto!, j.url!)}>Preparar para publicar</button>
                      ))}
                      <a className="btn sm" href={j.url} download>Baixar MP4</a>
                      <BotaoDrive url={j.url} conectado={driveConectado} toast={toast} />
                    </div>
                  ) : j.status === 'erro' ? (
                    <span className="hint">{j.error}</span>
                  ) : (
                    <>
                      <div className="bar"><i style={{ transform: `scaleX(${j.progress})` }} /></div>
                      <span className="hint">{j.status === 'na fila' ? 'Na fila' : `Renderizando ${Math.round(j.progress * 100)}%`}</span>
                    </>
                  )}
                </div>
              </li>
            ))}
          </ul>
        </>
      )}
    </>
  );
};

