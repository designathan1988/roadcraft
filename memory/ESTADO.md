# Estado do trabalho — reescrever a cada mudança (não acumular)

Atualizado: 2026-10-14 (noite). A versão longa anterior está no git (`git show 8ddba37:memory/ESTADO.md`).

## Quem trabalha
- Uma conversa só, "Análise de otimização e desempenho do jogo", com agentes só de leitura
  (ordem do jogador, 2026-10-14). As sessões Auditoria e Hook foram encerradas nessa noite; o
  trabalho delas passou para esta conversa.

## Plano em vigor
`docs/PLANO-ESPINHA-2026-10-14.md` (aprovado pelo jogador em 2026-10-14). Fase 0 em curso:
- feito e provado: verificador de "feito" (hook `agent` global no `Stop`/`SubagentStop`,
  `~/.claude/hooks/verificador-feito.md`, provado com `claude -p`: 5 casos em 13 rodadas); skill
  `lendo-o-codigo`; CLAUDE.md, ORDENS.md e as notas falsas de `src/editor`, `src/sim`, `src/world`;
- falta: linha de base deixa de ser aceite; falso positivo do research-gate; ler inteiro o trabalho
  não commitado da célula em worker; depois a fase 1 (bugs C7, innerHTML primeiro).

## Repositório (conferido em 2026-10-14 noite)
- `main` 80 commits à frente de `origin/main` (`b8c63c3`); envio ao GitHub só com o sim do jogador.
- Não commitado na árvore principal (da Auditoria, a ler inteiro antes de qualquer decisão):
  `src/render/buildings/` `cell.worker.ts`, `cellArrays.ts`, `cellPool.ts`, `cellRequests.ts`,
  `cellWork.ts`, `chunk.ts`, mudanças em `buildingMesh.ts`, `layer.ts`, `layerCells.ts`,
  `townIndex.ts`; `tests/render/cellArrays.spec.ts`, `cellWork.spec.ts`. Defeitos já achados nele:
  `disposeLanded` × fila de aquecimento; pedidos não cancelados no caminho inteiro. Relato da
  Auditoria, NÃO conferido: geometria na CPU 692 MB contra 364,6 MB do código antigo (cascas do
  worker presas na CPU?), medida com a máquina carregada e contexto WebGL perdido; mensagem de
  commit pronta em `%TEMP%/claude/C--Codex-Shared-roadcraft-2/ed3156c1-*/scratchpad/commit-celulas.txt`.
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
