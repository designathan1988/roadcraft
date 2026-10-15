# Auditoria completa — desempenho, malha, textura, threads e cidade sem limite

**Data:** 2026-10-15 · **Escopo:** o código inteiro de `src/` (511 arquivos TypeScript, ~170 mil linhas) ·
**Regra da casa seguida:** cada achado traz onde está (arquivo:linha), o que custa de fato, a correção
concreta e a fonte que a fundamenta. Item que não perde qualidade gráfica nem corta distância, sombra,
resolução, textura ou efeito. Um item só está "corrigido" quando a causa sai do código.

---

## 0. Como ler este relatório

1. Quem quer **o que fazer agora**: §4 (achados, do mais caro ao mais barato) e §6 (ordem de ataque).
2. Quem quer **a técnica e a fonte**: §5 (pesquisa) e a coluna "fonte" de cada achado.
3. Quem quer **os números**: §2 (medida de hoje, no jogo) e §8 (anexos).
4. Quem quer **saber o que eu não conferi**: §1.3. Está separado de propósito.

Este relatório **não substitui** `OTIMIZACAO.md` (a lista viva do que já foi corrigido) nem
`docs/PROBLEMS.md`. Ele os usa como ponto de partida: o que já está corrigido aparece aqui só quando
o achado novo muda a conclusão. O que o `CLAUDE.md` chama de "Achados abertos" está conferido, item a
item, em §4.

---

## 1. Método

### 1.1 O que foi lido

O código foi lido inteiro por área, não por amostragem: oito frentes em paralelo (§8.4 lista os
arquivos por frente), e o chamador seguido até o quadro, a edição ou o ponteiro nos achados que
importam. As afirmações de comportamento foram conferidas no código que **usa** a coisa — por
exemplo, a memória de vídeo dos alvos de render foi conferida na fonte do three r186 que aloca o
alvo (`WebGLShadowMap.js:227-269`), não na documentação.

### 1.2 O que foi medido

Uma execução de `node scripts/look.mjs scripts/look/auditoria.json` (Chrome instalado, headless, na
placa de vídeo), cidade gerada padrão, três vistas (mapa, bairro, rua), com `budget`, `memory` e
`profile` (Long Animation Frames + `.cpuprofile`). Artefatos em `scripts/look/out-auditoria/`.

**A máquina desta medição não é a do jogador.** Para que os números valham para "computadores
diferentes", a medida foi feita na **GPU integrada Intel UHD 770** (ANGLE/D3D11), não na RTX 3060 em
que o projeto mediu antes, e sob `run-limited.mjs` (25 % da CPU, 8 GB). Consequência a respeitar ao
ler as tabelas:

- **triângulos, chamadas de desenho, memória de vídeo e bytes de geometria não dependem disso** — são
  os números que uso para decidir;
- **fps, GPU p95 e ms de CPU estão pessimistas** (a CPU está limitada a ¼ e a placa é fraca) e servem
  só como proporção entre vistas e entre sistemas, nunca como valor absoluto.

### 1.3 O que eu **não** conferi

- **Não medi** o custo de cada achado isolado: os milissegundos citados entre aspas vêm dos
  comentários datados do próprio código (`perfil de 2026-10-11`, `OTIMIZACAO.md`) ou da medição de
  hoje, e estão marcados como tal. Onde a conta é aritmética minha, está escrita como **estimativa**
  com a conta ao lado.
- **Não rodei** a suíte de testes, o `eslint` nem o `check` (não são o pedido; e o pedido é auditoria,
  não verificação de entrega).
- **Não conferi** o comportamento em máquinas sem `float` render targets, sem MSAA 8× ou sem WebGL2 —
  os números de memória de alvos de render valem para a faixa em que o jogo roda hoje.
- **Não abri** todas as fotos: abri a vista de rua (§2.4). Não houve perda de qualidade gráfica nesta
  auditoria — nada foi alterado.

---

## 2. A medida de hoje, no jogo

Cidade gerada padrão (raio 640 m, ~1 348 prédios), 1920×1080, Intel UHD 770, 25 % da CPU.

### 2.1 Onde o tempo vai (o próprio HUD do jogo, capturado na vista de rua)

```
0. ONDE VAI O TEMPO ms por segundo (1000 = a thread inteira):
   739  quadro drawing        ← o desenho
    28  passo draw/Render
    19  quadro simulation      ← a simulação
     0  quadro panels / topology / overlay
3. MOTOR (core/engine.ts) último refresh, por tempo:
   0.10 ms  0 chaves draw street furniture … (todos os produtos ociosos: o motor está funcionando)
```

O perfil do mesmo trecho (`.cpuprofile`, 4,45 s, 12 quadros acima de 50 ms, pior 254 ms):

| função | próprio (ms) | com o que chama (ms) |
|---|---|---|
| `frame` (`main.ts`) | — | 472 |
| `draw` (`renderer.ts`) | 19 | 286 |
| `postprocess.render` | — | 206 |
| `WebGLRenderer.render` | — | 204 |
| `sim.clock.advance` → `step` | — | 174 / 173 |
| `bindVertexArray` (nativo) | 18 | — |
| `multiplyMatrices` (three) | 14 | — |
| `traverseVisible` (three) | 12 | — |
| `morph.height` (`people/body/morph.ts:143`) | 11 | — |
| `projectObject` (three) | 10 | — |
| `crowdBodies.make` | 8 | — |
| `hybridAStar.clearAt` | 8 | — |
| `snapshotInto` (`sim/vehicles/state.ts:18`) | 8 | — |

**Leitura:** nesta máquina o **desenho domina** (~74 % da thread) e a simulação é ~2 %. Na RTX 3060
do jogador a relação é outra — o próprio projeto mede a simulação em 13,7 ms de CPU por quadro, o
maior item isolado de CPU — mas as duas medidas concordam no essencial: **o que sobra para corrigir é
geometria (quantos e quais triângulos), submissão de desenho e memória**, e depois a simulação.

### 2.2 Orçamentos por vista (o `__roadcraft.budget` do projeto contra a medida)

| linha | mapa | bairro | rua | orçamento |
|---|---|---|---|---|
| triângulos desenhados | 3,16 M ✓ | **23,3 M** (2,9×) | **25,7 M** (2,6×) | 4 / 8 / 10 M |
| chamadas (cor + sombra) | 277 ✓ | **1 114** (1,0×) | 670 ✓ | 400 / 1 100 / 1 000 |
| **L0 cascas na GPU** | 2,4 MB ✓ | **335,5 MB** (1,1×) | **794,6 MB** (2,6×) | ≤ 300 MB |
| L0 peças dos prédios | 0,1 MB ✓ | 19,8 MB ✓ | 42,3 MB ✓ | ≤ 150 MB |
| L1 massas | 31,9 MB ✓ | 31,9 MB ✓ | 31,9 MB ✓ | ≤ 120 MB |
| texturas | 52,5 MB ✓ | 54 MB ✓ | 55 MB ✓ | ≤ 600 MB |
| alvos de render e sombras | não medido | não medido | não medido | ≤ 300 MB |
| heap JS | 1 100 MB ≈ | 1 725 MB ✗ | **2 116 MB** ✗ | ≤ 1 500 MB |
| geometria presa na CPU | 87,5 MB | 153,6 MB | **188,1 MB** | — (sem orçamento) |

### 2.3 O que a tabela já decide

1. **O detalhe dos prédios é o problema de geometria** e não a vegetação, o terreno nem as vias:
   L0 cascas sozinho são 794,6 MB de placa (2,6× o orçamento) e o grosso dos 25,7 M de triângulos.
2. **A memória de vídeo real é maior do que a medida** — a linha que mais pode estar estourada
   (alvos de render e sombras) é justamente a que o contador do jogo não mede (§4.1).
3. **Textura não é problema de memória** (55 MB contra 600 MB). É problema de *formato* e de
   *decodificação*, não de tamanho (§4.12).
4. **O heap passa do orçamento por cidade guardada na CPU**: 188 MB são geometria que já está na
   placa e continua na memória JS (§4.3).
5. A **cidade padrão levou 67,1 s** para ficar de pé nesta máquina (23,7 s só o crescimento): com o
   mapa inteiro isso é a parede descrita em `docs/CIDADE-10KM.md` (§4.7).

### 2.4 A imagem (nada quebrado, e é o que se quer manter)

