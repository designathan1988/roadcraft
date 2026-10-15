# Relatório de auditoria somente de leitura — 2026-10-15

Código: worktree `C:/Codex-Shared/rc2-wt/workers-10km`, ramo `fix/workers-10km`, HEAD `1b36572`.
O worktree tem alterações não commitadas de terceiros (`src/editor/lotTool.ts`, `src/render/flatAtlas.ts`, `.mjs` soltos na raiz).

**Método e limites.** Três leituras independentes (sim/editor, render, dados/main/heap), todas só de código. Nada foi executado nem medido: **todo byte e ms abaixo é ESTIMATIVA** feita por aritmética sobre o código. Reconferi eu mesmo, no código, cinco pontos-chave: `snapshotRoads` com `doc.clone()` (`editRules.ts:113-119`), `reach = Infinity` em perspectiva (`renderer.ts:3196`) e `Number.isFinite(reach)` em `layer.ts:656`, `JSON.stringify(doc.withoutBuildings())` (`chunkedSave.ts:179`), `splice(..., ...after)` (`docImage.ts:194`) e `hookProfiler` incondicional (`main.ts:707`). Os demais veredictos vêm das leituras dos agentes (arquivo:linha por eles lidos) e não foram relidos por mim.

Gravidade = para o mapa de 10 km × 10 km.

## (a) Tabela

