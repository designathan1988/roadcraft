# Roadcraft — status

> **HISTÓRICO** (marcado em 2026-10-14): não é o estado atual nem a lista de trabalho. O estado está em `memory/ESTADO.md`; os problemas de desempenho, com a regra de "feito", em `OTIMIZACAO.md`. Leia este arquivo só para saber o que já se tentou e mediu.

O que está ativo no jogo hoje, o que está aberto e as decisões do jogador.
Só o estado atual: o histórico fica no git (`git log -p docs/STATUS.md`; a
versão longa anterior está em `557c5384`).

## Leia primeiro

1. `docs/PLANO.md`: o único plano. Trabalhe só na etapa marcada como ATUAL;
   pedido novo entra na fila dele.
2. `docs/PROBLEMAS.md`: o único registro de desempenho e de defeitos, com a
   medida antes e depois.
3. `CLAUDE.md`: as regras de trabalho.

## Quem trabalha aqui

Uma sessão por vez (decisão do jogador de 2026-10-04, repetida em 2026-10-08,
depois que duas sessões no mesmo repositório se atropelaram), em `master`, em
`C:/Codex-Shared/Roadcraft`, com push a cada commit para o remoto `v3`
(github.com/designathan1988/app-roadcraft-v3, pedido do jogador de
2026-10-09) e para `origin` (github.com/designathan1988/app-roadcraft-v2).
Em 2026-10-09 a sessão "Análise de organização do jogo" foi encerrada e
arquivada (último commit `b30f8d2f`); a sessão de trabalho é a "ROADCRAFT",
na Etapa 5 do plano. Para jogar enquanto uma sessão edita, use a build de
produção (`roadcraft-play`, porta 4180): o servidor de desenvolvimento recarrega
o jogo a cada edição.

## Planeta (ramo `planeta-esfera`)

Neste ramo (worktree `C:/Codex-Shared/roadcraft-planeta-esfera`) o mundo é um
planeta: 864 peças sobre um cubo desenhado como esfera (`core/planetTiles.ts`,
`world/planet/`, `render/planet/`), faces de 6 km, raio de ~3,8 km. Plano:
etapa P7 de `docs/PLANO.md`; defeitos: quadro "Planeta" (PL) de
`docs/PROBLEMAS.md`.

- **Unidade:** 1 m por unidade desde 2026-10-11 (`docs/ESCALA.md`). Mapas e
  câmera salvos em 0,4 abrem no mesmo lugar (`world/rescale.ts`).
- **Servidores:** 5175 `npm run dev:planet` (o mapa do jogador fica nesta
  origem); 5176 `dev:planet:old-unit` (0,4 m, para comparar); 5177 o mapa
  plano deste ramo; 5178 planeta de rascunho (testes de edição, nunca no mapa
  do jogador).
- **Ativo:** vias, cruzamentos, trânsito, pedestres, prédios, lotes, zonas,
  postes, trilhos e muros através das divisas das peças; Terra com
  continentes e oceano; atmosfera de Hillaire do chão ao espaço; voo livre até
  a Lua (V); plano perto do chão e curvo ao subir; grade local por cidade
  (`world/planet/gridOrigin.ts`); sombras presas ao chão
  (`render/environment.ts` GroundShadowGrid); vigia de geometria atravessando
  o atlas no F9 (desenvolvimento).
- **Medido (2026-10-11 à tarde, 5178, cidade gerada, 400 veículos e 400
  pessoas, `npm run perf:gate`, Chrome sem janela que pegou a RTX 3060):** CPU
  do quadro p95 13,2 ms, simulação 3,8 ms, desenho 9,9 ms; GPU p50 13,3 / p95
  14,5 / p99 16,2 ms (`render/gpuTimer.ts`, linha `gpu` no F9); intervalo entre
  quadros p99 20,8-51,3 ms em duas rodadas; 527 draw calls, 11,8 M triângulos,
  alocação 200 MB/s, coletor 1,2 % (68 ms em 6 s), heap 1,21 GB; criar uma
  via: clique 31,5 ms, edição 130 ms, chão 327 ms. Simulação em mapa grande
  (PL49): grade 36×36 com 400/400, 11,2 → 7,2 ms por passo (A/B). População
  sustentada a 4×: nenhuma das medidas sustentou 59 Hz (`zz-maxpop-probe`,
  5177, cidade 4242: 382 carros e 414 pessoas dão 148 de 240 passos/s e
  simulação p50 16 ms por quadro; 286/402 dão 170 passos/s).
- **Orçamentos de desempenho** (`src/core/perfBudget.ts`, CLAUDE.md
  "Performance budgets"): specs de contagem no `npm run check`, portão
  `npm run perf:gate`, aviso no F9. Catraca: só baixam.
- **Ferramentas sobre a divisa** (sondas com cliques reais, sem interface):
  vias, cruzamento, controle, mover nó, zonas, lotes, prédios, relevo, ponto
  de ônibus, cerca, árvore, poste, rede de postes, carvalhos, solo, trilho,
  demolir e desfazer; sem fantasmas nem erros (PL25, PL28).
