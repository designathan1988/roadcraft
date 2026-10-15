# Auditoria de leitura — worktree `fix/workers-10km` (2026-10-15)

**Alvo:** `C:/Codex-Shared/rc2-wt/workers-10km`, ramo `fix/workers-10km`.
**Commit lido:** `3780807` ("Placas do terreno por distância da vista e chave do lotTool pelo diário").
**Aviso de alvo móvel:** o worktree **mudou durante esta auditoria** — começou em `8802c97` e recebeu
o commit `3780807` no meio. Todo veredito abaixo foi **reconfirmado no `3780807`**; onde a mudança
inverteu um veredito, está escrito. Nada foi executado: nenhum `npm`, `vite`, `vitest`, `node`, nenhum
jogo, nenhum servidor. Toda leitura foi por arquivo, e **todos os números são ESTIMATIVA** de leitura de
código (contas mostradas), exceto onde digo que o número veio de comentário medido do próprio projeto.

**Vocabulário:** PROCEDE (o problema existe hoje) · DEFASADO (já corrigido nesta árvore) ·
NÃO PROCEDE (a afirmação não se sustenta no código) · NÃO CONFERIDO.

---

## (a) Tabela de vereditos

| # | Item | Veredito | Evidência (`arquivo:linha`) | Custo estimado (leitura de código) | Gravidade em 10 km | Correção certa (uma frase) |
|---|---|---|---|---|---|---|
| 1 | `editRules.snapshotRoads` faz `doc.clone()` | **PROCEDE** (a parte "por pausa do ponteiro" é **DEFASADA**) | `editor/editRules.ts:113-118` `const copy = doc.clone(); const copyNet = new Network(copy); … copyNet.adopt(net)`; `world/doc.ts:1844-1896` (`clone` copia registro a registro — **não** é o `fork()` de `core/forkMap.ts`, que é o copy-on-write); chamadores: `guardRoadEdit` (`editRules.ts:129`) ← `main.ts` `mutateRoads`, **uma vez por edição in-place**; `commitDraft` (`commit.ts:395`) **não tem chamador no jogo** (só `tests/`), e o dry run do desenho já usa `doc.fork()` (`commit.ts:127-130`) | O(registros do mapa) por edição in-place, duas vezes (documento + rede, ver item 3) | Alta — todo clique de edição paga o mapa | Julgar a edição in-place sobre `doc.fork()` contra o `{doc, net}` vivo, como `commitRoadPath` já faz, em vez de `doc.clone()`. |
| 1b | `changedSegments` caminho de reserva | **NÃO PROCEDE** (hoje) | `editRules.ts:143-168`; o reserva roda só quando `roadIdsChangedFrom` devolve `null` — documento sem linhagem (carga) ou entrada de diário sem ids | Rede de segurança, não caminho normal | Baixa | Manter; a linhagem de `clone`/`fork` já cobre os dois chamadores vivos. |
| 2 | `lotTool` serializa o overlay inteiro por quadro | **DEFASADO** | `editor/lotTool.ts:139-153` (chave `lots ${lotRevision} ${buildings.revision}` / `liveKey`) e o comentário `:136` "it was made, and turned to JSON for its key, on every frame"; consumidor compara chave: `render/lotOverlay.ts:419-420` | Por quadro: uma string curta | Baixa | Nada. |
| 2b | (novo) `lotAt` é O(lotes) por passo do traço | **PROCEDE** | `lotTool.ts:359` `return this.doc.lots.find((l) => insideLot(p, l))`; chamado em laço de até **400 passos** por movimento do ponteiro: `:555` (dentro de `for k = 1..steps`, `steps = Math.min(400, …)` em `:552`); a API indexada existe e é usada a três linhas de distância (`:217` `doc.lotsIn([...])`) | Traço rápido: até 400 × O(lotes) de `insideLot` **por movimento do ponteiro**; num mapa de 10 km com dezenas de milhares de lotes é dezenas de milhões de testes | Alta (por movimento, não por quadro) | Trocar `lotAt` por consulta de lugar (`doc.lotsIn(caixa do ponto)`), como o próprio arquivo já faz em `refusedNow`. |
| 2c | (novo) overlay inteiro refeito a cada movimento do ponteiro | **PROCEDE** | `lotTool.ts:677-688` percorre **todos os lotes** e aloca um polígono por lote; a chave inclui o hover (`liveKey`), então cada movimento invalida | O(lotes) por movimento + um polígono por lote | Média | Reaproveitar o overlay entre movimentos e só redesenhar o que o hover toca. |
| 3 | `Network.adopt` copia o estado inteiro | **PROCEDE** | `world/network.ts:270-275` (`copyState` + `build.copyFrom`) e `:277-295` (clear+re-cópia de `junctions`, `ribbons`, `trims`, `plateReach`, `transitions`, `impossible`, `squeezed`, 3 `CellFiling`); `world/networkBuild.ts:172-192` (~14 `new Map(other.x)`). Chamadores: `commitRoadPath` (`commit.ts:130` e `:185`) = **2 cópias por via desenhada**; `moveNodeChecked` (1 por solta); `commitBlockGrid` (`blocks.ts:59`) **uma por linha do quarteirão**; `streetObjects`/`roundabout` (`seedJunctions` + `adopt`) = 2 | ~15-20 coleções × ~10-15 entradas por nó/via, por chamada | Alta — o gesto mais comum do jogo é O(mapa) duas vezes | Uma só dona do estado derivado, com cópia de trabalho por delta (`changesSince`), em vez de copiar todas as coleções. |
| 4 | `elevation.ts` / `lanelets.ts` / `walk.ts` | **elevation: PROCEDE (parcial)** · **lanelets: NÃO PROCEDE** · **walk: NÃO PROCEDE** | `world/elevation.ts:448` `for (const [id, ribbon] of net.ribbons)` por solve, com `:1177` `new Digest().addText(JSON.stringify(rt.materials ?? null))` e chaves por nó `:541`; chamado por `commit.ts:232,305` (por trecho), `renderer.ts:1860`, `editRules.ts:104` — **por edição, não por quadro**. `lanelets.ts:255-279` atualiza pelo diário (`net.changesSince`), `build` completo só em carga. `walk.ts:1241-1248` usa grade (`nearNow(s).someIn`). | Elevação: O(estradas+nós) de alocações + 1 `JSON.stringify` por estrada com `materials`, por solve | Média — hitch de edição que cresce com a malha | Digest dos campos de `materials` sem `JSON.stringify` e memo por estrada/nó, como o das estações. |
| 4b | (novo) alocação por tick no caminho dos caminhantes | **PROCEDE** | `sim/agents/walk.ts:1952` chama `w.city.transit.trainZones()` a cada tick; `world/transit.ts:505-529` monta `new Map` + arrays + ~24-40 objetos `{x,y,r}` por trem não-metro; `walk.ts:2293` `p.progress = { leg, s, since: 0 }` — um objeto por caminhante a cada ~0,1 m andado | Dezenas de objetos/trem/tick; ~1 objeto por caminhante por 0,1 s | Baixa-média (por tick, cresce com os trens) | Guardar as zonas dos trens (recalculadas por mudança da linha) e escrever `progress` num campo do caminhante. |
| 5 | `pipeline.ts` percorre controladores por tick | **NÃO PROCEDE** | `sim/pipeline.ts:90-96` itera `w.signalisedControllers()`, que é **lista guardada**: `sim/world.ts:516-519` devolve `junctionOrder.signalised`, refeita só quando `junctionsVersion` muda. Os demais estágios são O(agentes): 4-6 por veículo, 7 O(frota) | Por tick: O(junções com sinal) + O(agentes) | Baixa | Nada. |
| 5b | (novo) `stepControlAdvisor` varre todas as junções | **PROCEDE** | `sim/world.ts:881-899` `for (const [node, junction] of this.graph.junctions)` com `mainRoadLegs` + `flow.rate` por junção; dispara quando `advisor.tick(dt)` vence, e `sim/roads/controlAdvisor.ts:37` `static readonly EVERY = 10` | O(junções do mapa) **a cada 10 s** | Média-alta — hitch periódico que cresce com a cidade | Avaliar só as junções cujas pernas mudaram desde a avaliação anterior. |
| 6 | `ragdoll.wallsNear` e `new Float32Array` | **PROCEDE** | Roda **uma vez por corpo criado** (`ragdoll.ts:533`, dentro de `build` ← `absorb`/`trip`/`fling`), mas varre o mapa: `playEffects.ts:307-313` `[...(ragdollSim?.ambient.parked ?? [])].filter(...)` + `[...(ragdollSim?.vehicles.values() ?? [])].map((v) => ({ v, pose: vehiclePose(...) }))` + `[...moving, ...standing]`; `vehiclePose` aloca um `Pose` por veículo (`sim/pose.ts:100-103`). O lado dos prédios **já é indexado** (`playEffects.ts:272` `land.buildings.near(...)`). `new Float32Array`: `ragdoll.ts:1421` (`risePalette`, por corpo por quadro em `phase === 'rise'`) e `:2034` (`palettes`, por corpo por quadro enquanto não dorme), com `bonesWorld` alocando `Matrix4` por osso (`ragdoll.ts:1379-1411`) | Uma explosão que mata N pessoas: N × O(frota + estacionados) de objetos e poses; ragdolls contidos por `MAX_BODIES = 40` | Alta no evento (trava o quadro da explosão), cresce com a frota | Montar os anéis dos veículos uma vez por explosão por consulta espacial, e escrever as paletas em buffers guardados. |
| 6b | (novo) `ragdollGround` com teto que expulsa tudo | **PROCEDE** | `playEffects.ts:240` `if (ragdollGround.size > 60000) ragdollGround.clear();` | Ao estourar: reconsulta de todas as alturas usadas | Baixa | Descartar por região (as entradas longe da vista), não tudo. |
| 7 | JSON/`structuredClone`/`[...values]` em caminho quente | **PROCEDE num ponto** | `src/sim` **não tem** `JSON.stringify`/`parse`/`structuredClone` (grep: 0). Por quadro: `lotTool.ts:184` `JSON.stringify(this.host.settings())` dentro de `liveKey` ← `overlayKeyed` ← `main.ts:3172` (todo quadro com a ferramenta de zonas visível) — objeto pequeno. Por segundo (não por quadro): `sim/agents/lotTraffic.ts:309` e `lorryTraffic.ts:267` varrem a frota com `vehiclePose` para achar o carro mais próximo (`LOOK = 1 s` / `2 s`); `lorryTraffic.ts:247` `[...this.lorries.values()]` **dentro do callback do `filter`**, refeito por pátio | Dezenas a centenas de objetos por segundo | Baixa-média | Índice espacial para "o veículo mais próximo" e tirar a cópia de dentro do `filter`. |
| 8 | Terreno sem `addUpdateRange` | **DEFASADO em parte** (geometria resolvida) · **PROCEDE no resto** | **Existe hoje**: `terrain.ts:53` importa `markBox`/`markAll` de `render/mesh/updateRanges.ts`, cujo `:18` chama `attribute.addUpdateRange(...)` (com `MAX_RANGES = 128` e queda para o array inteiro). Geometria: `markBox` em `:2280` (índices), `:2410`, `:2516-2517`, `:3168`; `markAll` em `:2193`, `:2464`, `:3137/3140/3142`, `:3169`. **Restam texturas inteiras por dab**: `paintArray` 2 camadas de 1024² (`:2963`, `:2828`, `:2854`), `shore` (`:787`), `groundTexture` (`:2714`, `:3075`), ecologia (`:2577`, `:2655`). **Carimbo**: `:3125` `const made = firstBuild && prebuilt && doc.terrainStamps.length === 0 ? prebuilt : null;` | Geometria (conta): 321² = 103 041 cantos; position 321²·3·4 = 1 236 492 B, normais idem, `aSteep` 412 164 B, índices 320²·6·4 = 2 457 600 B. Um dab de r≈80 m marca ~28 cantos → ~44 kB/dab/placa. **Pintura: 8 388 608 B (2 × 1024² × 4) + `shore` 1 648 656 B ≈ 9,7 MB/dab/placa** | Pintura: um traço em 10 placas ≈ **4,8 GB de upload** (estimativa) | Faixa de textura por caixa do dab (`Texture.addUpdateRange`, já usada em `fogLayer.ts:132`) e um `prebuilt` que aceite carimbos. |
| 8b | Revisões globais em `terrain.ts` | **DEFASADO** (de 19 para 3 doc-level) | `:3102/3106` `doc.terrainRevision`, `:2901/2902` `doc.natureRevision`, `:2912/2913` `doc.paintRevision`; o resto são contadores locais por superfície, somados pelo atlas (`flatAtlas.ts:614,617,631`) | — | Baixa | Converter as 3 restantes pelo diário, um arquivo por vez. |
| 9 | `flatAtlas` `CACHE = 6` (cache com teto que expulsa) | **DEFASADO** — corrigido no `3780807`, durante a auditoria | Não existe mais `const CACHE`: `flatAtlas.ts:229` `let keepReach = Infinity;`, `:536` `keepReach = radius > 0 ? radius * KEEP_MARGIN : 0;`, `:323` `if (Math.abs(p.cx - focusX) > keepReach …) letGo(p);` e o comentário `:30-47` "let go beyond it: by distance from the view, never by how many are kept or how long ago they were drawn" | Residência agora acompanha a vista | Baixa | Nada na expulsão; o que resta é o **custo do retorno** (abaixo). |
| 9b | O que é refeito quando a placa volta | **PROCEDE** | `flatAtlas.ts:299-307` (`letGo` faz `surface.dispose()`, `p.heights = null`, `p.mesh = null`; o comentário diz "Its corners go too (725 kB a plate): read again if it comes back"); `:545` volta a pedir ao worker | ~725 kB de cantos + malha + normais/steep por placa que volta | Média — o vaivém da câmera paga de novo | Guardar o `PlateMesh` (cantos/normais/flip/woods) fora da vista e só liberar quando o orçamento de bytes exigir. |
| 10a | `coverSweep` por revisão | **DEFASADO** | `renderer.ts:2982` chave `\`${terrain.forestRevision}:${terrain.waterRevision}\``; `:2984-2990` e `:2999` `keep.refresh(coverFresh ? null : rects, KEEP_REACH)` — o sweep cobre a **área pintada**, não o mapa | O(área pintada) por revisão | Baixa-média | Reduzir o sweep ao retângulo do diário. |
| 10b | `reach = Infinity` | **PROCEDE** | `renderer.ts:3194` `let reach = Infinity;` (finito só na ortográfica, `:3196-3201`) → `layer.ts:650` `massCells.choose(..., reach)`; `massCells.ts:224` `Math.hypot(dx, dy) <= reach * …`; e `layer.ts:656` `if (Number.isFinite(reach) && (…))` — **a única evicção do detalhe exige reach finita** | Em perspectiva (o jogo normal) a evicção **nunca roda**: a área visitada só cresce | Alta — é o achado aberto do `CLAUDE.md` | Residência por orçamento de bytes do que está na placa, não por alcance da vista. |
| 10c | Transporte por revisão | **DEFASADO** | `render/transit.ts:281-296` `dirty(change, out, source)` com `filing.idsMeetingAny(change.rects)`; `allKeys` só quando `rects === null`; `:428-443` monta só as runs mudadas | O(itens alcançados) | Baixa | Nada. |
| 10d | Névoa e ravinas por revisão | **Névoa: DEFASADO** · **Ravinas: PROCEDE (caminho morto)** | Névoa: `renderer.ts:3515-3529` (`serialOf(...FOG_KINDS)` + só os retângulos) e `fogLayer.ts:125-135` com `texture.addUpdateRange` por linha. Ravinas: `render/terrainRelief.ts` **não existe**; `terrain.ts:3003` `setGullies() {}` e `:3005` `bakeRelief() {}` são vazios, e `renderer.ts:3495/3508` ainda os chama | Ravinas: os dabs são gravados e **nada é desenhado** | Baixa (código morto, mas engana quem lê) | Apagar o caminho de gullies/relief ou implementá-lo; o comentário de `terrainBrush.ts:115` aponta um arquivo que não existe. |
| 10e | `natureTrees.update` / `buildGroundCover` reescritos inteiros | **DEFASADO** | `renderer.ts:3009-3027` e `:3058-3078` usam `createCoverCells`/`createTreeCells`; `plantCells.ts:40-72` sincroniza só as células mudadas (+vizinhas), com o comentário `:19-21` "DO NOT write every tree of the map into its meshes again when one changed". `buildGroundCover` só aparece em `tests/render/groundCover.spec.ts:33` | Por célula (64 m) | Baixa | Nada vivo; `sync(null)` (sweep refeito) é O(área pintada), não O(mapa). |
| 11 | Céu (ordem/overdraw) e GTAO com alvo ocioso | **Céu: PROCEDE** · **GTAO (2 passes): PROCEDE** · **GTAO (14 MB de VRAM ociosa): NÃO PROCEDE** | Céu: `environment.ts:352` `depthTest: false` e `:357` `sky.renderOrder = -1000`; o vertex shader **já prepara** a correção: `:127-133` põe `gl_Position.z = 0.0` sob `USE_REVERSED_DEPTH_BUFFER`. GTAO: `postprocess.ts:262` `new GTAOPass(scene, camera, size.x, size.y)` (sem `parameters`), `:287` `pass.setGBuffer(depth)`; em `GTAOPass.OUTPUT.Default` o three faz **2 passes de tela cheia** (cópia + blend — `GTAOPass.js:576-583`). O `normalRenderTarget`: `_renderGBuffer` é posto em `false` antes de qualquer desenho (`postprocess.ts:298` no boot e `:287` no wrapper), e `GTAOPass.render` só o desenha sob `if (this._renderGBuffer)` (`GTAOPass.js:502-508`) — **nunca é ligado à GPU**; o que existe é um objeto JS | Céu: a tela inteira de fragmentos por quadro antes de tudo ser sobrescrito. GTAO: 2 passes em resolução cheia para um `blendIntensity` de 0,85 | Média (fragmentos e banda) | Céu: desenhado por último com `depthTest: true` (o three mapeia `LessEqual→GreaterEqual` sob buffer invertido, `WebGLState.js:137`, e o clear de profundidade vira 0, `:205-207` — conferido na fonte r186). GTAO: `OUTPUT.Off` e a AO multiplicada no passe que já existe. |
| 12 | VRAM: alvos de render e sombra fora da conta | **PROCEDE** | `postprocess.ts:164-178` (alvo da cena `HalfFloatType` + `DepthTexture(..., FloatType)` + `samples: Math.min(8, renderer.capabilities.maxSamples)`), `:190` (alvo do composer, HalfFloat sem depth; o `EffectComposer` clona: `EffectComposer.js:79-80`), `quality.ts:127/131` e `:154/156` (`high`: `pixelRatio 1.5`, `shadowMapSize 4096`; `ultra`: `pixelRatio 2`, `4096`). **Nem `inventory.ts` nem `memoryCounters.ts` contam**: `inventory.ts:83` `sceneInventory(root)` e `memoryCounters.ts:32` `countMemory(root)` percorrem a **cena** (`Object3D`); alvo de render não é objeto de cena, e `grep` em `inventory.ts` por `RenderTarget`/`composer`/`shadow` não acha nada. A linha do orçamento está "não medido": `core/perfBudget.ts:196` `cap('memória de vídeo: alvos de render e sombras', null, 300, 'MB')` | **1920×1080, `high` (2880×1620 = 4,67 Mpx):** cor RGBA16F 8 B/px × 8 amostras = 298,6 MB; profundidade 32F × 8 = 149,3 MB; resolvidas 37,3 + 18,7 = 56,0 MB; composer 2 × 37,3 = 74,6 MB; GTAO meia-resolução 2 × 9,3 = 18,7 MB; corpos 2 × 9,3 = 18,7 MB; nuvens 512² = 2,1 MB; sombra 4096² = 67,1 (cor RGBA8) + 67,1 (profundidade) = 134,2 MB → **≈ 752 MB**. **`ultra` (3840×2160):** 530,8 + 265,4 + 99,6 + 132,8 + 33,2 + 33,2 + 2,1 + 134,2 → **≈ 1 232 MB** (estimativa aritmética) | Alta — é o maior consumo de VRAM do jogo e o painel não o mostra | Contar os alvos (composer + cada luz) na linha que já existe, e tornar amostras de MSAA e tamanho da sombra campos de `quality.ts` (decisão do jogador, com foto). |
| 12b | Jardins: capacidade que dobra e arrays dos dois stores | **PROCEDE** (o valor "52+52 MB" NÃO foi conferido) | `gardens.ts:279-288` cria **dois stores por espécie** (corpo e cartões de folhagem); ambos recebem as mesmas listas (`:519-522`), logo os mesmos transforms. Por slot: CPU `matrices` 16×4 B + `colours` 3×4 + `spheres` 4×4 + `shown` 4 = **96 B**; GPU `instanceMatrix` 64 B + `instanceColor` 12 B = **76 B** (alocados pela capacidade: `:356-365`). Crescimento: `:515-517` `repack(s, Math.max(MIN_CAPACITY, (s.used + coming) * 2), false)` — **dobra**; `:510-512` empacota quando metade está morta mas **mantém a capacidade** (`Math.max(s.capacity, MIN_CAPACITY)`), nunca encolhe | 100 mil arbustos ≈ 9,6 MB CPU + 7,6 MB GPU **por store**, e o store de cartões guarda os mesmos transforms outra vez | Média (cresce com o jardim e nunca volta) | Compartilhar o `instanceMatrix` entre corpo e cartões (mesmos transforms) e deixar a capacidade voltar a encolher num empacotamento que não seja acionado por uso. |
| 12c | Atributos mortos na faixa do verge | **PROCEDE** | `mesh/tileMesh.ts:83` `export const streams = (): Streams => ({ positions: [], normals: [], uvs: [], colors: [], sections: [], indices: [] })` — **sempre** os seis; `mesh/surfaceMesh.ts:69` `geometry.setAttribute('roadSection', …)`. A faixa do verge usa o material do terreno: `roadSurfaces.ts:730-731` `material: raised ? materials.deck : groundMaterial ?? materials.verge`. O material do chão (`terrain.ts:1000-1014`) **não declara `vertexColors`** (o `vertexColors: true` de `terrain.ts:1992` é do `wallMaterial`, outro caminho) e **não lê `roadSection`** (`grep` em `terrain.ts`: 0) | 24 dos 56 B por vértice, na faixa mais extensa de cada via | Média (upload e heap proporcionais) | Streams opcionais: o verge é a única faixa que perde `color` e `roadSection`. |
| 12d | Geometria não indexada | **PROCEDE** | `structures.ts:414-420`: `push` empurra **6 vértices por quad** (`[[pa,uvA],[pb,uvB],[pc,uvC],[pa,uvA],[pc,uvC],[pd,uvD]]`) sem índice — parapeitos, muros de contenção, backfill e portais. `vehicleModels.ts:298` `const n = g.index ? g.toNonIndexed() : g;` no `merge` | Extrusão: 32 B/vert com 1/3 de redundância; veículo: ~36 B/vert × 3 vert/tri em todo corpo desenhado | Média | Indexar a extrusão (4 vértices + 6 índices por quad) e soldar depois do `merge` (`mergeVertices`, tolerância 1e-4 — a cor é constante por parte). |
| 12e | Uint16 ainda não usado em todo lugar | **DEFASADO nas células** · resta um ponto pequeno | `buildings/cellArrays.ts:127-128` `indexArray(vertices, indices)` já escolhe: `vertices > 0xffff ? new Uint32Array(indices) : new Uint16Array(indices)`, usado em `:137` e `:191`. Resta `flatAtlas.ts:180` `new Uint32Array(all.length)` no remendo do mapa | O remendo: 7 680 índices → 15 kB de desperdício (estimativa) | Irrelevante | Nada urgente. |
| 13 | Células de detalhe longe na GPU: existe teto por orçamento? | **PROCEDE** (não existe) | `layer.ts:644-668`: o "perto" vem de `massCells.choose` (erro de tela) e a **evicção** (`:658-666`) exige `Number.isFinite(reach)`; em perspectiva `reach = Infinity` (`renderer.ts:3194`) → nada é solto. As **massas** de toda célula nunca são soltas: `massCells.ts:170-191` (`land` cria a malha e a põe no grupo), liberadas só por `remove`/`dispose` (`:193-199`, `:266-271`). Nenhum orçamento de bytes no caminho (grep por `CHUNK_CACHE_BYTES`/`budget` em `layer.ts`: nada) | Percorrer o mapa inteiro em perspectiva acumula o detalhe de toda a área visitada; as massas de todas as células (~2,5 kB por prédio, estimativa) ficam para sempre | Alta — é a promessa "sem limite" | Residência do detalhe **e** das massas por orçamento de bytes (o `inventory.ts` já mede por objeto), com o retorno barato pelo worker da célula. |
| 14 | `chunkedSave`/`docImage`: cópia/reescrita total | **PROCEDE no head** · **undo: NÃO PROCEDE** | Head: `chunkedSave.ts:133` `if (!BUILDING_KINDS.includes(entry.kind)) { this.dirtyHead = true; continue; }` e `:179` `if (head) put.push([\`${this.key}:head\`, await gzip(JSON.stringify(doc.withoutBuildings()))])`; `doc.ts:2350-2352` `withoutBuildings() { return this.serialized(false); }` → **qualquer** edição de via, lote, árvore, cerca, poste reescreve o mapa inteiro sem prédios, por salvamento (debounce 700 ms/máx 3 s). Partes de prédio: só as sujas (`:136-141`, 512 registros por parte). Undo: `docImage.ts:45,48` marcam `buildings` e `lots` como `immutable` → `:117` `r.immutable ? value : copy(value)` e `:162` `const after = r.immutable ? now : copy(now)` guardam **por referência, sem `structuredClone`** | Head de um mapa de 10 km: dezenas de MB de texto serializado de uma vez, na thread principal (estimativa) | Alta — cresce O(mapa) e volta com a cidade maior | Partir o head nas mesmas partes que o diário já nomeia (por tipo/retângulo). |
| 14b | (novo) desfazer de postos/paisagem/cercas sem ids | **PROCEDE** | `doc.ts:2086-2088` grava `record('utilities', …)` sem `ids` → `docImage.ts:216-227` varre a coleção inteira do tipo para achar o que mudou | O(coleção) por desfazer desses tipos | Baixa-média | Passar os ids também nesses escritores (o diário já os conhece). |
| 15 | `conflictPool` engole erro? | **NÃO PROCEDE** | `conflictPool.ts:97-99` `const lanes = this.start(); if (!lanes) return Promise.reject(new Error('no workers in this browser'));`; `:274` rejeita com o erro do worker; `:246-248` watchdog de silêncio (`SILENCE_MS`) que rejeita todas as pendentes (`:297-302`); os chamadores degradam para a página com aviso (`world/waiting.ts:12-20`, `conflictPoints.ts:201-207`, `sim/world.ts:679-682`) | Espera máxima de `SILENCE_MS` num travamento total | Baixa | Nada. |
| 15b | (novo) workers órfãos se o 2º `new Worker` falhar | **PROCEDE** | `conflictPool.ts:283-287`: se o `new Worker` estourar no meio da criação das lanes, `this.lanes = null` sem terminar as já criadas | Até N-1 workers vivos sem uso | Baixa | Terminar as lanes criadas antes de zerar. |
| 16 | `profilerHooks` ligados com o profiler desligado | **PROCEDE (fato)** | `main.ts:707` `hookProfiler(scene.gl);` sem condição; `render/profilerHooks.ts:39-42` envolve `gl.bufferData` (e os demais envios) com uma função que chama `profiler.count(...)`; a contagem é que é desligada: `core/profiler.ts:139-140` `if (!this.enabled) return;`, e `main.ts:710` `mountProfilerHud(profiler, { visible: import.meta.env.DEV })` | Por chamada envolvida: uma chamada JS extra + `arguments` — ~0,1-0,5 µs (estimativa); sem crescer com a cidade | Baixa | Instalar os invólucros só em `import.meta.env.DEV` (o HUD de produção ficaria mudo). |
| 17 | `main.ts`: por quadro vs sob demanda | **PROCEDE (parcial)** | `main.ts:2748-2866`: `beginFrameWork` O(1), `canvasInput.drain` O(eventos), `gameState.flush` O(mudanças), câmera O(1), `growCity` só na geração, `topology.step` O(1) em dia, `engine.refresh('frame')` O(produtos), `sim.clock.advance(…, SIM_FRAME_BUDGET_MS)` (orçamento), `net.rebuild()` só com `net.revision !== doc.revision`, `scene.draw`, overlay/painéis por `Periodic`. As leituras de revisão restantes no arquivo são **comparações O(1)** (`:479`, `:574`, `:890`, `:914`, `:2166`, `:930`, `:2788`, `:2806`) | Nada O(mapa) por quadro no que foi lido | Baixa | Nada por quadro; `rebuildSimulationTopology` (`:574`) é O(cidade) **uma vez por gesto** ao soltar o arrasto. |
| 18 | Heap por prédio (~100 KB) e produtos do mapa | **NÃO CONFERIDO o número** — estruturas listadas abaixo | Ver §(b1) | — | Alta (é a muralha do 10 km) | Medir por amostragem de heap (CDP `HeapProfiler.startSampling`) e atacar o que a amostra nomear. |

