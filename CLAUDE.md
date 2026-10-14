# Roadcraft 2

Jogo de navegador de construir cidades (TypeScript, three.js, Vite). Meta: cidade no mapa inteiro
de 10 km, bonita e rápida. Jogo: `npm run dev` (127.0.0.1:5300). Verificação: `npm run check`.

## Memória do trabalho (leia primeiro)
Estado, decisões do jogador, quem faz o quê, o que está pela metade e os próximos passos. Entra
sozinho em toda sessão nova e depois de toda compactação. Atualize ao mudar o estado do trabalho.
@MEMORIA.md

## Desempenho: o plano manda
- Plano e orçamentos: `docs/CIDADE-10KM.md` e `docs/PESQUISA-CIDADE-10KM.md` §8. Os números estão
  em `src/core/perfBudget.ts` (`VIEW_BUDGETS`, `MEMORY_BUDGETS_MB`). Leia antes de propor.
- Todo trabalho de desempenho começa por `__roadcraft.budget('rua' | 'bairro' | 'mapa')` no
  console, com a câmera na vista nomeada: a tabela medido × orçamento, o mais acima primeiro.
  Ataque essa linha. Diga quanto passa e em que etapa do plano a correção entra.
- Correção que melhora uma linha e piora outra está errada, mesmo que resolva o sintoma.
- `__roadcraft.memory()`: geometria, quanto está preso na CPU e quem segura, pelo nome da malha.
  `performance.memory` soma o heap e os arrays e, no Chrome normal, só muda a cada 20 min: não
  serve para antes e depois.
- Se o plano estiver errado ou um orçamento for impossível, pare e diga ao jogador, com números.

## Padrões que já custaram caro (`OTIMIZACAO.md`)
- Refazer tudo quando uma parte muda: jardins, postes e cor dos lotes refeitos a cada prédio.
  Refaça só o que o diário (`world/changes.ts`) diz que mudou.
- Comparar cada item com todos (O(n²)) sem índice espacial: lotes, calçadas, esquinas, mobília.
- Fazer tudo num quadro ou na thread principal: fatie por tempo ou mande para um worker.
- Desenhar ou guardar o que não se vê: detalhe e sombra sem nível de distância, cópias na CPU
  que nunca são soltas, caches sem teto.
- Esperar a GPU no meio do quadro (`getImageData`) ou compilar shader durante o jogo.

## Limites do jogador
- Nenhuma perda de qualidade gráfica sem o sim dele: fotos antes e depois, nas mesmas vistas.
- Nada mais lento: números antes e depois no relatório.
- Nada de processo longo como barreira.

## Antes de dizer que funciona
- Use o jogo como o jogador, na cidade grande; diga foto por foto o que conferiu.
- Com a janela do Claude minimizada a página não desenha. Diga isso em vez de esperar.

## Várias sessões
- Outras sessões podem estar editando. Rode `git status` antes; não mexa em arquivo de outra
  sessão; faça commit só dos seus. Cada arquivo salvo recarrega o jogo na 5300.

## Onde está o resto
- Armadilhas por área: CLAUDE.md em `src/render`, `src/sim`, `src/world`, `src/editor`.
- Pesquisa já feita: `docs/research/`, `docs/reference/`, `docs/PESQUISA-CIDADE-10KM.md`.
