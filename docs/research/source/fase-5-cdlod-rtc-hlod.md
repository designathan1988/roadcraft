# Pesquisa da fase 5 — terreno CDLOD, desenho relativo à célula (RTC), HLOD de prédios, culling por célula e a dobra do planeta

Pesquisa de 2026-10-11, só leitura de código. Ramo `agente/pesquisa`, a partir de
`planeta-esfera` `27a7cb48`; todo `arquivo:linha` é desse commit (as linhas do
`three.js` são do r186.1 em `node_modules/three` do outro worktree, só para leitura).
Complementa as seções 4.2–4.5, 5.5–5.8 e 6.4 do
`docs/relatorio-desempenho-mapas-enormes-2026-10-11.md` (fontes F18–F21, F25, F34–F36,
F39) e o bloco E (fase 5) do `PROMPT-PENDENCIAS.md` ("atrás de chave, com fotos nos dois
modos"). Fora do escopo por decisão do jogador: WebGPURenderer, BatchedMesh, profundidade
logarítmica.

**Como as fontes foram lidas.** Páginas e código de terceiros: WebFetch (a página ou o
arquivo convertido em texto e respondido por um modelo pequeno a um pedido meu; onde a
resposta disse "não consta", virou lacuna). PDFs: baixados pela ferramenta e lidos como
texto com `pdftotext` — o artigo do CDLOD (428 linhas) foi lido **inteiro**. Código do
repositório e do three.js: lido por mim. Um cálculo aritmético simples (memória) é meu e
está marcado. Nada foi rodado.

---

## 1. Perguntas que a fase 5 precisa responder

1. O que o artigo do CDLOD exige de dados e de seleção, o que ele deixa de fora (edição,
   sombra, sombreamento por vértice) e que implementações em three.js existem?
2. O terreno atual (placas completas + globo leve) já faz o que o CDLOD faz? O que o
   CDLOD de fato troca, em bytes e em chamadas de desenho?
3. Como o CDLOD convive com a dobra do planeta (`bend.ts`) e com a edição do relevo
   (diário de mudanças, escrita por retângulo numa página de altura)?
4. O RTC "sem shader especial" do relatório 4.2 é viável com os materiais deste projeto
   (três.js r186)? Como a dobra recebe a peça **por objeto**?
5. Como é um HLOD de prédios por célula (Unreal, 3D Tiles, meshoptimizer) sobre o
   `BATCH_CELL`/`DETAIL_CELL` que a camada de prédios já tem?
6. O que já está feito em culling por instância e por célula, e o que a partição da fase 2
   troca?

---

## 2. Fontes lidas

### 2.1 Terreno

**Filip Strugar, "Continuous Distance-Dependent Level of Detail for Rendering
Heightmaps" (CDLOD), 2010** — PDF `cdlod_paper_latest.pdf` do repositório
https://github.com/fstrugar/CDLOD (MIT; código DirectX 9 em `source/`, "bem velho"),
lido **inteiro**. A LOD é função da **distância tridimensional exata** observador–vértice,
em toda a malha (o clipmap usa só a posição em planta; o Ulrich/Chunked LOD a mesma LOD
no pedaço inteiro). Estrutura: **quadtree de profundidade constante** de uma única **malha
de grade regular** (16², 32², 64² ou 128² células) que cada nó selecionado desloca no
vertex shader lendo a altura de uma textura; "cada filho tem 4× mais complexidade por
unidade de área que o pai". **Alcances** por nível: o de cada nível é **2× o do anterior**
(até a distância de visão); a **zona de morph** ocupa os **últimos 15%–30%** de cada
alcance. **Seleção** (pseudocódigo, `LODSelect`): recursiva do nível mais grosso ao mais
fino; se a caixa do nó não toca a esfera do alcance daquele nível, "devolve falso" e o pai
cobre a área; fora do frustum devolve verdadeiro sem selecionar; no nível 0 seleciona o nó
inteiro; senão, se a caixa não toca a esfera do alcance do nível mais fino, seleciona o nó
inteiro; senão desce nos 4 filhos, e cada filho que devolve falso é coberto por **parte do
pai** (seleção parcial). **Morph:** cada vértice recebe `morphK` de 0 a 1 pela **própria**
distância e se desloca para o vizinho par: `fracPart = frac(gridPos · gridDim · 0,5) · 2 /
gridDim; v.xy − fracPart · quadScale · morphK` (HLSL do artigo); com `morphK = 1` a malha
de 4× mais triângulos coincide com a do nível de cima, que a substitui sem costura nem
junção em T e **sem faixas de costura** (stitching). A altura (z) do vértice deslocado vem
da textura com **filtro bilinear**, e deve ser aproximada ou lida de modo **consistente**,
senão as bordas entre nós divergem. **Sombra:** o corte de frustum usa a câmera da
sombra, mas "a seleção de LOD deve continuar baseada na câmera principal" (senão a malha
da sombra difere da desenhada). **Limitação de granularidade:** "um único nó só suporta a
transição entre **duas** camadas de LOD"; em terreno muito acidentado (a LOD é 3D) o
problema aumenta, e o artigo reconhece que a configuração é por conjunto de dados (a
versão de depuração avisa de possíveis costuras). **Dados:** o quadtree guarda só
`minZ/maxZ` por nó (matriz de dois `uint16` por nível; o nível 0 comprimido em `uint8` no
espaço normalizado do pai: ≈ 1/45 da versão ingênua; 3,5 MiB para 32 K × 32 K com folha de
32); as texturas (altura, normais, sobreposição) são divididas em blocos por camada, e **a
mesma seleção do desenho serve para escolher o que carregar** (a granularidade do
streaming é bem menor que a do quadtree). **Desempenho do artigo:** ≈ 10 lotes por nível,
60–120 lotes por quadro com 7–9 níveis; 105 K–446 K triângulos; percurso do quadtree
0,075–0,57 ms por quadro de CPU (E8500 3,16 GHz a Atom 1,6 GHz); memória de textura 38–103
MiB para 138 × 167 km a 10/5 m; limite da GPU: "buscas de textura no vertex shader" ou
rasterização. **Edição:** "uma vez criado, o quadtree não muda a não ser que a altura-fonte
mude" — o artigo não trata de terreno editável; o `minZ/maxZ` de um nó editado tem de ser
refeito (conta direta: só os nós que o retângulo editado toca).
**felixpalmer/lod-terrain** (three.js, 2013,
https://raw.githubusercontent.com/felixpalmer/lod-terrain/master/js/app/terrain.js e
`js/shaders/terrain.vert`; extração dirigida): 76 tiles (6 anéis concêntricos de 12 + o
centro de 4) **compartilham uma só `PlaneGeometry`** de 128 segmentos, **um `Mesh` e um
`ShaderMaterial` por tile** (um desenho por tile, sem instanciar), posição/escala por
uniforme, bitmask de bordas a "morfar" para o anel de fora, altura lida de textura no
vertex shader; nada ali move os anéis com a câmera nem escolhe o detalhe por tile (é "uma
tarefa futura" no comentário). **tschie/terrain-cdlod** (https://github.com/tschie/terrain-cdlod,
MIT): demonstração mínima — seleção por quadtree e morph no vertex shader; o README diz que
**não** usa altura na seleção nem corte por frustum ("podem aparecer buracos nas bordas da
tela"). Não achei implementação de CDLOD em three.js que una instanciamento, textura de altura
em WebGL 2, edição e a dobra de um planeta: seria escrita aqui.
**Cesium, "Horizon culling" (Kevin Ring, 2013)** — https://cesium.com/blog/2013/04/25/horizon-culling/ :
escala-se o elipsoide a uma esfera unitária; com `c` a câmera, `t` o ponto e `v = t − c`,
`h = |c|² − 1`, `d = −v·c`: o ponto está oculto quando `d > h` e `d²/|v|² > h`; o ponto
oclusor de um tile é calculado como se o planeta tivesse o **menor raio** (conservador);
"mais da metade dos tiles" abaixo do horizonte num exemplo, e ~15% a mais que o teste
anterior; roda "centenas de vezes por quadro". **O projeto já implementa isso**
(`render/planet/bend.ts:377–393` `beyondHorizon`, e `capBeyondHorizon` `:337–351` para uma
placa por cap).
**three.js r186.1** — `Frustum.intersectsObject` (`math/Frustum.js`) usa
`object.boundingSphere` se existir (`InstancedMesh`, `BatchedMesh`) senão o da geometria;
o `InstancedMesh` calcula **uma única** esfera sobre todas as instâncias,
**só quando se chama** `computeBoundingSphere()` (`objects/InstancedMesh.js:151`), e não a
atualiza sozinho; `DataArrayTexture.addLayerUpdate(layer)` envia **a camada inteira**
(`texSubImage3D` com a camada toda: `renderers/webgl/WebGLTextures.js:1190`, não
retângulos); `WebGLRenderer.copyTextureToTexture(src, dst, srcRegion, dstPosition,
srcLevel, dstLevel)` (`renderers/WebGLRenderer.js:3336`) aceita `Box2/Box3` na origem e
destino `DataArrayTexture`/`Data3DTexture` (usa `UNPACK_SKIP_*` e
`texSubImage3D`): é a via para escrever **um retângulo** de uma camada.
**MDN, `OES_texture_float_linear`** — filtragem linear de texturas de ponto flutuante de
32 bits, disponível em WebGL 1 e 2, "amplamente disponível" desde 2015; a página **não**
trata de `R32F`/`RGBA32F` em WebGL 2 (isso é conhecimento geral, a conferir na
especificação Khronos); o `texImage3D` do MDN só diz que `TEXTURE_2D_ARRAY` e `TEXTURE_3D`
são alvos válidos e não traz a tabela de formatos. O próprio projeto já evita depender
disso: lê a textura de "costa" `RGBAFormat/FloatType` com **quatro `texelFetch` e bilinear
à mão** (`render/terrain.ts:1289, 1506–1509`) e usa `DataTexture Float32 RedFormat`
(`terrain.ts:2680`).

### 2.2 Precisão e a dobra

**AGI, "Precisions, Precisions" (Deron Ohlarik)** —
https://help.agi.com/AGIComponents/html/BlogPrecisionsPrecisions.htm (lido inteiro por
extração): o `float` tem ~7 dígitos; para 1 cm o limite é `131 071 m` (valores inteiros
até 2¹⁷ − 1; 131 071,01 vira 131 071,0078125 — erro de 0,8 cm); **RTC:** a CPU calcula
em `double` a posição do objeto relativa ao olho e a põe na coluna de translação da
`ModelView` em precisão simples, a GPU só vê números pequenos; a matriz é refeita sempre que
o observador se move ("custo desprezível"); funciona para cm "dentro de 131 070 m do centro
do objeto" (talvez a metade na prática; não analisado); **armadilha:** quando os vértices
de um mesmo objeto estão a mais que isso um do outro (órbitas, planos) "não há centro que
evite o tremor"; subdividir em células com centros próprios é rejeitado como solução
geral (complicado, ruim para animação e batching — no exemplo, 2 triângulos viram ~75 000);
**RTE na GPU** (alto/baixo, `high` múltiplos de 65 536, `low` com 7 bits de fração e 16
inteiros): erro máximo ~1,353 cm, vértice típico de 32 para 44 bytes (**+37,5%**, acima da
linha de cache de 32 B), VBO estático; "clearly outperforms" o RTE de CPU. Aplicável à
fase: o RTC do three (a CPU monta a `modelViewMatrix` em `double`) cobre o jogo (±17 km)
sem shader; o RTE só se o mundo passar de ~131 km.
**Allen Chou, "Bending Solid Geometry in Planetary Annihilation" (2013)** —
https://allenchou.net/2013/07/bending-solid-geometry-in-planetary-annihilation/ (lido por
extração): as "brochas" (CSG) são modeladas como em terreno plano e **projetadas ao
planeta por dobra**: a imagem da origem local fica à distância `R` do centro; cada vértice
é a imagem do vetor girado em torno do eixo `origem × posição`, de módulo `R + D` (`D` =
deslocamento vertical) e ângulo `distância horizontal / R` (distâncias horizontais
preservadas como arco); "a projeção é calculada **uma só vez**, na geração da malha do
planeta, antes do começo do jogo" (CPU, não por quadro, e o planeta é só esférico); numa
resposta aos comentários o autor confirma que **os prédios não são dobrados**; o artigo
**não trata** de subdivisão de triângulos longos, de normais, de objetos grandes ou de
desempenho. O projeto cita o PA (`bend.ts:11–14`) mas **dobra por quadro no vertex shader**
(a curvatura `k` muda com a altura do olho): a analogia vale para "o chão se dobra, o que é
pequeno e sólido é posto rígido".

