# Desempenho para mapas enormes nos modos planeta e plano — pesquisa, diagnóstico e arquitetura

> **HISTÓRICO** (marcado em 2026-10-14): não é o estado atual nem a lista de trabalho. O estado está em `memory/ESTADO.md`; os problemas de desempenho, com a regra de "feito", em `OTIMIZACAO.md`. Leia este arquivo só para saber o que já se tentou e mediu.

Relatório de 2026-10-11. Só pesquisa e investigação: nenhuma linha do jogo foi
alterada. As sondas de medida rodaram numa cópia do código fora do repositório
(anexo B).

## 0. Escopo, método e como ler

**O que foi examinado.** O modo planeta e o mapa plano completo não estão no
`master`: o planeta foi tirado do `master` em 2026-10-08 e vive no ramo
`planeta-esfera` (master + 112 commits, último `54c2e269`, com o mapa plano do
tamanho do globo, `docs/MAPA-PLANO-COMPLETO.md`). Este relatório analisa esse
ramo, que contém tudo o que o `master` tem. Quando cito `arquivo:linha`, é do
ramo `planeta-esfera` em `54c2e269`.

**Ordem de trabalho seguida.** (1) pesquisa externa em fontes primárias, lidas
na íntegra quando acessíveis (lista no anexo A); (2) leitura do código: docs do
projeto (`docs/PROBLEMAS.md`, `docs/PLANO.md`, `docs/ESCALA.md`,
`docs/MAPA-PLANO-COMPLETO.md`, os `CLAUDE.md` de cada pasta), leitura integral
dos caminhos quentes (laço de quadro, passo da simulação, mundo da simulação,
construção do grafo de faixas, planejador de rotas, desenho dos agentes,
reconstrução do mundo no renderizador, dobra do planeta, atlas de terreno,
atlas plano, qualidade, orçamentos, portão de desempenho, histórico de desfazer)
e varredura por padrão em todo `src/` (157 mil linhas); (3) medidas próprias;
(4) síntese.

**O que não foi lido linha a linha.** As 157 mil linhas não foram lidas uma a
uma. Fora dos caminhos quentes acima, o exame foi por varredura de padrões
(alocação, cópias, ordenações, chaves de texto, laços globais, culling
desligado, shaders próprios) e por leitura dos cabeçalhos e das funções que a
varredura apontou. Pessoas (`src/people`, `render/people`), edifícios por
dentro (`render/buildings/buildingMesh.ts`, 3 331 linhas) e pós-processamento
foram lidos só nos pontos que afetam o custo por quadro.

**Legenda das afirmações** (pedida no enunciado):

| Marca | Significado |
|---|---|
| **[MEDIDO-AQUI]** | medido neste trabalho; o método está no anexo B |
| **[MEDIDO-EQUIPE]** | medido antes pela equipe, com data e linha de `docs/PROBLEMAS.md` ou `src/core/perfBudget.ts` |
| **[CÓDIGO]** | demonstrável lendo o código; o mecanismo é certo, o tamanho do custo pode não estar medido |
| **[HIPÓTESE]** | plausível pelo código e pelas fontes, mas precisa de medida; o item 10 diz como medir |

**Máquina.** i9-12900K (8 núcleos P + 8 E, 24 threads), 32 GB, RTX 3060 (tela
2560×1080 a 59 Hz) e iGPU Intel UHD 770; Windows 10 19045. O Chrome sem
interface dos scripts desenha na iGPU (cerca de 5× mais lenta na GPU); o painel
do aplicativo desenha na RTX, mas só com o painel visível.

---

## 1. Síntese dos principais achados

1. **O custo do jogo cresce com o tamanho do mapa, não só com o que está na
   tela.** Com a mesma população (400 carros e 400 pessoas), o passo da
   simulação vai de 3,3 ms numa grade de 0,7 km para 9,7 ms numa de 4,3 km
   (mediana por passo de 1/60 s) **[MEDIDO-AQUI]**. Os estágios que mais
   crescem são os que percorrem o mapa inteiro a cada passo: semáforos de todos
   os cruzamentos (0,05 → 1,7 ms), despacho e rotas (0,19 → 1,3 ms), limpeza
   das faixas (0,18 → 0,86 ms). A 4× (quatro passos por quadro) o mapa de
   4,3 km já não cabe num quadro de 16,9 ms.
2. **Cada edição refaz trabalho do mapa inteiro.** Uma via isolada, desenhada
   fora da cidade e sem tocar em nada, custa na grade de 4,3 km: 6,8 s de
   preparo da topologia (fatiado em quadros, com o trânsito parado), 458 ms de
   troca num único quadro e 1,35 s da rede de pedestres **[MEDIDO-AQUI]**; na
   grade de 0,7 km os mesmos passos custam 55, 24 e 11 ms. Abrir o mapa de
   4,3 km sem cache levou 48 s só de topologia. O padrão se repete no
   renderizador (cenário, postes, mobiliário e listas de todo o mapa a cada
   edição) e no desfazer (o documento inteiro serializado e comparado a cada
   edição) **[CÓDIGO]**.
3. **A população é pequena para o tamanho do mundo.** O planeta tem cerca de
   183 km² e o mapa plano completo 335 km², mas o painel limita o mundo
   inteiro a 400 carros e 400 pessoas (`editor/persistence.ts:459-460`) e o
   motor a 1 200/1 000 (`sim/params.ts:185-186`) **[CÓDIGO]**. Com 1 000/1 000 o
   passo já leva 14-24 ms **[MEDIDO-AQUI]**. Uma "simulação completa" num mapa
   desse tamanho, nos jogos que fazem isso, usa níveis de detalhe de simulação
   (micro perto, filas ao longe), não mais força bruta.
4. **Tudo que importa roda na thread principal.** Simulação, rede viária,
   topologia, reconstrução do mundo, crescimento de zonas e desenho dividem uma
   thread; os workers (9 tipos) só assam pedaços específicos, cada pool com seu
   tamanho (até 6 + 4 + 2 + …) e sem memória compartilhada (sem COOP/COEP)
   **[CÓDIGO]**. Num processador de 24 threads, o jogo usa uma de verdade.
5. **O terreno tem dois níveis de detalhe, não uma hierarquia.** Placa inteira
   (célula de 6,4 m) perto e malha distante (60 m no plano, globo leve no
   planeta), com malhas próprias de cada placa montadas na CPU e muitos arrays
   por placa; no planeta, toda peça com algo construído fica carregada para
   sempre (`render/planet/terrainAtlas.ts:50-56`) **[CÓDIGO]**. Memória e
   desenho crescem com a área construída, não com a vista.
6. **Precisão: o jogo desenha em coordenadas absolutas.** O atlas do planeta vai
   a ±17 km e o mundo plano a ±12,5 km; câmera, vértices e a dobra do planeta
   trabalham em float32 nessas coordenadas (passo de 1-2 mm) **[CÓDIGO]**. Hoje
   isso basta; não escala para mundos maiores e tem custo de shader (a dobra
   recalcula a peça e a direção na esfera várias vezes por vértice, em todo
   material e na passada de sombra) **[CÓDIGO]**, cujo tamanho precisa de
   medida na RTX **[HIPÓTESE]**.
7. **Memória alta mesmo sem cidade.** Planeta vazio: 627-685 MB de heap JS,
   147 programas de shader, 191 texturas **[MEDIDO-AQUI]**; com a cidade do
   portão, 1,32-1,37 GB **[MEDIDO-EQUIPE, perfBudget.ts]**. Texturas são WebP
   descompactadas em RGBA8 na GPU (nenhum KTX2/Basis) **[CÓDIGO]**.
8. **O que já está certo e deve ser mantido**: trabalho fatiado com cota por
   quadro, diário de mudanças com retângulos, cache derivado no IndexedDB,
   compilação de shaders antecipada (`compileAsync`, `KHR_parallel_shader_compile`),
   instancing, desenho sob demanda, LOD de pessoas e carros, sombra só quando
   pedida, culling pelo horizonte (Cesium) no planeta, orçamentos em catraca e
   portão de desempenho. A arquitetura recomendada generaliza esses padrões, não
   os substitui.
9. **O portão de desempenho mede pouco do que o jogador sente.** Uma cena, 8 s,
   uma rodada, p95 de CPU por quadro (não o intervalo entre quadros, nem a GPU,
   nem p99), na iGPU sem interface, numa máquina compartilhada sem controle de
   ruído **[CÓDIGO]**. Ele protege contagens; não protege escala, fluidez ao
   viajar nem o tempo de GPU na RTX.

**Recomendação central.** Uma única partição espacial do mundo (células de
tamanho fixo dentro das placas/peças que já existem) como espinha de tudo:
dados, derivados, streaming, níveis de detalhe de desenho (HLOD), níveis de
detalhe de simulação, persistência e desfazer. Com ela: (a) o custo de uma
edição passa a depender só das células tocadas; (b) o custo do quadro depende
só das células vistas e das regiões simuladas em detalhe; (c) o trabalho pesado
sai da thread principal em lotes por célula, com dados transferíveis. Sobre essa
base: simulação em worker com dois níveis (micro e filas), terreno CDLOD,
renderização relativa à câmera por célula, HLOD de prédios, e um portão de
desempenho com cenários de escala, GPU e estatística. WebGPU fica para depois
(seção 7).

---

## 2. Pesquisa: como estúdios e engines resolvem isso

As referências entre colchetes ([F1]…) estão no anexo A. "Produção" quer dizer
que a técnica foi usada num produto lançado e descrita por quem a fez;
"experimental" quer dizer demo, artigo ou recurso atrás de flag.

### 2.1 Lições diretas de city builders e simulações grandes

**Cities: Skylines II (Colossal Order, Unity DOTS).** A análise de Paavo Huhtala
com RenderDoc [F1] é o estudo público mais detalhado de um city builder moderno
com problema de desempenho. Num quadro de uma vila de ~1 000 habitantes:
6 705 draw calls, das quais 72% eram de sombra; 121 milhões de vértices de
entrada e 36 milhões de triângulos rasterizados somando as passadas; a sombra
em cascata custava ~40 ms de um quadro de 87,8 ms; personagens de ~56 mil
vértices sem LOD (dentes de 6 108 vértices, 13 jogos de dentes desenhados com
zero pixels visíveis); objetos de 17 mil a 100 mil vértices sem LOD; prédio e
adereços fundidos numa malha, impedindo culling separado; só culling por
frustum, sem oclusão, e culling por distância pouco agressivo. A simulação, em
ECS/Jobs/Burst com cerca de 1 200 sistemas, usava bem os vários núcleos; o
jogo era limitado pela GPU. **Lição:**
num city builder o maior risco de GPU não é um efeito caro, é a falta de
disciplina de LOD, culling e sombras por tamanho na tela. O próprio estúdio
descreve a simulação como multinúcleo e sem limite rígido de agentes, com rota
calculada por agente por custo (tempo, conforto, dinheiro, comportamento) e
replanejamento em eventos [F3]. Tamanho de mapa: 159 km² em 441 peças; o
primeiro jogo usava peças de 1,92 × 1,92 km (o mesmo tamanho da placa do
Roadcraft), 92 km² no total [F2].

**Factorio (Wube).** Os Friday Facts são a melhor documentação pública de
otimização de simulação em larga escala [F4–F7]. Pontos medidos e aplicáveis:
- *"Fazer menos"* é a estratégia principal: entidades ociosas dormem e não
  custam nada; painéis solares e acumuladores agrupados custam o mesmo
  qualquer que seja o número; esteiras viram segmentos contíguos na memória
  em vez de itens atualizados um a um [F4].
- Dormir de verdade: roboports ociosos desligados, de 1 ms para
  0,025 ms por tick no save de teste; robôs atualizados raramente, com a
  posição prevista no desenho entre atualizações (+15% no save de escritório)
  [F7].
- Multithread só onde os dados são independentes: esteiras divididas em grupos
  que não interagem, um grupo por thread, e os efeitos sobre vizinhos
  enfileirados e aplicados depois numa ordem fixa (determinismo): esteiras de
  4 ms para 1,6 ms, 20-40% no total [F6].
- Multithread que falhou: a rede elétrica paralela caiu de 0,5 para 0,39 ms,
  mas a CPU usada subiu de 0,5% para 15% e o jogo não ficou mais rápido,
  porque o gargalo era a memória; foi descartada [F7]. Antes, rodar três
  sistemas em paralelo ficou *mais lento* que em série por invalidação de
  cache entre núcleos; leitura paralela de dados só lidos escala bem [F5].
- **Lição:** paralelismo só depois de arrumar os dados e só sobre partições
  independentes; medir CPU total gasta, não só o tempo do quadro.

**Multidões (produção).** Assassin's Creed Unity: limite de 40 IAs "reais" e
120 modelos de alta resolução, com ~10 000 NPCs de multidão na tela, por um
nível de detalhe de IA com reciclagem (troca de NPC barato por completo sem o
jogador perceber) e um "cérebro" simples para a massa [F8]. Hitman: Absolution:
1 200 personagens de multidão interativos a 30 fps em consoles de 2012 [F9].
Unreal Mass (usado na City Sample para trânsito e multidão): LOD de quatro
níveis (alto, médio, baixo, desligado) com distância e **número máximo** por
nível, frequência de atualização por nível e representação por nível (ator
completo, ator simples, malha instanciada animada por textura de vértices)
[F10]. **Lição:** população grande = poucos agentes completos perto da câmera,
muitos agentes baratos longe, troca invisível entre eles, e orçamento por
contagem, não por distância apenas.

**Trânsito em escala (produção, ferramentas de engenharia).** O SUMO tem um
modo mesoscópico: cada trecho de via vira uma fila; o veículo sai da fila num
tempo calculado pelo estado da fila atual e da seguinte; sem aceleração nem
movimento lateral; até 100× mais rápido que o modo microscópico [F11]. O IDM
(o modelo de seguimento que o jogo usa) dá o mesmo resultado com passos de até
0,5 s [F14] — o passo do jogo é 1/60 s. **Lição:** longe da câmera, filas e
passos grandes; perto, o modelo completo.

**Rotas em escala.** Bing Maps usa Customizable Route Planning: o grafo é
particionado uma vez (independente da métrica), a "customização" das
sobreposições com os custos atuais leva segundos (ou menos de um segundo na
versão de trabalho) e as consultas levam milissegundos [F13]. Supreme
Commander 2 resolveu milhares de unidades com campos de fluxo por setor de
10×10 m: A* sobre portais entre setores, campos de fluxo reaproveitados entre
pedidos (cache por portal), reconstrução por fila de prioridade com fatias de
tempo fixas, e teto de setores integrados por tick para limitar a CPU [F12].
**Lição:** rota hierárquica sobre partições + cache + orçamento por tick.

**SimCity (2013, GlassBox).** A palestra de 2012 descreve recursos, unidades,
mapas e agentes [F73]; o material público acessível é só o resumo, então não
uso como evidência técnica.

### 2.2 Mundo, partição, streaming e coordenadas

| Técnica | Como funciona | Produção? | Fonte |
|---|---|---|---|
| Grade de células com streaming por distância | Mundo em células fixas (exemplo 256 m); fontes de streaming (o jogador) carregam células num raio (exemplo 768 m); dados em um arquivo por ator | Produção (Unreal 5) | [F16] |
| HLOD por célula | Quando a célula sai, um proxy (instâncias, malha fundida ou simplificada) fica no lugar; menos draw calls de longe | Produção (Unreal 5) | [F17] |
| Árvore de tiles com erro geométrico | Cada tile tem um erro em metros; o erro na tela (pixels) decide refinar; filhos substituem ou somam ao pai; tiles implícitos (quadtree) | Padrão OGC, Cesium | [F18] |
| Cache LRU por bytes | Teto em bytes; ao encher, para de refinar e mantém os grossos | Produção (NASA-AMMOS, three.js) | [F36] |
| Grade fixa × hierárquica | Grade fixa para objetos móveis espalhados; quadtree para móveis agrupados; BSP/k-d para estáticos | Padrão consolidado | [F50] |

**Precisão de coordenadas.** float32 tem passo de ~2 mm entre 16 e 33 km e só
representa inteiros exatos até 16,7 milhões [F23]. As soluções comprovadas:
- *Relativo ao centro (RTC):* vértices guardados em relação a um centro
  próximo; a CPU (em double) calcula o centro relativo ao olho e a GPU só vê
  números pequenos. Vale enquanto o objeto tem até ~131 km para precisão de
  centímetro [F21].
- *Relativo ao olho (RTE) na GPU:* cada posição em dois floats (alto e baixo),
  subtraídos separadamente no shader; erro máximo ~1,35 cm em escala
  planetária, ao custo de +37,5% no vértice típico [F21].
