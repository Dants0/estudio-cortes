import React, { useEffect, useMemo, useState } from 'react';
import { ArrowUpRight, Clapperboard, RefreshCw, Scissors } from 'lucide-react';
import { api, Hoje, IdeiaHoje, MediaItem, Status } from './api';

type ToastFn = (t: string, tone?: 'ok' | 'erro') => void;
type Rede = 'youtube' | 'tiktok' | 'instagram';

const REDES: { id: Rede; nome: string; cor: string; fundo: string }[] = [
  { id: 'youtube', nome: 'YouTube', cor: 'bg-yt', fundo: 'bg-yt/15' },
  { id: 'tiktok', nome: 'TikTok', cor: 'bg-tt', fundo: 'bg-tt/12' },
  { id: 'instagram', nome: 'Instagram', cor: 'bg-ig', fundo: 'bg-ig/14' },
];
const STATUS: Record<string, string> = {
  agendado: 'agendado', 'na fila': 'na fila', enviando: 'enviando', processando: 'processando', enviado: 'enviado',
  publicado: 'no ar', 'no rascunho': 'nos rascunhos', erro: 'falhou', 'para postar': 'para postar', postado: 'postado', 'aguardando aprovação': 'aguardando aprovação',
};

const redeDe = (s: string): Rede | null => {
  const t = s.toLowerCase();
  if (t.includes('tiktok')) return 'tiktok';
  if (t.includes('insta') || t.includes('reels')) return 'instagram';
  if (t.includes('youtube') || t.includes('shorts')) return 'youtube';
  return null;
};
const chaveDia = (d: Date) => d.toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' });
const hora = (iso: string) => new Date(iso).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', timeZone: 'America/Sao_Paulo' });

type Slot = { quando: string; texto: string; tipo: 'real' | 'sugestao'; status?: string; projeto?: string; obs?: string };