| # | Item | Veredito | Evidência | Custo estimado | Grav. | Correção certa (uma frase) |
|---|---|---|---|---|---|---|
| 1 | `snapshotRoads` / `doc.clone()` | PROCEDE | `editRules.ts:113-119`; `doc.ts:1844-1890` (clone copia tudo, JSON de pessoas e transporte); COW é só `fork` (`doc.ts:1669`); chamado por `guardRoadEdit` (`editRules.ts:127-140`, `main.ts:859-868`) a cada edição de via no lugar. Desenhar via usa `fork` (`commit.ts:125-127`), não paga | O(nós+segmentos+postes+árvores+pessoas+transporte) por edição; dezenas de ms | Alta | Trocar o snapshot por `doc.fork()` e guardar o desfazer como os registros escritos |
| 1b | `changedSegments` reserva | NÃO PROCEDE (uso atual) | `editRules.ts:143-168`, reserva 163-166 só sem relação fork/clone; 4 chamadores passam documentos relacionados | — (risco latente O(vias)+JSON) | — | Remover o caminho de reserva ou torná-lo erro |
| 2 | JSON do overlay de lotes por quadro | DEFASADO | `lotTool.ts` `liveKey` 168-180 (chave curta), `overlayKeyed` 131-157. Resta `overlay(true)` 668-740 percorrendo `doc.lots` inteiro a cada mudança de hover | O(lotes) por movimento do ponteiro | Média | Overlay só do que está perto (`lotsIn`) e o resto em camada estática por diário |
| 3 | `Network.adopt` | PROCEDE | `network.ts:270-307`; `networkBuild.ts:172-195` (~14 `new Map`), `cells.ts:189-198`; chamado em `commit.ts:125-130` (cada pausa ao desenhar), `commit.ts:385-407` (**duas vezes** por commit) e `guardRoadEdit` | ~20 estruturas O(vias+nós+células); 10⁵–10⁶ inserções por edição | Alta | Fork da rede em camadas (`ForkMap`) e `adopt` aplicando só o que o fork escreveu |
| 4a | `elevation.ts` | PROCEDE | `elevation.ts:456-540, ~802-815, ~1088`; chamadores `renderer.ts:1860`, `commit.ts:232,305`, `editRules.ts:104,240-241` | O(vias) por solução, com strings e Maps | Média/alta | Índice espacial, `incident`, `nodeKeys` e resumos persistentes atualizados pelo diário |
| 4b | `lanelets.ts` | NÃO PROCEDE | `lanelets.ts:241-330` usa `changesSince`; construção inteira só em carga | — | — | — |
| 4c | `walk.ts` (~1247) | NÃO PROCEDE | `anyoneWithin` usa grade por tick; scratch reutilizado `810-824, 1704-1727` | O(pedestres) por tick | Baixa | — |
| 5 | `pipeline.ts` por tick | PROCEDE em parte | `pipeline.ts:90-97` (controladores adormecidos recebem `restController`); `world.ts:881-899` (`stepControlAdvisor` varre todas as junções a cada 10 s = espaçamento); `world.ts:534-556` `refreshJunctionOrder` por edição | O(junções com sinal) por tick; O(junções) a cada 10 s e por edição | Baixa/média | Guardar o instante de adormecer; conselheiro por lista suja; ordem de junções por diferenças |
| 6a | `ragdoll.ts` `wallsNear` | NÃO PROCEDE | `ragdoll.ts:533`; só no spawn, via `buildings.near` indexado (`playEffects.ts:256-300`) | O(prédios perto) por morte | — | — |
| 6b | `ragdoll.ts` `new Float32Array` | PROCEDE | `ragdoll.ts:1368-1423, 2024-2058`: aloca por quadro e por corpo ativo; limitado a explosões. `playEffects.ts:~240`: `ragdollGround.clear()` acima de 60 000 (cache com teto, só no evento) | Rajada de GC | Baixa | Reusar buffers e matrizes por corpo |
| 7 | JSON/clone/`[...values()]`/typed arrays em sim+editor | PROCEDE em poucos pontos | `src/sim`: nenhum JSON. `lotTraffic.ts:156,269`, `lorryTraffic.ts:136,247` cópias por tick (O(carros/caminhões)); `chunkedSave.ts:179` (ver 14); demais frios/por evento (lista no relato de sim) | Baixo | Baixa | Iterar sem copiar nos três pontos quentes |
| 8 | `terrain.ts` `needsUpdate`/`addUpdateRange` | DEFASADO em parte; PROCEDE no resto | `mesh/updateRanges.ts` `markBox`; faixas em `terrain.ts:2280, 2410, 2516-2517, 3168`. **Inteiro:** `markAll` 2193, 2464, 3137-3142, 3169 (~5,35 MB/placa + `computeVertexNormals` de 204 800 triângulos); textura shore 787 (1,65 MB/placa a cada `rebuildWater` e pincelada de cobertura); `applyEcology` 2655 (412 kB + laço de 103 mil cantos); camadas `paintArray` 2828/2854/2963 (limite do three: camada inteira, 1–4 MB); `markBox` = bbox, uma via diagonal vira quase a placa inteira | Por placa (321² cantos): position/normal 1,24 MB cada, índice Uint32 2,46 MB, shore 1,65 MB | Média | Faixa por linha (mín/máx), não bbox; faixas também para shore/ecologia |
| 8b | Leituras de revisão do terreno | DEFASADO | ~6 reais sobre `PlateSource` (2901-2902, 2912-2913, 3102-3107); o resto são contadores próprios | — | — | — |
| 8c | `prebuilt`/`terrainStamps` (~3125) | PROCEDE | `terrain.ts:~3125` `made = firstBuild && prebuilt && terrainStamps.length === 0`; `plateMesh.ts`/`flatGroundPool.ts` não recebem carimbos | Um carimbo na placa → `rewrite` inteiro + `chooseDiagonals` na página (~35 ms por placa, comentário do código) e perde as `woods` (167 mil células) | **Alta** | Mandar os carimbos locais da placa ao worker (o `PlateMesh` é função pura dos cantos) |
| 9a | `flatAtlas.ts` `CACHE = 6` | DEFASADO | A constante não existe; `flatAtlas.ts:42-49` `KEEP_MARGIN`, `refresh` 319-324, `keepReach` 532-536, `letGo` 287-296 | Solta placa fora de alcance e **refaz tudo ao voltar** (~14 MB de heap por placa) | Média | Residência por orçamento de bytes, mantendo o `PlateMesh` na CPU |
| 9b | Placa com conteúdo sem nível de distância | PROCEDE (novo) | `flatAtlas.ts:307-310`; `FAR_QUADS = 32` só para placas sem conteúdo | 25 placas × 204 800 triângulos ≈ 5,1 M triângulos; ~300–550 MB VRAM e ~350 MB heap | **Alta** | LOD contínuo (quadtree + geomorphing) também para placa com conteúdo |
| 9c | Pintura percorre 25 placas por revisão | PROCEDE (novo) | `flatAtlas.ts:435-445` `terrainPaint.filter` (até 60 000 dabs), sem diário/retângulos | O(placas × dabs) por pincelada | Média/alta | Diário com retângulos também para a pintura |
| 10a | `coverSweep` (~2986) | PROCEDE | `renderer.ts:1126-1135, 2270-2284, 2547, 2590-2606, 2982-2986` (caixa unida de dabs; itera toda célula; chave `forestRevision:waterRevision` soma `shownVersion×1e6`, flatAtlas 622) | ~0,7 M + ~18 M + ~10 M de células por varredura com pintura em dois cantos; ~11 M para margem de água | **Alta** | Varrer por célula do índice espacial das dabs, com chave por placa |
| 10b | `reach = Infinity` (~3196) | PROCEDE | `renderer.ts:3196-3201` (finito só em ortográfica); `layer.ts:656` `Number.isFinite(reach)` → sem residência em perspectiva (conferido) | Células de detalhe ficam na GPU para sempre | **Alta** | Residência por bytes valendo em perspectiva (ver 13) |
| 10c | Transporte `transitAreaOf`/`buildTransit` | DEFASADO | grep 0; `transit.ts:264-296` `Derived` por diário; registro `renderer.ts:1756-1778` | Resíduo: `tracks.find` por id | Baixa | — |
| 10d | Névoa | DEFASADO | `renderer.ts:3511-3530`, `fogLayer.ts:125-136` retângulos + `addUpdateRange` | — | — | — |
| 10e | Ravinas | DEFASADO | `setGullies() {}` vazio em `terrain.ts` e `flatAtlas.ts` | — | — | — |
| 10f | `natureTrees` / `buildGroundCover` | PROCEDE (leitura) / DEFASADO (escrita do ground cover) | `buildGroundCover` sem chamador; mas `natureSweep` devolve array novo (`renderer.ts:2359`), `fresh` (3045) → `CandidateKeep` com `changedNow` nulo → `sync(null)` reescreve todas as células; chave 3034 muda com qualquer placa | ~71 mil árvores reavaliadas com 25 placas; 17–27 ms (comentário 3040-3043) | **Alta** | Manter o `CandidateKeep` entre varreduras e trocar só a fatia das placas cuja chave mudou |
| 10g | Fatiamento da natureza (2397-2400) | PROCEDE | 1 placa por quadro na thread principal (167 mil células) | — | Média | É a amortização que as regras proíbem; mover ao worker |
| 11a | Céu com overdraw | NÃO PROCEDE | `renderer.ts:3266-3270` `skyMesh.visible = false`, fundo liso; `environment.ts:351-357` | — | — | — (PMREM não conferido) |
| 11b | GTAO com alvo de normais parado | NÃO PROCEDE (como VRAM) | `postprocess.ts:287,298` `setGBuffer`; three r186 só aloca no primeiro `setRenderTarget` (não medido) | Só um objeto JS | — | — |
| 11c | GTAO: passes | PROCEDE | `GTAOPass.js ~571-579`: cópia + blend em resolução cheia; só em high/ultra (`quality.ts:133,158`) | ~4,1 Mpx/quadro a 1080p (o 9,3 Mpx da auditoria anterior não foi reconferido) | Baixa/média | AO em meia resolução amostrado no passe do canyon |
| 12a | `gardens.ts` | PROCEDE (memória) | `gardens.ts:116, 141-144, 356, 364, 450-475, 582`: buffer de instâncias do tamanho de **toda** a cidade; só as plantas em vista são escritas; cópias pack+mestre+array CPU+GPU, body e cards | ~820 B/planta (estimativa); com premissa **minha** não conferida de 960 mil plantas ≈ 790 MB (≈220 MB VRAM). O dobrar de capacidade é amortizado (tempo ok) | Alta (heap) / média (VRAM) | Buffer pelo máximo visível e derivar esferas/matrizes do `GardenPack` |
| 12b | Atributos mortos | PROCEDE (classe maior que o verge) | `color`/`roadSection` lidos só por asphalt, asphaltRaised, footway (`materials.ts:423-426, 439-441`); `surfaceTiles.ts:19-22, 55-56` criam 24 de 56 B/vértice (43%) em todas as vias | Maior camada de geometria; também infla worker, LOD e hash do `weldVertices` | **Alta** | `SurfaceSpec` declara se usa tint/section e só essa faixa ganha os atributos |
| 12c | `structures.ts` / `vehicleModels` | PROCEDE | `structures.ts:412-427` (6 vértices/quad, −27% se indexado); `vehicleModels.ts:298,307` `toNonIndexed` + merge | Memória constante nos veículos; 3× vértices no shader | Baixa | `mergeVertices` após o merge; extrusões indexadas |
| 12d | Uint16 que sobrou | PROCEDE | Células já feitas (`cellArrays.ts:127-129`). Sobra pequena (~1 MB): `elements.ts:90-96,135`, `cookedPerson.ts:168,186`, `flatAtlas.ts:108,174`, `buildingMesh.ts:3457,3545`. `memoryCounters.ts:50` e `inventory.ts:121` usam `count*itemSize*4` mesmo para array solto → superconta 2× os Uint16 | Baixo + contagem errada | Baixa | Contar pelo `array.byteLength` real |
| 12e | Alvos de render + sombra (ultra, 1920×1080) | PROCEDE (não contado) | Conta abaixo; `perfBudget.ts:196` orçamento 300 MB; `inventory`/`memoryCounters` não somam alvos nem `light.shadow.map` | ~449 MB (DPR 1), ~841 MB (1,5), ~1,39 GB (2) — ESTIMATIVA | Média | Somar lista explícita de alvos × amostras + `sun.shadow.map` |
| 13 | Células de detalhe longe | PROCEDE | `layer.ts:644-668` (residência só se `isFinite(reach)`, conferido), `renderer.ts:3196-3201`; massas L1 `massCells.ts:124-273` sem teto | Perspectiva: sem teto → ~1 764 células de 240 m; massa L1 extrapolada ~1,9 GB contra 120 MB de orçamento (extrapolação linear de um número de segunda mão) | **Alta** | Residência por bytes (`bytesByName`) em perspectiva e um nível HLOD acima da massa |
| 14a | `chunkedSave` cabeça | PROCEDE | `chunkedSave.ts:133` (`dirtyHead`), `:179` `JSON.stringify(doc.withoutBuildings())` conferido; `persistence.ts:270-295` só espaça | O(vias+lotes+árvores+terreno+pessoas+transporte) por edição não-prédio, na thread principal | **Alta** | Cabeça em partes por tipo do diário; regravar só a parte que mudou |
| 14b | `DocImage` | PROCEDE | `src/world/docImage.ts:111-120` (`structuredClone` de todo o documento, dobra o heap); `:181-196` listas O(N) por commit e clone duplicado (`:192,194`); `:194` `splice(..., ...after)` conferido — risco de `RangeError` com ~10⁵ itens (não executado) | Heap ×2 das partes não imutáveis | Média | Listas identificadas por id e clone por referência/COW |
| 15 | `conflictPool.ts` `catch` | NÃO PROCEDE | `:283-287` `console.warn` + `broken`; tratado por `answered()` (`waiting.ts:14-17`) e `chooseTurns` (`sim/world.ts:679-682`). Ressalvas: uma falha quebra o pool até recarregar e joga ~3,4 s para a thread principal só com aviso; `:111` `rings.get(...)!.centre` fora do Promise | Robustez, não custo | Baixa/média | Reiniciar a lane com backoff e contar no profiler |
| 16 | `profilerHooks.ts` | PROCEDE | `main.ts:707` incondicional (conferido); `profiler.ts:88` `enabled = true`; closure com `...a` por chamada GL; `new Error().stack` nas 48 primeiras/quadro, depois 1/16 | ~0,5–2,5 ms/quadro com ≥48 uploads (estimativa, sem medida) | Baixa/média | Instalar hooks e observers só com a HUD aberta |
| 17 | `main.ts` revisão/quadro | NÃO PROCEDE como O(mapa) | 8 leituras (não 10): `:479,574,890,914,930,2166,2788,2806`; por quadro só `:2806` e `:2788`, O(1); `net.rebuild()` incremental (`network.ts:204-212`). Amortização restante: `growCity` em fatias de 100 ms (`:2200-2230`) | Baixo | Baixa | `growCity` no worker, sem fatiar |
| 18 | Heap por prédio / mapa | PROCEDE (sem atribuição) | Ver seção abaixo | ~35–90 KB lidos vs ~100 KB observados (soma de estimativas) | Alta | Medir antes de cortar (método abaixo) |