- *Doubles na CPU e floats na GPU:* Unreal 5 (limite do mundo de 88 milhões de
  km; partículas guardam célula + deslocamento em floats) [F22]; Godot com
  build em double e emulação de double nos shaders, recomendando mudar a
  origem em vez disso em plataformas modestas [F23].

**Planetas.** Esfera a partir de cubo com quadtree por face (distorção bem
menor que latitude/longitude) e LOD em pedaços [F26]; culling pelo horizonte,
que num exemplo do Cesium descartava mais da metade dos tiles [F25].

**Profundidade.** Com profundidade em float e Z invertido, a precisão fica
quase uniforme e os erros de comparação somem na simulação do autor [F24]. No
three.js r186, `reversedDepthBuffer` existe no `WebGLRenderer` (precisa de
`EXT_clip_control`), mas os mantenedores registram sombras e SSAO ainda
incompletos, e o `WebGPURenderer` não o suporta [F27, F32]. O
`logarithmicDepthBuffer` escreve `gl_FragDepth`, desliga o early-Z e, num
relato com muita vegetação, o quadro foi de 15,4 para 28,6 ms [F27, F33].

### 2.3 Renderização

**Terreno.**
- *Geometry clipmaps* (anéis aninhados centrados no observador, atualização
  toroidal): ~6L+5 draw calls; LOD só pela posição em planta, não pela altura
  do olho [F20].
- *CDLOD* (quadtree de grades regulares, LOD pela distância 3D, transição por
  "morph" no vertex shader, uma única malha de grade reaproveitada por todos os
  nós): 60-120 lotes por quadro nas bases de teste e 0,08-0,57 ms de CPU por
  quadro no percurso da árvore; sem costuras nem faixas de emenda [F19].
- *Texturas virtuais adaptativas* (Far Cry 4): terreno e grande quantidade de
  decalques num atlas virtual, 10 km × 10 km a 10 texels/cm [F46]; Far Cry 5
  move LOD, culling e emendas do terreno para compute na GPU [F47]. Produção,
  mas sem equivalente simples no WebGL.

**Draw calls no navegador.** No Chromium cada chamada WebGL é serializada num
command buffer, atravessa IPC até o processo da GPU e é validada antes de
chegar ao driver [F43]; por isso o custo por chamada é maior que no nativo
(inferência do desenho descrito, sem número publicado). As formas de juntar:
malha fundida (estática), `InstancedMesh` (mesma malha), `BatchedMesh`
(malhas diferentes, um material, `WEBGL_multi_draw`) e, no WebGPU, desenho
indireto. Sobre o `BatchedMesh`: ordenação e culling por objeto rodam na CPU a
cada quadro, há regressões de desempenho abertas, e um mantenedor resume que,
quando todo desenho é único, ele está no limite sem desenho indireto [F30,
F31]. `InstancedMesh2` (@three.ez) acrescenta culling por instância com BVH,
LOD e LOD de sombra [F34]; uma demo com 200 mil árvores usa ele com LODs do
meshoptimizer e impostores octaédricos acima de 100 m [F35].

**Culling.** Além de frustum e horizonte: oclusão por software com
profundidade hierárquica mascarada (Intel): 7 milhões de triângulos
testados em ~4 ms de uma thread nativa com SIMD, 98% do culling de um buffer
de profundidade completo [F45]; pipelines dirigidos pela GPU, em que a própria
GPU decide a visibilidade sem ida e volta à CPU (Assassin's Creed Unity,
~10× mais instâncias que os jogos anteriores) [F44, só o resumo foi
acessível]. No navegador, a oclusão dirigida pela GPU exige WebGPU (compute) e
desenho indireto; `multiDrawIndirect` existe só como recurso experimental do
Chrome atrás de flag [F42].

**Sombras.** Cascatas recortam o frustum em fatias com resolução decrescente;
o custo vem do número de casters desenhados em cada fatia. Na amostra da
NVIDIA, as variantes que descartam primitivas fora de cada cascata ficam entre
as mais rápidas, mas usam geometry shader e
multicast de viewport, que o WebGL não tem; no navegador o equivalente é o
culling por cascata na CPU [F71]. Mapas de sombra guardados ("on demand"), só
refeitos quando algo muda, são recurso de produção no HDRP [F70]. A lição de
[F1] é a mais relevante: casters sem critério de tamanho e distância foram
72% das draw calls.

**Multidões.** Skinning instanciado com a paleta de ossos numa textura: ~9 500
personagens a 34 fps em hardware de 2007, 160 draw calls contra 59 726 sem
instancing; o ganho é de CPU [F40].

**Melhores práticas WebGL** [F37]: evitar chamadas que sincronizam com a GPU
(`getError`, `getParameter`, `readPixels`), compilar e ligar shaders em lote e
consultar o estado só depois (`KHR_parallel_shader_compile`), `texStorage`,
texturas comprimidas, orçamento de VRAM por pixel da tela (não há consulta
portátil de VRAM), `invalidateFramebuffer`, VAOs estáticos, juntar desenhos.

### 2.4 Assets

- **Texturas comprimidas na GPU (KTX2/Basis).** No exemplo da Khronos, as
  texturas de uma luminária ocupam 96 MB na GPU como JPG/PNG e 21 MB como KTX;
  um PNG de 512² vai de 1,5 MB para 277 KB; UASTC para normal e
  roughness/oclusão/metal, ETC1S para cor [F38]. three.js tem `KTX2Loader`.
- **Malhas.** meshoptimizer: simplificação por erro relativo, preservando
  bordas (`LockBorder`) para simplificar pedaços sem frestas; quantização de
  vértices; compressão glTF `EXT_meshopt_compression` decodificada a 3-6 GB/s;
  tipicamente 2-4× menor nos vértices [F39]. O projeto já usa meshoptimizer
  para LOD de carros e pessoas.
- **Vegetação.** LODs simplificados + impostores octaédricos de longe [F35].

### 2.5 Simulação, CPU e memória

- **Passo fixo com interpolação** (acumulador, teto por quadro para não entrar
  em espiral, desenho interpolado entre os dois últimos estados) [F15]. O jogo
  já faz isso (`sim/clock.ts`).
- **Localidade de dados.** Arrays contíguos de componentes em vez de seguir
  ponteiros (o autor mediu ~50× num teste), ativos primeiro, separar campos
  quentes dos frios; aplicar só onde o perfil mostra faltas de cache [F49].
- **GC do V8.** O coletor jovem custa proporcionalmente aos sobreviventes, não
  ao que foi alocado; objetos que sobrevivem a dois ciclos vão para a geração
  velha, mais cara; marcação concorrente reduziu pausas em jogos WebGL em até
  50% [F48]. Alocação de vida curta é barata; o caro é reter.

### 2.6 Concorrência no navegador

- `SharedArrayBuffer` só com isolamento entre origens (`COOP: same-origin` +
  `COEP: require-corp` ou `credentialless`); `Atomics` para sincronizar [F51,
  F52]. Sem isolamento, `ArrayBuffer` **transferível** passa de um worker a
  outro sem cópia, mas o remetente perde o acesso [F53].
- O `postMessage` com clonagem custa proporcionalmente ao tamanho do JSON
  equivalente; até ~10 KiB cabe com folga num quadro de 16 ms; acima disso,
  binário transferível ou memória compartilhada [F54].
- Threads WebAssembly: pool criado antes (criar e esperar trava), tamanho do
  pool ajustado à carga em vez de reservar todos os núcleos; ganhos de 1,5-3×
  no Squoosh [F55].
- `OffscreenCanvas` permite desenhar WebGL num worker (base desde 2023); a
  entrada e o tamanho do canvas têm de ser repassados pela thread principal
  [F56].
- Job system da Unity: no máximo um worker por núcleo, roubo de trabalho,
  cada job com cópia dos seus dados (sem corrida) [F57].

### 2.7 Hardware e sistema

- Alder Lake no Windows 10 não tem o Thread Director (só HGS): o Windows 10
  vê os núcleos E como "lentos", não como "eficientes"; a Intel diz que o
  efeito aparece sobretudo como variação de rodada a rodada [F68]. Para medir,
  isso significa mais repetição e cuidado com o que roda ao lado.
- Escala de resolução dinâmica: baixar a resolução de renderização quando o
  quadro aperta, antes de cortar recursos [F69].
- GPU em pouco uso baixa o clock: tempos de GPU medidos com o jogo a 1 quadro/s
  (painel escondido) não valem (observado aqui: 52 ms por quadro escondido,
  seção 5.10).
- No Chromium, o WebGL das páginas é executado no processo de GPU, para onde
  os comandos vão por IPC [F43]; o que outra aba desenha disputa a mesma GPU. No aplicativo do
  Claude o painel é um só processo de GPU para todas as conversas (memória do
  projeto). Para medir, nada mais desenhando.
- A versão desktop (Electron) já pede a GPU de alto desempenho e desliga a
  limitação de abas em segundo plano (`desktop/main.cjs:20-24, 41`); no
  navegador comum quem escolhe a GPU é o Windows (configuração de gráficos por
  aplicativo).
- Consumo: o desenho sob demanda (que o jogo já faz) é a maior economia de
  energia; escala de resolução e LOD reduzem o resto.

### 2.8 Experiência: ritmo de quadros, travadas, entrada

- FPS médio esconde travadas; a análise por percentis de tempo de quadro veio
  da Tech Report (2011); a NVIDIA recomenda olhar a cauda (98%-99,95%), curvas
  de percentil normalizadas subtraindo a média, e capturas longas (dezenas de
  milhares de quadros) para a cauda se repetir entre rodadas [F63].
- Long Animation Frames (Chrome 123+): quadros acima de 50 ms com atribuição
  por script, inclusive o tempo bloqueando entrada [F58]. `scheduler.yield`
  quebra tarefas longas dando prioridade à continuação (disponibilidade
  limitada) [F59]. O `requestAnimationFrame` para em abas e quadros ocultos
  [F60].
- Compilação de shader: compilar antes (`compileAsync`) é a recomendação do
  three.js [F27, F28].

---

## 3. Comparação das tecnologias e metodologias

### 3.1 WebGL 2 × WebGPU (three.js r186)

| Critério | `WebGLRenderer` (hoje) | `WebGPURenderer` |
|---|---|---|
| Maturidade | Mantido; sem grandes recursos novos planejados [F29] | "Experimental", melhorando a cada versão; pode ser mais lento que o WebGL em algumas cenas [F29] |
| Suporte | Universal | Chrome/Edge 113+ (Windows, macOS, ChromeOS), Firefox 141+ no Windows, Safari 26; **Linux ainda não** [F41]; cai para um backend WebGL 2 |
| Shaders do projeto | 43 `onBeforeCompile`, 23 `ShaderMaterial`, remendo global de `ShaderChunk` na dobra do planeta (`render/planet/bend.ts:219-266`), cadeia própria com `EffectComposer` **[CÓDIGO]** | Nada disso funciona: tudo precisa ser reescrito em TSL/nós; `EffectComposer` não existe [F29] |
| Compute | Não | Sim (`compute`, `computeAsync`, despacho indireto) [F28] |
| Desenho indireto múltiplo | Não | Não no padrão; `multiDrawIndirect` só experimental no Chrome atrás de flag [F42] |
| Oclusão | Consultas de oclusão do WebGL 2 (assíncronas) | `isOccluded` [F28] |
| Z invertido | Sim (`reversedDepthBuffer`, com sombras/SSAO incompletos) [F32] | Não [F32] |

**Conclusão:** o ganho do WebGPU para este jogo (culling e animação na GPU)
não compensa agora o custo de portar ~66 shaders, a dobra do planeta e o
pós-processamento, num renderizador experimental. Os gargalos medidos estão na
CPU e no crescimento com o mapa, que o WebGPU não resolve (seção 7).

### 3.2 Terreno

| Abordagem | Detalhe | Memória por área | Custo na CPU | Emendas | Encaixe aqui |
|---|---|---|---|---|---|
| Placas inteiras + malha distante (hoje) | 2 níveis | malha única por placa + vários arrays de 90 mil cantos + texturas de dados (plano) | montagem da placa (worker no plano) | saia na borda | o que existe |
| Geometry clipmaps [F20] | anéis por distância em planta | texturas de altura por nível | baixa | faixas de emenda | ruim para o planeta (centro móvel numa esfera) |
| Chunked LOD [F26] | pedaços pré-tesselados | malha por pedaço e nível | baixa | emendas/saias | bom no planeta, pré-processamento pesado |
| **CDLOD** [F19] | quadtree, morph contínuo | **uma grade compartilhada + textura de altura por nó** | muito baixa (0,1-0,6 ms) | nenhuma | **escolhido**: funciona por peça do planeta e por placa do plano; edição só reescreve texturas |
| Tiles com erro geométrico [F18] | refinamento por erro na tela | por tile | baixa | depende do conteúdo | serve para prédios/HLOD, não para o terreno editável |

### 3.3 Precisão

| Abordagem | O que muda no código | Custo | Limite |
|---|---|---|---|
| Absoluto em float32 (hoje) | nada | zero | ~1-2 mm a 10-30 km; piora 2× a cada dobro |
| Origem flutuante (mover o mundo) [F23] | deslocar tudo ao trocar de origem | picos na troca | bom para física; em three.js ruim se exige mexer em milhares de objetos |
| **RTC por célula** [F21] | vértices locais à célula; `object.position` = origem da célula − origem de desenho | ~zero (o three já calcula `modelViewMatrix` em double na CPU, `WebGLRenderer.js:2160`) | cada célula < 131 km (sobra) |
| RTE na GPU (alto/baixo) [F21] | atributo duplo, shader próprio | +37,5% vértice, shaders | escala planetária real |

### 3.4 Juntar desenhos

| Mecanismo | Quando | Custo na CPU | Riscos |
|---|---|---|---|
| Malha fundida por célula | estático, mesmo material | zero por quadro | sem culling interno; refazer a célula ao editar |
| `InstancedMesh` (hoje, 41 usos) | mesma malha | escrita das matrizes | culling só da malha inteira (`frustumCulled=false` em 51 objetos) |
| `InstancedMesh2` [F34] | muitas instâncias espalhadas | culling por instância (BVH) | dependência externa; WebGL |
| `BatchedMesh` [F30] | malhas diferentes, um material | ordenação/culling por objeto na CPU | regressões abertas [F31]; no projeto já foi testado e desfeito (P29: compilação de 3 s, montagem de 2,8 s) **[MEDIDO-EQUIPE]** |
| Indireto na GPU | WebGPU | quase zero | experimental [F42] |

### 3.5 Simulação em escala

| Nível | Modelo | Custo | Onde usar |
|---|---|---|---|
| Micro (hoje, todos os agentes) | IDM + MOBIL + admissão por pontos de conflito | proporcional a agentes **e** ao mapa (seção 5.1) | região vista e arredores |
| Micro com passo maior | o mesmo, a 0,25-0,5 s | ~4-8× menos passos (IDM igual até 0,5 s [F14]) | faixa intermediária, sem pedestres interagindo |
| **Meso (filas)** [F11] | fila FIFO por trecho; saída por tempo livre e headway | até 100× menos que micro (SUMO) | resto do mapa |
| Agregado (fluxos) | volume por trecho e hora | desprezível | distritos sem ninguém olhando |

Transição: o agente muda de nível ao cruzar a borda da região detalhada, como
o "bolt crowd" ↔ IA completa do AC Unity [F8] e os níveis do Mass [F10].

### 3.6 Rotas

| Algoritmo | Pré-processo | Atualização com trânsito | Consulta | Complexidade de implementação |
|---|---|---|---|---|
| Dijkstra em faixas (hoje, `sim/drive/tactical.ts:120`) | nenhum | imediata | cresce com o grafo | baixa |
| A* com heurística (distância/limite de velocidade) | nenhum | imediata | menos nós visitados | baixa |
| Hierárquico por células (estilo portais [F12]) | por célula, incremental | por célula suja | pequena | média |
| CRP / multinível [F13] | partição | segundos ou menos | ms | alta |
| Contraction Hierarchies | pesado | refazer | a mais rápida | alta, ruim com edição |

### 3.7 Concorrência

| Opção | Requisito | Custo de transferência | Uso aqui |
|---|---|---|---|
| Fatias na thread principal (hoje) | nenhum | zero | trava a entrada se a fatia for longa |
| Worker + `ArrayBuffer` transferível | nenhum | zero-cópia, perde o acesso [F53] | **primeiro passo**: simulação e malhas por célula |
| Worker + `SharedArrayBuffer` | COOP/COEP [F52] | zero; sincronizar com `Atomics` | depois: estado da simulação lido pelo desenho sem mensagem |
| WASM com threads | COOP/COEP; pool fixo [F55] | zero | só para núcleos numéricos fechados (física já é Jolt WASM) |
| `OffscreenCanvas` (desenho num worker) | entrada repassada [F56] | — | não agora: o gargalo não é a UI na thread principal |

