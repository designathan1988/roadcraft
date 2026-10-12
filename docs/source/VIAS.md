# Sistema de vias (agente em segundo plano, ramo `vias`)

Proposta aprovada pelo jogador em 2026-10-09. O sistema de vias completo é feito
por um agente em segundo plano, num worktree próprio (ramo `vias`), enquanto a
sessão principal segue a Etapa 5 do `docs/PLANO.md`. Uma etapa por vez; ao fim de
cada uma o agente para e relata, a sessão principal confere no jogo e repassa ao
jogador, e só com a aprovação dele a etapa entra em `master` e a seguinte começa.

## O que existe e é reaproveitado (não se refaz)
- Seção: `world/roadTypes.ts` (classes, `roadProfile()` em camadas), `world/roadSection.ts`
  (ajuste por trecho e seta por faixa), `world/section.ts` (zonas de calçada), ciclofaixa
  (`world/parking.ts`).
- Superfícies: `world/surfaces.ts`, `render/roadSurfaces.ts` (bandas por subtração de
  polígonos, tiles com digest, rebaixamento `curbRamp`).
- Elevação e estruturas: `world/elevation.ts`, `world/structures.ts`, `render/structures.ts`,
  túnel automático (`editor/commit.ts`), recusas (`editor/editRules.ts`).
- Ferramenta: `editor/roadTool.ts`, `editor/snap.ts`, `editor/commit.ts`.
- Faixas, conectores e conflitos: `world/lanelets.ts` (`buildJunctions`), `world/turnPaths.ts`,
  `world/conflictPoints.ts`.
- Controle: `JunctionControl` (`world/doc.ts`), `sim/intersections/admission.ts`, `sim/signals/`;
  roteamento por faixa (`sim/drive/tactical.ts`).
- Mobiliário, postes e placas: `world/landscape.ts`, `world/streetFurniture.ts`,
  `editor/streetscapeTool.ts`, `render/scenery.ts`, `editor/poles.ts`, `world/poleLines.ts`,
  `render/utilities.ts`, `render/signs.ts`.
- Sinalização: `world/markings.ts`, `world/parkingLayout.ts`.
- Salvar: `world/doc.ts`, `editor/persistence.ts` (campo novo opcional, com padrão).
- Detectores e medida: `tests/fuzz`, `tests/arch`, `core/health.ts` (F9), `hitch:`,
  `scripts/probe-baseline.mjs`.

## Isolamento
- Worktree com o ramo `vias`. O agente nunca faz commit em `master` nem push; a sessão
  principal faz o merge depois da conferência e da aprovação.
- Código novo em pastas próprias dentro das camadas: `src/world/roads/`, `src/editor/roads/`,
  `src/ui/roads/`, `src/render/roads/`, `src/sim/roads/` (cobertas pelo eslint e por `tests/arch`).
- Arquivos quentes (`main.ts`, `world/doc.ts`, `render/roadSurfaces.ts`, `world/markings.ts`,
  `world/lanelets.ts`, `render/agents.ts`): o agente só os edita em commits de integração
  declarados no relato; a sessão principal não os edita enquanto a etapa do agente estiver
  aberta, salvo correção de defeito, avisada.
- CPU: só os specs dos arquivos tocados, `scripts/run-limited.mjs`, `VITEST_MAX_WORKERS=2`;
  suíte e fuzz uma vez no fim da etapa, sem tarefa pesada da sessão principal ao mesmo tempo
  (marcador `docs/.heavy-lock`).

## Módulos novos
- `world/roads/tuning.ts`: valores de ajuste num lugar só (inclinação 8% via, 12% rampa curta,
  35% recusa; altura livre 5,5 m sobre via e 4,5 m sob viaduto urbano; ponte acima de 6 m do
  terreno; túnel com cobertura de 7 m ou mais; vão de pilares 25-35 m; postes 30-38 m;
  limiares de fluxo). Os valores espalhados hoje passam a ler daqui.
- `world/roads/profile.ts`: perfil ordenado (calçada, faixa, ciclovia, faixa de ônibus, bonde,
  estacionamento, canteiro, meio-fio, acostamento; largura, altura relativa, sentido, classes
  permitidas, velocidade, material) e um adaptador que gera o `RoadType` atual, para os
  consumidores migrarem um a um. As classes atuais viram modelos; `RoadSegment.profile?` opcional.
- `world/roads/templates.ts`: modelos salvos.
- `world/roads/connectors.ts`: conectores por nó, padrão derivado + `RoadNode.laneLinks?` à mão
  (nunca sobrescrito; links para faixas que sumiram são limpos).
- `world/roads/rules.ts`: a regra é a fonte e a placa é derivada (velocidade, controle,
  `blockedMovements`, proibido estacionar).
- `world/roads/markingStyle.ts`: padrão regional trocável (Brasil/CONTRAN por padrão).
- `world/economy.ts`: saldo e custos.
- `sim/roads/flowStats.ts` e `sim/roads/controlAdvisor.ts`: fluxo por aproximação e escolha
  do controle por tendência.
- `editor/roads/`, `ui/roads/`, `render/roads/`: construção com elevação, editor de perfil e de
  conectores, painel do cruzamento, preview pelos mesmos construtores de malha.

## Donos das sobreposições com a Etapa 5
| Item | Dono | Como o outro usa |
|---|---|---|
| 5a detectores | sessão principal | o agente cobre os objetos novos e adiciona ops de fuzz |
| 5b objeto composto do lote, calçada↔portão, rebaixamento nos portões | sessão principal | sai da lista do agente |
| 5f catálogo por dados | sessão principal | o agente registra o mobiliário urbano nele |
| 5h postes que cruzam ruas | sessão principal | o agente faz a rede elétrica sobre o `planPoleRun` corrigido |
| 5e luzes por classe | sessão principal | o poste ilumina por esse sistema |
| rebaixamento e piso tátil nas faixas | 5c (feito) | o agente desenha o piso tátil sobre as rampas |