- **Aberto:** criar via ainda clona o mapa e refaz a rede duas vezes no planeta
  (`editor/commit.ts` commitOnChart, ~90 ms no mapa do jogador) e a rede
  elétrica é refeita inteira (~70-100 ms); verificação no painel do navegador
  (oculto durante esta sessão: tudo conferido sem interface, no iGPU).

## Controlador de estado e eventos, e o monitor

- **Diário do mundo** (`src/world/changes.ts`, `RoadDoc.changes`): o que
  mudou, onde e por quê, com as mudanças derivadas encadeadas (estrada →
  trânsito → alturas → chão → luz → tiles). Todas as revisões do documento e
  `buildings.revision` são o serial da última entrada do seu tipo
  (`serialOf`): nada muda sem passar por ele (`tests/arch` reprova contador
  à parte). Zonas, lotes e prédios gravam onde mudaram. A causa é a
  ferramenta e o gesto do jogador, ou o que o jogo fez (desgaste, crescimento
  da zona, mapa aberto). F8 desenha as mudanças dos últimos 8 s;
  `__changes()`.
- **Estado do jogo** (`src/core/gameState.ts`): ferramenta, pausa,
  velocidade, seleção, opções de cada ferramenta e o gesto em andamento, numa
  cópia só (o `tsc` recusa escrita direta). A interface reage por `watch`,
  avisada uma vez depois de cada mudança. `__state()`.
- **Monitor** (`src/core/health.ts`, `ui/healthWatch.ts`,
  `ui/healthPanel.ts`): erros, promessas rejeitadas, `console.error`, erros
  de shader e de workers, contexto WebGL perdido, quadros acima de 50 ms com
  os sistemas que os tomaram, invariantes da simulação; cada um com o que o
  jogador fazia. Botão de pulso na barra de cima (ponto verde, amarelo ou
  vermelho) e F9: abas Saúde, Mudanças e Estado; "copiar registro" para um
  relato. O registro sobrevive a recarregar a página. `__health()`.
  Quadro longo é trabalho (scripts + desenho, ou `blockingDuration`), não
  tempo de relógio: o navegador parado não entra; só as etapas `hitch:`
  contidas no quadro (síncronas) são culpadas (`tests/ui/healthWatch.spec.ts`).
- **Ferramentas em módulos próprios** (`src/editor/`): via (`roadTool.ts`),
  demolição (`bulldozer.ts`), mover nó (`nodeMover.ts`), lote e zona,
  cercas, postes, paisagismo, pincel de terreno, nuvens; a câmera à mão em
  `view/cameraGestures.ts`; as ações em `actionsWiring.ts`; a contabilidade
  do quadro em `frameLoop.ts`. O `main.ts` só liga e delega.

## Ativo no jogo

### Interface
- Interface v2 (`src/ui/v2/shell.ts`) no estilo Cities: Skylines II: dock de
  ícones embaixo no centro, painel de itens acima dele, opções da ferramenta
  embaixo à esquerda, nomes só na dica (`.v2-tip`). Conferida em 1280×720,
  1920×1080 e 1024 de largura.
- Reorganizada em 2026-10-09 (`722ba4af`): opções em linhas "nome | controles"
  (uma palavra à esquerda, o nome inteiro na dica), o mapa inteiro sob um
  divisor; Paisagem em Relevo, Solo, Natureza, Céu e clima, Rua, cada coisa um
  cartão; Zonas em Zonear e Lotes; Demolir, Pistola e Bomba numa ferramenta;
  Quarteirões é um traçado da via; no topo Camadas do mapa (grade, cores das
  zonas, congestionamento, interior), céu em três ícones, Ajuda com as teclas,
  aviso de cruzamentos impossíveis; as respostas do jogo (salvo, desfeito,
  via inválida) aparecem num aviso no topo. Sonda de função: 44/44 controles
  mudam o estado do jogo.
- O jogo abre num mapa vazio. Textos em `ui/i18n/en.ts` e `pt-BR.ts`.
- Números com casas decimais na notação da língua da interface ("22,0 m" em
  português, "22.0 m" em inglês): `ui/i18n` `formatDecimal` (um
  `Intl.NumberFormat` guardado por língua e precisão, 0,64 µs por chamada) e
  `parseDecimal` (lê vírgula ou ponto). Os campos do inspetor do Construtor são
  de texto: o `type=number` do Chrome escreve o decimal na língua do sistema,
  qualquer que seja a da página. Guarda: `tests/ui/decimals.spec.ts` reprova
  `toFixed` em texto da interface.
- Entre 781 e 1159 px de largura o dock fica à direita do painel de opções da
  ferramenta, sempre (a 1024 px ele cobria o botão "Ocultar outros"); a gaveta
  de itens fica centrada no vão entre o painel de opções e o painel Seleção, e
  as abas dela encolhem até só ícones e, por último, rolam: nenhuma fica sob o
  botão de fechar. O campo Função do inspetor tem a largura da opção mais longa.
  As medidas das arestas ficam logo acima da seta de arrastar de cada lado,
  sem cobri-la. Conferido a 1024 × 768 e no painel largo, em português e inglês.

