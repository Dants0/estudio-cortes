# Design · Mesa de Corte

Direção: **guia de programação da TV**. A semana do canal é lida como uma grade de programação: o que vai ao ar, quando e onde. Superfície Operate: controles padrão, sem fantasia; a identidade vem da paleta, da tipografia, da densidade e de um gesto próprio (a grade).

Fonte de verdade dos tokens: `src/styles.css` (`@theme` do Tailwind v4).

## Cor
Estratégia: contida, com papéis claros. Tema escuro obrigatório (vídeo e uso noturno).

| Token | Valor | Papel |
|---|---|---|
| `ground` | #121418 | fundo do app |
| `band` | #1C2230 | cabeçalho e faixas de "revista de TV", linhas de cabeçalho da grade |
| `raise` | #242C3D | controle selecionado, botão secundário |
| `sunk` | #0D0F13 | campos, poços de conteúdo |
| `line` / `line-soft` | #2A3244 / #222938 | filetes de 1px que dividem regiões |
| `text` / `muted` / `faint` | #F1F1EE / #9AA4B8 / #6B7489 | texto em três níveis |
| `hl` | #FFD43B | **marca**: só "hoje", a ideia do dia, a ação principal, seleção e foco |
| `yt` / `tt` / `ig` | #E5484D / #7CC4FF / #D96CF0 | faixas fixas de cada rede (ponto + preenchimento tingido; nunca borda lateral grossa) |
| `ok` / `bad` | #7BC59A / #FF7A72 | concluído / erro |

## Tipografia
- **Figtree** (400–800) em toda a interface. Títulos em 800 com tracking levemente negativo; rótulos de seção em 12px 700 `muted`.
- Horários, durações e números em numerais tabulares.
- **Anton** só no que é renderizado no vídeo (legendas, gancho, chamada final) e nas amostras de estilo de legenda.

## Forma e espaço
- Raio: 10px controles (`rounded-ctl`), 14px painéis (`rounded-card`).
- Regiões separadas por filetes de 1px, não por cartões com sombra. Sem cartões aninhados.
- Sombra só no player e em diálogos (deslocada e com desfoque).

## Componentes
- `btn` (+ `primary` amarelo, `ghost`, `sm`, `wide`), `seg` (segmentado), `chip`, `tag`, `switch`, `field`/`field-label`/`hint`, `callout`, `dialog`.
- Ícones: **lucide-react**, traço único. Nada de emoji ou caractere Unicode como ícone.
- Abas do inspetor = etapas do corte; o ✓ verde mostra o que já está feito.

## Gesto próprio
- **Hoje:** grade de 7 dias × 3 redes. O cabeçalho de hoje é amarelo; os itens marcados são blocos tingidos na cor da rede, e as sugestões do Claude têm contorno tracejado. A ideia do dia é uma faixa amarela de largura total, acima da grade.
- **Editar:** o player domina o centro; biblioteca à esquerda (280px), inspetor à direita (384px).

## Movimento
Só em resposta a ações: botão encolhe 3% ao apertar (140ms, ease-out forte), diálogo e aviso entram com 200–250ms. `prefers-reduced-motion` desliga tudo.