### 2.3 HLOD, partição e simplificação

**Unreal Engine, World Partition** e **World Partition — HLOD** — as páginas de que a fase 2
já tratou (células de 256 m e alcance de 768 m no exemplo; "atores que se referenciam
carregam juntos"; uma camada HLOD gera, por célula da sua grade, **uma malha-proxy e um
material**; tipos Instancing/Merged/Simplified; "HLODs inalterados não são refeitos";
"o conteúdo das células descarregadas é substituído pelos HLODs"). **3D Tiles
(OGC/Cesium)** — `geometricError` em metros por tile, "geralmente cada nível de filhos tem
erro menor que o pai", REPLACE/ADD, conteúdo dos filhos dentro do volume do pai, o cliente
refina "se o erro introduzido exceder o máximo" (a especificação **não dá fórmula** do erro
de tela). **meshoptimizer** — https://github.com/zeux/meshoptimizer README, seção
"Simplification" (lido até o caractere 100 000 de 107 228): `meshopt_simplify(destino,
índices, contagem, posições, nº, passo, alvo_índices, alvo_erro, opções, &erro_obtido)`;
**o erro-alvo é relativo à extensão da malha** (`1e-2` = ~1% do tamanho; `FLT_MAX` sem
limite; `meshopt_simplifyScale` converte para o espaço do objeto); opções:
`LockBorder` (não colapsa arestas de borda da malha, para unir pedaços simplificados
separadamente sem rachaduras), `Sparse` (pequenos subconjuntos esparsos, melhor com erro
absoluto), `ErrorAbsolute`, `Prune` (remove componentes isolados; recomendada para a malha
inteira), `Regularize`; `meshopt_simplifyWithAttributes` aceita pesos por atributo (≈ 1,0
para normais normalizadas, 10–100 para UV) e `vertex_lock`; `meshopt_simplifySloppy`
ignora a topologia (pior qualidade). Quantização: normais em 3×8 bits ou 10-10-10-2;
posições e UV em `half` ou inteiros normalizados de 16 bits. `EXT_meshopt_compression`:
decodificador de vértices ~3–6 GB/s (2–4× sobre dados já quantizados), de índices ~1–1,2
byte/triângulo.

