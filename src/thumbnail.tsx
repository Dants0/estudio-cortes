import { useEffect, useMemo, useState } from 'react';
import { Check, Download, ImageIcon, RefreshCw, Sparkles, Star } from 'lucide-react';
import { api, type BibItem, type MediaItem, type Project, type Status, type ThumbJob } from './api';
import { FORMATS, type FormatId } from '../remotion/types';
import { Campo } from './panels';

type Opcao = { url: string; rotulo: string; grupo: string; projeto?: string; jogo?: string; titulo?: string };

const quando = (ms: number) => new Date(ms).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
const formatoDe = (nome: string): FormatId | undefined =>
  /-9x16-/.test(nome) ? 'vertical' : /-16x9-/.test(nome) ? 'horizontal' : /-1x1-/.test(nome) ? 'square' : undefined;
const ativo = (j?: ThumbJob | null) => Boolean(j && j.status !== 'pronto' && j.status !== 'erro');

const PASSOS = ['o Claude está assistindo o vídeo', 'exportando os quadros escolhidos', 'desenhando no PhotoCraft', 'pronto'] as const;
const NOME_PASSO: Record<string, string> = {
  'o Claude está assistindo o vídeo': 'Claude escolhendo momentos e texto',
  'exportando os quadros escolhidos': 'Exportando os quadros',
  'desenhando no PhotoCraft': 'Desenhando no PhotoCraft',
  pronto: 'Pronto',
};