### 12e — conta dos alvos (ESTIMATIVA, qualidade `ultra`)

Bytes por pixel renderizado: cena MSAA 8× 108 (64 cor + 32 prof. + 8 resolvida + 4 prof. resolvida) + composer 16 + sharpMask 1 + nuvens 4 + GTAO meia res. 4 + SMAA 16 + bloom (mip 0) 2 = **~151 B/px**. Sombra 4096²: 64 MiB cor RGBA8 (existe, não amostrada) + 64 MiB profundidade ≈ 134 MB; sombra de nuvens 512² ≈ 2 MB.

| pixelRatio (`renderer.ts:2167,2185`, `min(DPR, quality)`) | Alvos | + sombra | Total |
|---|---|---|---|
| 1 | 313 MB | 136 MB | ~449 MB |
| 1,5 | 705 MB | 136 MB | ~841 MB |
| 2 | 1 252 MB | 136 MB | ~1,39 GB |

Não incluí mipmaps nem o atlas de impostores (`farForest.ts:247`) nem o alvo de paleta da multidão (`crowdAnimation.ts:297`).

### 18 — o que o prédio e o mapa retêm (leitura; tamanhos ESTIMADOS)

Por prédio:
1. Registro `Building` (`store.ts:67`): ~7 KB de JSON ≈ 15–25 KB de objeto JS; mapas `bays` com chave string `"lado:índice"` (poderia ser Int8/enum).
2. Referências ao mesmo registro em ~15 Maps/Sets (`sent`, `kept`, `lastShown`, `groundDigests`, `flagsOf`, `TownIndex`, `filed`, `sites`, `lotFiling`…): ~1 KB.
3. `WeakMap`s por registro, ~8–12 KB: `STORED_BOUNDS` (`geometry.ts:278`), `GROUND_BAYS` (`geometry.ts:623`, Float64Array 1–4 KB), walls (`parking.ts:69`, anéis de `{x,y}`), footprints do `CoverIndex` (`layerCells.ts:149-156`, ~3 KB), `DOORS`, `SIGNATURES`, pads. Os anéis existem em 3 listas: compartilhável.
4. `Kept.lot` (`layer.ts:692,700` → `lotGroundAgain`, `buildingMesh.ts:1899-1933`): closure com **cópia resolvida do prédio**, 5–30 KB, lazy, retida até o prédio sair. Guardar só anéis e alturas.
5. Jardim: `GardenPlant[]` ~100–120 B/planta + item 12a.
6. Sim: objetos `Bay` por vaga (`parking.ts`), ~2–15 KB por lote.
7. **Não lidos:** `sim/city` lots, `people/occupants`, `cameraSolidsKeeper`, `canyonLight`, `regionIndex`, `BuildingGrid`, `floorBoxes`/`bankBoxes`.