---

## (a1) O que muda em relação ao relatório anterior (`docs/AUDITORIA-2026-10-15.md`, meu, e `docs/relatorio-otimizacao-roadcraft2.md`, externo)

Os dois leram o `main`, não este ramo (`fix/workers-10km`). Neste ramo ficaram **defasados**:
o detalhe do terreno sem `addUpdateRange` (item 8 — a geometria agora usa faixas), o `CACHE = 6` do
`flatAtlas` (item 9 — agora é por distância), o `coverSweep` por revisão (10a), o transporte por
revisão (10c), a névoa por revisão (10d), as florestas reescritas inteiras (10e), os ladrilhos das vias
na CPU (o `SurfaceReuse` passou a guardar `KeptTile = readonly string[]` — só digests: `roadSurfaces.ts:180`,
com o comentário `:101-105` medindo 330 MB do que era), os índices `Uint32` das células (12e) e o
`pedPose` alocado por quadro (hoje `agents.ts:2302` usa `pedPoseInto` com `POSE` de módulo; a função
antiga `sim/pose.ts:275` ficou sem chamador).

E um veredito meu anterior **não procede**: o `normalRenderTarget` ocioso do GTAO **não** custa
~14 MB de VRAM — ele nunca é ligado (item 11).

---

## (b) Achados NOVOS (mesma classe, fora da lista)

