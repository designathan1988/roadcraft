# Onde o jogo trava — arquivo histórico (congelado em 2026-10-08)

> **Congelado.** O registro vivo é `docs/PROBLEMAS.md`; os itens ainda abertos
> daqui passaram para lá (P17, P18, P19), junto com o roteiro de medida e as
> regras. Este arquivo fica só porque o código cita os números dele (#1-#50).
> Não acrescente nada aqui.

Este arquivo existe para que ninguém precise refazer a auditoria. Cada travamento
encontrado fica aqui com: **causa** (o mecanismo, não o sintoma), **evidência
medida**, **onde está**, **correção estrutural** e **proteção contra a volta**.
Quem mexer em desempenho lê isto primeiro, mede com o mesmo roteiro e atualiza as
linhas que mudar. O histórico fica no git; aqui fica o estado atual.

## Como medir (sempre o mesmo roteiro)

```bash
npm run dev
node scripts/probe-hitches.mjs            # mapa vazio: desenha 8 vias com a ferramenta real, 10 carros, 10 pessoas
node scripts/probe-hitches.mjs --town     # a vila padrão (761 prédios): vias curtas dentro dela
```

O roteiro usa a ferramenta de vias de verdade (dois cliques e Esc) com o trânsito
e as pessoas do painel rodando. Para cada quadro acima de 50 ms ele mostra:

- programas de shader linkados, bytes enviados à placa (texturas e buffers) e
  leituras síncronas;
- o JavaScript que rodou no quadro (amostras da JS Self-Profiling API);
- as etapas cronometradas no código com `performance.measure('hitch:…')`
  (edição de via por etapa, tiles construídos/reaproveitados, classe de corpo,
  cabelo, ajuste de roupa) e `person-rig/face/bake` (corpos cozidos montados na hora).

Cuidados ao ler os números:

- O Chrome headless daqui desenha na Intel UHD 770, não na RTX 3060 do jogador:
  compare números só entre si.
- As **amostras** do profiler indicam *onde* está o custo, não *quanto*; o tempo
  exato vem dos `hitch:` (User Timing).
- Envio de textura parcial é contado inteiro (limite superior); buffers com
  intervalo (`addUpdateRange`) são contados pelo intervalo.
- A máquina é compartilhada: rode antes e depois na mesma sessão.

## Quadro geral (2026-10-06)

| # | Mecanismo | Quando trava | Medido antes | Estado |
|---|---|---|---|---|
| 1 | Coisas sobre o chão com chave de cache global | toda edição de via | trens relinkavam shader a cada via; todos os dependentes refeitos no mapa inteiro | **CORRIGIDO** |
| 2 | Mapa sem prédios remodelava o chão inteiro | toda edição de via em mapa sem prédios | invalidava tudo (via #1) | **CORRIGIDO** |
| 3 | Chão remodelado bloco a bloco, cada bloco com laços globais | edição de via que move vários blocos | 35–100 ms de "ground" | **CORRIGIDO** (medir de novo) |
| 4 | Materiais do transporte criados a cada reconstrução | toda edição de via | 1 shader relinkado por via | **CORRIGIDO** |
| 5 | Cabelo: busca de vizinho por força bruta; trança travava o jogo | cada penteado novo | 70–395 ms; trança: sem fim | **CORRIGIDO** (árvore k-d; 48–160 ms restantes) |
| 6 | Classe de corpo procedural montada de uma vez | cada classe nova (8) | 40–240 ms | **PALIATIVO** (fatiada); causa: não é pré-cozida (#8) |
| 7 | Corpos cozidos vencidos: queda silenciosa para montagem em runtime | motorista, pessoas em prédios | 200–550 ms por corpo | **CORRIGIDO** (impressão pelo fecho de imports; recozido) |
| 8 | Pessoas procedurais (classes, cabelo, roupas) sem caminho de cozimento | primeiros minutos, cada tipo novo | soma de segundos | **CORRIGIDO** (classes e penteados cozidos; só o rig da classe e o ajuste de roupa, ≤ 11 ms, ficam no jogo) |
| 9 | Malha das vias: todos os tiles fundidos e reenviados a cada edição | toda edição de via | fusão 28–35 ms + 50–80 MB enviados (quadros de 400–850 ms na vila) | **CORRIGIDO** (blocos 4×4 mantidos na placa) |
| 10 | Digest da solução de alturas invalidava a rua inteira / o mapa inteiro; o mundo inteiro refeito no quadro da edição | toda edição de via | 900 blocos na primeira via; quadros de 160–500 ms na vila | **CORRIGIDO** (digest local; mundo refeito em fatias e trocado de uma vez) |
| 11 | Calçadas: buscas no mapa inteiro para cada ponto/porta; tudo num quadro | toda edição de via | `buildWalkways` 57 ms + grafo dos pedestres 62 ms na vila | **CORRIGIDO** (28 + 27 ms, redes idênticas, em quadros separados) |
| 12 | Prédios: alterados e células montados no quadro da edição | via que remove prédios ou mexe no chão deles | quadros de 285–533 ms (`assembleByCell`, 49 MB) | **CORRIGIDO** (prédios e células montados em fatias antes da troca) |
| 13 | Calçadas, cenário, mobiliário, postes, placas refeitos no mapa inteiro | toda edição de via | baratos hoje (< 10 ms na vila), mas globais | **ABERTO** |
| 14 | Biblioteca de animações em cache fraco: descartada e decodificada de novo | pessoas novas depois de um tempo | 12,8 MB de base64 decodificados de novo, um caractere por vez | **CORRIGIDO** (cache permanente; decodificador nativo) |
| 15 | Vagas: cada vaga e cada lote olhavam todas as faixas; calculadas duas vezes por edição; todos os lotes refeitos | toda edição de via | 51 + 36 ms na vila | **CORRIGIDO** (grade de faixas, uma conta por revisão, lote guardado pelo que lê: 15 ms, vagas idênticas) |
| 16 | Clique em prédio: piso de cada prédio calculado antes do descarte barato | clique com a ferramenta de inspeção | 85 ms por clique na vila | **CORRIGIDO** |
| 17 | Rede viária: todas as junções resolvidas 2–3 vezes por via, cópia de trabalho sem memória | toda via desenhada | 13 ms por rebuild × 3 na vila | **CORRIGIDO** (junções guardadas pelo que as constrói: 2–5 ms, idênticas) |
| 18 | Fachadas de cada prédio recalculadas por plataformas, portas, assinatura e malhas | toda edição | um prédio grande: ~70 ms numa fatia | **CORRIGIDO** (uma vez por registro) |
| 19 | Cópia de trabalho do documento por JSON, prédios inclusos, e comparação por JSON | toda via desenhada | cópia 13 ms + volta 20 ms na vila | **CORRIGIDO** (prédios compartilhados: 1 + 2 ms) |
| 20 | `world.clear()` apagava muros, transporte, jardins e floresta a cada via | toda edição de via | sumiam da tela (defeito introduzido em 4c2f36a) | **CORRIGIDO** (a troca remove só o que substitui) |
| 21 | Clique que grava a via: mapa inteiro escrito como texto, túnel testado com o chão analítico | toda via desenhada | 58–95 ms por clique na vila | **CORRIGIDO** (texto por prédio guardado; chão já amostrado: 14–26 ms) |
| 25 | Via derruba prédio: cada prédio testado contra todas as vias e junções do mapa | toda via desenhada | ~760 × ~140 testes por via na vila | **CORRIGIDO** (grade de vias por revisão da rede, `validate.ts` `RoadContacts`) |
| 26 | Topo do prédio mais alto (sombras): caixa de cada malha instanciada calculada no quadro da troca | via que muda prédios | todas as janelas da célula percorridas num quadro | **CORRIGIDO** (caixa e esfera feitas na montagem em fatias) |
| 27 | Pedestres reencaixados na rede nova: Dijkstra com fila varrida inteira e sem parar no destino, por pedestre, num quadro | toda via desenhada | `rebind` dominava quadros de ~70 ms | **CORRIGIDO** (heap binário, para ao chegar; `core/heap.ts`) |
| 28 | Trabalhos em fatias com cotas próprias somadas no mesmo quadro; terreno dos prédios derrubados nivelado no quadro da edição | toda via desenhada | quadros de 60–90 ms depois da edição | **CORRIGIDO** (cota única de 10 ms por quadro, `core/frameWork.ts`; nivelamento dentro das fatias) |
| 29 | Cabelos gerados durante o jogo: pacote cozido desatualizado (código das pessoas mudou) e a faixa de cabelo nunca cozida | pessoas chegando | cabelos de 46–86 ms cada; a faixa era o maior consumo de script; 9 quadros > 50 ms ao desenhar vias | **CORRIGIDO** (faixa no pacote; `npm run cook:people` depois de mexer em pessoas: 9 → 1 quadros > 50 ms na mesma rodada) |
| 30 | Máscara da grama: canvas RGBA 2048² por anel de grama, redesenhado e enviado inteiro a cada edição | toda via ou prédio | 2 × 16,8 MB enviados por via | **CORRIGIDO** (uma máscara de um canal, 4,2 MB, compartilhada; só a área que mudou redesenhada e enviada; `grassField.ts` `createGrassMask`) |
| 31 | Texturas de pele e olhos decodificadas no quadro em que vão à placa (`<img>`) | pessoas chegando, carga | 10,7–13,7 ms por pele | **CORRIGIDO** (`createImageBitmap` fora da thread principal: 3,4 ms; `skinAppearance.ts`) |
| 32 | Platôs de todos os prédios calculados num passo só das fatias da edição, depois que a memória deles era zerada | via que move o chão | quadro de ~53 ms | **CORRIGIDO** (um prédio por passo, `shapeBlocksSteps`) |
| 33 | Primeira fatia do mundo novo no próprio quadro da edição; um bloco de terreno inteiro (160 m) por passo | toda via desenhada | +10 ms no quadro do clique; passos de 18 ms | **CORRIGIDO** (a reconstrução começa no quadro seguinte; terreno em quartos de bloco; etapas do quadro medidas como `hitch:draw/*`) |
| 34 | Superfícies das vias: os resumos de todas as peças reaproveitadas calculados sem pausa | toda via desenhada | fatias de 20–30 ms depois da edição | **CORRIGIDO** (pausa depois de cada peça; detalhes, cenário, postes e mobiliário medidos como `hitch:road-edit/*`) |
| 35 | Clique da via: cópia de trabalho reconstruía a rede inteira; alturas da rede resolvidas duas vezes (túnel e desenho) | toda via desenhada | ~5 + ~5 ms por clique | **CORRIGIDO** (a cópia herda a rede viva, `adopt`; o desenho recebe as alturas do teste de túnel, `offerElevation`) |
| 22 | Gravação automática serializava o mapa inteiro 700 ms depois de cada edição | toda edição | tarefa de 83 ms (trace) | **CORRIGIDO** (reaproveita o texto do desfazer) |
| 23 | `surfaces()` unia os quatro níveis do mapa para devolver um (calçadas, postes, verge) | toda edição | 4× o trabalho de união | **CORRIGIDO** (`levelPolygons` do nível usado) |
| 24 | Rig de cada classe de corpo montado quando o primeiro pedestre da classe chegava | primeiros pedestres | 58–105 ms × 8 | **CORRIGIDO** (os 8 preparados ao abrir o mapa, um por vez) |
| 36 | Vegetação do ecossistema com chave `doc.revision`/`buildings.revision`: varredura do mapa (147 456 células) e 36 malhas instanciadas recriadas | toda via, prédio, crescimento de zona (2/s) e desgaste (3 s) | não medido (lido no código, 2026-10-08) | **CORRIGIDO** (varredura × passe; malhas reescritas no lugar; `renderer.ts` `natureSweep`/`natureKeep`, `natureTrees.ts` `update`) |
| 37 | Pedras, mato, floresta pintada e pedras de rio refeitos por toque na união da área pintada e da água (rio: retângulo inteiro a 3 u) | toda via e prédio perto de rio ou pintura | não medido | **CORRIGIDO** (`coverSweep`/`coverKeep`) |
| 38 | LOD das árvores reenviava a capacidade inteira dos buffers | câmera andando 60 u | não medido | **CORRIGIDO** (`addUpdateRange` só do desenhado) |
| 39 | `onCarriageway` percorria todas as vias por ponto | toda reconstrução de plantas | não medido | **CORRIGIDO** (grade por rede, `world/carriageway.ts`) |
| 40 | Jardins, muros, transporte e fila dos prédios refeitos a cada quadro do job da edição (cada fatia marca o chão) e testados contra a união de todos os itens | toda via | não medido | **CORRIGIDO** (esperam o fim do job; áreas por item em `groundChanges.ts`; plantas por prédio) |
| 41 | Desgaste/nome/plano do lote renivelavam o lote (registro novo = lote novo) e refaziam as vagas | a cada 3 s com a cidade envelhecendo | não medido | **CORRIGIDO** (texto do lote por registro: `renderer.ts` `siteTextOf`, `agents/parking.ts` `lotText`) |
| 42 | Religação das portas: filtro de todos os obstáculos do mapa por porta | todo prédio novo | ~40 ms medidos para a religação inteira (#11) | **REDUZIDO** (grade de obstáculos, mesma chave); a religação ainda passa por todos os prédios |
| 43 | Viadutos, postes e mobiliário do mapa inteiro refeitos a cada via | toda via | < 10 ms cada na vila (#13) | **CORRIGIDO** (mantidos quando os blocos da edição não os alcançam) |
| 44 | Construir: segundo contexto WebGL solto a cada 4 s ocioso, `readPixels` e `toDataURL` síncronos por miniatura, miniaturas refeitas toda sessão | 1º uso do Construir e cada volta após 4 s | não medido | **CORRIGIDO** (cache no IndexedDB, `toBlob`, contexto mantido em uso) |
| 45 | Prévias das ferramentas (fantasma do prédio, trilhos, lotes) compiladas no quadro do 1º uso | 1º uso de cada ferramenta | não medido | **CORRIGIDO** (`warmPreviewShaders`) |
| 46 | Gravação automática síncrona no meio de um quadro, 700 ms após a edição | toda edição | não medido | **CORRIGIDO** (tempo ocioso; fechamento continua síncrono) |
| 47 | Pick do ponteiro descia o raio de 160/600 u, 2 leituras de layout por movimento | todo movimento do ponteiro | não medido | **CORRIGIDO** (`surfaceTop`, `landTop`) |
| 48 | Abertura: texturas procedurais (~70 MB) assadas a cada abertura antes do renderer | toda abertura | não medido | **CORRIGIDO** (cache derivado no IndexedDB sob a impressão das receitas) |
| 49 | Abertura: mundo, prédios e programas de shader num quadro só | toda abertura | não medido | **CORRIGIDO** (job fatiado, `compileAhead` antes da troca, prédios fatiados) |
| 50 | Abertura: ez-tree (4 MB) e as 6 árvores geradas numa tarefa, durante a abertura | toda abertura | não medido | **REDUZIDO** (depois do 1º mundo, uma variedade por tarefa); o kit não é guardado |

---

## 1. Chave de cache global para tudo que está sobre o chão — CORRIGIDO

**Causa.** Em `render/renderer.ts`, muros/cercas, transporte, jardins, floresta,
prédios e as plantas sob prédios tinham como chave de cache dois contadores
globais: `rebuilds` (sobe a cada reconstrução do mundo, ou seja, a cada via) e
`groundVersion` (sobe a cada nivelamento do chão em qualquer lugar). Uma via
desenhada num canto reconstruía todos eles no mapa inteiro, mesmo sem nada perto
e até sem nada (a malha vazia dos trens era refeita e seu shader relinkado a cada
via). A reconstrução do chão era por região, mas a invalidação era global.

**Evidência.** Programas de shader comparados antes e depois de cada via
(`scripts/probe-hitches.mjs`, relink): a cada via, um programa `transit-trains`
destruído e outro criado; `link=1` em todo quadro de edição.

**Correção estrutural.** `render/groundChanges.ts`: um registro único de
**onde e quando** o chão desenhado mudou. Quem altera o chão marca o retângulo:
`shapeGround` marca a região remodelada; `rebuildWorld` marca os blocos onde a
solução das vias mudou (`changedBlocks`, que já existia). Cada dependente é um
`GroundDependant`: é refeito só se a **sua própria revisão** mudou ou se uma
mudança desde a última construção **toca a sua área**. Sem conteúdo, não tem
área e nunca é refeito por causa do chão. Os prédios fazem o mesmo prédio a prédio
(`buildings/layer.ts`, `groundTouched`): só reamostram o chão os prédios cuja
encosta uma mudança alcançou. As plantas sob prédios passam a depender só dos
prédios (`buildings.revision`).

| dependente | chave própria | área |
|---|---|---|
| muros, cercas, sebes | `barrierRevision` | pontos dos muros |
| transporte | `transitRevision` | paradas e trilhos + 40 m (entrada de metrô procura lugar em volta) |
| jardins | plantas dos prédios | encosta dos prédios com plantas |
| floresta | `forestRevision` | pinceladas de floresta |
| prédios | — | encosta de cada prédio |

**Proteção.** A regra: nada em `render/` usa contador global como chave de
cache de coisa local; o que depende do chão usa `GroundDependant`. A fazer: teste
em `tests/render/` que desenha uma via longe de um muro e conta que o muro não foi
refeito.

## 2. Mapa sem prédios remodelava o chão inteiro a cada via — CORRIGIDO

**Causa.** `rebuildWorld` só usava o caminho por blocos (`shapeBlocks`) se
`padsCache` existisse, e ele é `null` em mapa sem prédios. Resultado: em mapa
sem prédios, que é o caso do jogador que começa desenhando vias, toda via
remodelava o mapa inteiro e marcava "tudo mudou".

**Correção.** Os blocos vêm só das duas soluções de via; a condição de `padsCache`
saiu (`renderer.ts`, comentário no lugar).

## 3. Chão remodelado bloco a bloco com laços globais — CORRIGIDO

**Causa.** `shapeBlocks` chamava `terrain.shapeToRoads` uma vez **por bloco**, e
cada chamada percorre todos os cantos já moldados, as caixas de todas as vias e
recalcula a esfera envolvente do terreno inteiro (90 mil vértices). Uma via que
mexe em 20 blocos pagava os laços globais 20 vezes.

**Evidência.** Com a #2 ligada, `hitch:road-edit/ground` subiu para 35–50 ms no
mapa vazio e 45–100 ms na vila.

**Correção.** `shapeToRoads` aceita várias regiões numa passada só
(`render/terrain.ts`); `shapeBlocks` passa todos os blocos de uma vez.

## 4. Materiais do transporte criados a cada reconstrução — CORRIGIDO

**Causa.** `render/transit.ts` criava materiais novos em toda reconstrução e os
descartava na seguinte. Contraria a regra do `src/render/CLAUDE.md` ("nunca crie
material dentro de uma reconstrução"). Com a #1, o transporte nem é mais refeito
por causa das vias; os materiais compartilhados garantem que, quando for, nenhum
shader é relinkado.

**Correção.** `sharedMaterial()`: um material por combinação de parâmetros, feito
uma vez.

## 5. Cabelo: vizinho mais próximo por força bruta — CORRIGIDO

**Causa.** `people/hair/procedural.ts` `pinned`: cada vértice do penteado
(dezenas de milhares) procurava os 3 vértices mais próximos da cabeça percorrendo
todos (cerca de 3 mil).

**Evidência.** `hitch:person/hair` de 70 a 225 ms por penteado novo (manBun 186,
longHeadband 225, bob 180).

**Correção.** `nearestThree`: grade uniforme percorrida em anéis (hash espacial),
com o mesmo critério de desempate. **Proteção:** `tests/people/hairPinning.spec.ts`
compara com a busca antiga em 4 mil pontos, incluindo empates exatos.

**Trança travava o jogo (098d595).** A trança tinha fios que paravam no laço no
primeiro passo: um cartão de um ponto só (`t = 0/0`, cantos NaN, o mesmo do erro
"Computed radius is NaN" no console), e a busca em grade nunca terminava num ponto
NaN. Corrigido nos dois lugares. **Proteção:** `tests/people/hairStyles.spec.ts`
gera todo penteado do jogo e exige números finitos.

**Árvore k-d (5ee5a05).** A grade varria quase todas as células para fios longe do
couro cabeludo (afro). Trocada por árvore k-d podada pela caixa de cada subárvore,
sem alocação por candidato: afro 395 → 159 ms, cacheado 298 → 131, longHeadband
192 → 76. Restam 48–160 ms por penteado novo; a causa de fundo é a #8.

## 6. Classe de corpo procedural montada de uma vez — PALIATIVO

**Causa aparente.** `render/people/proceduralCrowd.ts` `buildClass`: o rig, 16
componentes de forma (`rig.deltas` no corpo inteiro), 12 canais de expressão e os
clipes rodavam numa tacada só: 40–240 ms por classe (são 8: 2 sexos × 4 faixas
de idade).

**Feito.** O trabalho foi fatiado em pedaços de ~4 ms por quadro (`breathe`, o
mesmo de `citizenBake.ts`). Isso **só espalha o custo**. A causa é a #8: esses
dados são determinísticos e deveriam vir prontos do disco.

## 7. Corpos cozidos vencidos: queda silenciosa para runtime — ABERTO

**Causa.** Os corpos cozidos (`cooked/people`, `npm run cook:people`) levam uma
impressão digital de **todo** o código em `src/people` e `src/render/people`
(`cook-plugin.ts`). Qualquer edição ali, mesmo uma que não muda esses corpos (como
a multidão procedural), invalida o cozimento. O jogo então monta cada corpo na
hora sem avisar ninguém: o aviso só aparece no console do servidor de
desenvolvimento.

**Evidência.** Manifesto cozido em 2026-10-05 22:55; o código de pessoas mudou
depois disso (e7174cf, 2a1cbac). Medido: `person-rig` 35–80 ms, `person-face`
33–80 ms e `person-bake` 130–555 ms por corpo, durante o jogo.

**Correção (6673cfb).** A impressão é o fecho de imports de
`riggedCitizens.ts` (`cook-plugin.ts` `importClosure`): editar a multidão
procedural não invalida mais os corpos. Recozido (`npm run cook:people`, 14 s).
**Proteção:** `tests/tooling/cookFingerprint.spec.ts`; o build (e portanto o
`npm run check`) recusa cozimento vencido.

**Não fazer:** cozinhar automaticamente no servidor de desenvolvimento. Foi
tentado: a cada reinício do servidor ele abria um Chrome invisível, e com edições
seguidas isso pôs a CPU do jogador a 100% e travou o computador (2026-10-06).
Removido. Depois de mexer em código de pessoas, rode `npm run cook:people` à mão,
uma vez.

## 8. Pessoas procedurais sem caminho de cozimento — ABERTO

**Causa.** A multidão procedural (2a1cbac) monta tudo no navegador do jogador:
8 classes de corpo (base de forma, expressões, clipes), cada penteado
(`generateHair`) e cada roupa ajustada a cada classe (`rig.wear`). Tudo isso é
função só dos assets e do código, igual em toda partida. É o caso clássico de
conteúdo que se cozinha antes (*cooked assets*, como as engines fazem).

**Correção a fazer.** Incluir no cozimento os dados de cada classe (texturas de
forma e expressão, base das juntas, clipes; 6,3 MB por classe, medido) e os
pacotes de cabelo. Tentado em 2026-10-06: as 8 classes cozinham bem, mas algum
penteado em `HAIR_STYLES` estoura a memória ao ser gerado (a aba do cozimento
caiu; num teste em Node a geração não terminou em 300 s). Era a trança (#5),
já corrigida.

**Aplicado (2026-10-06).** `render/people/proceduralCook.ts` lê de
`cooked/procedural/` os dados das 8 classes (base de forma, expressões, base das
juntas, clipes; 6,3 MB cada) e os cartões dos 28 penteados, com impressão própria
(fecho de `proceduralCrowd.ts`). `npm run cook:people` cozinha tudo (≈ 40 s, em
prioridade baixa). Medido no jogo: nenhuma classe nem penteado montado em jogo;
restam o rig de cada classe (`createPersonRig`) e o ajuste de cada roupa (≤ 11 ms).
**Proteção:** `tests/render/cookPack.spec.ts`; o build recusa cozimento vencido.
Depois de mexer em código de pessoas: `npm run cook:people`, uma vez.

## 9. Malha das vias fundida e reenviada inteira a cada edição — ABERTO

**Causa.** `render/roadSurfaces.ts`: os tiles são reaproveitados (só os
alcançados são refeitos), mas no fim **todos** os tiles são fundidos numa malha
por superfície (`mergeTiles`) e a malha inteira vai de novo para a placa. Na
vila, uma via curta: fusão de 28–35 ms e 50–80 MB enviados, com quadros de 400 a
850 ms.

**Correção a fazer.** Malhas por bloco de tiles (por exemplo 4×4). Bloco com os
mesmos tiles mantém a malha e o buffer na placa; só os blocos tocados são
fundidos e enviados.

## 10. A edição de via refazia o mundo no próprio quadro — CORRIGIDO

**Causa.** `render/renderer.ts` `rebuildWorld` fazia tudo no quadro da edição:
plataformas dos prédios, chão, superfícies das vias (tiles a 4–13 ms cada),
estruturas, cenário, postes, mobiliário. Além disso o digest da solução de
alturas incluía a via inteira (uma junção numa ponta invalidava a rua toda) e
lia de um jeito diferente uma rede sem buckets (a primeira via mudava os 900
blocos do mapa).

**Correção.** No quadro da edição só a solução de alturas (≈ 8 ms, que os carros
leem). O resto é `worldSteps`: um gerador bombeado ~10 ms por quadro
(`pumpWorld`), o mundo antigo desenhado até o novo ficar completo e trocado de
uma vez, só o que é substituído (#20). Blocos de chão de uma edição atropelada por
outra passam para a próxima (`pendingBlocks`). Digest local por retângulo
(`world/elevation.ts` `localDigest`), alturas a 0,4 mm.

**Proteção.** `tests/render/roadTiles.spec.ts` (cache = construção do zero, bit a
bit, em várias edições na vila; menos de 25 blocos mudados por via curta).

**Medido na vila** (`scripts/probe-hitches.mjs --town`): pior quadro 851 → ~200 ms
(o restante são quadros de render no iGPU e o clique, ver #21); no mapa vazio,
8 vias longas com trânsito e pessoas: pior quadro 553 → 59 ms, nenhum acima de 100 ms.

## 11. Calçadas: buscas no mapa inteiro — REDUZIDO

Medido na vila, cache aquecido, depois de uma via curta (Node, um processo):

- `world/walkways.ts` (rede dos moradores): cada ponto de cada esquina media a
  distância até a borda externa de **toda** a calçada do mapa (um anel de
  milhares de pedaços numa rede ligada) - 46 de 57 ms. Agora uma grade dos
  pedaços (`NearestEdge`): 57 → 28 ms, rede idêntica (mesma impressão, 739 caminhos).
- `sim/peds/sidewalk.ts` (grafo dos pedestres): cada porta de cada prédio media
  todas as calçadas do mapa e descartava as além de 30 m; e as fachadas de cada
  prédio eram recalculadas a cada via. Grade de calçadas por alcance e fachadas
  guardadas por registro de prédio: 62 → 45 ms, grafo idêntico (2086 arestas).
- O cache de esquinas funciona: numa edição só 3 de 159 esquinas são refeitas.

Restante: as portas ainda são todas religadas a cada via (≈ 40 ms); o certo é
religar só as portas perto do que mudou (como a #1).

## 12. Prédios montados no quadro da edição — CORRIGIDO

`render/buildings/layer.ts`: quando uma via removia prédios ou mexia no chão
deles, os prédios alterados eram emitidos e as células de 240 m inteiras
remontadas (até 49 MB enviados) no mesmo quadro. Agora os prédios alterados são
emitidos ~6 ms por quadro e as células alteradas montadas uma por fatia
(`stagedCells`), com a cidade antiga desenhada; a troca só usa o que está pronto.

## 13. Reconstruções globais ainda baratas — ABERTO

Estruturas, cenário, postes, mobiliário e placas ainda são refeitos no mapa
inteiro a cada via (agora fora do quadro da edição, em fatias). Baratos hoje.

## 21. O clique que grava a via — CORRIGIDO

Medido na vila (`hitch:mutate`, `hitch:commit`, 6 vias seguidas): 95 → 14–26 ms,
dentro de um quadro. Três trabalhos que não deviam acontecer:

- **Texto do desfazer.** Cada edição escrevia o mapa inteiro como texto (~9 ms),
  quase tudo prédios que não mudaram. Os registros de prédio nunca mudam no
  lugar (`put` guarda uma cópia), então o texto de cada um é escrito uma vez e
  guardado por registro (`world/buildings/store.ts` `toText`,
  `world/doc.ts` `toText`): agora ~1 ms. Mesmo texto, caractere por caractere.
- **Teste de túnel com o chão analítico.** `editor/commit.ts` `boreDeepCuts`
  resolvia as alturas da rede inteira lendo o chão carimbo a carimbo (22 ms).
  Agora lê o chão já amostrado que o renderer usa para as mesmas alturas
  (`SceneHandle.naturalTerrainHeightAt`, passado pelo `main.ts`): 5–10 ms. Só
  roda se algum carimbo de terreno alcança as vias novas.
- **Índice do terreno refeito a cada via.** Guardado enquanto os carimbos são os
  mesmos (`sameStamps`).

**Proteção.** `tests/world/docText.spec.ts` (o texto é exatamente
`JSON.stringify(toJSON())` na vila, depois de mexer em prédios e vias, numa cópia
e num documento recarregado); os testes do editor seguem cobrindo o túnel com o
chão analítico.

## 14. Biblioteca de animações em cache fraco — CORRIGIDO

`render/citizenWalk.ts` guardava a biblioteca de animações decodificada num
`WeakRef`; o coletor de lixo a descartava entre uma pessoa e outra, e a próxima
a baixava e decodificava de novo (12,8 MB de base64, um caractere por vez). Agora
fica guardada (≈ 10 MB).

## 36-50. Ações mínimas e abertura (2026-10-08) — lido no código

O jogador relatou ações mínimas lentas (estrada, prédio, ferramenta, câmera) e a
abertura lenta. Diagnóstico pela leitura do fluxo, sem medir aqui (a iGPU desta
máquina não representa a RTX 3060 do jogador). O padrão comum: uma entrada barata e
frequente (uma via, um prédio, o crescimento de uma zona, o envelhecimento da
cidade a cada 3 s) presa à mesma chave de uma reconstrução cara do mapa inteiro
(Nystrom, "Dirty Flag": a marca grossa reprocessa o que não mudou).

- **Regra:** o que é caro e depende da terra, da pintura ou do ecossistema é
  *varrido* só quando essas mudam; o que depende de vias, prédios e chão é um
  *passe* sobre o que a varredura achou; malhas instanciadas são reescritas no
  lugar (buffers não mudam de tamanho, mas o conteúdo sim — manual do three.js
  r186, "How to update things") e só enviam à placa o que é desenhado.
- **Regra:** o que fica sobre o chão espera o job de uma edição terminar, e é
  testado contra os retângulos dos próprios itens, não contra a união da camada.
- **Regra:** um registro novo de prédio não é um lote novo: o nivelamento e as
  vagas comparam o texto do registro sem idade, nome e versão do plano do lote.
- **Cache derivado** (`render/derivedCache.ts`, IndexedDB): miniaturas do
  Construir e texels das superfícies, sob a impressão digital do código que os
  faz (`cook-plugin.ts` `DERIVED`). Sempre regenerável: o navegador pode despejar.
- **Abertura inteira** (pedido do jogador de 2026-10-09, substitui "em partes"): a página e todo mapa aberto ficam atrás da cortina "Carregando o mapa…" até vias, prédios, árvores e mobiliário estarem prontos (PA-U1). Antes:
- **Abertura em partes** (escolha do jogador): terreno primeiro; o primeiro mundo
  pelo job fatiado das edições, trocado só com os shaders compilados; prédios
  depois, em fatias; árvores por último.
- **Aberto:** religar só as portas dos prédios mudados (#42); guardar o kit de
  árvores (#50).

## Estado medido (2026-10-06, fim da sessão)

- Mapa novo, 8 vias longas com trânsito e pessoas chegando: pior quadro
  553 → 59–111 ms (variação entre rodadas; o restante são compilações de shader
  na primeira vez que um material aparece).
- Vila padrão, vias curtas: tarefa mais longa da thread principal no trace do
  Chrome (sem o profiler) 106 ms; as demais ≤ 82 ms. O que resta é trabalho
  proporcional à mudança: o clique que grava a via (~50 ms: túneis 20, peças
  10, texto do desfazer 9) e o quadro que refaz o grafo dos pedestres.
- Jogo rodando sem editar: quadros de 16,7 ms, nenhum acima de 50 ms.

## Já descartado (não é causa)

- Coletor de lixo: no trace da vila, uma coleta maior de 11 ms em quatro edições.

- `forestPlants` aparecia no topo das amostras ao desenhar vias, mas o tempo
  medido é menor que 8 ms. A amostra estava mal atribuída.
- "7 MB por quadro" de buffers de veículos: era erro de contagem do roteiro. Os
  veículos já enviam só o intervalo usado (`addUpdateRange` em `agents.ts`).
