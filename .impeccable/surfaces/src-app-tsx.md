---
version: 1
slug: "src-app-tsx"
primary_target: "src/App.tsx"
related_targets: ["src/hoje.tsx","src/panels.tsx","src/sugestoes.tsx"]
---

# Mesa de Corte · app inteiro (Hoje + Editar)

Scope: o app inteiro (src/App.tsx, src/hoje.tsx, src/panels.tsx, src/sugestoes.tsx). Mode: Operate.
Uso: rápido, várias vezes ao dia; bater o olho e entender. Queixas: bagunçado/denso, fluxo confuso, tipografia/espaçamento, genérico. Manter: player grande no centro, tema escuro, amarelo #FFD43B.

## Direction contract
THESIS: A semana do canal lida como uma grade de programação de TV: o que vai ao ar, quando e onde. Recusa o editor escuro genérico com cartões e sete abas iguais.
OWN-WORLD: Fundo grafite azulado #121418, faixa de cabeçalho #1C2230 como "cabeçalho de revista de TV", filetes #2A3244. Amarelo #FFD43B só para "hoje", a ideia do dia e a ação principal. Cada rede tem cor de faixa fixa (YouTube vermelho, TikTok azul-gelo, Instagram lilás) usada como preenchimento tingido e ponto, nunca borda lateral grossa. Figtree, horários em numerais tabulares, ícones Lucide.
STORY: Abre em Hoje e entende em segundos: o que gravar hoje, o que vai ao ar na semana e o que está parado. Clica e cai no corte certo. No editor, o player domina e o inspetor mostra as etapas na ordem, com o que já está feito.
FIRST VIEWPORT: Topo de 56px com marca, abas Hoje/Editar e as conexões compactas. Hoje: faixa amarela da ideia do dia em largura total com "Criar roteiro"; abaixo, a grade de 7 dias × 3 redes (hoje com cabeçalho amarelo), sugestões tracejadas; à direita, coluna de 360px "Esperando você" e "Canal". Editar: biblioteca 280px, player central grande, inspetor 380px com etapas numeradas e estado de conclusão.
FORM: Guia de programação da TV, item 1 da lista ordenada (IMPECCABLE’S PICK); seed:578a756703fb4b4f
SIGNATURE: a grade de programação da semana na aba Hoje, e no editor cada corte mostra em que faixas/horários vai ao ar, no mesmo código de cores.
FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance
