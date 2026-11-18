# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users
Um único criador: dev indie brasileiro (canal dev.gui / Gui01) que grava gameplay e devlogs dos próprios jogos (Oxe, Meu Bar!, Ironhex, mod de Minecraft, TropicalMod de GTA V) e publica em YouTube, Shorts, TikTok e Reels. Uso confirmado: **rápido, várias vezes ao dia**. Ele entra, vê o que gravar e o que publicar, aprova e sai. Precisa bater o olho e entender.

## Product Purpose
Levar uma gravação bruta até a publicação com o mínimo de trabalho manual: decidir o que gravar (aba Hoje), transformar a gravação em cortes (sugestão de cortes pelo Claude, trecho, legendas, narração, textos na tela), exportar (Remotion) e publicar ou agendar (YouTube, TikTok, Instagram). Sucesso = gravou hoje, publicou ou agendou hoje, sem se perder no caminho.

## Positioning
Mesa de corte pessoal que entende os jogos e o canal do próprio criador: o Claude assiste ao vídeo de verdade (quadros + fala + anotações do Pipeline) e escreve no tom do canal, com as regras do canal como lei.

## Operating Context
- Roda local em Docker (http://localhost:3100), só para o dono, no PC Windows com D:\Videos montado.
- Fluxo central: gravar → sugerir/fazer cortes → exportar → publicar/agendar.
- Integrações: Claude (assinatura Max via Agent SDK), ElevenLabs (voz e transcrição), YouTube Data API, TikTok Content Posting API (rascunhos), Instagram (em pausa, a Meta complicou), PhotoCraft (thumbnails via ponte no Windows).
- Convive com o Pipeline (D:\Pipeline), que também edita e publica.

## Capabilities and Constraints
- Telas: Hoje (plano do dia, agenda, pendências, canal); Editar (biblioteca, player Remotion, inspetor com Roteiro, Corte, Legendas, Voz, Textos, Exportar, Publicar); diálogos Conexões e Sugerir cortes.
- Player grande no centro é obrigatório na edição.
- Tema escuro é obrigatório (vídeo e trabalho noturno).
- Instagram: integração existe (token), mas o dono deixou para depois.
- Interface em português do Brasil.

## Brand Commitments
- Amarelo das legendas **#FFD43B** é a cor de marca/destaque.
- Tema escuro.
- Fonte Anton nas legendas renderizadas nos vídeos (parte do produto final, não da UI).

## Evidence on Hand
Dados reais do canal via YouTube API, gravações em D:\Videos, cortes e publicações em data/. Não inventar números, inscritos ou métricas.

## Product Principles
1. Bater o olho e entender: a próxima ação de cada tela precisa ser óbvia.
2. O caminho gravar → cortar → exportar → publicar é o eixo; tudo o mais é secundário.
3. O vídeo é o protagonista na edição.
4. Menos coisa ao mesmo tempo: mostrar o que importa agora, esconder o resto até ser preciso.
5. O Claude mostra em que se baseou; nada inventado.