export const HojePage: React.FC<{
  status: Status;
  toast: ToastFn;
  onUsarIdeia: (i: IdeiaHoje) => void;
  onSugerirCortes: (v: MediaItem & { pasta?: string }) => void;
  onAbrirCorte: (id: string) => void;
  openConexoes: () => void;
}> = ({ status, toast, onUsarIdeia, onSugerirCortes, onAbrirCorte, openConexoes }) => {
  const [dados, setDados] = useState<Hoje | null>(null);
  const [foco, setFoco] = useState('');
  const [carregando, setCarregando] = useState(true);
  const [resumoAberto, setResumoAberto] = useState(false);

  const carregar = () => api.hoje().then(setDados).catch((e) => toast(e.message, 'erro')).finally(() => setCarregando(false));
  useEffect(() => { carregar(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const gerando = Boolean(dados?.gerando);
  useEffect(() => {
    if (!gerando) return;
    const t = setInterval(async () => {
      const d = await api.hoje().catch(() => null);
      if (!d) return;
      setDados(d);
      if (!d.gerando) toast(d.erro ? `Não deu para montar o plano: ${d.erro}` : 'Plano do dia pronto', d.erro ? 'erro' : 'ok');
    }, 4000);
    return () => clearInterval(t);
  }, [gerando]); // eslint-disable-line react-hooks/exhaustive-deps

  const gerar = async () => {
    try {
      await api.gerarHoje(foco.trim() || undefined);
      setDados((d) => (d ? { ...d, gerando: { etapa: 'juntando os dados do canal', inicio: Date.now() }, erro: null } : d));
    } catch (e) {
      toast((e as Error).message, 'erro');
    }
  };

  // os 7 dias da grade, a partir de hoje
  const dias = useMemo(() => Array.from({ length: 7 }, (_, i) => {
    const d = new Date(Date.now() + i * 86400_000);
    return {
      chave: chaveDia(d),
      semana: d.toLocaleDateString('pt-BR', { weekday: 'short', timeZone: 'America/Sao_Paulo' }).replace('.', ''),
      dia: d.toLocaleDateString('pt-BR', { day: '2-digit', timeZone: 'America/Sao_Paulo' }),
      hoje: i === 0,
    };
  }), [dados?.situacao.hoje]);

  // a grade: o que já está marcado de verdade + o que o Claude sugeriu, por rede e por dia
  const grade = useMemo(() => {
    const g = new Map<string, Slot[]>();
    const por = (rede: Rede, quando: string, s: Slot) => {
      const k = `${rede}|${chaveDia(new Date(quando))}`;
      g.set(k, [...(g.get(k) || []), s]);
    };
    if (!dados) return g;
    for (const p of dados.situacao.publicacoes) {
      if (!p.quando) continue;
      por(p.plataforma, p.quando, { quando: p.quando, texto: p.titulo, tipo: 'real', status: p.status, projeto: p.projeto });
    }
    for (const a of dados.sugestoes?.agenda || []) {
      const r = redeDe(a.plataforma);
      if (r && !Number.isNaN(new Date(a.quando).getTime())) por(r, a.quando, { quando: a.quando, texto: a.o_que, tipo: 'sugestao', obs: a.observacao });
    }
    for (const [k, v] of g) g.set(k, v.sort((a, b) => +new Date(a.quando) - +new Date(b.quando)));
    return g;
  }, [dados]);

  if (carregando) return <div className="[grid-area:hoje] p-8 text-muted">Carregando o dia…</div>;
  if (!dados) return <div className="[grid-area:hoje] p-8 text-muted">Não deu para carregar.</div>;
  const s = dados.sugestoes;
  const sit = dados.situacao;
  const ideias = s?.ideias || [];
  const principal = ideias.find((i) => i.esforco === 'rápido') || ideias[0];
  const outras = ideias.filter((i) => i !== principal);

  return (
    <div className="[grid-area:hoje] min-h-0 overflow-y-auto">
      <div className="mx-auto grid max-w-[1560px] gap-8 px-8 pt-7 pb-12 xl:grid-cols-[minmax(0,1fr)_340px]">
        <main className="min-w-0">
          {/* cabeçalho do dia */}
          <header className="mb-5 flex flex-wrap items-end justify-between gap-4">
            <div>
              <h1 className="text-[34px] font-extrabold leading-none tracking-tight">Hoje</h1>
              <p className="mt-1.5 text-muted first-letter:uppercase">
                {sit.diaSemana}, {new Date(`${sit.hoje}T12:00:00`).toLocaleDateString('pt-BR', { day: '2-digit', month: 'long' })}
                {s && <span className="normal-case text-faint"> · plano das {new Date(s.geradoEm).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}</span>}
              </p>
            </div>
            {status.claude.ok ? (
              <div className="flex w-full max-w-[560px] gap-2">
                <input type="text" maxLength={500} value={foco} placeholder="Foco de hoje (opcional), ex.: só Oxe Meu Bar" onChange={(e) => setFoco(e.target.value)} aria-label="Foco de hoje" />
                <button className="btn primary shrink-0" disabled={gerando} onClick={gerar}>
                  <RefreshCw className={`size-4 ${gerando ? 'animate-spin' : ''}`} aria-hidden />
                  {gerando ? 'Pesquisando…' : s ? 'Refazer o plano' : 'Montar o plano do dia'}
                </button>
              </div>
            ) : (
              <button className="btn" onClick={openConexoes}>Conectar o Claude</button>
            )}
          </header>

          {gerando && (
            <p className="mb-5 rounded-card border border-line bg-band/60 px-4 py-3 text-muted">
              <strong className="text-text">{dados.gerando!.etapa[0].toUpperCase() + dados.gerando!.etapa.slice(1)}…</strong> O Claude busca o que está em alta, olha os números do canal e o cronograma. Leva de 1 a 4 minutos.
            </p>
          )}
          {dados.erro && !gerando && <p className="warn">{dados.erro}</p>}

          {/* a ideia do dia: a faixa amarela da revista */}
          {principal ? (
            <section className="mb-7 grid items-center gap-5 rounded-card bg-hl px-6 py-5 text-hl-ink md:grid-cols-[1fr_auto]" aria-label="Ideia para gravar hoje">
              <div className="min-w-0">
                <h2 className="text-[24px] font-extrabold leading-tight tracking-tight">{principal.titulo}</h2>
                <p className="mt-1.5 max-w-[75ch] text-[15px] font-medium">“{principal.gancho}”</p>
                <p className="mt-2 line-clamp-3 max-w-[75ch] text-[13.5px] opacity-80" title={principal.o_que_gravar}>{principal.o_que_gravar}</p>
                <div className="mt-3 flex flex-wrap gap-1.5 text-[12px] font-bold">
                  {[principal.jogo, principal.formato === 'short' ? 'Short' : 'Vídeo longo', principal.esforco, principal.melhor_horario].filter(Boolean).map((t) => (
                    <span key={t} className="rounded-full bg-hl-ink/10 px-2.5 py-0.5">{t}</span>
                  ))}
                </div>
              </div>
              <button className="btn border-hl-ink bg-hl-ink text-hl hover:bg-black" onClick={() => onUsarIdeia(principal)}>
                <Clapperboard className="size-4" aria-hidden /> Criar roteiro
              </button>
            </section>
          ) : !gerando && (
            <section className="mb-7 rounded-card border border-dashed border-line px-6 py-5">
              <h2 className="text-[18px] font-bold">Ainda não há plano para hoje</h2>
              <p className="mt-1 max-w-[70ch] text-muted">O Claude junta o que está em alta na web e no YouTube Brasil, os números dos seus últimos vídeos, o cronograma do Pipeline e o que está parado, e diz o que gravar.</p>
            </section>
          )}

          {/* a grade de programação da semana */}
          <section aria-label="Programação da semana">
            <div className="mb-2.5 flex items-baseline justify-between">
              <h2 className="text-[17px] font-bold">Programação da semana</h2>
              <span className="flex items-center gap-3 text-[12px] text-faint">
                <span className="flex items-center gap-1.5"><span className="inline-block h-3 w-5 rounded bg-raise" />marcado</span>
                <span className="flex items-center gap-1.5"><span className="inline-block h-3 w-5 rounded border border-dashed border-faint" />sugestão do Claude</span>
              </span>
            </div>
            <div className="overflow-x-auto rounded-card border border-line">
              <table className="w-full min-w-[920px] table-fixed border-collapse">
                <colgroup><col className="w-[118px]" />{dias.map((d) => <col key={d.chave} />)}</colgroup>
                <thead>
                  <tr className="bg-band">
                    <th className="border-b border-line" />
                    {dias.map((d) => (
                      <th key={d.chave} scope="col" className={`border-b border-l border-line px-2.5 py-2 text-left text-[12.5px] font-bold ${d.hoje ? 'bg-hl text-hl-ink' : 'text-muted'}`}>
                        <span className="capitalize">{d.semana}</span> <span className="tabular">{d.dia}</span>
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {REDES.map((r) => (
                    <tr key={r.id}>
                      <th scope="row" className="border-b border-line bg-band px-3 py-2 text-left align-top text-[13px] font-bold">
                        <span className="flex items-center gap-2"><span className={`size-2.5 rounded-[3px] ${r.cor}`} />{r.nome}</span>
                      </th>
                      {dias.map((d) => {
                        const slots = grade.get(`${r.id}|${d.chave}`) || [];
                        return (
                          <td key={d.chave} className={`h-[104px] border-b border-l border-line p-1.5 align-top ${d.hoje ? 'bg-hl/[0.04]' : ''}`}>
                            <div className="grid gap-1.5">
                              {slots.slice(0, 3).map((sl, n) => {
                                const conteudo = (
                                  <>
                                    <span className="flex items-center gap-1.5 text-[11px] font-bold tabular text-muted">
                                      <span className={`size-1.5 rounded-full ${r.cor}`} />{hora(sl.quando)}
                                    </span>
                                    <span className="line-clamp-2 text-[12px] leading-snug">{sl.texto}</span>
                                    {sl.tipo === 'real' && sl.status && (
                                      <span className={`text-[10.5px] font-semibold ${sl.status === 'erro' ? 'text-bad' : 'text-faint'}`}>{STATUS[sl.status] || sl.status}</span>
                                    )}
                                  </>
                                );
                                const base = `grid w-full gap-0.5 rounded-lg px-2 py-1.5 text-left ${sl.tipo === 'real' ? `${r.fundo}` : 'border border-dashed border-line text-muted'}`;
                                return sl.tipo === 'real' && sl.projeto ? (
                                  <button key={n} className={`${base} transition-colors hover:brightness-125`} title={sl.texto} onClick={() => onAbrirCorte(sl.projeto!)}>{conteudo}</button>
                                ) : (
                                  <div key={n} className={base} title={sl.obs ? `${sl.texto} · ${sl.obs}` : sl.texto}>{conteudo}</div>
                                );
                              })}
                              {slots.length > 3 && <span className="px-1 text-[11px] text-faint">+{slots.length - 3}</span>}
                            </div>
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          {/* outras ideias */}
          {outras.length > 0 && (
            <section className="mt-8">
              <h2 className="mb-2 text-[17px] font-bold">Outras ideias para gravar</h2>
              <ul className="divide-y divide-line border-y border-line">
                {outras.map((i, n) => (
                  <li key={n} className="grid items-start gap-x-6 gap-y-1 py-4 md:grid-cols-[minmax(0,1fr)_auto]">
                    <div className="min-w-0">
                      <h3 className="text-[15.5px] font-bold">{i.titulo}</h3>
                      <p className="mt-0.5 text-hl">“{i.gancho}”</p>
                      <p className="mt-1 max-w-[80ch] text-[13px] text-muted">{i.por_que}</p>
                      <div className="mt-2 flex flex-wrap gap-1.5">
                        {[i.jogo, i.formato === 'short' ? 'Short' : 'Vídeo longo', i.esforco, i.melhor_horario].filter(Boolean).map((t) => <span key={t} className="tag">{t}</span>)}
                      </div>
                    </div>
                    <button className="btn sm self-center" onClick={() => onUsarIdeia(i)}>Criar roteiro</button>
                  </li>
                ))}
              </ul>
            </section>
          )}

          {/* tendências */}
          {s && s.tendencias.length > 0 && (
            <section className="mt-8">
              <h2 className="mb-2 text-[17px] font-bold">Em alta agora</h2>
              <ul className="grid gap-x-8 md:grid-cols-2">
                {s.tendencias.map((t, n) => (
                  <li key={n} className="border-t border-line py-3">
                    <p className="font-semibold">{t.tema}</p>
                    <p className="mt-0.5 text-[13px] text-muted">{t.por_que_importa}</p>
                    {t.link ? (
                      <a className="mt-1 inline-flex items-center gap-1 text-[12px] font-semibold text-hl hover:underline underline-offset-4" href={t.link} target="_blank" rel="noreferrer">
                        {t.fonte || 'fonte'}<ArrowUpRight className="size-3.5" aria-hidden />
                      </a>
                    ) : t.fonte ? <p className="mt-1 text-[12px] text-faint">{t.fonte}</p> : null}
                  </li>
                ))}
              </ul>
            </section>
          )}
        </main>

        <aside className="grid content-start gap-6 xl:sticky xl:top-0">
          <section>
            <h2 className="hoje-sub">Esperando você</h2>
            <ul className="divide-y divide-line-soft">
              {(sit.brutos || []).slice(0, 6).map((b) => (
                <li key={b.url} className="flex items-center justify-between gap-3 py-2.5">
                  <span className="min-w-0">
                    <span className="block truncate text-[13px] font-semibold">{b.arquivo.replace(/^Videos Brutos\//, '')}</span>
                    <span className="text-[11.5px] text-faint">gravação bruta · {b.tamanhoMB} MB</span>
                  </span>
                  <button className="btn sm shrink-0" disabled={!status.claude.ok} onClick={() => onSugerirCortes({ name: b.arquivo.split('/').pop() || b.arquivo, pasta: b.arquivo.split('/').slice(0, -1).join('/'), url: b.url, kind: 'video', size: b.tamanhoMB * 1e6, createdAt: 0 })}>
                    <Scissors className="size-3.5" aria-hidden /> Sugerir cortes
                  </button>
                </li>
              ))}
              {sit.cortesSemPublicar.slice(0, 6).map((c) => (
                <li key={c.id} className="flex items-center justify-between gap-3 py-2.5">
                  <span className="min-w-0">
                    <span className="block truncate text-[13px] font-semibold">{c.nome}</span>
                    <span className="text-[11.5px] text-faint">corte sem publicar</span>
                  </span>
                  <button className="btn sm ghost shrink-0" onClick={() => onAbrirCorte(c.id)}>Abrir</button>
                </li>
              ))}
            </ul>
            {!sit.brutos?.length && !sit.cortesSemPublicar.length && <p className="empty">Nada parado.</p>}
            {s?.pendencias?.length ? (
              <details className="mt-3 text-[12.5px] text-muted">
                <summary className="cursor-pointer font-semibold text-text marker:text-faint">{s.pendencias.length} observações do Claude</summary>
                <ul className="mt-2 grid gap-2">
                  {s.pendencias.map((p, n) => <li key={n} className="leading-snug">{p}</li>)}
                </ul>
              </details>
            ) : null}
          </section>

          {s?.resumo && (
            <section>
              <h2 className="hoje-sub">Leitura do Claude</h2>
              <p className={`text-[13px] leading-relaxed text-muted ${resumoAberto ? '' : 'line-clamp-6'}`}>{s.resumo}</p>
              {s.resumo.length > 300 && <button className="link-btn mt-1 text-[12.5px]" onClick={() => setResumoAberto(!resumoAberto)}>{resumoAberto ? 'Ver menos' : 'Ver tudo'}</button>}
            </section>
          )}

          {sit.meuCanal && (
            <section>
              <h2 className="hoje-sub">Seu canal no YouTube</h2>
              {sit.meuCanal.inscritos !== null && (
                <p className="mb-2 text-[28px] font-extrabold tabular leading-none">{sit.meuCanal.inscritos.toLocaleString('pt-BR')} <span className="text-[13px] font-medium text-muted">inscritos</span></p>
              )}
              <table className="w-full text-[12.5px]">
                <tbody>
                  {sit.meuCanal.videos.slice(0, 8).map((v, n) => (
                    <tr key={n} className="border-t border-line-soft">
                      <td className="max-w-0 truncate py-1.5 pr-3">{v.titulo}</td>
                      <td className="py-1.5 text-right tabular text-muted">{v.views.toLocaleString('pt-BR')}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
          )}
        </aside>
      </div>
    </div>
  );
};