1. **`stepControlAdvisor` varre todas as junções do mapa a cada 10 s** — `sim/world.ts:881-899` +
   `sim/roads/controlAdvisor.ts:37`. Hitch periódico que cresce com a cidade (item 5b).
2. **`lotAt` é O(lotes) por passo do traço** (até 400 passos por movimento do ponteiro) — `lotTool.ts:359`,
   `:552-555`. O próprio arquivo já usa índice espacial três linhas acima (`:217`).
3. **Toda edição fora de prédio reescreve o mapa inteiro sem prédios no salvamento** — `chunkedSave.ts:133,179`
   + `doc.ts:2350`. É o maior custo O(mapa) periódico que encontrei (item 14).
4. **Pintura do terreno reenvia 2 × 1024² de textura por dab** (8,4 MB) + `shore` (1,6 MB) — `terrain.ts:2963`,
   `:2827-2828`, `:785-787`; o `addUpdateRange` de textura já é usado no projeto (`fogLayer.ts:132`).
5. **`renderer.ts:3535-3548`: a camada de elementos é inteira destruída e refeita quando `elementRevision`
   ou `terrainRevision` muda** — sem diário por elemento.
6. **`flatAtlas.ts:428-437`: cada `paintRevision` filtra a lista de dabs inteira por placa**, sem a porta
   por retângulos que o caminho de `terrain` tem (`:412-413`).
