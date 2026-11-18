# Mesa de Corte

Painel local para editar e publicar os vídeos do canal: corte com Remotion, legendas e narração com a ElevenLabs, roteiro e textos com o Claude (pela sua assinatura Max), thumbnails no PhotoCraft e publicação no YouTube.

- Painel: http://localhost:3100 (só acessível desta máquina)
- Container: `mesa-de-corte` (`docker compose up -d --build`)
- Ponte do PhotoCraft: `ponte\iniciar-ponte.bat`, no Windows, na porta 3101

## Primeira configuração

1. **Claude (assinatura Max, sem créditos de API)**
   ```
   claude setup-token
   ```
   Aprove no navegador e cole o token em `.env`, na linha `CLAUDE_CODE_OAUTH_TOKEN=`. O token vale 1 ano. Depois rode `docker compose up -d`.
   - Não coloque `ANTHROPIC_API_KEY` no `.env`: se ela existir, tem prioridade sobre o token e passa a gastar créditos.
   - O uso conta no limite da sua assinatura, como no Claude Code. O token é só seu: não exponha este painel para outras pessoas.
2. **YouTube:** o container usa o mesmo `client_secret.json` do Pipeline, só para leitura. Em **Conexões → Conectar YouTube**, entre com a conta do canal. O token fica em `config/youtube_token.json`, separado do token do Pipeline.
3. **ElevenLabs:** cole a chave em **Conexões** ou em `ELEVENLABS_API_KEY` no `.env`.
4. **PhotoCraft:** abra `ponte\iniciar-ponte.bat` e deixe a janela aberta enquanto usa as thumbnails. A ponte usa o login do Claude Code do Windows e o `PONTE_TOKEN` do `.env`.

## O que veio do Pipeline

- **Envio ao YouTube:** upload retomável em blocos de 16 MB. O agendamento usa `publishAt`, com o vídeo privado até o YouTube publicar sozinho. Thumbnail, categoria, idioma pt-BR e a conferência periódica do status (a cada 10 min) vieram juntos.
- **Validação antes de enviar:** título com até 100 caracteres, descrição com até 5000 bytes, sem `<` e `>`, e agendamento com pelo menos 15 min de antecedência.
- **Regras do canal:** jogos, chamadas para se inscrever com os textos exatos e bloco de links. Ficam em `config/canal.md`, editáveis em **Conexões → Regras do canal**.
- **Chamadas finais na tela:** "SEGUE PRA VER O PRÓXIMO UPDATE! 👀" nos Shorts e "SE INSCREVE NO CANAL!" no vídeo longo, com o lado direito livre para as telas finais.
- **Pasta `D:\Videos`:** montada só para leitura. As gravações e as músicas aparecem direto no painel, sem upload. Faixas de ZephiraMusic, VelarioMusic, da pasta `_bloqueadas` e com nome no padrão do Pixabay ficam bloqueadas por causa do Content ID.
- **Instruções de thumbnail:** vêm do seu agente `thumbnail-designer`.

### O que melhorou em relação ao Pipeline

- **Upload interrompido:** a sessão de envio fica salva, então "Tentar de novo" continua de onde parou em vez de recomeçar.
- **Erros de envio:** falhas temporárias são retentadas com espera crescente, e a cota esgotada (`quotaExceeded`) aparece com uma mensagem clara.
- **Thumbnail e playlist:** se falharem, aparecem como aviso na publicação em vez de ficarem só no log.
- **Configurável no formulário:** playlist, categoria, "feito para crianças" e o aviso de conteúdo sintético.

Atenção: enquanto o projeto do Google não passar pela auditoria da API do YouTube, os vídeos enviados pela API ficam travados como privados, igual no Pipeline (veja `D:\Pipeline\docs\auditoria_youtube.md`).

## TikTok e Instagram

### TikTok
Precisa de um app em developers.tiktok.com:
- **Plataforma:** Desktop, com os produtos Login Kit e Content Posting API.
- **URL de retorno:** `http://localhost:3100/api/tiktok/callback/`
- **No `.env`:** `TIKTOK_CLIENT_KEY` e `TIKTOK_CLIENT_SECRET`.

