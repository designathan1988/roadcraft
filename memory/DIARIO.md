# Diário (só acrescentar no fim; uma linha por evento, com data e hora)

- 2026-10-14 ~13h: criada esta memória a pedido do jogador; três de quatro relatórios de auditoria
  recebidos; divisão de trabalho combinada com a sessão "Hook de busca na internet".
- 2026-10-14 ~13h30: os quatro relatórios de auditoria gravados em `docs/AUDITORIA-2026-10-14.md`
  (A prédios, B editor/sim/ui, C render, D world/core; ~90 achados). A outra sessão fez o 1º contador
  por evento (`02a690b`, local): camada de prédios lê o doc 85× (16 prédios) × 325× (64) = ×3,82 por
  prédio acrescentado; linha de base `building+1:layer` em `tests/scale/baseline.json`.
- 2026-10-14 ~13h45 ("Hook de busca na internet"): o `49d12f3` levou as linhas de `holdUtilities`
  da outra sessão porque `git add src/main.ts` pegou o arquivo inteiro. Regra: antes de cada commit,
  ler `git diff --cached` trecho por trecho e tirar o que não é seu. Pendente do jogador: a regra
  "como adicionar um produto derivado" no CLAUDE.md (só com o OK dele) e o envio de `49d12f3` e
  `02a690b`. Próximos contadores: anel do diário (C1/D8), jardins (C2), cameraSolids (A8/C5), pads (C8).
- 2026-10-14 ~14h: a pedido do jogador, a memória virou a pasta `memory/` (índice curto importado +
  arquivos sob demanda), no desenho da memória automática do Claude Code; `MEMORIA.md` removido.