7. **Leitura de todas as placas derivadas do disco no boot, para a memória** — `renderer.ts:772` `stored: new Map()`
   preenchido por `readDerivedAll<TileBundle>(tilesPrefix)` (`:792-797`) e limpo depois de cada build
   (`:805` `surfaceReuse.stored!.clear()`): o pico de heap no boot é o tamanho do cache de ladrilhos da sessão
   anterior, mesmo para ladrilhos que o build não vai pedir.
8. **`ragdollGround` com teto que expulsa tudo** — `playEffects.ts:240` (`clear()` acima de 60 000 entradas).
9. **Caminho morto das ravinas**: `terrain.ts:3003,3005` (`setGullies`/`bakeRelief` vazios), chamados por
   `renderer.ts:3495,3508`; `terrainRelief.ts` não existe e `terrainBrush.ts:115` aponta para ele.
10. **`lorryTraffic.ts:247`**: `[...this.lorries.values()]` **dentro** do callback do `filter`, refeito por pátio.
11. **`lotTraffic.ts:309` / `lorryTraffic.ts:267`**: varrem a frota com `vehiclePose` (que aloca) para achar
    o veículo mais próximo, uma vez por segundo.

### (b1) Item 18 — o que o prédio e o mapa retêm (leitura de código; tudo ESTIMATIVA)

