// Google Drive: envia os vídeos editados para uma pasta do painel.
// Escopo drive.file: o painel só enxerga o que ele mesmo cria (a pasta e os vídeos enviados), nada mais do seu Drive.
// Usa o mesmo client_secret.json do YouTube (app instalado, retorno em http://localhost:PORTA/).
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import crypto from 'node:crypto';

const SCOPES = ['https://www.googleapis.com/auth/drive.file'];
const API = 'https://www.googleapis.com/drive/v3';
const UPLOAD = 'https://www.googleapis.com/upload/drive/v3';
const CHUNK = 16 * 1024 * 1024; // múltiplo de 256 KB
const PASTA = 'Mesa de Corte - vídeos editados';

const fail = (statusCode, message) => Object.assign(new Error(message), { statusCode });

export function createDrive({ clientSecretPath, tokenPath, redirectUri, loginHint, log }) {
  const pending = new Map();

  const client = () => {
    if (!fs.existsSync(clientSecretPath)) return null;
    const j = JSON.parse(fs.readFileSync(clientSecretPath, 'utf8'));
    const c = j.installed || j.web;
    return c ? { id: c.client_id, secret: c.client_secret } : null;
  };
  const readToken = () => { try { return JSON.parse(fs.readFileSync(tokenPath, 'utf8')); } catch { return null; } };
  const writeToken = (t) => fsp.writeFile(tokenPath, JSON.stringify(t, null, 2), { mode: 0o600 });

  const tokenRequest = async (params) => {
    const c = client();
    const r = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: c.id, client_secret: c.secret, ...params }),
    });
    const j = await r.json();
    if (!r.ok) throw fail(401, `O Google recusou o login do Drive (${j.error}: ${j.error_description || ''}). Conecte de novo.`);
    return j;
  };

  const accessToken = async () => {
    const t = readToken();
    if (!t?.refresh_token) throw fail(401, 'Conecte o Google Drive em Conexões.');
    if (t.access_token && t.expires_at > Date.now() + 60_000) return t.access_token;
    const j = await tokenRequest({ grant_type: 'refresh_token', refresh_token: t.refresh_token });
    const next = { ...readToken(), access_token: j.access_token, expires_at: Date.now() + j.expires_in * 1000 };
    await writeToken(next);
    return next.access_token;
  };

  const explain = (status, body) => {
    const e = body?.error || {};
    const reason = e.errors?.[0]?.reason || e.status || '';
    if (reason === 'accessNotConfigured' || /has not been used|is disabled/i.test(e.message || '')) {
      return fail(400, 'A API do Google Drive não está ativada no projeto do Google Cloud desse client_secret. Ative em console.cloud.google.com → APIs e serviços → Biblioteca → "Google Drive API" e tente de novo.');
    }
    if (reason === 'storageQuotaExceeded') return fail(507, 'O Google Drive está sem espaço.');
    if (status === 401) return fail(401, 'O login do Drive expirou. Conecte de novo.');
    return fail(status >= 500 ? 502 : status, `Google Drive recusou (${status} ${reason}): ${(e.message || '').slice(0, 300)}`);
  };

  const api = async (method, url, { json, headers = {} } = {}) => {
    const r = await fetch(url, {
      method,
      headers: { Authorization: `Bearer ${await accessToken()}`, ...(json ? { 'Content-Type': 'application/json; charset=UTF-8' } : {}), ...headers },
      body: json ? JSON.stringify(json) : undefined,
    });
    const text = await r.text();
    const data = text ? JSON.parse(text) : {};
    if (!r.ok) throw explain(r.status, data);
    return data;
  };

  /** a pasta do painel (criada na 1ª vez; se você apagar, é recriada) */
  const pasta = async () => {
    const t = readToken();
    if (t?.pastaId) {
      const ok = await api('GET', `${API}/files/${t.pastaId}?fields=id,trashed`).then((f) => !f.trashed).catch(() => false);
      if (ok) return t.pastaId;
    }
    const f = await api('POST', `${API}/files?fields=id`, { json: { name: PASTA, mimeType: 'application/vnd.google-apps.folder' } });
    await writeToken({ ...readToken(), pastaId: f.id });
    return f.id;
  };

  return {
    async status() {
      if (!client()) return { configurado: false, conectado: false, conta: null, auto: false };
      const t = readToken();
      return { configurado: true, conectado: Boolean(t?.refresh_token), conta: t?.conta || null, auto: Boolean(t?.auto), pasta: t?.pastaId ? `https://drive.google.com/drive/folders/${t.pastaId}` : null };
    },

    authUrl() {
      const c = client();
      if (!c) throw fail(400, 'Falta o client_secret.json do Google (o mesmo do YouTube/Pipeline).');
      const state = crypto.randomBytes(16).toString('hex');
      const verifier = crypto.randomBytes(48).toString('base64url');
      const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
      for (const [k, v] of pending) if (Date.now() - v.createdAt > 15 * 60_000) pending.delete(k);
      pending.set(state, { verifier, createdAt: Date.now() });
      const q = new URLSearchParams({
        client_id: c.id, redirect_uri: redirectUri, response_type: 'code', scope: SCOPES.join(' '),
        access_type: 'offline', prompt: 'consent', state, code_challenge: challenge, code_challenge_method: 'S256',
        ...(loginHint ? { login_hint: loginHint } : {}),
      });
      return `https://accounts.google.com/o/oauth2/v2/auth?${q}`;
    },

    isCallback: (state) => pending.has(state),

    async finishLogin(code, state) {
      const p = pending.get(state);
      pending.delete(state);
      if (!p) throw fail(400, 'Login do Drive expirado. Tente de novo.');
      const j = await tokenRequest({ grant_type: 'authorization_code', code, redirect_uri: redirectUri, code_verifier: p.verifier });
      if (!j.refresh_token) throw fail(400, 'O Google não devolveu o refresh token. Remova o acesso do app na sua conta Google e conecte de novo.');
      const anterior = readToken() || {};
      await writeToken({ auto: anterior.auto ?? true, refresh_token: j.refresh_token, access_token: j.access_token, expires_at: Date.now() + j.expires_in * 1000 });
      const about = await api('GET', `${API}/about?fields=user(displayName,emailAddress)`);
      const conta = { nome: about.user?.displayName || '', email: about.user?.emailAddress || '' };
      await writeToken({ ...readToken(), conta });
      if (loginHint && conta.email && conta.email.toLowerCase() !== loginHint.toLowerCase()) {
        log?.warn({ esperado: loginHint, conectado: conta.email }, 'Drive conectado com outra conta');
      }
      await pasta();
      return conta;
    },

    async logout() {
      const t = readToken();
      if (t?.refresh_token) await fetch(`https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(t.refresh_token)}`, { method: 'POST' }).catch(() => {});
      await fsp.rm(tokenPath, { force: true });
    },

    async setAuto(auto) {
      const t = readToken();
      if (!t) throw fail(400, 'Conecte o Google Drive primeiro.');
      await writeToken({ ...t, auto: Boolean(auto) });
    },

    /** upload retomável em blocos de 16 MB; devolve { id, link } */
    async enviar(file, nome, onProgress = () => {}) {
      const total = (await fsp.stat(file)).size;
      const pai = await pasta();
      const ini = await fetch(`${UPLOAD}/files?uploadType=resumable&fields=id,webViewLink`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${await accessToken()}`,
          'Content-Type': 'application/json; charset=UTF-8',
          'X-Upload-Content-Type': 'video/mp4',
          'X-Upload-Content-Length': String(total),
        },
        body: JSON.stringify({ name: nome, parents: [pai], mimeType: 'video/mp4' }),
      });
      if (!ini.ok) throw explain(ini.status, await ini.json().catch(() => ({})));
      const sessao = ini.headers.get('location');
      const fh = await fsp.open(file, 'r');
      try {
        let enviado = 0;
        for (;;) {
          const len = Math.min(CHUNK, total - enviado);
          const buf = Buffer.alloc(len);
          await fh.read(buf, 0, len, enviado);
          let r;
          for (let tent = 0; ; tent++) {
            r = await fetch(sessao, {
              method: 'PUT',
              headers: { 'Content-Length': String(len), 'Content-Range': `bytes ${enviado}-${enviado + len - 1}/${total}` },
              body: buf,
            }).catch((e) => ({ status: 599, erro: e }));
            if (r.status < 500 || tent >= 4) break;
            await new Promise((res) => setTimeout(res, 2 ** tent * 1000));
          }
          if (r.status === 200 || r.status === 201) {
            onProgress(1);
            const f = await r.json();
            return { id: f.id, link: f.webViewLink || `https://drive.google.com/file/d/${f.id}/view` };
          }
          if (r.status !== 308) throw explain(r.status, await r.json?.().catch(() => ({})) || {});
          const range = r.headers.get('range'); // "bytes=0-N"
          enviado = range ? Number(range.split('-')[1]) + 1 : enviado + len;
          onProgress(enviado / total);
        }
      } finally {
        await fh.close();
      }
    },
  };
}
