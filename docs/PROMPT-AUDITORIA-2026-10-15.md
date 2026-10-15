# Prompt — Auditoria SOMENTE DE LEITURA do Roadcraft 2 (2026-10-15)

Você é auditor. Sua tarefa é LER o código e dizer a verdade sobre o que procede. Responda em português do Brasil.

## Proibido
- NÃO edite, crie, apague, formate nem commite arquivo do projeto. Nada de `git add/commit/merge/checkout`, nada de `npm`, `vite`, `vitest`, `node scripts/look.mjs`, nem abrir o jogo. Só Read/Grep/Glob e Bash de leitura (`git log/show/diff`, `grep`, `sed -n`).
- Não toque nas portas 4180-4183, 5173, 5175-5178, 5300, 5351 nem em `C:/Codex-Shared/backup-mapa-jogador`.
- Não envie nada ao GitHub. Não proponha reduzir qualidade gráfica: apenas relate.
- Único arquivo que você pode criar: o seu relatório, `docs/RELATORIO-AUDITORIA-<data>.md` (nome novo, não sobrescreva os existentes).

## Contexto
Roadcraft 2: jogo de navegador de construir cidades (TypeScript, three.js r186, Vite). Meta: mapa de 10 km × 10 km de uma vez, sem custo O(mapa) por edição ou quadro. Código a auditar: worktree `C:/Codex-Shared/rc2-wt/workers-10km` (ramo `fix/workers-10km`). Leia antes: `C:/Codex-Shared/roadcraft-2/CLAUDE.md` (regras), `docs/PROMPT-OUTRA-IA-2026-10-15.md` (estado), `docs/AUDITORIA-2026-10-15.md` e `docs/relatorio-otimizacao-roadcraft2.md` (relatórios anteriores, que podem estar defasados). three.js offline: `C:/Codex-Shared/referencia/`.

Critério de "problema": custo O(mapa) por edição ou quadro; cache com teto que expulsa e refaz; trabalho pesado na thread principal; enviar à GPU o que não mudou; guardar na CPU o que já está na GPU; desenhar ou guardar o que não se vê; alocação por quadro em laço quente.

## Método (obrigatório)
Para cada item: leia o arquivo inteiro da função, siga o CHAMADOR até o quadro, a edição ou o ponteiro, e olhe os irmãos da mesma classe no projeto. Dê o veredito **PROCEDE / DEFASADO (já corrigido) / NÃO PROCEDE / NÃO CONFERIDO**, com `arquivo:linha` e o que leu. Nunca escreva "funciona" ou "já existe" sem ter lido o código que USA a coisa. Valores em bytes ou ms lidos do código são ESTIMATIVA: diga isso.

## Itens
**Sim/editor**
1. `src/editor/editRules.ts`: `snapshotRoads` faz `doc.clone()` (~114). O clone é copy-on-write (`src/core/forkMap.ts`, `RoadDoc.fork`) ou copia o mapa inteiro? Quem chama e quando (cada pausa do ponteiro ao desenhar via?). `changedSegments` (~143): quando o caminho de reserva que percorre todas as vias roda?
2. `src/editor/lotTool.ts` (~150): `JSON.stringify` do overlay inteiro por quadro com a ferramenta ativa; o custo cresce com o nº de lotes?
3. `Network.adopt`: copia o estado inteiro da rede por via? custo por edição versus tamanho do mapa.
4. `src/world/elevation.ts`, `lanelets`, `src/sim/agents/walk.ts` (~1247): varreduras do mapa, JSON/clone por chamada, alocações por quadro.
5. `src/sim/pipeline.ts` (~88-96, ~167): percurso dos controladores de sinal por tick; outra varredura O(mapa) por tick?
6. `src/render/ragdoll.ts`: `wallsNear` (~533) e `new Float32Array` (~1421, ~2034): frequência real.
7. Em todo `src/sim` e `src/editor`: `JSON.stringify/parse` em caminho quente, `structuredClone`, `[...map.values()]` por quadro, `new Float32Array/Array` em laço por quadro.

**Render**
8. `src/render/terrain.ts`: nenhum `addUpdateRange`, ~21 `needsUpdate = true` (~786, 902, 939, 1065, 1910, 2278, 2402, 2462). Para cada um: o que reenvia (buffer inteiro ou região), quando dispara, quantos bytes num mapa de 10 km (célula 6,4 m). As ~19 leituras de revisão global e o trecho ~3118 (`prebuilt`/`terrainStamps`).
9. `src/render/flatAtlas.ts`: `CACHE = 6` (~43, ~314-316), cache com teto que expulsa; as 9 leituras de revisão; o que é refeito quando algo volta.
10. `src/render/renderer.ts`: `coverSweep` (~2986) por revisão; `reach = Infinity` (~3196) e seu uso em `buildings/layer.ts`; transporte (`transitAreaOf`/`buildTransit` por revisão); névoa e ravinas por revisão do terreno; `natureTrees.ts update` e `buildGroundCover` reescritos pela lista inteira.
11. Céu (ordem de profundidade, overdraw) e GTAO com alvo de normais parado (`postprocess.ts`, `quality.ts`): procede?
12. Memória de vídeo: `gardens.ts` (`bushFlowering`, capacidade que dobra, arrays duplicados body/cards); atributos mortos no verge (`color`, `roadSection`); `structures.ts` e `vehicleModels` não indexados; onde Uint16 ainda não é usado (`new Uint32Array`, `setIndex`); soma, em bytes, dos render targets e mapas de sombra na qualidade máxima a 1920×1080 e se `inventory.ts`/`memoryCounters.ts` os contam.
13. Células de detalhe longe na GPU (`buildings/massCells.ts`, `layer.ts`): existe teto por orçamento de placa? O que acontece se o jogador percorrer o mapa todo?

**Dados/IO/main**
14. `src/editor/chunkedSave.ts`, `docImage.ts`: cópia, serialização ou reescrita total por salvamento/edição.
15. `src/conflictPool.ts` (~94-110): `catch` engolindo erro? quem trata a rejeição.
16. `src/render/profilerHooks.ts` (~39): hooks ligados mesmo com o profiler desligado? custo por quadro.
17. `src/main.ts` (~2864 e as 10 leituras de revisão): o que roda por quadro versus sob demanda.
18. Heap do JS por prédio (~100 KB, sem atribuição, e produtos do mapa: superfícies das vias, postes, junções, elevação): só por leitura de código, liste cada estrutura que o prédio e o mapa retêm (Map/Set/closures/arrays/strings/cópias), com tamanho estimado e o que pode ser compartilhado ou derivado. Sugira UMA forma confiável de medir (ex.: amostragem `HeapProfiler` via CDP), sem executá-la.

## Entrega
`docs/RELATORIO-AUDITORIA-<data>.md` com: (a) tabela item | veredito | evidência `arquivo:linha` | custo estimado (diga que é estimativa) | gravidade para 10 km | a correção certa em UMA frase (sem implementar); (b) lista dos achados NOVOS que não estavam nesta lista; (c) lista do que você NÃO conseguiu conferir e por quê; (d) ordem recomendada de correção. Sem elogio, sem plano burocrático: só fatos verificados.
