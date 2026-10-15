# Estado do Roadcraft 2

O único documento de estado. Achado novo entra aqui; correção feita sai daqui e vai para
`OTIMIZACAO.md` (causa, técnica, fonte). Não crie relatório, prompt ou plano paralelo.

Escrito em 2026-10-15, juntando as auditorias de 14 e 15/10 (dez arquivos, removidos; estão no
git). Cada achado foi conferido por agentes no código **commitado de `fix/workers-10km`
(`3780807`)**, numa leitura rápida (poucas consultas por achado). Os números de linha são desse
ramo. **Reconfira na linha antes de corrigir.** Bytes e milissegundos são estimativas de leitura,
não medidas.

## Ramos e trabalho em andamento

- `main` (`d546ae7`) está **97 commits atrás** de `fix/workers-10km`. Esse ramo contém o `main` e
  todos os `fix/*` já integrados. Quem ler só o `main` vê código velho.
- O worktree `rc2-wt/workers-10km` tem alterações sem commit de outro agente: `perfBudget.ts`,
  `main.ts`, `playEffects.ts`, `postprocess.ts`, `renderer.ts` e `tests/core/cityBudget.spec.ts`.
- Ainda fora de `fix/workers-10km`:
  - `fix/growth-worker`: o crescimento da cidade num worker, 10 commits próprios.
  - `fix/gerador-workers`.
  - `fix/render-cidade`: 1 commit, "só as células na vista em detalhe (L0)". Mexe na qualidade e
    pede foto e o sim do jogador.
  - `worktree-agent-*`: 9 ramos de agentes de 14/10, com 1 a 4 commits cada.
- Worktrees com mudança sem commit: `render-cenario` (3 arquivos de `src`), `world-2` (2 testes),
  `topo-swap` (pasta de bancada solta), `profiler-10km` e `probe10` (sondas soltas).
- Na pasta principal há trabalho sem commit de outro agente: `editor/commit.ts`,
  `world/changes.ts`, `world/doc.ts`, `core/layeredMap.ts` e o teste dele. Na integração,
  `core/forkMap.ts` (no ramo) e `core/layeredMap.ts` (aqui) fazem a mesma coisa: fica um só.

## Achados abertos (ordem de impacto)

### Memória de vídeo e desenho
- **Residência do detalhe sem teto.** Em perspectiva, `reach = Infinity` (`renderer.ts:3196`), e
  a única expulsão exige `Number.isFinite(reach)` (`buildings/layer.ts:656`). A memória de vídeo
  cresce com a área visitada, e a célula que volta é reemitida. Correção: residência por
  orçamento de bytes; quem sai cai na massa e volta sem refazer.
- **Alvos de render e sombra fora da conta.** `core/perfBudget.ts:196` passa `null`, e
  `memoryCounters.ts` só percorre a cena (MSAA HalfFloat, sombra 4096). Correção: somar os alvos
  vivos × `samples`.
- **Atributos `color` e `roadSection` em toda faixa de via** (`mesh/surfaceMesh.ts:68-69`,
  `mesh/tileMesh.ts:83`): 24 de 56 B por vértice nas faixas que não os leem. Correção: o
  `SurfaceSpec` declara o que usa.
- **Jardins com buffer do tamanho da cidade**, que nunca encolhe (`gardens.ts:512,516`). Os
  stores de corpo e de cartões guardam as mesmas matrizes (`:281-287`).
- **Geometria não indexada**: `structures.ts:414` (6 vértices por quad) e `vehicleModels.ts:298`
  (`toNonIndexed`). Correção: quads indexados e `mergeVertices`.