A vista de rua mostra fachada com caixilhos, peitoris e molduras, calçada com luminária e árvore,
tudo com sombra. Nenhum defeito de imagem foi encontrado nesta auditoria. É por isso que **toda
correção abaixo é de custo, não de aparência** — e as que puderem mudar aparência estão marcadas
como decisão do jogador, com foto antes e depois.

---

## 3. O mapa dos custos

| recurso | quem manda hoje | onde |
|---|---|---|
| **triângulos** (25,7 M na rua) | cascas de prédio (6,5 M medidos no projeto), peças (7,0 M), massas, vias | §4.2, §4.4, §4.5 |
| **chamadas de desenho** (670–1 114) | uma malha por célula de prédio + ~30 `InstancedMesh` por tipo por célula | §4.5 |
| **memória de vídeo** | alvo da cena com MSAA 8× em float (~500 MB, **não medido**), sombra 4096² (134 MB, **não medido**), cascas (794 MB) | §4.1, §4.2 |
| **heap JS** (2,1 GB) | ladrilhos das vias na CPU (188 MB de geometria), registros de prédio (~7 KB cada), baias de fachada | §4.3, §4.13 |
| **CPU por quadro** | desenho (~286 ms dos 472 no perfil desta máquina), simulação (13,7 ms na do jogador), eventos de alocação por quadro | §4.6, §4.9 |
| **CPU por evento** | traçado+abertura da cidade (67 s), emissão de prédio (~7 ms cada), edição de via | §4.7, §4.8 |

---

## 4. Achados

Cada achado: **onde** (arquivo:linha), **o que custa**, **correção**, **fonte**. Ordem por custo
dentro de cada bloco; os blocos estão na ordem em que eu atacaria.

### 4.1 Memória de vídeo: os dois maiores consumidores não aparecem na conta (ALTO)

**Onde.** `src/render/postprocess.ts:163-179`:

```ts
const sceneTarget = new WebGLRenderTarget(size.x * ratio, size.y * ratio, {
  type: HalfFloatType,
  depthTexture: new DepthTexture(..., FloatType),
  samples: Math.min(8, renderer.capabilities.maxSamples),
});
```

`src/render/quality.ts:131`: `shadowMapSize: 4096` no tier `high` (o padrão).

**O que custa** (aritmética, 1920×1080 com `pixelRatio` 1,5 → 2 880×1 620 = 4,666 Mpx):

- alvo da cena, cor RGBA16F: 4,666 M × 8 B = 37,3 MB; **com 8 amostras = 298,6 MB**;
- profundidade 32F: 4,666 M × 4 B = 18,7 MB; **com 8 amostras = 149,3 MB**;
- mais as texturas resolvidas (37,3 + 18,7) ⇒ **≈ 504 MB**.
- mapa de sombra 4096²: cor RGBA8 67,1 MB + profundidade 67,1 MB ⇒ **134 MB**.

Total ≈ **640 MB de memória de vídeo invisível**. O orçamento de 300 MB existe
(`src/core/perfBudget.ts:196`) e a linha aparece na tabela do jogo como **"não medido"**, porque
`memoryCounters.ts:32` percorre a **cena** (`root.traverse`), e alvo de render não é objeto de cena.
O comentário de `postprocess.ts:180-185` já registra o episódio em que isso estourou (dois alvos de
900 MB); sobrou um, que continua fora da conta.

**Segundo problema no mesmo lugar.** Metade da sombra é memória morta: o three r186 cria **sempre**
um alvo com textura de cor (`WebGLShadowMap.js:227`) e, no caminho de `PCFShadowMap`, a cor só é
limpa e nunca amostrada — a sombra sai da `depthTexture` (`:253-254`). São 67,1 MB alocados para
nada. Não há caminho pela API pública para um alvo só-profundidade por luz; o custo de substituir o
passe de sombra do three não se paga.

**Correção.**

1. **Medir** (barato e imediato): somar ao `budget` os alvos vivos — o `EffectComposer` e o alvo de
   cada luz de sombra, cada um multiplicado por `samples` quando multisampled. A linha já existe,
   está "não medido"; passa a valer.
2. **Tornar as amostras um campo de qualidade** (`quality.ts`): 8 em `ultra`, 4 em `high`, 0 em
   `low`/`medium` — onde a cadeia de pós nem existe. É a maior alavanca de memória do jogo e é
   **decisão do jogador** (muda a borda dos fios e caixilhos de perto): foto antes e depois, nas
   mesmas vistas, como manda o `CLAUDE.md`.
3. **Sombra**: 4096 → 2048 no tier `high` devolve 100 MB. O próprio arquivo documenta o compromisso
   (texel × degrau); o jogador decide vendo a foto do rodapé de perto, que é o defeito que motivou os
   4096 (`quality.ts:128-130`).

**Fonte.** Fonte do three r186 instalado (`repo-r186/src/renderers/webgl/WebGLShadowMap.js:227-269`):
o alvo da sombra nasce com textura de cor; `WebGLRenderer`/`WebGLRenderTarget` para o alvo da cena.

---

### 4.2 O detalhe dos prédios não tem residência por orçamento (ALTO)

**Onde.** `src/render/buildings/layer.ts` (a camada emite e mantém o detalhe por célula),
`src/render/buildings/massCells.ts` (a escolha perto/longe por erro de tela),
`src/render/buildings/cellPool.ts` (a montagem em worker), `renderer.ts` (o alcance da vista).

**O que custa.** Medido hoje: **794,6 MB** de "L0 cascas" na vista de rua contra um orçamento de
300 MB — 2,6×. A causa é de projeto, já nomeada no `CLAUDE.md`: *"as células de detalhe longe ficam
na GPU; a memória de vídeo cresce com a área já visitada; falta o teto pelo orçamento da placa
(residência), sem refazer o que volta."* O commit `b5495ec` fez o primeiro passo (o detalhe residente
pela distância à vista), mas **por distância, não por orçamento de bytes** — e o `budget` mostra o
resultado: numa caminhada a memória só cresce.