## Decisões do jogador
- Economia mínima já: saldo inicial configurável, custo por metro por elemento e por estrutura
  (ponte e túnel mais caros), custo no preview, débito na construção, devolução no desfazer,
  bloqueio sem saldo, devolução parcial na demolição; salvo no documento.
- Mobiliário automático por padrão em vias novas (conjunto "completo", trocável na construção);
  revoga a ordem de 2026-10-05 só para vias novas; vias existentes não mudam sozinhas; objeto
  automático editado à mão é preservado.
- Controle dos cruzamentos aplicado sozinho pela tendência medida (não por pico); a escolha
  manual trava o cruzamento, com opção de destravar.

## Adiado ou simplificado
- Pré-visualização do perfil na própria via selecionada, sem janela 3D à parte.
- Bonde: elemento e trilho visuais com ponto de integração; o veículo depois.
- Emergência: não há veículos de emergência; depois.
- Energia, drenagem, lixo e incêndio: ponto de integração apenas.

## Etapas (uma por vez, com aceite do jogador)
| Etapa | O quê | Aceite | Estado |
|---|---|---|---|
| V0 | Base: worktree, `tuning.ts`, contrato de dados, rede e elevação incrementais, economia mínima | mapas antigos idênticos; sem regressão no `probe-baseline`; fuzz verde; custo no preview, debitado e devolvido | em andamento (ver "Andamento da V0") |
| V1 | Perfil livre: adaptador, assimetria, material, meio-fio pela diferença de altura, UV sem esticar, modelos, aplicar sem demolir | testes de perfil; mapas antigos idênticos; perfis novos no jogo | feito no ramo, aguardando o jogador (ver "Andamento da V1") |
| V2 | Editor visual do perfil com validação e modelos | uso no jogo | feito no ramo, aguardando o jogador (ver "Andamento da V2") |
| V3 | Construção com elevação: preview pelo mesmo código, chão/aterro/ponte/trincheira com muro/túnel, feedback, teclas configuráveis | preview = resultado (teste); sem quadro longo no arraste | feito no ramo, aguardando o jogador (ver "Andamento da V3") |
| V4 | Conectores de faixa, classes por faixa, troca de faixa por tipo de linha | veículos seguem as conexões; testes | feito no ramo, aguardando o jogador (ver "Andamento da V4") |
| V5 | Cruzamentos inteligentes: CTB, Pare/Dê a preferência, minirrotatória, fluxo, escolha automática com trava, painel; semáforo editável, adaptativo, onda verde, prioridade de ônibus | testes de simulação; uso no jogo | feito no ramo, aguardando o jogador (ver "Andamento da V5") |
| V6 | Sinalização no chão regional e editável; placas instanciadas | uso no jogo | feito no ramo, aguardando o jogador (ver "Andamento da V6") |
| V7 | Mobiliário no catálogo da 5f, NBR 9050, conjuntos, automático, em linha, placa = regra, poste ilumina, rede elétrica | uso no jogo; detectores | primeira fatia no ramo (ver "Andamento da V7") |
| V8 | Complementares (ônibus com baia, retornos, balão, inverter mão, conta-gotas, edição em massa, nomes e numeração, casos de borda) | uso no jogo | em andamento (ver "Andamento da V8") |

## Andamento da V0
- `world/roads/tuning.ts`: feito. Os valores que já valiam no jogo continuam iguais (travados por
  `tests/world/roadTuning.spec.ts`); onde a referência real diverge, ela fica ao lado, para decisão
  do jogador: inclinação de via em nível 12% no jogo contra 8% de referência (TxDOT); altura do
  viaduto 5,6 m na superfície (4,4 m livres sob a laje) contra 5,5 m livres sobre via e 4,5 m sob
  viaduto urbano; túnel automático a 18 m de cobertura contra 7 m de cobertura mínima; vão dos
  pilares 29,6 m (elevado) e 38,4 m (ponte) contra 25-35 m; postes 38 m contra 30-38 m.
- Rede e alturas incrementais: feito (`docs/PROBLEMAS.md` PV1). `Network.rebuild()` compara de que
  cada trecho e nó foi feito com o que a última reconstrução registrou e só refaz o que mudou;
  `rebuild({ full: true })` ao abrir mapa (`editor/history.ts` `restoreInto`).
  `buildRoadElevation(net, chão, anterior)` reaproveita as estações e os pedaços conexos iguais; o
  renderizador passa a solução anterior enquanto o chão não muda, as regras de edição usam
  `FLAT_GROUND`. Oráculo `tests/world/incrementalRebuild.spec.ts`; medida `tests/bench/roadRebuild.spec.ts`.
- Economia mínima: feito. `world/economy.ts` (preço por metro quadrado de pista, canteiro e calçada,
  vezes o comprimento em cada modo de construção: chão 1, aterro 1,4, trincheira 1,8, ponte/viaduto 2,5,
  túnel 6; o modo vem da estrutura ou da altura definida sobre o chão projetado) e
  `editor/roads/economy.ts` (cobrança única: o que as vias valem depois menos antes; devolução de 25% do
  que sai). Cobrado em `commitRoadPath`, `commitDraft`, `guardRoadEdit` (todas as edições no lugar),
  `moveNodeChecked` e no Demolir; recusa `funds` com o motivo no preview; custo no rótulo do preview;
  saldo no documento (`RoadDoc.economy`, gravado só fora do saldo inicial, validado em
  `isSerializedDoc`), por isso o desfazer devolve; saldo na barra de cima. Saldo inicial 20 milhões
  (a cidade de teste vale 16,5 milhões). A cidade gerada (`generateCity`) não é cobrada.
