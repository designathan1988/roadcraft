# Pesquisa: cidade procedural no mapa inteiro (10,24 km), bonita e rápida

Data: 2026-10-14. Escopo: as sete perguntas do pedido (render de cidade inteira, geometria
virtualizada, fusão/instâncias, culling e sombras, geração procedural em escala, simulação em
escala, persistência). Regra das fontes: só entra na seção "Fontes" o que foi aberto com
WebFetch nesta pesquisa; quando uma página não abriu, isso está dito. Código lido localmente
(three r186 em `node_modules/three`, meshoptimizer 1.2.0 em `node_modules/meshoptimizer` e os
arquivos do projeto) é citado com caminho. Números marcados "(cálculo)" ou "(proposta)" são
meus, derivados dos números medidos; não vêm de fonte.

Este documento complementa `docs/CIDADE-10KM.md` (plano medido) e `OTIMIZACAO.md` (lista
viva); não os substitui.

## Resumo

1. Ficar no WebGL2 (`WebGLRenderer`) agora. WebGPU é etapa opcional e tardia: não existe no
   Linux nem em navegadores antigos, o `BatchedMesh` do three r186 no WebGPU vira um laço de
   `drawIndexed`, e 33 arquivos do projeto usam GLSL que o `WebGPURenderer` não aceita.
2. HLOD em árvore alinhada às placas de 2.048 m: detalhe por célula de 256/128 m; massa por
   prédio (já existe); ladrilho de 1.024 m fundido e simplificado; "skyline" por placa. Troca por
   erro de tela (fórmula do Cesium), com 1 a 2 px de limite, histerese e esmaecimento pontilhado.
3. Dentro do detalhe: cada tipo de peça some quando fica abaixo de 1 px. Nesse ponto o shader
   da fachada já a representa. As sombras seguem a mesma regra, medida em texels do mapa de sombra.
4. Vértice enxuto: posição int16 relativa à célula, normal por derivada, UV planar no shader,
   cor RGBA8. A memória de vídeo e a banda de vértices caem para cerca de 1/3.
5. Prédio = semente + versão do gerador + alterações. Tudo o mais é derivado em workers, com
   ArrayBuffers transferidos. Na página fica só a subida para a GPU, com orçamento por quadro.
6. Simulação em worker: mesoscópica (filas por via, por eventos) no mapa inteiro; microscópica
   só perto da câmera, com as fronteiras de Burghout.
7. Salvamento em partes binárias comprimidas, nunca um texto do mapa inteiro, porque o V8 limita
   strings a cerca de 512 M de caracteres. O trabalho vai num worker (OPFS ou IndexedDB) e o
   armazenamento é pedido como persistente.

## 0. Ponto de partida e conta de pixels

Medido no projeto (dados do pedido, `OTIMIZACAO.md`, `docs/CIDADE-10KM.md`):

| Medida | Valor |
|---|---|
| Cidade de 1.348 prédios (raio 640 m) | heap 335 MB; vista do mapa inteiro 52 fps, limitada pela GPU; 6,5 M triângulos de casca + 7 M de peças instanciadas (~4 triângulos por pixel) |
| Rua, 1688×922, depois do item 15 | 660 chamadas de desenho, 22,5 M triângulos, GPU 15,99 ms, CPU de desenho 7,4 ms |
| Cidade de 5.400 prédios | 47 s para gerar; heap 543 MB depois dos caches |
| Raio 2.560 m (~21 mil prédios) | >3 min sem lotes; malha das vias 24 s, faixas e conversões 15 s, lotes 11 s (tudo na página); heap 2,5 GB; aba caiu |
| Regressão do `BatchedMesh` (2026-10-14) | lotes das cascas seguravam 1.098 MB de arrays; heap 4.435–5.111 MB; mapa inteiro a 14 fps, quadros de 151 ms |
| Mapa inteiro (extrapolado) | ~80.000 prédios, ~15.700 trechos de via |

Conta de tamanho na tela (cálculo). Câmera em perspectiva do jogo: `PERSPECTIVE_FOV = 35`
(`src/render/isoViewport.ts:62`). Pixels por metro a uma distância d: `K / d`, com
`K = H / (2·tan(fov/2))`. A 922 px de altura, `K ≈ 922 / 0,6306 ≈ 1.462`. Um objeto de tamanho s
cobre 1 px até `d = K·s`:

| Elemento | Tamanho que conta | Some abaixo de 1 px a partir de |
|---|---|---|
| Perfil de caixilho | 0,05 m | ~73 m |
| Peitoril | 0,15 m | ~220 m |
| Ar-condicionado | 0,8 m | ~1,2 km |
| Fundo de varanda | 1,2 m | ~1,75 km |
| Janela | 1,5 m | ~2,2 km |
| Prédio | 20 m | ~29 km |

Na vista ortográfica (`OrthographicCamera` no mesmo arquivo), a razão pixels/metro não depende
da distância: `H / altura_da_vista_em_m`. O mapa inteiro em 922 px dá ~11 m por pixel. Por isso
a métrica de LOD precisa de dois ramos, perspectiva e ortográfica, como no Cesium (§1.4).
Consequência: na vista do mapa inteiro nenhuma peça, nem janela, cobre um pixel. O orçamento de
triângulos deve acompanhar os pixels da tela, não o número de prédios.

## 1. Como projetos reais desenham cidades inteiras

### 1.1 Unreal City Sample / The Matrix Awakens

- **Escala** (CGW): 7.000 prédios feitos de "milhares de peças modulares"; 45.073 carros
  estacionados (38.146 dirigíveis); mais de 260 km de vias; 512 km de calçada; 1.248
  cruzamentos; 27.848 postes; 12.422 bueiros; "sete milhões de assets instanciados"; 16 km².
  Os números de 35.000 pedestres e 17.000 veículos só apareceram em trecho de busca. A página
  oficial (`unrealengine.com/wakeup`) e o blog da Epic deram 403, então eles não estão
  confirmados aqui.
- **Geração** (documentação do City Sample): cidade de ~4 km × 4 km feita no Houdini, em etapas
  (traçado, vias, via expressa, lotes e calçadas, tráfego/prédios/chão, mobiliário/decalques/
  áudio). O Houdini exporta uma nuvem de pontos que um "Rule Processor" converte em "milhares de
  instâncias". Prédios são volumes com gramática de forma; cada prédio tem centenas de
  instâncias. Geometria própria só para colisão, tabuleiro da via expressa, decalques de via e
  alguns telhados.
- **Render**: Nanite em todas as malhas estáticas, "sem LODs tradicionais", "bilhões de
  polígonos de dezenas de milhares de objetos". World Partition divide o nível em células de
  grade carregadas sob demanda. A doc de HLOD diz que o conteúdo das células descarregadas é
  substituído pelos HLODs, em camadas Instancing, Merged Mesh ou Simplified Mesh, cada camada com
  `Cell Size` e `Loading Range` próprios. Virtual Shadow Maps no lugar de cascatas. O TSR leva a
  GPU de 57,50 ms (4K nativo) para 33,37 ms (metade da resolução).
- **Agentes**: MassEntity para tráfego e multidão. Perto, MetaHumans riggados; longe, malhas
  estáticas com animação por vértice. O Mass LOD dá quatro níveis (High/Medium/Low/Off) com
  distância e contagem máxima por nível. A representação por nível é ator completo, ator leve,
  ISM com animação por vértice ou nada. O "Simulation LOD" dá frequência de atualização variável.
- **Hardware recomendado**: CPU de 12 núcleos, 64 GB de RAM, RTX 2080, 8 GB de VRAM. Bem acima de
  "GPU comum de mesa no navegador".

**O que vale aqui.** O prédio como gramática sobre um kit de peças instanciadas é o que o
Roadcraft já faz. O HLOD que substitui a célula descarregada é o modelo certo. O LOD de
representação dos agentes (completo, animado por vértice, nada) também. O que não vale: Nanite.
Ele exige DirectX 12 com SM6, e o navegador não tem recursos equivalentes (§2).

### 1.2 Microsoft Flight Simulator (Blackshark.ai)

- TechCrunch: ~1,5 bilhão de prédios reconstruídos de imagens 2D por visão computacional. Saem
  pegada, altura (por GIS onde existe; senão por pistas como sombras e por priors aprendidos) e
  tipo de telhado. Como o sistema conhece a semântica de cada prédio, ele põe janelas e luzes
  (cenas noturnas). A fotogrametria do Bing cobre ~400 cidades; o resto é reconstruído. Os dados
  vêm do Azure por streaming. "Talvez 20% dos prédios estejam errados." Cerca de 50 pessoas.
- O SDK do MSFS 2024 (AutoLOD/Simplygon) gera 7 LODs com `minSize` de 70%, 50%, 35%, 20%, 10%,
  5% e ≤1% da tela. Diz também que LOD manual "sempre" sai melhor.
- A página da Blackshark aberta não traz números do MSFS.

**O que vale aqui.** Guardar a semântica (pegada, alturas, telhado, estilo) e gerar a malha no
cliente é exatamente "semente + parâmetros". Quem decide o LOD é a fração da tela que o objeto
ocupa.

