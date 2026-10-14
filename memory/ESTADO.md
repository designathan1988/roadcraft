# Estado do trabalho — reescrever a cada mudança (não acumular)

Atualizado: 2026-10-14 (noite).

## Quem está trabalhando
- **"Auditoria de desempenho three.js"**: otimização, correções no código (prédios, renderer,
  world, editor, sim), regras estáticas em `scripts/check-code.mjs`.
- **"Análise de otimização e desempenho do jogo"**: monta com o jogador um plano em duas frentes
  (mecanismos automáticos; causas grandes) dividido entre as sessões; nada dividido sem o sim dele.
- **"Hook de busca na internet"**: agentes em worktrees (2026-10-14 noite): pisca-pisca/faces
  coplanares e profundidade invertida, LOD de prédio perto + pontilhado/embaçado, câmera tremendo
  (gesto que depende do tempo dos quadros; olho dentro de copa de árvore), sobreposição dos lotes
  na GPU. Ferramentas de medida (`__roadcraft.memory()`,
  `__roadcraft.budget('rua'|'bairro'|'mapa')`, `src/core/perfBudget.ts`), fotos e gestos
  (`scripts/look.mjs`), o acusador (`scripts/acusar.mjs`), as skills `.claude/skills/`, o
  `CLAUDE.md` da raiz, contadores de trabalho por evento (testes de escala). Pendente dela, para
  quem continuar (2026-10-14 ~16h40, o jogador vai trocar de conta):
  - contadores por evento todos feitos no "um prédio a mais" (`tests/scale/buildingEdit.spec.ts`):
    diário `ground`/`ground:idle` (C1/D8), `bays` (B10), `yards` (B14), `solids` (A8/C5), `pads`
    (C8), x3,82; `gardens` (C2, numa cidade com árvore em cada jardim) x14,02, quadrático. Para os
    três do renderer, a parte que decide refazer saiu dele, sem mudar comportamento:
    `cameraSolidsKeeper` (`world/buildings/cameraSolids.ts`), `siteGrading`
    (`world/buildings/siteGrading.ts`), `gardenLists` (`render/gardenLists.ts`). O conserto de cada
    um (auditoria) é nesses módulos; ao consertar, tirar a linha de `baseline.json` no mesmo commit;
  - a regra "como adicionar um produto derivado" está no CLAUDE.md da raiz (sim do jogador,
    2026-10-14);
  - LSP (`workspaceSymbol`) e context7 conferidos e funcionando (2026-10-14);
  - referência offline: `C:/Codex-Shared/referencia/` (three.js r186 inteiro e 4 projetos;
    índice no `README.md` de lá).
- Combinado: uma não edita arquivo que a outra está mexendo; commit só dos próprios arquivos
  (caminhos explícitos). Cada arquivo salvo recarrega o jogo na 5300.

## Repositório
- No GitHub (`origin/main`): até `b8c63c3` (enviado em 2026-10-14 com o sim do jogador: os 28 commits
  de `247e770` a `b8c63c3`, das duas sessões).
- Local, não enviado (envio depende do jogador): `81c6ffb` (auditoria) diário com um anel por tipo
  (D8/C1); `c45806a` (auditoria) camada de prédios incremental pelo diário (A1, com A5 e A16); o
  commit de memória que vier depois deles.
- Não commitado (sessão de auditoria):
  - Em `git stash` ("portador das cascas (em espera)"): `buildingMesh.ts` + `kit.ts`, "portador de envio" das cascas (malha invisível
    que força o envio da geometria à GPU para soltar os arrays). **Em espera**: os 1,8 GB de cascas
    presas na CPU não se reproduziram; pode jogar até 583 MB na placa (teto do plano 300). Decidir com
    medição na sequência exata da outra sessão (cidade salva, recarregar, vista salva zoom 11,44,
    medir entre 70 e 92 s), com e sem o portador, olhando `budget('rua')`.
  - (nada além do stash do portador)
- Não mexer (de outros): `docs/RELATORIO-DESEMPENHO-2026-10-14.md`, `tests/scale/buildingEdit.spec.ts`,
  os apagados `.claude/*`, `.githooks/pre-push` (o jogador apagou; nunca commitar a deleção nem restaurar).
- Stashes: `stash@{0}` emitTileMass (L2/L3 de massa, WIP); `stash@{1}` emissão de prédios em worker
  (WIP); os demais antigos de agentes.