- Contrato de dados da V0: só `SerializedDoc.economy?: { balance }`.
- Fechamento da V0 no ramo (2026-10-09): lint e typecheck limpos; suíte inteira 1068 testes verdes, fuzz
  smoke verde; 2 falhas que já falham em `e10aab08` (antes da V0): `tests/world/terrace.spec.ts`
  (degraus do quintal, lotes da sessão principal) e `tests/render/occupantFit.spec.ts` (falta
  `docs/audit/seated-pose-extents.json`, arquivo não versionado). Fotografado na build de
  desenvolvimento do ramo: saldo na barra, custo no rótulo do preview, débito, desfazer devolvendo,
  preview vermelho "dinheiro insuficiente". Aguardando a conferência no jogo e a aprovação do jogador.

## Andamento da V1
- Perfil livre (`world/roads/profile.ts`): elementos ordenados da borda esquerda à direita (de A para B);
  o adaptador grava os campos que o trecho já tinha (faixas, sentido, seção, estacionamento), então todo
  consumidor lê o perfil sem migração. Em vez de um campo `RoadSegment.profile` novo, a `RoadSection`
  ganhou campos opcionais (calçada de cada lado, calçada no nível da rua, canteiro pintado, materiais):
  uma fonte só por trecho.
- Assimetria: calçadas de larguras diferentes em cada lado, de verdade na fita, nas pernas e quinas da
  junção, na transição, no encadeamento, nas zonas da calçada, nos caminhos de pedestre, no grafo de
  calçada, no mobiliário, nas placas e nas travessias. Faixas com larguras diferentes e quantidades
  diferentes por sentido ficam para a V4 (conectores e classes por faixa), recusadas com o motivo.
- Material: pista (asfalto, concreto, paralelepípedo), calçada de cada lado (bloquete, concreto, pedra),
  canteiro (grama, concreto, bloquete). Hoje é o tom sobre a textura que já existia (a pista muda na boca
  da junção); texturas próprias por material ficam pendentes.
- Meio-fio pela diferença de altura: calçada no nível da rua não tem meio-fio nem degrau; pessoas,
  postes, placas e mobiliário ficam no nível dela (`world/roads/footwayRise.ts`); não há rebaixamento de
  meio-fio onde não há meio-fio. Canteiro pintado não tem ilha.
- UV sem esticar: a calçada é texturizada no comprimento real de cada linha paralela à via, em painéis
  (`surfaceFrameAt`, `panel`), com junta a cada painel.
- Modelos: as classes viram modelos; o jogador salva os seus (no navegador) e aplica num trecho
  existente sem demolir, pelo inspetor (bloco "Perfil da via"), pago e julgado como qualquer edição.
- Detectores: `tests/world/oldMapsIdentical.spec.ts` (mapas antigos idênticos), operação `profile` no
  fuzz (calçadas assimétricas e no nível da rua), `tests/world/roadProfile.spec.ts`.