### Vias e terreno
- Rua transversal reta perto da emenda de um prolongamento ou do fim de uma
  via: o nó vem para a linha desenhada (desliza na própria via), em vez de
  a rua nova virar um V pelo nó (`editor/commit.ts` `slideOntoCrossing`,
  `tests/editor/crossStraight.spec.ts`). Conferido no jogo.
- Grade universal de 10 × 10 m com subdivisão de 1 m (`world/grid.ts`); perfis
  de via em metros inteiros; encaixe ligado por padrão (`editor/snap.ts`).
- Junções resolvidas uma vez, na linha do meio-fio
  (`world/junction/derive.ts`). Meio-fio de 15 cm, calçada no nível dele,
  talude de grama até o chão.
- Estacionamento paralelo ao meio-fio, por trecho e lado
  (`world/parking.ts`), e ciclofaixas.
- Ponta de rua: saída do mapa por padrão, ou balão de retorno, escolhido no
  inspetor (V8, 2026-10-10, `world/junction/bulb.ts`): carros e utilitários
  dão a volta, ônibus e caminhão não entram; a calçada contorna o balão.
- Retorno no canteiro central, um sentido por abertura, só onde o carro gira
  de verdade (V8, `editor/streetObjects.ts` `commitUturn`); o bulevar padrão
  recusa por canteiro estreito (falta o "loon"). Detalhes em `docs/VIAS.md`.
- Nada é gerado sozinho nas ruas nem no terreno (ordem do jogador de
  2026-10-05). Mobiliário, árvores de rua e postes só pela ferramenta de
  paisagismo e pela de postes, que ficam só nas calçadas. **Revogada para
  vias novas em 2026-10-09** (sistema de vias, `docs/VIAS.md`): quando a
  etapa V7 entrar, via nova sai com o conjunto de mobiliário escolhido
  (padrão "completo"); vias existentes não mudam sozinhas.
- Pincelada de terreno relê o ecossistema só onde a terra mudou (5g,
  `world/ecology.ts` `EcologyUpdate`, `render/terrain.ts` `ecologyDirty`): a
  região tocada mais o alcance de um vértice (média local de 8, declive);
  mapa inteiro só se a água, a pintura, o bioma ou o ponto mais baixo mudou.
  110 → 3 ms por pincelada (Node, grade do jogo); fora dela o campo, e com ele
  as árvores, fica idêntico (`tests/world/ecologyRegion.spec.ts`). Dentro, a
  vegetação segue a nova forma do terreno (decisão do jogador se deve).
- Pincel de terreno com rios e túneis; geologia por região (granito, arenito,
  basalto) e relevos (mesa, cânion, escarpa, pão de açúcar); mapas novos
  nascem num relevo natural.
- Terreno sem as luzes e efeitos que o jogador mandou tirar (`557c5384`).
- Árvores: todas as árvores e arbustos do jogo vêm de um só módulo
  (`render/lowPolyTrees.ts`), inclusive a reserva da mata pintada
  (`groundCover.ts`): tronco low poly e miolo escuro sob cartões de folhagem
  com recorte alpha virados para o olho. A palmeira tem folhas próprias:
  faixas dobradas em V ao longo da nervura, com textura de folha pinada, que
  lançam sombra (P85, `43860dde`). Gráfico com
  exposição de referência, grama com brilho medido, terreno e camadas do
  corte sem repetição nem chiado, nuvens sem flocos soltos; as sombras de
  nuvem tiram só a parte direta da luz do sol e as manchas do chão visto de
  longe são mais suaves (`7fb7fa98`, `b454120d`, `76a43fad`, sessão
  "Problemas visuais na otimização").
- Imagem limpa de longe (P102): a nitidez só onde um pixel vê detalhe real
  (máscara pela profundidade, `postprocess.ts` SHARP_MASK), sem grão de filme,
  normal maps com o azul codificado como o three lê, cor e luz de antes do
  `7e4032c6`, caixilhos desenhados também na câmera ortográfica.
- Vidro dielétrico: vidraças e fachada de vidro com metalness 0 (o reflexo é o
  Fresnel de 4 %); os montantes da fachada de vidro são alumínio pelo canal
  azul do mapa de rugosidade (`textureBaker.ts` `metallic`); o quarto atrás da
  janela é desenhado sem receber a luz da fachada, como no interior mapping
  (`kit.ts` `roomDaylight`), e o sol já não pinta as vidraças de bege.
- Câmera até a rua (trabalho do agente cancelado, ramo `camera`, terminado):
  inclinação, lente e altura do olhar mudam com a distância
  (`view/cameraProfile.ts`), teclas seguradas e roda viram deslizamento
  (`view/cameraMotion.ts`: WASD/setas, Q/E, Page Up/Down, + e -), o zoom vira
  passeio no mínimo. Perto da rua o olho é trazido para a frente do prédio que
  fica entre ele e o ponto olhado (raio a partir do alvo, como o
  camera-controls; `world/buildings/cameraSolids.ts`); de longe isso se apaga
  (`pullWeight`), e a vista geral nunca fica presa entre as torres.
