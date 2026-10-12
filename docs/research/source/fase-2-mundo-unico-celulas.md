# Pesquisa da fase 2 — mundo único, células, derivados incrementais, desfazer e autosave por célula

Pesquisa de 2026-10-11, só leitura de código. Ramo `agente/pesquisa`, a partir de
`planeta-esfera` `27a7cb48`; todo `arquivo:linha` é desse commit. Complementa a
seção 5.15, 5.2, 5.11, 6.2–6.3 do `docs/relatorio-desempenho-mapas-enormes-2026-10-11.md`
(fontes F16–F18, F50) e o bloco C do `PROMPT-PENDENCIAS.md` (aceite: a via isolada
da sonda B1 custa o mesmo em qualquer tamanho de mapa; oráculo "incremental = do
zero"; spec de ida e volta plano↔planeta).

**Como as fontes foram lidas.** Páginas: WebFetch (a página convertida em texto e
respondida por um modelo pequeno a um pedido meu; não é o byte bruto). PDFs: baixados
pela ferramenta e lidos como texto com `pdftotext`. Código do ramo: lido por mim. Um
cálculo numérico de projeção foi feito por mim num script descartável (resultado em
3.1; nenhum teste, build ou jogo foi rodado).

---

## 1. Perguntas que a fase 2 precisa responder

1. O que exatamente é "o modo plano é a dobra com curvatura 0" em termos de
   projeção: o que fica verdadeiro, o que se deforma, quanto, e o que o código
   atual faz com `k` baixo (há um piso)?
2. Como um documento plano (o das chaves `roadcraft.world.v7`) vira um documento
   nas cartas do planeta? Existe um molde no repositório? O que se perde?
3. Que partição em células usar (tamanho, dono de cada registro, halo, referências
   entre células) e o que fazem o Unreal (World Partition) e o 3D Tiles?
4. Como derivados por célula ficam corretos: chave de entrada, invalidação pelo
   diário, parada antecipada ("early cutoff"), e o oráculo "incremental = do zero"?
5. Como trocar o desfazer por instantâneos de texto (`editor/history.ts`) por
   comandos com inverso, como editores reais fazem, sem perder a atomicidade de um
   gesto?
6. Como autossalvar por célula no IndexedDB (esquema, transações, durabilidade,
   cotas) sem regravar o documento inteiro?

---

## 2. Fontes lidas

### 2.1 Projeção azimutal equidistante

**MathWorld, "Azimuthal Equidistant Projection"** —
https://mathworld.wolfram.com/AzimuthalEquidistantProjection.html : para o centro
(φ₁, λ₀) e `c` a distância angular ao centro, `x = k′ cos φ sin(λ − λ₀)`,
`y = k′ [cos φ₁ sin φ − sin φ₁ cos φ cos(λ − λ₀)]`, `k′ = c / sin c`,
`cos c = sin φ₁ sin φ + cos φ₁ cos φ cos(λ − λ₀)`; inversa com `c = √(x²+y²)`. A
página diz que a projeção "não é equivalente nem conforme" e remete a Snyder,
*Map Projections — A Working Manual*, USGS PP 1395, pp. 191–202. (A extração avisou
que as fórmulas foram reconstruídas do texto alternativo das imagens: conferir.)
**Wikipedia, "Azimuthal equidistant projection"** — preserva distâncias e azimutes **a
partir do centro**; descreve a distorção só de forma qualitativa, em km da Terra real
(mínima abaixo de ~10 000 km, moderada até 15 000, severa depois). **PROJ, `aeqd`** —
https://proj.org/en/stable/operations/projections/aeqd.html : a página lida só traz
a tabela e as opções (`lat_0`, `lon_0`, `R`), nada de propriedades.
**Snyder (PP 1395) em si NÃO foi lido:** o PDF do USGS passa do limite de 10 MiB da
ferramenta e o texto no archive.org redirecionou para nós que respondem 404. O
comentário de `src/core/planetTiles.ts:9–17` do próprio projeto cita Snyder pp.
191–202 e dá o mesmo resultado que a fórmula acima: "um arco de `d` a partir do
centro é desenhado `d/R / sin(d/R)` de comprimento na transversal".

**Código do projeto sobre a dobra** — `src/render/planet/bend.ts:29–48,125–137`:
a curvatura `k` (0..1) põe o chão em volta do ponto olhado numa esfera de raio `R/k`
tangente ao planeta nesse ponto, "a mesma distância ao longo do chão dele" (a
distância é a geodésica `Rθ`, com `θ` vindo de `planetFromAnchor`, `bend.ts:116–124`).
`planetBent` devolve `a·(R + h·cos φ − 2·(R/k)·sin²(φ/2)) + t·((R/k + h)·sin φ)` com
`φ = θ·k`. Limite `k → 0` (conta minha): o termo `t` vai a `R·θ` (a distância
verdadeira ao longo do chão) e o termo `a` vai a `R + h`: **exatamente a carta
azimutal equidistante tangente em `a`**. Para `k` exatamente 0 a fórmula divide por
zero (`rk = PLANET_R / planetK`, `bend.ts:133`), então `k = 0` precisa de ramo próprio
com esse limite. O código nunca chega a 0: `setPlanetCurvature` limita `k` a
`[0.02, 1]` (`bend.ts:514`) e `FLAT_K = 0.02` (`isoViewport.ts:86`, usado em
`isoViewport.ts:347`) é o "plano" de hoje, a menos de 300–400 m do chão (comentário
`isoViewport.ts:330–340`).

**Cada peça já é uma carta azimutal** — `planetTiles.ts:9–17,28–33`: 12×12 peças por
face (864), cada uma o mapa azimutal equidistante em torno do seu centro, "um ângulo
reto fica a menos de 1° e um comprimento a menos de 1,3% dentro da peça (as specs
medem)", 0,34% no canto mais distante com 150 m de alcance. `charts.ts:1–20`: o
documento escreve cada ponto na carta da peça que o possui; o que mistura vários pontos
(uma via entre dois nós, um cruzamento, um gesto) é calculado numa carta só, para a
qual os pontos são levados pela esfera; "no mapa plano há uma carta e todos os mapas
são a identidade" (`charts.ts:18`, `identity()` em `:45`, e `onOneChart` em `:31–42`).

### 2.2 Partição, streaming e HLOD

**Unreal Engine, World Partition** —
https://dev.epicgames.com/documentation/en-us/unreal-engine/world-partition-in-unreal-engine :
um nível persistente dividido em células de grade carregadas e descarregadas pela
distância às **fontes de streaming**; o exemplo da página usa células de 256 m e
alcance de carga de 768 m (a página **não** dá padrões numéricos; os 12 800 UU que o
relatório cita como exemplo não aparecem). Um ator pertence a uma célula conforme
**Is Spatially Loaded** (ligado: carrega quando uma fonte está no alcance; desligado:
carrega sempre); "atores que referenciam outros atores são empacotados e carregam
juntos"; **One File Per Actor** (um arquivo por ator) tira o conflito de edição do
arquivo do nível; fontes de streaming têm grade-alvo, prioridade, formas e estado-alvo
(Carregado/Ativado); a grade padrão é um hash 2D; comandos "builder" (HLOD,
navegação) rodam sem carregar o mundo; depuração com `wp.Runtime.*`.
**World Partition — HLOD** —
https://dev.epicgames.com/documentation/en-us/unreal-engine/world-partition---hierarchical-level-of-detail-in-unreal-engine :
uma camada HLOD gera, por célula da grade de HLOD, **uma malha-proxy e um material**
(tipos: Instancing — usa o LOD mais baixo em instâncias, bom para árvores —, Merged
Mesh, Simplified Mesh; a página não lista o tipo "Approximated"); a camada tem seu
próprio `Cell Size`/`Loading Range`; "o conteúdo das células descarregadas é
substituído pelos HLODs"; a construção é um passo de editor/comando (`-SetupHLODs`,
`-BuildHLODs`) e "HLODs inalterados não são refeitos": mudança em ator, malha, material
ou textura os refaz na próxima execução. A página não descreve a transição entre célula
carregada e HLOD.

