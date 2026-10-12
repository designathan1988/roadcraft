# ESCALA — 1 unidade do mundo = 1 metro

Estado: análise (fase 1), 2026-10-10. A fase 2 (a troca) é registrada no fim
deste arquivo, passo a passo, com o que foi medido e visto em cada um.

## O problema

`src/world/units.ts` define `METERS_PER_UNIT = 0.4`: uma unidade do mundo vale
40 cm. A escolha veio do V6 (larguras de via 15/22/34/46 lidas como 6/8,8/13,6/
18,4 m). O planeta (`core/cubeSphere.ts`) diz `FACE_HALF = 3000` "metros", mas
são 3000 **unidades** = 1,2 km: as faces têm 2,4 km de lado e o raio é
~1,5 km, não os 6 km de face e ~3,8 km de raio pretendidos. Por isso o
horizonte e a atmosfera parecem apertados em volta da cidade.

O jogador quer a escala certa: 1 unidade = 1 metro.

## A regra (o que muda e o que não muda)

Há três tipos de número de comprimento no código:

1. **Escrito em metros com `m()` / `kmh()`** (≈ 2 200 chamadas): carro, faixa,
   pavimento, calçada, pessoa, velocidade. Esses mudam sozinhos ao trocar a
   constante e continuam com o mesmo tamanho em metros. Nada a fazer.
2. **Literal em unidades calibrado a 0,4 m** (ex.: `EYE_HEIGHT = 4.25` "1,7 m a
   0,4 m a unidade", `MIN_HALF_HEIGHT = 2`, `SUN_DISTANCE = 1600`,
   `ASPHALT_TILE = 26`, `TERRAIN_MAX_HEIGHT = 560`, `MAP_SIZE = 4800`). Depois
   da troca ficariam 2,5× grandes. **Cada um vira `m(valor × 0,4)`** — escrito
   com o valor em metros, que a 0,4 dá exatamente o mesmo número de hoje.
   Inversos de comprimento (frequência de ruído por unidade, `zoom` em pixels
   por unidade, densidade de neblina por unidade, repetição de textura por
   unidade) viram `perM(valor / 0,4)`: um novo helper `perM(x por metro)` em
   `units.ts`. Áreas: `m(a) * m(b)`. Literais GLSL entram no shader pela
   interpolação de uma constante TypeScript escrita assim.
3. **Escala do planeta** (`FACE_HALF`, `PLANET_RADIUS`, peças/`TILES_PER_SIDE`,
   `TILE_REACH`, `ATLAS_PITCH`, `PLANET_MAX_PIECE`, relevo dos continentes,
   fundo do oceano, alturas da atmosfera derivadas de `R`, Lua). **Ficam em
   unidades**: o planeta mantém o mesmo número de unidades e, com 1 m por
   unidade, passa a medir o que o jogador pediu (faces de 6 km, raio
   3 820 m, montanhas de 175 m, fundo do mar a −150 m). O conteúdo humano é
   que fica 2,5× menor em unidades dentro de cada peça — ou seja, cabe 6,25×
   mais cidade por peça.

`src/core` não importa `world` (arquitetura): os poucos literais humanos de
`core` recebem o valor como parâmetro ou ficam com quem chama.

### Por que primeiro converter e só depois trocar

Converter um literal para `m(valor × 0,4)` com a constante ainda em 0,4 não
muda nenhum número do jogo: os testes atuais têm de continuar verdes
sem tocar em expectativa nenhuma. Isso prova cada conversão. A troca da
constante fica num commit pequeno no fim, quando tudo que depende da unidade
já passa por `m()`.

## Inventário (o que depende da unidade)

Medição feita com grep/leitura nesta árvore (157 mil linhas em `src`). Lista
dos pontos de maior efeito; o inventário arquivo por arquivo é refeito em cada
passo da fase 2 com o grep de conferência ao fim deste documento.