### 2.4 Código do repositório lido

`render/planet/terrainAtlas.ts` (cabeçalho e constantes), `render/terrain.ts` (constantes,
texturas de dados), `render/plateMesh.ts`, `render/flatAtlas.ts` (cabeçalho), `render/planet/bend.ts:1–530`,
`render/buildings/layer.ts` (células e ganchos de LOD), `render/scenery.ts:985–1076`,
`render/CLAUDE.md`, `world/planet/atlas.ts`, `core/planetTiles.ts`.

---

## 3. O que se aplica a este código

### 3.1 O terreno de hoje, em bytes e em chamadas

**Planeta** (`render/planet/terrainAtlas.ts:1–60`): já é, na ideia, um **cache de tiles
estilo Proland/Cesium**: uma peça de 81² cantos (512 m, células de 6,4 m) é mantida **completa**
se há algo do documento nela ou se está perto da vista (`NEAR_MOST = 24`, `NEAR_RADIUS ≈ 4,5 ·
TILE_HALF`, `NEAR_BUDGET_MS = 8`, `terrainAtlas.ts:69,76,78,80`), e o resto é o **globo leve**
em um desenho (`globeGround.ts`). O que o relatório 5.5 aponta não é "falta LOD", é que
(i) **peças com conteúdo nunca saem** (a memória cresce com a área construída) e (ii) o
passo de detalhe é um **degrau** (6,4 m → globo), sem nível intermediário. **Plano:**
placas de 1,92 km (301² = 90 601 cantos) com `CACHE = 6`, `NEAR_MOST = 9` e uma malha
distante de 32×32 por placa (60 m).
**Memória por placa plana** (relatório 5.5 e leitura de `plateMesh.ts:1–60`,
`terrain.ts:1304–1311, 2411–2415`): posições (1,09 MB), normais (1,09 MB), uv (0,72), cor
(1,09), `aBelow` (0,36) em `float32` + índice `uint32` de 300²·2·3 (2,16 MB) ≈ 6,5 MB de
geometria, mais texturas de dados (costa RGBA float 1,45 MB, tinta 1024² RGBA8 ×3 camadas
no plano; `PAINT_RES = 256` no planeta, `terrain.ts:906`; no planeta cada uma das 864 placas já
carregou 786 KB de tinta até a correção "cresce no primeiro traço", `terrain.ts:1160–1169`:
680 MB só nisso). Com CDLOD a geometria por placa **some**: uma grade
compartilhada (33² = 1 089 vértices e 2 048 triângulos ≈ 12 KB de índice `uint16`) e
**texturas** de altura/normal/etc. por nó.
**Conta minha — as alturas cabem inteiras.** 864 peças × 81² cantos × 4 B (`R32F`) =
22,7 MB; com mipmaps ×4/3, ≈ 30 MB: **o relevo do planeta inteiro, à resolução de edição
(6,4 m), cabe numa única `DataArrayTexture` de 30 MB**. O que pesa por placa hoje são
os atributos de geometria e as camadas de tinta/costa/luz, não a altura. Isso muda o plano
da fase 5: a página de altura não precisa de LRU por bytes; precisam dele a tinta, a costa e
os derivados.

