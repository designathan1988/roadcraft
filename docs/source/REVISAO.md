# Revisão do master — 2026-10-09 (rodada 1)

Revisor: ramo `revisao` (worktree próprio), base `817c1261` (master). Escopo:
merges de hoje desde `ec320d2e` (vias V1-V7 e catálogo, cidade em
quarteirões, prédios variados, lotes cortados, cidade povoada, cortina de
carga + autosave IndexedDB, grama oliva, noite sem bloom estourado) — 132
arquivos, +11 171/-1 247. Ramos ativos: `vias`, `predios`, `interface`,
`arte`, `camera` e o de desempenho estão sem commits à frente do master; o
da caminhada (`worktree-agent-ae0d63665879ae83a`) tem 1 (`41d8b4c5`), ainda
não revisado.

## Suíte e fuzz no master

Rodada em `revisao` = master `817c1261` + as duas correções abaixo, com
`VITEST_MAX_WORKERS=2` e `run-limited` (sem cobertura, para poupar a CPU):

- **lint:** verde.
- **typecheck:** verde no código do master; só o teste novo deste ramo tinha
  `number` no lugar de `NodeId` (corrigido no commit seguinte).
- **vitest (inclui o portão do fuzz: `tests/fuzz/fuzz.spec.ts` 6 sementes e
  `regressions.spec.ts`):** EM ANDAMENTO — a ~1 teste a cada 9 s com 2
  workers e a máquina ocupada por outras sondas, a suíte inteira leva mais
  de uma hora; o resultado entra na rodada 2.
- **build de produção** (`C:/Codex-Shared/road-revisao-dist`): na fila,
  depois da suíte.
- Hunt do fuzz (sementes 7-30): não rodado ainda; o STATUS registra 4
  defeitos fora do portão.
- Conflito de trava: com esta suíte rodando, `docs/.heavy-lock` foi
  sobrescrito por "arte probe" (outro agente não esperou); duas sondas e um
  `cook:people` rodavam ao mesmo tempo às 19 h.

## Achados por gravidade

### QUEBRA

**Q1. Cada via desenhada apagava, no mapa inteiro, o que o jogador ajustou nos
cruzamentos (V4 conexões de faixa, V5 regra por perna e semáforo).**
- Prova: `tests/world/nodeSettingsKept.spec.ts` (novo) falhava 3/3 no master.
- Causa: `RoadDoc.replaceContents` (`src/world/doc.ts`) recriava os nós sem
  `laneLinks`, `approachRules` e `signal`; todo traço de via faz
  `doc.replaceWith(work)` (`editor/commit.ts`), e desfazer/refazer também.
  Além disso `sameNode` não comparava esses três campos e `sameSegment` não
  comparava `cutWalls`: desfazer só um ajuste de semáforo ou só o muro de
  arrimo não registrava mudança de via (nada era refeito na tela nem na
  simulação).
- Origem: vias V4 (`7739d5a9`) e V5 (`988f09f3`/`22295baf`), V3 (`8f5ae89c`)
  para `cutWalls`; entrou no master pelos merges `a6cf2c8e` e `b0bf4f7f`.
- Dono: vias. **Corrigido** no ramo `revisao` (commit `Cruzamento não perde
  mais...`): os três campos copiados e comparados, `cutWalls` comparado. Os
  specs `junctionRules` e `laneConnectors` continuam verdes.
- Arquivo quente (`world/doc.ts`): correção de defeito, anunciada aqui.

**Q2. Painel de teclas da ferramenta de vias deixava o ouvinte antigo vivo.**
- Causa: `ui/roads/keysPanel.ts` testava `if (!open)` (o painel do módulo),
  não o próprio painel: reaberto, o ouvinte velho continuava; com um chip
  esperando tecla, roubava a próxima tecla (e a gravava na ação velha), e Esc
  fechava o painel novo. Origem: V3 (`6bfcfcd5`). Dono: vias.
  **Corrigido** (`e8a4a574`): compara com o próprio `root`.

### REGRESSÃO DE DESEMPENHO / RISCO DE CPU

**D1. Carga atrás da cortina pode girar um núcleo a 100 %.** `FrameClock`
(`src/frameLoop.ts`, `1febdf94`) troca o rAF por `MessageChannel` enquanto
`scene.opening`; e o `draw` chama `onAssetsReady()` em todo quadro não
mostrado (`renderer.ts`, ramo `else onAssetsReady()`). Resultado: enquanto a
cidade não está "inteira" (esperando worker, GLB, compilação), quadros vazios
se encadeiam sem pausa, inclusive com a aba oculta, até 90 s de trabalho
(`REVEAL_LIMIT_MS`). Somado às fatias de 250 ms (`HIDDEN_SLICE_MS` no
renderer e na camada de prédios, `LOADING_SLICE_MS` 120→250 na topologia),
um quadro de carga pode bloquear ~750 ms. Contraria a regra "nunca saturar a
CPU". Sugestão (dono: desempenho/abertura): enquanto só se espera algo
assíncrono, pedir o próximo quadro por `setTimeout(…, 16)`, ou só repostar
pelo canal quando houve trabalho no quadro. Medida pendente (sonda não
rodada nesta rodada: trava pesada ocupada).