- Lotes do laboratório de lotes (ramo `lab/lots`, 2026-10-05; só os lotes, sem o
  laboratório): os 33 prédios com lote completo (`lots/*.json`) no Construtor,
  Modelos → Lotes (interface v2 e antiga), cada um desenhado com peças próprias
  (`render/buildings/signature.ts`, `world/buildings/towerKit.ts`), lidos só
  quando escolhidos (`world/buildings/lotLibrary.ts`). Conferido no jogo com a
  torre art déco e a igreja.
- Prédios (ramo `predios`, agente cancelado, terminado): brise em uma instância
  por vão (`kit.ts` `brise`; antes uma por lâmina), molduras na cor da parede
  quando o caixilho é metal escuro, cornija só no topo do prédio, faixa central
  avançada nas torres modernas, paleta de terra e minerais e mais ritmos de
  fachada (`architecture.ts`, `procedural.ts`).
- Interface v2 (ramo `interface`, agente cancelado, terminado): listas de escolha
  no tema em vez do `select` branco do navegador (categoria dos modelos, encaixe,
  andar, placa), com as teclas de um select (setas, Home, End, Escape; WAI-ARIA
  APG); o painel não se refaz com uma lista aberta (fechava-a em menos de
  250 ms); título nos painéis e, num modo sem nada a escolher, o que fazer.
- Bomba (ramo do agente de desempenho, PA-U2 parcial, terminado no que estava
  feito): a cratera, primeiro carimbo de terreno do mapa, refaz só o retângulo
  dela; as células de prédio de uma edição sobem à GPU em fatias antes da
  troca. No painel do app (RTX), cidade gerada, bomba força 5 no chão: maior
  tarefa longa 1 153 ms na build anterior (4180) contra 468 ms com a mudança
  (5173). Visto uma vez, logo depois de o servidor recarregar: por alguns
  segundos depois da bomba as ruas sumiram da tela e voltaram; não se repetiu
  em três tentativas (mapa recém-gerado, mapa recarregado do salvamento, bomba
  logo ao sair da cortina de carga; alturas do terreno sob a via medidas a cada
  200 ms: nunca acima do asfalto). A única vez foi logo depois de o servidor de
  desenvolvimento ser reiniciado por outra sessão. Detector no renderer
  (`watchRoads`): uma vez por segundo confere as malhas das vias na cena e o
  terreno desenhado sob pontos de via (fora de túnel); falhando, registra no F9
  uma vez, com o estado da reconstrução. **Causa achada e corrigida
  (2026-10-09):** contando a cada quadro os blocos do grupo das vias na cena,
  uma bomba junto da rua o fez cair de 176 para 10 durante a reconstrução. Os
  blocos aproveitados do cache (`roadSurfaces.ts`) são os mesmos objetos já
  desenhados, e `group.add` no grupo novo os tirava do grupo na tela (um objeto
  do three.js tem um pai só, `Object3D.add`): as ruas viravam grama enquanto a
  reconstrução corria, e por mais tempo quando uma edição a atropelava. Agora o
  grupo novo recebe só os blocos recém-feitos, e os aproveitados mudam de grupo
  na troca (`RoadSurfaces.adopt`). Medido no 5173: uma bomba, 338 quadros com
  176 blocos; três bombas seguidas, 381 quadros com 176 blocos (antes: 10). Teste
  em `tests/render/roadTiles.spec.ts` (sem a correção, 18 de 110 blocos
  ficavam na tela). O painel da bomba
  mostra a ajuda da bomba (antes a do Demolir).
- Bomba num prédio (resto do PA-U2): as peças soltas de um golpe saem numa fila,
  4 ms por quadro (`destruction.ts` `release`/`loosen`), em vez de todas no
  quadro do golpe; a camada da câmera (`cameraSolids`) só é refeita quando a
  câmera a pede, com o piso de cada prédio guardado por registro (refazê-la a
  cada bomba custava 438 ms); a escolha do prédio no clique usa a caixa
  guardada (`storedBounds`, 83 ms antes). Painel do app (RTX), força 30, pior
  tarefa por bomba depois da primeira: 465-494 → 199-238 ms. A primeira bomba
  da sessão ainda compila os shaders das ruínas (~80-140 ms); o que resta é a
  rede elétrica e o mobiliário refeitos quando a bomba derruba postes.
- Simulação (os testes que falhavam no começo da sessão, achados por bissecção
  no `fb481b81`, a cidade aberta já povoada): carro posto no meio da faixa
  nasce no máximo à velocidade que as curvas adiante permitem (`spawn.ts`,
  `curvature.spec`); carro parado por um pedestre antes da linha não é
  admitido no cruzamento, e o admitido devolve a vaga (`admission.ts`
  `stoppedForWalker`, `shortLinkBox.spec`); o motor de caminhada passou a
  embarcar e desembarcar gente nas paradas no meio-fio (`walk.ts` `hailable`,
  `board`, `alight`, vazios desde 5/10; quem desce sai sobre a calçada,
  `kerbStops.spec`). Pedestres (P101): cara a cara na mesma faixa passam
  devagar na hora (`noseToNose`, o `jamtime.narrow` do SUMO), e o passo de lado
  só zera o tempo de preso quando é dado de fato. `tests/sim` 171 de 171, suíte
  inteira verde (1221); no jogo, 108 pessoas por 40 s, ninguém parado mais de
  1,2 s fora da espera da zebra.