- Cópia congelada para sondas longas: worktree em
  `%TEMP%/claude/C--Codex-Shared-roadcraft-2/19e8abda-.../scratchpad/probe-tree` (servida na 5301,
  junções para `node_modules` e `cooked`). Atualizar com `git -C <dir> checkout --detach <commit>`.
- Servidores: 5300 = árvore principal (`npm run dev`), 5301 = cópia congelada.
- **Portas do jogador, nunca sondar nem apagar dados**: 4180, 4181-4183, 5173, 5175-5178, e a pasta
  `C:/Codex-Shared/backup-mapa-jogador`.

## Medidas de referência
- Cidade de 2.560 m (21.120 lotes): lotes aos 70 s; antes das correções de hoje prédios aos 188 s e
  queda para 4 prédios/s depois de 14 mil (jardins). Vista geral nessa cidade: 1 fps (durante o
  crescimento). Heap vivo depois de coletar: 727 MB.
- Triângulos por quadro (outra sessão, cidade de 5.400): rua 42 M (teto 10 M; sombras ~19 M, sombra
  das peças 8,2 M); bairro 32 M; mapa 15 M (teto 4 M; vias 6,3 M em 700 chamadas, postes e fios 4 M).
- Ordem combinada para o desenho: 1) sombra por tamanho na tela (peças e cascas); 2) vias com nível
  de longe; 3) fios e postes por distância, sem sombra longe; 4) L2/L3 dos prédios.

## Mecanismos contra a volta dos padrões (em construção)
Pesquisa: `docs/research/` + memória do assistente (regression-barrier-research*.md). Fontes novas
lidas em 2026-10-14: CLARITY (Olivo, Dillig, Lin, PLDI 2015, travessia redundante), Salsa
(vermelho-verde, backdating), Jane Street Incremental, Nystrom "Dirty Flag" e "Spatial Partition",
Google Benchmark BigO, Epic "Min Screen Radius for Cascaded Shadow Maps", ESLint (só por função).
1. Regras estáticas em `scripts/check-code.mjs` (linha de base que só encolhe):
   - `whole-map-nested`: laço sobre coleção do tamanho do mapa cujo corpo (ou o que ele chama) percorre
     outra coleção do mapa. Função marcada `@rebuild` declara-se amortizada e não conta.
   - `whole-map-per-item`: varredura do mapa alcançável de função marcada `@perItem` (por prédio
     crescido, por linha de postes, por movimento do ponteiro, por edição de um item).
2. Caminho fácil certo: índice espacial dentro do `BuildingStore` (único escritor), `buildings.near(caixa)`
   na ordem de inserção; derivados por item lidos do diário (`doc.changes.since`).
3. Contadores de trabalho por evento (outra sessão): um prédio a mais em cidade de N e de 4N → o mesmo
   trabalho em cada produto derivado.

## Auditoria por padrão
Relatórios completos em `docs/AUDITORIA-2026-10-14.md`. Maiores, por área:
- Prédios: `replaceWith` clona a cidade por edição de rua (A3); desgaste refaz massas que não
  dependem dele (A6); validação e clique varrem todos os prédios (A9/A10). (A1, A2, A5, A7, A16 feitos.)
- Editor/sim/ui: geração quadrática (`growOnLot` com `neighbourStoreys`/`nearSignatures` dentro de 18
  tentativas, `doc.lots.filter` por prédio, `addPlaced`, `cornerOf`); sim refaz carros parados, lugares,
  pátios a cada prédio; overlay de lotes em JSON por quadro; snap varre tudo por movimento. Decisão do
  jogador pendente: um cruzamento trocando de controle reinicia os semáforos do mapa (achado 15).
- Render: superfícies unem a calçada do mapa por edição; cânion, plataformas, atlas do chão, mobília,
  semáforos refeitos inteiros. (C1 e C3 feitos.)
- World/core: `landOn` das calçadas varre todos os caminhos por ponta de travessia (~4×10⁹ na meta);
  `onPaving` testa todos os furos; calçadas e `crosswalkDistanceAt` refeitos por edição; LRU dos postes
  (64) mistura células e regiões (origem provável de 17 s + 35 s). (D8, anel do diário, feito.)