**A armadilha que não pode ser repetida.** O cache com teto que expulsa e refaz é proibido
(`OTIMIZACAO.md` #12, #2). A tentativa de `BatchedMesh` já custou 1,1 GB de heap
(`buildings/buildingMesh.ts:3546-3549`). Então a residência só vale se **voltar for barato**: o que
sai da placa tem de poder entrar de novo sem refazer a emissão.

**Correção (nesta ordem).**

1. **Orçamento, não alcance**: `massCells.choose` decide o que é "perto" pelo erro de tela (está
   certo e fica); a **residência** do detalhe passa a ser decidida pela soma de bytes do que está na
   placa — `memoryCounters.ts` já mede exatamente esse número por objeto (`bytesByName`), com a
   chave `building-shell-*` já classificada (`perfBudget.ts:129-140`).
2. **Sair da placa ≠ perder o trabalho.** Hoje a célula que sai solta as malhas *e* os arrays
   (`layer.ts`, `slim`); seu retorno paga a emissão inteira (~7 ms por prédio, `OTIMIZACAO.md` #16).
   O caminho certo é o que a pesquisa externa recomenda: o conteúdo que sai é **substituído pelo
   proxy** (a massa já existe e já é residente para todas as células) e o que volta chega de um
   **worker que devolve a célula pronta** (§4.7), com os arrays transferidos.
3. **Enquanto isso não existe, o orçamento pelo menos torna o custo visível e limitado** — e é o
   único passo que se pode dar sem tocar na arquitetura de emissão.

**Fonte.** Unreal World Partition HLOD ("o conteúdo das células não carregadas é substituído pelos
HLODs") e o refinamento `REPLACE` / `geometricError` do [3D Tiles](https://github.com/CesiumGS/3d-tiles/blob/main/specification/README.adoc);
a mesma conclusão está em `docs/CIDADE-10KM.md` §"Como os outros resolvem".

---

### 4.3 A geometria que já está na placa continua na CPU (ALTO)

**Onde.** `src/render/roadSurfaces.ts:146` (`readonly tiles: Map<string, Map<number, TileBundle>>`) e
`:161` (`chunks`) — todos os ladrilhos das vias, para sempre. `src/render/mesh/gpuOnly.ts` solta os
arrays **da malha** depois do envio; o ladrilho por baixo nunca é solto.

**O que custa.** 56 B por vértice + 4 B por índice de toda a rede viária, mantidos no heap depois de
já estarem na GPU. Medido hoje: **188,1 MB** de "geometria presa na CPU" na vista de rua (dos quais
os ladrilhos são a maior parte), dentro de um heap de 2,1 GB contra o orçamento de 1,5 GB.

**Por que não é simplesmente "apagar"**: o ladrilho é a fonte para refundir o bloco (`mergeTiles`) e
alimenta o `derivedCache`; apagar e refazer seria o cache que expulsa e refaz, proibido.

**Correção — encolher o dado, não apagá-lo.**

- **Vértice enxuto**: posição Int16 relativa à caixa do bloco (3×2 B), normal octaédrica (2×1 B),
  cor (4×1 B), `roadSection` (3×1 B) ⇒ **56 B → ~14 B** (4× menos heap), com o mesmo desenho: a
  posição volta a float no *vertex shader* com a caixa do bloco como uniforme — a técnica de
  quantização que o meshoptimizer chama de *vertex codec* (§5.1) e que o próprio projeto já lista
  como pendência ("vértice enxuto (48 → 12 B)", `docs/RELATORIO-DESEMPENHO-2026-10-14.md`).
- **Mesma técnica nas cascas de prédio** (48 B/vert) e nas massas (60 B/vert): o ganho vale para o
  heap *e* para o upload.
- Isto é pré-requisito do item 4.2: com o vértice 4× menor, o mesmo orçamento de bytes cobre 4× mais
  cidade residente.

**Fonte.** [meshoptimizer](https://meshoptimizer.org/) (vertex/index codec, quantização, filtros
octaédricos); `three/src/core/BufferAttribute.js` para o atributo inteiro como `Int16Array`
(three r186 aceita qualquer array tipado).

---

### 4.4 Orçamento de vértice: o que sobe à placa e ninguém lê (MÉDIO — ganho barato)

**a) Índice sempre Uint32 onde Uint16 cabe.** `src/render/buildings/cellArrays.ts:128` (massas) e
`:182` (cascas) fazem `new Uint32Array(indices)` sem perguntar o tamanho. Uma célula de 240 m tem
menos de 65 535 vértices, então **metade do upload de índice e ~12 B por vértice** são jogados fora
(aos ~2 triângulos por vértice, o índice custa ~24 B/vert em Uint32 contra ~12 B em Uint16 ⇒ ~17 % da
memória casca+índice). O caminho das vias **já acerta** isso (`surfaceTiles.ts:21`): falta aplicar a
mesma regra em `shellArrays`, `cellMass` e `meshTile`.

**b) Dois atributos mortos na faixa mais extensa do jogo.** `surfaceMesh.ts:400-407` escreve sempre
`color` (3 floats = 12 B) e `roadSection` (12 B) — 24 dos 56 B por vértice — com o argumento de que
"a material that declares `vertexColors` requires the attribute, and it is cheaper to write three
ones than to keep two variants of every road material". O argumento vale para as vias (asfalto,
calçada, meio-fio, faixa verde de fato usam a cor por vértice), **não para a faixa do *verge***: ela
vai para o material do terreno (`roadSurfaces.ts:611`, `renderer.ts:1748`), um material só para ela,
que **não declara `vertexColors`** (o do chão, `terrain.ts:1000-1014`; o `vertexColors: true` de
`terrain.ts:1973` é do material do corte, outro caminho) e **não lê `roadSection` em lugar nenhum**
(`grep` em `terrain.ts`: 0 ocorrências). É escritura e upload de 24 B por vértice, na faixa mais
extensa de cada via, sem um pixel de diferença. Correção: atributo só quando o spec pede (`tint` e
`section` já são parâmetros opcionais; a escrita é que é incondicional) — a faixa do verge é a única
que perde os dois.

**c) Geometria não-indexada onde caberia indexada.** `structures.ts:413-420` — cada quad de
parapeito, muro de contenção, backfill e portal empurra 6 vértices sem índice (32 B/vert); um corte
de 200 m com muro dos dois lados = 12 000 vértices (**estimativa**: 250 passos × 2 lados × 4 quads).
O mesmo em `vehicleModels.ts:298` (`toNonIndexed()` antes do merge) — todo veículo desenhado é
não-indexado, ~36 B/vert × 3 vert/tri. **Correção:** soldar após o merge
(`mergeVertices` com tolerância 1e-4 — a cor por vértice é constante por parte, `tint()` pinta a peça
inteira, então a solda não achata quina) e indexar as extrusões (4 vert + 6 índices por quad).