**Por prédio (registro):** `Building` (`world/buildings/types.ts:390-441`, ~20 campos escalares) contém
`volumes: Volume[]` (`:190+`, ~20 campos cada, com `storeys[]`), `elements?: BuildingElement[]`
(`:356-374`, 11 campos, teto `MAX_ELEMENTS = 128` em `:472`) e `cores: Core[]`. Um registro gerado
típico é ~9,5 KB de JSON, dos quais ~7,1 KB são elementos do lote (número do projeto, `docs/CIDADE-10KM.md`).
Em heap, cada elemento é um objeto (~100-200 B com o overhead do V8) e cada volume outros tantos —
**um registro gerado fica na casa das dezenas de KB, não 100 KB**; a diferença tem de estar nos
derivados abaixo.

**Por prédio (derivados, este ramo):** o store só guarda o registro — `world/buildings/store.ts:62`
`items: Map<BuildingId, Building>`, `:74` `settled: WeakSet`, `:76` `grid` (grade de 64 m). A camada
guarda `kept` (`layer.ts:29` `Kept { sig, digest, b, summary, pavedAt?, lot? }` — a referência ao
registro, não uma cópia), o digest por registro num `WeakMap` (`:54` `sigs`), a `CellFiling` de ids por
célula, e por célula detalhada um `BuildingMeshes` (`buildingMesh.ts:120-126`) cujo `group` sobrevive
mesmo depois de `gpuOnly` soltar os arrays (`mesh/gpuOnly.ts`). O undo **não** copia o registro
(`docImage.ts:45,117,162`).