### 3.8 Desfazer e persistência

| Modelo | Custo por edição | Memória | Hoje |
|---|---|---|---|
| Instantâneo do documento inteiro (texto) | O(documento) ×2 (antes e depois, comparação de texto) | teto de 96 MB, poucos passos em mapas grandes | `editor/history.ts`, `main.ts:1198-1213` **[CÓDIGO]** |
| **Comando + inverso / delta por registro** | O(registros tocados) | proporcional ao que mudou | recomendado |
| Persistência por célula (um "arquivo" por célula, como um arquivo por ator [F16]) | só células sujas | — | recomendado |

---

## 4. Aplicação em Three.js (com exemplos)

Os trechos abaixo são **material do relatório**: mostram a forma da solução no
three.js r186 e no código deste jogo; não foram aplicados nem testados no jogo.
Cada item tem uma ficha: gargalo, API, compatibilidade, custo, efeito visual e
como medir o benefício.

### 4.1 Medir a GPU, o ritmo e a CPU do quadro

O monitor do jogo mede a CPU de cada sistema dentro do quadro
(`core/health.ts` `frameStats`), não a GPU nem o intervalo entre quadros. A
extensão `EXT_disjoint_timer_query_webgl2` mede o tempo de GPU de um trecho; o
resultado chega quadros depois e é descartado se houver "disjoint" [F61]. É o
instrumento usado na tentativa da seção 5.10 e o que a fase 0 deve levar ao
portão e ao F9:

```ts
// Envolve renderer.render: uma consulta por chamada de nível superior
// (a sombra e os passes do pós ficam dentro), somadas por quadro.
function installGpuTimer(renderer: WebGLRenderer) {
  const gl = renderer.getContext() as WebGL2RenderingContext;
  const ext = gl.getExtension('EXT_disjoint_timer_query_webgl2');
  if (!ext) return null;
  const done: number[] = [], intervals: number[] = [];
  let open: WebGLQuery[] = [], waiting: WebGLQuery[][] = [], inside = false, last = 0;
  const render = renderer.render.bind(renderer);
  renderer.render = (scene, camera) => {
    if (inside) return render(scene, camera);          // passes aninhados
    inside = true;
    const q = gl.createQuery()!;
    gl.beginQuery(ext.TIME_ELAPSED_EXT, q);
    try { render(scene, camera); } finally { gl.endQuery(ext.TIME_ELAPSED_EXT); open.push(q); inside = false; }
  };
  const tick = (t: number) => {
    if (last) intervals.push(t - last);
    last = t;
    if (open.length) { waiting.push(open); open = []; }
    while (waiting.length && waiting[0]!.every((q) => gl.getQueryParameter(q, gl.QUERY_RESULT_AVAILABLE))) {
      const qs = waiting.shift()!;
      const disjoint = gl.getParameter(ext.GPU_DISJOINT_EXT);
      let ns = 0;
      for (const q of qs) { ns += gl.getQueryParameter(q, gl.QUERY_RESULT); gl.deleteQuery(q); }
      if (!disjoint) done.push(ns / 1e6);               // ms de GPU do quadro
    }
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
  return { gpuMs: done, intervalMs: intervals };
}
```

- **Gargalo:** saber se o quadro está preso na GPU, na CPU ou no ritmo.
- **Compatibilidade:** Chrome/Edge desktop no ANGLE/D3D11 (confirmado aqui na
  RTX); pode não existir em outros navegadores — o portão deve tolerar a falta.
- **Cuidados:** a GPU tem de estar em carga contínua (painel visível, sem
  limitação de quadros); com a GPU ociosa ela baixa o clock e o tempo infla.
- **Medida:** GPU p50/p95/p99 por cenário; intervalos p50/p95/p99 e contagem
  acima de 2× o período da tela (33,8 ms a 59 Hz).

### 4.2 Desenho relativo à câmera por célula (RTC)

O three.js já calcula `modelViewMatrix = câmera⁻¹ × matrixWorld` em números
JavaScript (double) na CPU para cada objeto (`WebGLRenderer.js:2160`;
`Matrix4.elements` é um array comum) e só então envia float32. Logo, se os
vértices de uma célula forem **locais à célula** e a posição grande ficar no
`object.position`, a GPU nunca vê números grandes — RTC sem shader especial:

```ts
const CELL = 256;                                   // m (planeta: 2 por peça de 512 m; no plano, 240 = 1,92 km / 8)
const origin = { x: 0, y: 0 };                      // origem de desenho, em double

interface Cell { readonly ox: number; readonly oy: number; readonly group: Group }

/** Uma vez por quadro: a origem segue o olho em passos de célula. */
function placeWorld(eye: { x: number; y: number; h: number }, camera: Camera, cells: Iterable<Cell>) {
  origin.x = Math.round(eye.x / CELL) * CELL;
  origin.y = Math.round(eye.y / CELL) * CELL;
  camera.position.set(eye.x - origin.x, eye.h, -(eye.y - origin.y)); // x leste, y altura, z = -y do mapa
  for (const c of cells) c.group.position.set(c.ox - origin.x, 0, -(c.oy - origin.y));
}
// Ao montar a malha da célula: positions[i] = x - cell.ox (e não x).
```

O que quebra: shaders que remontam a posição absoluta (`modelMatrix * position`
para névoa, ruído, ou a dobra do planeta). Para eles passa-se a origem como
uniforme separado em alto/baixo (como a GPU RTE [F21]) ou só a parte que cabe
(por exemplo `fract(origem / período)` para ruídos periódicos). No planeta,
a peça de cada objeto pode ir como uniforme por objeto (o centro e os eixos da
peça), o que também tira do vertex shader a busca da peça e as tangentes que
hoje se repetem por vértice (seção 5.7):

```glsl
// por objeto (Object3D.onBeforeRender + material.uniformsNeedUpdate = true)
uniform vec3 uTileC, uTileE, uTileN;   // centro e eixos da peça na esfera
uniform vec2 uCellOnTile;              // origem da célula no mapa da peça (m)
vec3 planetDirLocal(vec2 local) {      // local: m no mapa da peça
  float r = length(local);
  if (r < 1e-4) return uTileC;
  float th = r / PLANET_R;
  return cos(th) * uTileC + (sin(th) / r) * (local.x * uTileE + local.y * uTileN);
}
```

- **Gargalo:** precisão (vértices tremendo, sombras e decalques brigando) e
  custo de vertex shader no planeta.
- **API:** `Object3D.position`, `onBeforeRender`, `Material.uniformsNeedUpdate`.
- **Compatibilidade:** total (WebGL 1/2, WebGPU).
- **Custo:** médio-alto: toda montagem de malha passa a escrever coordenadas
  locais; instâncias (`InstancedMesh`) ficam por célula para que a matriz de
  instância também seja local.
- **Visual:** igual ou melhor (precisão independente do tamanho do mapa).
- **Medida:** sonda de "tremor": câmera parada na altura dos olhos na borda do
  atlas (±17 km) e no centro, deslocamentos de 1 mm por quadro, diferença de
  pixels entre quadros; deve ser igual nos dois lugares.

### 4.3 Terreno CDLOD

Uma única grade (por exemplo 33×33 vértices) desenhada para cada nó escolhido
da quadtree, com a altura lida de uma página de textura; o vértice "ímpar"
desliza para o vizinho par à medida que o nó se afasta, de modo que o nó
termina igual ao nível acima antes da troca [F19]. Com instancing, todos os nós
viram uma draw call:

```glsl
// vertex shader (ShaderMaterial ou onBeforeCompile); posição da grade em 0..1
uniform highp sampler2DArray uHeights;   // uma camada por página de altura (R32F)
uniform vec3 uEye;                        // olho relativo à origem de desenho
attribute vec4 aNode;                     // x0, y0 (relativos à origem), tamanho (m), camada
attribute vec2 aMorph;                    // início e fim da faixa de morph (m)
const float GRID = 32.0;

vec2 morphVertex(vec2 gridPos, vec2 local, float k) {
  vec2 odd = fract(gridPos * 0.5) * 2.0;            // 1 nos vértices ímpares
  return local - odd * (aNode.z / GRID) * k;         // fórmula do artigo
}
void main() {
  vec2 gridPos = position.xz * GRID;
  vec2 local = position.xz * aNode.z;
  float h0 = texelFetch(uHeights, ivec3(ivec2(gridPos), int(aNode.w)), 0).r;
  float d = distance(uEye, vec3(aNode.x + local.x, h0, aNode.y + local.y));
  float k = clamp((d - aMorph.x) / (aMorph.y - aMorph.x), 0.0, 1.0);
  local = morphVertex(gridPos, local, k);
  vec2 uv = local / aNode.z;                         // releitura no ponto deslocado
  float h = texture(uHeights, vec3(uv, aNode.w)).r;  // precisa de OES_texture_float_linear
  vec3 p = vec3(aNode.x + local.x, h, -(aNode.y + local.y));
  gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.0);
}
```

```ts
// Seleção (CPU, por quadro): alcances por nível crescem 2× (ranges[0] o mais fino).
function select(node: QuadNode, level: number, eye: Vector3, frustum: Frustum, out: Pick[]): boolean {
  if (!node.box.intersectsSphere(sphereAt(eye, ranges[level]!))) return false; // longe: o pai cobre
  if (!frustum.intersectsBox(node.box)) return true;                             // fora da vista
  if (level === 0 || !node.box.intersectsSphere(sphereAt(eye, ranges[level - 1]!))) {
    out.push({ node, level });                                                   // inteiro neste nível
    return true;
  }
  for (const child of node.children) {
    if (!select(child, level - 1, eye, frustum, out)) out.push({ node: child, level }); // quarto do pai
  }
  return true;
}
```

Edição: a moldagem do chão às vias (hoje em blocos de 160 m) escreve no array
de alturas da página e reenvia só a página (`copyTextureToTexture`/
`texSubImage3D`), o que encaixa no diário de mudanças que já existe. Normais
por diferenças centrais no shader ou numa página de normais.

- **Gargalo:** memória e CPU por placa; salto 6,4 m → 60 m; peças presas.
- **API:** `DataArrayTexture` (WebGL 2), `InstancedBufferAttribute`.
- **Compatibilidade:** WebGL 2 (usado já).
- **Custo:** alto (substitui `createTerrainSurface`, que tem 4 371 linhas com
  água, margens, pintura e ecologia); fazer por trás de uma chave, placa a placa.
- **Visual:** transição contínua, sem estalo; detalhe igual perto.
- **Medida:** bytes de GPU por km² visível, vértices desenhados, ms do
  `update` por placa, quadros acima de 33 ms ao viajar (cenários E e F de 9.3).

### 4.4 HLOD de prédios por célula, pelo erro na tela

Cada célula guarda representações com um erro em metros: completa (hoje),
sem detalhes de fachada (hoje há `setFar` e `cullDetails`), casca simplificada
fundida por material (meshoptimizer com `LockBorder`), e de longe caixas ou
impostores. Escolhe-se pelo erro em pixels, como nos 3D Tiles [F18]:

```ts
/** Erro na tela (px) de um erro geométrico `e` (m) a `d` m, câmera em perspectiva. */
const sse = (e: number, d: number, viewportH: number, fovY: number) =>
  (e * viewportH) / (2 * Math.max(d, 1e-3) * Math.tan(fovY / 2));
/** Na ortográfica do jogo: zoom em px por metro. */
const sseOrtho = (e: number, pxPerMetre: number) => e * pxPerMetre;

function pickLevel(cell: CellLods, d: number, view: View): number {
  for (let i = cell.levels.length - 1; i > 0; i--) {                 // do mais grosso ao mais fino
    if (sse(cell.levels[i]!.error, d, view.h, view.fovY) <= MAX_SSE_PX) return i;
  }
  return 0;
}
```

As cascas simplificadas são feitas num worker e guardadas no cache derivado
(IndexedDB) pela chave da célula — o mesmo padrão dos tiles de via (P21).

- **Gargalo:** triângulos e draw calls na vista de cima e no globo.
- **Custo:** médio (gerar e guardar proxies; trocar por célula com
  histerese).
- **Visual:** perde só o que está abaixo do limite de pixels escolhido.
- **Medida:** triângulos e draw calls por quadro nos cenários "alto" e "globo"
  com uma cidade de 1 500+ prédios; o piso de triângulos da vista de rua do
  portão não muda.

### 4.5 Agentes: culling por célula antes de calcular a pose

Hoje cada veículo do mundo tem pose e altura calculadas antes do teste de
visibilidade (`render/agents.ts:1989-2004`). Com os agentes agrupados por
célula (a simulação já tem grades por célula para pedestres e trânsito), o
desenho testa a célula primeiro:

```ts
for (const cell of cellsInViewNearestFirst) {         // frustum + horizonte por célula
  for (let k = cell.first; k < cell.first + cell.count; k++) {
    const id = agentsByCell[k]!;
    if (drawn >= cap) break;                          // teto pelos mais próximos, não pelo id
    poseInto(id, alpha, pose);                        // só os candidatos
    // ...
  }
}
```

- **Gargalo:** CPU do desenho proporcional à frota inteira.
- **API:** nenhuma nova; `Frustum.intersectsBox` por célula (no planeta, a
  esfera da célula levada pela dobra, como `planetSphereInView` já faz).
- **Compatibilidade:** total. **Custo:** baixo-médio (a grade por célula sai
  da simulação ou do instantâneo do worker). **Visual:** igual; o teto passa a
  escolher os mais próximos.
- **Medida:** ms de `sync` com 1 000 veículos, a maioria fora da vista.

### 4.6 Simulação num worker

O `world` e o `sim` não importam `render` (regra imposta por `tests/arch`), o
que permite rodar a simulação num worker com uma réplica do documento,
alimentada pelos mesmos comandos de edição. O desenho recebe instantâneos
compactos e interpola entre os dois últimos, como hoje faz com `alpha` [F15]:

```ts
// sim.worker.ts — cada agente tem um "slot" fixo, para alinhar instantâneos
const STRIDE = 8;                         // x, y, deck, yaw, speed, flags, lod, kind
const spare: ArrayBuffer[] = [];
self.onmessage = (e: MessageEvent) => {
  const m = e.data;
  if (m.type === 'edit') applyEdit(world, m.op);            // mesmo comando que o main aplicou
  else if (m.type === 'return') spare.push(m.buffer);        // buffer que o desenho já usou
  else if (m.type === 'advance') {
    for (let i = 0; i < m.steps; i++) step(world);
    const buffer = spare.pop() ?? new ArrayBuffer(SLOTS * STRIDE * 4);
    const count = writeSnapshot(world, new Float32Array(buffer));
    (self as DedicatedWorkerGlobalScope).postMessage({ type: 'snap', tick: world.clock.tick, count, buffer }, [buffer]);
  }
};

// main.ts — dois instantâneos vivos; o mais velho volta ao worker sem cópia
let older: Float32Array | null = null, newer: Float32Array | null = null;
sim.onmessage = (e) => {
  if (older) sim.postMessage({ type: 'return', buffer: older.buffer }, [older.buffer]);
  older = newer;
  newer = new Float32Array(e.data.buffer);
};
// no quadro: x = older[s*8] + (newer[s*8] - older[s*8]) * alpha, etc.
```

Com isolamento entre origens (4.10) os instantâneos podem ficar num
`SharedArrayBuffer` triplo, trocado por um índice atômico, sem mensagens.

- **Gargalo:** a simulação disputa a thread com o desenho e a edição.
- **Custo:** alto: (1) protocolo de comandos de edição (o diário
  `world/changes.ts` e o `mutateBuilt` são o ponto de corte); (2) o que o
  desenho hoje lê direto do `SimWorld` (pose dos veículos, portas, pedestres,
  semáforos, `crossingStates`) vira instantâneo; (3) ferramentas que perguntam
  ao `sim` (inspetor, Ações) viram mensagens.
- **Visual:** igual (interpolação já existe); um quadro a mais de latência na
  simulação, invisível a 60 Hz.
- **Medida:** CPU da thread principal por quadro com 400/400 e 1 000/1 000;
  p99 do intervalo entre quadros durante edições.

### 4.7 Trânsito mesoscópico longe da vista