- Canteiro central e faixa de pedestres: a ilha do canteiro termina antes da
  faixa, meio metro depois dela (`world/landscape.ts` `medianNose`, pela
  distância da faixa da rede); o desenho (`render/roadSurfaces.ts`) e as
  árvores do canteiro (`medianAt`) param no mesmo ponto. Antes a ilha, com
  meio-fio e grama, ia até a boca do cruzamento e os pedestres atravessavam
  pela grama. Visto no jogo (5173): a faixa passa sobre asfalto. Visto no jogo (5173):
  um carro deixou o passageiro e ele saiu andando pela calçada. O carro que
  sai de um lote recebe passageiros e tarefa como os outros
  (`lotTraffic.ts`, `assignOccupancy`; antes só o motorista, e numa cidade sem
  ponta de via ninguém levava passageiro): no jogo, 15 de 52 carros novos com
  passageiro em 40 s e paradas no meio-fio acontecendo sozinhas.
- Câmera entre as árvores: as folhas a menos de 5 m da câmera somem em
  pontilhado ordenado (Bayer 4x4, o "Pixel Dither" do distance fade do Godot),
  o material segue opaco e a sombra inteira (`wind.ts` `NEAR_FADE`, em todo
  material de copa). Visto no jogo (5173): a câmera levada pela roda através de
  uma copa mostra a calçada, não uma tela de folhas.
- Abertura: a cidade aparece inteira, vias e prédios no mesmo quadro
  (`renderer.ts`, marca `opening:shown`); os texels das superfícies ficam
  guardados no navegador e não são assados de novo a cada abertura; a carga
  dos prédios tem orçamento próprio (`8a35d468`, `5d7dd24f`). Cidade de
  teste (761 prédios): inteira aos 6,0-6,4 s. Os tiles das superfícies das
  vias também ficam guardados no navegador (P21, `341cd87c`): da segunda
  abertura em diante nenhum é refeito.
- O editor recusa, com o motivo, a geometria que o trânsito não suporta
  (`editor/editRules.ts`, P83/P82): ângulo fechado (< 25°), trecho curto
  demais para as faixas se separarem na junção, via sobre via sem junção nem
  vão de 14 u (5,6 m), rampa acima de 35% entre as placas. Vale ao desenhar,
  ao soltar um nó e nas edições do inspetor e das ferramentas; só o que a
  edição cria ou piora, nunca o que o mapa já tinha (abrir mapa não recusa).
  A pré-visualização pinta o rascunho de inválido com o motivo ao lado do
  comprimento antes de soltar.
- Sistema de vias, etapa V0 (ramo `vias`, ativo só depois do merge;
  `docs/VIAS.md`): valores de ajuste em `world/roads/tuning.ts`; rede e
  alturas refeitas só onde a edição mudou algo (PV1 no `PROBLEMAS.md`);
  economia mínima: saldo na barra de cima, custo da via no rótulo do preview,
  débito ao construir, recusa sem saldo, devolução de 25% ao demolir, desfazer
  devolve o dinheiro.
- Pincel de terreno: o fim da pincelada refaz só a região suja dela, em
  fatias, e a água só quando a pincelada chega perto dela (P98, `3e60f67b`).
- Névoa da chuva e bruma do ar medidas do olho equivalente também na vista
  ortográfica (a câmera dela fica longe por construção): de perto a chuva
  não cobre mais metade da imagem (P96).

### Noite
- Janelas acesas à noite pela fração de pessoas acordadas na hora (ATUS):
  63% às 22 h, 6% às 2 h (P30, `4b522935`). Sem a vida dos moradores, a
  tabela de cômodos (`lightSlots.ts`) não é alimentada; se for religada, ela
  volta a mandar.
- Luz por classe num lugar só (`render/lightLevels.ts`, `117534eb`): janela
  acesa 1,25 de luminância em média, lanterna 1,34, freio 2,04, seta 2,11,
  farol 3,0 (UN R7/R6), acima do limiar do bloom (0,92); lâmpada apagada e
  placa sem ganho. Luminária com luz na parede ao lado de cada porta do
  térreo. Cone de luz em cada poste (cone aditivo, técnica do Volumetric
  Light Beam). Conferido no jogo (build da porta 4180), à noite e de dia.

### Prédios e cidade
- Prédios gerados por ESTILO ARQUITETÔNICO (`world/buildings/architecture.ts`,
  ramo `predios`): 12 estilos (colonial, art déco, modernista com brises,
  contemporâneo com varandas gourmet e ático, tijolo, tropical de pastilha,
  vidro, industrial; casas colonial, bangalô, moderna, sobrado), cada um com
  família de pele e caixilho, ritmo de colunas simétrico (aberturas
  alinhadas andar a andar), térreo pelo uso (loja, portaria, casa), andar de
  coroamento, frisos e coroamento próprios (`Volume.dress`: nenhum, só
  embasamento, laje aparente ou todo andar; cornija, déco, laje, ático).
  Era do bairro (antigo, moderno, novo) e rua decidem o estilo
  (`zoning.ts` `quarterOf`). Peças novas instanciadas: loggia, brise,
  janela com venezianas, varanda gourmet com guarda-corpo de vidro
  (`kit.ts` `fin`, `louvre`, `glassRail`); laje plana nunca com telha;
  marquise na portaria moderna; casa de máquinas na pele do prédio;
  manchas de chuva sob peitoris (2 triângulos por janela). Detector:
  `tests/world/architecture.spec.ts`. Visto no jogo (build, sementes 11,
  23, 47). Aguardando o jogador.
