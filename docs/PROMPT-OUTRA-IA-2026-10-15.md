# Prompt para outra IA — Roadcraft 2: cidade de 10 km × 10 km (2026-10-15)

Você vai assumir um trabalho de engenharia de desempenho num jogo de navegador. Leia tudo antes de agir.
Responda ao jogador sempre em português do Brasil; código, comentários, testes e mensagens de erro em inglês.

## 1. O projeto
Roadcraft 2: jogo de construir cidades no navegador (TypeScript, three.js r186, Vite), a ser vendido na Steam.
Repositório: `C:\Codex-Shared\roadcraft-2` (ramo `main`). Leia primeiro o `CLAUDE.md` da raiz: é o ÚNICO arquivo
de instruções (não crie outro). Comandos: `npm run dev` (127.0.0.1:5300), `npm run check`,
`node scripts/look.mjs <roteiro.json>` (fotos no Chrome instalado, 1920×1080), `node scripts/acusar.mjs`,
`node scripts/check-code.mjs`, comandos pesados por `node scripts/run-limited.mjs …`.
Documentação do three.js offline: `C:/Codex-Shared/referencia/`.

## 2. Objetivo
Mapa inteiro de 10 km × 10 km gerado de uma vez, com desempenho e qualidade gráfica excelentes em máquinas
diferentes; depois, cidade sem limite. Hoje o mapa fixo é 5 × 5 placas de 2.048 m.

## 3. Regras do jogador (inegociáveis)
- "Corrigido" = o código não tem mais o problema (algoritmo e dados certos para cidade de qualquer tamanho).
  Tempo que caiu numa cidade de teste não é correção; número não é meta.
- PROIBIDO amortizar: fatiar em quadros, segurar uma camada, cache com teto que expulsa e refaz, espaçar
  refeituras. Corrija a causa.
- Trabalho pesado fora da thread principal (worker). Não desenhar nem guardar o que não se vê (nível de
  distância; sem cópia na CPU do que já está na GPU). Nada de esperar a GPU no meio do quadro nem compilar
  shader durante o jogo.
- Derivados leem o diário (`world/changes.ts`: `doc.changes.since`/`touches`), nunca uma chave de revisão global.
- Nenhuma perda de qualidade gráfica sem o sim do jogador: fotos antes e depois, nas mesmas vistas.
- Nunca enviar ao GitHub sem o sim dele. Nunca mexer nas portas 4180-4183, 5173, 5175-5178 nem em
  `C:/Codex-Shared/backup-mapa-jogador`. Nunca `rm -rf` em worktree (tem junção com `node_modules`): use `rmdir`.
- Mudança de arquitetura: comunique e peça autorização antes. Não faça tentativa e erro: se não souber, PESQUISE
  na documentação oficial na internet.
- Cada correção com commit próprio (causa, técnica, fonte; mensagem em português) e linha em `OTIMIZACAO.md`.
  Teste uma vez no fim de cada bloco, não a cada passo. Diga a verdade sobre o que não conferiu.
- Supervisione toda execução da cidade: timeout duro e conferência ao vivo. Não rode a cidade repetidamente:
  faça todas as modificações primeiro, depois meça.
- Não toque no trabalho não commitado de outro agente na pasta principal: `src/editor/commit.ts`,
  `src/world/changes.ts`, `src/world/doc.ts`, `src/core/layeredMap.ts`, `tests/core/layeredMap.spec.ts`,
  os `.claude/*` apagados e `.githooks/pre-push`.