```ts
/** Trecho de faixa fora da região detalhada: só uma fila (SUMO meso [F11]). */
interface MesoLane { length: number; vFree: number; head: number; size: number; lastExit: number; slots: Int32Array }
const HEADWAY = 1.8;                                  // s entre saídas (capacidade ~2 000 veíc/h)

function enter(l: MesoLane, v: number, now: number, exitAt: Float64Array): void {
  exitAt[v] = Math.max(now + l.length / l.vFree, l.lastExit + HEADWAY);
  l.lastExit = exitAt[v]!;
  l.slots[(l.head + l.size++) % l.slots.length] = v;
}
function drain(l: MesoLane, now: number, exitAt: Float64Array, next: (v: number) => MesoLane | null): void {
  while (l.size > 0) {
    const v = l.slots[l.head]!;
    const to = next(v);
    if (exitAt[v]! > now || (to && to.size >= to.slots.length)) break; // ainda viajando, ou sem espaço adiante
    l.head = (l.head + 1) % l.slots.length; l.size--;
    if (to) enter(to, v, now, exitAt);
  }
}
```

O veículo que entra na região detalhada ganha posição contínua no fim da fila
(ordem preservada) e passa ao modelo completo; o que sai vira item de fila.
Semáforos fora da região viram uma penalidade de tempo, como o
`--meso-tls-penalty` do SUMO [F11].

- **Gargalo:** custo por veículo longe da vista.
- **Custo:** médio (o modelo é simples; o difícil são as transições e a
  calibração, 10.6). **Visual:** nenhum fora da vista; na borda, a entrada na
  região detalhada precisa nascer sem salto (o jogo já sabe inserir veículos
  "como o SUMO", P100).
- **Medida:** µs por veículo meso, fluxo por trecho contra o micro.

### 4.8 Semáforos e controladores que dormem

Hoje cada passo ordena todos os cruzamentos e avança cada controlador
(`sim/world.ts:337-339`, `sim/pipeline.ts:82-87`): 1,7 ms por passo numa
grade de 1 369 cruzamentos **[MEDIDO-AQUI]**. Um controlador sem demanda pode
dormir até o próximo evento (fim do verde mínimo, chegada de veículo ao
detector), como as entidades da Factorio [F4, F7]:

```ts
// fila de eventos por instante (core/heap.ts já existe no projeto)
const wake = new MinHeap<{ at: number; node: number }>((a, b) => a.at - b.at);
function stepSignals(w: SimWorld, now: number): void {
  while (wake.size && wake.peek()!.at <= now) {
    const { node } = wake.pop()!;
    const next = stepController(w.controllers.get(node)!, w.deps);  // devolve quando precisa acordar
    if (next !== null) wake.push({ at: next, node });
  }
}
// um veículo que entra numa faixa de aproximação acorda o controlador do nó: wake.push({ at: now, node })
```

Para o tempo fixo, a fase em qualquer instante é calculável (`seekFixed` já
existe), então o controlador só precisa acordar nas trocas de fase.

- **Custo:** baixo-médio (o controlador passa a dizer quando precisa acordar;
  os specs de sinais protegem o comportamento). **Visual:** nenhum.
- **Medida:** estágio "1 signals" da sonda B2 em 6×6 e 36×36.

### 4.9 Um pool de workers e um orçamento por quadro que se adapta

```ts
// Um pool para o jogo inteiro; o resto dos núcleos fica para o processo da GPU,
// o compositor e o sistema. Com 24 threads: 6 workers.
const WORKERS = Math.max(2, Math.min(6, (navigator.hardwareConcurrency || 4) - 4));
type Priority = 0 | 1 | 2;           // 0 edição em curso, 1 streaming perto da vista, 2 fundo (bakes)
interface Job { key: string; priority: Priority; run: (w: Worker) => Promise<void> }
// Fila por prioridade; um job com a mesma `key` substitui o pendente (a edição seguinte cancela a anterior).

// Orçamento das fatias na thread principal: o que sobra do quadro, não 10 ms fixos.
function sliceBudget(targetMs: number, lastSimMs: number, lastDrawCpuMs: number): number {
  return Math.min(8, Math.max(1, targetMs - lastSimMs - lastDrawCpuMs - 2)); // 2 ms de folga
}
```

- **Gargalo:** workers demais competindo (hoje pools independentes) e cota fixa
  de 10 ms que estoura o quadro.
- **Efeito colateral a vigiar:** mais threads não é mais rápido quando o
  trabalho é limitado pela memória (Factorio [F7]); medir CPU total, não só o
  quadro. No i9 híbrido com Windows 10, workers podem cair em núcleos E [F68].
- **Medida:** p99 do intervalo durante edições; CPU total do processo.

### 4.10 Isolamento entre origens (para `SharedArrayBuffer`)

```ts
// vite.config.ts (dev e preview) — hoje só há 'Document-Policy'
const isolation = { 'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'require-corp' };
server: { headers: { 'Document-Policy': 'js-profiling', ...isolation } },
preview: { headers: isolation },

// desktop/main.cjs — no protocol.handle('app', …) que já existe
const response = await net.fetch(fileUrl);
const headers = new Headers(response.headers);
headers.set('Cross-Origin-Opener-Policy', 'same-origin');
headers.set('Cross-Origin-Embedder-Policy', 'require-corp');
return new Response(response.body, { status: response.status, headers });
```

Antes de exigir, usar `Cross-Origin-Embedder-Policy-Report-Only` e conferir
`self.crossOriginIsolated` [F52]; todos os recursos são da mesma origem hoje, o
que torna a mudança de baixo risco. Também libera
`performance.measureUserAgentSpecificMemory()` para o portão [F62].

### 4.11 Resolução dinâmica antes de trocar de nível

O governador atual troca de nível inteiro (sombras, grama, pós) pela mediana
do quadro (`render/quality.ts:210-260`). Escala de resolução muda só o custo de
preenchimento, sem recompilar nada [F69]:

```ts
// alvo de GPU para 59 Hz com folga: 13 ms. Passos de 5%, 2 s de espera entre passos.
let scale = 1;
function governResolution(gpuP90: number, now: number): void {
  if (now - lastChange < 2000) return;
  const next = gpuP90 > 13 ? scale - 0.05 : gpuP90 < 10 ? scale + 0.05 : scale;
  if (next === scale) return;
  scale = Math.min(1, Math.max(0.6, next));
  lastChange = now;
  // Sem realocar alvos: desenhar num retângulo do alvo de tamanho máximo
  // (setViewport/setScissor) e ampliar no passe final; ou setPixelRatio em passos raros.
}
```

- **Gargalo:** preenchimento (pós-processamento a 2560×1080, nuvens, SSAO).
- **Visual:** imagem um pouco mais macia em cenas pesadas, em vez de perder
  sombra e grama inteiras. **Custo:** baixo-médio (a cadeia de pós usa vários
  alvos, `postprocess.ts`). **Medida:** GPU p95 e número de trocas de nível.

### 4.12 Texturas comprimidas

```ts
import { KTX2Loader } from 'three/examples/jsm/loaders/KTX2Loader.js';
const ktx2 = new KTX2Loader().setTranscoderPath('/basis/').detectSupport(renderer);
const skin = await ktx2.loadAsync('/models/people/skins/skin-03.ktx2'); // gerado offline (toktx/basisu)
```

Vale para as texturas que vêm prontas (as 1 023 WebP de `public/`, sobretudo
peles e roupas de 2048²); as texturas assadas em canvas no jogo (46 usos de
`CanvasTexture`) continuam RGBA8.

- **Gargalo:** VRAM e banda de textura. **Compatibilidade:** `KTX2Loader`
  transcodifica para o formato que a placa aceita (BC no desktop) [F38].
- **Visual:** UASTC para normais e máscaras, ETC1S só para cor sem detalhe
  fino; comparar fotos de perto. **Custo:** baixo no código, médio no pipeline
  de assets (o cozimento de pessoas teria de emitir KTX2).
- **Medida:** soma de bytes de textura (anexo B, item B4) antes e depois, e
  tempo de transcodificação no primeiro uso.

---

## 5. Diagnóstico do projeto

### 5.0 Arquitetura e caminho de um quadro (ramo `planeta-esfera`)

```
main.ts (raiz de composição, 4 682 linhas)
 ├─ RoadDoc (world/doc.ts)  ── documento único, global, coordenadas do atlas
 ├─ Network (world/network.ts) ── rede derivada (incremental desde PV1)
 ├─ SimWorld (sim/world.ts) ── grafo de faixas, conflitos, sinais, agentes
 ├─ SceneHandle (render/renderer.ts, createSceneRenderer, 3 829 linhas)
 └─ workers: luz do terreno (2), ecologia, chão plano, superfícies, LOD de pessoas,
            cozimento de corpos (até 6), roupas, fratura (até 4)

frame(now)  [main.ts:3060-3166, uma thread]
  gameState.flush → câmera/voo → growCity
  → TopologyCatchUp.step  (fatias de 6 ms; 250 ms na carga; simulação parada)
  → sim.clock.advance(step) (DT 1/60 s, até 5 passos por quadro, × velocidade)
  → net.rebuild() se doc.revision mudou
  → buildings.beforeDraw → plano de postes
  → scene.draw: terrain.update → rebuildWorld (job fatiado) → pumpWorld
       → prédios, muros, transporte, jardins, varreduras de natureza
       → LOD de árvores → varredura de shaders novos → agents.sync → post.render
  → sobreposição 2D, bússola, painéis (a cada 0,4 s)
setInterval: crescimento de zona (500 ms, main.ts:3018), desgaste (3 s, main.ts:4648)
```

O desenho já é sob demanda (`frameLoop.ts`) e a carga de mapa é escondida atrás
de uma cortina com fatias maiores. O projeto tem um diário de mudanças com
retângulos (`world/changes.ts`) que muitos derivados já usam para refazer só o
que mudou — esse é o embrião da partição recomendada.

### 5.1 A simulação custa mais quanto maior o mapa, mesmo com a mesma população

| | |
|---|---|
| **Onde** | `sim/pipeline.ts` `step` e os estágios; `sim/world.ts` |
| **Evidência [MEDIDO-AQUI]** | Grades fechadas de vias locais de mão dupla, quarteirão de 120 m, 400 carros e 400 pessoas, 600 passos medidos um a um (anexo B1): |

| Grade | Lado | Trechos | Cruzamentos | p50 por passo | p95 | p99 |
|---|---|---|---|---|---|---|
| 6×6 | 0,72 km | 84 | 49 | 3,3 ms | 5,5 ms | 9,1 ms |
| 12×12 | 1,44 km | 312 | 169 | 4,9 ms | 7,8 ms | 10,7 ms |
| 24×24 | 2,88 km | 1 200 | 625 | 7,4 ms | 11,8 ms | 15,2 ms |
| 36×36 | 4,32 km | 2 664 | 1 369 | 9,7 ms | 12,8 ms | 14,8 ms |
| 12×12, 1 000/1 000 | 1,44 km | 312 | 169 | 14,3 ms | 18,2 ms | 21,4 ms |
| 24×24, 1 000/1 000 | 2,88 km | 1 200 | 625 | 21,6 ms | 27,0 ms | 28,8 ms |
| 36×36, 1 000/1 000 | 4,32 km | 2 664 | 1 369 | 23,9 ms | 29,1 ms | 32,1 ms |

Por estágio, mesma população, 6×6 contra 36×36 (anexo B2):

| Estágio | 6×6 | 36×36 | Por que cresce |
|---|---|---|---|
| 1 semáforos | 0,05 | 1,74 | todos os 1 225 controladores com sinal avançam a cada passo, depois de ordenar todos os cruzamentos (`world.ts:337-339`, `pipeline.ts:82-87`) |
| 2 despacho + rotas | 0,19 | 1,28 | `entryLanes` percorre e ordena todas as 20 876 faixas a cada passo, criando a entrada de cada uma em `runtime` (`vehicles/spawn.ts:57-64`); `trafficTarget` soma todas as fitas da rede a cada chamada, várias por passo (`:43-54`); rotas maiores (Dijkstra sem heurística, `drive/tactical.ts:120-168`) |
| 3 pedestres | 0,66 | 1,27 | grafo e grades maiores |
| 4 restrições | 0,52 | 1,53 | hipótese: mapas e `Map` maiores, mais faltas de cache |
| 5 admissão | 0,98 | 1,62 | idem |
| 6 integração | 0,51 | 1,13 | idem |
| 7 limpeza | 0,18 | 0,86 | `collectGhosts` copia e percorre as 20 876 faixas a cada passo (`pipeline.ts:196-206`, `[...w.runtime]`) |
| **total** | **3,27** | **9,85** | |

| | |
|---|---|
| **Mecanismo** | Trabalho por passo proporcional ao mapa, não aos agentes: laços sobre todos os cruzamentos, faixas e controladores; dependências do sinal refeitas a cada passo como fechamentos e `Map` novos (`world.ts:513-591`); `busNear` percorre a frota inteira a cada pergunta (`world.ts:647-657`); chaves de texto e `Map<string,…>` no caminho quente |
| **Impacto** | A 4× (4 passos por quadro), o mapa de 4,3 km gasta ~39 ms por quadro só de simulação; o de 1,4 km com 1 000/1 000 gasta ~57 ms. O portão mede 3,6-4,7 ms (p95) numa cidade gerada pequena **[MEDIDO-EQUIPE]** — por isso não viu |
| **Solução** | (1) "Fazer menos" primeiro: controladores que dormem até o próximo evento (4.8); limpeza de faixas fantasmas só quando a topologia muda; entradas do mapa (`entryLanes`) e comprimento total da rede (`trafficTarget`) guardados por revisão da topologia; ordem dos cruzamentos guardada por revisão; dependências do sinal construídas uma vez por revisão; `busNear` por faixa de aproximação. (2) Ids inteiros e arrays tipados nos campos quentes (faixa, `s`, `v`, ordem na faixa). (3) LOD de simulação (5.3, 4.7). (4) Simulação em worker (4.6). Alternativa descartada: só paralelizar estágios (seção 7) |
| **Validação** | A sonda B1/B2 vira um teste de escala (9.4): passo p50 na grade 36×36 ≤ 1,3 × o da 6×6 com a mesma população; estágio de semáforos ≤ 0,2 ms com 1 369 cruzamentos ociosos |

### 5.2 Uma edição refaz o mapa inteiro

| | |
|---|---|
| **Onde** | `sim/world.ts` `prepareVehicleTopology`/`rebuildVehicleTopology`/`walkTopologySteps`; `world/lanelets.ts:220-243` (`buildSteps` limpa e refaz tudo, com cache por chave); `world/lanelets.ts:246` (ordena todos os trechos) e `:330-338` (chave com digest da polilinha inteira, recalculada por trecho a cada edição); `render/renderer.ts:1894` (`buildScenery` do mapa todo a cada via), `:1909` e `:1914` (listas de todos os postes e de todo o paisagismo a cada edição); `main.ts:1198-1213` (documento serializado antes e depois, e comparado como texto) |
| **Evidência [MEDIDO-AQUI]** | Via isolada de 100 m desenhada fora da grade (não toca nada), mediana de 3 (anexo B1): |

| Grade | `commitDraft` | `net.rebuild` | preparo da topologia (fatiado) | troca (um quadro) | rede de pedestres (fatiada) | topologia ao abrir sem cache |
|---|---|---|---|---|---|---|
| 0,72 km | 7,5 ms | 1,1 ms | 55 ms | 24 ms | 11 ms | 1,7 s |
| 1,44 km | 7,2 ms | 1,7 ms | 218 ms | 78 ms | 48 ms | 6,4 s |
| 2,88 km | 40,5 ms | 13,3 ms | 1 731 ms | 226 ms | 273 ms | 24,9 s |
| 4,32 km | 62,8 ms | 13,8 ms | 6 812 ms | 458 ms | 1 350 ms | 47,7 s |

| | |
|---|---|
| **Evidência [MEDIDO-EQUIPE]** | No mapa do jogador: clique da via 65-112 ms, mundo refeito 287-370 ms, rede elétrica 68-86 ms, cópia do mapa no commit ~90 ms (`docs/PLANO.md` P7.7, PL29). Cidade gerada de 1 530 prédios, documento de 12,7 MB (PA-U1) |
| **Mecanismo** | Os derivados guardam caches por chave, mas a *passada* que monta as chaves e decide o que reaproveitar é global: percorre todos os trechos, cruzamentos, postes e itens a cada edição. Com caches, o custo por item é pequeno; multiplicado pelo mapa, deixa de ser. Durante o preparo fatiado, o trânsito fica parado (`frameLoop.ts:138-182`): 6,8 s de trânsito parado por via no mapa de 4,3 km |
| **Impacto** | Em mapas como os do planeta e do plano completo (dezenas de km de vias), cada edição vira segundos de trânsito parado e um quadro de centenas de ms. A regra "custo por edição proporcional ao que mudou" não vale fora da rede viária (que o PV1 já fez incremental) |
| **Solução** | Partição única (seção 6): cada derivado por célula, com chave das entradas da célula e do halo; a edição suja células pelo diário; só as células sujas reconstroem, em worker. Grafo de faixas e conflitos por cruzamento já têm cache por chave: falta só não percorrer o resto. Desfazer por comando/delta (5.11) |
| **Validação** | Teste de escala da edição (9.4): contadores de trabalho (trechos e cruzamentos visitados por edição) iguais no mapa de 0,7 km e no de 4,3 km para a mesma via isolada; troca da topologia ≤ 8 ms num quadro |