### 3.2 O que o CDLOD traria (e o que ele não resolve)

- **Chamadas de desenho:** 1 grade compartilhada, instanciada (`InstancedBufferGeometry` com
  `aNode = (x0, y0, tamanho, camada)` e `aMorph`): **1 desenho por nível** (o artigo contava
  ≈ 10 lotes por nível porque cada nó era um desenho em DX9; o `lod-terrain` em three.js
  também faz um desenho por tile). Hoje: 1 por placa mostrada (+1 do globo).
- **Seleção por quadro (CPU):** 0,075–0,57 ms no artigo; aqui por peça/raiz, com o olho em
  coordenadas locais da carta (ver 3.4) e o **horizonte** do Cesium já existente
  (`beyondHorizon`) antes do frustum.
- **Edição do relevo:** o diário (`changes.ts`) dá o retângulo sujo; escrever **o retângulo**
  na camada de altura com `renderer.copyTextureToTexture(srcDataTexture, array, Box2,
  Vector3)` (`WebGLRenderer.js:3336`) em vez de `addLayerUpdate` (camada inteira); atualizar o
  `minZ/maxZ` dos nós tocados (a CPU, só os nós do retângulo).
- **O que o CDLOD não toca:** o sombreamento do terreno é feito por fragmento (pintura,
  detalhe, água, costa, ecologia, `terrain.ts` 4 348 linhas); a **dobra** continua depois
  da posição; o **chão presente nas vias** (moldagem do terreno às vias e prédios, "pads")
  é conteúdo da altura, não da malha.