### Câmera e vista (`view/`, `render/isoViewport.ts`)
- `cameraProfile.ts`: `NEAR_HALF = 3`, `EYE_HEIGHT = 4.25` (1,7 m), os limites
  das misturas (`200`, `120`, `30`, `60`) — todos unidades → `m()`.
- `isoViewport.ts`: `MIN_HALF_HEIGHT = 2`, `MAX_HALF_HEIGHT` plano `1600`,
  `DISTANCE = 5000`, `VIEW_REACH +200`, `CHASE_ZOOM`, `near` 0,25/0,2,
  `far` 16000/14000/`+6000`. Os do globo (`PLANET_RADIUS × …`) ficam.
- `camera.ts`: `zoom` é **pixels CSS por unidade**: `MIN_ZOOM`, `MAX_ZOOM` e
  todo limiar de zoom (`GRASS_MIN_ZOOM = 4`, `FACADE_SHADOW_ZOOM = 11`,
  `PLANT_NEAR_ZOOM = 1.4`, `PLANT_MAP_ZOOM = 1`, …) são inversos → `perM()`.
- `cameraMotion.ts`/`cameraGestures.ts`: o que estiver em unidades por
  segundo (`COAST_MIN_PAN`, …) → `m()`; pixels e ângulos ficam.

### Mapa, chão e grade (`world/`)
- `bounds.ts`: `MAP_SIZE` plano `4800` → `m(1920)`; no planeta vem das peças
  (fica).
- `terrain.ts`: `TERRAIN_MIN/MAX_HEIGHT` (−360/560), `BASE_AMPLITUDE = 32`,
  `MIN_HARD_WALL = 32`, as frequências da base, carvar de rio — `m()`/`perM()`.
- `planet/atlas.ts`: centros num múltiplo de 400 para alinhar a malha do chão
  (16), a grade (25 = 10 m) e as plantas (12,5 = 5 m). A 1 m: grade 10,
  plantas 5 — 400 continua múltiplo. A malha do chão do planeta tem de
  dividir 400 (ver "Malha do chão" abaixo).
- `planet/relief.ts`: `OCEAN_FLOOR`, `MOUNTAIN_HEIGHT`, ruído de continente —
  escala do planeta, ficam.

### Desenho (`render/`)
- `render/terrain.ts`: `TERRAIN_SEGMENTS` (300 no plano, `MAP_SIZE/16` no
  planeta), `ROCK_WORLD = 58`, `WATER_CELL = 4`, estratos `320/260/320`,
  `TOPSOIL = 4`, `SHORE_BAND`, `RIBBON_STEP`, ~1000 literais incluindo GLSL.
- `environment.ts`: `SUN_DISTANCE = 1600`, `SHADOW_BIAS_WORLD = 0.1`,
  `SHADOW_SPAN_MIN = 12`, câmera de sombra ajustada (`fitDepth`).
- `materials.ts`: repetições `ASPHALT_TILE 26`, `FOOTWAY_TILE 18`,
  `KERB_TILE 8`, `VERGE_TILE 22`, `DECK_TILE 20` (unidades por textura).
- `water.ts`: `LAYER_A_TILE 34`, `LAYER_B_TILE 11`, `WAVE_TILE 90`,
  `DEEP_AT 6`, `FOAM_AT 4`.
- `grass.ts`/`grassField.ts`: `CHUNK 96`, `OPEN_REACH 700`, `GRID×SPACING`.
- `scenery.ts`: `SHADOW_REACH 70`; `planet/bend.ts`: `HORIZON_SLACK 200`
  (distância de folga do horizonte em unidades humanas → `m(80)`).
