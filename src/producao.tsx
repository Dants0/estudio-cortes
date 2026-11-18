import { useEffect, useMemo, useState } from 'react';
import { Check, CheckCircle2, Clock, Copy, Download, ExternalLink, Film, Play, RefreshCw, Smartphone, Trash2, Youtube } from 'lucide-react';
import { api, type BibItem, type ItemProducao, type MediaItem, type Producao, type Publicacao, type Status } from './api';
import { defaultProps } from '../remotion/types';
import { Campo } from './panels';
import { fmtEta } from './edicoes';

type ToastFn = (t: string, tone?: 'ok' | 'erro') => void;

const dataHora = (iso: string | number) => new Date(iso).toLocaleString('pt-BR', { weekday: 'short', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
const mmss = (s?: number) => (s ? `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}` : '');
/** valor de <input type="datetime-local"> no fuso do navegador */
const paraInput = (d: Date) => new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
const proximas19h = () => {
  const d = new Date();
  d.setHours(19, 0, 0, 0);
  if (d.getTime() < Date.now() + 60 * 60_000) d.setDate(d.getDate() + 1);
  return paraInput(d);
};
const rodando = (p: Producao) => p.status === 'rodando';

const ROTULO_YT: Record<string, string> = {
  'na fila': 'na fila de envio', enviando: 'enviando…', processando: 'processando no YouTube', enviado: 'enviado',
  agendado: 'programado', publicado: 'no ar', erro: 'falhou', 'aguardando aprovação': 'aguardando sua aprovação',
};

export const ProducaoPage: React.FC<{
  status: Status; gravacoes: MediaItem[]; biblioteca: BibItem[]; toast: ToastFn; openConexoes: () => void;
  onAbrirCorte: (id: string) => void; onThumbnail: () => void;
}> = ({ status, gravacoes, biblioteca, toast, openConexoes, onAbrirCorte, onThumbnail }) => {
  const brutos = useMemo(() => [
    ...biblioteca.map((v) => ({ url: v.url, rotulo: `${v.name.replace(/\.[^.]+$/, '')} · ${v.pasta}`, jogo: adivinharJogo(`${v.pasta}/${v.name}`) })),
    ...gravacoes.map((v) => ({ url: v.url, rotulo: `${v.name} · enviada`, jogo: adivinharJogo(v.name) })),
  ], [biblioteca, gravacoes]);

  const [lista, setLista] = useState<Producao[]>([]);
  const [selId, setSelId] = useState<string | null>(null);
  const [fonte, setFonte] = useState('');
  const [jogo, setJogo] = useState('');
  const [quantidade, setQuantidade] = useState(3);
  const [modo, setModo] = useState<'agora' | 'programado'>('programado');
  const [primeiro, setPrimeiro] = useState(proximas19h());
  const [intervaloH, setIntervaloH] = useState(24);
  const [longo, setLongo] = useState(true);
  const [orientacao, setOrientacao] = useState('');
  const [enviando, setEnviando] = useState(false);

  useEffect(() => { if (!fonte && brutos[0]) { setFonte(brutos[0].url); setJogo(brutos[0].jogo); } }, [brutos, fonte]);

  const carregar = () => api.producoes().then((l) => { setLista(l); setSelId((s) => s && l.some((p) => p.id === s) ? s : l[0]?.id || null); }).catch(() => {});
  useEffect(() => { carregar(); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const algumaRodando = lista.some(rodando) || lista.some((p) => [...p.shorts, ...(p.longo ? [p.longo] : [])].some((x) => x.publicacoes && Object.values(x.publicacoes).some((pub) => pub && ['na fila', 'enviando', 'processando'].includes(pub.status))));
  useEffect(() => {
    if (!algumaRodando) return;
    const t = setInterval(carregar, 4000);
    return () => clearInterval(t);
  }, [algumaRodando]); // eslint-disable-line react-hooks/exhaustive-deps

  const prod = lista.find((p) => p.id === selId) || null;
  const faltando = !status.claude.ok ? 'Conecte o Claude.' : !status.youtube.conectado ? 'Conecte o YouTube para publicar os Shorts.' : !status.filmcraft ? 'Abra a ponte do Windows (ponte\\iniciar-ponte.bat) para o FilmCraft editar.' : status.ponteReabrir ? 'Reabra a ponte do Windows (ela está com o código ou o token antigos).' : null;

  const produzir = async () => {
    if (!fonte) return;
    setEnviando(true);
    try {
      const p = await api.produzir({
        src: fonte, jogo: jogo.trim() || undefined, quantidade, minS: 90, maxS: 150, orientacao: orientacao.trim() || undefined, longo,
        youtube: modo === 'agora' ? { modo } : { modo, primeiro: new Date(primeiro).toISOString(), intervaloH },
        base: defaultProps,
      });
      setLista((l) => [p, ...l]);
      setSelId(p.id);
      toast('Produção começou: o Claude vai assistir, editar e publicar sozinho');
    } catch (e) {
      toast((e as Error).message, 'erro');
    } finally {
      setEnviando(false);
    }
  };

  const acao = async (fn: () => Promise<unknown>, ok?: string) => {
    try { await fn(); if (ok) toast(ok); carregar(); } catch (e) { toast((e as Error).message, 'erro'); }
  };

  return (
    <div className="[grid-area:hoje] min-h-0 overflow-y-auto">
      <div className="mx-auto grid max-w-[1400px] gap-8 px-8 pt-7 pb-12 lg:grid-cols-[380px_minmax(0,1fr)]">
        {/* ---------- nova produção ---------- */}
        <aside className="min-w-0">
          <h1 className="mb-1 text-2xl font-bold">Produção</h1>
          <p className="mb-5 text-muted">Escolha a gravação bruta. O Claude escolhe os Shorts, edita, publica no YouTube e deixa TikTok e Instagram prontos para você postar. O vídeo longo espera a sua aprovação.</p>

          {faltando && (
            <div className="callout mb-4">
              <p>{faltando}</p>
              {(!status.claude.ok || !status.youtube.conectado) && <button className="btn sm" onClick={openConexoes}>Conexões</button>}
            </div>
          )}

          <Campo label="Gravação bruta">
            {brutos.length === 0 ? <p className="empty">Nenhuma gravação. Coloque o vídeo em D:\Videos ou envie na aba Editar.</p> : (
              <select value={fonte} onChange={(e) => { setFonte(e.target.value); setJogo(brutos.find((b) => b.url === e.target.value)?.jogo || ''); }}>
                {brutos.map((b) => <option key={b.url} value={b.url}>{b.rotulo}</option>)}
              </select>
            )}
          </Campo>
          {fonte && <video key={fonte} src={`${fonte}#t=5`} controls muted preload="metadata" className="mb-4 max-h-56 w-full rounded-card bg-black object-contain" />}

          <div className="grid2">
            <Campo label="Jogo">
              <input type="text" list="jogos-prod" value={jogo} onChange={(e) => setJogo(e.target.value)} />
              <datalist id="jogos-prod">{['Oxe, Meu Bar!', 'Ironhex', 'Minecraft', 'GTAV'].map((j) => <option key={j} value={j} />)}</datalist>
            </Campo>
            <Campo label="Shorts" value={`${quantidade} de 1:30–2:30`}>
              <input type="range" min={1} max={6} value={quantidade} onChange={(e) => setQuantidade(+e.target.value)} />
            </Campo>
          </div>

          <Campo label="Shorts no YouTube">
            <div className="seg">
              <button className={modo === 'programado' ? 'on' : ''} onClick={() => setModo('programado')}>Programar</button>
              <button className={modo === 'agora' ? 'on' : ''} onClick={() => setModo('agora')}>Publicar assim que ficar pronto</button>
            </div>
          </Campo>
          {modo === 'programado' && (
            <div className="grid2">
              <Campo label="Primeiro Short">
                <input type="datetime-local" value={primeiro} onChange={(e) => setPrimeiro(e.target.value)} />
              </Campo>
              <Campo label="Depois, um a cada">
                <select value={intervaloH} onChange={(e) => setIntervaloH(+e.target.value)}>
                  {[[6, '6 horas'], [12, '12 horas'], [24, '1 dia'], [48, '2 dias']].map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                </select>
              </Campo>
            </div>
          )}

          <label className="switch mb-3">
            <input type="checkbox" checked={longo} onChange={(e) => setLongo(e.target.checked)} />
            <span>Também editar o vídeo longo (16:9, 8 min ou mais, com capítulos) para aprovação</span>
          </label>

          <Campo label="Pedido para o Claude (opcional)">
            <input type="text" maxLength={300} value={orientacao} onChange={(e) => setOrientacao(e.target.value)} placeholder="Ex.: foca nas partes em que o prédio cai" />
          </Campo>

          <button className="btn primary w-full" disabled={!fonte || enviando || Boolean(faltando)} onClick={produzir}>
            <Play className="size-4" aria-hidden /> {enviando ? 'Começando…' : 'Produzir e publicar'}
          </button>
          <p className="hint mt-2">Leva um tempo: cada Short passa pelo Claude, FilmCraft e Remotion, um de cada vez. Pode fechar a aba; o servidor continua.</p>

          {lista.length > 0 && (
            <>
              <h2 className="mt-8 mb-2 text-sm font-semibold text-muted">Produções</h2>
              <ul className="prod-lista">
                {lista.map((p) => (
                  <li key={p.id}>
                    <button className={`prod-item ${p.id === selId ? 'on' : ''}`} onClick={() => setSelId(p.id)}>
                      <strong>{p.fonte.nome}</strong>
                      <span className="hint">{dataHora(p.criadoEm)} · {p.shorts.length} Shorts{p.longo ? ' + longo' : ''} · <span className={`prod-st prod-st-${p.status.replace(' ', '-')}`}>{p.status}</span></span>
                    </button>
                  </li>
                ))}
              </ul>
            </>
          )}
        </aside>

        {/* ---------- acompanhamento ---------- */}
        <section className="min-w-0">
          {!prod ? (
            <div className="empty mt-16 text-center">Nenhuma produção ainda. Escolha a gravação e clique em <strong>Produzir e publicar</strong>.</div>
          ) : (
            <>
              <div className="row-between mb-2 gap-3">
                <div className="min-w-0">
                  <h2 className="text-xl font-bold">{prod.fonte.nome}</h2>
                  <p className="hint">{rodando(prod) ? prod.etapa : prod.status === 'pronto' ? 'Tudo pronto.' : prod.erro || prod.etapa}</p>
                </div>
                <div className="flex shrink-0 gap-2">
                  {['erro', 'com erros', 'interrompido'].includes(prod.status) && (
                    <button className="btn sm" onClick={() => acao(() => api.retomarProducao(prod.id), 'Retomando')}><RefreshCw className="size-3.5" aria-hidden /> Retomar</button>
                  )}
                  {!rodando(prod) && (
                    <button className="btn sm ghost" title="Tira da lista (os cortes e publicações continuam)" onClick={() => acao(() => api.removerProducao(prod.id))}><Trash2 className="size-3.5" aria-hidden /></button>
                  )}
                </div>
              </div>
              {prod.resumo && <p className="callout entendeu mb-6"><strong>O Claude viu:</strong> {prod.resumo}</p>}

              {/* ---------- Shorts ---------- */}
              <h3 className="prod-secao"><Smartphone className="size-4" aria-hidden /> Shorts <span className="hint">YouTube automático · TikTok e Instagram para você postar</span></h3>
              {prod.shorts.length === 0 ? (
                <p className="hint mb-8">{rodando(prod) ? 'O Claude está assistindo à gravação e escolhendo os trechos…' : 'Nenhum Short.'}</p>
              ) : (
                <div className="prod-grid mb-10">
                  {prod.shorts.map((s) => <CardShort key={s.projeto} item={s} onAbrir={() => onAbrirCorte(s.projeto)} acao={acao} toast={toast} />)}
                </div>
              )}

              {/* ---------- Vídeo longo ---------- */}
              {(prod.longo || prod.config.longo) && (
                <>
                  <h3 className="prod-secao"><Film className="size-4" aria-hidden /> Vídeo longo <span className="hint">monetização: 16:9, 8 min+, capítulos · espera a sua aprovação</span></h3>
                  {prod.longo ? <CardLongo item={prod.longo} onAbrir={() => onAbrirCorte(prod.longo!.projeto)} onThumbnail={onThumbnail} acao={acao} /> : <p className="hint">Começa depois que os Shorts forem criados.</p>}
                </>
              )}
            </>
          )}
        </section>
      </div>
    </div>
  );
};

const Progresso: React.FC<{ item: ItemProducao }> = ({ item }) => {
  if (item.status === 'pronto') return null;
  if (item.status === 'erro') return <p className="hint err">{item.erro}</p>;
  const pct = Math.round((item.progresso || 0) * 100);
  return (
    <div className="edicao-prog">
      <div className="row-between"><span className="hint">{item.etapa || item.status}</span><span className="hint">{item.status === 'editando' ? `${pct}% · ${fmtEta(item.eta)}` : ''}</span></div>
      <div className="bar edicao-bar"><i style={{ transform: `scaleX(${item.status === 'publicando' ? 1 : item.progresso || 0})` }} /></div>
    </div>
  );
};

const CardShort: React.FC<{ item: ItemProducao; onAbrir: () => void; acao: (fn: () => Promise<unknown>, ok?: string) => void; toast: ToastFn }> = ({ item, onAbrir, acao, toast }) => {
  const yt = item.publicacoes?.youtube;
  return (
    <article className="prod-card">
      <div className="prod-video">
        {item.render ? <video src={item.render} controls preload="metadata" /> : item.miniatura ? <img src={item.miniatura} alt="" /> : <span />}
      </div>
      <div className="prod-corpo">
        <button className="link-btn text-left font-semibold" onClick={onAbrir} title="Abrir o corte no editor">{item.titulo}</button>
        {item.duracao ? <span className="hint">{mmss(item.duracao)}</span> : null}
        <Progresso item={item} />
        {item.publicacoes && (
          <ul className="prod-redes">
            <li>
              <Youtube className="size-4 text-yt" aria-hidden />
              <span>YouTube</span>
              {yt ? <EstadoYT pub={yt} /> : <span className="hint">—</span>}
              {yt?.status === 'erro' && <button className="btn xs" onClick={() => acao(() => api.pubAcao(yt.id, 'tentar'), 'Tentando de novo')}>Tentar de novo</button>}
            </li>
            {(['tiktok', 'instagram'] as const).map((r) => {
              const pub = item.publicacoes?.[r];
              if (!pub) return null;
              const postado = pub.status === 'postado';
              return (
                <li key={r}>
                  <span className={`size-2.5 rounded-full ${r === 'tiktok' ? 'bg-tt' : 'bg-ig'}`} aria-hidden />
                  <span>{r === 'tiktok' ? 'TikTok' : 'Instagram'}</span>
                  {postado ? <span className="selo-ok"><Check className="size-3" aria-hidden /> postado</span> : <span className="selo-pronto"><CheckCircle2 className="size-3" aria-hidden /> pronto para postar</span>}
                  {pub.meta.agendarEm && !postado && <span className="hint">{dataHora(pub.meta.agendarEm)}</span>}
                  <span className="ml-auto flex gap-1">
                    {!postado && pub.meta.legenda && (
                      <button className="btn xs ghost" title="Copiar legenda e hashtags" onClick={() => navigator.clipboard.writeText(pub.meta.legenda!).then(() => toast('Legenda copiada'))}><Copy className="size-3" aria-hidden /></button>
                    )}
                    {!postado && <a className="btn xs ghost" href={pub.arquivo} download title="Baixar o MP4"><Download className="size-3" aria-hidden /></a>}
                    <button className="btn xs" onClick={() => acao(() => api.pubAcao(pub.id, postado ? 'pendente' : 'postado'))}>{postado ? 'Desfazer' : 'Marcar postado'}</button>
                  </span>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </article>
  );
};

const EstadoYT: React.FC<{ pub: Publicacao }> = ({ pub }) => (
  <>
    <span className={`hint ${pub.status === 'erro' ? 'err' : pub.status === 'publicado' ? 'ok' : ''}`}>
      {pub.status === 'agendado' || (pub.meta.publicarEm && ['na fila', 'enviando', 'processando'].includes(pub.status))
        ? <><Clock className="inline size-3" aria-hidden /> {ROTULO_YT[pub.status] === 'programado' ? '' : `${ROTULO_YT[pub.status]} · `}programado para {dataHora(pub.meta.publicarEm!)}</>
        : ROTULO_YT[pub.status] || pub.status}
      {pub.status === 'erro' && pub.erro ? `: ${pub.erro}` : ''}
    </span>
    {pub.link && <a className="btn xs ghost" href={pub.link} target="_blank" rel="noreferrer" title="Abrir no YouTube"><ExternalLink className="size-3" aria-hidden /></a>}
  </>
);

const CardLongo: React.FC<{ item: ItemProducao; onAbrir: () => void; onThumbnail: () => void; acao: (fn: () => Promise<unknown>, ok?: string) => void }> = ({ item, onAbrir, onThumbnail, acao }) => {
  const pub = item.publicacoes?.youtube || null;
  const [titulo, setTitulo] = useState(pub?.meta.titulo || '');
  const [descricao, setDescricao] = useState(pub?.meta.descricao || '');
  const [quando, setQuando] = useState<'agora' | 'programar'>('programar');
  const [data, setData] = useState(proximas19h());
  useEffect(() => { if (pub) { setTitulo(pub.meta.titulo); setDescricao(pub.meta.descricao); } }, [pub?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  const aguardando = pub?.status === 'aguardando aprovação';
  return (
    <article className="prod-card prod-longo">
      <div className="prod-video wide">{item.render ? <video src={item.render} controls preload="metadata" /> : <span />}</div>
      <div className="prod-corpo">
        <button className="link-btn text-left font-semibold" onClick={onAbrir}>{pub?.meta.titulo || item.titulo}</button>
        {item.duracao ? <span className="hint">{mmss(item.duracao)}{item.duracao < 480 ? ' · menos de 8 min (sem anúncio no meio)' : ' · 8 min+ (libera anúncios no meio)'}</span> : null}
        <Progresso item={item} />
        {pub && !aguardando && <p className="mt-2 flex items-center gap-2"><Youtube className="size-4 text-yt" aria-hidden /><EstadoYT pub={pub} /></p>}
        {pub && aguardando && (
          <div className="mt-3 grid gap-3">
            <Campo label="Título" value={`${titulo.length}/100`}>
              <input type="text" maxLength={100} value={titulo} onChange={(e) => setTitulo(e.target.value)} />
            </Campo>
            {pub.meta.titulosAlternativos?.length ? (
              <div className="flex flex-wrap gap-1">{pub.meta.titulosAlternativos.map((t) => <button key={t} className="chip" onClick={() => setTitulo(t)}>{t}</button>)}</div>
            ) : null}
            <Campo label="Descrição (com capítulos)">
              <textarea rows={8} maxLength={5000} value={descricao} onChange={(e) => setDescricao(e.target.value)} />
            </Campo>
            <p className="hint">
              Thumbnail: {pub.thumbnail ? 'escolhida na aba Thumbnail.' : 'nenhuma ainda.'}{' '}
              <button className="link-btn" onClick={onThumbnail}>Criar na aba Thumbnail</button>
              {pub.meta.textoThumbnail ? ` (sugestão de texto: "${pub.meta.textoThumbnail}")` : ''}
            </p>
            <div className="seg">
              <button className={quando === 'programar' ? 'on' : ''} onClick={() => setQuando('programar')}>Programar</button>
              <button className={quando === 'agora' ? 'on' : ''} onClick={() => setQuando('agora')}>Publicar agora</button>
            </div>
            {quando === 'programar' && <input type="datetime-local" value={data} onChange={(e) => setData(e.target.value)} />}
            <button className="btn primary" onClick={() => acao(() => api.aprovarPublicacao(pub.id, { titulo, descricao, publicarEm: quando === 'agora' ? null : new Date(data).toISOString() }), 'Aprovado: indo para o YouTube')}>
              <Check className="size-4" aria-hidden /> Aprovar e {quando === 'agora' ? 'publicar' : 'programar'}
            </button>
          </div>
        )}
      </div>
    </article>
  );
};

function adivinharJogo(s: string) {
  const t = s.toLowerCase();
  if (t.includes('oxe')) return 'Oxe, Meu Bar!';
  if (t.includes('ironhex')) return 'Ironhex';
  if (t.includes('minecraft')) return 'Minecraft';
  if (t.includes('gta')) return 'GTAV';
  return '';
}