**Por mapa:** `doc.lots` (`world/lotStore.ts` — `items` Map + lista cacheada, `:120-123`), as árvores
por célula, postes (`world/poleIndex.ts`), a rede (`network.ts`/`networkBuild.ts` — ~14 coleções), o
grafo de faixas (`world/lanelets.ts`), a elevação (`world/roadField.ts`, com memo por identidade
"elevation is immutable once built", `:484`), as junções (`world/junctionBuild.ts`), o cadastro de
lotes recusados, e o `derivedCache` (IndexedDB, `render/derivedCache.ts`). O documento do projeto mede
este conjunto: "superfícies das vias ~250 MB, postes ~106 MB, junções ~62 MB, elevação ~37 MB" em 66 s
de geração (`docs/PROMPT-OUTRA-IA-2026-10-15.md`, §6.1).

**A partilha/derivação possível, por leitura:**
- `Kept.summary` (`ChunkSummary`, `cellWork.ts:66-71`: key, flags?, lot, signatureFloor?) e `Kept.lot`
  (`LotGroundRecipe`) são **derivados do registro** — podem ser recalculados no worker e não guardados;
- `sig`/`digest` por prédio são dois números contra um `WeakMap` — barato, manter;
- o registro em si é o que a semente+lote pode substituir (`OTIMIZACAO.md` #8: decisão do jogador, exige
  gerador versionado);