export const ThumbnailPage: React.FC<{
  projects: Project[]; renders: MediaItem[]; gravacoes: MediaItem[]; biblioteca: BibItem[]; status: Status;
  toast: (t: string, tone?: 'ok' | 'erro') => void; openConexoes: () => void;
  onUsar: (projeto: string, url: string) => Promise<void>;
}> = ({ projects, renders, gravacoes, biblioteca, status, toast, openConexoes, onUsar }) => {
  // tudo o que dá para virar thumbnail: exportações dos cortes, vídeos editados pelo Claude e gravações
  const opcoes = useMemo<Opcao[]>(() => {
    const porId = new Map(projects.map((p) => [p.id, p]));
    const out: Opcao[] = [];
    for (const r of [...renders].sort((a, b) => b.createdAt - a.createdAt)) {
      const p = r.projeto ? porId.get(r.projeto) : undefined;
      const f = formatoDe(r.name);
      out.push({
        url: r.url, grupo: 'Cortes exportados', projeto: p?.id, jogo: p?.meta?.jogo, titulo: p?.name,
        rotulo: `${p?.name || r.name} · ${f ? FORMATS[f].label : 'vídeo'} · ${quando(r.createdAt)}`,
      });
    }
    for (const p of projects) {
      const ed = (p.meta?.edicao as { arquivo?: string } | undefined)?.arquivo;
      if (ed && !out.some((o) => o.url === ed)) out.push({ url: ed, grupo: 'Editados pelo Claude (sem legenda)', projeto: p.id, jogo: p.meta?.jogo, titulo: p.name, rotulo: p.name });
    }
    for (const v of gravacoes) out.push({ url: v.url, grupo: 'Gravações enviadas', rotulo: v.name });
    for (const v of biblioteca.slice(0, 60)) out.push({ url: v.url, grupo: 'Pasta D:\\Videos', rotulo: `${v.name.replace(/\.[^.]+$/, '')} · ${v.pasta.split('/').slice(-2).join(' / ')}` });
    return out;
  }, [projects, renders, gravacoes, biblioteca]);

  const [fonte, setFonte] = useState('');
  useEffect(() => { if (!fonte && opcoes[0]) setFonte(opcoes[0].url); }, [opcoes, fonte]);
  const escolhida = opcoes.find((o) => o.url === fonte);

  const [titulo, setTitulo] = useState('');
  const [texto, setTexto] = useState('');
  const [pedido, setPedido] = useState('');
  const [quantidade, setQuantidade] = useState(3);
  const [job, setJob] = useState<ThumbJob | null>(null);
  const [recentes, setRecentes] = useState<ThumbJob[]>([]);
  const [enviando, setEnviando] = useState(false);

  useEffect(() => { setTitulo(escolhida?.titulo || ''); }, [fonte]); // eslint-disable-line react-hooks/exhaustive-deps
  const carregarRecentes = () => api.thumbsRecentes().then((l) => {
    setRecentes(l);
    setJob((atual) => atual || l.find(ativo) || l[0] || null);
  }).catch(() => {});
  useEffect(() => { carregarRecentes(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // acompanha o pedido em andamento
  useEffect(() => {
    if (!job || !ativo(job)) return;
    const t = setInterval(async () => {
      const j = await api.thumbJob(job.id).catch(() => null);
      if (!j) return;
      setJob(j);
      if (j.status === 'pronto') { toast('Thumbnails prontas'); carregarRecentes(); }
      if (j.status === 'erro') { toast(`Thumbnail: ${j.erro}`, 'erro'); carregarRecentes(); }
    }, 2500);
    return () => clearInterval(t);
  }, [job?.id, job?.status]); // eslint-disable-line react-hooks/exhaustive-deps

  const gerar = async (novo = false) => {
    if (!fonte) return;
    setEnviando(true);
    try {
      const j = await api.thumbAuto({
        fonte, projeto: escolhida?.projeto, jogo: escolhida?.jogo, quantidade, novo,
        titulo: titulo.trim() || undefined, texto: texto.trim() || undefined, pedido: pedido.trim() || undefined,
      });
      setJob(j);
      setRecentes((l) => [j, ...l.filter((x) => x.id !== j.id)]);
    } catch (e) {
      toast((e as Error).message, 'erro');
    } finally {
      setEnviando(false);
    }
  };

  const projetoDoJob = job?.projeto ? projects.find((p) => p.id === job.projeto) : undefined;
  const pronta = !status.photocraft || !status.claude.ok;
  const grupos = [...new Set(opcoes.map((o) => o.grupo))];
  const passoAtual = job ? PASSOS.indexOf(job.status as (typeof PASSOS)[number]) : -1;

  return (
    <div className="[grid-area:hoje] min-h-0 overflow-y-auto">
      <div className="mx-auto grid max-w-[1400px] gap-8 px-8 pt-7 pb-12 lg:grid-cols-[400px_minmax(0,1fr)]">
        {/* ---------- pedido ---------- */}
        <aside className="min-w-0">
          <h1 className="mb-1 text-2xl font-bold">Thumbnail</h1>
          <p className="mb-5 text-muted">Escolha o vídeo. O Claude assiste, escolhe os melhores momentos e o texto, e desenha as variações no PhotoCraft.</p>

          {status.photocraft && status.ponteReabrir && (
            <div className="callout mb-4">
              <p><strong>Reabra a ponte do Windows.</strong> Ela foi aberta antes da última mudança no <code>.env</code> (ou está com o código antigo) e ainda usa o token velho do Claude. Feche a janela da ponte e abra de novo <code>ponte\iniciar-ponte.bat</code>.</p>
            </div>
          )}
          {pronta && (
            <div className="callout mb-4">
              <p>{!status.claude.ok ? 'O Claude não está conectado.' : 'A ponte do Windows (PhotoCraft) está desligada. Abra ponte\\iniciar-ponte.bat.'}</p>
              {!status.claude.ok && <button className="btn sm" onClick={openConexoes}>Conexões</button>}
            </div>
          )}

          <Campo label="Vídeo">
            {opcoes.length === 0 ? (
              <p className="empty">Ainda não há vídeos. Exporte um corte ou envie uma gravação.</p>
            ) : (
              <select value={fonte} onChange={(e) => setFonte(e.target.value)}>
                {grupos.map((g) => (
                  <optgroup key={g} label={g}>
                    {opcoes.filter((o) => o.grupo === g).map((o) => <option key={o.url} value={o.url}>{o.rotulo}</option>)}
                  </optgroup>
                ))}
              </select>
            )}
          </Campo>
          {fonte && (
            <video key={fonte} src={`${fonte}#t=1`} controls muted preload="metadata" className="mb-4 max-h-64 w-full rounded-card bg-black object-contain" />
          )}

          <Campo label="Título do vídeo" hint="Vazio: o Claude sugere um.">
            <input type="text" value={titulo} maxLength={100} onChange={(e) => setTitulo(e.target.value)} placeholder="Ex.: Contratei meu primeiro pedreiro" />
          </Campo>
          <Campo label="Texto na thumbnail" hint="Até 3 palavras. Vazio: o Claude escolhe.">
            <input type="text" value={texto} maxLength={40} onChange={(e) => setTexto(e.target.value)} placeholder="Ex.: ELE CONSTRUIU?!" />
          </Campo>
          <Campo label="O que você quer (opcional)">
            <textarea rows={3} value={pedido} maxLength={600} onChange={(e) => setPedido(e.target.value)} placeholder="Ex.: seta vermelha no pedreiro, fundo escurecido, minha cara de surpresa" />
          </Campo>
          <Campo label="Variações" value={String(quantidade)}>
            <div className="seg">
              {[1, 2, 3].map((n) => <button key={n} className={quantidade === n ? 'on' : ''} onClick={() => setQuantidade(n)}>{n}</button>)}
            </div>
          </Campo>

          <button className="btn primary wide" disabled={!fonte || enviando || pronta || ativo(job)} onClick={() => gerar(false)}>
            <Sparkles className="size-4" aria-hidden /> {ativo(job) ? 'Gerando…' : 'Gerar thumbnails com o Claude'}
          </button>
          <p className="hint mt-2">Leva alguns minutos. A escolha de momentos fica guardada: pedir de novo o mesmo vídeo só redesenha.</p>
        </aside>

        {/* ---------- resultado ---------- */}
        <main className="min-w-0">
          {!job ? (
            <div className="grid h-64 place-items-center rounded-card border border-dashed border-line text-muted">
              <span className="flex items-center gap-2"><ImageIcon className="size-5" aria-hidden /> As thumbnails aparecem aqui.</span>
            </div>
          ) : (
            <section aria-live="polite">
              <div className="mb-3 flex flex-wrap items-baseline justify-between gap-3">
                <h2 className="text-lg font-semibold">{job.nome || 'Thumbnail'}</h2>
                {job.status === 'pronto' && job.fonte && (
                  <button className="link-btn" onClick={() => { setFonte(job.fonte!); gerar(true); }} title="Pede ao Claude outros momentos e outro texto (gasta tokens)">
                    <RefreshCw className="mr-1 inline size-3.5" aria-hidden />Outras ideias
                  </button>
                )}
              </div>

              {job.status !== 'erro' && (
                <ol className="edicao-fases mb-4">
                  {PASSOS.map((p, i) => (
                    <li key={p} className={job.status === 'pronto' || i < passoAtual ? 'feito' : i === passoAtual ? 'agora' : ''}>
                      {job.status === 'pronto' || i < passoAtual ? <Check className="size-3" aria-hidden /> : <span className="ponto" aria-hidden />}
                      {NOME_PASSO[p]}
                    </li>
                  ))}
                </ol>
              )}
              {job.status === 'erro' && <p className="warn">{job.erro}</p>}
              {job.status === 'desenhando no PhotoCraft' && job.etapas.length > 0 && (
                <p className="hint">PhotoCraft: {job.etapas.slice(-3).join(' → ')}</p>
              )}

              {job.plano && (
                <div className="mb-5 rounded-card border border-line bg-band p-4">
                  <p className="mb-1"><strong>Texto:</strong> {texto || job.plano.texto_thumbnail}{!titulo && job.plano.titulo_sugerido ? <> · <strong>Título sugerido:</strong> {job.plano.titulo_sugerido}</> : null}</p>
                  {job.plano.conceitos?.length > 0 && (
                    <ul className="list-disc pl-5 text-muted">
                      {job.plano.conceitos.map((c, i) => <li key={i}><strong className="text-text">{'ABC'[i]}:</strong> {c}</li>)}
                    </ul>
                  )}
                </div>
              )}

              {job.variacoes.length > 0 ? (
                <div className="grid gap-5 md:grid-cols-2 2xl:grid-cols-3">
                  {job.variacoes.map((v) => {
                    const usada = projetoDoJob?.meta?.thumbnail === v.url;
                    return (
                      <figure key={v.url} className={`overflow-hidden rounded-card border bg-band ${v.letra === job.recomendada ? 'border-hl' : 'border-line'}`}>
                        <a href={v.url} target="_blank" rel="noreferrer"><img src={v.url} alt={`Thumbnail ${v.letra}`} className="aspect-video w-full object-cover" /></a>
                        <figcaption className="grid gap-2 p-3">
                          <div className="flex items-center gap-2">
                            <strong>Variação {v.letra}</strong>
                            {v.letra === job.recomendada && <span className="flex items-center gap-1 text-sm text-hl"><Star className="size-3.5" aria-hidden /> recomendada</span>}
                          </div>
                          <span className="hint">{v.testa}</span>
                          <div className="row-gap">
                            <a className="btn sm" href={v.url} download={`thumbnail-${v.letra}.jpg`}><Download className="size-3.5" aria-hidden /> Baixar</a>
                            {job.projeto && (usada ? (
                              <span className="selo-publicar"><Check className="size-3.5" aria-hidden /> Vai na publicação</span>
                            ) : (
                              <button className="btn sm ghost" onClick={() => onUsar(job.projeto!, v.url).then(() => toast('Thumbnail escolhida para a publicação no YouTube'))}>Usar na publicação</button>
                            ))}
                          </div>
                        </figcaption>
                      </figure>
                    );
                  })}
                </div>
              ) : job.frames?.length ? (
                <>
                  <p className="hint mb-2">Quadros escolhidos pelo Claude:</p>
                  <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
                    {job.frames.map((f, i) => (
                      <figure key={f} className="overflow-hidden rounded-card border border-line">
                        <img src={f} alt={`Quadro ${i + 1}`} className="aspect-video w-full object-cover" />
                        {job.plano?.momentos[i] && <figcaption className="hint p-2">{job.plano.momentos[i].por_que}</figcaption>}
                      </figure>
                    ))}
                  </div>
                </>
              ) : null}
              {job.motivo && <p className="hint mt-4">{job.motivo}</p>}
              {job.conferir && job.conferir.length > 0 && (
                <ul className="mt-2 list-disc pl-5 text-sm text-muted">{job.conferir.map((c) => <li key={c}>{c}</li>)}</ul>
              )}
            </section>
          )}

          {recentes.length > 1 && (
            <section className="mt-10">
              <h2 className="hoje-sub">Pedidos recentes</h2>
              <ul className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
                {recentes.map((r) => (
                  <li key={r.id}>
                    <button className={`w-full overflow-hidden rounded-card border text-left ${r.id === job?.id ? 'border-hl' : 'border-line'} bg-band`} onClick={() => setJob(r)}>
                      {r.variacoes[0] ? <img src={r.variacoes[0].url} alt="" className="aspect-video w-full object-cover" /> : <div className="grid aspect-video place-items-center text-muted"><ImageIcon className="size-5" aria-hidden /></div>}
                      <span className="block truncate p-2 text-sm">{r.nome} · {r.status === 'pronto' ? `${r.variacoes.length} variações` : r.status}</span>
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </main>
      </div>
    </div>
  );
};