- Cidade gerada auditada inteira (`tests/world/generatedCity.spec.ts`,
  `tests/world/cityAudit.ts`, sementes 20261009, 77 e 4242): nenhum lote
  sobre o pavimento nem sobre outro, nenhum maior que 2400 m2, todo lote
  zoneado construído, nenhum prédio entrando no vizinho nem saindo do lote,
  telhado de uma água subindo no máximo ~1,2 m e de duas águas ~3,2 m
  (`procedural.ts` `MAX_ROOF_RISE`; vão largo demais vira laje), galpão de um
  pavimento de 6-10 m. Lotes cortados à terra com folga de 8 cm do pavimento
  (`lots.ts` `landLot`, sem o snap de volta à calçada), prédio no maior
  retângulo dentro do lote (`lotBuildFrame`), recorte booleano no lote em
  `zoning.ts` `fitToLot`. Código antigo reprovado: 85-98 telhados-cunha por
  cidade. Visto no jogo (build, 3 sementes): 554/554 lotes com prédio.
  Aguardando o jogador.
- Lotes sem vazio nas esquinas: a faixa de uma rua entre duas transversais,
  e a fileira de um quarteirão com lote gravado, são cortadas no que sobra
  ao lado dos lotes que já estão lá (`world/lots.ts` `freeSpans`,
  `tests/world/lotCorners.spec.ts`). No modo Lotes os lotes da rua não
  somem: ficam desenhados e viram lotes de verdade no primeiro clique de
  edição (frente, cantos, dividir, juntar, apagar). Tirar zona tira também
  o prédio (`zoneLots`, `tests/world/unzone.spec.ts`). Conferido no jogo.
- Marcos (5f2, primeira entrega, `render/buildings/landmarks.ts` e
  `facadeKit.ts`): hotel Beaux-Arts (mansarda de cobre com lucarnas, base
  rusticada, toldos), torre art déco (recuos com floreiras, painéis dourados,
  pináculo), escritório modernista, residencial com terraços e torre de vidro
  azul, montados com módulos de verdade (janelas, cornijas, varandas) e
  oferecidos no Construtor com miniatura. Vistos no jogo (5173, 2026-10-10).
  Aguardando o jogador.
- Construtor com blocos não destrutivos, operações booleanas e fachadas;
  construir a partir de um modelo 3D de referência (`editor/fromReference.ts`).
- Zoneamento com crescimento de prédios nos lotes (`world/lots.ts`), planejador
  de lote (`editor/lotPlan.ts`). Estratégia e medidas em `docs/ZONEAMENTO.md`:
  - com a ferramenta de zona na mão, lotes propostos ao longo das vias
    (contorno fraco); o pincel cria e zoneia os que pinta (`lotTool.ts`);
  - pincelada nunca perdida (5g): os pontos pintados enquanto a proposta é
    refeita esperam por ela; solta antes, a pincelada é feita no quadro em que
    a proposta fica pronta, em fatias (de uma vez seriam 0,6 s numa cidade
    gerada), com o aviso "Zoneando assim que os lotes da rua estiverem
    prontos…" (`tests/editor/zoneStroke.spec.ts`);
  - prédio escolhido entre 4 candidatos, o menos parecido com os vizinhos a
    90 m; 6 formas de casa, 5 de prédio, esquemas de cor como dados
    (`procedural.ts`); altura perto da dos vizinhos baixos; lote de esquina
    olha para as duas ruas;
  - divisa completa (muro, cerca, gradil) com portão de pedestre e de carro;
    os dois desenhados abertos; vão do portão de pedestre livre de mobiliário;
  - carros entram pelo portão até o estacionamento dos fundos e saem por ele
    (`sim/agents/lotTraffic.ts`, `parking.ts`); nenhuma vaga de rua na frente
    de portão;
  - quintal em terraço na encosta, com muro de arrimo e escada;
  - prédio em meio-nível na encosta (`world/buildings/splitLevel.ts`,
    `Volume.lift`): o fundo meio andar ou um andar acima ou abaixo da rua,
    cada bloco no seu platô, o quintal na cota dos fundos (P74).
  - peças do gramado assentadas no ponto mais alto do chão DESENHADO sob toda
    a área delas (`render/buildings/lawnGround.ts`): cantos, vértices da malha
    do terreno dentro da peça e cruzamentos das bordas com as arestas dos
    triângulos, exato (`tests/render/lawnGround.spec.ts`); os 4 cantos e o
    centro deixavam cristas atravessarem a peça. Mesmo custo (1 530 prédios:
    ~3,4 s antes e depois, Node). Conferência visual pendente (painel oculto).
  - nenhuma peça do lote dentro de outra (`world/buildings/elements.ts`
    `elementsMeet`, aplicado em `editor/lotPlan.ts` `fits`): a pegada de um
    sólido é só dele, como no The Sims; superfícies, juntas do limite e das
    obras de terra (escada no arrimo), plantas sob a copa ou contra a cerca se
    encontram por projeto; o limite e as obras de terra tiram do caminho o
    enfeite. Antes, 2 949 numa cidade gerada (lixeira nas pedras, floreira no
    pilar do portão, telhado do depósito na copa, banco no banco); agora 0
    (`tests/world/lotClash.spec.ts`), 4% de peças a menos, crescimento da
    cidade no mesmo tempo (~4,3 s). Visto no jogo (servidor de
    conferência com o HEAD, cidade gerada, 2026-10-10): peças do quintal
    separadas.