## Feito hoje à noite (auditoria, nova conta)
Clique em prédio (`f1405fa`), item 34 registrado, A2 (`e5ec4e5`), A7 (`cf0917d`), C3 (`de7588d`), D8/C1
(`81c6ffb`), A1+A5+A16 (`c45806a`). Contadores fora da base: `building+1:ground`, `ground:idle`, `layer`.

## Feito na raiz (Hook, 2026-10-14 tarde/noite; OTIMIZACAO 40-47)
Postes inteiros: calçada pela volta dos anéis e contorno por índice (`9233238`), planejador por
ladrilho na geração (`82c0239`), meio-fio pelos anéis (`8e65f88`), fios instanciados dobrados no
shader (`bdda55a`), peças no carregamento (`a1dd21a`). Agentes revisados: recorte dos jardins
(`90524a3`) e da mobília (`b5cc51d`), curvas sem trabalho jogado fora (`7c046a4`). Sonda no
`look.mjs` (`profile`/`city`/`memory`, quadros longos com a função culpada e perfil de CPU).

## Feito na raiz (Hook, 2026-10-14 noite; OTIMIZACAO 48-50)
Camada de postes incremental lida do diário, índice de postes no documento (`5f52364`; saíram
`UTILITY_PACE` e `holdUtilities`); travessias e limite dos lotes por chave (`73d3536`); estoque de
prédios sem cópia por JSON e digests das vagas (commit seguinte); churrasqueiras removidas
(`05f8780`, pedido do jogador); OTIMIZACAO com a regra "amortização nunca é feito" e 12, 13, 20
remarcados (`beffd63`); `look-compare.mjs` e `"cpu": N` no `look.mjs` (`834b75c`). Hook de pesquisa
(`~/.claude/hooks/research-gate.mjs`): pega cp/mv/rm, git merge/stash pop/reset --hard,
--fix/--write/--update, scripts avulsos que escrevem; `>=` e `git merge-base` não dão falso bloqueio;
mensagem do jogador no meio do turno (attachment `queued_command`) reabre a exigência. A mensagem
com links NÃO é exigida pelo hook: o transcript não guarda o texto escrito junto de várias chamadas.

Depois, na mesma noite: câmera sem trepidar (`aaa7b85`: o ponto olhado só sobe ao telhado com olho
e ponto dentro; velocidade da mão pelo tempo dos eventos e `getCoalescedEvents`; deslizamento que
continua o gesto, decaimento exato no tempo); profundidade invertida em float e patamar da escada fora
do plano do pátio (commit "Z-fighting…", `depthConvention.ts`); `look.mjs` com arrasto no ritmo da mão
(`"ms"`, `"hold"`, `6c73fbe`: soltar parado dá a mesma câmera em duas rodadas); acusador com a regra
`copia-tipada` (`5531d6c`, 38 pistas; agente trocando por `BufferAttribute`).

## Divisão aprovada pelo jogador (2026-10-14, plano da sessão "Análise")
- Hook: look.mjs/look-compare, acusar, perfBudget, hook de pesquisa, documentos (OTIMIZACAO
  "Conferido e correto" sem proteger revisão global/cutChunks/"sem alocação"; STATUS/RELATORIO/
  PROBLEMS como históricos), `lotOverlay` (LAY_SLICE_MS) e os agentes de render (z-fighting, LOD,
  câmera).
- Análise: simulação inteira (inclusive `sim/agents/parking.ts` workOutBays/wallsOf e o worker),
  check-code, contadores do passo, catálogo de referências, limpeza (knip/check-refs).
- Auditoria: prédios (montagem da célula em worker: layer.ts, layerCells.ts, townIndex.ts,
  buildingMesh.ts), sólidos da câmera.
- Checagem rápida no fim do turno religada (`eff6d94`, `.claude/settings.json`); `.githooks/pre-push`
  continua apagado.

## Sonda de ponta a ponta, cidade de 2.560 m (2026-10-14 noite, HEAD 2ee8af5)
Sumiram do perfil da geração: poleLinesIn, insideRing, routeGraph, cloneBuilding, landOn, covered,
word, curvas. Tempos absolutos NÃO valem: a máquina estava ~2× mais lenta (agentes rodando o jogo;
meshTile/sampleAtInto, código igual, dobraram) — geração 170 → 282 s. Achado: `cameraSolids` 16 s
(corrigido pela auditoria em `eb31083`). Mapa: 36 M → 5,5 M triângulos, 2.780 → 420 chamadas, GPU p95
63 → 22 ms; geometria presa na CPU 2,1 GB → 113 MB. Repetir com a máquina livre.