- **Normais e atributos por vértice:** `aBelow`, a cor, a inclinação (`steep`) hoje são
  atributos; viram textura (normal por diferenças centrais com quatro `texelFetch`, ou
  página de normais).
- **Altura bilinear sem extensão:** o projeto já usa quatro `texelFetch` e interpolação à
  mão (`terrain.ts:1506–1509`), então `R32F` com filtro `NEAREST` e bilinear no shader não
  exige `OES_texture_float_linear`.
- **Sombra:** a seleção usa a **câmera principal** e a sombra só corta por frustum (artigo);
  o projeto tem **um mapa de sombra** movendo-se em texels inteiros do chão
  (`render/CLAUDE.md`, `GroundShadowGrid`): o terreno na passada de sombra precisa da mesma
  seleção do quadro, não de uma própria.
- **Limite do artigo:** um nó só faz transição entre duas camadas; num relevo muito
  acidentado os alcances precisam ser conferidos (o artigo tem aviso de depuração). Medir em
  vistas altas com montanha.

**Aritmética da grade (minha).** Uma peça tem 80 células de 6,4 m (81 cantos). Uma grade de
40×40 cobre 256 m e tem **40 par**: cada nível de morph pareia vértices pares, então 40 → 20
→ 10 é possível (5 não). Com nós de 256 m no nível 0 a peça (512 m) tem 4 folhas e **1 nó
raiz**; acima da peça, a face tem **12 × 12 peças** (`TILES_PER_SIDE = 12`, `planetTiles.ts:34`):
12 → 6 → 3, ou seja **3 × 3 raízes de 4×4 peças** por face (não é potência de dois: o
quadtree acima da peça precisa ser feito por face, e o plano da Terra, com 1,92 km por placa
e células de 6,4 m, é 300 células por lado, não potência de dois também: nós de 300 / 2³ =
37,5 células → ajustar a placa a 320 ou 256 células, ou a folha a 25 células).

### 3.3 Alternativa menor se o perfil não pedir CDLOD

O relatório assume CDLOD "por trás de chave, placa a placa". Das duas hipóteses de 5.5
(memória crescendo com a área construída, vista alta desenhando placas inteiras onde 60 m
bastaria), só a medida do anexo B4 e a contagem de vértices na vista alta dizem qual dói.
Alternativas por ordem de custo: (a) **nível intermediário por placa** (malha de 150²
cantos para a placa, escolhida por distância, com a costura resolvida como o próprio artigo
descreve — o que o CDLOD evita), (b) deixar a peça cheia de lado e **descarregar
atributos de geometria** das placas que o jogador não olha há tempo (mantendo só a altura em
textura), (c) CDLOD. O artigo diz que a malha de nível fixo exige "faixas de costura" ou
junções, e que o CDLOD as dispensa por construção (morph): por isso a (c) é a única sem
remendo de borda. Registrar as três e **medir antes**.

### 3.4 RTC por célula, e o que o r186 realmente permite