Produtos do mapa (estrutura lida, sem tamanho estimado): `SurfaceInputs` (`roadSurfaceInputs.ts:190-204`, `Map<string,Set<Entry>>` por tile e passe), `Network` (ribbons, polylines, trims, junctions, plateReach), tabelas de conflito (288 B por par, `conflictTable.ts:265`), lanelets, walkways, postes, elevação resolvida, placas do terreno (~14 MB de heap por placa, número da auditoria anterior, não reconferido).

**Forma de medir (não executada):** `HeapProfiler.startSampling({samplingInterval: 8192})` via CDP, com `collectGarbage` antes de iniciar e antes de `stopSampling`; abrir a mesma cidade com N e com N/2 prédios; o delta ÷ (N/2) dá bytes por prédio por função alocadora. Snapshot completo só na cidade pequena, para o retained size por construtor.

## (b) Achados NOVOS (fora da lista do prompt)

1. **Sem LOD para placa com conteúdo** (9b): ~5,1 M triângulos de terreno com 25 placas.
2. **Residência desligada em perspectiva** (`layer.ts:656`) e **massas L1 do mapa inteiro sem teto** (13): maior risco de perda de contexto/OOM a 10 km.
3. **`chunkedSave.ts:179`** serializa a cabeça inteira em cada edição não-prédio, na thread principal (14a).
4. **`Network.adopt` duas vezes por commit** (`commit.ts:385-407`) e a cada pausa do ponteiro ao desenhar.
5. **`refreshJunctionOrder`** (`world.ts:534-556`) refaz ordem e mapas de todas as junções a cada edição de via; **`stepControlAdvisor`** varre todas as junções a cada 10 s.
6. **Carimbo de terreno derruba a malha pré-feita da placa** (8c) e perde as `woods`.
7. **Pintura O(25 placas × dabs)** por pincelada, sem diário (9c).
8. **Plantas do jogador:** `plantedKeep` refeito por `treeRevision` global (`renderer.ts ~3081-3099`).
9. **`elementLayer` inteiro destruído e recriado** a cada carimbo de terreno (`elementKey`, `renderer.ts:3535-3548`).
10. **Virar o sol ≥ 2°** reluz todas as placas mostradas; cada resultado sobe 1–4 MB (~100 MB por passo com 25 placas pintadas; `terrain.ts ~2860-2880`).
11. **`shapePass` sem região** percorre 103 mil cantos por placa mostrada (≤ 25 placas, uma vez por edição sem região).
12. **Atributos `color`/`roadSection` mortos** em kerb, deck, pintura e parapeito, não só no verge (12b).
13. **Contadores errados:** superconta Uint16 solto; não conta alvos de render nem sombra; o DPR da tela decide o tamanho dos alvos (12d/12e).
14. **`DocImage`:** `structuredClone` de tudo (heap ×2) e `splice(...after)` com risco de estouro de pilha (14b).
15. **`Kept.lot`** retém cópia resolvida do prédio (18).
16. **`conflictPool`:** uma falha quebra o pool para sempre; o trabalho vai à thread principal sem contador (15).
17. **Profiler e hooks de GL ligados em produção** (16).
18. **`gardens.ts`:** buffer de instâncias do tamanho da cidade, só a vista é escrita (12a).
19. **Textura shore** (1,65 MB/placa) reenviada inteira a cada pincelada de cobertura e `rebuildWater` (8).
20. **`wallsNear`/explosão:** `ragdollGround.clear()` acima de 60 000 (cache com teto, restrito ao evento).