- Luzes pontuais (`renderer.ts`: luz do disparo, da explosão, lâmpadas): o
  three.js usa intensidade em candela com queda pelo inverso do quadrado da
  distância **em unidades** (https://threejs.org/docs/pages/PointLight.html).
  Os alcances já estão em `m()`; a intensidade tem de ser multiplicada por
  `m(0.4)²` para dar a mesma luz a 1 m por unidade.
- Neblina, nuvens (`postprocess.ts`), chuva: alturas e passos em unidades.

### Simulação (`sim/`)
Em grande parte já em `m()`/`kmh()` (parâmetros, arquétipos, IDM). Literais
restantes (tolerâncias, células de grade espacial, distâncias de busca) são
convertidos com o mesmo método.

### Ferramentas e interface (`editor/`, `main.ts`, `ui/`)
Conversões para o jogador já passam por `METERS_PER_UNIT`/`UNITS_PER_METER`
(km/h, metros mostrados, sliders em metros). Literais de raio de pincel,
distâncias de captura e passos de traço em unidades → `m()`.
`PLANET_MAX_PIECE = 200` é escala do planeta (cortar vias longas pelo erro do
mapa plano da peça): fica.

### Pessoas e modelos
Carros e pessoas são feitos em metros e escalados por `m(1)`
(`agents.ts createProceduralCrowd({ unit: m(1) })`, `procSize.makeScale(m(1))`,
`referenceModel.ts inner.scale.set(UNITS_PER_METER …)`). Mudam sozinhos.
O cozimento das pessoas (`cooked/people`, `cooked/procedural`) é em metros;
a troca não exige recozinhar (a impressão digital muda só se o código
importado pelo cozimento mudar — conferir `npm run cook:people` depois).

## Mapas salvos (têm de continuar abrindo)

O documento (`doc.toJSON`, `version: 1`) e o salvamento da sessão
(`persistence.ts`, chaves `roadcraft.world.v7` no plano,
`roadcraft.planet.atlas864.v1` no planeta, e `roadcraft.settings.v1` com a
câmera `x, y, zoom`) guardam unidades. Plano:

- O documento ganha `unit` (metros por unidade). Ausente = 0,4 (todo mapa
  salvo até hoje).
- `world/rescale.ts`: `rescaleSerializedDoc(data, fator)` escala, campo a
  campo, **antes** de `fromJSON` ler: nós (x, y, `heightOffset`), curvas,
  `dashOrigin`, seções (larguras), estacionamento, carimbos do terreno (x, y,
  raio, força em altura), tinta, neblina, ravinas, nuvens, elementos,
  árvores, clareiras, postes, paisagismo, muros, prédios (posição, volumes,
  contornos, alturas, módulo, elementos, detalhes de telhado, relevos,
  fachada em unidades, núcleos, mobília), zonas, marcas, lotes, transporte
  (pontos e paradas). Ângulos, contagens, ids, dinheiro, cores não mudam.
- **No planeta** uma posição é endereço do atlas (centro da peça + ponto no
  mapa da peça), e o espaçamento do atlas (`ATLAS_PITCH`) é em unidades: muda
  com a unidade e com o tamanho do planeta. O atlas salvo é lido com as
  medidas do build que o salvou (`oldAtlasToSphereInto`: a unidade e o
  `planetHalf` do mapa) e cada ponto vai à mesma direção da esfera, escrito na
  peça que a possui hoje. Com o planeta do mesmo tamanho em metros, nada se
  move; um mapa do primeiro planeta (menor) mantém a cidade do mesmo tamanho em
  volta do seu meio.
- Câmera salva: `zoom` (px por unidade) ÷ fator; no plano `x, y` × fator;
  no planeta `x, y` pelo mesmo caminho do atlas, com o `planetHalf` gravado
  nas configurações ou, nas mais antigas, o do mapa salvo junto
  (`persistence.ts` `cameraInUnit`).
- A linha de base dos mapas antigos (`tests/world/oldMapsIdentical.spec.ts`)
  é uma por unidade: os resumos são dos números em unidades, que arredondam
  diferente depois da migração (`roadBaseline.json` a 0,4,
  `roadBaseline.1m.json` a 1 m, gravada na troca).
- Spec: um mapa salvo a 0,4 (fixture) abre a 1 m com as mesmas medidas em
  metros (comprimento de via, largura, altura de prédio, número de carros
  possíveis).

Com a constante ainda em 0,4 o fator é 1: a migração entra antes da troca sem
mudar nada.

## Precisão numérica

Hoje o atlas vai a ~±29 000 unidades (36 colunas × 1 600 de passo). O planeta
fica com as mesmas unidades, então a precisão em unidades não muda; em metros
piora 2,5× porque o conteúdo encolhe em unidades. Tabela do Godot para float32
(https://docs.godotengine.org/en/stable/tutorials/physics/large_world_coordinates.html):
de 16 384 a 32 768 o passo é ~0,0019 unidade = **~2 mm**, dentro do que o
Godot recomenda para jogos vistos de cima (até 32 768) e muito abaixo de um
pixel numa rua vista de perto. Riscos a medir na fase 2:
- `near` da câmera: hoje mínimo 0,2 u = 8 cm. Escrito como `m(0.08)` fica
  0,08 u; a razão far/near cresce 2,5× → menos precisão de profundidade no
  globo. Medir z-fighting de faixas/calçadas com a câmera baixa e longe.
- Epsilons de 1e-3 / 1e-6 em unidades viram 2,5× mais grosseiros em metros
  (1 mm). Nada no jogo depende de submilímetro; conferir os testes de
  geometria (`tests/core`).

## Malha do chão (decisão de desempenho)

A malha do chão tem 6,4 m. No plano, `TERRAIN_SEGMENTS = 300` sobre
`MAP_SIZE` em metros continua 6,4 m e o mesmo número de vértices. No planeta
o planeta tem o mesmo tamanho em metros nas duas unidades (faces de 6 km
desde 2026-10-10) e a célula da placa é `PLATE_CELL = ATLAS_GRID / 25` com
`ATLAS_GRID = m(160)`: 6,4 m nas duas, as mesmas placas e os mesmos vértices.
Decidido (2026-10-11): fica 6,4 m, sem custo novo; a comparação lado a lado
mediu o chão igual nas duas escalas.

## Ordem dos passos (cada um um commit, o jogo funcionando)

1. `units.ts`: `perM()`; `world/rescale.ts` + campo `unit` no documento e na
   sessão (fator 1 hoje) + spec da migração. Sem mudança visível.
2. Converter literais `view/` + `render/isoViewport.ts` (câmera). Specs de
   câmera iguais.
3. Converter `world/` + `core/` (terreno, limites, alturas).
4. Converter `render/` (terreno e shaders, ambiente, materiais, água, grama,
   cenário, efeitos, luzes).
5. Converter `sim/`, `editor/`, `main.ts`, `ui/`.
6. Converter os specs que constroem cenas com números crus e cujas
   expectativas dependem da escala (vão para `m()`).
7. **Troca** (2026-10-11): o padrão é 1 m (`vite.config.ts`,
   `vitest.config.ts`); malha do chão do planeta decidida (6,4 m); mapas e
   câmera salvos migrados; docs (`CLAUDE.md`, `units.ts`, comentários "0,4 m").
8. `npm run check` uma vez, por `run-limited`.

## Como cada passo é verificado

- `tsc --noEmit`, eslint nos arquivos tocados, os specs tocados (configs
  plana e do planeta), tudo por `scripts/run-limited.mjs`.
- Passos 1–6: os testes existentes passam **sem mudar expectativa** (prova de
  que a conversão não muda número nenhum a 0,4). Grep de conferência:
  `rg "\b[0-9]+(\.[0-9]+)?\b"` nos arquivos do passo, olhando os que não estão
  em `m()`.
- Passo 7: probe do planeta (`scripts/zz-planet-probe.mjs`, porta 5175) com
  fotos na rua (câmera nos olhos), meia altura e globo, abertas uma a uma:
  carro ~4,5 m, faixa ~3,5 m, andar ~3 m comparados com a grade de 10 m;
  nada flutuando nem enterrado; texturas sem esticar; sombras, neblina e
  atmosfera coerentes. Números antes/depois: ms de quadro, draw calls,
  triângulos, ms de reconstrução.

## Comparação lado a lado (2026-10-11)

A unidade é uma chave de compilação (`__METERS_PER_UNIT__`, `src/globals.d.ts`).
Desde a troca, `npm run dev:planet` serve o planeta a 1 m (porta 5175) e
`npm run dev:planet:old-unit` a 0,4 m (porta 5176, modo `planet-old-unit`);
os specs rodam a 1 m, e a 0,4 com `ROADCRAFT_METERS_PER_UNIT=0.4`. (Na
comparação, antes da troca, era o contrário: o modo `planet-metre` servia 1 m.) A mesma cidade gerada (semente
7) é comparada em metros nas duas escalas: o documento (vias, lotes, prédios
campo a campo), a geometria das vias (área e vértices de cada nível), as faixas
da simulação e seus primeiros passos, o tamanho de cada objeto desenhado e
fotos das mesmas vistas subtraídas pixel a pixel. O que diverge aponta o número
que ainda não está em metros. Classes achadas e corrigidas:

- **Números crus** em unidades: raios do meio-fio (`core/fillet.ts`),
  tolerâncias de achatamento de curva (`core/scalar.ts`), o atlas do planeta
  (`TILE_REACH`, `ATLAS_PITCH`, `TILE_PLATE_HALF`), `PLANET_MAX_PIECE`, os
  limites e a taxa de aplainar do terreno, alcances de árvores e grama,
  estruturas (pontes, muros, portais), neblina, céu, nascimento dos carros.
- **`m()` local com 0,4 fixo** (`render/signals.ts`): os semáforos ficavam
  2,5 vezes maiores a 1 m. Só existe o `m()` de `core/units.ts`.
- **Limiares de zoom** em pixels por unidade (níveis de detalhe de carros,
  pessoas, plantas, qualidade): agora `perM()`.
- **Padrões afinados com dezenas de números** (ruído do relevo plano e do
  planeta, estratos da parede do mapa): lidos na escala em que foram afinados,
  `TUNED_UNIT` (0,4 m), convertendo só a entrada e a saída - como um
  importador de modelos aplica um fator de escala (glTF 2.0, 3.4: comprimentos
  em metros; Unity, Scale Factor do importador).
- **Empates de ponto flutuante**: uma contagem arredondada de uma razão em
  x,5 (baias, pilares, vagas) ou dois lotes à mesma distância saíam diferentes
  com a unidade. `stepsIn()` (`core/units.ts`) e `steadyRatio()`
  (`core/scalar.ts`) leem a razão ao milionésimo; os lados de um lote entram
  no gerador ao milímetro (`zoning.ts` `metresOf`); um lote só é "mais perto"
  por 1 mm ou mais.

Resultado: a cidade gerada é idêntica nas duas escalas (66 vias, 237 lotes,
206 prédios, mobiliário); a simulação é idêntica nos primeiros 51 passos e
depois só difere por ruído de ponto flutuante (o trânsito é caótico).

## O que o jogador vai ver

- Na rua: igual (carros, pessoas, prédios com os mesmos metros).
- O planeta: 2,5× maior — faces de 6 km, raio ~3,8 km. Do chão o horizonte
  fica mais longe e mais plano; do alto a cidade fica menor sobre o globo e a
  atmosfera em volta não aperta mais a cidade.
- Cada peça comporta 6,25× mais cidade.
- Mapas antigos abrem no mesmo lugar e com os mesmos tamanhos em metros.

## Riscos

- Literal esquecido: fica 2,5× maior/menor depois da troca. Defesa: passos
  2–6 por pasta, grep de conferência, testes com números em metros, fotos.
- GLSL com número embutido (frequências, larguras de linha da grade, folgas
  de profundidade): convertidos por constante TypeScript interpolada.
- Memória e tempo do chão no planeta (malha fina) — medido antes de decidir.
- Outro agente edita a mesma árvore: cada arquivo só é tocado sem mudança
  alheia pendente (`git status --short`).