### Pessoas
- Na rua andam só os NPCs do cenário (`sim/ambient`), entrando pelas pontas
  das vias, com o motor de caminhada `sim/agents/walk.ts` (o único motor de
  pedestre). As calçadas de toda junção se ligam em ordem angular, também
  nas junções rasas (P50); listras pelas regras do SUMO, sem girar nas
  esquinas (P52). Os carros escolhidos entram no ritmo da faixa (P51).
- Pessoas saem de casa, chegam, entram em lojas pelo portão de pedestre dos
  lotes (P84, `sim/agents/lotDoors.ts`): da porta pelo caminho do lote, pelo
  meio do portão, até a calçada, ou o contrário, e somem na porta. Quantas:
  a densidade do cenário por uso e hora contra o número escolhido; saindo ou
  entrando pela presença por hora do ATUS; a outra ponta pelo modelo
  gravitacional. O resto continua de ponta de via a ponta de via.
- Desenho: a multidão procedural (`render/people/proceduralCrowd.ts`) por
  nível de detalhe, com faixas pela altura na tela (P15). Quem está em
  veículos ainda usa os corpos cozidos (`riggedCitizens.ts`). Esses corpos
  escolhem a malha pelo erro na tela (do ramo `perf/render-lod` de 5/10,
  `citizenLevelFor`): o nível mais simples cujo desvio fica abaixo de um
  pixel (README do meshoptimizer, "Simplification"), mas inteiros onde o
  rosto aparece (zoom 8 em diante; só o nível 0 tem os morphs do rosto).
  Medido no 5173 com `?bodies=cooked`: em zoom 3 o corpo custa ~6,2 mil
  triângulos em vez de ~12 mil; em zoom 1,5, ~1,9 mil em vez de ~6,2 mil.
  Na build de produção a verificação de cada shader fica desligada
  (`checkShaderErrors`, como a documentação do three.js recomenda).
- Detectores de movimento do pedestre (5a, `tests/sim/walkHeight.spec.ts`):
  nenhum salto no plano além do passo para a frente e do passo de lado
  (`SIDESTEP`, até 0,45 m/s mesmo parado, como o `maxYSpeed` do SUMO), nenhum
  giro mais rápido que `turnV`, `prev` sempre o tique anterior. O passo é
  desenhado na velocidade real do corpo (`sim/people/view.ts` `gaitSpeed`):
  antes, quem dava passo de lado parado (15 099 vezes em 4 min) ou andava num
  caminho de lote com `v` = 0 deslizava na pose parada. Ninguém gira no lugar
  (`tests/sim/agents/citySpin.spec.ts`, cidade gerada como no jogo, e
  `lotDoors.spec.ts`): o trecho de lote também termina ao chegar a `THERE` do
  fim (chegada de Reynolds); um caso visto no jogo durante o crescimento da
  cidade, não reproduzido depois em 495 s com 300 pessoas. Conferência visual
  do passo lateral pendente (painel do navegador oculto em 2026-10-10).
- Sobrancelhas e cílios dos corpos cozidos num só `DataArrayTexture` de
  256 px, uma camada por item (`render/people/skinAppearance.ts`
  `faceCardLayer`): o corpo de perto com os morphs do rosto usava 17
  amostradores dos 16 que o fragment shader tem (limite do ANGLE, na RTX como
  na Intel) - aviso a cada quadro e a sombra do sol sem ligar. Agora 16 (14
  sem morphs), nenhum programa da página acima de 16, sem aviso (5173,
  2026-10-10).
- Depois de mexer em código de pessoas: `npm run cook:people`, à mão, uma vez.

### Veículos e transporte
- Drive v2 é o único modelo de direção. Veículos por nível de detalhe.
- Transporte público (`sim/transit/transit.ts`, `editor/transitTools.ts`):
  ônibus de parada em parada, trens e metrô nos trilhos, passagens de nível.

### Ações
- Pistola e bomba em pessoas, carros e prédios (`render/playEffects.ts`,
  `render/ragdollJolt.ts`). O laboratório de armas (`?lab=armas`,
  `src/weaponsLab.ts`, `scripts/weapons-lab.mjs`) NÃO abre: `main.ts` só o
  carrega com `__PLAY_MODE__`, que `vite.config.ts` define como `false`
  (o modo de andar como pessoa foi para o backup).