**Fonte.** Manual three r186 *Custom BufferGeometry*; [meshoptimizer](https://meshoptimizer.org/)
(`optimizeVertexFetch`, `generateVertexRemap`) — os dois já no projeto (`mesh/simplify.ts`).

---

### 4.5 Malhas em excesso: os corpos de assinatura não têm nível de longe (MÉDIO)

**Onde.** `src/render/buildings/massing.ts:146,157` — `emitMassing(..., signature = false)` e
`if (floor !== undefined && !signature)`; a API da camada (`townIndex.ts:80-107`) só tem
`set/remove/keepOnly`, nenhum `visible`.

**O que custa.** Um prédio comum troca ~13 mil triângulos de detalhe por **~56 triângulos de massa**
ao longe (medido pelo projeto). Um landmark (assinatura) **não troca por nada**: o corpo é *merged* de
centenas de caixas e prismas (`signature.ts:1788`) e é desenhado inteiro em qualquer afastamento.
**Estimativa**: 30 landmarks de ~30 mil triângulos = **~900 mil triângulos sempre desenhados**, sem
proxy barato, a qualquer distância, inclusive no mapa inteiro onde não se vê um caixilho.

**Correção.** Dar massa também à assinatura — o simplificador já está no projeto
(`mesh/simplify.ts`, usado em `kit.ts:546` e no carro far, `agents.ts:838`) — e amarrar a visibilidade
do corpo à célula (`cellNear(cellOf(b))`), um nível por vez, exatamente como o HLOD das células já faz.

**Fonte.** [BatchedMesh/LOD do three](https://threejs.org/docs/pages/BatchedMesh.html) e
[meshoptimizer](https://meshoptimizer.org/) (`simplify`); a mesma política já usada no veículo.

---

### 4.6 A simulação inteira na thread principal (ALTO — arquitetura)

**Onde.** `src/sim/pipeline.ts:58` (`step`), `src/main.ts:2791`
(`sim.clock.advance(wall, () => step(...), SIM_FRAME_BUDGET_MS)`), `src/sim/params.ts:21`
(`SIM_FRAME_BUDGET_MS = 8`), `src/sim/clock.ts:77` (o laço quebra ao estourar o orçamento),
`src/sim/populationGovernor.ts:36` (`HIGH_MS = 6.5`).

**O que custa.** 13,7 ms de CPU por quadro medidos pelo projeto (o maior item de CPU que resta), com
passos de 9-12 ms contra um orçamento de 8. Passado o orçamento a simulação **desacelera** e o
governador **tira população** — o custo é escondido (amortização), não corrigido. É o item 3 do
`OTIMIZACAO.md`, marcado `pendente (arquitetura)`.

**Correção (o plano já está escrito em `OTIMIZACAO.md:227` — confirmei que ele bate com o código).**
(a) o worker recebe o documento e a rede serializados na abertura e os deltas do diário a cada edição;
(b) a cada tick escreve num `SharedArrayBuffer` (com `postMessage` + transferência como *fallback*
sem `crossOriginIsolated`) as poses de veículos e pedestres, estados de semáforo e de trem, no formato
que `render/agents.ts` e `signals.ts` já leem (`vehiclePoseInto`, `pedViews`, `controller(node)`);
(c) a página mantém um `SimWorld` só de leitura alimentado por esses buffers, com interpolação por
`alpha` como hoje; (d) os leitores restantes (`ui/inspector`, `lotTool`, efeitos/ragdoll,
`simShowsMotion`) passam a ler o snapshot.

**Pré-requisitos que eu conferi no código** (e que fazem isto ser arquitetura, não edição pontual):

- `SimWorld` lê `w.doc` e `w.net` por referência (`sim/world.ts:680,698`);
- **não existe** `SharedArrayBuffer` nem `crossOriginIsolated` em lugar nenhum do projeto hoje
  (`grep` vazio): exige `Cross-Origin-Opener-Policy: same-origin` + `Cross-Origin-Embedder-Policy:
  require-corp` no `vite.config.ts` (que hoje só manda `Document-Policy`) **e** no protocolo do
  Electron (`desktop/main.cjs:59`, `protocol.handle`).

**Fonte.** [MDN, SharedArrayBuffer](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/SharedArrayBuffer) (isolamento entre origens);
Fiedler, *Fix Your Timestep!* (o relógio de passo fixo, já seguido em `sim/clock.ts`).

---

### 4.7 Gerar e abrir a cidade (ALTO — a parede do mapa inteiro)

**Onde e o que custa.**

| passo | onde | custo |
|---|---|---|
| traçado + `layCity` + troca do documento | `main.ts:2150-2158` | ~0,8-1,5 s **síncronos no clique** (`OTIMIZACAO.md` #14, pendente) |
| crescimento dos prédios | `main.ts:2195-2268` (`GROW_SLICE_MS = 100`) | medido hoje: **23,7 s** de fatias dentro de 67,1 s até a cidade de pé |
| emissão de cada prédio | `render/buildings/layer.ts` | ~7 ms por prédio (p90 8,8; máximo 15,6 — medido pelo projeto em 2026-10-14) |
| abrir o mapa salvo | `main.ts:207,240`, `history.ts:151-157` | 3 s para 1 530 prédios (comentário do projeto); a 80 mil prédios, minutos |

As fatias de 100 ms são **amortização declarada** (`OTIMIZACAO.md` #13, "em parte amortização"): a
causa é o custo de cada prédio crescido — que continua aberto.

**O que já está certo e não se mexe:** a resposta dos pares de conflito em até 4 workers
(`conflictPool.ts`), o cozimento de pessoas, a fratura, a ecologia, a luz do terreno, o acolchoado, o
LOD de pessoas e as massas de prédio (`cellPool.ts`) — todos com transferência de buffers.

**Correção.**

1. **Emissão de prédio em worker, devolvendo a célula pronta** — não um chunk por prédio. A tentativa
   de 2026-10-14 (`OTIMIZACAO.md:219`) mostrou que um chunk por prédio **piora** (desserializar
   dezenas de arrays por prédio devolve 2,1 s de mensagens e quadros de 103-182 ms): o certo é o
   worker guardar os chunks e devolver a **célula montada** (junção dos arrays lá dentro, transferida;
   o padrão `combineGeometry`/`packCombineGeometryResults` do Cesium). A página só embrulha e envia.
2. **Traçado e crescimento em worker**, com o chão amostrado: o gerador é dado puro — a única
   dependência de cena é `groundAt`/`pavedAt` (`main.ts:2251`), que é analítico
   (`world/terrain.ts:312-364`). O worker recebe o campo de alturas (ou calcula do `TerrainIndex`) e
   devolve nós, segmentos, lotes e prédios como buffers.
3. **Abrir o salvo**: `JSON.parse` + migração são puros — cada parte (já vem em gzip do IndexedDB,
   `chunkedSave.ts`) pode migrar em worker e devolver registros por transferência.

**Fonte.** Cesium `TaskProcessor` e `PrimitivePipeline.combineGeometry` (citados em `OTIMIZACAO.md`);
[MDN, Worker.postMessage](https://developer.mozilla.org/en-US/docs/Web/API/Worker/postMessage) sobre transferência.

---

### 4.8 Terreno: reenvio integral, carimbo refeito, cache que expulsa (ALTO)

**a) Cada dab de escultura reenvia os buffers da placa inteiros.** `terrain.ts` **não tem um único
`addUpdateRange`** (conferi: `grep` devolve 0) contra 21 `needsUpdate = true`, entre eles
`:2386` (position), `:2492-2493` (normal, steep), `:2250` (índice). Por placa:
position 321²×3×4 = 1,24 MB + normal 1,24 MB + aSteep 0,41 MB + índice 320²×6×4 = 2,46 MB ⇒
**~5,35 MB por dab por placa** (estimativa), mesmo movendo 200 cantos. Um traço de pincel com 1-2
placas visíveis reenvia 320-640 MB/s. O projeto **já faz certo** em `instanceRuns.ts:494-497`,
`poleLayer.ts` e `agents.ts:2372-2395`. **Correção:** `addUpdateRange` por faixa de linhas nos quatro
atributos; a lista de índices mudados já existe (`changed`).

**b) Uma placa atingida por carimbo se constrói inteira na página e joga fora o mesch do worker.**
`terrain.ts:3084`: `const made = firstBuild && prebuilt && doc.terrainStamps.length === 0 ? prebuilt : null;`
— se **um** carimbo alcança a placa, o update cai em `rewrite(0, GRID-1, …)` +
`computeVertexNormals` (204 800 tri) + `refreshAllSteep` + `retriangulate` na thread principal. O
comentário do próprio worker mede **~35 ms de um quadro** (`plateMesh.ts:10`). O mapa padrão tem 25
carimbos grandes (`defaultTown.ts:140-234`), então as placas do town pagam isso toda vez que entram
em cheio — e de novo quando voltam. Pior: `woods = made?.woods ?? null` (`:3087`) descarta a
densidade de madeira calculada no worker (167 281 células/placa), que a varredura da natureza então
recalcula na página. **Correção:** mandar os carimbos **da placa** ao worker (já são cópias locais) e
o `TerrainIndex`; ou aplicar as normais/steep do worker como base e reescrever só a caixa de cada
carimbo (`shapeToRoads` já faz exatamente isso por região).

**c) O cache de placas expulsa e refaz.** `flatAtlas.ts:40` (`const CACHE = 6`, "the oldest let go
first") e `:288-296` (`letGo` faz `dispose()` e zera `heights` e `mesh`). Ao voltar: o worker relê os
321² cantos, `createTerrainSurface` novo, ecologia nova, luz nova, normais novas — e, com carimbo, os
35 ms do item (b). As placas **com conteúdo nunca são soltas** (`:300`), então um mapa com edições
espalhadas mantém placas residentes para sempre, sem orçamento. **VRAM por placa** (estimativa do
código): geometria ~5,3 MB + `shore` 1,65 MB + ecologia 0,41 MB + `paint` 3,1-12,6 MB; **heap
~14 MB/placa** (`grid`+`natural` 824 kB cada, `biomeCorners` 2,47 MB, position+normal 2,47 MB,
`EcologyField` ~3,3 MB). **Correção:** residência por **bytes** (o `memoryCounters` já mede), não por
contagem, e o que sai **mantém o `PlateMesh` na CPU** (cantos, normais, flip, woods) — que é pequeno
justamente por ser os mesmos números — para voltar sem refazer.

**d) A varredura da natureza é fatiada 1 placa por quadro** (`renderer.ts:2205`, com o comentário
`:2166-2171`: "each was some 35 ms"): amortização explícita. **Correção:** a densidade é pura — vai
ao worker com os cantos que o worker já tem.

**e) Sem LOD contínuo do terreno.** `flatAtlas.ts:95-99` (`FAR_QUADS = 32` por placa ⇒ **64 m por
quad** contra 6,4 m da placa em cheio) com saia de 30 m para esconder o degrau. As árvores longe
dissolvem por *alpha-to-coverage*; o **terreno troca de malha num quadro** (popping de silhueta e de
sombreado numa placa de 2 km). **Correção:** quadtree com *geomorphing* (o vértice cujo pai é mais
grosso move-se para a altura do pai por `t` do erro de tela) — a técnica que o módulo já cita — ou
clipmap por anéis; a troca passa a ser contínua e a saia pode sumir.

**f) Menores:** `biomeCorners` alocado sempre (2,47 MB/placa, ~37 MB em 15 placas) mesmo sem bioma
pintado; `farIndexInto` reescreve e reenvia até 768 kB de índice a cada mudança do conjunto de placas;
`groundOn` bilinear pode divergir do `bare` exato na fronteira entre placas.

**Fonte.** Manual three r186 *How to update things* (`addUpdateRange`); Proland/quadtree com
geomorphing (a "split rule" citada no módulo); [InstancedMesh2](https://github.com/agargaro/instanced-mesh)
para o padrão de capacidade que cresce sem teto.

---

### 4.9 Agentes, multidão e física: alocação e trabalho por quadro (MÉDIO-ALTO)

**a) Ragdolls alocam por corpo por quadro.** `ragdoll.ts:2012-2018`:
`world.push(new Matrix4().compose(pos, q, body.scl0[i]!))`; `:2027-2034` (`new Matrix4()`,
`new Float32Array(bones * 16)` **dentro do laço de peças**); `:1989/1996` (`new Quaternion()` por
parte); `:1463` (`new Vector3()` por corpo por subpasso); `ragdollJolt.ts:361-377` (`push`/`pull`
alocando por partícula). Até 40 corpos × 12 partes × ~53-80 ossos ⇒ **~3 200 `Matrix4` + ~3 200
`Quaternion` + ~30 KB de paleta por corpo por quadro** enquanto não dormem (estimativa). **Correção:**
paletas e matrizes em buffers persistentes (pool por corpo, `Float32Array` plano/SoA), escrita direta
na textura de palheta da instância.

**b) Cada corpo que cai reconstrói o campo de altura da física.** `ragdoll.ts:1520-1535`
(`physics.ground(cx-half, cz-half, n, cell, …)` com n = 128/256; `physics.prism(…)`),
`ragdollJolt.ts:127-140`. 40 corpos nascendo juntos = **0,65-2,6 milhões de `groundAt` + 40 shapes de
height field num quadro** (estimativa), e nada é compartilhado entre corpos a 2 m um do outro.
**Correção:** um height field por célula, arquivado e atualizado só quando o diário toca a célula;
prisms por célula — como o Jolt prevê com blocos.