### 5.3 População e nível de detalhe da simulação

| | |
|---|---|
| **Onde** | `editor/persistence.ts:459-460` (400/400 no painel), `sim/params.ts:185-186` (tetos 1 200/1 000, também tamanho dos buffers de instância), `sim/agents/walk.ts:368-372` (`COARSE`: pedestre fora da vista dá um passo a cada 4 e não negocia com os outros), nenhum equivalente para veículos |
| **Evidência** | **[CÓDIGO]** todos os veículos rodam IDM, troca de faixa, admissão e integração a cada 1/60 s, vistos ou não. **[MEDIDO-AQUI]** 1 000/1 000 numa grade de 2,9 km: 21,6 ms por passo |
| **Mecanismo** | Sem níveis de simulação para veículos, o custo é agentes × passos × (custo por agente + parte global) |
| **Impacto** | Num mapa de centenas de km² não cabe uma cidade viva com população visível em toda parte; o teto de 400 carros espalhados por 183 km² deixa o mundo vazio longe da câmera |
| **Solução** | Três níveis por região (3.5): micro completo na região vista + margem; micro com passo de 0,25-0,5 s numa faixa intermediária (o IDM aceita, [F14]); filas mesoscópicas no resto (4.7). Sem teto fixo de população: o limite é o que o hardware sustenta a 4× dentro do orçamento do quadro, descoberto e empurrado para cima a cada fase (o Cities: Skylines II declara não ter limite rígido de agentes [F3]). O nível de detalhe decide quem é simulado em detalhe completo (o que está na vista, quantos o orçamento permitir), não quantos existem. Pedestres: o `COARSE` atual é o começo certo; acrescentar "agregado" (contagens por calçada) para quem está longe |
| **Validação** | Mesmo comportamento observável na região vista (o `defects.spec` e o fuzz rodam com e sem LOD); fluxo médio por trecho no meso dentro de ±10% do micro num mapa de teste (calibração como o SUMO faz); custo por agente meso < 1/20 do micro |

### 5.4 Thread principal e concorrência

| | |
|---|---|
| **Onde** | `main.ts:3060-3166` (tudo no quadro), `main.ts:3018` e `:4648` (`setInterval` com trabalho de mapa inteiro fora do orçamento), `core/frameWork.ts:10` (cota fixa de 10 ms), `render/bakePool.ts:15` (até 6 workers), `render/destruction.ts:105` (até 4), `render/terrainLightPool.ts:19` (2), mais 6 workers avulsos; `vite.config.ts:59` (sem COOP/COEP) |
| **Evidência [CÓDIGO]** | Simulação, rede, topologia, derivados, prédios e desenho na mesma thread. Pools independentes podem somar 15+ workers num pico (bombas + pessoas chegando + luz) |
| **Mecanismo** | A cota fixa de 10 ms se soma à simulação (3-5 ms) e ao desenho (8-10 ms de CPU no portão): durante edições, quadros de 20-25 ms são esperados por construção. Workers demais disputam os núcleos P com a thread principal e o processo da GPU; no Windows 10 sem Thread Director isso aparece como variação [F68] |
| **Impacto** | Fluidez durante construção e demolição; nenhuma margem para população maior |
| **Solução** | Um pool só, com prioridades e cancelamento por chave (4.9); orçamento das fatias calculado pelo que sobra do quadro; simulação num worker dedicado (4.6); derivados por célula em workers com resultados transferíveis; `setInterval` de crescimento e desgaste dentro do orçamento do quadro; depois COOP/COEP (4.10) para memória compartilhada |
| **Validação** | Uso de CPU por thread (perfil do Chrome) e p99 do intervalo de quadros durante 10 edições seguidas; CPU total gasta não pode subir mais que o tempo economizado (lição da Factorio [F7]) |

### 5.5 Terreno: dois níveis e peças presas

| | |
|---|---|
| **Onde** | `render/planet/terrainAtlas.ts:50-56` (peça com qualquer coisa do documento fica carregada para sempre), `:69` (`CACHE` 8), `:76` (`NEAR_MOST` 24); `render/flatAtlas.ts:43-47` (`CACHE` 6, `NEAR_MOST` 9), `:97` (malha distante de 32×32 por placa = 60 m); `render/terrain.ts:84` (300 segmentos por placa plana), `:1304-1322` (arrays e texturas de dados por placa), `:2411-2415` (posições, normais, uv, cor e `aBelow` em float32) |
| **Evidência [CÓDIGO]** | Placa plana: 301² = 90 601 cantos; cada array por canto ocupa 362 KB (float32), e são vários (seis só em `:1304-1311`) mais a geometria (~4,3 MB de atributos) e texturas de dados (a de margem RGBA float, 1,45 MB; pintura 1024² RGBA8, 4 MB). Peça do planeta: 81² cantos (512 m), bem menor. **[MEDIDO-EQUIPE]** o atlas já precisou cortar ~4 GB de vídeo e metade da memória de pintura (commits `348a60f1`, `1177d0c7`); no plano, a malha da placa feita no worker baixou o `update` de 70-156 para ~6 ms (PL40) |
| **Mecanismo** | Cada placa é uma superfície completa e única; o detalhe salta de 6,4 m para 60 m; a regra "peça com conteúdo nunca sai" faz a memória crescer com a área construída |
| **Impacto [HIPÓTESE]** | Uma cidade espalhada por dezenas de peças/placas mantém todas carregadas em detalhe máximo, com VRAM e heap proporcionais; a vista de cima desenha placas inteiras onde 60 m bastaria. Precisa de medida (10.2) |
| **Solução** | CDLOD por peça/placa (4.3): grade compartilhada, páginas de altura por nó com LRU por bytes, separar "tem conteúdo" (guardado em disco/IndexedDB) de "carregado" (só perto da vista). A água, as margens e a pintura viram páginas do mesmo esquema |
| **Validação** | Bytes de GPU e heap por km² construído (cidade de 20 placas) antes/depois; vértices desenhados na vista alta; ausência de degrau (spec das emendas, como `terrainSeam.spec`) |

### 5.6 Precisão das coordenadas

| | |
|---|---|
| **Onde** | `world/planet/atlas.ts:25-34` (atlas de 36 × 24 células de 960 m: ±17,3 km), `world/flatEarth.ts` (mundo plano de 24,96 × 13,44 km: ±12,5 km), `render/planet/bend.ts:533-552` (o movimento rígido põe o ponto olhado na sua posição absoluta no atlas: câmera em coordenadas absolutas), `bend.ts:203-209` (`planetView` desfaz a câmera e refaz a posição absoluta no shader) |
| **Evidência [CÓDIGO]** | Vértices, câmera e a dobra em float32 absoluto. Passo do float32: ~1 mm entre 8 e 16 km, ~2 mm entre 16 e 33 km [F23]. O PL3 já teve de corrigir "cacos" perto da âncora por precisão |
| **Impacto** | Hoje aceitável (1-2 mm); a cada dobro do mundo o passo dobra; na rua, 2 mm a 2 m do olho é ~1 px numa tela de 1080 px **[HIPÓTESE]**; impede mundos maiores sem retrabalho |
| **Solução** | RTC por célula (4.2); a dobra do planeta recebe a peça e a origem por objeto em vez de deduzi-las de coordenadas absolutas |
| **Validação** | Sonda de tremor (4.2) na borda e no centro do atlas |

### 5.7 A dobra do planeta no vertex shader

| | |
|---|---|
| **Onde** | `render/planet/bend.ts:58-210` (GLSL) e `:219-266` (remendo global dos chunks do three: `project_vertex`, `worldpos_vertex`, `defaultnormal_vertex`, `lights_fragment_begin`) |
| **Evidência [CÓDIGO]** | Por vértice, em todo material e também na passada de sombra: `planetTile` (divisões e `floor`), `planetTileFrame` (2 `tan`, 2 `normalize`, `cross`), `planetDirection` (`cos`, `sin`), e com curvatura < 1 `planetFromAnchor` (`atan`, 2 `length`); isso roda em `worldpos_vertex` e de novo em `project_vertex` (via `planetView`, que também multiplica pela transposta da vista), e mais duas vezes na normal (`planetTurn`) e na tangente. Com 12,16 M de triângulos por quadro na rua (portão **[MEDIDO-EQUIPE]**), são dezenas de milhões de avaliações por quadro |
| **Mecanismo** | Escolha de projeto legítima (a curvatura `k` muda com a altura do olho, então a geometria não pode ser dobrada uma vez na CPU), mas o trabalho repetido por vértice não depende do vértice: a peça e seus eixos são os mesmos para todo o objeto |
| **Impacto [HIPÓTESE]** | Custo de GPU de vértice relevante na RTX nas vistas com muitos triângulos; não medido (a medida da seção 5.10 ficou pendente) |
| **Solução** | Eixos da peça por objeto (uniformes) e posição local à célula (4.2), calcular a posição dobrada uma vez em `worldpos_vertex` e reaproveitá-la em `project_vertex`; objetos pequenos (carros, pessoas, mobiliário) podem ser posicionados rigidamente pela CPU (a flecha de um carro de 10 m numa esfera de 3,8 km é ~3 mm) e pular a dobra por vértice |
| **Validação** | Tempo de GPU (4.1) da mesma vista no build do planeta e no plano, e com/sem a mudança; fotos lado a lado (diferença de pixels) |

### 5.8 Desenho: draw calls, triângulos, culling

| | |
|---|---|
| **Evidência [MEDIDO-EQUIPE]** | Rua no planeta com cidade gerada e 400/400: 519-542 draw calls, 12,16 M triângulos (sombras incluídas), CPU do desenho 8,5-9,9 ms p95 na iGPU (`perfBudget.ts:84-95`). No `master`, RTX 1280×720, 256 pedestres e 400 carros: quadro de GPU 6,4 ms, sombra do sol 0,10 ms, cena 1,47 ms, cada passe de pós ≤ 0,40 ms (P9). Placas de sinalização: +237 draw calls antes do atlas delas (PA-S1). **[MEDIDO-AQUI]** planeta vazio visto de cima: 84 draw calls, 2,33 M triângulos |
| **Evidência [CÓDIGO]** | 51 objetos com `frustumCulled = false` (instâncias e o que a dobra move); culling do planeta por esfera envolvente de cada objeto levada à esfera e teste de horizonte (`bend.ts:277-297`), bom; agentes: pose e altura de todo veículo antes do teste de visibilidade e teto pela ordem do id (`agents.ts:1989-2004`); `new Set` por quadro (`agents.ts:2202`); ~150 `InstancedMesh` de peças de veículo (vazias já ficam invisíveis, P42) |
| **Mecanismo** | Instâncias sem culling por instância: um `InstancedMesh` com uma árvore na tela desenha todas as do mapa; agentes custam CPU por existirem, não por aparecerem |
| **Impacto** | Hoje controlado (o portão está dentro do orçamento); cresce com a área construída e a população |
| **Solução** | Instâncias por célula (ou `InstancedMesh2` com BVH [F34]); culling de agentes por célula e teto pelos mais próximos (4.5); HLOD por célula (4.4); LOD de sombra (casters pequenos param de projetar sombra cedo, lição de [F1]) |
| **Validação** | Draw calls e triângulos nos cenários alto/globo com cidade grande; CPU do `sync` dos agentes com 1 000 veículos, 90% fora da vista |

### 5.9 Memória e assets

| | |
|---|---|
| **Evidência [MEDIDO-AQUI]** | Planeta **vazio** (5178, painel, Chrome 152): heap JS 627 MB ao abrir, 685 MB depois de 10 s; 147 programas de shader; 191 texturas; 88 geometrias |
| **Evidência [MEDIDO-EQUIPE]** | Com a cidade do portão: heap 1 320-1 368 MB; alocação 168-176 MB/s; coletor 1% da thread (`perfBudget.ts:84-95`). PL26: alocação 216 → 189 MB/s |
| **Evidência [CÓDIGO]** | Nenhum `KTX2Loader` nem decodificador de meshopt; 1 023 WebP em `public/` (342 MB) descompactadas em RGBA8; 46 `CanvasTexture` assadas no jogo; desfazer com teto de 96 MB de texto (`editor/history.ts:31`); arrays por placa em float64/float32 (5.5) |
| **Mecanismo** | Sem orçamento de memória por sistema nem contabilidade de bytes de GPU (o three só conta objetos) |
| **Impacto [HIPÓTESE]** | 627 MB num planeta vazio sugere dados do mundo inteiro carregados (atlas de 864 peças, relevo, ecologia, cozimentos de pessoas); precisa de instantâneo de heap para atribuir |
| **Solução** | Contabilidade de bytes por sistema (geometria, textura, arrays) e teto por LRU, como o `lruCache` em bytes do 3DTilesRendererJS [F36]; KTX2 para peles e roupas [F38]; quantização dos atributos de terreno e prédios (posições locais em `Int16` normalizado por célula, normais oct-encoded) [F39] |
| **Validação** | Instantâneo de heap (DevTools) e soma de bytes de GPU (anexo B4) em três momentos: planeta vazio, cidade, depois de 30 min jogando (vazamento) |

### 5.10 GPU na RTX: medida não concluída

**NÃO MEDIDO na RTX.** O painel do navegador ficou escondido durante este
trabalho. Escondido, o painel limita os quadros a ~1 por segundo, a GPU baixa
o clock e o tempo de GPU sai inflado: medi 52,7 ms (p50) por quadro no planeta
vazio, valor que **não** representa o jogo (anexo B3). O procedimento para a
medida válida está no item 10.1.

### 5.11 Desfazer, autosave e tamanho do documento

| | |
|---|---|
| **Onde** | `main.ts:1183-1213`, `editor/history.ts:13-60`, `world/doc.ts:1490-1500` (`toText`), `editor/persistence.ts` (IndexedDB para mapas grandes) |
| **Evidência** | **[CÓDIGO]** cada edição: texto do documento antes (em cache por revisões), a edição, o texto depois (`docText = null`, nova serialização) e a comparação de dois textos do tamanho do mapa; o desfazer guarda o texto inteiro. **[MEDIDO-EQUIPE]** ~90 ms de "clone do mapa" por via no mapa do jogador; documento de 12,7 MB numa cidade gerada |
| **Mecanismo** | O(documento) por edição, duas vezes; com 96 MB de teto, poucos passos de desfazer em mapas grandes |
| **Solução** | Edição como comando com inverso (ou delta por registro, que o diário de mudanças já quase descreve); autosave por célula suja; texto do documento inteiro só ao exportar |
| **Validação** | ms por edição e bytes do desfazer por passo, iguais num mapa de 3 MB e num de 30 MB |

### 5.12 Rotas

| | |
|---|---|
| **Onde** | `sim/drive/tactical.ts:120-168` (`planTrip`), `sim/routing/router.ts:221-305` (busca local de 5 níveis com `Set` compartilhado), `sim/routing/destination.ts:105` |
| **Evidência [CÓDIGO]** | Dijkstra sem heurística sobre o grafo de faixas, com chaves de texto em `Map` e heap de objetos; chamado no nascimento, na extensão e no replanejamento. **[MEDIDO-AQUI]** o estágio de despacho e rotas sobe de 0,19 para 1,28 ms por passo entre os mapas de 0,7 e 4,3 km |
| **Solução** | A* com heurística admissível (distância / maior limite de velocidade), ids inteiros e arrays tipados; cache de rota por (célula de origem, destino) com validade pela revisão; para redes grandes, hierarquia por células (portais entre células, como [F12]) e, se preciso, CRP [F13]; pedidos de rota numa fila com orçamento por passo |
| **Validação** | Nós visitados por rota e ms por rota na grade 36×36; mesma rota (ou custo igual) que o Dijkstra atual num conjunto de pares de teste |

### 5.13 Qualidade e governador

| | |
|---|---|
| **Onde** | `render/quality.ts:78-189` (níveis; Alto com `pixelRatio` 1,5) e `:210-260` (governador pela mediana) |
| **Evidência [CÓDIGO]** | Troca de nível inteiro (sombras, grama, pós, vegetação), que recompila e refaz a vegetação (`renderer.ts:2100-2113`, `networkRevision = -1`); sem escala de resolução |
| **Solução** | Escala de resolução dinâmica pelo tempo de GPU (4.11) como primeira alavanca; nível só por escolha do jogador ou queda prolongada |
| **Validação** | Nenhuma troca de nível em 10 min de jogo normal na RTX; GPU p95 dentro do alvo com a escala ativa |

### 5.14 Proteção atual contra regressões