## 4. Onde está o trabalho
Worktree `C:\Codex-Shared\rc2-wt\workers-10km`, ramo `fix/workers-10km` (NÃO está no `main`; o jogador pediu
juntar só quando o pacote completo estiver resolvido). Outros worktrees em `C:\Codex-Shared\rc2-wt\`;
`fix/growth-worker` (tip 9f18b76) NÃO foi mesclado. Sondas e logs em `C:/Codex-Shared/rc2-wt/probe-out/`
(spikes*.log, cpuprofile, suite*.log, fotos/). Servidor de sondas: `vite.probe.config.ts` na 127.0.0.1:5351
(salvar qualquer arquivo ali recarrega a página e mata as sondas em andamento). Sondas Playwright
(`invprobe.mjs`, `spikes2.mjs`, `heapprobe.mjs`, `gpubreak*.mjs`) estão na raiz do worktree, não versionadas.
O Chromium do Playwright não abre nesta máquina: use `channel: 'chrome'`. O jogo expõe `__roadcraft`
(hook `inventory:` em `main.ts`, `src/render/inventory.ts`).

## 5. O que já foi feito (no ramo `fix/workers-10km`, a maior parte mesclada nele)
- Workers com buffers transferíveis: pools de ladrilhos de via (`RoadTilePool`, `roadTile.worker.ts`), conflitos,
  células, formas do chão, baias; topologia, chão, primeiro grafo; entradas de superfície por item;
  `doc-fork` (copy-on-write, `src/core/forkMap.ts`).
- Muitas buscas O(mapa) trocadas por índice: `idsMeetingAny`, `landscapeInAny`, `barriersInAny`, `nearAny`
  (grade e `store` de prédios), usadas em renderer, jardins, câmera, estacionamento, barreiras, placas,
  transporte, rede, calçadas, mobiliário.
- Superfícies das vias: `flipToDelaunay` (Lawson) em `tileShape.ts` (rampa 320→156 triângulos, 0 lascas),
  `weldVertices` exato em `tileMesh.ts`, nível distante por bloco (meshoptimizer `simplifyWithAttributes`, feito
  em worker) e residência (`roadLod*.ts`, `roadResidency.ts`): geometria na GPU −41%. Fotos antes/depois sem
  diferença visível.
- Arrays de CPU de massas liberados após o upload (`mesh/gpuOnly.ts`), aquecimento de upload isolado (`uploads.ts`).
- A* em `sim/agents/walk.ts`; blob de desgaste por `:wear:N` em `chunkedSave.ts`; `yawMatrixInto` em jardins.
- Inventário completo da cena (malhas, vértices, triângulos, bytes GPU/CPU por camada e tipo, bandeiras).
- Três edições prontas SEM commit: `src/sim/pose.ts` (`pedPoseInto`), `src/render/agents.ts`,
  `src/render/buildings/cellArrays.ts` (`indexArray` Uint16/Uint32), `tests/render/cheapAudit.spec.ts`,
  `scripts/check.mjs` (ALWAYS += cheapAudit). tsc/eslint limpos; 122 arquivos / 437 testes passaram.

## 6. Estado atual e problemas ABERTOS (os que a IA anterior não resolveu)
1. **Muralha do heap do JS: ~100 KB por prédio**, sem atribuição. Heap pós-GC 3,0–3,2 GB aos 2.560 m; em 66 s
   chega a 3,4 GB com zero prédios (superfícies das vias ~250 MB, postes ~106 MB, junções ~62 MB, elevação ~37 MB).
   Snapshots de heap (`snap10k.mjs`/`snapRead.mjs`) se mostraram não confiáveis (travam/vazios); falta uma
   atribuição que funcione (contadores por estrutura, ou amostragem `HeapProfiler` via CDP).
2. **Crescimento da cidade na thread principal** (~22 s da geração de 2.560 m). O worker de crescimento
   (`fix/growth-worker`) ficou MAIS LENTO e causou perda de contexto WebGL a 2.560 m; não mesclado, sem decisão.
3. **Terreno sem `addUpdateRange`** (0 usos vs ~21 `needsUpdate = true` em `terrain.ts`): edição pequena reenvia o buffer.
4. **`flatAtlas.ts` `CACHE = 6`** (linhas ~314-316): cache com teto que expulsa e refaz (viola o CLAUDE.md).
5. **`lotTool.ts` ~150**: `JSON.stringify` do overlay inteiro por quadro com a ferramenta ativa.
6. **`editRules.ts`**: `snapshotRoads` ainda faz `doc.clone()` (não verificado se o fork evita a cópia total);
   `changedSegments` tem caminho de reserva que percorre todas as vias.
7. **`Network.adopt`** copia o estado inteiro da rede por via (~3 ms, cresce com o mapa).
8. **Ainda O(mapa) por mudança**: transporte (`transitAreaOf`/`buildTransit` por revisão), névoa e ravinas por
   revisão do terreno, florestas/cobertura reescritas inteiras (`natureTrees.ts update`, `buildGroundCover`),
   `coverSweep` por revisão (`renderer.ts` ~2986); `terrain.ts` (19 leituras de revisão), `flatAtlas.ts` (9),
   `main.ts` (10) por converter; derivados fora do motor (`core/engine.ts` só tem os da fase `draw`); trava ESLint
   contra revisão global não existe.
9. **Memória de vídeo**: células de detalhe longe ficam na GPU e crescem com a área visitada (falta teto por
   orçamento de placa, sem refazer o que volta); jardins (`bushFlowering` 52+52 MB, capacidade que dobra, arrays
   duplicados body/cards); atributos mortos no verge (`color`, `roadSection`); vértice de 56 B (quantizar para
   ~30 B); paredes/saias = 62–68% dos vértices de verge/calçada/meio-fio; `structures.ts`/`vehicleModels`
   não indexados; Uint16 ainda não aplicado em todo lugar; `reach = Infinity` (`renderer.ts` ~3196) a verificar.
10. **Decisões que exigem o sim do jogador com fotos**: MSAA, tamanho do mapa de sombra, redução de saias.
11. **Itens do último relatório de 26 pontos NÃO verificados** (verificados: os de 3–6 acima): `elevation.ts`,
    `lanelets.ts`, `walk.ts:1247`, `chunkedSave.ts`/`docImage.ts`, `conflictPool.ts` (catch), `profilerHooks.ts`,
    `main.ts` ~2864, ordem de profundidade do céu (arriscado), GTAO com alvo de normais parado, alocações do
    ragdoll (`wallsNear`, `Float32Array` por chamada).
12. **Integração final**: ao mesclar no `main`, reconciliar `src/core/forkMap.ts` (doc-fork) com o
    `layeredMap.ts` não commitado do outro agente — escolher um, nunca apagar o do outro.

## 7. O que já foi tentado e NÃO funcionou / lições
- Medir repetidamente sem corrigir irritou o jogador; ele quer código resolvido, não métrica.
- Fatiar em quadros/segurar camada: proibido e rejeitado.
- Simplificação do nível distante na thread principal atrasou o mundo (42 s contra 26–29 s): foi para o worker.
- Worker de crescimento: mais lento + perda de contexto WebGL (não mesclado).
- Heap snapshots em headless: travaram ou vieram vazios (processos concorrentes); processos velhos precisam ser
  mortos antes (PowerShell). Não confie neles sem validar.
- Série de fotos contaminada por comando antigo ainda rodando e revertendo arquivo; fotos de "esquina" no lugar
  errado (rampas reais em (-50,25) e (52,29), de `curbRamps`).
- Inventário contava blocos expulsos (corrigido). Testes mal calibrados (faixa que preenche o bloco travando a borda).
- Relatórios externos (`docs/AUDITORIA-2026-10-15.md`, `docs/relatorio-otimizacao-roadcraft2.md`, relatório de
  26 itens): a maioria procede (5 de 6 afirmações-chave), mas "ladrilhos na CPU" já estava defasado. Verifique
  cada afirmação no código antes de agir.

## 8. Como trabalhar
1. `git status` nos dois checkouts; nunca commite caminhos de outro agente (`git commit --only <caminhos>`).
2. Commite primeiro as edições pendentes da seção 5 (mensagem em português, com
   `Co-Authored-By: <seu modelo> <noreply@anthropic.com>`), linha no `OTIMIZACAO.md`.
3. Ataque, nesta ordem: (1) atribuição e redução do heap por prédio; (2) terreno `addUpdateRange` + carimbos do
   worker; (3) cache do `flatAtlas` sem expulsão; (4) chave do `lotTool`; (5) crescimento fora da página (decida
   com dados o que fazer com `growth-worker`, e peça autorização se for mudar arquitetura); (6) O(mapa) restantes
   do item 8; (7) VRAM/quantização/atributos mortos; (8) itens do relatório ainda não verificados.
4. Pesquise a técnica na fonte oficial antes de usar (three.js `BufferAttribute.addUpdateRange`, V8 heap
   profiling/CDP `HeapProfiler.startSampling`, meshoptimizer, Rendering on Demand).
5. Só no fim do bloco: `tsc --noEmit`, `eslint src tests scripts`, `node scripts/check-code.mjs` (compare as
   linhas "novo:"), suíte `vitest`, UMA medição supervisionada com timeout, fotos antes/depois de qualquer mudança
   visual. Entregue um relatório em português dizendo o que mudou, o que mediu e o que NÃO conferiu.