**O que o three faz.** A `modelViewMatrix` de cada objeto é montada em `double` na CPU
(`object.modelViewMatrix.multiplyMatrices(camera.matrixWorldInverse, object.matrixWorld)`,
em `renderObject`, `WebGLRenderer.js:2157–2163`: primeiro `object.onBeforeRender`, depois a
`modelViewMatrix`, depois `material.onBeforeRender`); a AGI chama de RTC exatamente
isso, e dá o limite de 131 070 m de cm de precisão. O mundo do jogo tem ±17 km no atlas e
±12,5 km no plano: com `float32` o passo é de ~2 mm entre 16 e 33 km (AGI: valores
representados até 2¹⁷ com 0,8 cm) — o RTC **não é necessário** para precisão de
centímetro hoje; o ganho é afastar o limite se o mundo crescer. **A casa da cidade está na
origem do atlas** (`HOME_TILE = tileCellOf(0, 0)`, `planet/relief.ts:138`), onde o `float32`
é mais fino; as peças das outras faces estão a 10–17 km.
**A armadilha para a dobra.** A dobra reconstrói a posição **absoluta** do atlas dentro do
shader (`planetTile(p)` lê `p.x, −p.z` e acha a peça pela célula; `bend.ts:79–85`), o que
anula o RTC se os vértices forem locais à célula (`modelMatrix * position` é
reconstruída em `float32` no shader). A saída do relatório (4.2) é passar a peça (centro,
leste, norte) **por objeto**, como uniforme. **Verificado no r186:** só o
**`ShaderMaterial`** reenvia seus uniformes quando se marca `material.uniformsNeedUpdate =
true` (`WebGLRenderer.js:2795`: `if (material.isShaderMaterial && material.uniformsNeedUpdate === true)`);
o projeto tem 43 materiais embutidos remendados por `onBeforeCompile` e 23 `ShaderMaterial`
(relatório 3.1), e nos embutidos o envio dos uniformes próprios só acontece quando o material
muda (`refreshMaterial`, `:2558–2587, 2749`). O comentário de `bend.ts:61–65` já registrou a
variante do problema ("a uniform of its own stayed at its first value; the matrix's array is
shared"). Portanto: (i) objetos **`ShaderMaterial`** (cenário, sinais, chuva… ver
`PLANET_VERTEX`, `bend.ts:268–285`) podem receber a peça por `onBeforeRender` +
`uniformsNeedUpdate`; (ii) objetos com material embutido remendado precisam de **uma
instância de material por célula** (o programa é compartilhado se a chave de compilação é a
mesma; o custo é trocar de material a cada célula: `refreshMaterial`), ou de um atributo
constante por objeto/instância (memória × vértices), ou de um `ShaderMaterial`. A
`modelMatrix` não serve para carregar dados: a linha de baixo é lida em `mvPosition.w`
(`project_vertex` mantém `mv.w`, `bend.ts:204–209`), que precisa ser 1.
**Teste de aceite do relatório (4.2):** sonda de "tremor" na borda do atlas e no centro,
deslocamentos de 1 mm por quadro e diferença de pixels entre quadros: igual nos dois
lugares. O número esperado hoje é 1–2 px a 2 m do olho (a hipótese 5.6); **só medindo se sabe
se vale a obra**.

### 3.5 Culling por célula e instâncias

O relatório 5.8 diz que as instâncias não têm culling por instância. **Lendo o código, isso
é parcialmente falso:** a vegetação e o mobiliário (`render/scenery.ts:1019–1076`
`cullInstances`) **cortam por instância na CPU**, a cada mudança da matriz de vista
(`cull`, `scenery.ts:1004–1011`, `culledFor.equals(view)`), com a esfera inteira do mesh
como atalho (`all.bounds`) — mas **só fora do planeta** (`if (all.bounds && !__PLANET__)`,
`:1034`): no planeta cada instância de cada mesh é testada (`planetSphereInView`,
`bend.ts:403–412`) e as sobreviventes são **copiadas para o início do buffer** e enviadas
(`instanceMatrix.needsUpdate = true`, `:1073`, faixa de atualização `0..n·16`). Custo: O(todas
as instâncias do mundo) por mudança de vista, mais o envio das visíveis. O mesmo padrão em
`grass.ts:326` (por célula), `renderer.ts:1104, 1141` (multidão e veículos). Com a partição:
**um `InstancedMesh` por célula e por tipo, estático** (matrizes enviadas uma vez), a
**esfera da célula** (`computeBoundingSphere()` a chamar uma vez, o three não a atualiza
sozinho, `InstancedMesh.js:151`) dá o corte do conjunto — o corte por instância some, o
reenvio por quadro some. O `frustumCulled = false` em 51 objetos (relatório 3.4) está em
arquivos como `scenery.ts`, `natureTrees.ts`, `blast.ts`, `transit.ts`, `riggedCitizens.ts`,
`grass.ts`; os de interesse da fase são os de objetos **estáticos espalhados**:
`scenery.ts`, `natureTrees.ts`, `signals.ts`, `utilities.ts`, `signs.ts`, `structures.ts`.
**No planeta**, o `Frustum.prototype.intersectsObject` já é remendado para levar a esfera
envolvente à dobra e testar o horizonte (`bend.ts:268–297`), então um `InstancedMesh` por
célula com a esfera da célula passa a ser culled **sem** a gambiarra por instância; o
`userData.planetCap` serve a placas.
**Agentes:** `render/agents.ts:1989–2004` (pose e altura antes do teste, teto pelo id,
relatório 4.5) e o teto por mais próximos precisam do índice por célula que o instantâneo
da fase 4 traz.