| | |
|---|---|
| **Onde** | `src/core/perfBudget.ts` (tabelas e catraca), `tests/perf/budgets.spec.ts`, `tests/planet/perfBudgets.spec.ts`, `scripts/perf-gate.mjs`, `core/health.ts:220-246` |
| **Evidência [CÓDIGO]** | Bom: orçamentos únicos, catraca, pisos de detalhe, contagens exatas nos specs, aviso no F9. Falta: o portão roda **uma** vez, numa cena, 8 s, na iGPU sem interface; mede p95 da CPU do quadro (`frameStats` só tem p50/p95/máx), não o intervalo entre quadros, nem p99, nem GPU; não há cenário de mapa grande, de viagem rápida, de carga longa, nem do modo plano; o ruído da máquina compartilhada não é controlado (a equipe já viu 1,7× entre rodadas iguais, P70) |
| **Solução** | Seção 9 |

### 5.15 Plano e planeta: um mundo, duas formas de ver

**Decisão do jogador (2026-10-11):** é um único mundo. O modo plano mostra as
coisas planas e o planeta as mostra na esfera; tudo que se faz num aparece no
outro.

| | |
|---|---|
| **Onde** | `world/flatEarth.ts` (projeção equirretangular, documento próprio do modo plano), `docs/PLANO.md` item 10 ("cada modo guarda seus mapas"), `render/planet/bend.ts` (curvatura `k` de 0 a 1) |
| **Evidência [CÓDIGO]** | Hoje os dois modos têm documentos separados, e o plano usa a projeção equirretangular, que estica leste-oeste por 1/cos(latitude) (1,41× a 45°): a mesma cidade não teria as mesmas medidas nos dois |
| **Solução** | Um documento só, guardado nas cartas do planeta (cada ponto é um ponto da esfera, como o ramo já faz). O modo plano passa a ser o mesmo mundo desenhado com curvatura `k = 0` na dobra que já existe (`bend.ts`): em volta do ponto olhado, as distâncias ao longo do chão são as verdadeiras (mapa azimutal equidistante), então ruas, prédios, carros e pessoas têm as mesmas medidas nos dois modos e a simulação é uma só. A vista inteira do mundo no plano (de muito alto) usa uma projeção global só para o desenho distante, com o detalhe sempre sem distorção perto do ponto olhado. O `flatEarth.ts` e o documento separado do plano saem; mapas planos antigos entram como uma região do mundo, pela migração que o `ESCALA.md` já descreve para unidades |
| **Validação** | A mesma edição feita no plano aparece no planeta e vice-versa (spec com ida e volta); medidas em metros de vias e prédios iguais nos dois modos; troca de modo sem recarregar o mundo nem a simulação; fotos do mesmo lugar nos dois modos |

### 5.16 Carga de mapa e demolição

| | |
|---|---|
| **Evidência [MEDIDO-EQUIPE]** | Abrir uma cidade gerada de 294 vias e 1 530 prédios (documento de 12,7 MB): cidade inteira aos ~13,8 s do clique, CPU 16,9 s, atrás da cortina (PA-U1). Bomba num prédio: quadros de 1-1,5 s com as peças da fratura chegando do worker e subindo à GPU, ainda aberto (PA-U2) |
| **Mecanismo [CÓDIGO]** | A carga monta o mundo inteiro antes de mostrar (decisão do jogador: nada chegando aos pedaços); com mapas do tamanho do planeta, "inteiro" cresce sem limite. Na demolição, o envio à GPU não tem orçamento por quadro |
| **Solução** | Mostrar quando as células perto da vista estão completas e o resto está no nível distante vindo do cache (HLOD guardado no IndexedDB) — a imagem fica inteira, só com menos detalhe longe, e o detalhe chega por células fora da vista; na demolição, envio à GPU com orçamento em bytes por quadro (como `drainUploads` já faz para texturas) e buffers pré-alocados por ruína |
| **Validação** | Cenário K (tempo até mostrar e maior quadro depois) e um cenário de bombas (maior quadro, bytes enviados por quadro) |

### 5.17 O que está alinhado e deve ficar

- Trabalho fatiado com cota e a cortina de carga (`frameLoop.ts`, `revealGate`).
- Diário de mudanças com retângulos (`world/changes.ts`) e derivados que leem
  o diário pela área.
- Cache derivado em IndexedDB por impressão do código (tiles de via, zonas de
  conflito, LOD de pessoas).
- Compilação antecipada (`uploads.ts` `compileAhead`, varredura de variantes em
  `renderer.ts:3219-3265`, `checkShaderErrors` só em desenvolvimento) — segue
  [F37] e [F27].
- `shadowMap.autoUpdate = false` e uma sombra por quadro (`renderer.ts:498-503`).
- Desenho sob demanda e 20 Hz para nuvens sozinhas.
- Culling pelo horizonte no planeta (`bend.ts:337-388`, Cesium [F25]).
- Workers para relevo, malha da placa plana, luz e ecologia, com buffers
  transferidos (PL40).
- Orçamentos em catraca com piso de detalhe.

---

## 6. Arquitetura recomendada

### 6.1 Duas invariantes

1. **O custo de uma edição é proporcional ao que ela muda.** Nada que a edição
   não alcança (pelas células sujas e o halo delas) é visitado.
2. **O custo de um quadro é proporcional ao que se vê e à região simulada em
   detalhe.** O resto do mundo custa por célula, não por objeto, e em níveis
   baratos.

Os dois achados mais caros (5.1 e 5.2) são violações dessas invariantes; as
técnicas de estúdio da seção 2 são formas diferentes de cumpri-las.

### 6.2 A espinha: uma partição única do mundo

```
Carta (peça do planeta, 512 m; placa do plano, 1,92 km)   ← já existe
 └─ quadtree da carta: nível n = carta / 2^n
     ├─ célula de dados  (~250 m: planeta n=1 → 256 m; plano n=3 → 240 m,
     │                     o `BATCH_CELL` que a camada de prédios já usa)
     │    registros donos (via, nó, prédio, lote, poste, item, carimbo) pelo ponto de âncora
     │    derivados por célula + halo: faixas, conflitos, calçadas, superfícies,
     │      cenário, postes, mobiliário, jardins, malhas de prédio, HLOD
     │    região de simulação (micro / micro grosso / meso / agregado)
     │    pedaço de persistência e de desfazer
     └─ nós do terreno (CDLOD) até a célula de 6,4 m
```

- **Cada derivado** tem uma chave por célula feita das entradas que ele lê
  (os registros da célula e do halo) — o que os tiles de via, os cruzamentos e
  as zonas de conflito já fazem, só que hoje a varredura que monta as chaves é
  global.
- **O diário de mudanças** (`world/changes.ts`) passa a produzir a lista de
  células sujas; cada camada consome a lista, não o mapa.
- **Streaming**: uma célula tem estados (nos dados / derivada / na GPU /
  desenhada), com LRU por bytes em cada estado; a câmera e as regiões de
  simulação são as fontes de streaming, como no World Partition [F16].

### 6.3 Fluxo de uma edição

```
gesto → comando (com inverso) → RoadDoc (thread principal)
      → diário: retângulos → células sujas
      → pool de workers (prioridade "edição"): derivados das células sujas
            (faixas+conflitos, calçadas, superfícies, cenário, prédios)
            → buffers transferíveis
      → troca de uma vez no quadro seguinte (o padrão que o jogo já usa)
      → worker da simulação recebe o mesmo comando e refaz a topologia das
        células sujas; os agentes de fora delas nunca param
```

### 6.4 Desenho

- **RTC por célula** (4.2): vértices e instâncias locais à célula; origem de
  desenho em passos de célula; a dobra do planeta recebe a peça por objeto.
- **Terreno CDLOD** por carta (4.3), páginas de altura com LRU por bytes; o
  globo/malha distante continua para o que está além das cartas carregadas.
- **HLOD por célula** (4.4): completo, sem detalhe, casca simplificada,
  caixas/impostores, escolhidos pelo erro na tela.
- **Instâncias por célula** (árvores, mobiliário, carros parados) para o culling
  valer; agentes testados por célula antes de qualquer cálculo (4.5).
- **Sombra**: o mapa único perto da vista (já barato, P9) com casters por
  tamanho na tela (LOD de sombra), a lição de [F1].
- **Medida embutida**: tempo de GPU (4.1) no F9 e no portão; escala de
  resolução (4.11).

### 6.5 Simulação

- **Num worker dedicado**, com réplica do documento por comandos e
  instantâneos interpolados (4.6). A thread principal fica com entrada,
  interface e desenho.
- **Regiões por célula**: micro completo (vista + margem), micro com passo de
  0,25 s (anel seguinte), meso (resto com vias), agregado (células sem ninguém
  olhando há muito). Sem teto fixo de população: o orçamento do quadro decide
  quantos ficam no detalhe completo; a troca de nível é na borda (3.5, 4.7).
- **"Fazer menos"**: controladores que dormem, limpeza só na mudança de
  topologia, ids inteiros, arrays tipados nos campos quentes (5.1).
- **Rotas**: A* com heurística, cache por célula, hierarquia por portais entre
  células; fila de pedidos com orçamento por passo (5.12).
- **Determinismo** preservado: a ordem por id continua dentro de cada região;
  a troca de nível acontece em pontos fixos do passo.

### 6.6 Memória, persistência e desfazer

- Contabilidade de bytes por sistema (CPU e GPU) e tetos com LRU.
- Persistência por célula no IndexedDB (só células sujas são gravadas), texto
  do documento inteiro só ao exportar.
- Desfazer por comandos com inverso; o teto vira número de passos, não bytes
  do mapa.

### 6.7 Por que esta combinação

- **Ataca o que foi medido.** Os custos que crescem com o mapa (5.1, 5.2) só
  somem mudando o domínio de iteração de "o mapa" para "as células" — nenhuma
  troca de API gráfica, linguagem ou número de threads resolve isso sozinha.
- **É o que funciona em produção na mesma classe de problema.** Partição com
  HLOD e streaming (Unreal [F16, F17]), refinamento pelo erro na tela (3D Tiles
  [F18]), terreno CDLOD [F19], "fazer menos" e dormir antes de paralelizar
  (Factorio [F4, F7]), níveis de simulação com teto por nível (Mass [F10], AC
  Unity [F8]), filas para o tráfego distante (SUMO [F11]).
- **Reaproveita o que o projeto já acertou.** O diário com retângulos, os
  caches por chave, as trocas de uma vez, as fatias, os workers com buffers
  transferidos e os orçamentos em catraca são as peças; a partição única só
  faz delas a regra para todas as camadas.
- **Dá margem para a população e o tamanho de mapa que o jogo quer**, sem tirar
  detalhe de perto: o detalhe máximo continua onde o jogador olha.
- **Ordem segura**: cada passo é medível sozinho e pode ser feito por camada,
  com o oráculo "incremental = do zero" que o projeto já usa
  (`tests/world/incrementalRebuild.spec.ts`).

---

## 7. Alternativas descartadas (e por quê)

| Alternativa | Por que não agora |
|---|---|
| **Migrar para `WebGPURenderer`** | Exige portar ~66 shaders próprios, o remendo global da dobra do planeta e o pós-processamento para TSL; o renderizador é experimental e pode ser mais lento em algumas cenas; sem Linux; desenho indireto múltiplo não padronizado [F29, F41, F42]. Os custos medidos estão na CPU e no crescimento com o mapa. Reavaliar depois das fases 1-5, com um protótipo isolado (culling de agentes em compute) |
| **Paralelizar a simulação atual por estágios** | Os dados são objetos JS ligados por `Map` de texto, que não se compartilham entre workers; paralelizar sem arrumar os dados ficou mais lento na Factorio (invalidação de cache) e, quando o gargalo era memória, gastou 30× mais CPU sem ganho [F5, F7]; o determinismo exigiria a fusão ordenada que a Factorio fez [F6]. Primeiro "fazer menos" e níveis de simulação; depois, partições independentes por região |
| **Aumentar a população por força bruta** | Medido: 14-24 ms por passo com 1 000/1 000 (5.1) |
| **Desenhar num worker (`OffscreenCanvas`)** | Tiraria o desenho da thread da interface, mas a simulação e os derivados continuariam lá; entrada e redimensionamento teriam de ser repassados [F56]; ganho incerto e refatoração grande |
| **`BatchedMesh` para prédios e vias** | Já tentado e desfeito no projeto (P29: compilação de 3 s, montagem de 2,8 s, desenho mediano 23-30 ms) **[MEDIDO-EQUIPE]**; regressões abertas no three.js [F31]. Malha fundida por célula e por material é mais simples e previsível |
| **Profundidade logarítmica** | Desliga o early-Z [F27, F33]; o Z invertido é o caminho, quando sombras e SSAO estiverem completos no three [F32] |
| **Z invertido já** | Sombra e SSAO incompletos no WebGL do r186 segundo os mantenedores [F32]; o jogo tem materiais de profundidade próprios. Avaliar na fase 7 |
| **Doubles emulados (RTE alto/baixo) em tudo** | +37,5% por vértice e shaders próprios [F21]; nas escalas do jogo (±17 km) o RTC por célula basta |
| **Texturas virtuais (Far Cry)** | Precisam de passe de retorno, paginação e atlas grandes [F46]; no WebGL sem texturas esparsas o custo de implementação é alto para um ganho que o CDLOD com páginas já dá ao terreno |
| **Geometry clipmaps no planeta** | Centrados no observador em planta; numa esfera de cartas e com LOD que deve considerar a altura do olho, o CDLOD encaixa melhor [F19, F20] |
| **Contraction Hierarchies** | Pré-processo pesado refeito a cada edição; o jogo edita a rede o tempo todo. A* + hierarquia por células, e CRP se for preciso [F13] |
| **Reescrever a simulação em WASM ou num framework ECS** | Reescrita total; o ganho principal vem do layout de dados e de fazer menos, que dá para obter em TypeScript com arrays tipados nos campos quentes [F49]. WASM só para núcleos numéricos fechados, se o perfil pedir |
| **Oclusão na GPU (Hi-Z) no WebGL** | Exige leitura de volta e latência de um quadro; útil sobretudo na rua entre prédios. Primeiro medir sobre-desenho na rua (10.4); se for gargalo, oclusão por software com SIMD em WASM [F45] é candidata |

---

## 8. Ordem de implementação

Impacto e esforço são estimativas de engenharia, não ganhos medidos; cada fase
termina com a medida que diz se valeu.

| Fase | O quê | Impacto esperado | Depende de | Esforço | Risco | Como saber que deu certo |
|---|---|---|---|---|---|---|
| **0** | Medir direito: GPU no portão e no F9 (4.1), intervalo entre quadros p99, cenários de escala (9.3), contabilidade de memória (B4), instantâneo de heap, medida na RTX (10.1) | Sem isso nada abaixo é validável | — | 1-2 semanas | baixo | linha de base gravada por cenário |
| **1** | "Fazer menos" na simulação: semáforos dormindo, limpeza só na mudança de topologia, `entryLanes`/`trafficTarget`/ordem dos cruzamentos/dependências do sinal por revisão, `busNear` por faixa, sem cópias por passo | Passo independente do tamanho do mapa nas partes ociosas (hoje 3,3 → 9,7 ms) | 0 | dias | baixo (specs de sinais, `defects.spec`, fuzz) | sonda B2: estágios 1 e 7 iguais em 6×6 e 36×36 |
| **2** | Mundo único (5.15: um documento nas cartas do planeta; o modo plano é a dobra com curvatura 0) e partição única com derivados por célula: índice de células; faixas, conflitos e calçadas visitando só células sujas; cenário, postes, mobiliário e jardins por célula; desfazer por comando; autosave por célula | Edição proporcional ao que muda (hoje 6,8 s de topologia por via no mapa de 4,3 km) | 0 | semanas | médio (oráculo incremental = do zero por camada) | sonda B1: custo da via isolada igual em todos os tamanhos |
| **3** | Um pool de workers com prioridade; derivados das células em workers com buffers transferíveis; orçamento da fatia pelo que sobra do quadro | Edições sem quadro longo; thread principal livre | 2 | semanas | médio | p99 do intervalo durante 20 edições seguidas |
| **4** | Simulação em worker + níveis (micro, micro grosso, meso, agregado), sem teto fixo de população, rotas com A*/cache/hierarquia | População visível em todo o mapa; thread principal só desenha | 1, 2 | semanas a meses | alto (determinismo, transições) | mesmo `defects.spec` na região vista; fluxo meso dentro de ±10% do micro; CPU principal por quadro |
| **5** | Terreno CDLOD, RTC por célula, HLOD de prédios, instâncias por célula, culling de agentes por célula, dobra do planeta com a peça por objeto | Memória e desenho proporcionais à vista; precisão independente do tamanho | 0, 2 | semanas a meses | alto (terreno tem 4 371 linhas de recursos) | bytes por km², vértices desenhados, GPU na RTX, fotos lado a lado |
| **6** | Memória e assets: KTX2 nas peles e roupas, atributos quantizados, LRU por bytes em cada cache | VRAM e heap menores | 0 | dias a semanas | baixo | soma de bytes (B4) antes/depois |
| **7** | Resolução dinâmica; governador sem troca de nível; LOD de sombra; avaliar Z invertido | Quadro estável na GPU sem perder recursos | 0 | dias | baixo | GPU p95 no alvo; nenhuma troca de nível em 10 min |
| **8** | Isolamento entre origens e `SharedArrayBuffer` para os instantâneos | Menos cópias se a fase 4 mostrar custo de mensagens | 4 | dias | baixo | ms de `postMessage` no perfil |
| depois | Protótipo WebGPU (culling e animação de agentes em compute) | a decidir pela medida | 5 | — | — | GPU e CPU contra o WebGL no mesmo cenário |