## (c) O que NÃO foi conferido

- **Nada foi medido** (tempo, heap, VRAM): a tarefa proibia executar.
- Eu mesmo só reconferi 5 pontos (topo); o resto é leitura dos agentes.
- `renderer.ts` como consumidor do overlay de lotes (item 2): custo do lado do renderer.
- `world.ts` `rebuildTopology`/`rebuildVehicleTopology` (a partir de `:628`), `rebindAgents`/`rebindPeds`, `junctionBuild.ts`, `conflicts.update`, `crossingSpans.update`; `roadDifferences`, `movedIn`, `takeFork` de `doc.ts` (se `replaceWith(before.doc)` na recusa de edição também é O(mapa)); `sim/city` e `sim/ambient` só por grep.
- Quantas células o mapa de 10 km gera (`CellFiling.byCell`).
- Carimbos por quadro de pincelada (`terrainBrush.ts`, `main.ts`), que decide se o `rewrite` inteiro dispara a cada quadro; `defaultTown.ts` (os "25 carimbos grandes"); `rasterCover` e `natureDensity`.
- VRAM real do `normalRenderTarget` do GTAO (conclusão vem do código do three); geração do PMREM do céu; atlas de impostores; alvo de paleta da multidão.
- `vertexColors` no material de tinta de pista; tile guardado em `derivedCache` (IndexedDB) ainda Uint32.
- Interior de `terrainLightCompute`, `flatGroundPool.ts`, `ecologyPool.ts`, `TransitProduct.compute`, `beforeDraw`, `drawOverlayScreen`, `updateStatus`, `refreshInspector`, `engine.refresh`.
- Plantas por prédio (a premissa de 960 mil é minha), bytes da cabeça do save, custo real de `new Error().stack`, `RangeError` do `splice` (não executado).
- Item 18: estruturas listadas como "não lidas"; tamanhos de `SurfaceInputs`, `Network`, lanelets, conflitos e elevação a 10 km.