**c) `wallsNear` varre a frota inteira por corpo que cai.** `playEffects.ts:307-313`:
`[...(ragdollSim?.ambient.parked ?? [])].filter(…)` e `[...(ragdollSim?.vehicles.values() ?? [])].map(…)`
chamado de `ragdoll.ts:533` (`world.wallsNear(x, y, m(35))`) no nascimento de **cada** corpo. Com
~700-1 200 veículos vivos, uma explosão de 40 corpos = **~48 000 `vehiclePose` e ~100 000 objetos num
quadro** (estimativa). **Correção:** montar a lista uma vez por explosão/quadro e filtrar pelo índice
espacial (`solidsOf(doc).near`, já usado logo acima, `playEffects.ts:292`).

**d) `pedPose` aloca 3 objetos por pedestre por quadro.** `sim/pose.ts:261-267`, chamado em
`agents.ts:2302` para até `MAX_PEDS = 1000` ⇒ ~3 000-4 000 objetos/quadro (estimativa). O caminho dos
**veículos já corrigiu exatamente isso** (`vehiclePoseInto`, `pose.ts:106-110`, que registra o custo
antigo: 48 MB em 10 s). **Correção:** `pedPoseInto(ped, alpha, out)`.

**e) Multidão cozida: mistura de palheta na CPU e cópia por pessoa.** `riggedCitizens.ts:780-794`
(`blendPackedFrames` por clipe por osso na CPU) e `:905-912`
(`kept.palette.set(batch.pixels.subarray(...))` — 80 ossos × 16 floats = **5 120 B por pessoa por
quadro**); `:1143` (`new Float32Array(batch.width)` por chamada). A multidão **procedural já faz isto
na GPU** (passe de palheta, `crowdAnimation.ts:169-192`, com `renderPalettes` antes do desenho).
**Correção:** levar ocupantes/rider/kerb pelo mesmo caminho da procedural; no mínimo, a mistura num
worker e a cópia só quando um ragdoll a pedir.

**f) Física: passo único, single-thread, dentro do `sync` do desenho.** `ragdoll.ts:1091-1103`
(até 9 passos de Jolt de 1/90 s por quadro), `ragdollJolt.ts:104` (`mMaxWorkerThreads = 0`).
**Correção:** passo só com corpo acordado e `maxWorkerThreads` do Jolt exercitado.

**O que está certo e não se mexe** (conferido no código): veículos instanciados por classe+estilo com
cor por atributo de instância, ~150-170 malhas, sem variantes de programa por cor; LOD de veículo em
3 faixas com histerese e teto de 200 inteiros; pedestres por pixels com culling próprio antes de
qualquer trabalho por agente; buffers com `addUpdateRange`; pele na GPU na multidão procedural;
governador de população.

**Fonte.** [InstancedMesh2](https://github.com/agargaro/instanced-mesh) (skinning e uniforms por
instância), `docs/PLANO-ESPINHA-2026-10-14.md` (a palheta na GPU já é o caminho do projeto).

---

### 4.10 O laço: revisão global, chaves de cache, JSON (MÉDIO)

O motor central (`core/engine.ts`) está funcionando — a medição de hoje mostra **0 chaves** de
trabalho num refresh ocioso. O que sobra é o que ainda não foi convertido:

- **196 leituras de revisão global em 36 arquivos** (`eslint-suppressions.json`, regra
  `roadcraft/no-global-revision`) — as maiores: `renderer.ts` 42, `doc.ts` 23, `flatAtlas.ts` 19,
  `main.ts` 17, `sim/world.ts` 8, `terrain.ts` 7. O `CLAUDE.md` já nomeia o método:
  `terrain.ts`, `flatAtlas.ts`, `main.ts` por converter.
- **9 chaves de cache com revisão global** (o acusador as lista): `lorryDocks.ts:477` (`yardKey`),
  `render/buildings/layer.ts:465`, `renderer.ts:2611` e `:3116`, `lotTool.ts:140` e `:224`,
  `connectorPanel.ts:75`, `inspector.ts:137`, `main.ts:883`. A chave certa é **o que a saída lê**
  (o diário por tipo e lugar).
- **33 comparações por `JSON.stringify`** (acusador), a maioria em `world/doc.ts` (`:1179`, `:1229`,
  `:1366`, `:2021-2085`, `:2794`, `:2829`). As do `replaceContents` só rodam quando o diário diz que
  o tipo andou (metade do problema já resolvido por `4` do `OTIMIZACAO.md`), mas a comparação em si
  continua serializando listas inteiras.
- **Alocação por quadro** (baixa, mas soma a 60 Hz): `world/derived.ts:117,125` — **dois `new Set()`
  por produto por refresh**, mesmo sem nada mudar; `core/engine.ts:138` (`busy: string[]` por fase);
  `core/health.ts:198,204` (`new Map` por quadro); `sim/world.ts:486` (`junctionHolders()` novo a
  cada `signalDeps`). **Correção:** `clear()` e Sets reaproveitados no objeto.

**Fonte.** Salsa (`revisions` por durabilidade), já citada em `OTIMIZACAO.md`; Nystrom, *Dirty Flag*.

---

### 4.11 Passes, sombras e overdraw (MÉDIO)