### Outras páginas
- `human-generator.html` (criador de pessoas) e `people-lab.html`.

## Guardado fora do código ativo

- `src/backup/residents`: a vida dos moradores (casa, trabalho, necessidades,
  carro próprio, vida dentro dos prédios) e andar como uma pessoa. O README
  diz como religar.
- `src/backup/crime`: crime e polícia, fora do jogo por decisão do jogador
  (2026-10-06). Não rodar, citar nem relatar.
- Removidos (no `master`; neste ramo o planeta é o mundo): o mundo planeta e os motores de pedestre People, Crowd e de
  calçada legado; o Drive v1. Em 2026-10-09, o que ainda restava deles: a
  navmesh (`world/nav/navmesh.ts`), o publicador legado das faixas
  (`sim/peds/publish.ts`), e no `SidewalkGraph` as esquinas, os corredores,
  a ligação de cada porta, os destinos e a ocupação (`corridor.ts`,
  `behaviour.ts`); o grafo ficou só com meio-fios, faixas e calçadas, que os
  veículos e sinais leem. Também `scripts/verify-citizens.mjs` (e
  `npm run verify:citizens`) e `scripts/ped-sequence.mjs`, que liam o mapa
  `sim.peds` do motor legado, vazio desde 2026-10-08.

## Aberto

- Desempenho e defeitos: `docs/PROBLEMAS.md` (P70, P92).
- Zoneamento: o meio-nível só é escolhido no crescimento (o construtor não
  tem controle para mudar `lift`; as alças e os arrastes já seguem a cota de
  cada bloco, P89); andar de baixo com garagem no lado da descida não é
  feito (o carro entra pela rua, na cota da frente); lojas e prédios com
  estacionamento ou pátio de carga atrás não são escalonados.
- Prédios: subir a altura de um prédio (relato: cerca de 10 s): na
  cidade de teste, 83 ms até o prédio redesenhado, e andar, fachada e
  telhado não renivelam mais o chão em volta (P87); em relevo, conferir no
  mapa do jogador.
- Cidade: parece uma grade rígida; o relevo quase não aparece nela.
- Pessoas: o jogador ainda relata rostos, animação e pessoas se esbarrando.
- Simulação com 400 carros e 400 pessoas a 4x: 4,0-10 ms por quadro no
  headless conforme o estado da máquina (antes 7,7-8,4 com metade das
  pessoas); nenhum quadro longo em 80 s; o orçamento de 4 ms ainda não é
  garantido (P70). Último passo: o conjunto de obstáculos de cada carro não
  é mais refeito a cada passo (6,7 % do passo, antes 9,2 %); o próximo
  custo é o passo das pessoas (`stepWalkers`).
- Edição de via na cidade de teste com o F9 aberto (P3): a moldagem do chão
  em quartos de no máximo 2,3 ms; o maior passo das fatias caiu de 51,6 para
  33,4 ms. Feito, aguardando o jogador.
- Fuzz da via (`tests/fuzz`): as 6 sementes do portão e as 29 regressões
  passam, sem fixture aberta para corpos sobrepostos. Fora do portão
  (sementes 7-30) restam 4 defeitos: `poseJump` (semente 19) e
  `elevationStep` em via mudada para túnel pela operação `structure`, que o
  jogo não oferece (sementes 26 e 28), e um degrau de 0,25 u no limite
  (semente 24).

## Decisões do jogador

- Interface: ícones e dicas, sem nome escrito em tudo; sem painéis com
  rolagem vertical; painéis pequenos; o visual de Cities: Skylines II. Trabalho
  de interface só é dado como feito com fotos em tamanho real, conferidas em
  1280×720.
- Cidade: sem chão vazio dentro das quadras, mas os pátios e praças do meio
  das quadras ficam; nunca prédio novo no meio de uma quadra.
- O objeto acompanha o terreno.
- Construindo, em qualquer altura da câmera, o mapa é o bloco de terra com o
  corte em camadas sobre o azul-escuro liso: sem céu, sem terra nem fundo verde
  além da borda (2026-10-10). Céu e terra em volta só no modo de jogo.
- O jogador escolhe a qualidade gráfica; sem tela de carregamento.
- Otimizar sem tirar visual. Mudanças visuais pequenas por velocidade são
  decisão minha; pergunto só se mudar a jogabilidade ou sair um recurso.
- Assets: baixar o que o trabalho precisar sem perguntar. Pedestres comuns
  plausíveis (sem armas, chifres ou máscaras na rua).
- Nunca levantar licença, crédito ou atribuição com o jogador.

## Esta máquina

- Os dados do jogador em 127.0.0.1 são dele: teste em outra origem
  (localhost) e nunca os sobrescreva.
- O Chrome headless desenha na Intel UHD 770; o jogador tem uma RTX 3060 e um
  i9-12900K. Medida de GPU que vale é a do jogo aberto.
- Nunca saturar a CPU: trabalho pesado em prioridade baixa, um por vez.
