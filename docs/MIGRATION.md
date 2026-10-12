# Migração da FONTE para o Roadcraft 2

FONTE: ramo `planeta-esfera`, commit **`4cc2926ee22df6f69a3f047b180f2e1121a3437a`** (`C:/Codex-Shared/roadcraft-planeta-esfera`). Mudanças não commitadas do worktree e ramos não integrados não entram (lista em `docs/PLAN.md` 1.1).

## Como a lista foi calculada (nunca à mão)

Ferramenta fora dos repositórios, em `C:/Codex-Shared/roadcraft2-migracao/` (SHA-256: `fecho.mjs` 6f636dcb…, `usados.mjs` 2d4351aa…, `copiar.mjs` b5ac6538…, completos no fim).

1. **Fecho de importações** a partir de `index.html` (script `/src/main.ts` e folha `/src/ui/app.css`) e das declarações ambiente (`src/**/*.d.ts`): importações estáticas e dinâmicas e `import type` pelo `ts.preProcessFile` do TypeScript, workers (`new URL(..., import.meta.url)`), `import.meta.glob`, pastas de modelos (`virtual:model-urls/<pasta>?ext=`), `@import`/`url()` de CSS. Sem entrar nos arquivos do SAI.
2. **Conferência pelos source maps** das builds de produção dos dois modos (`npm run build:modos` da FONTE): os mapeamentos decodificados dão os caracteres gerados por arquivo. 432 arquivos `.ts` têm bytes nas builds; 11 não têm (4 só de tipos; `weaponsLab.ts`, que não entra; os outros 6 são constantes embutidas ou ramos mortos, necessários para compilar). Nenhum arquivo com bytes nas builds ficou fora do fecho.
3. **Specs** cujo fecho cai inteiro no que entra (mais os arquivos de apoio de teste abaixo). **Configuração e scripts ainda usados** com o próprio fecho.
4. **Cópia dos blobs** do commit (o `git archive` dele) e conferência de cada arquivo com `git hash-object` contra `git ls-tree -r 4cc2926e`: **2930 arquivos, todos iguais**. Lista com o blob de cada um: `docs/migration/copiados.txt`.

## O que entrou

| grupo | arquivos |
|---|---|
| jogo (fecho de `index.html`) | 2577 |
| configuração, scripts usados e apoio de teste | 22 |
| testes (specs e seus apoios em `tests/`) | 301 (288 specs) |
| documentos da FONTE (histórico, em `docs/source/` e `docs/research/source/`) | 23 |
| notas dos módulos (`src/*/CLAUDE.md`) | 4 |
| licenças dos assets copiados | 5 |

Apoio de teste trazido de `src/` (usado só por specs, sai de `src/` na E3): `src/world/defaultTown.ts`, `src/world/sampleTown.ts`, `src/world/town.ts`, `src/sim/snapshot.ts`, `src/sim/drive/motionMetrics.ts`.

Dependências usadas pelo código do jogo: `clipper2-ts`, `earcut`, `jolt-physics`, `meshoptimizer`, `polygon-clipping`, `three`. `recast-navigation` não aparece em nenhum fecho (sai na limpeza seguinte).

## O que ficou fora, com o motivo

### FORMA, outro projeto (226)

