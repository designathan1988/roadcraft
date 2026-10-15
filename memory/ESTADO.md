# Estado do trabalho — reescrever a cada mudança (não acumular)

Atualizado: 2026-10-14 (noite). A versão longa anterior está no git (`git show 8ddba37:memory/ESTADO.md`).

## Quem trabalha (2026-10-14 noite)
- Uma conversa só, "Análise de otimização e desempenho do jogo". Agentes, cada um lendo inteira
  uma parte do código e corrigindo no SEU worktree (C:/Codex-Shared/rc2-wt/<parte>, ramo
  fix/<parte>, criado do main local): sim, world, render-cidade, render-vivos (rodando) e
  editor-2 (o que ficou aberto do editor/core). Eu leio cada diff, rodo o analisador e os testes do
  bloco e faço o merge na pasta principal.
- No main (2026-10-14 ~21h40): `66e3f87` fix/ui (src/ui lido e corrigido por mim), `8395fe6`
  fix/editor-ui (36 commits do agente, revisados), `49298cf`. Conferido no jogo (look.mjs, cidade
  padrão, 5320): inspetor, catálogo, F9, ver por dentro (uma barra, andar limitado ao prédio).
- Pendente no merge do world: `editor/itemCells.ts` (índice da paisagem e muros do editor) e
  `doc.landscapeIn` do world são o mesmo índice: ficar com o do documento; `FURNITURE_CELL` de
  roadTool.ts com o `CELL` de world/roads/furnitureSets.ts.
- Defeitos vistos no jogo, com dono: o corte de "ver por dentro" não desenha (também no main;
  enviado ao render-cidade, fotos em C:/Codex-Shared/rc2-wt/ui-look/fotos-terreo-*); olho dentro
  da copa de árvore (decisão do jogador); realce azul da via escolhida por cima dos prédios.
- Lint do main falha em scripts/check-code.mjs (1.007 linhas, máx. 800) e render/buildings/layer.ts
  (801, do render-cidade).

## Ramos antigos dos agentes (decididos em 2026-10-14 noite; os worktrees de .claude/worktrees saíram)
- Removidos por inúteis ou já no main: a84faa1 (BufferAttribute = a08cb68), aa3046a (churrasqueiras =
  05f8780), adf464a (um 4º diário sem leitor), a17828c (bancada com 2.568 arquivos copiados).
- Guardados, eu reviso e junto DEPOIS das partes, conferindo no jogo: aece52d (lotes por grade
  vetorial, sem LAY_SLICE_MS), a432aff (LOD dos prédios perto), a9b9ac5 (sombras em degrau),
  a56be88 (câmera dentro do prédio; estado parado), a976623 (dono do estoque/vagas; parado),
  ab4e4e8 (limite dos lotes e patamar das calçadas; parado).
- Referência, não entram como estão (partem do origin/main e refazem "o tocado" à mão, fora do
  Derived): a5fbde5 (zebras, calçadas, travessias) e a799a55 (grafo de faixas, conflitos, sinais).
- Para a simulação em worker (depois): af5ce5d (tickInput, lockstep; tirar focus e populationShare).
- Restam 4 pastas vazias em .claude/worktrees presas por algum processo; as junções já saíram.
- Decisões do jogador mantidas: .githooks/pre-push e .claude/launch.json apagados ("deixe assim").

## Plano em vigor
`docs/PLANO-ESPINHA-2026-10-14.md` (diretriz do jogador no topo: desempenho e qualidade em
computadores diferentes, rumo à cidade sem limite; ler o código inteiro, identificar e corrigir;
teste no fim de cada bloco). No main: fase 0, innerHTML, projetos/modelos do jogador
(core/keptList.ts), via invertida/coletora/postes, trilhos/caminhões, desgaste por heap, a
espinha (world/derived.ts), instruções e checagem do turno só com a barreira (4bb1188, 07a0940).
- Depois dos blocos: a cidade no mapa inteiro, `generateCity({ radius })` (plan.ts:109 limita a
  MAP_HALF - 60 m; o mapa é fixo em 10,24 km, 5 × 5 placas), jogada como o jogador; o que ela
  mostrar volta a ser lido e corrigido; depois o mundo sem borda (plano, "10 km e a cidade sem limite").

## Repositório (conferido em 2026-10-14 noite)
- `main` à frente de `origin/main` (`b8c63c3`; eram 80 commits antes da fase 0); envio ao GitHub só com o sim do jogador.
- A pasta principal está limpa (só as deleções do jogador e um relatório de outra sessão). O
  trabalho que estava nela foi para os ramos das partes: a célula em worker (com os defeitos lidos
  e corrigidos por mim; falta a causa da geometria presa na CPU) em fix/render-cidade.
- Relato da Auditoria, NÃO conferido: `world/buildings/cameraSolids.ts` (eb31083), em follow, a
  troca de estoque vem antes de `const wholeWas = whole` e devolve false sem `version++`.
- Ramos de agentes não mesclados em `main` (worktrees em `.claude/worktrees/`): `a432aff…` LOD (3
  commits, base a08cb68); `a9b9ac5…` sombras em degrau (1, base 1f539e2); `aece52d…` sobreposição
  dos lotes (3, base 8ddba37); `a5fbde5…` vãos das zebras (3, base b8c63c3); `a799a55…` sinais e
  topologia (3, base b8c63c3); `a84faa1…` BufferAttribute (1, base 2afa140); `aa3046a…`
  churrasqueiras (1, base b8c63c3). Com arquivos não commitados: `a56be88…` câmera (9), `a5fbde5…`
  (4), `a976623…` (5), `ab4e4e8…` (5), `af5ce5d…` (3), `a17828c…` (1), `adf464a…` (1).
- Stashes: 7 (`git stash list`), todos de trabalho parado.
- `.githooks/pre-push` e o `launch.json` da pasta `.claude` apagados pelo jogador: nunca commitar a deleção nem
  restaurar.

## Servidores e máquina
- No ar (netstat, 2026-10-14 noite): 5300 (árvore principal, `npm run dev`), 5301 (cópia congelada
  `probe-tree` da sessão 19e8abda), 5312 (cópia da Hook em `%TEMP%/rc2-hook/sonda`; a Hook disse que
  parou e não parou).
- **Portas do jogador, nunca sondar nem apagar dados**: 4180, 4181-4183, 5173, 5175-5178, e a pasta
  `C:/Codex-Shared/backup-mapa-jogador`.
- Cada conversa roda na própria fatia (`scripts/sessionJob.mjs`: 25% da CPU, 8 GB).

## Medida de referência
Cidade semente 1, fatia de 25% (`roadcraft-look/2026-10-14T20-33-55-428Z/relatorio.json`): quadro p50
50,3 ms, p95 116,7 ms; passo da simulação p50 18,8 ms; governador com `share` 0,52. Perfil
(`2026-10-14T20-21-01-230Z/10-sim.cpuprofile`): desenho 44,4%, passo da simulação 28,4%.

Detalhe do que já foi feito: `memory/FEITO.md`. Histórico: `memory/DIARIO.md`.