### 3.6 HLOD de prédios

**O que existe.** A camada de prédios já tem **duas grades de células**: `BATCH_CELL =
m(240)` (peças "grossas": cascas e mobília) e `DETAIL_CELL = m(120)` (peças de detalhe:
caixilho, grade, balaustrada, veneziana, cortina), ambas montadas por `assembleByCell` e
guardadas por célula (`layer.ts:575–578, 363, 415–416`); só as células que uma edição
tocou são refeitas (`CellCache`); o detalhe é **cortado por distância** (`cullDetails(eye,
reach)`, `layer.ts:74, 491`) e há `setFar(far)` (`:65, 486`). As chaves de célula são
**strings** `"cx,cy"` que são **desmontadas por `slice`/`Number`** a cada passada
(`layer.ts:494–496`) — outro lugar do tipo "texto no caminho quente" (fase 1).
**O que as fontes pedem** para a camada que falta (casca simplificada por célula):
- *Unreal HLOD:* uma malha e um material por célula da grade de HLOD, **não refeita
  se nada mudou**, e gerada fora do quadro por um passo de construção; aqui seria o cache
  derivado (IndexedDB por impressão do código, o mesmo dos tiles de via), construído em
  worker (fase 3) e **chaveado pela célula e pelos prédios dentro dela**.
- *3D Tiles:* cada nível tem um **erro geométrico em metros** e o cliente refina quando o erro
  projetado passa do máximo; a fórmula é do cliente (a especificação não a dá); a do relatório
  4.4 (`erro · altura da tela / (2 · distância · tan(fov/2))` em perspectiva; `erro · px por
  metro` em ortográfica) é a de Cesium e serve; a histerese entre níveis é do cliente.
- *meshoptimizer:* simplificar a casca fundida da célula com o **erro absoluto em metros**
  (`ErrorAbsolute`, p.ex. 0,5–2 m conforme o nível), `Prune` (tirar detalhes isolados:
  chaminés, antenas), `simplifyWithAttributes` com pesos para cor/material (os prédios
  são pintados por vértice/materiais), e `LockBorder` **só** se se quiser unir pedaços
  simplificados separadamente — as cascas de prédios são fechadas (não têm borda), então o
  `LockBorder` importa pouco; o que importa é **o prédio não cruzar a borda da célula**
  (dono único por âncora, fase 2).
- *Instancing HLOD do Unreal:* o proxy de árvores é a própria malha de menor LOD em
  instâncias — o jogo já tem LOD de árvores (`natureTrees.ts`).
- Níveis propostos (do relatório): 0 completa (hoje), 1 sem detalhes (hoje `cullDetails`),
  2 casca simplificada fundida por material, 3 caixas ou extrusão de contorno (um só
  material com cor), e para o globo nada (o `globeGround` mais as luzes). O erro de cada
  nível e o limite de pixels são **parâmetros a calibrar com fotos nos dois modos** (aceite do
  PROMPT).
**Medida:** triângulos e draw calls nos cenários B–D com uma cidade de 1 500+ prédios; o
piso de triângulos da rua (`GATE_BUDGETS.triangles.min = 8 500 000`, `perfBudget.ts:91`) tem
de continuar valendo: o HLOD só entra em vistas onde o erro projetado é abaixo do limite, a
rua não muda.

### 3.7 A dobra "com a peça por objeto" e o `k = 0`