- `labs/building/.claude/launch.json`
- `labs/building/.gitattributes`
- `labs/building/.gitignore`
- `labs/building/forma-builder-3d-legacy.html`
- `labs/building/forma-builder-3d.html`
- `labs/building/forma/README.md`
- `labs/building/forma/docs/AUDIT-2026-10-11.md`
- `labs/building/forma/docs/INTERFACE.md`
- `labs/building/forma/docs/PLAN.md`
- `labs/building/forma/docs/RESEARCH.md`
- `labs/building/forma/docs/SELECTION.md`
- `labs/building/forma/docs/TOOLS.md`
- `labs/building/forma/e2e/editor.spec.ts`
- `labs/building/forma/e2e/f3.spec.ts`
- `labs/building/forma/package-lock.json`
- `labs/building/forma/package.json`
- `labs/building/forma/playwright.config.ts`
- `labs/building/forma/scripts/extract-legacy.mjs`
- `labs/building/forma/scripts/make-fixtures.mjs`
- `labs/building/forma/scripts/port-css.mjs`
- `labs/building/forma/scripts/record-legacy.mjs`
- `labs/building/forma/src/app/editor.html`
- `labs/building/forma/src/app/editor.ts`
- `labs/building/forma/src/app/host-scene.html`
- `labs/building/forma/src/app/host-scene.ts`
- `labs/building/forma/src/app/index.html`
- `labs/building/forma/src/app/main.ts`
- `labs/building/forma/src/app/public/tex/Bricks066/color.jpg`
- `labs/building/forma/src/app/public/tex/Bricks066/normal.jpg`
- `labs/building/forma/src/app/public/tex/Bricks066/rough.jpg`
- `labs/building/forma/src/app/public/tex/Bricks085/color.jpg`
- `labs/building/forma/src/app/public/tex/Bricks085/normal.jpg`
- `labs/building/forma/src/app/public/tex/Bricks085/rough.jpg`
- `labs/building/forma/src/app/public/tex/Concrete034/color.jpg`
- `labs/building/forma/src/app/public/tex/Concrete034/normal.jpg`
- `labs/building/forma/src/app/public/tex/Concrete034/rough.jpg`
- `labs/building/forma/src/app/public/tex/CorrugatedSteel007B/color.jpg`
- `labs/building/forma/src/app/public/tex/CorrugatedSteel007B/normal.jpg`
- `labs/building/forma/src/app/public/tex/CorrugatedSteel007B/rough.jpg`
- `labs/building/forma/src/app/public/tex/Plaster001/color.jpg`
- `labs/building/forma/src/app/public/tex/Plaster001/normal.jpg`
- `labs/building/forma/src/app/public/tex/Plaster001/rough.jpg`
- `labs/building/forma/src/app/public/tex/RoofingTiles003/color.jpg`
- `labs/building/forma/src/app/public/tex/RoofingTiles003/normal.jpg`
- `labs/building/forma/src/app/public/tex/RoofingTiles003/rough.jpg`
- `labs/building/forma/src/app/public/tex/RoofingTiles006/color.jpg`
- `labs/building/forma/src/app/public/tex/RoofingTiles006/normal.jpg`
- `labs/building/forma/src/app/public/tex/RoofingTiles006/rough.jpg`
- `labs/building/forma/src/app/public/tex/Wood049/color.jpg`
- `labs/building/forma/src/app/public/tex/Wood049/normal.jpg`
- `labs/building/forma/src/app/public/tex/Wood049/rough.jpg`
- `labs/building/forma/src/app/v3.html`
- `labs/building/forma/src/app/v3.ts`
- `labs/building/forma/src/core/events.ts`
- `labs/building/forma/src/core/history.ts`
- `labs/building/forma/src/core/ids.ts`
- `labs/building/forma/src/core/index.ts`
- `labs/building/forma/src/core/indices.ts`
- `labs/building/forma/src/core/migrate/v1.ts`
- `labs/building/forma/src/core/model.ts`
- `labs/building/forma/src/core/schema.ts`
- `labs/building/forma/src/core/validate.ts`
- `labs/building/forma/src/editor/editor.ts`
- `labs/building/forma/src/editor/example.ts`
- `labs/building/forma/src/editor/interior-ops.ts`
- `labs/building/forma/src/editor/lot-ops.ts`
- `labs/building/forma/src/editor/ops.ts`
- `labs/building/forma/src/editor/scene.ts`
- `labs/building/forma/src/editor/templates.ts`
- `labs/building/forma/src/editor/walk.ts`
- `labs/building/forma/src/f3/editor/editor.ts`
- `labs/building/forma/src/f3/editor/elements.ts`
- `labs/building/forma/src/f3/editor/handles.ts`
- `labs/building/forma/src/f3/editor/infer.ts`
- `labs/building/forma/src/f3/editor/selection.ts`
- `labs/building/forma/src/f3/editor/store.ts`
- `labs/building/forma/src/f3/editor/view.ts`
- `labs/building/forma/src/f3/eval/body.ts`
- `labs/building/forma/src/f3/eval/bounds.ts`
- `labs/building/forma/src/f3/eval/clipoffset.ts`
- `labs/building/forma/src/f3/eval/evaluate.ts`
- `labs/building/forma/src/f3/eval/facade.ts`
- `labs/building/forma/src/f3/eval/faces.ts`
- `labs/building/forma/src/f3/eval/interior.ts`
- `labs/building/forma/src/f3/eval/mesh.ts`
- `labs/building/forma/src/f3/eval/parapet.ts`
- `labs/building/forma/src/f3/eval/parts.ts`
- `labs/building/forma/src/f3/eval/roofs.ts`
- `labs/building/forma/src/f3/eval/subelements.ts`
- `labs/building/forma/src/f3/families/awning.ts`
- `labs/building/forma/src/f3/families/balconies.ts`
- `labs/building/forma/src/f3/families/canopies.ts`
- `labs/building/forma/src/f3/families/decal.ts`
- `labs/building/forma/src/f3/families/doors.ts`
- `labs/building/forma/src/f3/families/family.ts`
- `labs/building/forma/src/f3/families/fences.ts`
- `labs/building/forma/src/f3/families/index.ts`
- `labs/building/forma/src/f3/families/kit.ts`
- `labs/building/forma/src/f3/families/lights.ts`
- `labs/building/forma/src/f3/families/ornament.ts`
- `labs/building/forma/src/f3/families/railings.ts`
- `labs/building/forma/src/f3/families/roofgear.ts`
- `labs/building/forma/src/f3/families/shapes.ts`
- `labs/building/forma/src/f3/families/stairs.ts`
- `labs/building/forma/src/f3/families/structure.ts`
- `labs/building/forma/src/f3/families/windows.ts`
- `labs/building/forma/src/f3/io/export.ts`
- `labs/building/forma/src/f3/io/game.ts`
- `labs/building/forma/src/f3/io/migrate.ts`
- `labs/building/forma/src/f3/io/persist.ts`
- `labs/building/forma/src/f3/kernel/kernel.ts`
- `labs/building/forma/src/f3/model/align.ts`
- `labs/building/forma/src/f3/model/blocks.ts`
- `labs/building/forma/src/f3/model/defaults.ts`
- `labs/building/forma/src/f3/model/layers.ts`
- `labs/building/forma/src/f3/model/modeling.ts`
- `labs/building/forma/src/f3/model/ops.ts`
- `labs/building/forma/src/f3/model/plan.ts`
- `labs/building/forma/src/f3/model/quick.ts`
- `labs/building/forma/src/f3/model/samples.ts`
- `labs/building/forma/src/f3/model/schema.ts`
- `labs/building/forma/src/f3/model/selsets.ts`
- `labs/building/forma/src/f3/render/finishes.ts`
- `labs/building/forma/src/f3/render/images.ts`
- `labs/building/forma/src/f3/render/look.ts`
- `labs/building/forma/src/f3/render/night.ts`
- `labs/building/forma/src/f3/render/parts.ts`
- `labs/building/forma/src/f3/render/pbr.ts`
- `labs/building/forma/src/f3/render/procedural.ts`
- `labs/building/forma/src/f3/render/shell.ts`
- `labs/building/forma/src/f3/render/thumbs.ts`
- `labs/building/forma/src/f3/ui/actions.ts`
- `labs/building/forma/src/f3/ui/catalog.ts`
- `labs/building/forma/src/f3/ui/icons.ts`
- `labs/building/forma/src/f3/ui/inspector.ts`
- `labs/building/forma/src/f3/ui/interior.ts`
- `labs/building/forma/src/f3/ui/kit.ts`
- `labs/building/forma/src/f3/ui/lastop.ts`
- `labs/building/forma/src/f3/ui/layers.ts`
- `labs/building/forma/src/f3/ui/materials.ts`
- `labs/building/forma/src/f3/ui/palette.ts`
- `labs/building/forma/src/f3/ui/shell.ts`
- `labs/building/forma/src/f3/ui/time.ts`
- `labs/building/forma/src/f3/ui/viewcube.ts`
- `labs/building/forma/src/geometry/boolean.ts`
- `labs/building/forma/src/geometry/collision.ts`
- `labs/building/forma/src/geometry/frame.ts`
- `labs/building/forma/src/geometry/interior-parts.ts`
- `labs/building/forma/src/geometry/lot.ts`
- `labs/building/forma/src/geometry/mass-parts.ts`
- `labs/building/forma/src/geometry/parts.ts`
- `labs/building/forma/src/geometry/polygon.ts`
- `labs/building/forma/src/geometry/ring-ids.ts`
- `labs/building/forma/src/geometry/ring.ts`
- `labs/building/forma/src/geometry/roofs/legacy.ts`
- `labs/building/forma/src/geometry/roofs/skeleton-roof.ts`
- `labs/building/forma/src/geometry/roofs/skeleton.ts`
- `labs/building/forma/src/geometry/rooms.ts`
- `labs/building/forma/src/geometry/stairs.ts`
- `labs/building/forma/src/geometry/walls.ts`
- `labs/building/forma/src/index.ts`
- `labs/building/forma/src/io/export.ts`
- `labs/building/forma/src/io/persistence.ts`
- `labs/building/forma/src/render/build-building.ts`
- `labs/building/forma/src/render/collision.ts`
- `labs/building/forma/src/render/context.ts`
- `labs/building/forma/src/render/lod.ts`
- `labs/building/forma/src/render/lot.ts`
- `labs/building/forma/src/render/modules.ts`
- `labs/building/forma/src/render/textures.ts`
- `labs/building/forma/src/render/worker-client.ts`
- `labs/building/forma/src/styles/builtin.ts`
- `labs/building/forma/src/styles/index.ts`
- `labs/building/forma/src/styles/interpret.ts`
- `labs/building/forma/src/styles/schema.ts`
- `labs/building/forma/src/styles/split.ts`
- `labs/building/forma/src/ui/icons.ts`
- `labs/building/forma/src/ui/legacy.css`
- `labs/building/forma/src/ui/panels.ts`
- `labs/building/forma/src/ui/shell-html.ts`
- `labs/building/forma/src/ui/shell.ts`
- `labs/building/forma/src/ui/styles.css`
- `labs/building/forma/src/vite-env.d.ts`
- `labs/building/forma/src/worker/inline.d.ts`
- `labs/building/forma/src/worker/parts.worker.ts`
- `labs/building/forma/test/fixtures/legacy-baselines.json`
- `labs/building/forma/test/fixtures/styles/ornate.json`
- `labs/building/forma/test/fixtures/v1/arches.json`
- `labs/building/forma/test/fixtures/v1/circle.json`
- `labs/building/forma/test/fixtures/v1/courtyard.json`
- `labs/building/forma/test/fixtures/v1/example.json`
- `labs/building/forma/test/fixtures/v1/openings.json`
- `labs/building/forma/test/fixtures/v1/roofs.json`
- `labs/building/forma/test/fixtures/v1/setback.json`
- `labs/building/forma/test/fixtures/v1/stress-120.json`
- `labs/building/forma/test/fixtures/v1/toggles.json`
- `labs/building/forma/test/legacy/forma-core.js`
- `labs/building/forma/test/legacy/package.json`
- `labs/building/forma/test/legacy/polygon-clipping.js`
- `labs/building/forma/test/unit/f3-eval.test.ts`
- `labs/building/forma/test/unit/f3-families.test.ts`
- `labs/building/forma/test/unit/f3-interior.test.ts`
- `labs/building/forma/test/unit/f3-migrate.test.ts`
- `labs/building/forma/test/unit/f3-modeling.test.ts`
- `labs/building/forma/test/unit/f3-ops.test.ts`
- `labs/building/forma/test/unit/f3-plan.test.ts`
- `labs/building/forma/test/unit/f3-procedural.test.ts`
- `labs/building/forma/test/unit/f3-selection.test.ts`
- `labs/building/forma/test/unit/f3-selsets.test.ts`
- `labs/building/forma/test/unit/f3-subelements.test.ts`
- `labs/building/forma/test/unit/interiors.test.ts`
- `labs/building/forma/test/unit/legacy.ts`
- `labs/building/forma/test/unit/lod.test.ts`
- `labs/building/forma/test/unit/lot.test.ts`
- `labs/building/forma/test/unit/migrate.test.ts`
- `labs/building/forma/test/unit/ops.test.ts`
- `labs/building/forma/test/unit/parity.test.ts`
- `labs/building/forma/test/unit/polygon.test.ts`
- `labs/building/forma/test/unit/ring-ids.fuzz.test.ts`
- `labs/building/forma/test/unit/roofs.test.ts`
- `labs/building/forma/test/unit/skeleton.test.ts`
- `labs/building/forma/test/unit/styles.test.ts`
- `labs/building/forma/test/unit/templates.test.ts`
- `labs/building/forma/tsconfig.json`
- `labs/building/forma/vite.config.ts`
- `labs/building/forma/vite.lib.config.ts`