**3D Tiles (OGC/Cesium)** —
https://github.com/CesiumGS/3d-tiles/blob/main/specification/README.adoc (lido por
extração dirigida): `geometricError` do tile é um número ≥ 0 em metros, "em geral a
raiz tem o maior erro e cada nível de filhos tem erro menor que o pai" (é expectativa,
não obrigação); `refine`: REPLACE (filhos no lugar do pai) ou ADD (filhos além do pai),
obrigatório na raiz; volumes: `box` (12 números), `region` (radianos), `sphere` (4
números); o **conteúdo dos filhos fica dentro do volume do pai** (não precisa o volume
dos filhos); `viewerRequestVolume`; **tiling implícito** `QUADTREE`/`OCTREE` com
subárvores de tamanho fixo e dados de disponibilidade; o spec **não dá fórmula** de
erro de tela, só diz que o cliente usa o erro geométrico com métricas de tela
(distância, tamanho, resolução) e refina "se o erro introduzido exceder o máximo".

**Nystrom, "Spatial Partition"** — citado no relatório (F50); não relido nesta pesquisa.

### 2.3 Incremental correto: rastros, parada antecipada, oráculo

**Mokhov, Mitchell, Peyton Jones, "Build Systems à la Carte" (ICFP 2018)** — PDF de
https://www.microsoft.com/en-us/research/uploads/prod/2018/03/build-systems.pdf , lido
como texto (944 linhas). Definição 2.1: um sistema de construção é **mínimo** se
executa cada tarefa no máximo uma vez por construção e **só** se ela depende
transitivamente de entradas que mudaram. **Parada antecipada** ("early cutoff"): se
uma tarefa é refeita e o resultado é igual ao anterior, os dependentes não precisam
ser refeitos (Shake e Bazel têm; Make e Excel não). Estratégias de reconstrução:
**bit sujo** (Excel guarda um bit por célula e marca sujos os dependentes
transitivos por superaproximação estática; é seguro marcar sujo demais, nunca de
menos; dá minimalidade mas dificulta a parada antecipada), **rastros de verificação**
(guardam hashes das dependências do último resultado), **rastros construtivos**
(guardam também o valor, permitem cache compartilhado), **rastros construtivos
profundos** (só hashes das entradas terminais; não suportam parada antecipada, e com
`n ≥ 2` exigem tarefas determinísticas). Dependências dinâmicas pedem agendador
"suspendendo" (Shake) ou "reiniciando" (Excel/Bazel).
**Salsa (rust-analyzer), explicação do algoritmo** —
https://salsa-rs.github.io/salsa/reference/algorithm.html : uma revisão global avança
a cada entrada alterada; cada função memoizada guarda o valor, as dependências e a
revisão em que cada uma mudou por último; se nenhuma mudou, devolve o valor guardado;
**backdating**: se uma dependência é refeita e dá o mesmo valor, o resultado é tratado
como não alterado e os dependentes não são refeitos; **durabilidade**: entradas
raramente alteradas deixam pular a verificação. (A extração não trouxe os nomes
"verified_at/changed_at".)
**Nystrom, "Dirty Flag"** — https://gameprogrammingpatterns.com/dirty-flag.html (já
descrito na fase 1): a bandeira precisa ser marcada em todo ponto de escrita; granularidade
fina custa memória e metadados, grossa reprocessa o que não mudou; ver também "física:
corpo parado é bandeira suja".