Somando a fase 2: com `k` até 0,02 (`bend.ts:514`), `planetBent` divide por `k`; o `k = 0`
exato exige o ramo do limite (fase 2, 3.1). **Da fonte PA:** só o que é **chão** precisa ser
dobrado ponto a ponto; "os prédios não são dobrados". No jogo, o que é pequeno em relação ao
raio (veículos de ~5 m, pessoas, mobiliário: a flecha de um carro de 10 m numa esfera de
3,8 km é ≈ 3 mm, relatório 5.7) pode ser posto **rígido** na CPU — calcular um quatérnion e
uma posição por objeto (`planetPointInto`, `bend.ts:446–452`) e pular a dobra por vértice
(`PLANET_SKIP` já existe, `bend.ts:229,236,243`). Isto reduz o custo de vértice dos agentes
a zero de dobra e é independente do CDLOD.

---

## 4. Riscos e o que medir

1. **O que dói, primeiro.** Memória por placa (B4), vértices desenhados na vista alta e
   quadros ao viajar (cenários E–F); decidir entre 3.3 (a), (b) e (c).
2. **CDLOD e a dobra:** o morph roda **antes** da dobra; testar costuras entre nós de níveis
   diferentes dentro de uma peça e **entre peças** (a emenda atual é testada em
   `tests/world/bendSeam.spec.ts` e `tests/planet/terrainSeam.spec.ts`); a altura
   bilinear com `NEAREST` + 4 `texelFetch` tem de ser **igual** em nós vizinhos de níveis
   diferentes (o artigo: "consistente").
3. **Sombra:** o terreno na passada de sombra com a seleção da câmera principal; vistas
   que deslocam o mapa de sombra em texels do chão.
4. **Edição:** latência do clique ao terreno novo (escrever o retângulo + `minZ/maxZ`),
   quadros longos durante pincelada (cenário G).
5. **Uniforme por objeto:** uma instância de material por célula multiplica materiais; medir
   o custo de `refreshMaterial` por desenho e a memória (programas continuam 147 hoje,
   relatório B3: não pode subir).
6. **Culling por célula na dobra:** o horizonte do Cesium é conservador (raio mínimo +
   80 m de folga, `HORIZON_SLACK`); testar cantos e fronteira de face.
7. **HLOD:** erro visual (silhueta, cor) versus triângulos poupados; transições com
   histerese; custo de construção em worker e de guardar no cache derivado (bytes por
   célula).
8. **Hipótese de precisão:** tremor de ~1 px a 2 m (relatório 5.6) **não confirmada**;
   medir antes de reescrever a montagem de malha (4.2 do relatório é o item de maior
   custo da fase).
9. **Escrever o CDLOD é código novo:** nenhuma implementação existente em three.js une
   instanciamento, altura em textura, edição e a dobra; o `felixpalmer/lod-terrain` e o
   `tschie/terrain-cdlod` são ponto de partida de morph/seleção, não do conjunto.

---

## 5. O que NÃO foi possível ler (ou só em resumo)

- **Código-fonte do CDLOD** (`source/`, DirectX 9, e o `source.zip` do autor): não lido; só o
  artigo. As demonstrações em three.js foram lidas por extração dirigida e o
  `terrain.vert` do `lod-terrain` veio sem o `edgemorph.glsl`.
- **Chunked LOD (Ulrich 2002)** e **Geometry Clipmaps (Losasso & Hoppe 2004)**: não lidos
  (só como descritos pelo artigo do CDLOD e pelo GPU Gems 2 do relatório, F20).
- **AGI**: a postagem lida não cita a DSFUN90; "limite possível ~65 000 m na prática" é
  dito como não analisado; a parte do RTE foi lida por extração, sem as fórmulas.
- **Cesium, "Horizon culling"**: as equações são imagens; a postagem seguinte (ponto oclusor
  exato) não foi lida.
- **Allen Chou**: o artigo não trata de subdivisão, normais nem desempenho; o desenho do
  Mavor (engine do PA) não foi lido.
- **Unreal HLOD e 3D Tiles**: já listados na fase 2 (extração dirigida; sem a transição
  célula–proxy do Unreal, sem fórmula de erro de tela no 3D Tiles).
- **meshoptimizer**: lido até o caractere 100 000 de 107 228 do README; não li `EXT_meshopt_compression` no
  glTF nem o código.
- **Especificação WebGL 2** (formatos filtráveis `R32F`): só o MDN e o conhecimento geral
  anotado pela ferramenta; a tabela não foi lida.
- **Atualização de uniformes por objeto em materiais embutidos**: conclusão tirada da leitura
  de `WebGLRenderer.js` r186 (trecho de `setProgram`), não de documentação; confirmar com um
  teste mínimo antes de basear o desenho nela.
- **Impostores octaédricos** (fórum do three, relatório F35): não relidos.