### script sem uso (sonda, laboratório ou geração antiga) (69)

- `scripts/bench-render.mjs`
- `scripts/bench-sim.mjs`
- `scripts/build-human-base.py`
- `scripts/build-human-extras.py`
- `scripts/build-studios.mjs`
- `scripts/capture-scene.mjs`
- `scripts/census-report.mjs`
- `scripts/contact-sheet.mjs`
- `scripts/export-rocketbox-facial.py`
- `scripts/extract-citizen-walk.mjs`
- `scripts/extract-cmu-clips.mjs`
- `scripts/extract-quaternius-clips.mjs`
- `scripts/extract-rocketbox-clips.mjs`
- `scripts/fetch-citizens.py`
- `scripts/import-faceunits.mjs`
- `scripts/import-makehuman-community.mjs`
- `scripts/import-makehuman-proxies.mjs`
- `scripts/import-makehuman-skins.mjs`
- `scripts/import-makehuman.mjs`
- `scripts/inspect-scene.mjs`
- `scripts/make-wardrobe-thumbs.py`
- `scripts/measure-seated-poses.mjs`
- `scripts/pack-citizens.py`
- `scripts/pack-facial-morphs.py`
- `scripts/pack-facial-pilot.py`
- `scripts/perf-gate.mjs`
- `scripts/perf-probe.mjs`
- `scripts/probe-agents.mjs`
- `scripts/probe-arrays.mjs`
- `scripts/probe-barriers.mjs`
- `scripts/probe-baseline.mjs`
- `scripts/probe-brows.mjs`
- `scripts/probe-corner.mjs`
- `scripts/probe-creator-swap.mjs`
- `scripts/probe-creator.mjs`
- `scripts/probe-doc-size.mjs`
- `scripts/probe-face.mjs`
- `scripts/probe-hitches.mjs`
- `scripts/probe-idle-profile.mjs`
- `scripts/probe-lab.mjs`
- `scripts/probe-loading.mjs`
- `scripts/probe-memory.mjs`
- `scripts/probe-normal-map.mjs`
- `scripts/probe-planet-load.mjs`
- `scripts/probe-road-relief.mjs`
- `scripts/probe-shots.mjs`
- `scripts/probe-start.mjs`
- `scripts/probe-startup-profile.mjs`
- `scripts/probe-talk.mjs`
- `scripts/probe-terrain-crash.mjs`
- `scripts/probe-terrain-leak.mjs`
- `scripts/probe-terrain-relief.mjs`
- `scripts/probe-town.mjs`
- `scripts/probe-traffic.mjs`
- `scripts/probe-triangles.mjs`
- `scripts/probe-walk.mjs`
- `scripts/register-makehuman.py`
- `scripts/remove-shirt-logos.py`
- `scripts/serve-studios.mjs`
- `scripts/svg-to-png.mjs`
- `scripts/test-light.mjs`
- `scripts/texture-to-webp.py`
- `scripts/transit-shots.mjs`
- `scripts/verify-buildings.mjs`
- `scripts/verify-studio-exports.mjs`
- `scripts/verify-ui.mjs`
- `scripts/verify-visual.mjs`
- `scripts/walk-shots.mjs`
- `scripts/weapons-lab.mjs`