### 1.3 Cities: Skylines I e II

**CS2 (o que falhou)**, Huhtala, RTX 3080 + Ryzen 7 5800X, quadro de cidade com 1.000
habitantes:

- 87,8 ms por quadro. Sombras em cascata ~40 ms (quase metade). 6.705 chamadas de desenho, das
  quais 4.828 (72%) de sombra. 4 cascatas de 2048².
- 121 M de vértices de entrada; ~36 M de triângulos rasterizados.
- Sem LOD em personagens. Os dentes têm 6.108 vértices e 13 conjuntos deles foram desenhados sem
  cobrir pixel algum.
- Cabine de estacionamento com mais de 40 mil vértices sem LOD; pilha de toras com mais de 100 mil.
- Só culling de frustum e de distância fraco, sem oclusão. Os props vêm fundidos aos prédios, o
  que impede culling individual. Muitas chamadas de sombra afetam menos de 100 pixels do mapa.
- Renderer próprio sobre `BatchRendererGroup`, com ~50 floats de dados por instância de prédio.

Patch 1.0.11f1 (DSOGaming): "LOD independente da resolução de render" e "stutters otimizados
quando prédios surgem ou sobem de nível". Um segundo patch, que segundo resultados de busca
"melhora o LOD de sombras para descartar casters irrelevantes mais cedo", não foi confirmado: as
páginas (Techraptor, Neowin) deram 403.

**CS1 (o que funcionou)**:

- Tetos rígidos por tipo de agente e de objeto, lidos por mod e relatados no fórum Steam, não
  oficiais: veículos ativos 16.384; instâncias de cidadão 65.536; prédios 49.152; segmentos de
  via 36.864; nós 32.768; faixas 262.144; unidades de caminho 262.144; cidadãos 1.048.576.
- Todo asset tem LOD barato. Pelo autor do Loading Screen Mod, "10 a 100 triângulos é típico
  para um LOD"; o mod avisa a partir de 600 triângulos ou 1.000 vértices; o jogo rejeita LOD
  acima de 4.062 vértices (~8.100 para prédios e vias).

**O que vale aqui.** LOD em tudo, inclusive props e personagens. Sombra só do que tem tamanho no
mapa de sombra. Nada de fundir props ao prédio se eles precisam de culling próprio. Teto e
orçamento explícitos por tipo de agente.

### 1.4 Cesium OSM Buildings, Google Photorealistic 3D Tiles, 3D Tiles

- **OSM Buildings** (anúncio da Cesium): mais de 350 milhões de prédios em ~3 milhões de
  ladrilhos, "centenas de GB". Quadtree "frouxa": um prédio na borda pode invadir o ladrilho
  vizinho em vez de ser cortado. glTF em lote por ladrilho, com cada prédio ainda consultável e
  estilizável. "Para a maioria dos estilos, cidades inteiras renderizam com uma única chamada de
  desenho por ladrilho."
- **3D Tiles** (especificação): `geometricError` em metros é a métrica de seleção. `REPLACE`
  desenha os filhos no lugar do pai; `ADD` desenha os dois. Há tiling implícito (quadtree/octree
  endereçada por coordenada). glTF 2.0 é o formato primário.
- **CesiumJS** (`Cesium3DTile.getScreenSpaceError`, código aberto):
  `error = (geometricError * height) / (distance * sseDenominator)`, com
  `sseDenominator = 2·tan(fovy/2)`. Há um ramo ortográfico separado e uma subtração por "neblina"
  quando `dynamicScreenSpaceError` está ligado.
- **Padrões de `Cesium3DTileset`**: `maximumScreenSpaceError` 16;
  `cacheBytes = maximumCacheOverflowBytes` = 536.870.912; `dynamicScreenSpaceError` e
  `foveatedScreenSpaceError` ligados; `skipLevelOfDetail` desligado; `cullRequestsWhileMoving`
  ligado; `progressiveResolutionHeightFraction` 0,3.
- **Google Photorealistic 3D Tiles**: um pedido do `root.json` vale por "pelo menos três horas"
  de pedidos de ladrilho. Requer CesiumJS ≥ 1.91 (ou Cesium for Unreal ≥ 1.12).
- **3DTilesRendererJS** (NASA, para three.js): os limites do cache são tetos rígidos. Quando a
  vista não cabe, ficam ladrilhos grossos e o refinamento para; a recomendação é monitorar
  `lruCache.cachedBytes` e `isFull()`.

**O que vale aqui.** O navegador desenha centenas de milhões de prédios porque desenha só o que o
erro de tela pede, com um lote por ladrilho e cache com teto em bytes. Portar a fórmula do
Cesium (com o ramo ortográfico) para a métrica do HLOD. O projeto já usa `NEAR_PIXELS = 2` em
`massCells.ts`.

### 1.5 Unity Megacity (DOTS)

- PCPer, Unite LA 2018: ~4,5 milhões de objetos renderizados, ~5.000 veículos em movimento,
  100.000 fontes de áudio, 60 fps. O ECS agrupa objetos e "faz muito instancing" para mandá-los
  juntos à GPU. Dois artistas, cerca de dois meses.
- Megacity Metro (GitHub): Entities Graphics + URP, até 150 jogadores; não dá números de
  streaming.
- Páginas `unity.com/megacity` e PC Gamer abriram sem o conteúdo técnico; `unity.com/demos/megacity`
  deu 404.

**O que vale aqui.** Dados em arrays contíguos (struct-of-arrays) e instancing massivo. Os
veículos andam em splines de faixa, sem física.

### 1.6 Demonstrações em WebGL/WebGPU

| Demonstração | O que mostra |
|---|---|
| CesiumJS + OSM Buildings (§1.4) | escala planetária em WebGL |
| `nanite-webgpu` (Scthe) | 1,2 a 1,7 bilhão de triângulos em cenas de instâncias repetidas, só no Chrome (§2) |
| "Forest of octahedral impostors" (agargaro, fórum three.js) | 200 mil árvores num terreno de 3072×3072: LOD por instância (malha cheia → meshoptimizer de 15 a 100 m → impostor octaédrico a partir de 100 m), BVH para frustum, terreno em `BatchedMesh` com LOD |
| Usnul, fórum three.js | LOD por clusters em WebGL2 com uma chamada instanciada em que cada instância é um cluster de 128 triângulos e os atributos vêm de texturas (§2) |

**Conclusão da §1 para o Roadcraft.** Ninguém desenha a cidade inteira em detalhe. Todos
selecionam pelo tamanho na tela, guardam a hierarquia em ladrilhos e substituem o longe por algo
mais barato. No WebGL2, isso é HLOD com lotes por ladrilho, LOD por tipo de peça e instâncias. O
equivalente ao Nanite (§2) só é viável no WebGPU, e com restrições.

## 2. Geometria virtualizada e LOD por clusters

**Nanite (documentação da Epic).**

- Na importação, a malha vira "clusters hierárquicos de grupos de triângulos" trocados em tempo
  real conforme a vista, sem fendas entre vizinhos.
- Streaming sob demanda; passe próprio, "contornando chamadas de desenho tradicionais".
- Teto de 16 milhões de instâncias.
- Só materiais opacos ou mascarados; sem morph targets; WPO limitado; exige DX12/SM6.
- Bons candidatos: malhas densas, muitas instâncias, grandes oclusores e casters de VSM.
- Os slides de Karis (SIGGRAPH 2021) **não abriram**: o PDF passa de 10 MB, limite do WebFetch.
  Por isso os detalhes internos abaixo vêm de implementações abertas.

**Bevy 0.14 (jms55).** O pipeline de construção:

- Meshlets de ≤64 vértices e 64 triângulos (meshoptimizer).
- Grupos de ~4 meshlets por METIS, com peso pelas arestas compartilhadas.
- Simplificação do grupo para ~50% dos triângulos, com o erro acumulado do filho mais grosso.
- Nova divisão em ~2 meshlets; repete.

A regra de seleção é: desenhar o cluster cujo erro próprio é imperceptível (<1 px de diâmetro
projetado) e cujo erro do pai não é. Isso dá um corte consistente sem comunicação entre threads.
O culling é em duas passadas com Hi-Z: a primeira usa a pirâmide do quadro anterior; a segunda
testa os rejeitados contra a pirâmide nova.

Números da cena de teste: 3.092 coelhos de 144.042 triângulos, RTX 3080, 2240×1260, 2,78 ms no
total (sem o sombreamento de material). Achados:

- Subir dados por cluster custaria 122,10 MB (~7,63 ms em PCIe 3.0); por instância, 0,025 MB.
- Indirect indexado é 10–20% mais rápido, mas gasta ~12 B por triângulo.
- Multi-draw por cluster "foi mal por overhead do processador de comandos".
- Buffer de visibilidade R32Uint (26 bits de cluster + 6 de triângulo).
- Faltam no wgpu: mesh shaders e atomics de 64 bits.

**nanite-webgpu (Scthe).** Implementa:

- DAG de meshlets e culling por instância e por meshlet (frustum + oclusão pela pirâmide de
  profundidade do quadro anterior, sem reprojeção e sem segunda passada).
- Rasterizador por software, sem buffer de visibilidade porque o WebGPU não tem `atomic<u64>`.
- Impostores de 12 vistas para instâncias longe.
- Pré-processamento no navegador com meshoptimizer e METIS em WASM.

Cenas de 640 M a 1,7 bilhão de triângulos, todas de instâncias de poucos modelos. Limites
declarados:

- O buffer por instância cresce com `instâncias × meshlets do nível mais fino`.
- Limite de storage buffer de 128 MB no Chrome.
- Sem BVH de instâncias, sem streaming, sem sombras.
- "Muitos objetos distintos não escalam."

**meshoptimizer (zeux).**

- `meshopt_buildMeshlets`: para NVIDIA, limites de 64 vértices e 126 triângulos; para malhas
  reais, 64/96.
- `meshopt_partitionClusters` agrupa clusters (exemplo: 24 por grupo; máximo `alvo + alvo/3`).
- `meshopt_SimplifyLockBorder` impede colapsar bordas, para simplificar partes
  independentemente sem fendas. `Sparse` acelera a simplificação de subconjuntos (meshlets).
- O post "Billions of triangles in minutes" mede o `clusterlod.h` (clusters de 128 triângulos):
  1,64 bilhão de triângulos (cena Zorah) em ~2 min 35 s num Ryzen 7950X com 16 threads, ~45 GB
  de pico de RAM; o `vk_lod_clusters` desenha a cena com 2 GB de pool em 16 ms (raster) numa RTX 3050.
- No pacote JS 1.2.0 do projeto (`node_modules/meshoptimizer/*.d.ts`) existem `buildMeshlets`,
  `buildMeshletsFlex`, `buildMeshletsSpatial`, `computeClusterBounds`, `computeMeshletBounds`,
  `computeSphereBounds`, `simplify` com as flags `LockBorder`, `Sparse`, `ErrorAbsolute`, `Prune`,
  `Regularize` e `Permissive`, e `simplifyWithAttributes`, `simplifySloppy` e `simplifyPrune`.
  **Não** existe `partitionClusters` no JS; o agrupamento teria de ser próprio.

**WebGL2 sem compute (Usnul, fórum three.js).**

- Uma chamada instanciada em que cada instância é um cluster de 128 triângulos; os atributos
  vêm de texturas (vertex pulling). Mais clusters perto, um só no extremo longe.
- Sobre o código aberto `three-nanite`, Usnul estima "10 mil triângulos/segundo no máximo" no
  pré-processamento e "~100 MB de RAM para cada 1 MB de malha". O README do `three-nanite` diz
  que o código "é uma bagunça" e que o streaming falta.

**O que o navegador oferece hoje** (fontes: Khronos `WEBGL_multi_draw`, web.dev, Chrome 131,
Toji, código do three r186):

| Recurso | WebGL2 | WebGPU (núcleo) |
|---|---|---|
| Multi-draw | `WEBGL_multi_draw` ("Community Approved"; `gl_DrawID` no vertex shader; equivale a várias chamadas) | não há; `multiDrawIndirect` só como `chromium-experimental-multi-draw-indirect` atrás de flag |
| Indirect draw | não | `drawIndirect`/`drawIndexedIndirect`, um por chamada; o Dawn valida no GPU, e 412 buffers separados custaram ~3 ms contra ~10 µs num buffer só |
| Compute | não (só transform feedback) | sim |
| Atomics de 64 bits / mesh shaders | não | não |
| Disponibilidade | universal | Chrome/Edge 113+ (Windows D3D12, macOS, ChromeOS), Android 12+ desde o Chrome 121, Firefox 141 (Windows), Safari 26; Linux "em andamento" |

**Para o Roadcraft.**

- O LOD por clusters à moda Nanite exige pré-processar cada prédio. Em produção isso leva
  minutos por bilhão de triângulos em código nativo, e no JS de Usnul ~10 mil triângulos/s.
  Os prédios do Roadcraft são gerados e editados em tempo de jogo, cada um único, então o
  pré-processamento teria de rodar a cada edição.
- No WebGL2 não há compute nem indirect, então a seleção do corte do DAG seria na CPU (em
  worker), com o resultado subindo por quadro, ou por vertex pulling como Usnul.
- O ganho real que se busca (≤1 triângulo por pixel longe) vem mais barato de HLOD por célula e
  ladrilho, LOD por tipo de peça e simplificação do meshoptimizer com `LockBorder` dentro de cada
  ladrilho.
- Clusters fazem sentido mais tarde, e só no WebGPU, para as cascas de células perto: seleção e
  culling em compute, com um buffer indirect único por material (lição de Toji).

## 3. Fusão, instâncias, BatchedMesh, InstancedMesh2, impostores, atlas e GPU no three r186

**`BatchedMesh` (código do three r186, `src/objects/BatchedMesh.js`).**

- O construtor recebe `maxInstanceCount`, `maxVertexCount` e `maxIndexCount` (padrão
  `maxVertexCount*2`).
- `_initializeGeometry` cria na CPU arrays com toda a capacidade de cada atributo: é o que
  segurou 1.098 MB no projeto.
- `perObjectFrustumCulled` e `sortObjects` vêm ligados; a cada quadro, `onBeforeRender` percorre
  as instâncias para culling e ordenação, e as matrizes ficam num `DataTexture`.
- No WebGL desenha com `multiDrawElementsWEBGL` (`WebGLIndexedBufferRenderer.js`).
- No backend WebGPU (`WebGPUBackend.js`), o `BatchedMesh` é **um laço de `drawIndexed` por
  instância** desenhada.
- O fórum do three (gkjohnson) cita um gargalo de multi-draw no WebGL (issue Chromium 437957104).
  A página da issue pediu login e não abriu, então a causa não está confirmada.

**`InstancedMesh2` (`@three.ez/instanced-mesh`).**

- Capacidade dinâmica; culling de frustum por instância, com BVH dinâmico opcional
  (`computeBVH`, bom para instâncias quase estáticas).
- LOD por instância (`addLOD(geometry, material, distance)`) e LOD de sombra
  (`addShadowLOD(geometry, distance)`).
