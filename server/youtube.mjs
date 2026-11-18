// Publicação no YouTube (porte do publisher do Pipeline, em Node, sem dependências).
// OAuth de "app instalado" com PKCE + upload retomável em blocos de 16 MB.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import crypto from 'node:crypto';

const SCOPES = ['https://www.googleapis.com/auth/youtube.upload', 'https://www.googleapis.com/auth/youtube'];
const CHUNK = 16 * 1024 * 1024; // múltiplo de 256 KB
const API = 'https://www.googleapis.com/youtube/v3';
const UPLOAD = 'https://www.googleapis.com/upload/youtube/v3';

const fail = (statusCode, message) => Object.assign(new Error(message), { statusCode });

export function createYouTube({ clientSecretPath, tokenPath, redirectUri, log }) {
  const pending = new Map(); // state -> { verifier, createdAt }

  const client = () => {
    if (!fs.existsSync(clientSecretPath)) return null;
    const j = JSON.parse(fs.readFileSync(clientSecretPath, 'utf8'));
    const c = j.installed || j.web;
    return c ? { id: c.client_id, secret: c.client_secret } : null;
  };
  const readToken = () => {
    try { return JSON.parse(fs.readFileSync(tokenPath, 'utf8')); } catch { return null; }
  };
  const writeToken = (t) => fsp.writeFile(tokenPath, JSON.stringify(t, null, 2), { mode: 0o600 });

  const tokenRequest = async (params) => {
    const c = client();
    const r = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: c.id, client_secret: c.secret, ...params }),
    });
    const j = await r.json();
    if (!r.ok) throw fail(401, `O Google recusou o login (${j.error}: ${j.error_description || ''}). Conecte o YouTube de novo.`);
    return j;
  };

  const accessToken = async () => {
    const t = readToken();
    if (!t?.refresh_token) throw fail(401, 'Conecte o YouTube antes de publicar.');
    if (t.access_token && t.expires_at > Date.now() + 60_000) return t.access_token;
    const j = await tokenRequest({ grant_type: 'refresh_token', refresh_token: t.refresh_token });
    const next = { ...t, access_token: j.access_token, expires_at: Date.now() + j.expires_in * 1000 };
    await writeToken(next);
    return next.access_token;
  };

  const explain = (status, body) => {
    const reason = body?.error?.errors?.[0]?.reason || body?.error?.status || '';
    const msg = body?.error?.message || '';
    if (reason === 'quotaExceeded' || reason === 'uploadLimitExceeded') {
      return fail(429, 'A cota diária da API do YouTube acabou. Ela renova à meia-noite do horário do Pacífico (por volta das 4h–5h em Brasília).');
    }
    if (status === 401) return fail(401, 'O login do YouTube expirou. Conecte de novo.');
    return fail(status >= 500 ? 502 : status, `YouTube recusou (${status} ${reason}): ${msg.slice(0, 300)}`);
  };

  const api = async (method, url, { json, body, headers = {} } = {}) => {
    const r = await fetch(url, {
      method,
      headers: { Authorization: `Bearer ${await accessToken()}`, ...(json ? { 'Content-Type': 'application/json; charset=UTF-8' } : {}), ...headers },
      body: json ? JSON.stringify(json) : body,
    });
    const text = await r.text();
    const data = text ? JSON.parse(text) : {};
    if (!r.ok) throw explain(r.status, data);
    return data;
  };

  return {
    configured: () => Boolean(client()),

    async status() {
      if (!client()) return { configurado: false, conectado: false };
      const t = readToken();
      return { configurado: true, conectado: Boolean(t?.refresh_token), canal: t?.canal || null };
    },

    authUrl() {
      const c = client();
      if (!c) throw fail(400, 'Falta o client_secret.json do Google (o mesmo do Pipeline). Veja o README.');
      const state = crypto.randomBytes(16).toString('hex');
      const verifier = crypto.randomBytes(48).toString('base64url');
      const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
      for (const [k, v] of pending) if (Date.now() - v.createdAt > 15 * 60_000) pending.delete(k);
      pending.set(state, { verifier, createdAt: Date.now() });
      const q = new URLSearchParams({
        client_id: c.id,
        redirect_uri: redirectUri,
        response_type: 'code',
        scope: SCOPES.join(' '),
        access_type: 'offline',
        prompt: 'consent',
        state,
        code_challenge: challenge,
        code_challenge_method: 'S256',
      });
      return `https://accounts.google.com/o/oauth2/v2/auth?${q}`;
    },

    isCallback: (state) => pending.has(state),

    async finishLogin(code, state) {
      const p = pending.get(state);
      pending.delete(state);
      if (!p) throw fail(400, 'Login do YouTube expirado. Tente de novo.');
      const j = await tokenRequest({ grant_type: 'authorization_code', code, redirect_uri: redirectUri, code_verifier: p.verifier });
      if (!j.refresh_token) throw fail(400, 'O Google não devolveu o refresh token. Remova o acesso do app na sua conta Google e conecte de novo.');
      await writeToken({ refresh_token: j.refresh_token, access_token: j.access_token, expires_at: Date.now() + j.expires_in * 1000 });
      const ch = await api('GET', `${API}/channels?part=snippet&mine=true`);
      const canal = ch.items?.[0] ? { id: ch.items[0].id, nome: ch.items[0].snippet.title } : null;
      await writeToken({ ...readToken(), canal });
      return canal;
    },

    async logout() {
      const t = readToken();
      if (t?.refresh_token) {
        await fetch(`https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(t.refresh_token)}`, { method: 'POST' }).catch(() => {});
      }
      await fsp.rm(tokenPath, { force: true });
    },

    async playlists() {
      const j = await api('GET', `${API}/playlists?part=snippet&mine=true&maxResults=50`);
      return (j.items || []).map((p) => ({ id: p.id, nome: p.snippet.title }));
    },

    /**
     * Envia um vídeo. `pub` é o registro da publicação; `save(pub)` persiste o progresso
     * (inclusive a URL de sessão, para retomar depois de uma queda).
     */
    async upload(pub, filePath, save) {
      const size = (await fsp.stat(filePath)).size;
      const meta = pub.meta;
      if (!pub.sessionUrl) {
        const status = {
          privacyStatus: meta.publicarEm ? 'private' : meta.privacidade,
          selfDeclaredMadeForKids: Boolean(meta.paraCriancas),
          containsSyntheticMedia: Boolean(meta.conteudoSintetico),
        };
        if (meta.publicarEm) status.publishAt = new Date(meta.publicarEm).toISOString();
        const r = await fetch(`${UPLOAD}/videos?uploadType=resumable&part=snippet,status&notifySubscribers=${meta.notificar !== false}`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${await accessToken()}`,
            'Content-Type': 'application/json; charset=UTF-8',
            'X-Upload-Content-Length': String(size),
            'X-Upload-Content-Type': 'video/mp4',
          },
          body: JSON.stringify({
            snippet: {
              title: meta.titulo,
              description: meta.descricao,
              tags: meta.tags.slice(0, 30),
              categoryId: meta.categoria || '20',
              defaultLanguage: 'pt-BR',
              defaultAudioLanguage: 'pt-BR',
            },
            status,
          }),
        });
        if (!r.ok) throw explain(r.status, await r.json().catch(() => ({})));
        pub.sessionUrl = r.headers.get('location');
        pub.enviado = 0;
        await save(pub);
      }

      // descobre quanto o YouTube já recebeu (retomada)
      const probe = async () => {
        const r = await fetch(pub.sessionUrl, {
          method: 'PUT',
          headers: { Authorization: `Bearer ${await accessToken()}`, 'Content-Range': `bytes */${size}` },
        });
        if (r.status === 200 || r.status === 201) return { done: await r.json() };
        if (r.status === 308) {
          const range = r.headers.get('range');
          return { offset: range ? Number(range.split('-')[1]) + 1 : 0 };
        }
        if (r.status === 404 || r.status === 410) {
          pub.sessionUrl = null;
          await save(pub);
          throw fail(409, 'A sessão de envio expirou. Tente de novo para recomeçar do zero.');
        }
        throw explain(r.status, await r.json().catch(() => ({})));
      };

      let { offset = 0, done } = await probe();
      const fh = await fsp.open(filePath, 'r');
      try {
        let tries = 0;
        while (!done) {
          const len = Math.min(CHUNK, size - offset);
          const buf = Buffer.alloc(len);
          await fh.read(buf, 0, len, offset);
          try {
            const r = await fetch(pub.sessionUrl, {
              method: 'PUT',
              headers: {
                Authorization: `Bearer ${await accessToken()}`,
                'Content-Length': String(len),
                'Content-Range': `bytes ${offset}-${offset + len - 1}/${size}`,
              },
              body: buf,
            });
            if (r.status === 308) {
              const range = r.headers.get('range');
              offset = range ? Number(range.split('-')[1]) + 1 : 0;
            } else if (r.ok) {
              done = await r.json();
              offset = size;
            } else if (r.status >= 500) {
              throw Object.assign(new Error(`HTTP ${r.status}`), { retry: true });
            } else {
              throw explain(r.status, await r.json().catch(() => ({})));
            }
            tries = 0;
            pub.enviado = offset / size;
            await save(pub);
          } catch (e) {
            if (e.statusCode && !e.retry) throw e;
            if (++tries > 6) throw fail(502, `O envio caiu várias vezes seguidas (${e.message}). Tente de novo: ele continua de onde parou.`);
            log?.warn({ err: e.message, tries }, 'bloco falhou; tentando de novo');
            await new Promise((res) => setTimeout(res, Math.min(60_000, 2 ** tries * 1000)));
            ({ offset = 0, done } = await probe());
          }
        }
      } finally {
        await fh.close();
      }
      return done; // recurso do vídeo (tem .id)
    },

    async setThumbnail(videoId, imagePath) {
      const buf = await fsp.readFile(imagePath);
      if (buf.length > 2 * 1024 * 1024) throw fail(400, 'A thumbnail passa de 2 MB; o YouTube não aceita.');
      const type = /\.png$/i.test(imagePath) ? 'image/png' : 'image/jpeg';
      return api('POST', `${UPLOAD}/thumbnails/set?videoId=${encodeURIComponent(videoId)}`, { body: buf, headers: { 'Content-Type': type } });
    },

    async addToPlaylist(videoId, playlistId) {
      return api('POST', `${API}/playlistItems?part=snippet`, {
        json: { snippet: { playlistId, resourceId: { kind: 'youtube#video', videoId } } },
      });
    },

    /** Vídeos em alta no Brasil (por padrão, categoria Jogos). Custa 1 unidade da cota. */
    async emAlta({ regiao = 'BR', categoria = '20', max = 25 } = {}) {
      const j = await api('GET', `${API}/videos?part=snippet,statistics,contentDetails&chart=mostPopular&regionCode=${regiao}&videoCategoryId=${categoria}&maxResults=${max}`);
      return (j.items || []).map((v) => ({
        titulo: v.snippet.title, canal: v.snippet.channelTitle, publicadoEm: v.snippet.publishedAt,
        views: Number(v.statistics?.viewCount || 0), duracao: v.contentDetails?.duration, tags: (v.snippet.tags || []).slice(0, 8),
      }));
    },

    /** Últimos envios do seu canal com números (2 unidades da cota). */
    async meusVideos(max = 20) {
      const ch = await api('GET', `${API}/channels?part=contentDetails,statistics&mine=true`);
      const c = ch.items?.[0];
      if (!c) return { inscritos: null, videos: [] };
      const pl = await api('GET', `${API}/playlistItems?part=contentDetails&maxResults=${max}&playlistId=${c.contentDetails.relatedPlaylists.uploads}`);
      const ids = (pl.items || []).map((i) => i.contentDetails.videoId);
      if (!ids.length) return { inscritos: Number(c.statistics.subscriberCount || 0), videos: [] };
      const vs = await api('GET', `${API}/videos?part=snippet,statistics,contentDetails,status&id=${ids.join(',')}`);
      return {
        inscritos: Number(c.statistics.subscriberCount || 0),
        videos: (vs.items || []).map((v) => ({
          titulo: v.snippet.title, publicadoEm: v.status.publishAt || v.snippet.publishedAt, privacidade: v.status.privacyStatus,
          duracao: v.contentDetails.duration, views: Number(v.statistics.viewCount || 0),
          likes: Number(v.statistics.likeCount || 0), comentarios: Number(v.statistics.commentCount || 0),
        })),
      };
    },

    /** Apaga o vídeo do canal (não dá para desfazer). */
    async excluir(videoId) {
      await api('DELETE', `${API}/videos?id=${encodeURIComponent(videoId)}`);
    },

    async statuses(ids) {
      const out = {};
      for (let i = 0; i < ids.length; i += 50) {
        const j = await api('GET', `${API}/videos?part=status&id=${ids.slice(i, i + 50).join(',')}`);
        for (const v of j.items || []) out[v.id] = v.status;
      }
      return out;
    },
  };
}

/** Mesmas regras do fila.validar do Pipeline. */
export function validarMeta(meta, { minutosAntecedencia = 15 } = {}) {
  const erros = [];
  if (!meta.titulo?.trim()) erros.push('Escreva um título.');
  if ((meta.titulo || '').length > 100) erros.push('O título passa de 100 caracteres.');
  if (/[<>]/.test(meta.titulo || '') || /[<>]/.test(meta.descricao || '')) erros.push('O YouTube não aceita < ou > no título e na descrição.');
  if (Buffer.byteLength(meta.descricao || '', 'utf8') > 5000) erros.push('A descrição passa de 5000 bytes.');
  if (meta.publicarEm) {
    const t = new Date(meta.publicarEm).getTime();
    if (!Number.isFinite(t)) erros.push('Data de publicação inválida.');
    else if (t < Date.now() + minutosAntecedencia * 60_000) erros.push(`Agende com pelo menos ${minutosAntecedencia} minutos de antecedência.`);
  }
  const tagsLen = (meta.tags || []).join(',').length;
  if (tagsLen > 500) erros.push('As tags somam mais de 500 caracteres.');
  return erros;
}