- as três estruturas grandes do mapa (superfícies, postes, junções) são **derivados da rede** e já
  deveriam caber no mesmo contrato do motor (`doc.changes`), como o `derived.ts` faz.

**A UMA medição confiável que eu recomendo** (sem executar): **amostragem por CDP `HeapProfiler.startSampling`
→ exercício → `HeapProfiler.stopSampling`**, no Chrome já dirigido por `scripts/look.mjs` (que já abre uma
sessão CDP e usa `Profiler.start/stop` para o `.cpuprofile`; a amostragem de heap usa a mesma sessão).
Por que esta e não o snapshot: o snapshot (`HeapProfiler.takeHeapSnapshot`) trava a página por segundos,
gera centenas de MB e é o que já falhou aqui (`snap10k.mjs`/`snapRead.mjs`, §7 do prompt); a **amostragem**
não para a página, devolve uma árvore de pilhas com bytes auto-atribuídos (`selfSize`) por **função que
alocou** — é o que nomeia "quem alocou estes 100 KB por prédio" (por exemplo, `cloneBuilding`,
`growOnLot`, `emitLots`, `readContent`), o que um contador por estrutura não faz sem instrumentar cada
uma. Complemento barato e determinístico, que não substitui a amostra: contadores de contagem por
estrutura (`items.size`, `kept.size`, entradas por célula) expostos no `__roadcraft`, para separar
"muitas coisas pequenas" de "poucas coisas grandes".

