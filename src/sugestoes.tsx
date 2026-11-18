import React, { useEffect, useRef, useState } from 'react';
import { EditProps, defaultProps } from '../remotion/types';
import { api, CorteSugerido, MediaItem, Project, SugestaoJob } from './api';

type ToastFn = (t: string, tone?: 'ok' | 'erro') => void;

const mmss = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
const ETAPAS: SugestaoJob['status'][] = ['lendo a gravação', 'transcrevendo a fala', 'olhando os quadros', 'o Claude está assistindo'];

/** O Claude assiste à gravação inteira, propõe Shorts e o painel cria um corte para cada um. */
export const SugestoesDialog: React.FC<{
  video: MediaItem;
  jogoPadrao?: string;
  ganchosUsados: string[];
  temElevenLabs: boolean;
  /** a ponte do Windows está com o FilmCraft: dá para o Claude editar cada corte sozinho */
  temFilmCraft?: boolean;
  onClose: () => void;
  onCriados: (ps: Project[]) => void;
  toast: ToastFn;
}> = ({ video, jogoPadrao, ganchosUsados, temElevenLabs, temFilmCraft = false, onClose, onCriados, toast }) => {
  const ref = useRef<HTMLDialogElement>(null);
  const [jogo, setJogo] = useState(jogoPadrao || adivinharJogo(video));
  const [quantidade, setQuantidade] = useState(4);
  const [faixa, setFaixa] = useState<[number, number]>([90, 150]);
  const [orientacao, setOrientacao] = useState('');
  const [job, setJob] = useState<SugestaoJob | null>(null);
  const [marcados, setMarcados] = useState<Set<number>>(new Set());
  const [exportar, setExportar] = useState(true);
  // padrão: o Claude edita cada corte no FilmCraft e o Remotion finaliza (automação máxima)
  const [editarIA, setEditarIA] = useState(temFilmCraft);
  const [criando, setCriando] = useState(false);

  useEffect(() => { ref.current?.showModal(); }, []);

  useEffect(() => {
    if (!job || job.status === 'pronto' || job.status === 'erro') return;
    const t = setInterval(async () => {
      const j = await api.sugestao(job.id).catch((e) => { toast(e.message, 'erro'); return null; });
      if (!j) return;
      setJob(j);
      if (j.status === 'pronto') setMarcados(new Set(j.cortes.map((_, i) => i)));
    }, 2500);
    return () => clearInterval(t);
  }, [job?.id, job?.status]); // eslint-disable-line react-hooks/exhaustive-deps

  const pedir = async (novo = false) => {
    try {
      setJob(await api.sugerirCortes({
        novo,
        src: video.url, jogo: jogo || undefined, quantidade, minS: faixa[0], maxS: faixa[1],
        orientacao: orientacao.trim() || undefined, evitarGanchos: ganchosUsados.slice(0, 60),
      }));
    } catch (e) {
      toast((e as Error).message, 'erro');
    }
  };

  const criar = async () => {
    if (!job) return;
    setCriando(true);
    const criados: Project[] = [];
    try {
      const dur = job.duracao || 0;
      for (const [i, c] of job.cortes.entries()) {
        if (!marcados.has(i)) continue;
        const props = propsDoCorte(video.url, dur, c);
        const p = await api.createProject(c.titulo, props);
        await api.saveMeta(p.id, { jogo: jogo || undefined, ideia: c.motivo });
        criados.push(p);
        if (editarIA) await api.editarCorte(p.id);
        else if (exportar) await api.render(c.titulo, props, ['vertical'], p.id);
      }
      onCriados(criados);
      toast(`${criados.length} cortes criados${editarIA ? '; o Claude vai editar um por um (acompanhe no canto da tela)' : exportar ? ' e na fila de exportação' : ''}`);
      ref.current?.close();
    } catch (e) {
      toast((e as Error).message, 'erro');
    } finally {
      setCriando(false);
    }
  };

  const trabalhando = job && job.status !== 'pronto' && job.status !== 'erro';
  const etapaAtual = job ? ETAPAS.indexOf(job.status) : -1;

  return (
    <dialog ref={ref} className="dialog wide sugestoes" onClose={onClose}>
      <h2>Sugerir cortes</h2>
      <p className="hint">{video.name.replace(/\.[^.]+$/, '')}</p>

      {!job && (
        <>
          <p>O Claude assiste à gravação inteira (quadros ao longo do vídeo{temElevenLabs ? ' e a fala transcrita' : ''}) e escolhe os melhores trechos para Shorts, TikTok e Reels.</p>
          {!temElevenLabs && <p className="hint warn">Sem a ElevenLabs, ele decide só pelos quadros e os cortes saem sem legenda.</p>}
          <div className="grid2">
            <label className="field">
              <span className="field-label">Jogo</span>
              <input type="text" list="jogos-sug" value={jogo} onChange={(e) => setJogo(e.target.value)} />
              <datalist id="jogos-sug">{['Oxe, Meu Bar!', 'Ironhex', 'Minecraft', 'GTAV'].map((j) => <option key={j} value={j} />)}</datalist>
            </label>
            <label className="field">
              <span className="field-label">Quantos cortes<span className="field-value">até {quantidade}</span></span>
              <input type="range" min={1} max={8} value={quantidade} onChange={(e) => setQuantidade(+e.target.value)} />
            </label>
          </div>
          <div className="seg">
            {([[60, 90, 'Rápidos (1:00–1:30)'], [90, 150, 'Padrão (1:30–2:30)'], [150, 180, 'Longos (2:30–3:00)']] as const).map(([a, b, l]) => (
              <button key={l} className={faixa[0] === a && faixa[1] === b ? 'on' : ''} onClick={() => setFaixa([a, b])}>{l}</button>
            ))}
          </div>
          <label className="field">
            <span className="field-label">Pedido para o Claude (opcional)</span>
            <input type="text" maxLength={300} value={orientacao} placeholder="Ex.: foca nas partes em que o NPC dá bug" onChange={(e) => setOrientacao(e.target.value)} />
          </label>
          <div className="dialog-actions">
            <button className="btn ghost" onClick={() => ref.current?.close()}>Cancelar</button>
            <button className="btn primary" onClick={() => pedir()}>Pedir sugestões</button>
          </div>
        </>
      )}

      {trabalhando && (
        <div className="etapas" aria-live="polite">
          {ETAPAS.map((e, i) => (
            <div key={e} className={`etapa ${i < etapaAtual ? 'feita' : i === etapaAtual ? 'agora' : ''}`}>
              <span className="dot" aria-hidden />{e[0].toUpperCase() + e.slice(1)}
            </div>
          ))}
          <p className="hint">Gravações longas levam alguns minutos. A transcrição fica guardada: da segunda vez é instantânea.</p>
        </div>
      )}

      {job?.status === 'erro' && (
        <div className="callout">
          <p className="err">{job.erro}</p>
          <button className="btn" onClick={() => setJob(null)}>Tentar de novo</button>
        </div>
      )}

      {job?.status === 'pronto' && (
        <>
          {job._cache && (
            <p className="hint">
              Sugestão guardada de {new Date(job._cache).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' })} para esta gravação (sem gastar token).{' '}
              <button className="link-btn" onClick={() => { setJob(null); pedir(true); }}>Pedir novas sugestões</button>
            </p>
          )}
          {job.resumo && <p className="callout entendeu"><strong>O Claude entendeu assim:</strong> {job.resumo}</p>}
          <p className="hint">
            Baseado em {job.usado.quadros} quadros{job.usado.palavras ? ` e ${job.usado.palavras} palavras faladas` : ''}{job.usado.descricao ? ' e nas anotações do Pipeline' : ''}.
          </p>
          <ul className="sug-lista">
            {job.cortes.map((c, i) => (
              <li key={i} className={marcados.has(i) ? 'on' : ''}>
                <label>
                  <input type="checkbox" checked={marcados.has(i)} onChange={() => {
                    const n = new Set(marcados);
                    if (n.has(i)) n.delete(i); else n.add(i);
                    setMarcados(n);
                  }} />
                  {c.miniatura ? <img src={c.miniatura} alt="" /> : <span className="sem-mini" />}
                  <span className="sug-corpo">
                    <strong>{c.titulo}</strong>
                    <span className="sug-tempo">{mmss(c.inicio)}–{mmss(c.fim)} · {Math.round(c.fim - c.inicio)} s{c.palavras.length ? ' · com legenda' : ''}</span>
                    <span className="sug-gancho">“{c.gancho}”</span>
                    <span className="hint">{c.motivo}</span>
                  </span>
                </label>
              </li>
            ))}
          </ul>
          <label className="switch" title={temFilmCraft ? '' : 'Abra a ponte do Windows com o FilmCraft para liberar'}>
            <input type="checkbox" disabled={!temFilmCraft} checked={editarIA} onChange={(e) => setEditarIA(e.target.checked)} />
            <span>O Claude edita cada corte no FilmCraft (cortes secos, zoom, música) e já exporta</span>
          </label>
          {!editarIA && <label className="switch"><input type="checkbox" checked={exportar} onChange={(e) => setExportar(e.target.checked)} /><span>Já exportar em 9:16 sem edição</span></label>}
          <div className="dialog-actions">
            <button className="btn ghost" onClick={() => setJob(null)}>Pedir outras</button>
            <button className="btn primary" disabled={criando || marcados.size === 0} onClick={criar}>
              {criando ? 'Criando…' : `Criar ${marcados.size} ${marcados.size === 1 ? 'corte' : 'cortes'}`}
            </button>
          </div>
        </>
      )}
    </dialog>
  );
};

/** Corte 9:16 pronto: trecho, legendas da fala, gancho e chamada final de Shorts. */
export function propsDoCorte(src: string, duracao: number, c: CorteSugerido): EditProps {
  return {
    ...defaultProps,
    format: 'vertical',
    videoSrc: src,
    videoDuration: duracao,
    trimStart: c.inicio,
    trimEnd: c.fim,
    // gameplay costuma ser 16:9: inteiro com fundo desfocado não corta o HUD
    fit: 'contain',
    zoom: 1,
    hook: { text: c.gancho, duration: 2.5 },
    captions: { ...defaultProps.captions, enabled: c.palavras.length > 0, source: 'video', words: c.palavras },
    cta: { enabled: true, preset: 'shorts', color: '#FFD43B' },
  };
}

function adivinharJogo(v: MediaItem & { pasta?: string }) {
  const s = `${v.pasta || ''}/${v.name}`.toLowerCase();
  if (s.includes('oxe')) return 'Oxe, Meu Bar!';
  if (s.includes('ironhex')) return 'Ironhex';
  if (s.includes('minecraft')) return 'Minecraft';
  if (s.includes('gtav') || s.includes('gta')) return 'GTAV';
  return '';
}