- **Cerca de 43 chamadas de desenho por célula**: uma malha por acabamento e um `InstancedMesh`
  por tipo de peça (`buildingMesh.ts:3531,3573`). O `BatchedMesh` foi desfeito porque guarda os
  arrays na CPU (`OTIMIZACAO.md` #2).
- **Índices `Uint32`** em `buildings/massing.ts:132` e `buildingMesh.ts:3457`; não se conferiu
  se esses arrays vão à GPU. Em `cellArrays.ts` os índices já são `Uint16`.
- **Pede foto e o sim do jogador** (muda o desenho longe):
  - prédios de assinatura sem nível de longe (`massing.ts:157`, `&& !signature`);
  - placa de terreno com conteúdo sem LOD (`flatAtlas.ts:104`).

### Thread principal
- **Simulação na página** (`main.ts:2797`, `SIM_FRAME_BUDGET_MS`), sem worker nem
  `SharedArrayBuffer`. Correção: `SimWorld` num worker com os deltas do diário, poses em memória
  compartilhada e COOP/COEP no Vite e no Electron (`OTIMIZACAO.md` #3).
- **Crescimento da cidade fatiado** (`main.ts:2200-2273`, `GROW_SLICE_MS`) e traçado dos postes
  fatiado (`roads/powerLine.ts:39`): é amortização. A correção está em `fix/growth-worker`, ainda
  não mesclado.
- **Natureza**: uma placa varrida por quadro (`renderer.ts:2359-2393`, amortização), e
  `new CandidateKeep` com todas as árvores (`:3045`). Correção: a varredura no worker e trocar só
  a fatia da placa.
- **Varredura da cena atrás de variantes de shader** a cada 2 s (`renderer.ts:3112`), que
  compila durante o jogo. Correção: catálogo fechado, compilado na abertura.
- **Abertura**: `net.rebuild({ full: true })` (`history.ts:155`), e `readDerivedAll` lê o cache
  inteiro para a memória (`renderer.ts:792`).
- **Ganchos do profiler sempre instalados** (`main.ts:707`, `profiler.ts:88`, que gera
  `new Error().stack` por upload). Correção: instalar só com a HUD ou em DEV.

### O(mapa) por edição
- **`snapshotRoads` faz `doc.clone()`** (`editRules.ts:114`) a cada edição no lugar
  (`main.ts:862`). Correção: julgar sobre `doc.fork()`, como `commitRoadPath` já faz.
- **`Network.adopt` copia a rede inteira** (`network.ts:270-300`), chamado de 10 lugares e duas
  vezes por via desenhada. Correção: fork da rede em camadas, `adopt` só do delta.
- **`elevation.ts` percorre todas as fitas** a cada solução (`:448`), mais `JSON.stringify` no
  digest (`:1177`).
- **Autosave**: `dirtyHead` regrava a cabeça inteira, com tudo que não é prédio
  (`chunkedSave.ts:133,179`). Abaixo de 3.000 prédios, `persistence.ts:188` grava o documento
  inteiro. Correção: cabeça em partes pelo diário, gravada num worker (OPFS).
- **Desfazer**: `DocImage` faz `structuredClone` de nós, segmentos, postes, paisagem e barreiras
  (`docImage.ts:83,117`) e compara as listas por prefixo e sufixo (`:186`). Além disso,
  `doc.ts:2086` registra `'utilities'` sem ids.
- **28 `JSON.stringify` em `doc.ts`**, que comparam coleções em `replaceContents` (`:2217-2248`).
- **Terreno**:
  - carimbo descarta a malha feita no worker (`terrain.ts:3125`);
  - `new TerrainIndex` com todos os carimbos a cada revisão (`:3102`);
  - texturas e buffers reenviados inteiros, sem `addUpdateRange`.
- **`flatAtlas.ts`**:
  - cada placa filtra todas as pinceladas (`:435-444`);
  - `letGo` joga fora a placa, que volta refeita (`:299-307`).
- **Derivados por revisão global** em `renderer.ts`:
  - cobertura: `coverSweep` por `forestRevision:waterRevision` (`:2547, 2982`);
  - elementos refeitos inteiros por `elementRevision:terrainRevision` (`:3535`);
  - árvores plantadas por `treeRevision` (`:3086`);
  - `watchRoads` copia todas as faixas uma vez por segundo (`:1314`).
- **Ferramenta de lotes**:
  - `lotAt` faz `doc.lots.find` até 400 vezes por movimento (`lotTool.ts:359,552`);
  - o overlay recompõe todos os lotes;
  - a chave da proposta usa `net.revision` (`:259`).

  Correção: `doc.lotsIn(caixa)`, que o próprio arquivo já usa em `:217`.
- **Simulação**:
  - `refreshJunctionOrder` ordena todas as junções a cada edição (`sim/world.ts:534`);
  - `rebindVehicles` percorre a frota inteira (`pipeline.ts:167-200`);
  - o laço de sinais passa por todos, inclusive os adormecidos, a cada tick (`pipeline.ts:92`);
  - o conselheiro de controle visita todas as junções a cada 10 s (`controlAdvisor.ts:37`);
  - as paradas são todas varridas (`transit/transit.ts:268`);
  - `trainZones` é montado a cada tick (`walk.ts:1952`).
- **Frota copiada ou varrida**:
  - por tick em `lotTraffic.ts:156,269,309` e `lorryTraffic.ts:136,247`;
  - por quadro no desenho (`render/agents.ts:2120`);
  - por corpo em `wallsNear` (`playEffects.ts:307`).
- **Ragdoll**:
  - alocações por quadro (`ragdoll.ts:2027-2034`, `:1421`);
  - um campo de altura por corpo (`:1526`);
  - `ragdollGround` com teto que esvazia tudo (`playEffects.ts:240`).
- **Multidão cozida**: mistura a paleta na CPU e copia por pessoa (`riggedCitizens.ts:793,911,1143`).
- **188 leituras de revisão global** ainda suprimidas em `eslint-suppressions.json`, em 35
  arquivos (`renderer.ts` 42, `doc.ts` 23, `flatAtlas.ts` 19, `main.ts` 15, `terrain.ts` 7). O
  motor tem só 6 `engine.register`; os demais derivados se atualizam sozinhos.
- **Baixo**:
  - `conflictPool.ts:283` não chama `terminate` nos workers já criados quando a criação falha;
  - arquivos de 3.500 a 4.500 linhas (`main.ts`, `renderer.ts`, `buildingMesh.ts`).

### Decisões do jogador
- **Tetos que apagam trabalho**: `MAX_PLANTED_TREES = 20_000` (`doc.ts:1334`) e os elementos
  (`:1381`); o desfazer descarta os passos mais antigos por bytes (`history.ts:128`).
- **Registro de prédio de cerca de 7 KB**, que daria 560 MB a 80 mil prédios. Guardar só semente
  e lote muda o gerador.

### Divergências entre agentes (conferir na linha)
- **`GTAOPass`**: um agente diz que o `normalRenderTarget` é alocado sem uso
  (`postprocess.ts:262`, sem `depthTexture` no construtor; `GTAOPass.js:225,317` do r186). O
  outro diz que não procede.
- **`simShowsMotion`** (`main.ts:2870`), que pede quadro contínuo enquanto houver controlador:
  um agente diz que é um custo; o outro, que é só o desenho contínuo com a simulação viva.

### Não conferidos (precisam de medida no jogo)
- Heap de cerca de 100 KB por prédio.
- Lixo de cerca de 30 MB/s.
- Via que leva 9 a 10 s (R8).
- Abrir o mapa grande (R3).
- GPU de 18,6 ms no mapa inteiro.
- Reiluminar com o sol ≥ 2°.
- `lanelets.takeWhole`.

## Já corrigidos no ramo (não repetir como aberto)

- Transporte e névoa pelo diário.
- Ravinas: `setGullies` é vazio.
- Florestas célula a célula (`plantCells.ts`).
- Trava do ESLint `no-global-revision`.
- Cache LRU dos chunks.
- `CACHE = 6` do atlas.
- Chave JSON do `lotTool`.
- Ladrilhos de via sem arrays na CPU.
- `pedPoseInto`.
- `lanelets` por delta.
- Emissão de células em worker (`cellPool.ts`).
- Paredes de estacionamento por `store.near`.
- `matrixAutoUpdate = false` nos prédios.
- `changedSites` pelo diário.
- `changedSegments` pelo diário.
- Céu sem overdraw: nunca foi problema, já que `skyMesh.visible = false`.

## Documentos

| Arquivo | O que é |
|---|---|
| `CLAUDE.md` | As regras. O único arquivo de instruções. |
| `docs/ESTADO.md` | Este: o estado e o que está aberto. |
| `OTIMIZACAO.md` | O registro das correções (causa, técnica, fonte). |
| `docs/ARCHITECTURE.md` | Como o código está montado (em inglês). |
| `docs/PESQUISA-CIDADE-10KM.md` | Pesquisa com fontes para a cidade de 10 km. |
| `docs/research/` | Pesquisas técnicas com fontes (controladores, barreira de regressão, proteções, juntas do ragdoll; `source/fase-0-medida.md`). |
| `docs/source/CREDITOS.md` | Licenças dos recursos externos. Não apagar. |
| `docs/source/VIAS.md`, `ESCALA.md`, `ZONEAMENTO.md`, `performance.md`, `PROBLEMAS.md`, `PLANO.md`, `investigacao-populacao.md`, `relatorio-desempenho-mapas-enormes-2026-10-11.md` | Especificações e registros do jogo antigo que o código cita pelos números dos itens. |
| `docs/PLAN.md`, `STATUS.md`, `PROBLEMS.md`, `CIDADE-10KM.md`, `AUDITORIA-2026-10-14.md`, `PLANO-ESPINHA-2026-10-14.md` | HISTÓRICO, citados pelo código. Não são lista de trabalho. |

Removidos em 2026-10-15 (estão no git): os dez relatórios e prompts de 15/10, o relatório de
14/10, `MIGRATION.md` e a lista de cópia, `PROMPT-AUDITORIA.md`, a pasta `reference`, as fases 1-8
de `docs/research/source/`, `gate.md`, a especificação externa e quatro arquivos de
`docs/source/`.