---

## (c) O que NÃO consegui conferir, e por quê

1. **O número de ~100 KB por prédio** e a atribuição do heap: exigiria executar o jogo (proibido) ou um
   gerador de amostra. O que fiz foi listar as estruturas e estimar por campos (§b1).
2. **Tamanhos reais em bytes** de qualquer estrutura: sem execução, tudo acima é aritmética de campos;
   comentei onde o número vem de medição do próprio projeto.
3. **A frota e `ambient.parked` num mapa de 10 km**: a gravidade do item 6 depende desse número.
4. **`decayWatch`, `populationGovernor.feed`, `poleTool.plan`**: li o contrato, não os internos.
5. **`scene.draw`**: aceitei o contrato "O(visível)" sem auditar o desenho a fundo (é o assunto dos
   itens 8-13, que cobri por outro lado).
6. **Frequência real de `elevation.digest` por rebuild** (quantos blocos por edição) — li o caminho, não medi.
7. **Se o pincel de pintura grava um dab por `pointermove`** — li `doc.ts:1281-1284` e
   `terrainBrush.ts:136-142`, não o ponto de chamada por quadro.
8. **Os arquivos `tests/` do ramo** (197 arquivos de teste novos/modificados no diff): não foram lidos;
   nenhum veredito aqui depende deles.
9. **A árvore mudou no meio da auditoria** (`8802c97` → `3780807`). Tudo foi reconferido no `3780807`,
   mas os *agentes de leitura* que trabalharam na primeira metade leram estados diferentes para os itens
   8 e 9 — os dois foram revertidos por mim no commit novo (por isso os vereditos DEFASADO).

---

## (d) Ordem recomendada de correção

Ordem por custo × risco, cada um com a causa (nunca amortização):

1. **Residência do detalhe e das massas por orçamento de bytes** (itens 10b e 13) — é a promessa
   "cidade sem limite"; sem isso a VRAM cresce com a área visitada e não volta.
2. **Head do salvamento por partes** (item 14) — é o único custo O(mapa) que roda **sozinho**, em segundo
   plano, a cada edição; a correção é a mesma partição que o diário já nomeia.
3. **`lotAt`/overlay por consulta de lugar** (itens 2b, 2c) — barato de fazer, e hoje é O(lotes) **por
   movimento do ponteiro**, o pior multiplicador do código.
4. **`wallsNear` sem varrer a frota** (item 6) — o congelamento do quadro da explosão tem causa clara e
   correção local (consulta espacial, como os prédios já fazem ao lado).
5. **Contar os alvos de render e sombra e pôr as duas decisões na qualidade** (item 12) — ~750 MB em
   `high` que o painel não mostra; as duas mudanças de aparência vão com foto para o jogador.
6. **Faixa de textura na pintura do terreno** (item 8) — 9,7 MB por dab é o maior upload por gesto.
7. **`doc.clone()` → `doc.fork()` nas edições in-place** (item 1) e **`Network.adopt` por delta** (item 3)
   — juntos, são duas cópias de mapa por clique.
8. **Paletas dos ragdolls em buffers guardados** (item 6, segunda metade) e **zonas dos trens por linha**
   (item 4b) — alocação por quadro/tick em laço quente.
9. **Streams opcionais e geometria indexada** (itens 12c, 12d) — memória e upload proporcionais, sem
   mudança de imagem.
10. **`stepControlAdvisor` incremental** (item 5b) e **descartar o caminho morto das ravinas** (10d).
11. **`instanceMatrix` compartilhado entre corpo e cartões dos jardins** (12b) e a capacidade que encolhe.
12. **Invólucros do profiler só em DEV** (item 16) e **`ragdollGround` por região** (6b) — higiene.
13. **Medir o heap por amostragem CDP** (item 18) antes de tocar em qualquer estrutura de prédio — é o
    único dos itens grandes que ainda não tem causa nomeada.