### asset sem referência no código do jogo (48)

- `public/models/citizens/catalog.json`
- `public/models/humans/mhr/base.bin`
- `public/models/humans/mhr/base.json`
- `public/models/humans/vitruvian/Dark_Skin_Color.1001.jpg`
- `public/models/humans/vitruvian/Dark_Skin_Color.1002.jpg`
- `public/models/humans/vitruvian/Dark_Skin_Color.1003.jpg`
- `public/models/humans/vitruvian/Dark_Skin_Color.1004.jpg`
- `public/models/humans/vitruvian/Iris_Color.1007.jpg`
- `public/models/humans/vitruvian/Iris_Height.1007.jpg`
- `public/models/humans/vitruvian/Iris_Roughness.1007.jpg`
- `public/models/humans/vitruvian/Light_Skin_Color.1001.jpg`
- `public/models/humans/vitruvian/Light_Skin_Color.1002.jpg`
- `public/models/humans/vitruvian/Light_Skin_Color.1003.jpg`
- `public/models/humans/vitruvian/Light_Skin_Color.1004.jpg`
- `public/models/humans/vitruvian/Mouth_Color.1008.jpg`
- `public/models/humans/vitruvian/Mouth_Height.1008.jpg`
- `public/models/humans/vitruvian/Mouth_Roughness.1008.jpg`
- `public/models/humans/vitruvian/Sclera_Color.1005.jpg`
- `public/models/humans/vitruvian/Sclera_Height.1005.jpg`
- `public/models/humans/vitruvian/Skin_Age_Height.1001.jpg`
- `public/models/humans/vitruvian/Skin_Age_Height.1002.jpg`
- `public/models/humans/vitruvian/Skin_Age_Height.1003.jpg`
- `public/models/humans/vitruvian/Skin_Age_Height.1004.jpg`
- `public/models/humans/vitruvian/Skin_Height.1001.jpg`
- `public/models/humans/vitruvian/Skin_Height.1002.jpg`
- `public/models/humans/vitruvian/Skin_Height.1003.jpg`
- `public/models/humans/vitruvian/Skin_Height.1004.jpg`
- `public/models/humans/vitruvian/Skin_Roughness.1001.jpg`
- `public/models/humans/vitruvian/Skin_Roughness.1002.jpg`
- `public/models/humans/vitruvian/Skin_Roughness.1003.jpg`
- `public/models/humans/vitruvian/Skin_Roughness.1004.jpg`
- `public/models/humans/vitruvian/base.bin`
- `public/models/humans/vitruvian/base.json`
- `public/models/humans/vitruvian/extras.bin`
- `public/models/humans/vitruvian/extras.json`
- `public/models/humans/vitruvian/makehuman.bin`
- `public/models/humans/vitruvian/makehuman.json`
- `public/models/nature/LICENSE-Kenney-Nature-Kit.txt`
- `public/models/nature/tree_default.glb`
- `public/models/nature/tree_detailed.glb`
- `public/models/nature/tree_fat.glb`
- `public/models/nature/tree_oak.glb`
- `public/models/nature/tree_pineDefaultA.glb`
- `public/models/nature/tree_pineRoundA.glb`
- `public/models/nature/tree_plateau.glb`
- `public/models/nature/tree_tall.glb`
- `public/models/people/expressions.bin`
- `public/models/people/expressions.json`