**D2. `setNodeSignal` refaz a malha das vias em volta do nó.** Mudar o tempo
de um semáforo chama `markNode` → `doc.revision` (malhas, marcas) quando só
a simulação muda (devia mexer só em `trafficRevision`). Local (retângulo do
nó), mas a cada clique de stepper do painel. Dono: vias. Limpeza de
desempenho.

**D3. `fitFree` em `world/lots.ts` é quadrático.** Cada lote candidato
filtra TODOS os lotes já postos (`kept` + `add`, com `rectAround` alocando)
antes do recorte booleano: ~n² em cidade de 1 500 lotes. Sugestão: grade
espacial de caixas. Dono: prédios/lotes. Medir o tempo de gerar a cidade.

**D4. `footwayRiseAt` por pedestre por quadro** (`render/agents.ts`), mais
postes, placas e mobiliário: varredura linear das vias com calçada rente
(`world/roads/footwayRise.ts`), com `sampleAt` alocando. Barato hoje (poucas
vias rentes); cresce com pedestres × vias rentes. Dono: vias. Sugestão: grade
de células como em `lanesNear`.

### RISCO

- **R1. Determinismo da simulação.** `AmbientWorld.refreshPlaces` resolve os
  caminhos dos lotes por tempo de relógio (`WAYS_MS`, `performance.now()` em
  `sim/`); hoje `placesReady()` passou a decidir a abertura povoada
  (`openPeople`) e o `keepWalking`: a mesma cidade enche diferente conforme a
  máquina. Contraria o espírito do invariante 5. Dono: caminhada/população.
- **R2. Autosave IndexedDB** (`editor/persistence.ts`): `saveSession` devolve
  `true` antes de o IndexedDB gravar; se falhar, `onSaveFailed` só chega
  depois. A chave pequena antiga continua com o mapa velho completo até o
  ponteiro ser gravado — correto (o mais novo vence por `savedAt`), mas um
  mapa grande que nunca gravou no IndexedDB reabre o mapa pequeno antigo sem
  aviso na abertura. Dono: abertura.
- **R3. Controles nativos novos:** `<select id="paintStyleSelect">`
  (`index.html`, V6) e o `<input>` de nome no editor de perfil. O shell v2
  usa um proxy (`segProxy`); conferir na tela que o nativo não aparece.
- **R4. `main.ts` cria a cortina de carga com estilo inline** e texto fixo
  (`t('map.loading')` lido uma vez: não muda com a troca de idioma). O
  STATUS ainda diz "sem tela de carregamento" nas decisões do jogador; o
  pedido URGENTE PA-U1 mudou isso — atualizar o STATUS.

### LIMPEZA

- `render/signs.ts`: `postMaterial` e `CylinderGeometry` novos a cada
  `buildSigns` (anterior a hoje); o atlas novo das placas está certo
  (uma malha, sem transparência, células liberadas).
- `render/buildings/buildingMesh.ts`: `new Color(1,1,1)` por malha montada
  (`setColorAt(0, …)`), agora em três tipos de peça; trocar por constante.
- `sim/ambient/ambient.ts` `keepWalking`: `[...this.roaming]` copiado a cada
  passo (alocação por tick).
- `sim/agents/lotTraffic.ts`: `call` e `depart` montam `Set`/`Map` de strings
  de todas as vagas a cada consulta (1/s); aceitável hoje.

## Conferido sem achado

- Camadas: nenhum `three` fora de `render/` (só `src/sandbox`, fora do jogo);
  nenhum `Math.random` novo em `world/`/`sim/`.
- Prédios: a mudança de cor por instância (caixilhos, guarda-corpos) usa
  material próprio branco por tipo (sem variante trocada); `roofPlant` é
  semeado por prédio; `buildings.revision` não toca `doc.revision`.
- Placas num atlas, jardins empacotados por lista (`gardenPack`), caixas de
  talude por registro (`bankBoxes`), `macroNoise` sem closures: ganhos reais.
- Listeners do editor de perfil (resize, ResizeObserver) liberados no
  `dispose`.

## Não feito nesta rodada (motivo)

- Medidas de desempenho (cidade 4242, 400/400, draw calls, memória ao
  reabrir o mapa) e fotos dia/noite master × `ec320d2e`: a sonda está pronta
  (`rev-probe.mjs` no scratch) e a cópia de `ec320d2e` extraída; esperam a
  trava pesada (a suíte e as sondas de outros agentes a ocupam).
  **SEM VERIFICAÇÃO VISUAL nesta rodada:** nenhuma foto tirada ainda; as duas
  correções (Q1 dado do documento, Q2 ouvinte de teclado) não foram vistas
  no jogo.
- O merge `571babea` (caminhada, `41d8b4c5`) entrou no master durante a
  revisão: lido (`walk.ts`, fila larga na guia); `room()` agora é chamado duas
  vezes por pedestre por passo (custo pequeno); o próprio commit diz 8 de 10
  cidades do `defects.spec` verdes (faltam player-city e mixed-lanes).