### 2.4 Desfazer por comando com inverso

**Nystrom, "Command" (Undo e Redo)** — https://gameprogrammingpatterns.com/command.html :
o comando guarda o que muda (`xBefore_`, `yBefore_`) porque o objeto esquece; desfazer
em vários níveis = lista de comandos com um ponteiro "atual" (executar adiciona e
avança; desfazer volta; refazer avança e executa; um comando novo depois de desfazer
descarta o que vem adiante); o autor tentou **Memento** (instantâneo do objeto) e
achou que "não funciona bem": os comandos mudam uma parte pequena, guardar só os
valores alterados é mais barato; alternativa: **estruturas persistentes** (compartilham
dados entre versões); exige disciplina: **toda** modificação passa por um comando.
**Figma, "How Figma's multiplayer technology works"** —
https://www.figma.com/blog/how-figmas-multiplayer-technology-works/ : o documento é uma
árvore de objetos, conceitualmente `(ObjectID, Property, Value)`; edições são mudanças
de propriedade; o servidor define a ordem; "o último a chegar vence" por propriedade;
mudanças locais aplicam na hora; criar e remover são operações explícitas, o ID inclui
um ID de cliente para criar offline; "o cliente que apagou guarda as propriedades no
seu buffer de desfazer"; o texto **não diz** se desfazer é uma operação nova, mas
afirma o princípio de que "desfazer, copiar e refazer de volta ao presente deve deixar
o documento inalterado", e que "um desfazer modifica o histórico de refazer **no
momento do desfazer**, e um refazer modifica o de desfazer no momento do refazer".
**tldraw, `HistoryManager.ts`** (ramo `main`, lido por extração dirigida) — duas pilhas
imutáveis (`undos`, `redos`) com entradas `diff` (um `RecordsDiff { added, updated,
removed }`) e `stop` (marca com id); a captura é um interceptor do `store`
(`addHistoryInterceptor`), que só registra mudanças de origem `user`, com estados
Recording / RecordingPreserveRedoStack / Paused; as mudanças desde a última marca vão
sendo **fundidas** num `pendingDiff` (`squashRecordDiffsMutable`); `mark(id)` fecha a
entrada; desfazer inverte o diff (`reverseRecordsDiff`), junta tudo até a marca anterior
e aplica **numa chamada** (`store.applyDiff`), pausando a gravação durante a reprodução;
`bailToMark` desfaz sem alimentar o refazer; o trecho lido não limita a profundidade.
**Excalidraw, `packages/excalidraw/history.ts`** (ramo `master`; extração) — pilhas de
`HistoryDelta` (elementos + estado da aplicação); o que se guarda é o **inverso** da
mudança (`HistoryDelta.inverse(delta)`); ao desfazer, aplica-se a entrada à cena atual
(com o instantâneo local como fallback para elemento ausente), calcula-se o delta que
de fato foi aplicado (`applyLatestChanges`) e **empurra-se o inverso dele na outra
pilha**; `version` e `versionNonce` não são restaurados (cada desfazer vira uma versão
nova para os colaboradores); passos sem efeito visível são pulados; o trecho não mostra
limite de tamanho. Os três (Figma, tldraw, Excalidraw) guardam **valores**, não
instantâneos do documento, e **recalculam o inverso do desfazer no momento do desfazer**.

### 2.5 Persistência no navegador

