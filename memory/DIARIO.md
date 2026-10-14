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
- 2026-10-14 ~14h40 (auditoria): `96d1d64` postes segurados durante o traçado, com `--only`; o
  `777b12a` da outra sessão tinha levado o renderer.ts do índice (ela desfez e refez como 6b487bb).
  Regra nova em ORDENS: `git commit --only <caminhos>`. Portador e regras do check-code em stash.
- 2026-10-14 ~15h30 (auditoria): `6f22b1c` regras novas no check-code (CLARITY); `f01799a` índice de
  prédios por lugar (cidade idêntica; 12,0 → 7,8 s em 5.400 prédios). Timeouts do check completo de
  novo por carga (passam sozinhos).
- 2026-10-14 ~16h10 (Hook de busca na internet): `1ee7f37` scripts/look.mjs (fotos 1920x1080 na
  GPU, gestos, recomeça se o Vite recarregar, evalFile) + skills `investigando-desempenho` e
  `conferindo-no-jogo`. Referência offline do three.js r186 e de 4 projetos em
  C:/Codex-Shared/referencia. Plugins typescript-lsp e context7 instalados no usuário. Defeito
  visto e passado à auditoria: fresta preta e textura borrada numa fachada (15-rua-arrastada.png).
  Próximo: o "acusador" (script só de leitura) de usos do three.js contra o manual e dos padrões.
- 2026-10-14 (Hook de busca na internet, nova conta): LSP e context7 funcionando. `a17e808` contador
  `journalWork.entries` em `world/changes.ts` e produtos `building+1:ground` / `ground:idle` (17 -> 65,
  x3,82, na base); mutante do conserto D8 morto (vai a 0, pede para sair da base). Jardins, cameraSolids
  e pads: decididos dentro do `createSceneRenderer`, que o vitest não monta; a auditoria extrai a parte
  incremental num módulo puro ao consertar e avisa. Acusador rodado, pistas passadas à auditoria.
- 2026-10-14 (Hook de busca na internet): com o sim do jogador, seção "Como adicionar um produto
  derivado" no CLAUDE.md da raiz (diário em vez de revisão global, `near`, módulo puro, contador +
  teste de escala).
- 2026-10-14 (Hook de busca na internet): `b95f63b` contadores do sim no "um prédio a mais":
  `bays` (B10, 34 -> 130) e `yards` (B14, 17 -> 65), x3,82 na base; mutante da chave sem a revisão dos
  prédios morto (x1, pede para sair da base).
- 2026-10-14 (Auditoria, nova conta): `f1405fa` clique em prédio. No jogo o rayAt sozinho não bastou:
  medido pixel a pixel, todo raio entrava no quintal (`open`) do vizinho, testado como caixa de um
  andar; virou placa do chão. Item 34 (lotes abertos, `6914c7d`) registrado no OTIMIZACAO. Vistos e
  anotados, fora do clique: célula da câmera ainda em massa ao chegar (sem muros), olho dentro de
  prédio recém-crescido (tela cinza; cameraSolids), pessoa da bomba atravessando poste de cerca,
  sombra pontilhada no gramado. Próximo: D8 (anel por tipo do diário).
- 2026-10-14 noite (Hook de busca na internet): `4362867` sólidos da câmera, plataformas e jardins fora
  do renderer (Extract Class, sem mudar comportamento) e contadores `solids`/`pads` x3,82 e `gardens`
  x14,02; check-code com as 4 entradas só renomeadas (173). `18c373a` `__roadcraft.setView`: os gestos
  davam vista diferente a cada rodada (A/A do HEAD), agora o antes/depois usa vistas fixas. No jogo:
  vistas iguais nos dois lados; câmera dentro de prédio é defeito antigo (passado à auditoria).
- 2026-10-14 noite (Hook de busca na internet): com o sim do jogador, origin/main enviado de `a4725ff`
  até `b8c63c3` (28 commits das duas sessões); `81c6ffb` (D8, auditoria) segue local.
- 2026-10-14 (Auditoria, noite): A2 `e5ec4e5`, A7 `cf0917d`, C3 `de7588d` (os três enviados pela outra
  sessão com o sim do jogador), D8 `81c6ffb`, A1+A5+A16 `c45806a` (locais). No jogo, mesma sequência
  antes/depois do A1: fotos iguais; cascas L0 795 MB no bairro nos dois lados (anterior, acima do teto
  de 300 - virou o passo 2). Defeitos da outra sessão e meus anotados no ESTADO (passos 1 e 5).
- 2026-10-14 noite (Hook): ordem do jogador "corrigir na raiz, não métrica"; postes inteiros corrigidos na causa
  (9233238, 82c0239, 8e65f88, bdda55a, a1dd21a); agentes revisados: jardins 90524a3, mobília b5cc51d,
  curvas 7c046a4; regras, skill e hook reescritos (5361eb8, ab455db). OTIMIZACAO 40-47.
