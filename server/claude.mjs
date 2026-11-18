// Chamadas ao Claude pela assinatura (Pro/Max) usando o Claude Agent SDK.
// Autentica com CLAUDE_CODE_OAUTH_TOKEN (gerado por `claude setup-token`). Uso pessoal:
// não exponha este painel para outras pessoas usarem a sua assinatura.
import { query } from '@anthropic-ai/claude-agent-sdk';

export const claudeModel = () => process.env.CLAUDE_MODEL || 'claude-opus-5-5';

export const claudeStatus = () => {
  if (process.env.ANTHROPIC_API_KEY) return { ok: true, via: 'api-key' };
  if (process.env.CLAUDE_CODE_OAUTH_TOKEN) return { ok: true, via: 'assinatura' };
  return { ok: false, via: null };
};

const fail = (statusCode, message) => Object.assign(new Error(message), { statusCode });

/**
 * Roda um pedido de texto ao Claude, sem ferramentas, e devolve o JSON validado pelo schema.
 */
export async function runClaude({ system, prompt, schema, images = [], maxTurns = 4, timeoutMs = 240_000, web = false, log }) {
  // web: libera só a busca e a leitura de páginas (para tendências); nada de arquivos ou shell
  const ferramentas = web ? ['WebSearch', 'WebFetch'] : [];
  if (web) maxTurns = Math.max(maxTurns, 24);
  if (!claudeStatus().ok) {
    throw fail(400, 'Conecte o Claude: rode `claude setup-token` no seu terminal e coloque o token em CLAUDE_CODE_OAUTH_TOKEN no .env.');
  }
  const abortController = new AbortController();
  const timer = setTimeout(() => abortController.abort(), timeoutMs);
  try {
    // com imagens, o pedido vai como mensagem de usuário com blocos de imagem + texto
    const input = images.length
      ? (async function* () {
          yield {
            type: 'user',
            parent_tool_use_id: null,
            message: {
              role: 'user',
              content: [
                ...images.flatMap((img) => [
                  { type: 'text', text: img.legenda },
                  { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: img.base64 } },
                ]),
                { type: 'text', text: prompt },
              ],
            },
          };
        })()
      : prompt;
    const run = query({
      prompt: input,
      options: {
        model: claudeModel(),
        systemPrompt: system,
        tools: ferramentas,
        allowedTools: ferramentas,
        settingSources: [],
        permissionMode: 'dontAsk',
        maxTurns,
        outputFormat: { type: 'json_schema', schema },
        abortController,
        env: { ...process.env },
      },
    });
    for await (const msg of run) {
      if (msg.type !== 'result') continue;
      if (msg.subtype === 'success' && msg.structured_output) {
        log?.info({ custo_estimado_usd: msg.total_cost_usd, turnos: msg.num_turns }, 'claude ok');
        return msg.structured_output;
      }
      // token revogado/expirado chega como "resposta" de texto, não como erro
      if (typeof msg.result === 'string' && /failed to authenticate|token (revoked|expired)|please log in/i.test(msg.result)) {
        throw fail(401, 'O token do Claude foi revogado ou expirou. No terminal, rode `claude setup-token`, cole o novo valor em CLAUDE_CODE_OAUTH_TOKEN no .env e recrie o container (docker compose up -d).');
      }
      // às vezes o JSON vem no texto (com ou sem ```json): aproveita em vez de jogar a resposta fora
      if (msg.subtype === 'success' && typeof msg.result === 'string') {
        const ini = msg.result.indexOf('{');
        const fim = msg.result.lastIndexOf('}');
        if (ini >= 0 && fim > ini) {
          try {
            const obj = JSON.parse(msg.result.slice(ini, fim + 1));
            const faltando = (schema.required || []).filter((k) => !(k in obj));
            if (!faltando.length) {
              log?.info({ custo_estimado_usd: msg.total_cost_usd, turnos: msg.num_turns }, 'claude ok (JSON lido do texto)');
              return obj;
            }
            log?.warn({ faltando }, 'JSON do Claude incompleto');
          } catch {}
        }
        log?.warn({ texto: msg.result.slice(0, 1500), turnos: msg.num_turns }, 'Claude respondeu sem o formato esperado');
      } else {
        log?.warn({ subtype: msg.subtype, erros: msg.errors, turnos: msg.num_turns }, 'Claude não terminou');
      }
      const detalhe = msg.subtype === 'success' ? 'resposta sem o formato esperado' : msg.subtype;
      throw fail(502, `O Claude não terminou o pedido (${detalhe}). Tente de novo.`);
    }
    throw fail(502, 'O Claude encerrou sem resposta.');
  } catch (e) {
    if (abortController.signal.aborted) throw fail(504, 'O Claude demorou demais para responder. Tente de novo.');
    if (e.statusCode) throw e;
    const msg = String(e.message || e);
    if (/rate|limit|usage/i.test(msg)) throw fail(429, `Limite de uso da assinatura atingido: ${msg.slice(0, 200)}`);
    if (/auth|login|token|401/i.test(msg)) throw fail(401, `O token do Claude foi recusado. Gere outro com \`claude setup-token\`. (${msg.slice(0, 160)})`);
    throw fail(502, `Falha ao falar com o Claude: ${msg.slice(0, 300)}`);
  } finally {
    clearTimeout(timer);
  }
}