A fase 1 é a de melhor relação custo/benefício; a fase 2 é a que destrava o
"mapa enorme" para edição; a 4 destrava "simulação completa" no mapa enorme.

---

## 9. Validação e proteção contra regressões

O mecanismo atual (tabela única em catraca, specs de contagem, portão, aviso no
F9) é a base certa. O que falta é cobrir **escala**, **GPU na RTX**, **ritmo de
quadros** e **ruído estatístico**.

### 9.1 Condições de comparação (fixas e registradas em cada resultado)

| Item | Referência |
|---|---|
| Máquina | i9-12900K, 32 GB, RTX 3060 (driver anotado), Windows 10 19045; plano de energia "alto desempenho" |
| Navegador | painel do aplicativo (Chrome 152 embutido, ANGLE/D3D11 na RTX), **painel visível**; versão anotada |
| Resolução | 2560×1080 a 59 Hz (a do jogador) e 1280×720 (comparável com o histórico); DPR 1 |
| Qualidade | nível fixo "Alto"; governador e escala de resolução desligados na medida |
| Mapas | fixos por semente: cidade gerada pequena (a do portão), cidade grande espalhada por 20+ placas/peças, grade 36×36; planeta e plano |
| População | 400/400 (hoje), 1 000/1 000 (estresse), e depois as metas por nível de simulação |
| Câmera | trajetos gravados (posição, zoom, órbita por tempo), nunca à mão |
| Carga da máquina | `run-limited` (trava de tarefa pesada) e CPU ociosa conferida antes; nenhum outro painel desenhando o jogo |
| Aquecimento | 10 s antes de medir; 60 s por cenário (~3 500 quadros, bastante para o p99; para p99,9 são dezenas de milhares [F63]) |

### 9.2 Métricas

- **Ritmo**: intervalo entre quadros (rAF) p50/p95/p99/máx e número de
  quadros acima de 2× o período da tela (33,8 ms) por minuto.
- **CPU**: por sistema (o `frameStats` atual), com p99 acrescentado.
- **GPU**: p50/p95/p99 pelo timer (4.1).
- **Travadas**: Long Animation Frames com atribuição [F58]; tempo da entrada
  até o quadro seguinte nas edições.
- **Trabalho**: contadores (trechos, cruzamentos, células visitadas por edição
  e por passo), como o `padsWork` que já existe.
- **Memória**: heap (e `measureUserAgentSpecificMemory` quando houver
  isolamento [F62]), bytes de GPU contabilizados (B4), inclinação do heap em
  30 min.
- **Imagem**: piso de triângulos/detalhe (já existe) e fotos dos trajetos.

### 9.3 Cenários

| Id | Cenário | O que protege |
|---|---|---|
| A | Rua, cidade pequena, 400/400 (o portão de hoje) | o caso comum |
| B | Vista 3/4 sobre a cidade grande | prédios, HLOD, sombras |
| C | Alto (meia altura) e D globo/vista inteira do plano | terreno distante, árvores, HLOD |
| E | Viagem rápida: 20 km em 20 s pelo planeta, 3 altitudes | streaming de peças, ritmo |
| F | Os mesmos A-E no modo plano | o segundo modo |
| G | Rajada de edições: 20 vias em 60 s em cidade grande | custo por edição, trânsito sem parar |
| H | Estresse: 1 000/1 000 (e depois metas de LOD) a 4× | simulação |
| I | Grade 36×36 sem câmera (node) | escala da simulação e da edição |
| J | Sessão de 30 min jogando | vazamentos, envelhecimento, caches |
| K | Abrir mapa grande | tempo até a cidade aparecer, maior quadro depois |

### 9.4 Testes de escala no `npm run check` (determinísticos, sem relógio)

Contagens em vez de tempo, como os specs de orçamento atuais:

```ts
// tests/perf/scale.spec.ts (esboço): a mesma via isolada num mapa 36× maior
it('uma edição isolada visita o mesmo trabalho em qualquer tamanho de mapa', () => {
  const small = openWorld(closedGrid(6)), large = openWorld(closedGrid(36));
  const a = workOfEdit(small, isolatedRoad()), b = workOfEdit(large, isolatedRoad());
  expect(b.segmentsVisited).toBeLessThanOrEqual(a.segmentsVisited + 8);
  expect(b.junctionsVisited).toBeLessThanOrEqual(a.junctionsVisited + 4);
  expect(b.cellsRebuilt).toBe(a.cellsRebuilt);
});
it('um passo sem agentes por perto não visita controladores ociosos', () => {
  const w = openWorld(closedGrid(36));
  expect(workOfStep(w).controllersStepped).toBeLessThanOrEqual(activeControllers(w));
});
```

### 9.5 Estatística e decisão

- **Repetição**: 5 rodadas por cenário, intercalando a versão de referência e
  a candidata (A, B, A, B…) para que o estado da máquina afete as duas
  igualmente; repetir onde a variância é maior [F65]; aleatorizar a ordem dos
  cenários para não criar viés de configuração [F66].
- **Comparação**: razão das medianas com intervalo de confiança por bootstrap;
  reprovar quando o limite inferior passar de +5% numa métrica `error`
  (a Mozilla usa limiares de 2% e exige 12 pontos depois da mudança antes de
  alertar [F64]; aqui, com poucas rodadas, 5% e o intervalo de confiança):

```js
// scripts/compare.mjs (esboço)
const median = (a) => { const s = [...a].sort((x, y) => x - y); return s[s.length >> 1]; };
function bootstrapRatio(base, cand, n = 10000) {
  const draw = (a) => a.map(() => a[(Math.random() * a.length) | 0]);
  const r = Array.from({ length: n }, () => median(draw(cand)) / median(draw(base))).sort((x, y) => x - y);
  return { lo: r[Math.floor(n * 0.025)], mid: median(cand) / median(base), hi: r[Math.floor(n * 0.975)] };
}
```

- **Quando reprova**: rodar de novo (como o "retrigger" da Mozilla); se
  persistir, bisseção nos commits e correção na causa — nunca afrouxar o
  orçamento, que continua em catraca e só sobe com o sim do jogador.

### 9.6 Orçamentos propostos (calibrar na fase 0, depois catraca)

Os valores abaixo são **metas de partida**, não medidas: a fase 0 mede a linha
de base nas condições de 9.1 e cada número entra na tabela com o valor medido
mais uma margem, como o `perfBudget.ts` já faz.

| Métrica | Cenários | Meta de partida |
|---|---|---|
| Intervalo entre quadros p95 / p99 | A-D, F parados | ≤ 17,5 ms / ≤ 25 ms (59 Hz) |
| Quadros > 33,8 ms | A-F | ≤ 1 por minuto; nenhum > 50 ms fora de carga |
| GPU p95 | A-F na RTX | ≤ 13 ms (folga para o compositor) |
| CPU da thread principal p95 | A-F | ≤ 10 ms |
| Simulação por quadro | A, H | ≤ 4 ms com 400/400 a 4× (a meta já registrada em P70) |
| Edição | G | quadro do clique ≤ 50 ms; nenhum > 100 ms; trânsito parado ≤ 0,5 s |
| Viagem | E | p99 ≤ 33,8 ms; máximo ≤ 100 ms; sem placa faltando nas fotos |
| Memória | J | heap estável depois do aquecimento (inclinação ≈ 0); bytes de GPU ≤ teto por pixel da tela [F37] |
| Escala | I | contadores de 9.4 iguais em qualquer tamanho; passo p50 da 36×36 ≤ 1,3× o da 6×6 |

### 9.7 Regras de arquitetura que impedem a volta

1. **Todo derivado declara seu domínio (células) e sua chave de entrada**; o
   teste de escala de 9.4 vale para cada camada nova.
2. **Nenhum laço sobre o mapa inteiro em código por passo ou por edição** sem
   um contador de trabalho com orçamento na tabela; o contador entra no mesmo
   commit da funcionalidade (já é a regra 3 do `CLAUDE.md` do ramo).
3. **Todo cache declara teto em bytes** num registro único de memória; um spec
   soma os tetos contra o orçamento total.
4. **Documento inteiro como texto só em exportar/importar**; edição e
   autosave trabalham por registro/célula.
5. **Nada de `Map<string,…>` com chave montada por texto no passo da
   simulação** (regra de lint `no-restricted-syntax` para template literal
   como chave dentro de `src/sim/**` nas funções de passo, ou revisão pelo
   contador de alocação do portão).
6. **Workers só pelo pool único**, com prioridade declarada.
7. **Funcionalidade nova entra com seu cenário** (ou estende um de 9.3) e com
   a linha de orçamento; o portão roda no fechamento de cada etapa e depois de
   qualquer mudança no desenho, na simulação ou na reconstrução.

### 9.8 Concorrência dos próprios testes

- Uma medida por vez na máquina (`run-limited`); proposta: o portão recusar
  começar com a CPU acima de 30% (o `run-limited` hoje espera abaixo de 70%) e
  anotar a carga no resultado.
- `vitest` com 1 worker para medidas de tempo (o `bench-sim` já faz).
- Nenhum outro painel do aplicativo desenhando durante a medida de GPU (o
  processo da GPU é um só para todas as conversas).
- No Windows 10 com núcleos P/E, mais rodadas em vez de rodadas mais longas
  [F68].

---

## 10. Lacunas, dúvidas e medições que faltam

### 10.1 GPU na RTX (não medida — painel escondido)

Procedimento: (1) painel do navegador **visível** (Ctrl+Shift+B), nenhum outro
painel desenhando o jogo; (2) abrir o servidor de rascunho do planeta (5178) e
o do plano (5177); (3) instalar o timer de 4.1 pelo console; (4) para cada
cenário A-F de 9.3: aquecer 10 s, zerar, medir 60 s; anotar GPU p50/p95/p99,
intervalo p95/p99, draw calls e triângulos; (5) repetir com a janela emulada em
2560×1080 (`resize_window`) para o custo de preenchimento do jogador; (6)
repetir A e C no plano para separar o custo da dobra do planeta (5.7).

### 10.2 Memória

- Instantâneo de heap do planeta vazio (627-685 MB **[MEDIDO-AQUI]**) e com a
  cidade: quem retém o quê (atlas, relevo, ecologia, pessoas, caches).
- Bytes de GPU por sistema (B4) com uma cidade espalhada por 20+ placas/peças,
  para confirmar ou não a hipótese de 5.5.
- Sessão de 30 min (cenário J) para vazamentos.

### 10.3 Precisão

Sonda de tremor (4.2) na borda do atlas e no centro; confirma ou descarta a
hipótese de ~1 px na rua (5.6).

### 10.4 Sobre-desenho na rua

Medir o custo de fragmento na vista de rua entre prédios (GPU com e sem
pós-processamento, e com a resolução reduzida): decide se oclusão vale a pena.

### 10.5 Mapas reais

As sondas B1/B2 usam grades sintéticas de vias locais com sinal em quase todo
cruzamento — pior caso para o estágio de semáforos. Repetir com o mapa do
jogador e com a cidade gerada grande (cenário K) para dar o peso real de cada
estágio.

### 10.6 Calibração do meso

Fluxo por trecho e tempo de viagem do meso contra o micro num mapa de teste,
antes de ligar o meso fora da vista (o SUMO trata isso como calibração por
parâmetros de headway [F11]).

### 10.7 Entrada

Latência do gesto até o quadro (Event Timing/LoAF [F58]) nas ferramentas de
via, zona e terreno, com 400/400 e 1 000/1 000.

### 10.8 Decisões do jogador (respondidas em 2026-10-11)

1. **Um mundo só, duas formas de ver** (5.15): tudo que se faz no plano
   aparece no planeta e vice-versa.
2. **População sem teto fixo**: o objetivo é a maior população que a máquina
   sustenta a 4× com o quadro estável; a otimização existe para aumentar esse
   número, nunca para cortá-lo.

---

## Anexo A — Fontes

Lidas na íntegra salvo indicação. "Resumo" = só o resumo estava acessível.

