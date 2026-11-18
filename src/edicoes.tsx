import { useEffect, useState } from 'react';
import { Check, ChevronDown, ChevronUp, CloudUpload, Wand2 } from 'lucide-react';
import { api, type EdicaoJob, type EnvioDrive } from './api';

/** "faltam ~2 min" / "faltam ~40 s" (estimativa pelo ritmo até agora) */
export const fmtEta = (s: number | null | undefined) => {
  if (s == null) return 'calculando o tempo…';
  if (s < 60) return `faltam ~${Math.max(5, Math.round(s / 5) * 5)} s`;
  const m = Math.round(s / 60);
  return `faltam ~${m} min`;
};

const ativa = (j: EdicaoJob) => j.status === 'na fila' || j.status === 'editando';

/** barra de progresso + as 4 fases (lendo fala, Claude, FilmCraft, finalização) */
export const ProgressoEdicao: React.FC<{ job: EdicaoJob; compacto?: boolean; posicaoFila?: number }> = ({ job, compacto, posicaoFila }) => {
  const pct = Math.round((job.progresso || 0) * 100);
  const idxAtual = job.fases.findIndex((f) => f.id === job.fase);
  return (
    <div className={`edicao-prog ${job.status === 'erro' ? 'bad' : ''}`}>
      <div className="row-between edicao-topo">
        <span className="edicao-pct">{job.status === 'pronto' ? 'Pronto' : job.status === 'erro' ? 'Falhou' : `${pct}%`}</span>
        <span className="hint">
          {job.status === 'na fila' ? (posicaoFila ? `na fila (${posicaoFila}º)` : 'na fila') : job.status === 'editando' ? fmtEta(job.eta) : ''}
        </span>
      </div>
      <div className="bar edicao-bar" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct} aria-label={`Edição de ${job.nome}`}>
        <i style={{ transform: `scaleX(${job.status === 'pronto' ? 1 : job.progresso || 0})` }} />
      </div>
      {!compacto && (
        <ol className="edicao-fases">
          {job.fases.map((f, i) => {
            const feito = job.status === 'pronto' || (idxAtual >= 0 && i < idxAtual);
            const agora = job.status === 'editando' && i === idxAtual;
            return (
              <li key={f.id} className={feito ? 'feito' : agora ? 'agora' : ''}>
                {feito ? <Check className="size-3" aria-hidden /> : <span className="ponto" aria-hidden />}
                {f.nome}
              </li>
            );
          })}
        </ol>
      )}
      {job.status === 'erro' ? (
        <span className="hint err">{job.erro}</span>
      ) : job.status === 'editando' && !compacto ? (
        <span className="hint">{job.etapa}</span>
      ) : null}
    </div>
  );
};

/** situação de um envio para o Drive: barra enquanto envia, link quando termina */
export const EstadoDrive: React.FC<{ envio: EnvioDrive }> = ({ envio }) =>
  envio.status === 'pronto' && envio.link ? (
    <a className="btn sm ghost" href={envio.link} target="_blank" rel="noreferrer"><CloudUpload className="size-3.5" aria-hidden /> Abrir no Drive</a>
  ) : envio.status === 'erro' ? (
    <span className="hint err">Drive: {envio.erro}</span>
  ) : (
    <div className="edicao-prog">
      <span className="hint">{envio.status === 'na fila' ? 'Drive: na fila' : `Enviando para o Drive ${Math.round(envio.progresso * 100)}%`}</span>
      <div className="bar edicao-bar"><i style={{ transform: `scaleX(${envio.progresso})` }} /></div>
    </div>
  );

/** botão "Enviar para o Drive" de um vídeo exportado, com progresso próprio */
export const BotaoDrive: React.FC<{ url: string; conectado: boolean; toast: (t: string, tone?: 'ok' | 'erro') => void }> = ({ url, conectado, toast }) => {
  const [envio, setEnvio] = useState<EnvioDrive | null>(null);
  // já enviado ou enviando (por exemplo, pelo envio automático)?
  useEffect(() => { api.driveEnvios().then((l) => setEnvio(l.find((e) => e.url === url) || null)).catch(() => {}); }, [url]);
  const ativo = envio && (envio.status === 'na fila' || envio.status === 'enviando');
  useEffect(() => {
    if (!ativo) return;
    const t = setInterval(async () => {
      const e = (await api.driveEnvios().catch(() => [])).find((x) => x.id === envio!.id);
      if (!e) return;
      setEnvio(e);
      if (e.status === 'pronto') toast('Vídeo no Google Drive');
      if (e.status === 'erro') toast(`Drive: ${e.erro}`, 'erro');
    }, 1500);
    return () => clearInterval(t);
  }, [ativo]); // eslint-disable-line react-hooks/exhaustive-deps
  if (envio && envio.status !== 'erro') return <EstadoDrive envio={envio} />;
  if (!conectado) return null;
  return (
    <button className="btn sm ghost" onClick={async () => {
      try { setEnvio(await api.driveEnviar(url)); } catch (e) { toast((e as Error).message, 'erro'); }
    }}>
      <CloudUpload className="size-3.5" aria-hidden /> {envio?.status === 'erro' ? 'Tentar Drive de novo' : 'Enviar para o Drive'}
    </button>
  );
};

/** painel flutuante com todas as edições em andamento e as que acabaram de terminar */
export const PainelEdicoes: React.FC<{ edicoes: EdicaoJob[]; onAbrir: (projetoId: string) => void }> = ({ edicoes, onAbrir }) => {
  const [aberto, setAberto] = useState(true);
  // mostra as ativas e as terminadas nos últimos 15 min
  const visiveis = edicoes.filter((j) => ativa(j) || (j.fim && Date.now() - j.fim < 15 * 60_000));
  if (!visiveis.length) return null;
  const ativas = visiveis.filter(ativa);
  const fila = ativas.filter((j) => j.status === 'na fila').sort((a, b) => a.criadoEm - b.criadoEm);
  const total = ativas.length ? ativas.reduce((a, j) => a + (j.progresso || 0), 0) / ativas.length : 1;
  return (
    <section className="painel-edicoes" aria-label="Edições automáticas">
      <button className="painel-edicoes-cab" onClick={() => setAberto(!aberto)} aria-expanded={aberto}>
        <Wand2 className="size-4" aria-hidden />
        <strong>{ativas.length ? `Editando ${ativas.length} corte${ativas.length > 1 ? 's' : ''}` : 'Edições prontas'}</strong>
        {ativas.length > 0 && <span className="hint">{Math.round(total * 100)}%</span>}
        {aberto ? <ChevronDown className="size-4" aria-hidden /> : <ChevronUp className="size-4" aria-hidden />}
      </button>
      {aberto && (
        <ul>
          {visiveis.map((j) => (
            <li key={j.id}>
              <button className="link-btn edicao-nome" onClick={() => onAbrir(j.projeto)} title="Abrir o corte">{j.nome}</button>
              <ProgressoEdicao job={j} compacto={j.status === 'na fila'} posicaoFila={fila.indexOf(j) + 1 || undefined} />
              {j.drive?.map((d) => <EstadoDrive key={d.id} envio={d} />)}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
};
