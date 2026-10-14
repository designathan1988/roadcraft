# Auditoria por padrão — 2026-10-14

Varredura somente leitura feita por quatro agentes, um por área, a pedido do jogador ("ir no código,
compreender, identificar e corrigir"). Nada foi medido: cada achado precisa de um número
(`__roadcraft.budget(vista)`, perfil ou contador) antes de entrar na fila, e de prova de resultado
idêntico (digest, teste) quando for corrigido. Linhas de código no estado de `49d12f3` + árvore de
trabalho de 2026-10-14 ~13h.

Padrões: P1 refazer tudo por mudança pequena · P2 varrer a coleção inteira para achar vizinho
(sem índice espacial) · P3 cache que não segura · P4 malha/array recriado em vez de atualizado ·
P5 trabalho para o que não se vê / alocação por quadro · P6 trabalho pesado síncrono sem fatia ·
P7 invalidação larga demais (revisão global) · P8 comparar serializando (JSON/strings) · P9 densidade
além da necessária · P10 espera síncrona da GPU · P11 crescimento sem teto / dado duplicado.

Estado: `[ ]` pendente · `[x]` corrigido (com commit) · `[d]` decisão do jogador.

## A. Prédios (`src/render/buildings`, `src/world/buildings`)
- [ ] A1 P1/P7/P6 `layer.ts:495-657` `update` percorre a cidade ~12× por mudança de prédio (chave =
  `buildings.revision`…): dois `filter` de `all()`, `massFor` de todos, `massesByCell` ×2,
  `groupByCell` ×2, `cellOf` em 4 passes, `cover.index` de todos, backlog, `flyFlags`. Mudança durante o
  warming recomeça tudo (`:509`). Correção: ids do diário (`doc.changes.since(seen,['buildings'])`),
  `shownById`/`townCells` persistentes, `massCells.updateCells` parcial; caminho completo só com `null`.
- [ ] A2 P6 `layer.ts:516-526,573` edição pequena tratada como carga (`unmade` conta `chunks`, e longe
  não há chunk): fatia de 50 ms e sem pré-envio. Correção: contar por `masses.has(id)`. Uma linha.
- [ ] A3 P1/P8 `store.ts:188,199` `replaceWith` faz `toText()` da cidade ×2 e clona todos os registros a
  cada edição de rua que muda um prédio — invalida todos os caches por objeto (RECORD_TEXT, pegadas,
  STORED_BOUNDS, pads). Correção: tirar a comparação por texto; reaproveitar o objeto quando igual.
- [ ] A4 P2 `layer.ts:777-783` `anyLotHeightAt` varre todos os chunks por pedestre "open" por quadro.
  Correção: grade das caixas de `lotGround`, menor número de inserção entre os candidatos.
- [ ] A5 P1 `layerCells.ts:193-225` índice de cobertura refeito do zero a cada troca. Incremental por id.
- [ ] A6 P7 `layer.ts:346-354` + `massCells.ts:131-149` desgaste refaz a massa e a célula de massas,
  que não dependem de `decay`/`builtAt`. Chave sem esses campos.
- [ ] A7 P11/P4 `layer.ts:519` streaming cancelado abandona malhas já enviadas (vazamento de GPU).
  `dispose` de `streaming.made` antes de anular. Uma linha.
- [ ] A8 P1/P7 `cameraSolids.ts:61-91` + `renderer.ts:3216-3231` sólidos da câmera de todos os prédios
  por revisão; pisos por chave global de terreno. `refile(ids)` + `groundChanges.touches`.
- [ ] A9 P2/P5 `pick.ts:49-60` + `buildingTool.ts:2056,2266` clique/hover O(prédios) com arrays por
  chamada. Grade de `storedBounds` + DDA.
- [ ] A10 P2 `validate.ts:183-186` validação varre todos os prédios (até 18× por lote no crescimento).
  Mesma grade.
- [ ] A11 P11/P4 `buildingMesh.ts:3579-3615` arrays das peças instanciadas mantidos na CPU depois do
  envio (e no chunk). `onUpload(letGoOfArray)` + REFILL.
- [ ] A12 P11 `massCells.ts:82-115` arrays das células de massa nunca soltos.
- [ ] A13 P11/P8 `layer.ts:136-144` e `store.ts:136-147` texto de cada registro guardado duas vezes.
- [ ] A14 P4/P1 `layer.ts:327-331,422,657` + `flagLayer.ts:122-160` bandeiras recriadas inteiras por troca.
- [ ] A15 P6/P4 `layer.ts:626-629` "ocultar outros" remonta o desbotado inteiro síncrono por troca.
- [ ] A16 P8/P1 `layer.ts:636-646` `JSON.stringify(b)` por assinatura por troca.
- [ ] A17 P11 `layer.ts:246` `groundDigests` vaza para prédios removidos sem chunk.
- [ ] A18 P5 `layer.ts:493-495,398-404,669` chaves em string e `key.slice` por célula por quadro.
- [d] A19 P3/P11 `lightSlots.ts:16-36` tabela de luz das salas sem limpeza, teto 65.536: depois do teto
  a aparência das janelas depende da ordem de emissão. Mexe na imagem: decisão do jogador.

## B. Editor, main, simulação, interface
- [ ] B1 P2/P3 `zoning.ts:577,582` `neighbourStoreys`/`nearSignatures` varrem todos os prédios dentro
  do laço de até 18 tentativas, por prédio crescido. Calcular uma vez antes do laço + grade de prédios.
- [ ] B2 P1/P2 `zoning.ts:528,515-523,541-544` `open`, `lastGrown` e "o mais perto" varrem todos os
  lotes por prédio. Fenwick + grade dos lotes abertos, mesmo RNG.
- [ ] B3 P1 `main.ts:2120,2560` `doc.lots.some` por lote recusado e a cada 500 ms.
- [ ] B4 P2 `zoning.ts:478-486` `cornerOf` filtra todos os ribbons por prédio. Grade por `net.revision`.
- [ ] B5 P2/P3 `zoning.ts:41-45` `addPlaced` com `buildingBounds` sem cache sobre todos os prédios.
  `storedBounds` + grade.
- [ ] B6 P1/P4/P8 `lotTool.ts:612-660,144` overlay de lotes refeito e serializado em JSON por quadro na
  ferramenta de zona. Parte estática por revisão + parte dinâmica pequena.
- [ ] B7 P2/P9 `lotTool.ts:305,241-244,379-389,491-497` pincel/borracha: `lotAt` linear até 400× por
  movimento. Grade das caixas dos lotes.
- [ ] B8 P2 `sim/agents/lotTraffic.ts:160` `list.includes` por tick sobre os parados do mapa. `Set`.
- [ ] B9 P1/P3 `sim/ambient/ambient.ts:418-470,716-740` `busy`/`outShare` (exponenciais) por lugar por
  olhada. Uma vez por tipo; contador de olhada antes do laço.
- [ ] B10 P1/P2 `ambient.ts:859-895` + `parking.ts:198-205,308` carros parados do mapa refeitos por
  prédio, `others.some` quadrático. Hash espacial de 1,5 m; patch pelo diário.
- [ ] B11 P1/P7 `ambient.ts:666-675,901-915,271-283` `refreshPlaces`/`mixAround`/`behindWall` por prédio.
- [ ] B12 P1/P4 `lotTraffic.ts:207,221,263-266` mapas e strings de todas as baias por olhada.
- [ ] B13 P1 `walk.ts:1669-1695` zonas de todos os carros parados quando um muda.
- [ ] B14 P1/P3 `lorryTraffic.ts:178-188` + `lorryDocks.ts:300-330` pátios refeitos por prédio.
- [d] B15 P7 `sim/world.ts:626,580,862-890` um cruzamento automático trocando de controle reconstrói e
  REINICIA todos os semáforos do mapa (AMBER/ALL_RED). Corrigir muda comportamento: decisão do jogador.
- [ ] B16 P2/P3 `snap.ts:112-157` `findAnchor` todos os nós e segmentos por movimento, `roadProfile`
  antes do teste de caixa.
- [ ] B17 P2/P3/P4 `buildingSnap.ts:157-171,190-194,84-90` + `buildingTool.ts:2056-2060` construtor varre
  prédios (caixa sem cache) e ribbons por movimento.
- [ ] B18 P1/P8 `editRules.ts:112-118,142-155` + `commit.ts:811` edição de via no lugar clona o doc e
  compara segmentos por JSON.
- [ ] B19 P2 `sim/transit/transit.ts:224-236` passagens de nível: faixas × trechos do trem sem caixa.
- [ ] B20 P2 `ui/inspector.ts:228` estatística do segmento varre todas as faixas a cada 0,4 s.
- [ ] B21 P7 `sim/world.ts:557-581,634-651`, `peds/sidewalk.ts:77-140`, `crossingSpans.ts:63-82`
  topologia de pedestres refeita para o mapa por edição local.
- [ ] B22 P8 `ui/v2/shell.ts:2133`, `buildingTool.ts:975` JSON para detectar mudança por quadro.
- [ ] B23 P7 `sim/world.ts:465` `signalsAsleep` acorda todos os semáforos a cada edição.
- [ ] B24 menores: `main.ts:1702` localStorage por `input` do slider; `ambient.ts` `vacated` sem poda.

## C. Render (fora de prédios)
- [ ] C1 P3/P7 `renderer.ts:1230-1241` + `groundChanges.ts:131-136` + `changes.ts:80,140,173-193`:
  depois de 2.048 entradas do diário sem mudança de chão, todo dependente do chão fica "sujo" para
  sempre — barreiras, transporte e todos os jardins refeitos a CADA QUADRO. Correção: `touches` responde
  `false` quando `since >= groundChanges.version`. (Ver também D8: anel do diário por tipo.)
- [ ] C2 P1/P3 `renderer.ts:2972-2996` laço dos jardins: o `seen` de cada prédio nunca avança; o laço
  percorre a cidade a cada prédio com plantas, cada `touches` percorre até 2.048 entradas.
- [ ] C3 P2 `signs.ts:170-176,333` cada placa de rua percorre todas as faixas. `net.ribbonsMeeting` (já
  existe, mesma ordem).
- [ ] C4 P1/P6 `roadSurfaces.ts:556-573,735-845,870-905` união da calçada do mapa por passe e inputs da
  rede inteira por edição.
- [ ] C5 P1 `renderer.ts:3216-3240` + `canyonLight.ts:233-236` sólidos da cidade rearquivados por prédio.
- [ ] C6 P7/P4 `utilities.ts:200-206,376-404` direção do meio-fio de todos os postes invalidada por
  `net.revision`; fios do mapa num buffer só, refeito e reenviado. Por blocos.
- [ ] C7 P2/P5 `gardens.ts:356-383`, `scenery.ts:794-840` cull por instância de todas as plantas por
  quadro de câmera. Instâncias agrupadas por célula, como `grass.ts:326-345`.
- [ ] C8 P1/P2 `renderer.ts:1520-1575` + `pads.ts:105-160` + `terrain.ts:2482` plataformas: grade de
  todas refeita por prédio; `shapeBounds` copia todas as caixas por placa e fatia.
- [ ] C9 P1 `renderer.ts:1297-1301,1327-1345,1408-1420,1511-1525,2910` varreduras O(cidade) por revisão.
- [ ] C10 P7 `renderer.ts:2469,2595-2628,3011,3126-3140` vegetação refeita por chave global.
- [ ] C11 P1/P4/P8 `lotOverlay.ts:95-96,217-229,245-275` chave em string por lote e buffer inteiro por
  entrada.
- [ ] C12 P1 `flatAtlas.ts:325-342,560-561` atlas do chão varre o mundo por mudança de revisão.
- [ ] C13 P1/P5 `renderer.ts:3408-3412` `tallestBox.setFromObject` por versão do layer.
- [ ] C14 P1/P4 `renderer.ts:1668-1697` + `scenery.ts:637-760` mobília inteira por item/hora/edição.
- [ ] C15 P1/P4 `signals.ts:341-371` uma luz trocando reescreve as lentes de todos os semáforos.
- [ ] C16 P1/P9 `structures.ts:67-97,545-555` estruturas amostram todas as faixas por edição.
- [ ] C17 P7 `renderer.ts:3584-3611` elementos e neblina refeitos a cada mudança de terreno.
- [ ] C18 P2/P7 `roomLamps.ts:23-31` lâmpadas do corte ordenam todos os prédios.
- [ ] C19 P11 `renderer.ts:835-845` + `roadSurfaces.ts:908-926` tiles de via duplicados na CPU.
- [ ] C20 P5/P4 `natureTrees.ts:181,197,209-251` árvores sem cull por célula, reescritas inteiras.
- [ ] C21 P5 `renderer.ts:1269-1275` `watchRoads` por segundo.
- [ ] C22 P8 `renderer.ts:1310-1316,1376-1393` texto como detector de mudança por registro.

## D. World e core
- [ ] D1 P2/P6 `walkways.ts:768-777` `landOn` varre todos os caminhos por ponta de travessia
  (~4×10⁹ testes na meta, síncrono). Índices `footwaysBySegment`/`cornersByNode`.
- [ ] D2 P2 `walkways.ts:280-295` `onPaving` testa todos os furos da calçada por ponto de esquina.
  Baldes de 25,6 m.
- [ ] D3 P1/P7/P11 `walkways.ts:325-335,595-665` calçadas da cidade refeitas por edição (~13 s medidos);
  grafo guardado duas vezes (`transitTools.ts:82`). Por célula, como `poleLinesIn`.
- [ ] D4 P3/P9/P11 `poleLines.ts:119,128-181` LRU de 64 mistura células e regiões; contorno e acessos
  calculados à toa (origem provável de 17 s + 35 s). Mapa próprio por célula, getters preguiçosos.
- [ ] D5 P2/P4 `lots.ts:487-499` faixa aberta: corridas × todos os lotes × 4 `closestPoint`. Usar a
  grade `ringCells` que já existe.
- [ ] D6 P1/P7/P11 `network.ts:165-166,394-464` + `walkable.ts:32-35` `crosswalkDistanceAt` e
  `WalkableSurface` do mapa refeitos por edição.
- [ ] D7 P1/P8/P4 `lanelets.ts:254-376,393-431` grafo inteiro recalculado 2× por edição, chaves em texto.
- [ ] D8 P7 `changes.ts:80,173-181` anel de 2.048 compartilhado por todos os tipos: enxurrada de um tipo
  faz todo leitor de outro tipo ver `null` e refazer o mapa. `serialOf(kinds) <= since → []`; anel por tipo.
- [ ] D9 P2/P4 `lots.ts:576,582` `applyLots` com `includes` em listas grandes; `splice(...80 mil)` pode
  estourar a pilha.
- [ ] D10 P1/P2/P6/P11 `lots.ts:230-350` raster da cidade por plano; union-find O(R²); `ribbons.includes`.
- [ ] D11 P1/P11 `network.ts:240-265` + `networkBuild.ts:171-191` + `cells.ts:131-139` ~30 Maps copiados
  2-3× por via.
- [ ] D12 P1/P8/P4 `doc.ts:1222-1305,1478-1484` `clone`/`replaceWith` do documento por via.
- [ ] D13 P1/P8/P4 `elevation.ts:501-614,839-846,1880-1941` `buildRoadElevation` O(todas as vias).
- [ ] D14 P1/P8 `conflictPoints.ts:194-300` todos os pares de todas as junções 2× por edição.
- [ ] D15 P3 `turnPaths.ts:345,453-454` memo de curvas zerado inteiro em 50 mil.
- [ ] D16 P2 `roads/footwayRise.ts:24-55` todas as vias rentes por ponto, por pedestre por quadro.
- [ ] D17 P2/P4 `doc.ts:454-466,518-528` `addPoleSpan`/`removePole` varrem todos os fios.
- [ ] D18 P1/P2 `junction/bulb.ts:129-146` `clearBulbs` varre junções, postes e elementos por edição.
- [ ] D19 P2/P4 `cityGen/squares.ts:77-89,108` `mainRoadDistance` todos os trechos por canto.
- [ ] D20 P2 `cityGen/streets.ts:252-264` `planarize` ignora o hash já montado.
- [ ] D21 P1/P7/P4 `lots.ts:746-758,976-998` união da calçada do mapa por revisão.
- [ ] D22 P2 `lots.ts:1008-1014` `lotSnapper` todos os cantos por movimento.
- [ ] D23 P1/P2/P11 `parkingLayout.ts:79-190,214-235` sem cache, mapa inteiro, ribbons × entradas.
- [ ] D24 P1/P7/P4 derivados por revisão global: `curbRamps.ts`, `landscape.ts:288-319`,
  `carriageway.ts`, `streetFurniture.ts:93-136`, `poleLines.ts:78-87`.
- [ ] D25 P1/P8 `docImage.ts:165-180` comparação profunda de todos os nós e trechos por edição.

## Causas comuns (o que os mecanismos atacam)
1. Falta um índice espacial mantido pelo único escritor (prédios, lotes, ribbons por caixa): A9, A10,
   B1, B2, B4, B5, B7, B16, B17, C3, D1, D2, D5, D16, D17, D22.
2. Derivados que leem a coleção inteira por revisão global em vez dos ids do diário: A1, A5, A6, A8, B10,
   B11, B14, C2, C5, C8-C12, C14, D3, D6, D24.
3. O diário perde a precisão: anel único de 2.048 (C1, D8) — conserto central, beneficia todos os leitores.
4. Comparar por texto: A3, A13, A16, B6, B18, B22, C11, C22, D7, D25.
