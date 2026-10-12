# Fase 2 — mapa do código para o mundo único (2026-10-11)

Leitura do código do ramo `planeta-esfera` (sem fontes externas; complementa
`fase-2-mundo-unico-celulas.md`). Pergunta: o que muda para a vista plana ser
o próprio planeta desenhado com curvatura ~0, trocada em tempo de execução, e
para o build plano separado (`__PLANET__` falso, `world/flatEarth.ts`) sair.

## Resumo

`__PLANET__` aparece 159 vezes em 37 arquivos de `src/` (fora `backup/`).

- **A — o lado do planeta já serve à vista plana** (a maioria): contas nas
  cartas (`world/geometry.ts`, `charts.ts`, `walkways.ts`, `lanelets.ts`,
  `carriageway.ts`, `zoneGrid.ts`, `lots.ts`, `elevation.ts`, `grid.ts`,
  `buildings/*`), editor (`commit.ts`, `roundabout.ts`, `terrainBrush.ts`,
  `zoning.ts`), simulação (`walk.ts`, `parking.ts`), terreno e superfícies
  (`terrain.ts`, `terrainRelief.ts`, `roadSurfaces.ts`, `scenery.ts`,
  `environment.ts`), `renderer.ts` (planeta, sol local, árvores, sombras),
  `postprocess.ts` (desfoque, sombra do sol, nuvens na esfera desenhada).
- **B — precisa de um ramo em tempo de execução** ("vista plana" ligada):
  - `render/isoViewport.ts`: curvatura pela altura (`:344`) → ~0 em qualquer
    altura; `globe` (`:270`) → 0 (sem inclinação de globo, sem giro);
    `deep` (`:290`) → `halfHeight / tan(elev)`; planos de corte (`:292`,
    `:301`) sem `2,6 R`; teto de altura próprio (`:38`, hoje `1,5 R`) abaixo
    do topo do ar (`ATMOSPHERE_TOP − R ≈ 1,6 km`).
  - Voo (`renderer.ts:621`, `isoViewport.ts:243`, `ui/v2/shell.ts:601,710`):
    força k = 1 e vai ao espaço — desligar na vista plana ou trocar para o
    globo ao decolar.
  - `postprocess.ts:1104–1105`: `pass` contra o centro real e `AIR_R`.
  - `ui/modeChooser.ts`: o botão de modo vira troca de vista, sem navegar.
- **C — só do build plano, sai com ele:** `world/bounds.ts` (lado plano),
  `editor/commit.ts:210` (`flatGroundFor`), `editor/persistence.ts:19`
  (chave `roadcraft.world.v7`) e `:477` (câmera plana), `world/rescale.ts:230`,
  `render/flatEarthGlsl.ts`, `render/flatAtlas.ts`, `render/flatOcean.ts`,
  `renderer.ts:727`, `ui/modeChooser.ts` (`modeUrl`, `switchMode`,
  `roadcraft.mode.v1`), `scripts/build-modes.mjs`. Antes de apagar
  `flatEarth.ts`, mover `ROAD_SEA_FREEBOARD`, `seaRoadGround`, `seaFloorOver`
  (usados pelo planeta em `terrainAtlas.ts:593`). `flatGroundPool.ts` e
  `flatGround.worker.ts` são compartilhados apesar do nome.

## O que supõe k = 1 acima do ar ou mede "dentro do ar" pelo centro real

- `air.ts:670` (`inside` pelo centro real), `:92`, `:322–336`, `:141–142`.
- `space.ts:706,828` (casca do ar no centro real: na vista plana cortaria o
  plano num disco de raio ~R), `:833`, `:108–116`, `:247–260`.
- `postprocess.ts:549–554,570–573,1104–1105`.
- `renderer.ts:3561–3567`: mergulho do horizonte pelo centro real.
- `bend.ts:514` limita k ≥ 0,02 e não tem ramo k = 0 (`R/k` em `planetBent`,
  `bentInto`, `bentSphere`, `planetDrawnSphere`; `planetDaylight` com
  `max(k, 1e-3)`); `:340` sem corte de placa pelo horizonte com k < 1.
- Peças perto do antípoda caem na borda de um disco de raio πR e os
  triângulos que o atravessam se esticam: na vista plana, cortar o chão
  distante pela distância.

Com a vista plana presa abaixo do topo do ar, o olho fica sempre "dentro do
ar" mesmo medido pelo centro real, e quase nada dessa lista dispara; a vista
do mundo inteiro no plano (projeção global para o longe) é o passo seguinte.

## Salvamento e migração

- Chaves: planeta `roadcraft.planet.atlas864.v1`, plano `roadcraft.world.v7`
  (`persistence.ts:19`; grandes no IndexedDB `roadcraft-saves`); comuns
  `roadcraft.settings.v1` e `roadcraft.mode.v1`.
- `main.ts:226` `clearOldMapsOnce` apaga `roadcraft.world*` uma vez.
- Migração de um mapa plano: depois de `loadSessionAsync` vazio na chave do
  planeta, ler `new Persistence('roadcraft.world.v7')`, levar cada ponto pela
  carta de `HOME_TILE` (`tileToSphereInto` → `tileOfDirection` → atlas, como
  `rescale.ts planetPlace`), salvar na chave do planeta e deixar a antiga.
  Arquivo importado sem `planetHalf` hoje se confunde com atlas antigo de
  3000 (`rescale.ts:250–260`): decidir pela origem ou marcar. Servidores de
  desenvolvimento 5177/5175 são origens diferentes: lá só exportar/importar.
  O relevo do mapa antigo (`flatGroundFor`, `FLAT_BLEND`) não tem costura no
  planeta (`relief.ts:261`).
