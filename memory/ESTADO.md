# Estado do trabalho — reescrever a cada mudança (não acumular)

Atualizado: 2026-10-14 (noite). A versão longa anterior está no git (`git show 8ddba37:memory/ESTADO.md`).

## Quem trabalha
- Uma conversa só, "Análise de otimização e desempenho do jogo", com agentes só de leitura
  (ordem do jogador, 2026-10-14). As sessões Auditoria e Hook foram encerradas nessa noite; o
  trabalho delas passou para esta conversa.

## Plano em vigor
`docs/PLANO-ESPINHA-2026-10-14.md` (aprovado pelo jogador em 2026-10-14). Fase 0 feita:
- verificador de "feito" (hook `agent` global no `Stop`/`SubagentStop`,
  `~/.claude/hooks/verificador-feito.md`, provado com `claude -p`: 5 casos em 13 rodadas); skill
  `lendo-o-codigo`; CLAUDE.md, ORDENS.md e as notas falsas de `src/editor`, `src/sim`, `src/world`;
  mensagens de check-code, knip e refs dizem "defeitos conhecidos ainda no código" (c18494b);
  falsos positivos do research-gate tirados (29 comandos conferidos); o trabalho da célula em
  worker lido inteiro (abaixo).
- próximo: fase 1 (bugs C7 independentes, cada um com teste que falha antes; segurança do
  `innerHTML` primeiro). O trabalho da célula em worker não entra em commit antes de corrigir os
  defeitos abaixo e medir a memória com a máquina livre.

## Repositório (conferido em 2026-10-14 noite)
- `main` 80 commits à frente de `origin/main` (`b8c63c3`); envio ao GitHub só com o sim do jogador.
- Não commitado na árvore principal (da Auditoria):
  `src/render/buildings/` `cell.worker.ts`, `cellArrays.ts`, `cellPool.ts`, `cellRequests.ts`,
  `cellWork.ts`, `chunk.ts`, mudanças em `buildingMesh.ts`, `layer.ts`, `layerCells.ts`,
  `townIndex.ts`; `tests/render/cellArrays.spec.ts`, `cellWork.spec.ts`. Lido inteiro em 2026-10-14
  noite (os seis novos, `layer.ts` 1-735, `layerCells.ts` 1-311, `townIndex.ts` 1-131, os dois
  testes, o diff de `buildingMesh.ts` e `uploads.ts` 1-232). Defeitos conferidos na linha:
  - `disposeLanded` (`cellRequests.ts:56, 94, 111`) solta malhas ainda na fila de `warmLooseAhead`;
    `warmOne` (`uploads.ts:172-205`) as desenha sem conferir: a geometria sobe de novo sem dono;
  - o caminho inteiro limpa `pendingCells` (`layer.ts:596`) sem largar os pedidos: eles contam no
    `STREAM_AHEAD` e o que pousa fica em `landed` sem ninguém tomar; `CellPool.cancel` só marca, o
    worker faz todas as rodadas (`cellPool.ts:98-100, 161-180`); `summarize` sem id, não cancela
    (`cellRequests.ts:98-100`);
  - pedido de resumo tira a célula de `released` (`cellWork.ts:160`): célula longe deixa de ceder
    primeiro as suas peças;
  - por quadro: `entriesOf` de cada célula pendente (`layer.ts:427`); `[...lista, b]` por prédio na
    fatia dos resumos (`layer.ts:453`);
  - `streamCells` citado em 6 comentários e inexistente (`layer.ts:332, 660, 666`;
    `layerCells.ts:63, 65, 109`); fórmula própria de chave de célula em `cellWork.ts:249`;
  - os testes só cobrem o caminho na página (`workers = false`); nada cobre cancelamento nem
    descarte. Relato da
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
