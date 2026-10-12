# Mapa plano completo, do tamanho do globo (fila do PLANO, item 11)

Pedido do jogador (2026-10-11): "no modo plano tem que ter o mapa completo do
mesmo tamanho que é no globo".

## Hoje

- **Modo plano:** uma placa de terreno de 1,92 × 1,92 km (3,7 km²,
  `world/bounds.ts` `MAP_SIZE`, `render/terrain.ts`), relevo por carimbos, sem
  continentes.
- **Planeta:** 6 faces de 6 × 6 km (cerca de 216 km²), 864 peças planas lado a
  lado num atlas (`world/planet/atlas.ts`). Cada peça tem uma placa de terreno
  carregada sob demanda (`render/planet/terrainAtlas.ts`), o chão leve de longe
  vem de `globeGround.ts`, e o relevo da Terra (continentes, oceano, gelo) é
  lido por direção na esfera: `world/planet/relief.ts` `earthHeight(sx, sy, sz)`
  e `world/planet/ice.ts`.

## Desenho

- **Projeção:** equirretangular (o mapa-múndi clássico, 2:1) com a mesma área
  do globo: cerca de 20,8 × 10,4 km. Um ponto do plano vira longitude e
  latitude, que viram uma direção na esfera, que dá relevo, gelo e oceano pelo
  mesmo código do planeta. Os polos ficam esticados em faixas, como em todo
  mapa-múndi plano. Leste e oeste podem se emendar, se o jogador quiser.
- **Terreno em blocos:** uma grade plana de peças de 500 m (cerca de 42 × 21),
  carregadas sob demanda pela distância à câmera. É a mesma ideia das placas
  do atlas e do CDLOD (Strugar, https://github.com/fstrugar/CDLOD): resolução
  menor ao longe, com o chão leve distante e sem costuras. No plano as peças
  vizinhas são contínuas, então não há cartas nem imagens-fantasma: o mapa é
  um só plano.
- **Unidade e precisão:** 1 m por unidade. Com ±10 km, o float32 da GPU ainda
  dá cerca de 1 mm. Mesmo assim vale uma origem flutuante para a câmera, como
  já faz o planeta.
- **Mapas antigos (1,92 km):** abrem como uma região desse mundo, num lugar
  escolhido (por padrão a mesma longitude e latitude da cidade do jogador no
  globo). As vias e os prédios não mudam.
- **Desempenho:** entra nos orçamentos (`src/core/perfBudget.ts`): placas
  ativas, triângulos e draw calls no portão, e um passo `hitch:` para o
  carregamento de cada placa.

## Etapas

1. Amostrador do relevo no plano (projeção), com specs: continuidade e mesma
   altura que o globo no mesmo lugar.
2. O terreno do modo plano em blocos sob demanda, com o chão leve ao longe.
3. Limites do mundo (`MAP_REGIONS`) do tamanho novo; câmera, grade e minimapa.
4. Mapas antigos e salvamento.
5. Oceano, gelo e vegetação vindos do mesmo campo do planeta.
6. Portão de desempenho, fotos (rua, meia altura, alto) e a conferência do
   jogador.

## Estado (2026-10-11)

Feito e medido (sondas sem interface na 5177 e painel na RTX; ver `docs/PROBLEMAS.md` PL37 a PL40):

- **Etapa 1:** `world/flatEarth.ts` projeta a Terra equirretangular no plano (24,96 × 13,44 km em 13 × 7 placas de 1,92 km). O chão no plano é o mesmo do globo (spec com diferença abaixo de 1e-6).
- **Etapa 2:** `render/flatAtlas.ts` traz as placas inteiras perto da vista e mostra o resto num chão distante de uma só geometria, com um retalho de 32 × 32 por placa e saia (como o `globeGround.ts` do planeta). O índice deixa de fora as placas desenhadas inteiras.
  - Placa nova sem travar a tela, no modo assíncrono do Proland (desenha "o primeiro ancestral pronto"): o relevo e a primeira malha (alturas, diagonais, normais, inclinações) são calculados num worker (`flatGround.worker.ts`, `plateMesh.ts`, como o `createVerticesFromHeightmap` do Cesium), os buffers chegam transferidos sem cópia (MDN, "Transferable objects") e entra no máximo uma placa por quadro. As placas com vias ou prédios continuam síncronas.
  - Varredura de árvores amortizada (uma placa por quadro) e orçamento de árvores por área, como no planeta. Antes, no plano, o orçamento era o de uma placa só, e as últimas placas ficavam sem árvores.
- **Etapa 3:** `MAP_REGIONS`, `insideMap`, `clampToMap`, a câmera (até 7,4 km de meia altura, câmera ortográfica afastada pela profundidade h·cot(e)) e a grade cobrem o mundo inteiro.
- **Etapa 4:**
  - Um mapa antigo mantém o próprio relevo na placa dele e passa à Terra numa transição de 480 m.
  - O mar de um mapa antigo segue uma linha de nível do chão do mundo (0,3 m abaixo do nível do mar), nunca a borda da placa.
  - O chão das vias sobre o mar fica no nível do mar mais 1,5 m: via no chão vira aterro, via ponte vira ponte. A conta é contínua em toda parte (spec).
- **Etapa 5:**
  - Mar plano (`flatOcean.ts`): cor por profundidade, espuma e brilho, numa só draw call. É relido quando uma placa muda.
  - Gelo e climas da Terra no shader do chão: a direção na esfera vem da projeção, então calotas, plataformas, fendas, desertos e tundra são os do globo.
  - A laje do mundo (paredes cortadas com as camadas do mapa antigo, em toda a borda) e a lâmina d'água onde a borda corta o mar.
  - Névoa exponencial em altura (Quilez, "Better fog"; altura de escala de 1,2 km dos aerossóis).

### Navegação no plano (sonda `scripts/zz-nav-probe.mjs`, 5177, mapa vazio, sem cidade, iGPU)

| etapa | p95 | p99 | máximo | quadros > 50 ms |
|---|---|---|---|---|
| placas síncronas (antes) | 16,8 | 38,9 | 1 267 | 3 |
| relevo no worker | 20,8 | 96 | 142 | 12 |
| + máscara do mar pelos cantos | 16,8 | 47,3 | 110 | 5 |
| + malha pronta no worker | 21,1 | 48,6 | 167 | 4 |
| + densidade de bosques no worker, plantio por peça | 16,8 | 33,4 | 123 | 3 |

O `update` de uma placa caiu de 70–156 ms para cerca de 6 ms. Painel na RTX (teclas e roda): p95 16,8 ms, máximo de 33 ms.

### Falta

- O gelo marinho no mar plano.
- A criação da superfície (cerca de 15 ms por placa) ainda roda na thread principal.
- Fazer a medida sustentada com cidade de 400/400 nos dois modos, salvar e recarregar longe da cidade, e editar nas bordas do mundo.