- **10 passes de tela cheia por quadro de dia** (a lista de passes foi medida ao vivo — `RenderPass`,
  `GTAOPass`, `ShaderPass`, `BloomPass` desligado, `ShaderPass`, `SMAAPass`, `OutputPass`; a soma de
  ~47 Mpx de sombreamento a 2880×1620 é **estimativa** da conta dos passes): cópia
  do alvo, `sharpMask`, GTAO (2 half + 2 full), canyon, nuvens, SMAA (3 full), OutputPass. O
  `EffectPass` fundido do pmndrs já foi adotado para tone mapping+grade (`OTIMIZACAO.md` #6); o que
  resta é o GTAO.
- **O `GTAOPass` aloca um `normalRenderTarget` que nunca desenha** (`postprocess.ts:262`, e o
  `setGBuffer(depth)` de `:287` desliga o gbuffer) ⇒ ~14 MB ociosos (estimativa). **Correção:** passar
  `parameters.depthTexture` no construtor (o alvo não é criado) e tirar o `setGBuffer`.
- **A AO custa 2 passes full-res para ser um `blendIntensity` de 0,85.** **Correção:** multiplicar o
  passe do canyon pela AO desenoisada (half-res, bilinear) e fixar `gtao.output = Off` ⇒ ~9,3 Mpx a
  menos por quadro, sem mudança visual.
- **O céu é desenhado primeiro** com `depthTest: false` (`environment.ts:355-358`): ~4,7 M
  fragmentos baratos por quadro sempre. **Correção:** céu por último com `depthTest: true`
  (mantendo `depthWrite: false`) — mesmo pixel final, metade das escritas vira rejeição por
  profundidade.
- **Sem z-prepass** e a ordem dos opacos é por material (three ordena por `material.id` antes do `z`,
  com o buffer invertido tratado). Não é defeito hoje, mas é o que se olharia se aparecer custo de
  overdraw — não há linha de orçamento para overdraw.
- **Compilar shader em jogo: OK.** `compileAsync` é usado com o alvo certo e com a variante de
  sombra (o stand-in de `uploads.ts:77-107` é o que evita compilar o programa errado); medido, 8
  programas e 29 texturas entram durante o jogo sem travar o quadro; o `checkShaderErrors` está
  desligado em produção (`renderer.ts:494`).
- **A grade de sombra do chão: OK** — texel inteiro (`environment.ts:245-310`), sol preso até andar
  `SUN_STEP = 0.1°`, chão fora do passe de sombra (180 mil triângulos a menos).
- **`depthConvention`: OK** — todos os passes que leem profundidade usam `DEPTH_GLSL`, buffer 32F
  invertido, `pullTowardEye` corrige o sinal do `polygonOffsetUnits`.

**Fonte.** pmndrs/postprocessing (passes fundidos); GTAO do three r186 (`GTAOPass.js`, `setGBuffer`).

---

### 4.12 Texturas: o problema é formato, não tamanho (BAIXO hoje, MÉDIO na cidade grande)

Medido: **52-55 MB** de textura na placa, contra orçamento de 600 MB. O que há para corrigir não é
tamanho, é **formato** e **decodificação**:

- **Zero texturas comprimidas de GPU** no repositório (`find`: 0 `.ktx2`/`.basis`/`.dds`): tudo
  decodifica para RGBA8 (ou float) na memória da placa.
- **Os PNG dos elementos são 2048² sem compressão**: `Leaves.png` (2,5 MB em disco) e
  `Rocks_Diffuse.png` (2,5 MB) ⇒ **~21 MB de VRAM cada**; os 6 PNG somam ~60 MB (≈24 MB se
  comprimidos). **Correção:** KTX2 + `KTX2Loader` (ETC1S para albedo, UASTC onde aparece de perto),
  transcodificado para BC7/ASTC na placa. **É ganho puro** — não muda um pixel.
- **As 1 023 folhas `.webp` de roupa, cabelo, pele e rosto** (contadas hoje: 984 em
  `proxies/` + 39 em `skins/`, **16,7 MB** em disco no total): o custo não é o disco, é a
  **decodificação e a residência** — uma folha 512² em RGBA8 com mipmaps ocupa ~1,4 MB na placa, e
  o jogo já descarta por refcount (`skinAppearance.ts:615-651`). **Não medi quantas ficam residentes
  ao mesmo tempo**; se a cidade grande passar a manter muitas, é aqui que a VRAM cresce. Mesma
  correção (KTX2), e aí a residência fica barata.
- **Duplicação pequena**: as texturas de detalhe existem como 2-D (materiais de via) **e** como
  `DataArrayTexture` (terreno) — ~5,6 MB extra; os bakes de rocha ficam só na CPU (18 MB de canvas)
  enquanto o array (16,8 MB) é o que sobe.
- **O que está certo:** sRGB correto (albedo `srgb`, normal/rough/dados sem), mipmaps e anisotropia
  por tier nas que são amostradas, 223 materiais distintos com 183 programas (cache por chave de
  texto, `customProgramCacheKey`), nenhum material criado em refeitura na área conferida, e os campos
  de dados (névoa, altura, pintura, shore) corretamente sem mipmap.

**Fonte.** [three.js KTX2Loader](https://threejs.org/docs/pages/KTX2Loader.html) (transcodificação
Basis Universal para BC7/ASTC/RGBA32, `detectSupport`, `setWorkerLimit`); ver §5.5 para o critério de
quando vale.

---

### 4.13 Dados, abertura e entrega (MÉDIO)

- **Registro de prédio ~7 KB de JSON** (`OTIMIZACAO.md` #8): 1 348 prédios ≈ 9 MB de texto; a 80 mil,
  ~600 MB. O autosave **já** é por partes com gzip e só grava as partes sujas
  (`chunkedSave.ts:110-163`) — o que resta é `:146` montar `records.map(JSON.stringify).join(',')`
  de 512 prédios por parte na callback ociosa, e o tamanho do registro em si (o item 8 é decisão do
  jogador: exige gerador versionado).
- **`openImported` clona todo prédio por JSON** (`main.ts:2319` → `doc.toJSON()` →
  `store.ts:247-249` `cloneBuilding`): só no clique de abrir arquivo, mas com 80 mil prédios é o
  mesmo custo do item acima. **Correção:** guardar o "before" pela imagem de undo (`DocImage`), que já
  copia só o que o diário diz que mudou.
- **Tetos que apagam o trabalho do jogador**: `MAX_PLANTED_TREES = 20_000` (`trees.ts:50`),
  `MAX_PAINT_DABS`, `MAX_ELEMENTS`, `MAX_GULLY_DABS`/`MAX_FOG_DABS`, `MAX_TERRAIN_STAMPS`,
  `MAX_PLACED_CLOUDS` — todos "the oldest go first" (`doc.ts:1236` faz
  `trees.splice(0, n)`). Não é custo de quadro: é **perda de dados silenciosa** no caminho "cidade
  sem limite", e o `splice(0, n)` é O(n). **Correção:** orçamento por célula de 64 m (como `treeCells`
  já é) ou compactar os dabs antigos num campo/textura em vez de descartá-los.
- **Teto do undo**: `history.ts:127-131` descarta os passos mais antigos por orçamento de bytes —
  perda de dados do jogador. **Correção:** delta contra o passo anterior em vez de descarte.
- **Entrega** (medido hoje, em bytes): `dist` = **471 MB**; as fontes são `public` 279 MB + `cooked`
  144 MB. Dentro disso, **390,1 MB são `.bin`** — 580 arquivos, média 689 KB —, quase todos os
  proxies MakeHuman (500 em `proxies/`, buscados **um a um por nome**, que é o certo: `proxy.ts:180-188`
  busca só o que a pessoa veste) mais os alvos de morfo (`targets-macro-pca.bin` 11 MB,
  `targets-local.bin` 6,4 MB). As imagens são **24,0 MB** (6 PNG = 7,3 MB; 1 023 `.webp` = 16,7 MB).
  Para a Steam o que importa: os `.bin` já são sob demanda, e os PNG grandes viram KTX2 (§4.12).

---

## 5. Técnicas modernas (pesquisa) — o que serve a **este** jogo

Pesquisado em 2026-10-15. Cada técnica com o que dá, o custo e a decisão para o Roadcraft.

### 5.1 Simplificação e cadeia de LOD — [meshoptimizer](https://meshoptimizer.org/)

O que a biblioteca oferece (lido na fonte oficial):

| função | o que faz | número |
|---|---|---|
| `simplify` | redução preservando topologia, costura e borda; `target_error` normalizado pela extensão | soldar antes, ou "get stuck" |
| `simplifyWithAttributes` | erro também nos atributos (normais, UV, cor), com pesos; UV 10-100 | base do LOD das pessoas |
| `simplifySloppy` | ignora topologia; junta o que está perto mas separado | pior qualidade geométrica |
| cadeia de LOD | re-simplificar do original (melhor) ou em cadeia (mais barato), acumulando o erro | recomendado: otimizar cada nível e montar do mais grosso |
| `optimizeVertexCache` / `optimizeOverdraw` / `optimizeVertexFetch` | ordem dos triângulos e dos vértices | overdraw: "from all directions", limiar 1.05 |
| codec de vértice/índice | lossless depois da quantização | vértice 2-4×, índice 1-1,2 B/tri, 3-6 GB/s |

**No Roadcraft.** Já é usado em três lugares (`mesh/simplify.ts` nas peças do kit e no carro far;
`people/crowdLod.ts` + `lodWorker.ts`; `people/personRig.ts`). O que **falta** e é o caminho já
apontado pelo próprio projeto (`OTIMIZACAO.md:177`): **casca de prédio simplificada por célula, com
erro abaixo de um pixel** — a única forma de reduzir os 25,7 M de triângulos da vista de rua sem
trocar detalhe por massa (a troca foi tentada e desfeita: 17,6 → 20,6 de diferença média, "a massa
ficou 12 % mais escura e ainda mais saturada").

### 5.2 Cluster LOD / meshlets — [zeux, *Billions of triangles redux* (2026)](https://zeux.io/2026/09/30/billions-of-triangles-redux/)

O estado da arte: dividir a malha em **clusters** (grupos), simplificar cada grupo preservando as
fronteiras, redividir, repetir — formando um **DAG**; em tempo de execução escolhe-se o nível por
cluster, e a seleção é feita com uma BVH sobre o DAG. Números do artigo (cena Zorah, 1,6 G de
triângulos): o processamento gera ~3,26 G (cada nível do DAG corta pela metade, ~2× o total); o codec
de meshlet leva o índice de 9,8 GB para ~2,6 GB (**6,5 bits por triângulo**) decodificando a 10 GB/s
por núcleo; `simplifyWithAttributes` com erro limitado pela área acumulada cortou a geometria de
996 MB para 678 MB.

**No Roadcraft: não adotar agora.** Exige pipeline próprio de geometria virtual (rasterização por
software dos triângulos pequenos, visibilidade em duas fases) que não existe no three e cujo custo de
implementação é maior que o ganho numa cena de 25 M de triângulos. O que **se aproveita**: (a) o
*método* — simplificar por grupo preservando fronteira é o que permite trocar LOD sem costura, e é
aplicável célula a célula; (b) o *número* — a quantização dá 4× de memória, que é exatamente o
"vértice enxuto" de §4.3. O próprio autor é ambivalente ("Should all engines embrace clustered LOD?
I'm still not sure").

### 5.3 LOD por instância — [InstancedMesh2](https://github.com/agargaro/instanced-mesh)

Culling por instância com BVH (que o autor marca como caro de atualizar se as instâncias se movem),
**LOD por instância** (`addLOD(geometry, material, distance)`) e **LOD de sombra**
(`addShadowLOD`), capacidade que cresce sozinha (1,5× + 512), uniforms por instância, skinning por
instância. A ressalva que interessa: o LOD é **por distância** (`useDistanceForLOD`), e o "por tamanho
em tela" está marcado como não suportado — a mesma limitação que o `docs/CIDADE-10KM.md` já anota.

**No Roadcraft**: as peças de prédio, a mobília e a vegetação usam `InstanceRuns` + `CandidateKeep` +
quadtree esparsa próprios, que **já fazem** culling por instância e faixa parcial de upload — não há
ganho em trocar. O que se aproveita é a **regra de capacidade** (`1,5× + 512`) e o LOD de sombra por
instância, para onde o projeto ainda decide sombra por texel.

### 5.4 Impostores — [floresta de impostores octaédricos, fórum three.js](https://discourse.threejs.org/t/a-forest-of-octahedral-impostors/85735)

200 mil árvores com LOD por instância: cheia → simplificada por meshoptimizer → **impostor
octaédrico** (billboard ao qual se aplica a normal octaédrica para o sombreamento). É o que permite
milhares de árvores por metro de tela.

**No Roadcraft**: o `farForest.ts` **já faz** impostores octaédricos por placa, com programa
pré-compilado e atributos só na GPU, e as árvores próximas sem LOD são **decisão declarada do
jogador** (`natureTrees.ts:19-29`). Nada a corrigir; fica registrado como o caminho se a vegetação
crescer.

### 5.5 Textura — [KTX2Loader](https://threejs.org/docs/pages/KTX2Loader.html)

KTX2 + Basis Universal: a textura fica **comprimida na placa** (menos VRAM que PNG/JPEG decodificados
para RGBA), um arquivo serve todas as plataformas (transcodifica no carregamento para BC7/ASTC/ETC/
RGBA32, escolhido por `detectSupport(renderer)`), e o transcoder roda em **Web Workers** (limitável
com `setWorkerLimit`). Ressalvas lidas: exige WebAssembly; o alvo é escolhido automaticamente, e sem
suporte a compressão a textura cai para RGBA32 (aí não há ganho de VRAM, só de download).

**Quando vale aqui:** (a) **sempre** para os elementos (6 PNG, 2048², ~60 MB → ~24 MB); (b) para as
folhas de roupa/cabelo **se** a residência passar a ser grande — hoje elas têm refcount e descarte e
custam pouco; (c) **não vale** para as milhares de texturas procedurais (canvas/`DataTexture`), que
não têm arquivo e são geradas na hora — o custo delas é o decode, não o formato.

### 5.6 Workers e simulação — [MDN, SharedArrayBuffer](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/SharedArrayBuffer)

Memória compartilhada exige contexto seguro **e** isolamento entre origens
(`Cross-Origin-Opener-Policy: same-origin` + `Cross-Origin-Embedder-Policy: require-corp`); sem isso
`postMessage` lança para `SharedArrayBuffer` e o caminho é transferir `ArrayBuffer` (cópia zero, mas
sem memória comum) — que é o *fallback* previsto no plano do projeto. A sincronização é por
`Atomics`. O projeto **já usa** os dois padrões onde importa (10 pools de worker, transferência de
buffers), e **não tem nenhum `SharedArrayBuffer`** hoje: o cabeçalho tem de entrar no Vite **e** no
Electron antes da simulação ir para o worker.

### 5.7 Streaming e cidade sem limite

O que já está no projeto e continua valendo como referência: **World Partition HLOD** (o conteúdo
não carregado é substituído pelo HLOD; só o *Loading Range* fica residente), **3D Tiles** com
refinamento `REPLACE` por `geometricError`, **`dynamicScreenSpaceError`** do Cesium (o erro permitido
cresce com a distância — já implementado em `massCells.choose`), cache por **bytes** em vez de por
contagem (`cacheBytes`/`maximumCacheOverflowBytes`), e o que derrubou o Cities: Skylines II
(LOD em tudo; sombra só do que tem tamanho em tela — a regra que o projeto já segue desde o #25).
A regra que atravessa todos: **fila por prioridade e o que sai é substituído pelo proxy, nunca
"desaparece"**.

### 5.8 GPU-driven (o que **não** fazer agora)

Desenho por *indirect* e culling na própria GPU (compute) existe em WebGPU e em WebGL2 com
`WEBGL_multi_draw`. Neste jogo o custo dominante **não** é a submissão (670-1 114 chamadas, dentro do
orçamento do projeto): é a **geometria** (25,7 M triângulos) e a **memória**. Migrar para WebGPU
trocaria a fundação por um ganho pequeno — e `InstancedMesh2`/`BatchedMesh` já mostraram que a
capacidade na CPU cobra caro neste projeto (`buildingMesh.ts:3546-3549`). Fica registrado como
caminho futuro, não como correção.

---

## 6. Ordem de ataque proposta

Ordem por **custo × risco**, com o pré-requisito de cada par. Nenhum item perde imagem; os que podem
mudar a imagem (**†**) são decisão do jogador, com foto antes e depois, nas mesmas vistas.

| # | o que | por quê primeiro | pré-requisito |
|---|---|---|---|
| 1 | **Medir os alvos de render e a sombra** (§4.1) | é a maior memória de vídeo do jogo e está fora da conta; sem medir, não se decide nada | nenhum |
| 2 | **Amostras de MSAA e tamanho do mapa de sombra como campo de qualidade** (§4.1)† | ~600 MB de uma vez, com uma foto | 1 |
| 3 | **Residência do detalhe por bytes** (§4.2) | 794 MB contra 300 MB de orçamento; é a causa do heap e da placa | 1 |
| 4 | **Vértice enxuto + índices Uint16 + atributos mortos** (§4.3, §4.4) | 4× menos heap e upload, e é pré-requisito para a residência caber | nenhum |
| 5 | **`addUpdateRange` no terreno + carimbo no worker** (§4.8a, b) | 5,35 MB por dab hoje; traço de pincel a 60 Hz | nenhum |
| 6 | **Emissão de célula em worker (célula pronta, não chunk)** (§4.7.1) | é o que faz "voltar" ser barato e destrava 3 | o desenho do item 3 definir o contrato |
| 7 | **Simulação em worker com `SharedArrayBuffer`** (§4.6) | 13,7 ms/quadro de CPU; arquitetura já especificada | COOP/COEP no Vite e no Electron |
| 8 | **Alocação por quadro nos ragdolls, `pedPose`, `wallsNear`** (§4.9a-d) | barato, local e sem risco; alivia GC e o pior caso de explosão | nenhum |
| 9 | **Casca simplificada com erro abaixo de um pixel** (§5.1) | o único caminho que resta para a vista de rua | 3, 4 |
| 10 | **Assinatura com nível de longe** (§4.5) | ~900 mil triângulos sempre desenhados | 9 (mesma técnica) |
| 11 | **GTAO: alvo ocioso + 2 passes full-res; céu por último** (§4.11) | ~9,3 Mpx/quadro, sem mudança visual | nenhum |
| 12 | **KTX2 nos 6 PNG dos elementos** (§4.12) | ~36 MB de VRAM e download menor, ganho puro | nenhum |
| 13 | **Revisões globais restantes e comparações por JSON** (§4.10) | é a dívida que obriga cada edição a olhar o mapa | um arquivo por vez |
| 14 | **Terreno com geomorphing** (§4.8e) | tira o popping de silhueta do quadro em que a placa troca | 5 |
| 15 | **Orçamento por célula no lugar dos tetos de lista** (§4.13) | para de apagar o trabalho do jogador | decisão do jogador |

**Regra de avanço (do próprio projeto, e eu concordo):** cada item vira um commit com a causa, a
técnica e a fonte, com uma linha no `OTIMIZACAO.md`, e a medida só vale acompanhada da foto de antes
e depois nas mesmas vistas.

---

## 7. O que **não** fazer (armadilhas já pagas ou que este relatório recomenda evitar)

1. **`BatchedMesh` para as cascas da cidade inteira** — a capacidade inteira fica na CPU
   (`_initializeGeometry` aloca `maxVertexCount × itemSize`): 1,1 GB de heap medidos, o jogo caiu para
   14 fps e a mudança foi desfeita.
2. **`needsUpdate = true` sem faixa** nos buffers de célula/placa — é o defeito de §4.8a, não a
   solução.
3. **Fatiar em quadros** o que é caro (crescimento da cidade, topologia, varredura da natureza):
   esconde o custo, que volta maior com a cidade maior. O que é puro vai para worker; o resto é causa
   a corrigir.
4. **Cache com teto que expulsa e refaz** (o `CACHE = 6` de `flatAtlas`, o cache LRU de chunks do
   render): o certo é o trabalho de volta ser barato (§4.2 e §4.8c).
5. **Trocar detalhe por massa na vista de cima** — tentado e medido: a diferença média piorou
   (17,6 → 20,6) e a massa ficou mais escura e mais saturada.
6. **Um chunk por prédio vindo do worker** — medido: as mensagens devolvem 2,1 s e pioram os quadros
   (37-101 → 103-182 ms). O worker tem de devolver a célula montada.
7. **`SharedArrayBuffer` sem `crossOriginIsolated`** — lança; os cabeçalhos têm de existir antes.
8. **Cluster LOD/Nanite caseiro** (§5.2) e **migração para WebGPU** (§5.8): custo de fundação maior
   que o ganho no tamanho de cena do jogo.
9. **KTX2 para as texturas procedurais** — não têm arquivo; o ganho é zero e o custo é real.
10. **Medir `performance.memory` como se fosse o heap exato**, ou confiar no contador de memória do
    jogo para VRAM: ele não vê alvos de render nem sombra (§4.1), que são hoje os maiores.

---

## 8. Anexos

### 8.1 A medida de hoje, crua

`node scripts/look.mjs scripts/look/auditoria.json` — Chrome headless, Intel UHD 770, 1920×1080,
`run-limited.mjs` (25 % CPU / 8 GB), cidade padrão gerada. Relatório completo em
`scripts/look/out-auditoria/relatorio.json`; fotos `02-aud-mapa.png`, `07-aud-bairro.png`,
`11-aud-rua.png`; perfil `16-rua.cpuprofile`.

**Duas execuções, não uma.** Os números das três vistas e do perfil são desta execução. Os da
contagem de materiais/programas/texturas ao vivo (223 materiais, 183 programas, 57
`customDepthMaterial`, a lista de passes, o `shadowMap: [4096, 4096, 1009, 1014]`) vêm de uma segunda
execução do mesmo `look.mjs`, na cidade de 1 km, feita na leitura da área de materiais — mesma máquina,
mesmo método, `dpr` 2 (canvas 2880×1620). O `shadowMapSize` e a conta dos alvos de render foram
conferidos por mim na fonte do three r186 (§4.1), não só na medida.

```
cidade pronta em 67.1 s (crescimento 23.7 s)
mapa:   3 158 296 tri · 277 chamadas · heap 1 099,8 MB
bairro: 23 291 146 tri · 1 114 chamadas · heap 1 725 MB
rua:    25 680 496 tri · 670 chamadas · heap 2 115,6 MB · geometria na GPU 1 169,7 MB
        geometria presa na CPU 188,1 MB · texturas 55 MB
        topo do heap por objeto: terrain-ground 55,5 MB · citizen-mh_* 4-7 MB cada
perfil (4,45 s): 12 quadros > 50 ms (pior 254 ms)
console: 1 aviso do driver Intel (soma em precisão dupla, inofensivo)
```

### 8.2 O que a análise estática do projeto já acusa (rodada hoje)

`node scripts/acusar.mjs` → relatório em `%TEMP%\roadcraft-acusacoes.md`:

| regra | quantas | onde estão as maiores |
|---|---|---|
| `check-code` (só podem diminuir) | 396 | baseline |
| `comparação por JSON` | 33 | `world/doc.ts` (13) |
| `recorte-desligado` (`frustumCulled = false`) | 36 | quase todas certas (instâncias com volume próprio) |
| `buffer-inteiro` (`needsUpdate` sem faixa) | 17 | `terrain.ts` (9) |
| `remove-sem-dispose` | 13 | confirmar caso a caso |
| `chave-revisao-global` | 9 | §4.10 |
| `criado-em-laco` | 8 | `finishes.ts`, `blast.ts`, `riggedCitizens.ts` |
| `material-needs-update` | 6 | — |
| `posicao-sem-volume` | 4 | `agents.ts:2430`, `playEffects.ts:152` (recorte pode errar) |
| `leitura-da-gpu` | 4 | `textureBaker.ts:37`, `terrain.ts:835`, `referenceModel.ts:122` |
| `geometria-trocada` | 1 | `proceduralCrowd.ts:1296` |

`eslint-suppressions.json` (só encolhe): **619 supressões**, sendo
`no-module-state` 266, `no-global-revision` **196** (36 arquivos), `no-silent-catch` 108,
`max-lines` 35, `no-whole-map-walk` 10, `no-logic-timer` 4.

### 8.3 Fontes lidas nesta auditoria

- Fonte e manual do three **r186** instalados: `repo-r186/src/renderers/webgl/WebGLShadowMap.js:227-269`;
  manual *How to update things*, *How to dispose of objects*, *Optimize lots of objects*,
  *Matrix transformations*, *Rendering on demand*; `GTAOPass.js`.
- [meshoptimizer](https://meshoptimizer.org/) — página oficial (simplificação, LOD, meshlets, codec).
- [zeux, *Billions of triangles redux* (2026-09-30)](https://zeux.io/2026/09/30/billions-of-triangles-redux/).
- [InstancedMesh2 (agargaro)](https://github.com/agargaro/instanced-mesh) — e o exemplar local em
  `C:/Codex-Shared/referencia/instanced-mesh`.
- [three.js KTX2Loader](https://threejs.org/docs/pages/KTX2Loader.html).
- [A forest of octahedral impostors (fórum three.js)](https://discourse.threejs.org/t/a-forest-of-octahedral-impostors/85735).
- [MDN SharedArrayBuffer](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/SharedArrayBuffer)
  e [Window.crossOriginIsolated](https://developer.mozilla.org/en-US/docs/Web/API/Window/crossOriginIsolated).
- [3D Tiles (refinamento, `geometricError`)](https://github.com/CesiumGS/3d-tiles/blob/main/specification/README.adoc)
  e `Cesium3DTileset.dynamicScreenSpaceError`.
- Já no projeto: World Partition HLOD (Epic), Salsa, Nystrom (*Dirty Flag*, *Spatial Partition*),
  Huhtala (Cities: Skylines II), Burghout (tráfego híbrido).

### 8.4 Áreas e arquivos lidos (para conferir um achado)

| área | arquivos principais |
|---|---|
| malha e geometria | `render/buildings/{buildingMesh,cellArrays,massing,signature,kit,finishes,layer,massCells,cellPool,townIndex}.ts`, `render/mesh/{surfaceMesh,surfaceTiles,simplify,gpuOnly}.ts`, `render/{structures,roadSurfaces,vehicleModels,carBody,blast}.ts` |
| terreno e natureza | `render/{terrain,flatAtlas,groundCover,natureTrees,farForest,plantCells,instanceRuns,candidateKeep}.ts`, `world/{elevation,bounds}.ts` |
| materiais, texturas, pós | `render/materials.ts`, `render/postprocess.ts`, `render/environment.ts`, `render/quality.ts`, `render/depthConvention.ts`, `render/memoryCounters.ts` |
| agentes, multidão, física | `render/{agents,ragdoll,ragdollJolt,riggedCitizens,playEffects}.ts`, `render/people/*`, `sim/params.ts`, `sim/pose.ts` |
| laço, motor, workers | `main.ts`, `core/*`, `sim/{pipeline,world,clock}.ts`, `world/{doc,derived,changes}.ts`, `editor/{commit,chunkedSave,persistence,history}.ts`, `frameLoop.ts`, `render/uploads.ts` |

### 8.5 Arquivos criados por esta auditoria

- `docs/AUDITORIA-2026-10-15.md` (este relatório);
- `scripts/look/auditoria.json` (roteiro da medição, para repetir com um comando);
- `scripts/look/out-auditoria/` (fotos, orçamentos, perfil).