### arquivo de teste de spec que não entra (47)

- `tests/fixtures/contactSheet.ts`
- `tests/fixtures/grid-and-bends.json`
- `tests/fixtures/player-city.json`
- `tests/fixtures/poles-varied-blocks.json`
- `tests/fixtures/roadBaseline.1m.json`
- `tests/fixtures/roadBaseline.json`
- `tests/fixtures/seated-body-cells.json`
- `tests/fixtures/seated-pose-extents.json`
- `tests/fuzz/fixtures/bodies-meet-on-hooked-turn.json`
- `tests/fuzz/fixtures/body-at-road-end-between-sweep-steps.json`
- `tests/fuzz/fixtures/bus-leaves-kerb-on-acute-turn.json`
- `tests/fuzz/fixtures/clipper-sweep-exception-seed29.json`
- `tests/fuzz/fixtures/curved-mouth-ribbon-gap.json`
- `tests/fuzz/fixtures/curved-mouth-strip-missing-from-turn-surface.json`
- `tests/fuzz/fixtures/elevated-deck-no-cliff-after-split.json`
- `tests/fuzz/fixtures/freeform-highway-boulevard-curve-mouth.json`
- `tests/fuzz/fixtures/highway-corner-built-as-ramp-gore.json`
- `tests/fuzz/fixtures/highway-meeting-ramps-square-built-as-gore.json`
- `tests/fuzz/fixtures/kink-at-chain-node-read-as-straight.json`
- `tests/fuzz/fixtures/lane-end-reversed-by-short-trim-piece.json`
- `tests/fuzz/fixtures/lane-end-reversed-on-curved-approach.json`
- `tests/fuzz/fixtures/lane-starts-past-mouth-on-tight-curve.json`
- `tests/fuzz/fixtures/lane-with-no-exit-where-every-movement-is-a-uturn.json`
- `tests/fuzz/fixtures/mouth-wedge-after-slab-bump.json`
- `tests/fuzz/fixtures/mouth-wedge-refined-trim-past-leg-cap.json`
- `tests/fuzz/fixtures/no-mouth-seam-after-move-onto-tight-curve.json`
- `tests/fuzz/fixtures/open-body-overlap-on-folded-turn.json`
- `tests/fuzz/fixtures/open-body-overlap-on-impossible-short-leg.json`
- `tests/fuzz/fixtures/open-claim-held-by-immobile-vehicle.json`
- `tests/fuzz/fixtures/open-elevation-step-at-ramp-plate.json`
- `tests/fuzz/fixtures/open-pedestrian-on-crossing-of-reserved-connector.json`
- `tests/fuzz/fixtures/open-pedestrian-stalls-while-crossing.json`
- `tests/fuzz/fixtures/open-road-drawn-over-road.json`
- `tests/fuzz/fixtures/open-unrelated-body-overlap-near-bridge.json`
- `tests/fuzz/fixtures/opposing-mouth-stop-line-budget.json`
- `tests/fuzz/fixtures/pedestrian-crossing-agent-seed5.json`
- `tests/fuzz/fixtures/pedestrian-crossing-seed3.json`
- `tests/fuzz/fixtures/pedestrian-landing-seed5-b.json`
- `tests/fuzz/fixtures/pedestrian-reservation-seed6.json`
- `tests/fuzz/fixtures/pedestrian-vehicle-body-seed5.json`
- `tests/fuzz/fixtures/short-approach-past-chain-node.json`
- `tests/fuzz/fixtures/short-transition-mouth-gap.json`
- `tests/fuzz/fixtures/stop-line-inside-wide-junction-mouth.json`
- `tests/fuzz/fixtures/stub-taken-by-plate-at-road-end.json`
- `tests/fuzz/fixtures/turn-shaped-for-the-bus-alone-on-gentle-bend.json`
- `tests/fuzz/fixtures/wide-legs-overlap-on-short-acute-link.json`
- `tests/studios/model.native.mjs`