## (d) Ordem recomendada de correção

Critério: o que quebra o 10 km (memória/contexto) primeiro, depois o que é O(mapa) por edição, depois o resto. Cada correção com commit próprio e linha em `OTIMIZACAO.md`, como as regras do projeto pedem. Nenhuma delas reduz qualidade gráfica, exceto onde indicado; **LOD de terreno com conteúdo (9b) e HLOD de massa (13) mudam o que é desenhado longe e pedem fotos antes/depois e o seu sim.**

1. **Residência por bytes também em perspectiva + teto das massas L1** (13, 10b): hoje percorrer o mapa acumula sem limite.
2. **Atributos mortos das vias** (12b) e **buffer de jardins pelo máximo visível** (12a): corte direto de memória sem mudar imagem.
3. **LOD para placa com conteúdo** (9b) e **carimbos no worker** (8c).
4. **`coverSweep` por índice de dabs** (10a), **`CandidateKeep` persistente** (10f/10g), **pintura por diário** (9c), **planted/elements por diário** (achados 8–9).
5. **Edição de via sem clone/adopt completos** (1, 3): `fork` + `adopt` por escritos; depois **elevação persistente** (4a), `refreshJunctionOrder` e conselheiro por lista suja (5).
6. **Save: cabeça em partes e `DocImage` por id** (14).
7. **Contadores honestos de VRAM** (12d/12e), antes de qualquer teto de orçamento.
8. Profiler sob demanda (16), `conflictPool` com reinício (15), alocações do ragdoll e do tráfego (6b, 7), faixa por linha no `markBox` e shore/ecologia (8).
9. Medir o heap por prédio (18) com o método acima antes de mexer em `Kept.lot` e nos `WeakMap`s.