**MDN, `IDBDatabase.transaction()`** — https://developer.mozilla.org/en-US/docs/Web/API/IDBDatabase/transaction :
`mode` `readonly` (padrão), `readwrite` e `readwriteflush`; opção `durability`:
`"strict"` (só considera confirmada depois de verificar que foi ao armazenamento
persistente; recomendada quando perder dado pesa mais que custo), `"relaxed"` (confirmada
quando entregue ao sistema operacional; recomendada para dados efêmeros como caches ou
registros que mudam rápido), `"default"` (o padrão do agente de usuário). A página não
diz qual é o padrão de cada navegador (a afirmação "o Chrome mudou o padrão para
relaxed" que circula **não está nela**). Atenção ao exemplo da página: abre a transação
fora do `onsuccess`.
**MDN, "Storage quotas and eviction criteria"** —
https://developer.mozilla.org/en-US/docs/Web/API/Storage_API/Storage_quotas_and_eviction_criteria :
Web Storage: 5 MiB de `localStorage` por origem, `QuotaExceededError` ao passar;
IndexedDB/Cache/OPFS: Chrome/Chromium até **60% do disco total** (best-effort e
persistente), Firefox 10% do disco ou 10 GiB (best-effort) e até 50% persistente,
Safari ~60% em apps de navegador; as cotas contam o disco **total**, não o livre;
despejo por pressão de armazenamento é LRU **por origem, tudo ou nada**, e uma origem
com `navigator.storage.persist()` concedido é poupada (Chromium e Safari decidem sem
perguntar, Firefox pergunta); `navigator.storage.estimate()` dá uso e cota
(estimativas); escrita acima da cota falha com `QuotaExceededError`.

### 2.6 Código do projeto lido para esta fase

`src/world/changes.ts` (diário), `src/editor/history.ts`, `src/main.ts:1175–1235`,
`src/editor/persistence.ts:30–60,140–200,720–771`, `src/render/derivedCache.ts`,
`src/world/rescale.ts`, `src/world/flatEarth.ts`, `src/world/bounds.ts`,
`src/world/planet/{atlas,charts}.ts`, `src/core/planetTiles.ts`, `src/core/regionIndex.ts`
(cabeçalho), `src/world/ids.ts`, `tests/world/incrementalRebuild.spec.ts`,
`tests/world/oldMapsIdentical.spec.ts`, `docs/ESCALA.md`, `docs/MAPA-PLANO-COMPLETO.md`.

---

## 3. O que se aplica a este código

### 3.1 "Plano = dobra com curvatura 0": o que isso garante e custa

**Garantido** (matemática da carta e leitura do shader): em volta do ponto olhado, as
**distâncias radiais** ao longo do chão e os rumos são exatos; a transversal sofre
`k′ = c / sin c` (MathWorld; comentário do projeto). Com `R = 4·FACE_HALF/π =
3 819,7 m` (`cubeSphere.ts:37–40`), conta minha:

| Distância ao ponto olhado | `k′` (esticamento transversal) |
|---|---|
| 250 m | +0,07% |
| 500 m | +0,29% |
| 1 000 m | +1,15% |
| 1 360 m (meia diagonal da placa velha de 1,92 km) | +2,14% |
| 2 000 m | +4,72% (o comentário de `charts.ts` fala "5% a 2 km") |
| 3 000 m | +11,1% |

Uma via **reta** (geodésica) de 1 000 m, transversal, centrada a 1 000 m do ponto
olhado, aparece **curvada 5,7 m** no mapa azimutal em torno dele (10,9 m se o centro
estiver a 2 000 m; 0,09 m para 250 m a 250 m; conta minha). Nada disso aparece onde o
jogador constrói (dentro de ~500 m do ponto olhado o erro é < 0,3% e < 1 m de
arqueamento), mas a vista de cima do mundo plano e vias longas que não passam pelo
centro mostram o efeito. A "vista inteira do mundo no plano" (relatório 5.15) precisa
de projeção global à parte: azimutal em volta de um ponto só vai a ~10 000 km na Terra
real antes de a distorção ficar moderada (Wikipedia); aqui isso é uma fração do
planeta de 3,8 km de raio: o limite prático do plano-pela-dobra é da ordem de 1–2 km do
ponto olhado.

**O que o código faz hoje e muda:**
- O piso de curvatura é `k = 0,02` (`bend.ts:514`, `isoViewport.ts:86`): o "plano" de
  hoje é uma esfera de raio `R/k ≈ 191 km` — o chão cai `d²/(2·191 km)` abaixo da
  tangente: 0,65 m a 500 m, 2,6 m a 1 km, 10,5 m a 2 km (conta minha). Para um plano
  de verdade é preciso o ramo `k = 0` com o limite do `planetBent` (2.1), na GLSL
  (`bend.ts:129–137`) e no espelho da CPU (`bentInto`, `bend.ts:475–481`; `unbend`
  `:490–498`; `bentSphere`/`planetDrawnSphere` `:483–490,561–600`; `planetDaylight`
  `bend.ts:195–202` usa `R − R/k`), ou aceitar `k = 0,02` como "plano" e decidir se
  10 m de queda a 2 km importam para o jogador.
- `__PLANET__` aparece **159 vezes em 36 arquivos** (`grep`, fora de `backup`):
  `render/renderer.ts` 23, `isoViewport.ts` 19, `postprocess.ts` 14, `main.ts` 14,
  `terrain.ts` 12, `bounds.ts` 9, `geometry.ts` 7, `rescale.ts` 5, `sim/agents/walk.ts` 5,
  `editor/commit.ts` 5, …. Os dois modos são hoje **dois builds**; juntar é remover
  essas ramificações (ou colapsar uma na outra). As cartas já têm a rota de fuga:
  `onOneChart` (`charts.ts:31–42`) e `identity()` (`charts.ts:45`) tratam o plano como
  carta única — o contrário do que a unificação quer.
- Chaves de salvamento separadas: `roadcraft.world.v7` (plano) e
  `roadcraft.planet.atlas864.v1` (planeta) (`docs/ESCALA.md`, seção "Mapas salvos").
  Mundo único = uma chave (ou um esquema de células, 3.5) e a migração das duas.

### 3.2 Migração de um documento plano para as cartas

O molde já existe e é testado: `rescaleSerializedDoc` (`rescale.ts:247–309`) percorre **todas** as coleções do documento
(nós, segmentos, terreno, tinta, névoa, ravinas, nuvens, elementos, árvores, clareiras,
postes, paisagismo, barreiras, prédios, zonas, marcas de zona, lotes, transporte) e
passa cada posição por uma função `place` (`PlaceFn`, `rescale.ts:229–232`);
`planetPlace` (`rescale.ts:105–132`) faz o que a migração precisa: leva o ponto à
esfera (`atlasToTileInto` → `tileToSphereInto`), à carta de uma peça-mãe, aplica a
operação, volta à esfera e **escreve na peça que agora possui o ponto**
(`tileOfDirection` → `sphereToTileInto` → `tileToAtlas`). Sua motivação está no
comentário do arquivo: escalar cada ponto em torno do centro da *sua* peça rasgaria
toda via que cruza uma borda — a migração do plano precisa levar **todos os pontos de
um documento pela mesma carta** e só depois dividi-los por dono.

Para o mapa plano antigo, a carta é a da peça de origem, `HOME_TILE`
(`relief.ts:138`, `flatEarth.ts:21`: "a origem do plano é o centro da peça onde está a
cidade do planeta"): o ponto `(x, y)` da placa velha é o ponto `(x, y)` da carta
azimutal dessa peça (identidade); depois `tileToSphereInto(HOME_TILE, x, y)` →
`tileOfDirection` → coordenadas na carta dona. O que muda: (i) a placa velha tem
±960 m, a peça tem ±~250 m; a placa cobre cerca de 4×4 = 16 peças, então **cada
registro muda de dono** conforme o ponto de âncora; (ii) coleções com forma não
pontual — `zones` são retângulos `x0,y0,x1,y1` e `rescale.ts:289–293` usa mín/máx de
dois cantos movidos, o que **na esfera é aproximação**; `lots` por cantos, `barriers` e
`transit.tracks` por listas de pontos, `buildings` com contorno — precisam ser
migrados como polígonos na carta comum, e só serem partidos por dono quando o *registro*
é indivisível (um prédio pertence a uma célula); (iii) a distorção transversal da
carta azimutal (tabela 3.1) vira parte do mapa: uma via reta do mapa antigo continua
reta **na carta de origem** e é "reta na carta" (não geodésica) na esfera, como as vias
do planeta já são (`charts.ts`: cálculo numa carta só). O comprimento de uma via de
1 km muda no máximo ~1% por esse efeito e as medidas locais (largura, ângulos) mudam
menos de 0,3% dentro de 500 m. A diferença para o mapa equirretangular atual
(`flatEarth.ts`) é outra: lá `x` é longitude × R, de modo que 1 unidade a leste vale
`cos(lat)` do chão (1,41× a 45°, relatório 5.15); **a migração não converte
coordenadas equirretangulares em azimutais — as trata como metros da carta**
(comportamento descrito em `docs/MAPA-PLANO-COMPLETO.md`: "as vias e os prédios não
mudam"), então o que o jogador desenhou mantém as medidas do jogo, e é o relevo (que o
mapa antigo guarda em carimbos, `flatGroundFor` com mistura `FLAT_BLEND = 480 m`,
`flatEarth.ts:102–123`) que precisa de uma costura com o relevo da Terra, como já faz.

**Oráculos de migração prontos para reaproveitar** (existem e rodam hoje):
`tests/world/rescale.spec.ts` (mapa em outra unidade abre com as mesmas medidas em
metros) e `tests/world/oldMapsIdentical.spec.ts` (mapas antigos derivam exatamente o
que derivavam; hoje com uma linha de base por unidade); ambos usam
`maps/cidade-com-estacionamento.json`, `tests/fixtures/grid-and-bends.json` e
`tests/fixtures/player-city.json`. A spec de ida e volta plano↔planeta que o PROMPT
pede é, no desenho do relatório, mais de **desenho e seleção** do que de dados: o
documento é um só e o modo é só `k` (e o terreno/oceano que se carrega), então o que
precisa ser provado é que a **seleção** (`planetPick`/`unbend`, `bend.ts:490–498`) é a
inversa do desenho em `k` baixo e em `k = 1`, e que uma edição em coordenadas de carta
sai igual por qualquer dos dois caminhos.

### 3.3 A partição em células

**Estado.** Há duas "grades" em uso: as peças (500 m, 864; `planetTiles.ts:34–36`) e a
`BATCH_CELL = m(240)` da camada de prédios (`render/buildings/layer.ts:575`, mais a
`DETAIL_CELL`). `RegionIndex` documenta o custo de ignorar a esparsidade: duas grades
de 3,3 milhões de células, 200 ms por edição e 50 MB descartados, porque as peças ficam
a quilômetros no atlas (`regionIndex.ts:27–44`, "agrupa em uma grade por aglomerado").

**Definição proposta (a mesma do relatório 6.2, agora com os números do código):** a
célula é `(peça, quadrante)` na carta **da peça dona**: 2×2 por peça = 3 456 células de
~250 m em 183 km² (área da esfera, conta minha: 4πR²). O dono de um registro é a
peça do seu **ponto de âncora** (`tileOfDirection`, como o desenho já escolhe a carta de
um vértice `bend.ts:79–85`), o quadrante o sinal de `(x, y)` na carta dessa peça. A peça
não é um quadrado (`TILE_HALF` é o meio-lado do quadrado que contém a mais larga;
`TILE_INNER` o do que cabe na mais estreita, `planetTiles.ts:127–170`): células na
borda da peça são o resto, o que importa é que **a função ponto→célula é determinística
pela carta dona**, não a forma. O halo é `TILE_REACH = m(120)` (`atlas.ts:30`), o
alcance máximo de um registro sobre a borda da peça.

**Referências entre células** (um segmento é dono do ponto do seu nó inicial, mas seus
nós, calçadas e junções reaparecem em outras células): o World Partition resolve com
"atores que referenciam outros atores são empacotados e carregam juntos" (2.2). Aqui
`RoadDoc` guarda `nodes`, `segments`, `poles`, … em `Map`s globais por id
(`doc.ts:196–225`) e **os ids são monotônicos, nunca reutilizados** (`ids.ts:30–48`:
`IdAllocator.take/reserve`); portanto uma referência é estável e não ambígua, o que
simplifica tanto o desfazer (3.4) quanto a persistência (3.5). A carga parcial precisa
do fecho de referências (ou de "pés" — id e posição — dos nós vizinhos dentro de cada
célula).

**Diário → células sujas.** `ChangeJournal.record(kind, rects, …)` já guarda
retângulos do mundo (`changes.ts:77–86`) e `touches(since, area, kinds)` (`:188`)
responde "alguma mudança depois de `since` encosta nesta área"; o anel é de 2048
entradas e quem for mais velho recebe `null` ("tudo mudou", `since`, `:173–174`). A lista de
células sujas desde a série `s` é a união das células que cada retângulo toca (mais o
halo). O diário **não** diz *o que* mudou nem guarda valores anteriores: serve a
invalidação, não ao desfazer.

**HLOD por célula** (a ponte com a fase 5): o World Partition gera "uma malha-proxy e
um material por célula da grade de HLOD", refaz só o que mudou e o 3D Tiles refina por
erro geométrico em metros com "o conteúdo dos filhos dentro do volume do pai"; o jogo
já tem `setFar`/`cullDetails` por prédio e `assembleByCell` por `BATCH_CELL` — a
célula de dados e a de desenho podem ser a mesma se 240 m forem alinhados a 256 m (ou
o contrário). Decidir isso é da fase 5.

### 3.4 Derivados por célula e o oráculo "incremental = do zero"

**O que já é rastro de verificação.** O grafo de faixas guarda `linkCache` "pela
geometria e os cortes de que foram feitas" e `junctionCache` "pela superfície e as
faixas" (`lanelets.ts:190–199`): uma via que a edição não tocou mantém as suas faixas,
objetos e tudo. É o rastro de verificação do *Build Systems à la Carte* (hash das
entradas → valor guardado), e o que falta, como o próprio relatório diz, é que a
*passada* que monta as chaves é global (`lanelets.ts:246` ordena todos os trechos e
`:330–338` calcula o digest da polilinha inteira por trecho, a cada edição). Mapeando
os conceitos:

| Build Systems / Salsa | No jogo |
|---|---|
| entradas | registros do documento por célula (`nodes`, `segments`, `buildings`, …) |
| bit sujo, fecho transitivo por superaproximação | o diário com retângulos + halo: marcar sujo demais é seguro, de menos é bug |
| rastro de verificação / construtivo | chave da célula = hash das entradas da célula e do halo; o valor derivado fica no cache (`render/derivedCache.ts`, IndexedDB por impressão do código) |
| parada antecipada / backdating | se a célula refeita dá o mesmo hash de saída, os dependentes (o vizinho, a simulação, a camada seguinte) não são refeitos |
| agendador suspendendo | dependências *dinâmicas* (junção depende dos trechos vizinhos; elevação depende do chão) — resolvidas pela ordem fixa das camadas e pelo halo |
| "mínimo" | contador de trabalho por camada nos testes de escala (fase 0): células refeitas por edição constante |

Cuidados que as fontes dão: (i) **minimalidade e parada antecipada não vêm juntas com
bit sujo**: depois de marcar sujos os dependentes transitivos, "limpar" os que a parada
antecipada dispensa é difícil (Excel); a opção do Shake/Salsa é guardar a chave de
entrada e comparar, não marcar adiante; (ii) rastros construtivos **profundos** (só
hashes dos terminais) não suportam parada antecipada, só nos `n` níveis — a chave de
uma célula deve incluir *as saídas já calculadas* das camadas anteriores dos vizinhos,
não só o documento; (iii) tarefas devem ser determinísticas (o `world` e o `sim` já não
chamam `Math.random`, `CLAUDE.md`).

**O oráculo já existe para a rede e a elevação** — `tests/world/incrementalRebuild.spec.ts`:
depois de **cada** op das sequências do fuzzer (`generate(seed, length)`, `ORACLE_SEEDS`
= 8, `ORACLE_OPS` = 24 por padrão) e sobre cada fixture gravada, a rede mantida
incrementalmente e as alturas resolvidas a partir da solução anterior têm que ser
**exatamente** (por `networkLines`, `laneletLines`, linhas de perfil e de altura de
nó) as de uma rede e de uma solução feitas do zero (`expectSameAsFull`). O padrão serve
a cada camada nova de células: a mesma lista de ops e fixtures, resumo canônico da
camada por célula, e comparação com a reconstrução completa. Sobre isso entra o
oráculo de **escala** da fase 0: o contador `células refeitas` para a mesma via
isolada tem que ser igual no mapa de 0,7 km e no de 4,3 km (sonda B1).

### 3.5 Desfazer por comando com inverso

**Hoje.** `History` guarda o **texto JSON do documento inteiro** antes de cada edição
(`history.ts:13–60`), 60 passos e 96 MiB (`:24–33`); `mutateBuilt` (`main.ts:1198–1231`)
tira o texto antes (`serializedDoc()`), roda a edição, tira o texto depois e **compara
os dois como texto** para saber se algo mudou (`main.ts:1211`: `if (before ===
serializedDoc()) return false`); o desfazer reescreve o documento (`restoreSnapshot` →
`replaceFromJSON`, `history.ts:133–134`). O custo é O(documento) duas vezes por edição
(os 65–112 ms por via do mapa do jogador, "clone do mapa" ~90 ms, relatório 5.11).

**O que as fontes pedem e o código oferece.**
- *Guardar valores, não instantâneos.* Nystrom, Figma, tldraw e Excalidraw guardam o
  que mudou. O jogo tem o ponto único de escrita: o diário (`changes.ts` cabeçalho:
  "toda mudança passa por um lugar"; `DOC_CHANGE_KINDS`, `changes.ts:52`), e os
  mutadores do `RoadDoc` chamam `changes.record(kind, rects, { ids })`
  (`changes.ts:154`). A imagem anterior dos registros tocados pode ser capturada
  **nesses mesmos pontos** (o análogo do interceptor de `store` do tldraw): `ids` já
  nomeia os registros, falta o *valor antes*. Um diff `{ added, updated(de, para),
  removed }` por edição, em registros do documento (nó, segmento, prédio, poste, lote,
  zona, carimbo…), é o `RecordsDiff` do tldraw, e a entrada de histórico guarda o
  inverso.
- *Inverso recalculado no desfazer.* Figma ("um desfazer modifica o histórico de
  refazer no momento do desfazer") e Excalidraw (aplica o delta à cena atual e empilha o
  inverso do que **de fato** foi aplicado): ao aplicar o inverso, ler o valor corrente
  dos registros e guardá-lo como o refazer — assim um desfazer após mudanças feitas
  por outro caminho (um sistema derivado que reescreveu um registro, p. ex. a
  elevação ou as luzes) não restaura valores obsoletos.
- *Ids monotônicos* (`ids.ts`): desfazer a criação de um nó e refazê-la reusa o mesmo
  id sem colisão, e `reserve` mantém o contador acima (`doc.ts:1608`).
- *Gesto = uma entrada.* O tldraw funde tudo desde a última marca num `pendingDiff` e
  desfaz até a marca anterior numa só aplicação; o jogo tem gestos com vários passos
  (arrastar um nó, pincel de terreno): funda-se os diffs de um gesto e fecha-se com a
  marca no fim do gesto (`causeNext` do diário já nomeia a ferramenta/gesto,
  `changes.ts:147–154`).
- *"Nada mudou"* hoje é comparar dois textos (`main.ts:1211`); com diff vira "diff
  vazio". O tldraw otimiza justamente isso: só reavalia o vazio quando entram ou saem
  registros.
- *Limite*: a pilha deixa de ser em bytes do mapa e passa a ser em passos (os diffs
  são proporcionais ao que mudou); o teto de 96 MiB do `History` vira o orçamento de
  bytes de diffs, e o contador de passos (60) pode subir.
- *Exportar/importar* continuam usando o texto do documento inteiro (`toText`), e só
  nesse caso (regra 9.7.4 do relatório).

Dificuldades específicas: o desfazer atual desfaz **também** o que a edição derivou
no documento (um prédio demolido pela via, `buildings.afterRoadEdit()` e `clearBulbs`
na mesma passada, `main.ts:1218–1224`: "no mesmo passo do desfazer"): o diff tem que
cobrir esses efeitos, ou ser capturado em torno de toda a sequência. A *economia* (o
saldo, `kind: 'economy'` no diário) também é desfeita com a edição hoje, por ser parte
do texto. Estruturas **não** em registros (a `BuildingStore`, que guarda `revision` e
`size`, `main.ts:1184`) precisam do mesmo contrato de diff.

### 3.6 Autosave por célula no IndexedDB

**Hoje.** `saveSession` serializa o documento inteiro; se cabe em 2,4 M caracteres vai
para `localStorage` (limite de 5 MiB do MDN), senão para o IndexedDB como **uma
string** numa chave (`persistence.ts:37–60,160–187`; `storePut` em `:762–764`);
700 ms depois de cada edição (`DEBOUNCE_MS`, `saveSoon` `:140–146`); a cidade gerada
(1 530 prédios) tem 12,7 MB de texto (`persistence.ts:37–44`). O texto é reaproveitado do
desfazer (`documentText`, `:151–157`) — por isso o autosave hoje pega carona na
comparação de texto de `mutateBuilt`. Ao trocar o desfazer por diffs, o autosave passa
a **precisar do seu próprio caminho** (não haverá mais o texto inteiro à mão).

**Esquema proposto (derivado das fontes e do código):**
- Uma loja `cells`, chave `"<peça>:<quadrante>"` (ou um inteiro), valor = os registros
  *donos* da célula (serializados como hoje, em texto JSON, que o código já sabe ler e
  escrever) + o número de série do diário em que foi gravada; uma loja `meta` com o que
  é global (saldo, relógio, configurações, contadores de id, transporte se for global,
  clima) e a versão do esquema; uma loja `index` opcional (mapa de célula para bytes e
  série). O `localStorage` fica só como ponteiro/pequeno cache, como já é.
- **Sujas por diário**: `since(serialDoUltimoSalvamento)` → retângulos → células (+halo);
  se o anel esqueceu (`null`), compara a impressão (hash) de cada célula com a gravada.
- **Uma transação `readwrite` por lote** de células sujas, com o `meta` — atômica (se a
  transação aborta nenhuma célula fica pela metade). Durabilidade: o MDN recomenda
  `relaxed` para "registros que mudam rápido" e `strict` quando perder dado pesa mais
  que custo; para o autosave contínuo de edição `relaxed` serve, com um salvamento
  `strict` ao sair (`pagehide`/`visibilitychange`) — o padrão de cada navegador **não**
  está na página lida. Medir o tempo da transação nos dois modos.
- **Cotas**: Chromium dá até 60% do disco total por origem; 12,7 MB de cidade são
  desprezíveis, mas um mundo do tamanho do planeta preenchido seria da ordem de
  centenas de MB; pedir `navigator.storage.persist()` (Chromium decide sem perguntar,
  pelo histórico de interação) e `estimate()` no F9 evita o despejo tudo-ou-nada da
  origem; escritas devem tratar `QuotaExceededError`.
- **Estimativa de ganho (minha)**: a cidade gerada ocupa algumas dezenas de células
  de 256 m; uma edição suja de 1 a 4 delas, ou seja cerca de 0,4–1,5 MB de escrita
  contra 12,7 MB — uma ordem de grandeza; **a medir** com a sonda do relatório
  (`scripts/probe-doc-size.mjs`).
- **Carga**: ler todas as células (ou as do entorno da câmera, com streaming de
  documento — passo opcional, depois) e recompor; o fecho de referências entre células
  (3.3) tem de ser resolvido antes de construir derivados. O cache derivado
  (`render/derivedCache.ts`, IndexedDB por impressão do código) continua separado.
- **Migração**: as duas chaves antigas (`roadcraft.world.v7`, `roadcraft.planet.atlas864.v1`)
  viram células na primeira abertura; a versão do esquema vai em `meta`.

---

## 4. Riscos e o que medir

1. **Projeção:** o limite prático de "plano pela dobra" (1–2 km do ponto olhado) vs. o
   que o jogador espera ver no modo plano de longe (mundo inteiro). Medir: erro
   de posição entre o que a carta da peça e a carta em torno do ponto olhado dão para
   vias longas em duas ou três distâncias (sonda a partir do cálculo de 3.1); fotos
   do mesmo lugar em `k` = 0,02, 0 e 1.
2. **`k = 0` no shader:** divisão por zero em `planetBent` (`bend.ts:133`) e em
   `planetDrawnSphere`/`planetDaylight` (`R − R/k`); o ramo limite precisa nos dois
   lados (GLSL e CPU); testar a continuidade em `k → 0` (`bendSeam.spec.ts` é o vizinho).
3. **Migração com perdas** nas coleções com forma: zonas (retângulo → polígono na
   carta comum), lotes, muros e trilhos do transporte; o `oldMapsIdentical` deve ser
   estendido com um "mapa plano antigo → planeta → mesmas medidas em metros".
4. **Diário incompleto**: o oráculo só prova o que o diário vê; um mutador que escreve
   sem registrar quebraria tanto a invalidação quanto o desfazer (Nystrom, "Dirty
   Flag": a bandeira que um caminho esquece é o bug). Mitigação: um spec que percorre os
   mutadores do `RoadDoc` e exige que cada um registre no diário (e o `docText.spec`
   existente).
5. **Atomicidade do desfazer** com efeitos derivados no mesmo passo (prédio demolido,
   economia): definir a fronteira do diff e testar "desfazer N vezes e refazer N vezes
   devolve o texto do documento original" (o princípio do Figma) em todas as
   sequências do fuzzer (`tests/fuzz/support/ops.ts`).
6. **Autosave**: o caminho novo perde a carona no texto do desfazer; medir CPU de
   serializar as células sujas e o tempo de transação; testar a recuperação quando o
   navegador morre no meio (transação abortada); testar quota (preencher até
   `QuotaExceededError`) e `persist()`.
7. **Células na borda da peça**: registros que atravessam a borda têm dono único (âncora)
   mas geometria em duas cartas; os derivados do vizinho dependem do halo. Contar em
   teste de escala as células refeitas por edição de uma via que cruza uma borda de peça
   e uma borda de face do cubo.
8. **Memória do diff**: um carimbo de terreno ou uma pincelada afeta muitos registros;
   decidir a granularidade (por registro, como o tldraw, ou por região de textura).

**Medidas de aceite desta fase (as do PROMPT):** (a) sonda B1: `commitDraft`,
`net.rebuild`, preparo, troca e rede de pedestres da via isolada **iguais** de 0,7 a
4,3 km; (b) oráculo "incremental = do zero" por camada; (c) tamanho médio do diff de
desfazer por edição e bytes escritos por autosave, em um mapa de 3 MB e em um de 30 MB
(relatório 5.11, validação); (d) spec de ida e volta.

---

## 5. O que NÃO foi possível ler (ou só em resumo)

- **Snyder, PP 1395, pp. 191–202**: não lido (PDF acima do limite da ferramenta; o
  texto no archive.org deu 404 depois do redirecionamento). As fórmulas vêm do
  MathWorld (que cita essas páginas; extração com aviso de fórmulas reconstruídas) e o
  fator transversal coincide com o comentário do próprio código e com a minha conta.
- **Unreal**: a página de World Partition não traz tamanhos padrão de célula nem diz se o
  ator é atribuído por centro ou por caixa; a de HLOD não descreve a transição entre
  célula e proxy.
- **3D Tiles**: lido por extração dirigida (não os 100% do `README.adoc`); o spec de
  tiling implícito (propriedades `subtreeLevels`, formatos) não foi aberto.
- **Build Systems à la Carte**: li as seções 2 (propriedades), 4 (estratégias) e a
  tabela 2; não li as demonstrações nem a seção 6 (aplicações). **Salsa**: a página lida
  não definia `verified_at`/`changed_at`; sem o código de `salsa`.
- **tldraw e Excalidraw**: lidos por extração do código (o corpo de `reverseRecordsDiff`
  e de `StoreDelta.inverse` não apareceu); **Figma**: o texto não diz como o desfazer é
  implementado, só o princípio.
- **IndexedDB**: o padrão de durabilidade de cada navegador não consta no MDN lido; não
  li a especificação do W3C (transações, auto-commit) nem o custo de clone estruturado
  de strings grandes versus objetos.
- **Nystrom, "Spatial Partition"** e o Minecraft/Anvil (um arquivo por região de
  chunks) não foram relidos; o relatório F50 cobre a parte conceitual.
- **A causa de a placa velha ter 16 peças** é minha conta (1,92 km / ~500 m); o número
  exato de peças que ela cobre depende da orientação das cartas no `HOME_TILE` e deve
  ser medido.