Modos de envio:
- **Enviar para rascunhos (padrão):** o vídeo chega na caixa de entrada do app e você termina a postagem no celular. Usa o escopo `video.upload`.
- **Postar direto:** precisa do escopo `video.publish`. Coloque `TIKTOK_SCOPES=user.info.basic,video.upload,video.publish` no `.env`. Sem a auditoria do TikTok, os posts diretos ficam só como privados ("Só eu"). O painel mostra a conta, as opções de privacidade da sua conta (sem escolher por você) e os avisos que o TikTok exige.

### Instagram (Reels)
O envio de um arquivo do seu PC só é aceito pelo **login do Facebook**. Com o login do Instagram, a API só aceita vídeos por URL pública. Por isso:
- **Conta:** a conta do Instagram precisa ser profissional e estar ligada a uma Página do Facebook.
- **App:** crie um app do tipo Empresa em developers.facebook.com, com o Login do Facebook para Empresas e a API do Instagram.
- **URL de retorno:** `http://localhost:3100/api/instagram/callback`
- **No `.env`:** `META_APP_ID` e `META_APP_SECRET`. Com o app em modo de desenvolvimento, você publica na própria conta sem passar pela análise da Meta.
- **Validade do login:** 60 dias. Depois disso, conecte de novo.
- **Arquivo:** antes de enviar, o painel reorganiza o MP4 com o índice no começo, sem perder qualidade, como o Instagram exige.

### Textos do Claude
O Claude escreve sobre o vídeo que vai ser publicado. Ele recebe:
- 6 quadros da versão exportada;
- a fala transcrita, com cache (precisa da ElevenLabs);
- a narração, o gancho e o roteiro do corte;
- os `_descricao.md` que o Pipeline deixa na pasta da gravação.

O painel mostra "O Claude entendeu assim" e em que ele se baseou, para você conferir antes de usar.

## Hoje: o que gravar e a agenda
É a tela inicial. "Montar o plano do dia" junta várias fontes e propõe de 3 a 6 ideias para gravar hoje e a agenda dos próximos 7 dias:
- **Na web:** o Claude pesquisa o que está em alta, com fonte e link.
- **No YouTube:** o que está em alta no Brasil, na categoria Jogos, e os números dos seus últimos vídeos.
- **No D:\Videos:** o `cronograma_postagens.md` do Pipeline e as gravações brutas paradas.
- **No painel:** os cortes sem publicar.

Cada ideia vira um corte com "Criar roteiro desta ideia". O plano fica salvo por dia em `data/hoje/`.

**Agendamento:** o YouTube agenda sozinho. O TikTok e o Instagram não agendam pela API, então o painel guarda o horário e envia quando chegar. Para isso, o PC e o Docker precisam estar ligados.

## Sugerir cortes
Use o ✂ ao lado de uma gravação ou "Sugerir cortes desta gravação". O Claude assiste à gravação inteira (quadros ao longo do vídeo e a fala transcrita) e propõe Shorts de trecho contínuo, cada um com título, gancho e o motivo da escolha. Os cortes que você marcar já são criados em 9:16, com legendas, gancho e chamada final, e podem ir direto para a exportação.

## Agentes
São três especialistas, todos editáveis em **Conexões → Agentes**, em `config/agentes/`:
- **Roteirista:** roteiro, narração, ganchos e sugestão de cortes.
- **Social media:** títulos, descrições, legendas e agenda.
- **Marketing:** o que gravar hoje e as tendências.

As regras do canal (`config/canal.md`) valem para todos e têm prioridade.

## Roadmap

### Outras ideias
- Capítulos automáticos para o vídeo longo, a partir da transcrição.
- Importar a fila e o cronograma do Pipeline (`cronograma_postagens.md`) para um calendário de publicações.
- Modelos de thumbnail por jogo (`D:\Videos\_templates`). Hoje a ponte só enxerga `data\`.

## Desenvolvimento
```
npm install
npm run dev:server   # API em http://127.0.0.1:3100
npm run dev:web      # Vite em http://localhost:5173
npm run ponte        # ponte do PhotoCraft
```