### crime, polícia e moradores com vida interior (SAI) (32)

- `src/backup/README.md`
- `src/backup/crime/crime-shots.mjs`
- `src/backup/crime/crime.spec.ts`
- `src/backup/crime/crime.ts`
- `src/backup/residents/play.ts`
- `src/backup/residents/render/indoors.ts`
- `src/backup/residents/scripts/agent-card-shots.mjs`
- `src/backup/residents/scripts/agents-shots.mjs`
- `src/backup/residents/scripts/cycle-shots.mjs`
- `src/backup/residents/scripts/life-shots.mjs`
- `src/backup/residents/scripts/player-shots.mjs`
- `src/backup/residents/sim/agents/activities.ts`
- `src/backup/residents/sim/agents/cars.ts`
- `src/backup/residents/sim/agents/manoeuvre.ts`
- `src/backup/residents/sim/agents/mind.ts`
- `src/backup/residents/sim/agents/player.ts`
- `src/backup/residents/sim/ambient/play.ts`
- `src/backup/residents/sim/city/life.ts`
- `src/backup/residents/sim/city/population.ts`
- `src/backup/residents/tests/sim/agents/activities.spec.ts`
- `src/backup/residents/tests/sim/agents/cycleLane.spec.ts`
- `src/backup/residents/tests/sim/agents/jobs.spec.ts`
- `src/backup/residents/tests/sim/agents/kerbParking.spec.ts`
- `src/backup/residents/tests/sim/agents/lotPlan.probe.ts`
- `src/backup/residents/tests/sim/agents/mind.spec.ts`
- `src/backup/residents/tests/sim/agents/ownCars.spec.ts`
- `src/backup/residents/tests/sim/agents/player.spec.ts`
- `src/backup/residents/tests/sim/agents/walk.spec.ts`
- `src/backup/residents/tests/sim/city.spec.ts`
- `src/backup/residents/tests/sim/transit/transit.spec.ts`
- `src/backup/residents/ui/agentCard.ts`
- `src/backup/residents/ui/playerHud.ts`