- Ordenação (radix), visibilidade e opacidade por instância, uniforms por instância e skinning.
- O README não traz números de desempenho; exemplo de "1kk static trees".
- Extensões de `BatchedMesh` (`@three.ez/batched-mesh-extensions`): BVH, uniforms por instância
  (só WebGL) e LOD como faixas de índice sobre o mesmo array de vértices ("só LODs que
  compartilham o array de vértices"), com LODs gerados em tempo de execução pelo meshoptimizer.

**Impostores.** O post da floresta de 200 mil árvores usa `octahedral-impostor` com
`useHemiOctahedron: true`, `spritesPerSide: 16`, `textureSize: 2048` e `parallaxScale: 0,5`, sem
crossfade entre LODs. As páginas de referência (shaderbits.com, README do `octahedral-impostor`)
abriram sem o corpo do texto, então os detalhes do método não estão confirmados. Para prédios,
impostor octaédrico não é a primeira escolha: prédios são grandes e têm paralaxe forte. Para
árvores, props repetidos e carros longe, é.

**Texturas.** O three r186 tem `DataArrayTexture` e `CompressedArrayTexture`, e o `KTX2Loader`
devolve `CompressedArrayTexture` quando o contêiner tem `layerCount > 1`
(`examples/jsm/loaders/KTX2Loader.js:447`). Isso permite um array comprimido por família de
acabamento, com a camada escolhida por atributo, e menos materiais e chamadas. A MDN (WebGL best
practices) diz:

- mipmaps custam 30% a mais de memória;
- prefira `texStorage` + `texSubImage`, porque `texImage*` pode alocar a cadeia toda;
- RGB8 "costuma ser surpreendentemente lento", então prefira RGBA8;
- formatos comprimidos "ocupam menos memória de GPU e são mais rápidos de amostrar";
- `MAX_TEXTURE_IMAGE_UNITS` mínimo garantido é 8 e `MAX_VERTEX_TEXTURE_IMAGE_UNITS` é 4.

**Formato de vértice (meshoptimizer.org).**

- Posição e UV em half ou int16 normalizado relativo à caixa da malha; normal em 3×8 bits (ou
  10-10-10-2, ou octaédrica).
- O codec de vértices comprime mais 2–4× sobre dados já quantizados; o de índices chega a ~1 B
  por triângulo.

No three, `flatShading` calcula a normal no fragment shader por `cross(dFdx, dFdy)`
(`ShaderChunk/normal_fragment_begin.glsl.js`). As cascas do Roadcraft são flat shaded e têm UV
planar no mundo; com isso, normal e UV podem sair do atributo e ir para o shader (proposta, §8).

**Caminho de GPU no three r186 (código local).**

- O `WebGPURenderer` tenta WebGPU e cai para um backend WebGL2 (`forceWebGL` existe).
- No backend WebGL, compute vira transform feedback (`webgl-fallback/WebGLBackend.js`).
- Draw indirect: `geometry.setIndirect(IndirectStorageBufferAttribute)` vira `drawIndexedIndirect`
  por offset; não há multi-draw indirect.
- Oclusão por consulta: `object.occlusionTest` e `renderer.isOccluded()`.
- `BundleGroup`/render bundles para cortar CPU de submissão.
- O `StandardNodeLibrary` converte `MeshStandardMaterial`, `MeshLambertMaterial` e afins para
  node materials, **mas não `ShaderMaterial` nem `RawShaderMaterial`**. O `onBeforeCompile` em
  GLSL não se aplica a node materials. O projeto tem 33 arquivos em `src/` com `onBeforeCompile`,
  `ShaderMaterial` ou `RawShaderMaterial` (grep), todos a portar para TSL antes de mudar de renderer.

**Para o Roadcraft, no WebGL2 agora.**

- Peças continuam `InstancedMesh` por tipo e por célula, como hoje. O ganho vem de não desenhar
  o que é sub-pixel (§8), não de trocar o contêiner.
- Cascas continuam `Mesh` por acabamento e por célula, com os arrays soltos depois da subida
  (`onUpload`, já feito). Nada de `BatchedMesh` grande para geometria que muda, por causa da
  cópia inteira na CPU.
- `BatchedMesh` só serve para conjuntos pequenos e de capacidade fixa: os ladrilhos L2 de uma
  placa (§8), cujos arrays são pequenos.
- Árvores e props repetidos: `InstancedMesh2` (LOD por instância, LOD de sombra, BVH) com
  impostor no último nível.

## 4. Culling e sombras

**Frustum.** Por célula ou ladrilho é praticamente grátis. Por instância vale BVH
(`InstancedMesh2`, `batched-mesh-extensions`). Sem BVH, o laço por instância do `BatchedMesh`
custa CPU por quadro.

**Oclusão Hi-Z na GPU.**

- Rastergrid (2010): a pirâmide guarda a profundidade máxima por mip (passes de quad de tela
  inteira) e custou <0,2 ms numa Radeon HD5770. O teste projeta a caixa, escolhe o mip
  `ceil(log2(max(w,h)/2))`, lê 4 texels e compara. O resultado sai sem readback, por geometry
  shader e transform feedback.
- O WebGL2 não tem geometry shader, mas tem vertex shader com transform feedback e
  `RASTERIZER_DISCARD`, então o mesmo teste por instância é possível.
- O consumo do resultado é que esbarra na falta de indirect draw. Ou se lê de volta assíncrono
  (MDN: `fenceSync` + `getBufferSubData` com polling de `clientWaitSync`; "até chamadas básicas
  podem levar 1 ms" se bloquearem), com 1–2 quadros de atraso, ou se compacta numa textura que o
  vertex shader consulta para colapsar a instância (economiza raster, não vértice).
- Bevy e Scthe mostram a forma WebGPU: pirâmide do quadro anterior e compute. Bevy faz a segunda
  passada para não perder o que apareceu; Scthe não, e aceita pop-in.

**Consultas de oclusão.** `beginQuery(ANY_SAMPLES_PASSED_CONSERVATIVE)` no WebGL2 é assíncrona
(MDN); o three r186 expõe `occlusionTest` só no `WebGPURenderer`. Servem para poucos objetos
grandes, não para milhares.

**Oclusão na CPU.** Masked Occlusion Culling (Intel) rasteriza oclusores num buffer de
profundidade hierárquico com duas profundidades e uma máscara por bloco. É sempre conservador:
"objetos ocultos podem sair visíveis, nunca o contrário". `TestRect` é bem mais barato que
`TestTriangles`, e 4 threads deram ~3× sobre a versão de uma thread. Numa cidade, os oclusores
naturais são as massas (L1) dos prédios: caixas de poucos triângulos. Uma versão em JS ou WASM
num worker, com buffer de baixa resolução e testes por célula ou prédio, cabe no WebGL2 hoje
(proposta, §8).

**Sombras.**

- CS2: 72% das chamadas e ~40 ms eram sombra (§1.3).
- VSM da Epic: virtual de 16k×16k em páginas de 128×128 e clipmaps do nível 6 (64 cm) ao 22
  (~40 km).
  - Cache ligado por padrão, com duas cópias de profundidade (estática e dinâmica).
  - Mover a luz invalida tudo; WPO e skinning invalidam a cada quadro.
  - "Geometria não-Nanite é muito mais cara de renderizar em VSM" e precisa de cadeia de LOD
    completa.
  - Recomendações: limitar objetos pequenos e longe (`r.Shadow.RadiusThreshold`) e separar o
    estático do dinâmico.
- PSSM (GPU Gems 3, cap. 10): 3 ou 4 divisões "dão um bom equilíbrio"; a divisão mistura a
  logarítmica e a uniforme, com peso padrão 0,5. Os casters são escolhidos por divisão: cada
  caster guarda a primeira e a última divisão que toca.
- Three r186: `renderer.shadowMap.autoUpdate = false` + `needsUpdate`, e `LightShadow.autoUpdate`
  e `needsUpdate` por luz. O projeto já desliga o autoUpdate (`src/render/renderer.ts:506`) e
  redesenha só com caster móvel (commit 72454a2). O three traz CSM em `examples/jsm/csm`.

**Para o Roadcraft.**

- **WebGL2 agora**: frustum por célula; LOD de sombra por nível (L2/L3 projetam a sombra longe);
  corte de casters por tamanho no texel do mapa de sombra (raio projetado <1 texel não entra);
  cache estático (já existe); oclusão na CPU em worker para as vistas de rua.
- **WebGPU depois**: Hi-Z em compute com duas passadas e indirect.

## 5. Conteúdo procedural em escala

**Greuter et al. 2003, "Pseudo infinite cities"** (lido inteiro).

- Cada prédio sai de uma semente de 32 bits, `seed = hash(x ^ hash(z ^ citySeed))` com o mix de
  32 bits de Thomas Wang, em células de 25 m. O hash evita prédios parecidos para sementes
  vizinhas.
- O PRNG é o de Park–Miller (período 2,1×10⁹). A planta sai da união iterativa de polígonos
  aleatórios, extrudados em degraus de cima para baixo.
- "View frustum filling": só se gera o que está num ângulo de 120° e a `loops × cellsize`.
- Cache LRU de display lists com `minAge` 100 quadros, `maxAge` 500 e capacidade de 1.000 itens,
  com reuso do item mais velho. A memória fica "aproximadamente constante".
- Medido num P4 de 2 GHz com GeForce 4: 200 prédios a 60 fps e 1.000 a 5 fps. A display list
  acelera até 8× o redesenho, com ~40% de custo extra na primeira geração. O índice do cache
  escala "graciosamente até ~10 mil itens".
- O texto deles sugere oclusão como próximo passo, porque "cidades são candidatas ideais".

**Danihelka & Zara (Eurographics 2011, pôster "Procedural Generation of Infinite Cities").** A
página da Eurographics deu 403 duas vezes e **não foi lida**. Só sei, por trecho de busca, que o
prédio também nasce da semente das suas coordenadas.

**Krecklau, Born, Kobbelt (Eurographics 2013).** Fachadas procedurais renderizadas em duas
passadas: a fachada plana primeiro; depois o fragment shader dispara a instanciação dos detalhes
3D só onde podem estar visíveis. A troca para texturas assadas é por distância. Krecklau &
Kobbelt 2011 compõem a fachada na GPU com um atlas de peças atômicas e fazem ray casting pelas
janelas para quartos procedurais (o "interior mapping" que o Roadcraft já usa). Não há números
na página.

**Workers e memória compartilhada.**

- Transferable: ArrayBuffer transferido é zero-cópia e a origem fica destacada (MDN). No teste
  do Chrome (2011), 32 MB levaram 302 ms em cópia e 6,6 ms em transferência, ida e volta.
- `SharedArrayBuffer` não é transferível; é compartilhado. Exige contexto seguro e isolamento de
  origem (MDN). O web.dev dá os cabeçalhos `Cross-Origin-Embedder-Policy: require-corp` e
  `Cross-Origin-Opener-Policy: same-origin`. O modo `credentialless` existe no Chrome 96+ e no
  Edge. Cada sub-recurso de outra origem precisa de CORP ou CORS. A verificação é
  `self.crossOriginIsolated`.
- `OffscreenCanvas` (Baseline desde março de 2023) permite render em worker; serve para assar
  texturas de via e terreno fora da página.

**Para o Roadcraft.**

- **Semente determinística e versionada por prédio**, no padrão de Greuter: hash do id do lote,
  da semente da cidade e da versão do gerador. Guardar só o que o jogador mudou. Gerar o que a
  vista pede, num LRU com teto em bytes. O projeto já tem 128 MB de cache de chunks e 4 células
  por quadro.
- **Gerar em workers** e mandar ao main thread só ArrayBuffers transferidos.
- **Determinismo entre workers**: o mesmo código, sem `Math.random` nem dependência de ordem de
  mensagem.
- Os cabeçalhos COOP/COEP só são obrigatórios se a simulação usar `SharedArrayBuffer`. Sem eles,
  usar buffers duplos transferidos.

## 6. Simulação em escala

- **Unreal Mass**: LOD de simulação com frequência variável e LOD de representação (§1.1). O
  City Sample deixa a multidão longe com animação por vértice.
- **Megacity**: ~5.000 veículos em splines de faixa sem colisão (§1.5).
- **CS1**: tetos rígidos de 16.384 veículos ativos e 65.536 instâncias de cidadão (§1.3).
- **SUMO meso** (documentação):
  - "roda até 100 vezes mais rápido que o modelo microscópico";
  - cada via vira filas de comprimento `--meso-edgelength` (~100 m) que saem em ordem;
  - fila livre ou congestionada por limiar de ocupação, com headways τ padrão de 1,13 / 1,13 /
    1,73 / 1,4 s;
  - "veículos meso não modelam a velocidade atual"; sem saída por faixa; troca lateral não modelada.
- **Burghout (tese, KTH 2004, lida inteira).**
  - **Mezzo**, mesoscópico por veículo e **por eventos**. Cada via tem parte "em movimento" (a
    velocidade sai de uma função de densidade calculada só nessa parte) e parte "em fila" (os
    veículos com hora de saída mais cedo já vencida). Servidores de fila por conversão modelam a
    capacidade do cruzamento, e um limite de "look-back" representa as baias.
  - Uma onda de choque de recuperação, `ω = (qA − qB)/(kA − kB)`, propaga a dissolução da fila.
  - Medido em 2004: uma rede de 2.173 vias e 1.181 nós rodou 3× mais rápido que o tempo real num
    Pentium de 1 GHz com 256 MB.
  - **MiMe**, híbrido: o micro roda em 0,1 s e o meso por eventos, então não há agregação de
    passos (meso típico: 60–300 s).
  - Grafo, tempos de viagem e escolha de rota são comuns aos dois lados. "Links virtuais"
    representam no meso os caminhos que atravessam a área micro.
  - Na saída micro→meso, o último carro micro segue um "veículo virtual" na velocidade que o meso
    deu ao que saiu.
  - Na entrada meso→micro, a velocidade inicial segue 3 regimes pelo headway: ≤2,5 s copia o da
    frente; 2,5–7,5 s mistura; >7,5 s velocidade desejada. O mínimo é t1 = 0,5 s.
  - Sem isso, a aceleração média na entrada caía a −5 m/s² e a capacidade ficava presa em ~2.000
    veíc./h/faixa (contra 2.600 determinístico). Com qualquer dos quatro métodos novos testados, o
    mínimo sobe para −0,7 m/s²; com os 3 regimes, a média fica entre 0,0 e −0,2 m/s².
  - Ressalva: área micro com mais vias menores que o meso atrai tráfego e distorce a atribuição;
    os dois lados devem ter o mesmo grafo.
  - Resultados na rede de Brunnsviken (RMSNE dos fluxos): MITSIM 9%, híbrido 12%, Mezzo 14%;
    Theil U de 0,051 / 0,054 / 0,055.

**Para o Roadcraft.**

- **Simulação num worker.** Meso para as ~15.700 vias do mapa: por eventos, por via, só
  comprimento, faixas, velocidade e capacidade por conversão. Não precisa da geometria de faixa
  nem dos caminhos de conversão; são esses que custam 15 s hoje.
- **Micro só numa janela** em volta da câmera ou dos pontos de interesse, com as faixas e
  conversões detalhadas construídas sob demanda para ela.
- **Fronteiras de Burghout**: veículo virtual na saída; velocidade de entrada em 3 regimes;
  bloqueio comunicado nos dois sentidos; conservação de veículos.
- **Render por LOD**: rigged ou esqueleto perto; instâncias com animação por textura no meio;
  longe, sem indivíduos. O veículo meso pode ser interpolado ao longo da parte em movimento
  entre entrada e hora de saída prevista, para aparecer como instância se a vista pedir.

## 7. Persistência de mundos enormes no navegador

- **Strings**: no V8, `String::kMaxLength = (1 << 29) − 24` em 64 bits, ou seja 536.870.888
  unidades UTF-16 (`include/v8-primitive.h`). 80 mil registros de ~9,5 KB dão ~760 MB de texto
  (cálculo): impossível como uma string só.
- **Heap**: a compressão de ponteiros do V8 põe os objetos numa faixa de 4 GB. Ela reduziu o heap
  em até 43% e a memória do renderer em até 20%. É o teto real que o projeto bateu (4,4–5,1 GB).
- **Cotas** (MDN):
  - Chrome/Edge: até 60% do disco por origem, nos dois modos; o Chrome usa no máximo 80% do disco
    somando todas as origens.
  - Firefox best-effort: menor entre 10% do disco e 10 GiB; persistente até 50% (teto de 8 TiB).
  - Safari 17+: ~60% do disco para apps de navegador. Sem interação por sete dias de uso, apaga os
    dados criados por script quando a prevenção de rastreamento está ligada.
  - O despejo é LRU por origem e apaga tudo de uma vez; poupa quem obteve
    `navigator.storage.persist()`.
  - Escrita acima da cota lança `QuotaExceededError`.
- **IndexedDB** (web.dev): o clone estruturado "acontece na thread principal", e quanto maior o
  objeto, mais longo o bloqueio. Recomenda dividir o estado em registros e gravar só os que
  mudaram. `durability: "relaxed"` confirma quando os dados chegam ao sistema operacional e é
  "recomendado para dados efêmeros, como caches"; `"strict"` espera o disco (MDN).
- **OPFS**: arquivos privados da origem com escrita no lugar; `createSyncAccessHandle()` só em
  workers, com `read`, `write`, `truncate` e `flush` síncronos. Baseline desde março de 2023.
- **CompressionStream**: gzip e deflate, disponível em workers, Baseline desde maio de 2023.
- **Estado atual do projeto**: há salvamento em partes em andamento na árvore de trabalho (ainda
  não commitado quando esta pesquisa foi escrita). `src/editor/chunkedSave.ts` grava
  os prédios em partes de 512 ids, gzip, numa transação de IndexedDB, só as partes que mudaram, a
  partir de 3.000 prédios. O undo é por patches (`src/editor/history.ts`: 60 passos, 96 MB). Falta:
  - a "cabeça" do documento (vias, terreno, zonas) ainda é um JSON só;
  - os registros ainda são JSON de 7–9 KB;
  - o gzip e o `JSON.stringify` rodam na thread da página.

## 8. Arquitetura recomendada para o Roadcraft

### 8.1 Princípios

1. O custo de desenho acompanha os pixels, não os prédios. O que fica abaixo de 1 px não é
   desenhado; o que fica abaixo de ~1 px mas soma cor (caixilhos, janelas) passa para o shader
   da fachada do nível de cima.
2. O que se guarda é a menor descrição que regenera tudo: sementes, parâmetros e alterações.
   Malhas são cache.
3. A página só faz entrada, desenho, subida para a GPU com orçamento e interface. Todo o resto
   roda em worker.
4. Todo cache e todo nível tem teto em bytes e é medido.

### 8.2 Grade espacial (proposta)

Quadtree alinhada às 25 placas de 2.048 m (o mapa é 5×5 placas):

| Nível | Lado | Quantidade no mapa | Uso |
|---|---|---|---|
| Placa | 2.048 m | 25 | L3 (skyline), terreno longe, rede viária meso |
| Ladrilho | 1.024 m | 100 | L2 (prédios fundidos), vias longe, construção em worker |
| Célula | 256 m | 1.600 | L1 (massas) e casca L0, unidade de streaming |
| Subcélula | 64 m | 25.600 | culling e corte das peças e props L0 |

Hoje `BATCH_CELL = 240 m` e `DETAIL_CELL = 120 m` (`layerCells.ts`), e 2.048 não é múltiplo de
240. Passar para 256 e 128 m (ou 64 m para as peças) faz as células encaixarem nas placas e nos
ladrilhos, e as chaves viram códigos de Morton. É uma mudança de constante com efeito em
`layerCells.ts` e `massCells.ts`; precisa ser medida (§9, E4).

Prédio pertence à célula do seu centroide; as bordas da célula são frouxas (caixa ampliada), como
a quadtree frouxa do OSM Buildings.

### 8.3 Camadas e níveis

Métrica comum: erro de tela à moda Cesium, `sse = e·H / (d · 2·tan(fov/2))` em perspectiva e
`sse = e·H / altura_da_vista` em ortográfica, com `e` o erro geométrico do nível em metros.
Refina quando `sse > 2 px` e engrossa quando `sse < 1,5 px` (histerese). A troca esmaece por
pontilhado em ~0,25 s; não é a neblina do Cesium, porque ela é corte de qualidade.

**Prédios** (`e` por nível, proposta):

| Nível | Representação | `e` | Unidade | Onde fica a beleza |
|---|---|---|---|---|
| L0 | casca completa + peças instanciadas + interior pelas janelas | ~0,05 m | célula 256 m (casca), subcélula 64 m (peças) | geometria real |
| L0 por peça | cada tipo de peça some quando `tamanho·K/d < 1 px` (tabela da §0); a sombra some quando o raio projetado < 1 texel do mapa | tamanho da peça | subcélula | a fachada L0 já tem janelas texturadas; o tipo que some passa a ser desenhado pelo shader da fachada (moldura, peitoril, faixa da varanda) |
| L1 | massa por prédio (existe): caixas, telhados e janelas procedurais no shader | ~0,5 m | célula 256 m, lote único por célula | shader de fachada com o estilo do prédio e luzes à noite |
| L2 | ladrilho fundido: pegada simplificada (≤8 vértices), degraus fundidos, telhado simplificado; meshoptimizer `simplify` com `LockBorder` só onde dois prédios se tocam; atributo de estilo por vértice | ~2 m | ladrilho 1.024 m, 1 malha por ladrilho | mesmo shader de janelas do L1, com mip ajustado |
| L3 | skyline da placa: caixa orientada por prédio, sem degraus | ~6–10 m | placa 2.048 m | cor média do estilo e luzes |

Triângulos aproximados (cálculo): L2 com 20–40 triângulos por prédio dá 1,6–3,2 M para 80 mil
prédios; L3 com 10–12 dá ~1 M. No mapa inteiro em perspectiva, metade do mapa costuma estar
longe, em L3.

**Vias.**

- L0: superfície detalhada com meio-fio, calçada e marcas.
- L1: fita fundida por ladrilho, com as marcas no shader por coordenada ao longo da via (o
  tracejado por `fract(u/comprimento)`).
- L2: as vias "pintadas" na textura do terreno da placa, assadas em worker com `OffscreenCanvas`.
- Faixas e caminhos de conversão: só para a janela micro (§6) e sob demanda por cruzamento.

**Terreno.** Quadtree de blocos por placa, com o mesmo erro de tela; máscaras de via e de lote
assadas na textura da placa em worker. O projeto já tem `flatGround.worker` e
`terrainLight.worker`.

**Vegetação.** `InstancedMesh2` por tipo e ladrilho: malha cheia, simplificada pelo meshoptimizer
e impostor octaédrico (o padrão da floresta de 200 mil árvores: 15–100 m e 100 m+), com LOD de
sombra e BVH. O projeto já tem `farForest`, `farWoods` e `impostorShaders`.

**Props (mobiliário, postes).** Como as peças: instâncias por tipo e subcélula, com corte por
tamanho na tela. À noite, os postes longe viram sprites emissivos instanciados.

**Agentes.** Sim micro perto e meso em todo o resto (§6). Render rigged perto, instâncias
animadas no meio, nada longe. Teto explícito por tipo, como o CS1.

### 8.4 Estruturas de dados

- **Tabela de prédios (SoA)**, um array tipado por campo:
  - id, x, y, ângulo, semente, versão do gerador, id do lote, estilo da fachada, altura e
    pavimentos, bandeiras;
  - offset no pool de polígonos das pegadas (`Float32Array` compartilhado).
  - Cerca de 64 B por prédio, ~5 MB para 80 mil (cálculo).
  - O registro JSON completo só existe para prédios com alteração (deltas), num `Map` por id.
- **Pool de chunks L0** (`Float32Array`, `Int16Array` e `Uint8Array` por atributo) num LRU com
  teto em bytes e idade mínima em quadros (o `minAge`/`maxAge` de Greuter). O pool já existe com
  128 MB.
- **Formato de vértice das cascas** (proposta), conferido contra os atributos de
  `buildingMesh.ts:3490`:

  | Atributo | Hoje | Proposta |
  |---|---|---|
  | position | 3×f32 | 3×int16 normalizado relativo à caixa da célula, com escala por eixo; passo ~3,9 mm nos 256 m do lado (a altura usa a escala da caixa) |
  | normal | 3×f32 | removida: `flatShading` por derivada |
  | color | 3×f32 | 4×uint8, com o quarto byte para `aDecay` |
  | uv | 2×f32 | removida: projeção planar no shader a partir da posição e da normal |
  | aDecay | f32 | dentro da cor |

  O vértice passa de 48 B para 12 B: 3×2 B de posição, 2 B de alinhamento e 4 B de cor.
- **Ladrilhos L2 e placas L3**: uma malha por ladrilho e por placa, construída em worker a partir
  da tabela SoA e reconstruída só quando um prédio do ladrilho muda.
- **Grafo viário meso**: arrays de vias (origem, destino, comprimento, faixas, velocidade,
  capacidade) e de conversões; a geometria de faixa fica fora.

### 8.5 Threads

| Onde | O quê |
|---|---|
| Página | entrada, `WebGLRenderer`, seleção de nível pela árvore, subida para a GPU com orçamento (≤3 ms por quadro), interpolação das poses de agentes, interface |
| Pool de geração (`hardwareConcurrency − 2`, até 6) | traçado e malha das vias por ladrilho; lotes por quarteirão; emissão das células L0; construção de L2 e L3 (meshoptimizer em WASM); assar máscaras de via e terreno em `OffscreenCanvas` |
| Worker de simulação | meso em todo o mapa, micro na janela, semáforos; poses em `SharedArrayBuffer` (com COOP/COEP) ou em buffers duplos transferidos |
| Worker de oclusão (rua) | z-buffer hierárquico de baixa resolução com as massas L1, teste por célula e prédio, resultado com um quadro de atraso |
| Worker de salvamento | serializar binário, gzip (`CompressionStream`), OPFS (`createSyncAccessHandle`) ou IndexedDB |

Regra: entre threads só passam ArrayBuffers transferidos ou `SharedArrayBuffer`. Nenhum objeto
grande passa por clone estruturado.

### 8.6 Orçamentos (proposta, para RTX 3060 a 1920×1080, a máquina de medição do projeto)

**Por vista** (GPU ≤ 12 ms; CPU de desenho ≤ 5 ms):

| Vista | Triângulos | Chamadas (cor + sombra) | GPU |
|---|---|---|---|
| Rua (olho a ~1,7 m) | ≤ 10 M (hoje 22,5 M) | ≤ 700 + ≤ 300 | ≤ 12 ms |
| Bairro | ≤ 8 M | ≤ 800 + ≤ 300 | ≤ 12 ms |
| Mapa inteiro | ≤ 4 M (hoje 13,5 M com 1.348 prédios) | ≤ 300 + ≤ 100 | ≤ 12 ms (≥ 50 fps com folga) |

**Memória de vídeo** (cidade de 80 mil prédios):

| Nível | Residente | Teto |
|---|---|---|
| L0 cascas (formato novo) | células dentro do erro, ~1.500–2.500 prédios | 300 MB |
| L0 peças, props, instâncias | idem | 150 MB |
| L1 massas | anel até ~2 km, ≤ 25 mil prédios | 120 MB |
| L2 ladrilhos | 100 ladrilhos | 60 MB |
| L3 placas | 25 | 15 MB |
| Texturas (KTX2/Basis em arrays) | — | 600 MB |
| Alvos de render e sombras | — | 300 MB |

**Heap JS**: ≤ 1,5 GB no total (meta já fixada em `CIDADE-10KM.md`).

| Item | Teto |
|---|---|
| Tabela SoA de prédios | ~5 MB |
| Deltas | ≤ 50 MB |
| Cache de chunks L0 | 128 MB (já existe) |
| Grafo meso | ≤ 30 MB |
| Agentes micro | ≤ 50 MB |
| Undo | 96 MB (já existe) |

**Tempo de geração**: cidade de pé (L1, L2, L3 e vias longe) em ≤ 90 s com a página respondendo.
O detalhe chega depois, pela vista.

### 8.7 Persistência

- **Prédio**: registro binário de tamanho fixo (os campos da tabela SoA), mais delta JSON só
  quando há alteração. Partes por ladrilho de 1.024 m em vez de por faixa de ids: o que se edita
  fica junto.
- **Cabeça do documento** em partes: vias por ladrilho, terreno por placa, zonas por ladrilho.
  Nunca um texto do mapa inteiro.
- Gravação em worker. `durability: "relaxed"` no autosave e `"strict"` no salvar manual.
  `navigator.storage.persist()` na primeira cidade grande. Exportar para arquivo, pelo despejo do
  Safari após 7 dias.
- **Versão do gerador** no cabeçalho de cada parte. Se o gerador mudar, os prédios sem delta
  regeneram na versão antiga (o código dela é mantido) ou são congelados como delta. Isso é
  decisão de produto, a tomar antes da E5.

## 9. Plano em etapas (por impacto)

| # | Etapa | Ganho esperado (cálculo) | Risco | Como medir |
|---|---|---|---|---|
| E1 | Banco de medição: caminhos de câmera fixos (rua, bairro, mapa, ortográfica), GPU por `gpuTimer.ts`, triângulos e chamadas por `renderer.info`, heap, tempo de geração por fase | pré-requisito; sem ele nenhuma etapa vale | baixo | o próprio relatório, rodado antes e depois de cada etapa, com fotos 1:1 das mesmas vistas |
| E2 | Corte por tamanho na tela das peças e props (por tipo e subcélula) e dos casters de sombra (por texel) | vista do mapa: 7 M de triângulos de peças → ~0 (nenhuma peça ≥1 px a mais de ~1,7 km); bairro: peças finas (caixilho, peitoril) fora a ~70–220 m; sombra só do que tem texel | pop visível se o limiar estiver errado ou se o shader da fachada não assumir o que some | triângulos e GPU por vista; fotos 1:1 lado a lado em 3 distâncias por tipo de peça, conferindo que a imagem não muda |
| E3 | Vértice enxuto nas cascas (posição int16, normal por derivada, UV no shader, cor RGBA8) | VRAM e banda de vértices das cascas ÷4; arrays temporários no heap ÷4 | fendas por quantização (mitigar com origem por célula e passo de 3,9 mm); o shader de desgaste precisa da mesma normal e UV | VRAM estimada por nível; GPU na rua; fotos 1:1 da fachada perto |
| E4 | L2 por ladrilho e L3 por placa, construídos em worker; grade 256/128/64 alinhada às placas; métrica Cesium com ramo ortográfico e histerese | mapa inteiro com 80 mil prédios em ≤ 4 M de triângulos e ≤ 300 chamadas, ≥ 50 fps | costura entre ladrilhos e pops na troca L1↔L2; mudar a grade mexe no streaming atual | fps e triângulos no mapa inteiro com 21k e com 80k; fotos 1:1 na distância de troca |
| E5 | Registro compacto (semente + versão + deltas) e tabela SoA; lote e mobiliário regenerados da semente | heap de ~110–150 KB para ≤ 15 KB por prédio; salvamento proporcional ao que é único | gerador não determinístico, ou mudança de versão mudando a cidade salva | heap vivo por prédio (amostra a 5,4k e 21k); hash da saída do gerador igual em dois workers e duas sessões |
| E6 | Geração em workers: vias por ladrilho, lotes por quarteirão, emissão de células, faixas e conversões só sob demanda | cidade de 21k (hoje >3 min e queda) de pé em ≤ 90 s com quadros p95 < 33 ms durante | corrida entre edição e resultado de worker (versão por ladrilho resolve); duplicação de código main/worker | tempo por fase, p95 dos quadros durante a geração, heap pico |
| E7 | Simulação em worker; meso por eventos no mapa, micro na janela, fronteiras de Burghout | −6 ms por quadro na página; tráfego no mapa inteiro sem custo por veículo longe | frenagem artificial e perda de capacidade na fronteira se a velocidade de entrada for ingênua (−5 m/s², ~2.000 contra 2.600 veíc./h/faixa em Burghout) | ms por quadro na página; contagem conservada de veículos na fronteira; fluxo por via meso contra micro na mesma via |
| E8 | Oclusão na CPU (massas L1, worker) para vistas de rua | rua de 22,5 M → ≤ 10 M de triângulos (incerto: depende da densidade da quadra) | um quadro de atraso causa pop ao virar a câmera (mitigar com margem e teste conservador) | triângulos e GPU na rua; contagem de pops em giro de 360° gravado |
| E9 | Persistência completa em partes binárias (cabeça por ladrilho e placa, OPFS ou IDB em worker, persist) | salvamento do mapa inteiro ≤ ~50 MB, nunca uma string inteira, página sem trava ao salvar | migração de saves antigos | tamanho do save; tempo de salvar e abrir; tarefa longa na página (Long Tasks) durante o autosave |
| E10 | Opcional: protótipo isolado em `WebGPURenderer` (compute de culling, indirect num buffer só, clusters nas cascas L0) | só se E2–E8 não bastarem na rua | alto: 33 arquivos de GLSL a portar para TSL, `BatchedMesh` em laço no WebGPU, WebGPU ausente no Linux | protótipo numa cena isolada antes de qualquer porte |

## 10. Armadilhas (o que falhou em outros e como evitar)

1. **Sem LOD em tudo** (CS2: dentes de 6.108 vértices desenhados sem pixel; props de 40–100 mil
   vértices). Regra: todo tipo de peça, prop, árvore e agente tem tamanho declarado e corte por
   tamanho na tela, testado.
2. **Sombra de tudo** (CS2: 72% das chamadas, ~40 ms). Casters por nível, com corte por texel;
   cache estático; dinâmicos separados (VSM: estático e dinâmico em cópias separadas; mover a luz
   invalida tudo).
3. **Props fundidos ao prédio** (CS2) impedem o culling deles. No Roadcraft as peças já são
   instâncias por tipo; manter assim.
4. **`BatchedMesh` grande para geometria que muda.** O three guarda a capacidade inteira na CPU
   (`_initializeGeometry`); no projeto foram 1.098 MB e a aba a 14 fps. No WebGPU ele é um laço
   de `drawIndexed`. Usar só para conjuntos pequenos e fixos.
5. **Multi-draw não é grátis.** Há um gargalo relatado no WebGL (issue Chromium não aberta, §3).
   No Bevy, multi-draw por cluster foi mal por overhead do processador de comandos. Medir antes
   de apostar em milhares de sub-draws.
6. **Nanite no navegador.** Sem `atomic<u64>` não há buffer de visibilidade (Scthe). O storage
   buffer tem 128 MB no Chrome. O pré-processamento do DAG custa minutos por bilhão de triângulos
   em nativo e ~10 mil triângulos/s no JS de Usnul, incompatível com prédios editados em tempo
   real. Os exemplos que impressionam são instâncias repetidas, não objetos únicos.
7. **Validação de indirect no Dawn** (Toji): um buffer de indirect por objeto custou ~3 ms (412
   buffers); um buffer só, ~10 µs. As medições de timestamp não mostram esse custo.
8. **Cache com teto rígido sem plano** (3DTilesRendererJS): ao encher, o refinamento para. Medir
   o uso do cache e preferir mostrar o nível grosso a abrir buraco.
9. **String e heap.** `JSON.stringify` do mapa passa do `kMaxLength` (~512 M de caracteres), e o
   heap tem o teto prático da faixa de 4 GB. Nada pode crescer com o mapa sem teto: caches,
   linhas de postes, registros JSON e arrays espelho na CPU.
10. **Clone estruturado na thread da página** (web.dev). Gravar o estado inteiro a cada mudança
    trava a aba; gravar só partes mudadas e em worker.
11. **Despejo do armazenamento.** Best-effort é apagado por LRU; o Safari apaga em 7 dias sem
    interação. Pedir `persist()` e oferecer exportação.
12. **Fronteira micro/meso ingênua** (Burghout): velocidade de entrada sem relação com o headway
    gera frenagem de −5 m/s² e capacidade artificialmente baixa. Detalhe de rede diferente nos
    dois lados distorce a atribuição de rotas.
13. **Simulação micro do mapa inteiro.** Nem CS1 nem Megacity simulam sem teto; o CS1 trava em
    16.384 veículos ativos. Teto por tipo de agente e meso no resto.
14. **Pop de LOD.** O agargaro troca LOD sem crossfade. Para prédios, a troca é perceptível se o
    limiar for de vários pixels; usar 1–2 px, histerese e esmaecimento pontilhado, e conferir em
    foto 1:1 na distância de troca.
15. **Imagem de cache ≠ imagem de jogo.** Tudo que o L1, L2 e L3 desenham (cor, janelas,
    desgaste) tem de casar com o L0 na distância de troca. O `OTIMIZACAO.md` já registra uma
    tentativa desfeita de "massa com as cores do detalhe". Testar por foto, não por suposição.

## 11. Fontes

Abertas com WebFetch e usadas:

1. Epic — City Sample: https://dev.epicgames.com/documentation/en-us/unreal-engine/city-sample-project-unreal-engine-demonstration
2. Epic — Nanite: https://dev.epicgames.com/documentation/en-us/unreal-engine/nanite-virtualized-geometry-in-unreal-engine
3. Epic — World Partition HLOD: https://dev.epicgames.com/documentation/en-us/unreal-engine/world-partition---hierarchical-level-of-detail-in-unreal-engine
4. Epic — Mass Entity: https://dev.epicgames.com/documentation/en-us/unreal-engine/overview-of-mass-entity-in-unreal-engine
5. Epic — Mass Gameplay (LOD e representação): https://dev.epicgames.com/documentation/en-us/unreal-engine/overview-of-mass-gameplay-in-unreal-engine
6. Epic — Virtual Shadow Maps: https://dev.epicgames.com/documentation/en-us/unreal-engine/virtual-shadow-maps-in-unreal-engine
7. CGW — The Matrix Awakens: https://www.cgw.com/Press-Center/In-Focus/2021/The-Matrix-Awaits-in-The-Matrix-Awakens-An-Unrea.aspx
8. Huhtala — CS2 performance: https://paavo.me/cities-skylines-2-performance/
9. DSOGaming — patch 1.0.11f1 do CS2: https://www.dsogaming.com/patches/cities-skylines-2-just-got-its-first-perfomance-patch/
10. Steam — limites do CS1 (lista do mod): https://steamcommunity.com/app/255710/discussions/0/152390648082792963
11. Steam — 64k agentes no CS1: https://steamcommunity.com/app/255710/discussions/0/357286033301141730
12. Steam — limites de LOD (Loading Screen Mod): https://steamcommunity.com/workshop/filedetails/discussion/667342976/1639789306562193628
13. TechCrunch — Blackshark.ai e MSFS: https://techcrunch.com/?p=2032098
14. MSFS 2024 SDK — AutoLOD/Simplygon: https://docs.flightsimulator.com/msfs2024/html/3_Models_And_Textures/Modeling/Landscape/Using_Simplygon_To_Generate_LODs.htm
15. Cesium — anúncio do OSM Buildings: https://community.cesium.com/t/announcing-cesium-osm-buildings/9757
16. 3D Tiles — especificação: https://github.com/CesiumGS/3d-tiles/blob/main/specification/README.adoc
17. CesiumJS — `Cesium3DTileset`: https://cesium.com/learn/cesiumjs/ref-doc/Cesium3DTileset.html
18. CesiumJS — `Cesium3DTile.js` (fórmula do erro de tela): https://raw.githubusercontent.com/CesiumGS/cesium/main/packages/engine/Source/Scene/Cesium3DTile.js
19. Google — Photorealistic 3D Tiles: https://developers.google.com/maps/documentation/tile/3d-tiles
20. NASA — 3DTilesRendererJS: https://github.com/NASA-AMMOS/3DTilesRendererJS
21. PCPer — Megacity (Unite LA 2018): https://pcper.com/2018/10/unite-la-2018-unity-presents-megacity-demo/
22. Unity — Megacity Metro: https://github.com/Unity-Technologies/megacity-metro
23. jms55 — Virtual geometry no Bevy 0.14: https://jms55.github.io/posts/2024-06-09-virtual-geometry-bevy-0-14/
24. Scthe — nanite-webgpu: https://github.com/Scthe/nanite-webgpu
25. zeux — Billions of triangles in minutes: https://zeux.io/2025/09/30/billions-of-triangles-in-minutes/
26. meshoptimizer — README: https://github.com/zeux/meshoptimizer
27. meshoptimizer — site: https://meshoptimizer.org/
28. AIFanatic — three-nanite: https://github.com/AIFanatic/three-nanite
29. Fórum three.js — "Virtually Geometric" (Usnul): https://discourse.threejs.org/t/virtually-geometric/28420?page=3
30. Fórum three.js — LOD e BatchedMesh (gkjohnson): https://discourse.threejs.org/t/when-is-it-actually-beneficial-to-use-lod-in-three-js-for-performance/87697/11
31. Fórum three.js — BatchedMesh LOD: https://discourse.threejs.org/t/batchedmesh-lod/82449
32. Fórum three.js — floresta de impostores octaédricos: https://discourse.threejs.org/t/a-forest-of-octahedral-impostors/85735
33. three.ez — InstancedMesh2: https://github.com/agargaro/instanced-mesh
34. three.ez — batched-mesh-extensions: https://github.com/agargaro/batched-mesh-extensions
35. Khronos — `WEBGL_multi_draw`: https://registry.khronos.org/webgl/extensions/WEBGL_multi_draw/
36. web.dev — WebGPU nos principais navegadores: https://web.dev/blog/webgpu-supported-major-browsers
37. Chrome — New in WebGPU 131 (multi-draw indirect): https://developer.chrome.com/blog/new-in-webgpu-131
38. Toji — indirect draws no WebGPU: https://toji.dev/webgpu-best-practices/indirect-draws.html
39. Rastergrid — Hi-Z occlusion culling: https://www.rastergrid.com/blog/2010/10/hierarchical-z-map-based-occlusion-culling/
40. Intel — Masked Occlusion Culling: https://github.com/GameTechDev/MaskedOcclusionCulling
41. MDN — `beginQuery`: https://developer.mozilla.org/en-US/docs/Web/API/WebGL2RenderingContext/beginQuery
42. MDN — WebGL best practices: https://developer.mozilla.org/en-US/docs/Web/API/WebGL_API/WebGL_best_practices
43. NVIDIA GPU Gems 3, cap. 10 — PSSM: https://developer.nvidia.com/gpugems/gpugems3/part-ii-light-and-shadows/chapter-10-parallel-split-shadow-maps-programmable-gpus
44. Greuter et al. 2003 — pseudo infinite cities (PDF): https://svn.sable.mcgill.ca/sable/courses/COMP763/oldpapers/greuter-03-real-time.pdf
45. RWTH — Krecklau et al. (fachadas procedurais): https://www.graphics.rwth-aachen.de/publication/03196_037_035_0324_0326_0332/
46. MDN — Transferable objects: https://developer.mozilla.org/en-US/docs/Web/API/Web_Workers_API/Transferable_objects
47. Chrome — transferables (números): https://developer.chrome.com/blog/transferable-objects-lightning-fast
48. MDN — SharedArrayBuffer: https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/SharedArrayBuffer
49. web.dev — COOP/COEP: https://web.dev/articles/coop-coep
50. MDN — OffscreenCanvas: https://developer.mozilla.org/en-US/docs/Web/API/OffscreenCanvas
51. Burghout 2004 — tese do híbrido meso/micro (PDF): https://kth.se/polopoly_fs/1.742065.1600688570!/hybrid%20mesoscopic.pdf
52. SUMO — modelo mesoscópico: https://sumo.dlr.de/docs/Simulation/Meso.html
53. MDN — cotas e despejo: https://developer.mozilla.org/en-US/docs/Web/API/Storage_API/Storage_quotas_and_eviction_criteria
54. MDN — OPFS: https://developer.mozilla.org/en-US/docs/Web/API/File_System_API/Origin_private_file_system
55. MDN — Compression Streams: https://developer.mozilla.org/en-US/docs/Web/API/Compression_Streams_API
56. MDN — `IDBDatabase.transaction` (durability): https://developer.mozilla.org/en-US/docs/Web/API/IDBDatabase/transaction
57. web.dev — boas práticas do IndexedDB: https://web.dev/articles/indexeddb-best-practices-app-state
58. V8 — `v8-primitive.h` (`kMaxLength`): https://github.com/v8/v8/blob/main/include/v8-primitive.h
59. V8 — compressão de ponteiros: https://v8.dev/blog/pointer-compression

Abertas, mas sem o conteúdo pedido (não usadas como fonte de números):

- https://blackshark.ai/?p=1857 (página institucional, nada do MSFS)
- https://unity.com/megacity (só a página do Megacity Metro)
- https://www.pcgamer.com/uk/unitys-impressive-megacity-tech-demo-is-available-now (corpo truncado)
- https://shaderbits.com/blog/octahedral-impostors (só cabeçalho)
- https://github.com/agargaro/octahedral-impostor (README sem corpo)
- https://steamcommunity.com/app/255710/discussions/0/152390648087024418 (erro de LOD de um usuário, sem orçamentos)
- https://issues.chromium.org/issues/437957104 (pede login)
- https://threejs.org/docs/#api/en/objects/BatchedMesh (só o índice; li o código local no lugar)

Não abriram:

- Karis, "A Deep Dive into Nanite" (SIGGRAPH 2021), PDF acima de 10 MB: https://advances.realtimerendering.com/s2021/Karis_Nanite_SIGGRAPH_Advances_2021_final.pdf
- Epic, página e blog do Matrix Awakens (403): https://www.unrealengine.com/en-US/wakeup e https://www.unrealengine.com/blog/introducing-the-matrix-awakens-an-unreal-engine-5-experience
- Danihelka & Zara, Eurographics 2011 (403): https://diglib.eg.org/items/1704c432-13e2-4008-9a58-f54590b382ba
- Neowin e Techraptor sobre os patches do CS2 (403)
- `unity.com/demos/megacity` (404); manual do `WebGPURenderer` no threejs.org (404); um post do blog da Cesium com URL que eu supus (404)

Código local lido (three r186 e meshoptimizer 1.2.0):

- `node_modules/three/src/objects/BatchedMesh.js`
- `node_modules/three/src/renderers/webgl/WebGLIndexedBufferRenderer.js`
- `node_modules/three/src/renderers/webgpu/WebGPUBackend.js`
- `node_modules/three/src/renderers/webgpu/WebGPURenderer.js`
- `node_modules/three/src/renderers/webgpu/nodes/StandardNodeLibrary.js`
- `node_modules/three/src/renderers/webgl-fallback/WebGLBackend.js`
- `node_modules/three/src/renderers/common/RenderList.js`
- `node_modules/three/src/lights/LightShadow.js`
- `node_modules/three/src/renderers/shaders/ShaderChunk/normal_fragment_begin.glsl.js`
- `node_modules/three/examples/jsm/loaders/KTX2Loader.js`
- `node_modules/meshoptimizer/meshopt_clusterizer.d.ts`
- `node_modules/meshoptimizer/meshopt_simplifier.d.ts`