## Causas ainda abertas, achadas pela sonda na cidade de 2.560 m (Hook)
- Amortizações ainda no código: `LAY_SLICE_MS` (sobreposição dos lotes; agente da Hook trabalhando
  na textura vista de cima), cache LRU dos prédios (auditoria), crescimento e traçado em fatias com
  `holdBuildings`, simulação com teto `SIM_FRAME_BUDGET_MS`.
- Vagas: `workOutBays`/`wallsOf` O(N) por passada (O(N²) no crescimento): frente da sessão Análise.
- LOD: depois de mover a câmera, 3-4 s com todos os prédios da tela no nível simplificado (fotos
  `%TEMP%/rc2-hook/maos-1/09-02-giro-parado.png`); com o agente do LOD.
- Sombras: serrilhado em degrau no rodapé e nos degraus, tracejado no batente da porta, caminho do lote
  atravessando o degrau de baixo; com o agente do z-fighting.
- Câmera: olho dentro de algo em `setView({x:20,y:-20,zoom:80,azimuth:4.0,elevation:0.25})` e rente a
  parede em `{x:11.5,y:-11.5,zoom:200,azimuth:0.785,elevation:0.1}` (cidade padrão); com o agente
  da câmera. Olho dentro de copa de árvore: decisão do jogador (sólido macio x pontilhado da folhagem).
- Simulação na thread principal (31% do quadro explorando a cidade padrão): worker (OTIMIZACAO 3).
- Matrizes da cena refeitas a cada quadro (`updateMatrixWorld` ~1 s em 42 s): objetos estáticos sem
  `matrixWorldAutoUpdate`.
- Programas de shader ligados no primeiro desenho (`getProgramInfoLog` 0,5-1,4 s): compilar antes.
- Geração: `cloneBuilding` em `add`/`put`, `digest.word`, `landOn` das calçadas (D), `lotPlan.covered`.

## Próximos passos (em ordem)
1. Câmera dentro de prédio (defeito antigo, visto 2026-10-14 nas duas versões): com
   `setView({x:11.5,y:-11.5,zoom:200,azimuth:0.785,elevation:0.1})` na cidade de semente 1 a tela
   fica cinza (olho dentro do volume); com `{x:20,y:-20,zoom:80,azimuth:4.0,elevation:0.25}` o olho
   atravessa a fachada e vê a sala. Também: prédio recém-crescido no lote onde está o olho (tela
   cinza). O afastamento da câmera (`cameraSolidsKeeper` + rig) não age; os muros dos lotes não contam.
2. Cascas L0 na placa: 795,1 MB no bairro (teto 300) depois de passar pela rua (cidade padrão,
   `setView` bairro → rua → bairro); igual antes e depois do A1, então é anterior.
3. Contadores ainda na base: jardins (C2, x14,02, `render/gardenLists.ts`), sólidos da câmera (A8/C5,
   `cameraSolidsKeeper`), plataformas (C8, `siteGrading`), baias (B10) e pátios (B14) do sim.
4. Etapa 1 do desenho: sombra por tamanho na tela (peças e cascas).
5. Defeitos vistos (fotos em `%TEMP%`): fresta preta comprida entre volumes de um prédio de perto
   (`roadcraft-look/2026-10-14T16-03-43-146Z/15-rua-arrastada.png`); triângulo azul-escuro no piso
   atrás de um banco (`rc2-hook/triangulo.png`); retângulo claro translúcido junto ao poste da cerca
   (`setView({x:60,y:10,zoom:120,azimuth:5.5,elevation:0.2})`, `rc2-hook/fixo-antes/27-h-jardins.png`);
   pessoa atingida pela bomba atravessando o poste de uma cerca; sombra pontilhada de copa no gramado;
   clique entre as barras de grade/portão pega a grade (caixa cheia).
6. Marcar `@perItem` nos outros pontos de entrada por item (movimento do ponteiro, edição de um item);
   o clique (`buildingTool.pick`) ainda copia o estoque inteiro por movimento (A9).

Detalhe do que já foi feito: `memory/FEITO.md`. Histórico: `memory/DIARIO.md`.