### gerador e criador de pessoas (SAI) (19)

- `src/people/gen/accessories.ts`
- `src/people/gen/catalog.ts`
- `src/people/gen/clothes.ts`
- `src/people/gen/extras.ts`
- `src/people/gen/hair.ts`
- `src/people/gen/hairSculpt.ts`
- `src/people/gen/humanBase.ts`
- `src/people/gen/makehuman.ts`
- `src/people/gen/names.ts`
- `src/people/gen/person.ts`
- `src/people/gen/sampleBody.ts`
- `src/render/people/generator/accessories.ts`
- `src/render/people/generator/fabric.ts`
- `src/render/people/generator/humanMesh.ts`
- `src/render/people/generator/stage.ts`
- `src/render/people/generator/strands.ts`
- `src/ui/creator/creator.ts`
- `src/ui/creator/icons.ts`
- `src/ui/creator/store.ts`

### sandbox e studios (SAI) (12)

- `src/sandbox/agent.ts`
- `src/sandbox/body.ts`
- `src/sandbox/main.ts`
- `src/sandbox/nav.ts`
- `src/sandbox/objects.ts`
- `src/studios/README.md`
- `src/studios/audio.ts`
- `src/studios/main.ts`
- `src/studios/mapView.ts`
- `src/studios/model.ts`
- `src/studios/style.css`
- `src/studios/threeView.ts`

### arquivo da raiz sem uso no build nem na verificação (10)