## Andamento da V2
- Pesquisa (lida): Streetmix, especificação de segmentos (https://docs.streetmix.net/contributing/code/reference/segments:
  o corte é uma sequência de segmentos sem sobreposição, cada um com uma faixa, objetos e marcas, altura relativa ao
  nível da rua) e o código de redimensionar (https://github.com/streetmix/streetmix/blob/main/client/src/segments/resizing.ts,
  `constants.ts`: largura arredondada à resolução, presa entre mínimo e máximo, 0,1 m por clique e por arrasto). Aqui a
  resolução é 1 m porque a seção grava larguras inteiras da grade (`roadSection.ts` `onGridLength`). Road Builder para
  Cities: Skylines II (https://github.com/JadHajjar/RoadBuilder-CSII): faixas arrastadas de uma lista para o corte no
  centro, reordenadas arrastando, opções de cada faixa sobre ela, propriedades da via num painel à parte, miniatura gerada
  de cada via. Cities: Skylines II, ferramenta de vias (https://cs2.paradoxwikis.com/Roads): modos de traçado, elevação
  em passos, substituir. Network Multitool (https://github.com/MacSergey/NetworkMultitool) é edição de geometria de nós e
  trechos (CS1; a página de descrição não abriu): entra na V3/V8, não no editor de perfil.
- Editor (`ui/roads/profileEditor.ts`, `ui/roads/crossSection.ts`, `ui/roads/roads.css`): corte desenhado em SVG à escala
  do metro (asfalto com linha pintada e seta, carro de costas na faixa para B e de frente na faixa para A, calçada com piso
  e pessoa, ciclofaixa verde com ciclista e placa de bicicleta, vaga com carro e placa P, canteiro com árvore), cotas em
  metros por baixo, borda arrastada muda a largura, elemento arrastado muda a ordem (a coluna inteira acima do elemento o
  pega), selecionado com contorno; modelos em cartões com a miniatura do corte (classes, os do jogador, em branco);
  "Adicionar" em paleta de ícones que põe cada elemento onde a via o aceita; propriedades num bloco com stepper, botões
  segmentados e interruptor (nenhum select, checkbox ou caixa de número); problema com ícone no bloco do elemento e selo no
  desenho, aplicar e salvar presos enquanto houver problema; "Desenhar vias novas com ele" (linha "Perfil" da ferramenta
  de vias, cobrado como a via).
- Inspetor: só o resumo (corte em miniatura com cotas, faixas, piso, velocidade) e "Editar perfil"; os selects de classe,
  sentido, faixas e vagas saem quando o editor existe.
- Detectores: `tests/ui/roadProfileEditor.spec.ts` (nenhum controle nativo no editor e no inspetor, problema no bloco do
  elemento, coluna inteira clicável, carro de frente e de costas, modelo salvo vira cartão escolhido, desenho em menos de
  2 ms por chamada).
- Desempenho: durante o arrasto só o SVG do corte é refeito (um `innerHTML`); medido no Chrome headless da iGPU durante um
  arrasto de largura de 40 passos: 1,3-2,4 ms por redesenho (máximo 2,4 ms), contra 16,7 ms de um quadro. Nada muda no
  quadro do jogo com o editor fechado.
- Fotos (1280x720): pasta de rascunho da sessão, `fotos-v2b/01..17`.

## Andamento da V3
- Pesquisa (lida): Network Multitool, código das ferramentas de criação
  (https://github.com/MacSergey/NetworkMultitool, `ToolModes/ConnectionModes/BaseCreate.cs`): calcula os pontos uma vez
  quando a entrada muda (`Calculate`, `CalcState`), tira o custo desses mesmos pontos, desenha a prévia deles
  (`RenderOverlay`) e constrói com eles (`Create(points, ..., cost)`); atalhos de cada modo nas configurações. WSDOT Design
  Manual M 22-01, cap. 730 "Retaining Walls and Steep Reinforced Slopes"
  (https://wsdot.wa.gov/publications/manuals/fulltext/M22-01/730.pdf, lido em texto): muro onde falta faixa de domínio para
  o talude; em corte, muros ancorados, grampeados (soil nail) e em balanço, de base estreita; MSE pede base de 70% da altura
  e não serve em corte.
- Prévia = construção: o dry run da prévia (`commitRoadPath` com `dryRun`) devolve as estações da via (`DraftResult.stations`,
  a cada 2 m: deck resolvido pelo mesmo `buildRoadElevation`, chão natural, modo de construção), da mesma rede de trabalho e
  da mesma solução de alturas que o commit; o desenho da prévia passa a usar essas estações quando o rascunho é julgado
  (120 ms parado); antes disso, a estimativa de sempre. `world/roads/buildMode.ts`: chão, aterro, trincheira, ponte, túnel,
  pelos limiares com que o jogo constrói (`RAISED_LIFT`, agora declarado uma vez em `world/structures.ts` e lido por
  `render/structures.ts` e `render/roadSurfaces.ts`; `TUNNEL_BORE`; `fillFrom`). Teste `tests/editor/buildPreview.spec.ts`:
  via erguida em pilares e via atravessando um morro, dry run contra a via construída e resolvida do zero, deck e modo iguais
  em cada estação.
- Feedback: a prévia pinta entre o deck e o chão o aterro (terra), a trincheira (cinza com a crista), os pilares da ponte e
  escurece o trecho em túnel; o rótulo diz o comprimento, o custo e os trechos ("ponte 170 m", "túnel 100 m · trincheira
  80 m").
- Teclas configuráveis (`ui/roads/keys.ts`, `ui/roads/keysPanel.ts`): subir e descer a via e trocar o traçado (padrão
  Page Up, Page Down, V); linha "Teclas" na ferramenta de vias abre o painel; uma tecla dada a uma ação sai da outra; teclas
  do jogo (ferramentas, câmera, números, Esc) recusadas com o motivo; as frases que citam as teclas usam as escolhidas
  (`setGlobalParams` em `ui/i18n`). Teste `tests/ui/roadKeys.spec.ts`.
- Defeito achado ao usar (classe): a altura nas opções da ferramenta mostrava o passo anterior quando mudada pelo teclado;
  agora o painel observa o texto que o jogo escreve (`shell.ts`, `mirrored`).
- Trincheira com muro (`RoadSegment.cutWalls`, opcional no documento, ausente em todo mapa antigo): linha "Corte: Talude |
  Muro" na ferramenta de vias. Com muro, o modelador do terreno corta só a faixa de um emboque de túnel
  (`CUT_WALL_REACH` = `SHAPE_INNER` + `CUT_SHOULDER`, `world/elevation.ts`) e o renderizador ergue em cada borda da pista um
  muro de concreto do pé sob a via até um coroamento sobre o chão natural, com o reaterro no material do próprio terreno por
  cima da faixa cortada (nunca uma "manta verde"), só onde a via está em trincheira aberta (`buildModeAt`, nunca sobre um
  túnel), com tampa nas pontas. Copiado ao dividir, duplicar e juntar vias. Detector `tests/world/cutWalls.spec.ts`: salvo e
  ausente nos mapas antigos, corte não passa do reaterro, muro do pé sob a via ao topo, reaterro assentado no chão (sem
  flutuar nem enterrar), nenhum muro sobre um túnel. O preço continua o da trincheira.
- Desempenho (`tests/bench/roadRebuild.spec.ts`, BENCH=1, cidade de teste, mediana de 5): dry run 5,9 ms, dos quais as
  estações 0,19 ms (a solução do teste de túnel é reaproveitada); commit 6,0 ms, igual. Arraste na sonda headless: quadro
  mediano 2,5 ms. Muros: uma malha só (faces) e uma de reaterro por reconstrução dos detalhes, só para vias com muro.
- Fechamento no ramo: lint limpo, suíte inteira 1123 verdes (a falha antiga de `occupantFit` à parte), fuzz smoke verde.

## Andamento da V4
- Pesquisa (lida): Traffic Manager: President Edition, código do conector de faixas
  (https://github.com/CitiesSkylinesMods/TMPE, `TLM/Manager/Impl/LaneConnection/LaneConnectionSubManager.cs`): uma faixa com
  conexões próprias usa só elas, as outras ficam com as do jogo; faixa inválida perde as conexões; as setas são recalculadas
  das conexões. Manual Brasileiro de Sinalização de Trânsito, vol. IV, Sinalização Horizontal (CONTRAN, PDF no site do DNIT,
  https://www.gov.br/dnit/pt-br/rodovias/operacoes-rodoviarias/faixa-de-dominio/regulamentacao-atual/microsoft-word-04-mbst-vol-iv-sinaliza_347_343o-horizontal_f.pdf,
  lido em texto): LMS-1 (linha simples contínua, branca, 0,10-0,15 m) proíbe ultrapassagem e transposição entre faixas de
  mesmo sentido; LMS-2 (seccionada) permite; MFE (faixa exclusiva no fluxo) é uma linha contínua de 0,20-0,30 m, contínua em
  toda a extensão exceto onde a entrada ou saída é permitida.
- Conectores à mão: `RoadNode.laneLinks` (opcional, ausente em todo mapa antigo; `world/roads/connectors.ts`). Para cada faixa
  que chega listada, `lanelets.ts` `buildJunctions` constrói exatamente essas conexões (movimento proibido no nó continua
  proibido); as outras faixas ficam com as derivadas; link para faixa que sumiu fica fora (e uma faixa cujos links sumiram
  todos volta às derivadas). Editor no inspetor do cruzamento ("Conexões de faixa"): planta do nó virada como a câmera vê,
  faixas que chegam em azul e que saem em verde, conexões construídas em curvas; clicar numa que chega acende as dela,
  clicar numa que sai liga ou desliga; a primeira edição parte das conexões que o jogo construiu; tirar a última saída de
  uma faixa é recusado com o motivo; "Restaurar automáticas".
- Classes por faixa e tipo de linha: `RoadSection.useForward/useBackward` ("all" | "bus") e `linesForward/linesBackward`
  ("dashed" | "solid") por laneIndex, no perfil como `use` e `line` do elemento faixa (editor: "Uso: Todos | Ônibus",
  "Linha à direita: Tracejada | Contínua", travada em contínua ao lado de faixa de ônibus); problema `busOnly` quando um
  sentido fica só com faixas de ônibus. Grafo: `Lanelet.use`, `solidInner/solidOuter`; `LaneletGraph.laneUsable` e
  `changeTargets` (só através de linha tracejada, nunca para faixa que o veículo não pode usar). Simulação: o planejador de
  viagem (`drive/tactical.ts`), o roteador, a troca de faixa (obrigatória e discricionária) e o nascimento dos veículos usam
  essas regras. Pintura: linha contínua onde é contínua, linha larga contínua ao lado de faixa de ônibus.
- Detectores: `tests/sim/laneConnectors.spec.ts` (os veículos que saem da faixa com conexão à mão vão só por ela; link
  inválido; alternância parte do construído e nunca deixa faixa sem saída; seção salva e invertida; nenhum carro em faixa de
  ônibus e nenhuma troca através da linha dela em 200 s de tráfego; alvos de troca por linha e uso).
- Desempenho (cidade de teste, intensidade 3, 1200 passos): passo da simulação 0,150 ms antes e 0,149 ms depois; montagem do
  grafo de faixas na mesma ordem (7-12 ms, ruído de primeira execução). Alvos de troca guardados por faixa até o próximo grafo.
- Fechamento no ramo: lint limpo, suíte inteira 1130 verdes (a falha antiga de `occupantFit` à parte), fuzz smoke verde.

## Catálogo de estradas (pedido urgente do jogador, 2026-10-09)
- Pesquisa (lida): menu de vias do Cities: Skylines (https://skylines.paradoxwikis.com/Roads: abas Small, Medium, Large
  Roads, Highways, Intersections; variantes com árvores, ciclovia, faixa de ônibus, mão única; custo por célula, manutenção,
  velocidade, faixas) e do Cities: Skylines II (https://cs2.paradoxwikis.com/Roads: Small, Medium, Large, Highways; rua de
  duas faixas, mão única de 1 a 3, cascalho, viela, estacionamento perpendicular e angular, dividida; custo por km).
- `world/roads/catalog.ts`: 31 vias prontas em quatro categorias (Ruas, Avenidas, Rodovias, Especiais), todas no perfil livre
  (V1) sobre uma das classes, as seis classes entre elas como sempre foram; "Meus modelos" são os salvos do editor.
  Teste `tests/world/roadCatalog.spec.ts`: mais de 25 vias, todas construíveis como estão, as classes iguais.
- Galeria da ferramenta de vias (`ui/roads/catalogPanel.ts`): abas por categoria com a contagem, cartões grandes com o corte
  desenhado, o nome, a largura total e o preço por metro, dica com faixas, sentido e velocidade; clicar escolhe e a ferramenta
  já desenha com ela (a prévia usa o perfil escolhido); o escolhido com contorno e o botão "Personalizar…". As linhas
  Faixas, Largura e Vagas das opções só aparecem com uma classe pura; a linha "Perfil" da V2 saiu (o catálogo a substitui).
- Editor secundário: "Personalizar…" abre o editor ancorado entre a barra de cima e a galeria, compacto, recolhível, sem os
  cartões de modelo; "Salvar modelo" leva para "Meus modelos". Teste `tests/ui/roadCatalogPanel.spec.ts`.
- Modelos salvos agora guardam também o uso e a linha de cada faixa (V4).

## Andamento da V5
- Pesquisa (lida): CTB art. 29, III (texto reproduzido pelo Portal do Trânsito,
  https://www.portaldotransito.com.br/noticias/de-quem-e-a-preferencia-de-passagem-em-local-nao-sinalizado-2/; o Planalto
  recusou a conexão): sem sinalização, rodovia antes da via que cruza, quem circula na rotatória antes de quem entra, e nos
  demais casos quem vem pela direita. MUTCD 2009 sec. 2B.05-2B.07 (https://mutcd.fhwa.dot.gov/htm/2009/part2/part2b.htm: Pare
  só onde a parada é sempre necessária, Dê a preferência primeiro; Pare em todas com 300 veíc./h na principal e 200 na
  secundária) e sec. 4C.02, Warrant 1 (https://mutcd.fhwa.dot.gov/htm/2009/part4/part4c.htm: 500/150 ou 750/75 veíc./h).
  Minirrotatória (https://en.wikipedia.org/wiki/Mini-roundabout): ilha pintada ou domo transponível, quem entra cede a quem
  circula. Prioridade ao ônibus (https://en.wikipedia.org/wiki/Bus_priority_signal): extensão do verde até um máximo, verde
  antecipado encurtando as fases em conflito. Onda verde (https://en.wikipedia.org/wiki/Green_wave): ciclo comum, defasagem =
  distância / velocidade do pelotão.
- Regras (`world/roads/rules.ts`, a fonte; as placas derivam dela na V6): `RoadNode.approachRules` (regra de cada via sob
  controle "Placas": Preferencial, Dê a preferência, Pare; padrão: a via principal preferencial, as outras dão a
  preferência), `mainRoadLegs` (o par de pernas de maior classe, o mais reto no empate), `JunctionControl` ganhou `mini`.
  Simulação (`intersections/admission.ts`): Placas pela regra da perna; "Sem sinalização" pela CTB (rodovia primeiro, senão
  cada um cede só a quem vem da direita, `yieldSide`/`comesFrom`); minirrotatória: todos cedem, só a quem vem da esquerda.
- Fluxo e escolha automática (`sim/roads/flowStats.ts`, `sim/roads/controlAdvisor.ts`): veículos por hora entrando por cada
  perna, média móvel (janela de tendência 900 s); um cruzamento em "Automático" sobe e desce de preferência para Pare em todas
  para semáforo pelos limiares do MUTCD (agora LIVE em `roads/tuning.ts` `flow`), só depois de uma janela inteira medida,
  desce só abaixo de 80 % e muda no máximo uma vez por janela: pela tendência, nunca por pico. A escolha manual trava;
  "Destravar (automático)" volta.
- Semáforo (`signals/fsm.ts`): adaptativo (o atuado de sempre) ou tempo fixo com o verde de cada fase, defasagem pelo relógio
  comum (`seekFixed`); prioridade ao ônibus (verde estendido até 10 s para ônibus a até 90 u da linha; verde cortado após o
  mínimo para ônibus esperando em outra fase); onda verde (`sim/roads/greenWave.ts`): os semáforos da via principal num ciclo
  comum (a fase principal esticada) e defasagem pelo tempo de percurso.
- Painel do cruzamento no inspetor (`ui/roads/junctionPanel.ts`), só controles do tema (a pedido do coordenador e do
  jogador): altura em stepper; controle em botões (Automático, Semáforo, Placas, Pare em todas, Minirrotatória, Sem
  sinalização); escolha automática e fluxo por perna; trava; regra de cada via; tempos do semáforo, defasagem, onda verde,
  prioridade ao ônibus; movimentos por perna como chips por conversão. As alturas das pontas no inspetor da via viraram
  steppers. Minirrotatória com a ilha pintada no centro (`world/markings.ts`, recortada pela placa da junção).
- Defeitos achados ao usar: o painel não mostrava o bloco do semáforo até reabrir (a escolha chega com o grafo refeito):
  a chave de reconstrução do inspetor inclui agora o estado do semáforo e a revisão da topologia; a ilha da minirrotatória
  era recortada pela pintura das pernas.
- Detectores: `tests/sim/junctionRules.spec.ts` (regra por via, CTB direita e rodovia, minirrotatória à esquerda, nenhum
  travamento em 300 s de tráfego pesado em sem sinalização, minirrotatória e placas; limiares e histerese; cruzamento
  automático vira semáforo com controlador; fases do tempo fixo; corte do verde para ônibus; onda verde com ciclo comum).
- Limite conhecido: os conectores da minirrotatória continuam os da junção (uma conversão à esquerda passa sobre a ilha
  pintada, transponível); o contorno da ilha fica para a V8.
- Impasse do player-city (defects.spec, cruzamento parado 75 s com a cidade povoada ao abrir): não era admissão; um carro
  sem destino entrava numa rua cuja única saída, duas faixas adiante, é uma curva em que nenhum carro cabe (conector com
  `maxBodyClass` -1), e o roteador só olhava 5 faixas à frente; parava no fim da rota para sempre, a perna enfileirada.
  `sim/routing/router.ts` `trapLanes`: as faixas de onde um corpo nunca sai (descascadas de trás para frente, como as
  arestas "desconectadas" do SUMO), custo infinito no roteador. Antes/depois: cruzamento 75 → 19 s, carro parado 76 → 43 s.
  Detector `tests/sim/trapLanes.spec.ts`. Seguem falhando, da caminhada (não das vias): pedestre parado na calçada 5,9 s
  (player-city) e 10,3 s (mixed-lanes), iguais antes e depois.
- Fechamento no ramo: lint limpo; suíte inteira 1158 verdes; falhas: `occupantFit` (antiga) e
  `tests/world/lotPhysics.spec.ts` (lotes, vinda do master em 4223ce23, fora do sistema de vias).

## Andamento da V6
- Padrão regional do mapa (`world/roads/markingStyle.ts`, `RoadDoc.markingStyle`): Brasil (MBST vol. IV: amarelo entre
  sentidos, branco no mesmo sentido; tracejado 1:2 abaixo de 60 km/h, 1:3 acima, 4/12 m a partir de 80), EUA (MUTCD 3/9 m),
  Europa (branco entre sentidos) e Clássica (a pintura de antes). Mapa salvo antes abre Clássica e grava sem o campo;
  mapa novo nasce Brasil. Escolha no Menu, linha "Pintura" (desfaz como edição).
- Linha central por via (`RoadSection.centreLine`: tracejada LFO-2, contínua LFO-1, dupla LFO-3; ausente: a regra antiga),
  no editor de perfil ("Linha central", só com os dois sentidos sem canteiro).
- Legenda "ÔNIBUS" (BUS nos EUA/Europa) ao longo da faixa de ônibus, 12 m após o início e a cada 70 m, 1,6 m (2,4 m acima
  de 80 km/h), lida por quem vem pela faixa.
- A regra do cruzamento pintada e sinalizada (fonte única `rules.ts` `approachSign`): "PARE" antes da linha de retenção em
  cada faixa que para, triângulo (SIP) em cada faixa que dá a preferência; placa R-1/R-2 à direita de cada perna
  (`world/roads/derivedSigns.ts`), no atlas e instâncias das placas. Automático, semáforo e sem sinalização não põem placa.
  Placa de velocidade (R-19) após cada cruzamento em trechos de 60 m ou mais, só em mapa com padrão regional.
- Detector: `tests/world/roadPaint.spec.ts` (Clássica idêntica ao de antes, cores e tracejado por velocidade, linha dupla,
  ÔNIBUS dentro da faixa externa, PARE antes da linha e na metade de quem chega, placas fora da pista, à direita e voltadas
  ao motorista, velocidade só com padrão).
- Fica para depois: tracejado da linha de retenção de "dê a preferência" (LDP); placa "PARE" com "TODAS AS DIREÇÕES".

## Andamento da V7
- Feito: mobiliário automático nas vias novas (`world/roads/furnitureSets.ts`), conjunto escolhido na ferramenta de vias
  ("Mobiliário": Completo, padrão; Básico; Nenhum; guardado no navegador). Completo: poste a cada 30 m em cada lado
  (alternados), lixeira junto às esquinas e a cada 60 m, hidrante a cada 100 m (lado direito), banco a cada 60 m, árvore a
  cada 10 m; Básico: postes e lixeiras. As peças são itens comuns do paisagismo (`RoadDoc.landscape`), postas onde a
  ferramenta de paisagismo as poria (`snapLandscape`), no mesmo passo de desfazer da via; editadas ou removidas uma a uma,
  nada as recria. Vias já construídas não mudam. NBR 9050 6.12.3: a peça só vai se deixar 1,20 m livres ao lado (na
  calçada de 2 m vão postes e hidrantes; lixeiras e bancos, não). O poste acende à noite pelo sistema de luzes existente.
- Detector: `tests/world/roadFurniture.spec.ts` (faixa livre, sem sobreposição, determinismo, conjuntos).
- Segunda fatia: canteiro arborizado (`landscape.ts` `medianAt`/`plantedMedian`: canteiro de 1,5 m ou mais, com meio-fio, de
  grama) recebe as árvores do conjunto Completo na linha do centro, e as calçadas ficam sem árvore; o paisagismo também planta
  árvore e arbusto no canteiro (`streetFurniture` com `on: 'median'`, ninguém anda ali). Colocação em linha: com o
  paisagismo, clicar e arrastar ao longo da calçada põe uma fileira no espaçamento do tipo (poste 30 m, árvore 10 m,
  banco 20 m...), anéis de prévia, um desfazer. Placa = regra: uma placa de Pare ou Dê a preferência posta na aproximação de
  um cruzamento muda a regra daquela perna (controle "Placas"), e a placa desenhada é a da regra (`signApproach`).
- Defeitos das fotos corrigidos: a linha branca sobre o canteiro era o destaque da via sob o ponteiro da ferramenta
  Informação, uma linha de 2 px no eixo; agora é uma faixa translúcida da largura da pista. "Nenhum" estourava a borda
  das opções: botões dessa linha mais justos (cabe com 16 px de folga em 1280x720).
- Detectores: `tests/world/roadFurniture.spec.ts` (árvores no canteiro e desenhadas lá), `tests/editor/signRule.spec.ts`
  (placa = regra, fileira a cada 30 m).
- Cidade gerada arborizada (`editor/cityGenerator.ts` `widenCityFootways`, `greenCity`; `world/cityGen/squares.ts`):
  calçadas de 3 m (cabe a cova da árvore com 1,20 m livres, NBR 9050) e canteiro de 2 m gramado nas avenidas, antes de
  cortar os lotes; o conjunto Completo em todas as ruas (árvores na calçada, no canteiro das avenidas, postes, lixeiras,
  bancos, hidrantes); uma praça por bairro (célula de 420 m): o quarteirão inteiro (os lotes que se tocam) de 1.500 a
  14.000 m², de frente para avenida ou coletora, o mais perto do meio do bairro; caminhos em cruz pavimentados, árvores em
  grade de 9 m nos gramados (árvores plantadas, desenhadas em instância). Cidade pequena: 4 praças, 2.414 peças, 1,4 s na
  geração; quadro mediano 23 ms no Chrome sem tela (iGPU), sem número de antes.
- Detector: `tests/world/cityGreen.spec.ts`. `crossingAccesses` memorizado por revisão e `furnitureFor` com grade de
  vizinhança (antes, quadrático no número de peças).
- Rede elétrica (`editor/roads/powerLine.ts`): com o conjunto Completo, cada via nova (e cada rua da cidade gerada) ganha
  a linha de distribuição no lado esquerdo pelo planejador da ferramenta de postes (`planPoleRun`: postes na calçada junto
  à guia, fora das travessias, contornando esquinas), cada poste com luminária (a rua iluminada pelo poste, como no Brasil);
  as pontas encaixam em postes já existentes, então as ruas viram uma rede. O lado direito fica com os postes de luz do
  conjunto; o mobiliário não cai sobre um poste. Cidade pequena: >50 postes ligados (`cityGreen.spec`).
- Catálogo por dados (`world/roads/furnitureCatalog.ts`, 2026-10-09): cada peça com profundidade, espaçamento
  na rua, primeira peça, espaçamento da fileira e conjuntos; os conjuntos e a ferramenta de paisagismo leem dele.
  Quando o catálogo da 5f existir, as entradas passam para ele.
- Visto em 2026-10-09: desfazer uma via nova não devolve o custo (R$ 20.000.000 → 19.823.680 ficou), contra o
  aceite da V0 ("debitado e devolvido"). A conferir.

## Andamento da V8
- Balão de retorno (decisão do jogador, 2026-10-10: opção por ponta; a ponta continua saída do mapa por
  padrão): no inspetor da via, "Ponta inicial/final: Saída do mapa | Balão de retorno" (`RoadNode.end`). O
  balão é uma junção de uma perna (`world/junction/bulb.ts`): pista de 13 m de raio (bombeiros: Chico, CA,
  48 ft; Hebron, OH, 44 ft), concordâncias de meio-fio de 7,5 m (Silverton, OR, 25 ft), cada nível externo
  concêntrico; a via é cortada onde a concordância começa; sem zebra nem retenção; a calçada contorna o
  círculo (`walkways.ts`), sem travessia nem rampa na ponta. Meia-volta própria (`turnPaths.ts`
  `bulbTurnPath`): entra pela faixa, segue o círculo a 10 m do centro pelo fundo e sai pela outra; carros e
  utilitários cabem; ônibus e caminhão cabem sozinhos, mas um segundo atrás do primeiro encostaria nele
  (verificação de dobra da varredura), então não são mandados para rua com balão. A ponta com balão não é
  saída nem entrada do mapa (`RoadDoc.mapEdge`). O que estava em pé na pista do balão (poste, banco) sai
  no mesmo passo (`clearBulbs`). Detectores: `tests/world/bulb.spec.ts`, `tests/sim/bulb.spec.ts`. Visto no
  jogo (5173): círculo, meio-fio, calçada, poste removido; a volta dos carros vista só na simulação.
- Retorno no canteiro (peça do jogador, 2026-10-10): no inspetor de uma via de mão dupla com canteiro,
  "Retorno para quem vai à ponta final / inicial" (`editor/streetObjects.ts` `commitUturn`; `RoadNode.uturn` é
  a via de onde chega quem volta). Um sentido por abertura: dois retornos frente a frente, cada um esperando na
  ponta da sua faixa interna, ficavam dentro do semicírculo um do outro (impasse medido). Caminho próprio
  (`turnPaths.ts` `medianUturnPath`): semicírculo da faixa interna à do outro sentido, aceito só para quem gira
  nesse raio (AASHTO, linha de centro: carro 6,4 m, ônibus 11,5 m, caminhão 11,6 m; FHWA: carro precisa de
  12,8 m de faixa a faixa) e cabe na pista. O bulevar padrão (canteiro de 2 m) recusa com o motivo; com canteiro
  de 5 m carros dão a volta. Abertura do canteiro de 10 m do lado para onde o semicírculo avança
  (`landscape.ts` `medianNose`). Detectores: `tests/editor/uturn.spec.ts`, `tests/sim/uturn.spec.ts`. Visto no
  jogo (servidor de conferência com o HEAD e o retorno, 2026-10-10): abertura no canteiro, moto e SUV dando a
  volta, até 16,8 km/h na saída. Falta: o "loon" (alargamento do lado de lá) para canteiros estreitos.
- Conta-gotas: no inspetor da via, "Desenhar com este perfil" passa a via como ela está para a ferramenta de vias (abre o
  painel de vias com o cartão "Via copiada" escolhido; um perfil em mãos que não é nenhum cartão aparece sempre como
  primeiro cartão, `catalogPanel.ts`).
- Edição em massa: "Rua inteira (n)" copia o perfil da via para todos os trechos da rua, atravessando os cruzamentos em
  linha reta (`world/roads/streetChain.ts`), um desfazer, cobrado; trecho desenhado ao contrário recebe o perfil
  espelhado (`flipProfile`), então estacionamento e calçadas ficam do mesmo lado no mundo. Detector
  `tests/world/streetChain.spec.ts`.
- Inverter mão única: já existia no inspetor.
- Nomes e numeração (`world/roads/streetNames.ts`): toda rua nova (com mobiliário Básico ou Completo) e toda rua da cidade
  gerada recebe um nome ("Rua"/"Avenida" + nomes comuns no Brasil, sem repetir), como item `streetname` (placas azuis nas
  esquinas, editável/removível); o inspetor mostra o nome no título e a numeração métrica do trecho (metros desde a ponta
  da rua mais perto do marco zero, o centro do mapa; pares à direita). Detector `tests/world/streetNames.spec.ts`.

## Desempenho
- Rede e elevação incrementais (V0). Preview em fatias, sem alocar por quadro. Placas em atlas e
  instância. Fluxo em anéis fixos a 1 Hz. Editor de conectores refaz só o nó.
- Cada etapa relata antes e depois pelo `probe-baseline`, `__frames` e os orçamentos do F9.