- [F1] Paavo Huhtala, "Why Cities: Skylines 2 performs poorly" — https://blog.paavo.me/cities-skylines-2-performance/
- [F2] Colossal Order, dev diary de mapas e temas (159 km², 441 peças; CS1 com peças de 1,92 km) — https://colossalorder.fi/?p=1767
- [F3] Colossal Order, dev diary de IA de trânsito — https://colossalorder.fi/?p=1597
- [F4] Factorio Friday Facts #148 — https://factorio.com/blog/post/fff-148
- [F5] Factorio Friday Facts #215 — https://factorio.com/blog/post/fff-215
- [F6] Factorio Friday Facts #364 — https://factorio.com/blog/post/fff-364
- [F7] Factorio Friday Facts #421 — https://factorio.com/blog/post/fff-421
- [F8] Cournoyer, "Massive Crowd on Assassin's Creed Unity: AI Recycling", GDC 2015 (resumo) — https://gdcvault.com/play/1022141/Massive-Crowd-on-Assassin-s
- [F9] Fauerby, "Crowds in Hitman: Absolution", GDC 2012 (resumo) — https://gdcvault.com/play/1016443/Crowds-in-Hitman
- [F10] Epic, Overview of Mass Gameplay — https://dev.epicgames.com/documentation/en-us/unreal-engine/overview-of-mass-gameplay-in-unreal-engine
- [F11] SUMO, Mesoscopic model — https://sumo.dlr.de/docs/Simulation/Meso.html
- [F12] Emerson, "Crowd Pathfinding and Steering Using Flow Field Tiles", Game AI Pro, cap. 23 — http://www.gameaipro.com/GameAIPro/GameAIPro_Chapter23_Crowd_Pathfinding_and_Steering_Using_Flow_Field_Tiles.pdf
- [F13] Delling, Goldberg, Pajor, Werneck, "Customizable Route Planning" (resumo) — https://www.microsoft.com/en-us/research/publication/customizable-route-planning/
- [F14] Treiber, Intelligent Driver Model — https://traffic-simulation.de/info/info_IDM.html
- [F15] Fiedler, "Fix Your Timestep!" — https://gafferongames.com/post/fix_your_timestep/
- [F16] Epic, World Partition — https://dev.epicgames.com/documentation/en-us/unreal-engine/world-partition-in-unreal-engine
- [F17] Epic, World Partition HLOD — https://dev.epicgames.com/documentation/en-us/unreal-engine/world-partition---hierarchical-level-of-detail-in-unreal-engine
- [F18] OGC/Cesium, 3D Tiles specification — https://github.com/CesiumGS/3d-tiles/blob/main/specification/README.adoc
- [F19] Strugar, "Continuous Distance-Dependent Level of Detail for Rendering Heightmaps" — https://github.com/fstrugar/CDLOD
- [F20] Asirvatham e Hoppe, GPU Gems 2 cap. 2 (geometry clipmaps) — https://developer.nvidia.com/gpugems/gpugems2/part-i-geometric-complexity/chapter-2-terrain-rendering-using-gpu-based-geometry
- [F21] Ohlarik, "Precisions, Precisions" — https://help.agi.com/AGIComponents/html/BlogPrecisionsPrecisions.htm
- [F22] Epic, Large World Coordinates — https://dev.epicgames.com/documentation/en-us/unreal-engine/large-world-coordinates-in-unreal-engine-5
- [F23] Godot, Large world coordinates — https://docs.godotengine.org/en/stable/tutorials/physics/large_world_coordinates.html
- [F24] Reed, "Depth Precision Visualized" — https://www.reedbeta.com/blog/depth-precision-visualized/
- [F25] Ring, "Horizon Culling" (Cesium) — https://cesium.com/blog/2013/04/25/horizon-culling/
- [F26] Wittens, "Making Worlds 1 — Of Spheres and Cubes" — https://acko.net/blog/making-worlds-1-of-spheres-and-cubes/
- [F27] three.js, WebGLRenderer — https://threejs.org/docs/pages/WebGLRenderer.html
- [F28] three.js, Renderer (WebGPU) — https://threejs.org/docs/pages/Renderer.html
- [F29] three.js manual, WebGPURenderer — https://threejs.org/manual/pages/webgpurenderer.html
- [F30] three.js, BatchedMesh — https://threejs.org/docs/pages/BatchedMesh.html
- [F31] three.js issue #28776 (desempenho do BatchedMesh) — https://github.com/mrdoob/three.js/issues/28776
- [F32] Fórum three.js, Z invertido no WebGPU (mantenedores) — https://discourse.threejs.org/t/does-three-js-webgpu-support-reverse-z-buffer/87687
- [F33] Fórum three.js, profundidade logarítmica e desempenho — https://discourse.threejs.org/t/beware-of-logarithmic-depth-buffer-it-can-degrade-scene-performance/88495
- [F34] @three.ez/instanced-mesh (InstancedMesh2) — https://github.com/agargaro/instanced-mesh
- [F35] Fórum three.js, floresta de impostores octaédricos — https://discourse.threejs.org/t/a-forest-of-octahedral-impostors/85735
- [F36] NASA-AMMOS, 3DTilesRendererJS — https://github.com/NASA-AMMOS/3DTilesRendererJS
- [F37] MDN, WebGL best practices — https://developer.mozilla.org/en-US/docs/Web/API/WebGL_API/WebGL_best_practices
- [F38] Khronos, KTX Artist Guide — https://github.com/KhronosGroup/3D-Formats-Guidelines/blob/main/KTXArtistGuide.md
- [F39] meshoptimizer — https://meshoptimizer.org/
- [F40] Dudash, GPU Gems 3 cap. 2 (multidões animadas) — https://developer.nvidia.com/gpugems/gpugems3/part-i-geometry/chapter-2-animated-crowd-rendering
- [F41] web.dev, WebGPU nos principais navegadores — https://web.dev/blog/webgpu-supported-major-browsers
- [F42] Chrome, What's new in WebGPU (131): multi-draw indirect — https://developer.chrome.com/blog/new-in-webgpu-131
- [F43] Chromium, GPU Command Buffer — https://www.chromium.org/developers/design-documents/gpu-command-buffer/
- [F44] Haar e Aaltonen, "GPU-Driven Rendering Pipelines", SIGGRAPH 2015 (resumo; slides não lidos) — https://advances.realtimerendering.com/s2015/aaltonenhaar_siggraph2015_combined_final_footer_220dpi.pdf
- [F45] Intel, Masked Software Occlusion Culling (resumo do artigo e da biblioteca) — https://www.intel.com/content/www/us/en/developer/articles/technical/masked-software-occlusion-culling.html
- [F46] Chen, "Adaptive Virtual Texture Rendering in Far Cry 4", GDC 2015 (resumo) — https://gdcvault.com/play/1021761/Adaptive-Virtual-Texture-Rendering-in
- [F47] Moore, "Terrain Rendering in Far Cry 5", GDC 2018 (resumo) — https://gdcvault.com/play/1025261/Terrain-Rendering-in-Far-Cry
- [F48] V8, "Trash talk: the Orinoco garbage collector" — https://v8.dev/blog/trash-talk
- [F49] Nystrom, Game Programming Patterns, "Data Locality" — https://gameprogrammingpatterns.com/data-locality.html
- [F50] Nystrom, Game Programming Patterns, "Spatial Partition" — https://gameprogrammingpatterns.com/spatial-partition.html
- [F51] MDN, SharedArrayBuffer — https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/SharedArrayBuffer
- [F52] web.dev, COOP e COEP — https://web.dev/articles/coop-coep
- [F53] MDN, Transferable objects — https://developer.mozilla.org/en-US/docs/Web/API/Web_Workers_API/Transferable_objects
- [F54] Surma, "Is postMessage slow?" — https://surma.dev/things/is-postmessage-slow/
- [F55] web.dev, WebAssembly threads — https://web.dev/articles/webassembly-threads
- [F56] MDN, OffscreenCanvas — https://developer.mozilla.org/en-US/docs/Web/API/OffscreenCanvas
- [F57] Unity, Job system overview — https://docs.unity3d.com/Manual/job-system-overview.html
- [F58] Chrome, Long Animation Frames API — https://developer.chrome.com/docs/web-platform/long-animation-frames
- [F59] MDN, scheduler.yield — https://developer.mozilla.org/en-US/docs/Web/API/Scheduler/yield
- [F60] MDN, requestAnimationFrame — https://developer.mozilla.org/en-US/docs/Web/API/Window/requestAnimationFrame
- [F61] Khronos, EXT_disjoint_timer_query_webgl2 — https://registry.khronos.org/webgl/extensions/EXT_disjoint_timer_query_webgl2/
- [F62] MDN, measureUserAgentSpecificMemory — https://developer.mozilla.org/en-US/docs/Web/API/Performance/measureUserAgentSpecificMemory
- [F63] NVIDIA, "Analysing Stutter – Mining More from Percentiles" — https://developer.nvidia.com/content/analysing-stutter-%E2%80%93-mining-more-percentiles-0
- [F64] Mozilla, Performance Sheriffing — https://firefox-source-docs.mozilla.org/testing/perfdocs/perf-sheriffing.html
- [F65] Kalibera e Jones, "Rigorous Benchmarking in Reasonable Time" (resumo) — https://kar.kent.ac.uk/33611/
- [F66] Mytkowicz et al., "Producing Wrong Data Without Doing Anything Obviously Wrong!" (resumo) — https://sape.inf.usi.ch/publications/asplos09
- [F67] Unity, Performance Testing Extension — https://docs.unity3d.com/Packages/com.unity.test-framework.performance@3.0/manual/index.html
- [F68] AnandTech, Alder Lake e Thread Director no Windows 10 × 11 — https://www.anandtech.com/show/16959/intel-innovation-alder-lake-november-4th/3
- [F69] Unity, Dynamic Resolution — https://docs.unity3d.com/Manual/DynamicResolution-landing.html
- [F70] Unity, Shadows in HDRP (modos de atualização) — https://docs.unity3d.com/Packages/hdrp/manual/Shadows-in-HDRP.html
- [F71] NVIDIA, Cascaded Shadow Mapping sample — https://archive.docs.nvidia.com/gameworks/content/gameworkslibrary/graphicssamples/opengl_samples/cascadedshadowmapping.htm
- [F73] Willmott, "Inside GlassBox" (só o resumo) — https://www.andrewwillmott.com/talks/inside-glassbox

Código-fonte consultado: three.js r186 em `node_modules/three` (`WebGLRenderer.js`
linha 2160, `Matrix4.js`, `BatchedMesh.js`, `examples/jsm/csm`,
`renderers/common/IndirectStorageBufferAttribute.js`).

---

## Anexo B — Sondas e dados brutos

### B1 e B2 — escala da simulação e da edição

- **Onde rodou:** cópia do ramo `planeta-esfera` em `54c2e269` exportada por
  `git archive` para uma pasta temporária, com `node_modules` ligado ao da
  árvore do ramo; Node 24.20 (V8), `vitest` com 1 worker, modo plano
  (`__PLANET__ = false`), 1 m por unidade; sob `scripts/run-limited.mjs` (uma
  tarefa pesada por vez, prioridade baixa); máquina compartilhada com outras
  sessões. Em 2026-10-11, 13:30-13:44.
- **Mapa:** grade fechada de n×n quarteirões de 120 m, vias locais de mão
  dupla (`closedGrid` do `population.spec`), sem lotes; população pelo
  ambiente (`trafficCount`, `pedestrianCount`, `ambient.source = 'edges'`) e o
  motor de caminhada instalado, como o jogo faz.
- **B1:** aquecimento até encher mais 20 s simulados; 600 passos cronometrados
  um a um; depois 3 vias isoladas de 100 m a 200 m da borda da grade, cada uma
  medida em `commitDraft`, `net.rebuild`, `prepareVehicleTopology` (inteiro),
  `rebuildVehicleTopology` + `rebindVehicles`, `walkTopologySteps` +
  `rebindPeds` (medianas). A "topologia ao abrir" é `rebuildTopology` logo
  depois de criar o mundo; nas rodadas seguintes da mesma grade o cache em
  memória das zonas de conflito já estava quente (por isso 12×12 com
  1 000/1 000 abriu em 3,6 s e não 6,4 s).
- **B2:** 6×6 e 36×36 com 400/400, 600 passos com `StepOptions.timings`.
- **Limites:** grade sintética (pior caso para semáforos); números de CPU
  desta máquina; o tempo da topologia ao abrir não inclui o cache de zonas de
  conflito do IndexedDB que o jogo usa (P34).

Dados brutos de B1 (ms, medianas por passo e por edição):

```json
[{"grid":"6x6","segments":87,"popAsked":400,"cars":400,"people":410,"netBuildMs":30.8,"topoColdMs":1679,"tickP50":3.289,"tickP95":5.52,"tickP99":9.082,"tickMax":14.237,"editCommitMs":7.534,"editNetMs":1.118,"editPrepMs":55.432,"editSwapMs":24.285,"editWalkMs":10.662},
 {"grid":"12x12","segments":315,"popAsked":400,"cars":400,"people":417,"netBuildMs":73.5,"topoColdMs":6420,"tickP50":4.862,"tickP95":7.796,"tickP99":10.719,"tickMax":26.665,"editCommitMs":7.187,"editNetMs":1.673,"editPrepMs":217.633,"editSwapMs":78.123,"editWalkMs":47.777},
 {"grid":"24x24","segments":1203,"popAsked":400,"cars":400,"people":421,"netBuildMs":195,"topoColdMs":24887.5,"tickP50":7.372,"tickP95":11.774,"tickP99":15.209,"tickMax":25.987,"editCommitMs":40.507,"editNetMs":13.281,"editPrepMs":1731.465,"editSwapMs":225.714,"editWalkMs":273.125},
 {"grid":"36x36","segments":2667,"popAsked":400,"cars":400,"people":420,"netBuildMs":416.1,"topoColdMs":47740.7,"tickP50":9.737,"tickP95":12.842,"tickP99":14.755,"tickMax":19.393,"editCommitMs":62.839,"editNetMs":13.754,"editPrepMs":6811.656,"editSwapMs":457.774,"editWalkMs":1350.328},
 {"grid":"12x12","segments":315,"popAsked":1000,"cars":1000,"people":1028,"netBuildMs":72.2,"topoColdMs":3570.4,"tickP50":14.271,"tickP95":18.175,"tickP99":21.407,"tickMax":26.542,"editCommitMs":5.062,"editNetMs":1.548,"editPrepMs":145.543,"editSwapMs":67.212,"editWalkMs":34.057},
 {"grid":"24x24","segments":1203,"popAsked":1000,"cars":1000,"people":1043,"netBuildMs":206.2,"topoColdMs":15089.1,"tickP50":21.605,"tickP95":26.991,"tickP99":28.813,"tickMax":33.807,"editCommitMs":26.403,"editNetMs":17.238,"editPrepMs":1685.676,"editSwapMs":228.552,"editWalkMs":233.506},
 {"grid":"36x36","segments":2667,"popAsked":1000,"cars":1000,"people":1053,"netBuildMs":503.3,"topoColdMs":36201.4,"tickP50":23.907,"tickP95":29.102,"tickP99":32.119,"tickMax":38.919,"editCommitMs":51.315,"editNetMs":21.631,"editPrepMs":6537.182,"editSwapMs":458.145,"editWalkMs":1417.664}]
```

(`segments` inclui as 3 vias da edição; o heap medido por diferença foi
descartado, por ser dominado pelo coletor.)

Dados brutos de B2 (ms por passo):

```json
[{"grid":"6x6","segments":84,"junctions":49,"lanelets":596,"signalised":25,"vehicles":400,"peds":410,"msPerTick":3.272,
  "stages":{"0 topology":0.004,"1 signals":0.053,"2 dispatch+routes":0.194,"2b lane change":0.023,"2c kerb stops":0.073,"3 pedestrians":0.663,"4 constraints":0.517,"5 admission":0.983,"6 integrate":0.511,"7 cleanup":0.182,"8 audit":0}},
 {"grid":"36x36","segments":2664,"junctions":1369,"lanelets":20876,"signalised":1225,"vehicles":400,"peds":426,"msPerTick":9.845,
  "stages":{"0 topology":0.02,"1 signals":1.735,"2 dispatch+routes":1.276,"2b lane change":0.065,"2c kerb stops":0.14,"3 pedestrians":1.273,"4 constraints":1.529,"5 admission":1.619,"6 integrate":1.126,"7 cleanup":0.855,"8 audit":0.001}}]
```

O código da sonda B1 (para reproduzir; roda com um `vitest.config` que define
`__PLANET__ = false`, `__METERS_PER_UNIT__ = 1` e os mesmos atalhos `@core`,
`@world`, `@sim`, `@editor` do projeto):

```ts
const BLOCK = 120;
function closedGrid(n: number): RoadDoc { /* igual a tests/sim/agents/population.spec.ts, sem lotes */ }
const CONFIGS: [number, number][] = [[6, 400], [12, 400], [24, 400], [36, 400], [12, 1000], [24, 1000], [36, 1000]];
it('scales', () => {
  for (const [n, pop] of CONFIGS) {
    const doc = closedGrid(n);
    const net = new Network(doc);
    let t = performance.now(); net.rebuild(); const netBuild = performance.now() - t;
    const w = new SimWorld(doc, net, 0x0be9);
    t = performance.now(); w.rebuildTopology(); const topoCold = performance.now() - t;
    w.usePedestrianEngine(createAgentWalkEngine());
    w.trafficCount = pop; w.pedestrianCount = pop;
    w.ambient.enabled = true; w.ambient.source = 'edges'; w.clock.paused = false;
    for (let i = 0; i < Math.round(pop / 2) + Math.round(20 / DT); i++) step(w, { traffic: true, pedestrians: true });
    const ticks: number[] = [];
    for (let i = 0; i < 600; i++) { t = performance.now(); step(w, { traffic: true, pedestrians: true }); ticks.push(performance.now() - t); }
    const edge = m(BLOCK) * (n / 2) + m(200);
    for (let k = 0; k < 3; k++) {
      const y = m(-150) + k * m(150);
      // commitDraft → net.rebuild → prepareVehicleTopology (inteiro) → rebuildVehicleTopology + rebindVehicles
      // → walkTopologySteps (inteiro) + rebindPeds, cada um cronometrado; depois 30 passos
    }
  }
});
```

### B3 — painel do aplicativo, planeta vazio (servidor 5178)

Chrome 152 embutido, `ANGLE (NVIDIA GeForce RTX 3060 … Direct3D11)`,
`EXT_disjoint_timer_query_webgl2` e `EXT_clip_control` presentes, janela
1024×768, DPR 1, `crossOriginIsolated = false`, `hardwareConcurrency = 24`.
Planeta vazio (0 vias, 0 prédios), vista de cima, 10 s: 84 draw calls,
2,33 M triângulos, CPU do quadro 5,6 ms (p50), heap 627 → 685 MB, 147
programas, 191 texturas, 88 geometrias. **O painel estava escondido** (20
quadros em 10 s, intervalos de até 1 s): o tempo de GPU medido (52,7 ms p50)
reflete a GPU em clock baixo e **não vale** como medida do jogo.

### B4 — contabilidade de bytes de GPU (para a fase 0)

```js
// No console da página do jogo (desenvolvimento): soma aproximada do que está na cena.
const seen = new Set(); let geo = 0, tex = 0;
const channels = { 1023: 4, 1028: 1, 1030: 2 };              // RGBAFormat, RedFormat, RGFormat (r186)
__scene.traverse((o) => {
  if (o.geometry && !seen.has(o.geometry)) {
    seen.add(o.geometry);
    for (const a of Object.values(o.geometry.attributes)) geo += a.array.byteLength;
    if (o.geometry.index) geo += o.geometry.index.array.byteLength;
  }
  for (const m of [].concat(o.material ?? [])) for (const v of Object.values(m)) {
    if (v?.isTexture && !seen.has(v) && v.image?.width) {
      seen.add(v);
      const mip = v.generateMipmaps ? 4 / 3 : 1;
      const typeBytes = v.type === 1015 ? 4 : v.type === 1016 ? 2 : 1;   // Float, HalfFloat, UnsignedByte
      tex += v.image.width * v.image.height * (channels[v.format] ?? 4) * typeBytes * mip;
    }
  }
});
({ geometryMB: geo / 1e6, textureMB: tex / 1e6 });
```

Não conta alvos de renderização, mapas de sombra nem texturas fora da cena
(cache); é uma cota inferior útil para comparar antes e depois.