- `.claude/launch.json`
- `.claude/settings.json`
- `.gitignore`
- `AGENTS.md`
- `CLAUDE.md`
- `PROMPT-AGENTES.md`
- `PROMPT-PENDENCIAS.md`
- `README.md`
- `maps/cidade-com-estacionamento.json`
- `vite.lab.config.ts`

### página de laboratório (SAI) (9)

- `animation-system.html`
- `human-generator.html`
- `material-system.html`
- `people-lab.html`
- `sandbox.html`
- `signal-system.html`
- `sound-system.html`
- `traffic-system.html`
- `transit-system.html`

### fora do fecho de importações do jogo (4)

- `src/render/citizens.manifest.json`
- `src/render/people/hairEditor.ts`
- `src/render/people/peopleLab.ts`
- `src/world/nav/path.ts`

### usa arquivo que não entra: src/people/gen/humanBase.ts (3)

- `tests/people/dressing.spec.ts`
- `tests/people/humanBase.spec.ts`
- `tests/people/person.spec.ts`

### gerador de humanos (SAI) (1)

- `src/humanGenerator.ts`

### laboratório de armas (modo Jogar, SAI) (1)

- `src/weaponsLab.ts`

### usa arquivo que não entra: src/studios/model.ts (1)

- `tests/studios/model.spec.ts`

## Ferramenta (SHA-256)

- fecho.mjs 6f636dcbaa685ccf4f1a0464fe35da6ce30b0a0cf6b7fb965f92c14c2a833836
- usados.mjs 2d4351aad0a57d31b33b38a73c9b401d65eccac95b992c43db28d9b9e2cd6292
- copiar.mjs b5ac6538840c9c74b6d57113b8d20852905c74f9435697d3565703d591533ab1

## Complemento: dados de teste lidos do disco

Os specs leem dados com `readFileSync` (não por importação), o que o fecho não via:
`tests/fixtures/**`, `tests/fuzz/fixtures/**` e os arquivos que um spec nomeia
(`maps/cidade-com-estacionamento.json`). 47 arquivos a mais, copiados dos blobs e
conferidos por `git hash-object` (a ferramenta passou a não sobrescrever arquivo que
já existe no repositório). Lista completa atualizada em `docs/migration/copiados.txt`.

## Retirada do que é SAI de dentro dos arquivos usados (guiada por ferramenta)

- `main.ts`: o ramo `__PLAY_MODE__` do laboratório de armas (import de
  `./weaponsLab`, que não foi copiado); a chave `__PLAY_MODE__` sai de
  `globals.d.ts`, `vite.config.ts` e `vitest.config.ts`. O `tsc` passa sem erros.
- `recast-navigation`: nenhum fecho o importa; `npm uninstall`.
- 560 textos de interface sem referência no código copiado (`hgen` 369, `agent`
  102, `lab` 76 e 13 avulsos), achados por `textos-sem-uso.mjs` (conservador: todo
  token `a.b.c` ou prefixo `a.b.` do código conta como uso) e retirados pelos nós de
  sintaxe do TypeScript (`remover-chaves.mjs`), nunca por substituição de texto.
- `app.css`: `.inspect-card.bad` só casava com o laboratório de armas
  (`oldInterface.spec` o acusou).
- `package.json`: scripts que apontavam para arquivos não copiados (`verify:*`,
  `screens`, `perf:gate`) saem; `gate` entra; servidores de desenvolvimento na 5300
  (as portas antigas guardam mapas do jogador).

## Prova de igualdade pela build

As duas builds de produção (`build:modos`) da FONTE e do repositório novo, comparadas
arquivo a arquivo (`comparar-builds.mjs`, nomes casados sem o hash, fim de linha
normalizado porque a FONTE foi extraída com CRLF):
- 4.401 de 4.445 arquivos iguais. Todos os blocos de JavaScript, workers e assets
  são idênticos, exceto o `index-*.js` de cada modo.
- `index-*.js` (`comparar-index.mjs`): igual ao da FONTE depois de tirar dele as
  1.120 entradas de texto retiradas, trocar as duas impressões digitais de
  cozimento (a lista de assets de pessoas perdeu `expressions.bin/json`, sem uso) e
  ignorar o selo da build (`unknown` → `main 42c87ca`). Nenhuma outra diferença.
- CSS: só as duas regras retiradas. `index.html`: só os nomes com hash.
- Pessoas cozidas de novo neste repositório (o selo mudou pela lista de assets): as
  37 classes procedurais são idênticas byte a byte; os 16 corpos são idênticos fora
  um UUID aleatório do three.js gravado em cada um.
