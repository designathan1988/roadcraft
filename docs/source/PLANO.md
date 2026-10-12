# Plano do Roadcraft — o único

Este é o plano em execução. Toda sessão o lê antes de qualquer coisa e
trabalha só na etapa marcada como **ATUAL**. Ele substitui
`~/.claude/plans/encapsulated-enchanting-wirth.md`, cuja parte B2 ficou pela
metade e foi dada como feita.

## Como um pedido novo entra

- **URGENTE:** interrompe a etapa atual, é feito e a etapa continua.
- **PRIORIDADE:** entra na fila logo depois da etapa atual.
- **Sem marca:** entra no fim da fila.

Nenhuma etapa começa com a anterior aberta. Uma etapa só fecha com o critério
de pronto dela verificado no jogo aberto, com fotos, e com a linha do
`docs/PROBLEMAS.md` atualizada.

As regras de trabalho (pesquisa antes de mudar, verificação no jogo com fotos,
testes só do que foi tocado, sonda no máximo duas vezes, documentação no mesmo
commit, "feito" medido e visto, "fechado" só pelo jogador) ficam no
`CLAUDE.md`, que toda sessão carrega.

## Estado

| Etapa | O quê | Estado |
|---|---|---|
| 0 | Arrumar a casa: instruções do Roadcraft, um plano, um registro | feita (`e169da0a`); em 2026-10-09 o jogador restaurou o `CLAUDE.md`, o `.claude/settings.json` e o `.claude/launch.json` do Roadcraft, e a trava de pesquisa por arquivo saiu; o `CLAUDE.md` ganhou "Pace and done" |
| 1a | Estado do jogo: ferramenta, pausa, velocidade, seleção, opções das ferramentas, gesto; interface por `watch` | feita (`de0ecfe6`, `46ca5873`, `4c535183`) |
| 1b | Revisões do documento lidas do diário; zonas, lotes e prédios registrados | feita (`e2092b4e`) |
| 1c + 2 | Causas certas no diário; monitor de quebra e lentidão; inspetor único (botão de pulso / F9) | feita (`8bb31320`, `db6057fa`, `d5ad6dd1`) |
| 1d | `main.ts` dividido: cada ferramenta no seu módulo, o laço do quadro em `src/frameLoop.ts` | feita: lote/zona, cercas, postes, paisagismo, pincel de terreno, nuvens, ações, via (`5d7dd24f`), demolição (`10ea0371`), mover nó (`7a7ab0dd`), câmera (`ad3f053b`, em `view/`), laço do quadro (`65b75bb5`). `main.ts` de cerca de 6 000 para 4 533 linhas; os `let` que restam são de ligação. Cada ferramenta testada com mouse real |
| 3 | Otimização completa, guiada pelo monitor | **pausada** em 2026-10-09 pela Etapa 5 (a CPU do quadro já está em 2,4 ms de mediana; o que o jogador vê de errado é visual e de física). Feitos: linha de base por sistema (`probe-baseline.mjs`, `__frames`); edição de via só refaz o que muda (P24); abertura sem a cópia JSON das texturas (P25) e com a topologia como carga (P26); câmera e criação de pessoas medidas sem custo de CPU do jogo (P27, P28); P18 e P19 fechados. 2026-10-09: P4, P7a, P22 e P23 medidos e fechados (400/400 a 4x por 80 s sem quadro longo); P70 com mais dois passos (MOBIL, curvas, motorista); P3 medido com o painel aberto e o passo longo das fatias da edição corrigido (Pump 51,6 → 33,4 ms), aguardando o jogador. Falta: P70 (orçamento de 4 ms na iGPU) e a conferência única do jogador na RTX (ver "Metas") |
| 4 | Todos os defeitos abertos | a fazer |
| 5 | Física e realismo visual: detectores de invariantes, objeto composto do lote, pedestres sem salto, câmera, luzes, variedade, postes que cruzam ruas (pedidos de 2026-10-09) | **ATUAL**. Feitos, aguardando o jogador: 5c (`cd2ecf69`, `4620de9c`), 5h (`b12ebaa3`), 5d (`898ab0e4`), 5b (`6c82ee4e`, `49cd33f7`), 5e (`117534eb`, `a237c511`, `88e0b234`), 5f2 primeira entrega (cinco marcos, 2026-10-10), 5f (`aa1ea0cf`, catálogo de equipamentos do telhado sem peça cruzando outra), 5a (pedestre, apoio no chão desenhado, peça contra peça do lote; 2026-10-10), 5g (pincelada de zona, pincel de terreno por região, monitor F9; 2026-10-10). Falta: 5a, sólidos do interior do veículo (nomear os sólidos); 5g, interface v2 sem a antiga (proposta como sessão própria); conferência do jogador de 5b a 5g |
| 6 | Sistema de vias: perfil livre, construção com elevação, conectores, cruzamentos inteligentes, sinalização, mobiliário, economia mínima | V0-V7 no `master` (o agente do ramo `vias` foi cancelado em 2026-10-09 e o ramo está todo incorporado); V8 em andamento na sessão principal: balão de retorno feito (`e809814b`, opção por ponta, decisão do jogador de 2026-10-10); faltam retornos (peça que o jogador põe no canteiro), ônibus com baia e casos de borda (`docs/VIAS.md`) |

**Por que 1d vem depois do monitor:** dividir o `main.ts` (6 000 linhas) é a
mudança mais arriscada do plano. Com o monitor ligado, um erro ou um quadro
lento que a divisão causar aparece na hora, com a causa; sem ele, só o
jogador veria.

## Planeta (ramo `planeta-esfera`, servidor 5175): o mundo numa esfera

Decisão do jogador em 2026-10-10: o mundo é uma esfera de verdade, e as 96
peças planas costuradas saem. A pesquisa e as fontes estão na conversa de
2026-10-10.

- **O que é verdade:** cada coisa (nó de via, prédio, lote, zona, carro,
  pessoa) é um ponto da esfera.
- **Como se guarda:** nas coordenadas da carta que é dona do ponto, uma
  codificação exata e reversível. Nada é cortado na divisa, e uma via pode
  ligar nós de cartas diferentes.
- **Como se calcula:** num atlas de cartas sobrepostas, a definição
  matemática de superfície curva. A esfera é dividida em regiões, numeradas
  pelas faces de um cubo como no Spore. Cada região tem uma carta plana
  azimutal equidistante, a dobra do Planetary Annihilation, e calcula na sua
  carta tudo o que está nela e numa faixa em volta (o halo). Só desenha e
  simula o que é dela. Com o halo, cada coisa é calculada inteira e com todos
  os vizinhos, e o motor plano do jogo roda sem mudança dentro de cada carta.
- **Como se desenha:** cada vértice vai da carta dona para a esfera no
  shader (`render/planet/bend.ts`).

| Etapa | O quê | Pronto quando |
|---|---|---|
| P1 | Base: atlas de cartas sobrepostas (dona, halo, transições), tamanho da região escolhido pelo erro medido | testes de ida e volta, erro medido, dona única |
| P2 | Documento: cada nó guardado na carta dona; o gesto lido numa carta e cada ponto passado à sua dona; via longa dividida | via construída em qualquer direção e tamanho, guardada e desfeita |
| P3 | Mundo derivado por carta com halo: vias, cruzamentos, calçadas, faixas; só o que é da carta é desenhado | via e cruzamento sobre a divisa inteiros no jogo, sem fresta nem peça dupla |
| P4 | Simulação: grafo de faixas unido, pose e corpo passando de carta, proximidade em 3D | carros e pessoas atravessam a divisa sem parar nem saltar |
| P5 | Prédios, lotes, zonas, postes, terreno moldado pelo halo | cidade sobre a divisa sem peça dupla |
| P6 | Terreno leve: detalhe por distância (base no ramo `planeta`, `src/planet/surface.ts`) | carga e quadro medidos antes e depois |

Estado em 2026-10-11. P1-P6 feitos no ramo `planeta-esfera` (vias, cruzamentos,
trânsito, pedestres, prédios, lotes, zonas, postes, trilhos e muros através
das divisas; chão completo só perto da vista e uma malha leve no resto;
atmosfera de Hillaire do chão ao espaço; Terra com continentes e oceano; voo
livre até a Lua; plano perto do chão e curvo ao subir; grade local da cidade;
escala de 1 m nos passos 1-5 de `docs/ESCALA.md`). O `master` foi trazido em
`ded64259`. Desde 2026-10-11 o jogo e os testes são a 1 m por unidade.

**P7 - auditoria de lançamento (ATUAL).** Pedido do jogador de 2026-10-11:
auditoria completa (desempenho, gráficos, navegação, interface, usabilidade,
funcionalidades, unidade de 1 m) e correção de tudo. Plano em
`~/.claude/plans/audite-integralmente-a-aplica-o-parsed-stroustrup.md`;
cada defeito é uma linha PL em `docs/PROBLEMAS.md` (quadro "Planeta").

| Parte | O quê | Estado |
|---|---|---|
| P7.0 | master no ramo, linha de base com fotos | feito (`ded64259`) |
| P7.1 | Unidade de 1 m: passos 6-8 de `ESCALA.md` | feito: comparação lado a lado e troca (PL13-PL15, `3df20424`, `f6751a67`); `npm run check` no fechamento |
| P7.2 | Uma só forma desenhada (ar, nuvens, noite, horizonte na esfera R/k) | feito (PL4, PL12) |
| P7.3 | Sombras estáveis | feito: sol que segue a vista (PL6); mapa de sombra em texels do chão desenhado e sol em passos (PL16, `1d4f623b`) |
| P7.4 | Navegação | feito: precisão da âncora (PL3), chão sob o olho (PL5); copas entre a câmera baixa e o alvo são oclusão (a folhagem a menos de 5 m já some em pontilhado) |
| P7.5 | Nada atravessa o atlas | feito: bomba e fios (PL2), perfis de via (PL7), vigia no F9 e pisca da grade (PL17, `908d7173`) |
| P7.6 | Grade local | feito: origem pelo mapa e pelo lugar, troca suave (PL18, `e24a8654`) |
| P7.7 | Desempenho | feito: lixo nos laços quentes (PL19, PL26), criar via sem travar (PL29: clique 180-215 → 65-112 ms no mapa do jogador), orçamentos em catraca com portão `npm run perf:gate` e aviso no F9 (`6ec8de8f`); 2026-10-11: a "cópia do mapa" mede 0,6-1,2 ms (o custo era a rede elétrica e os postes automáticos lendo a cidade inteira): linhas de poste por células (PL43), fios guardados por vão e mobiliário só quando o paisagismo muda (PL45); clique de via na cidade 4242 do planeta 66-86 → 30-37 ms |
| P7.8 | Efeitos, interface, funcionalidades | feito: ferramentas sobre a divisa com cliques reais (PL25, PL28), placas (PL27), mapas Terra (PL20), dicas (PL21), interface nas três larguras (PL22), feixe e voo (PL23, PL24); gelo com volume (PL30, sessão paralela); espaço vivo e voo de verdade na sessão paralela (fila 7) |
| P7.9 | Fechamento (`npm run check`, fuzz, build, docs) | 2026-10-11: `npm run check` verde (lint, tipos, 1 344 testes, 137 do planeta, build) depois de 5 specs presos ao mapa plano de uma placa (`99967a6f`); fuzz do portão verde no `check`; o fuzz `deep` é o bloco D (agente de trânsito) |

## Fila (pedidos do jogador ainda não atendidos)

1. ~~Árvores low-poly bonitas~~: um só módulo para todas as árvores e
   arbustos (`7fb7fa98`, `b454120d`), depois com cartões de folhagem; a
   palmeira, a última no estilo antigo, com folhas pinadas em V (P85,
   `43860dde`). Conferência visual com o jogador.
1a. URGENTE de 2026-10-08, atendido: a cidade abria com as vias primeiro e
   os prédios de 2 a 20 s depois. Ver P20 (`8a35d468`, `5d7dd24f`).
2. ~~Quarentena de mapa ilegível com um lugar só~~: feita
   (`editor/persistence.ts` `quarantine`: um segundo mapa posto de lado vai
   para uma chave irmã com a hora, o primeiro fica). Antes: uma segunda
   falha de carregamento gravava por cima da
   primeira e o mapa posto de lado se perdia (aconteceu com o mapa de teste em
   localhost em 2026-10-08, durante uma edição em vários passos com o jogo
   aberto). Etapa 2 (uma quarentena é uma quebra que o monitor mostra) e
   correção na Etapa 4.
3. ~~O envelhecimento da cidade troca prédios a cada 3 s~~: medido, um
   prédio troca a cada ~54 min reais e sem quadro longo (P23).
4. ~~Lint vermelho~~: verde desde `74bc314c` (camadas, `release/`, escapes).
   Restam os testes (item 5). Antes: `npm run check` vermelho desde antes de 2026-10-08: o lint varre
   `release/` (o executável do Electron, 9 000 erros de código compilado) e
   `src/ui/v2/shell.ts` tem 244 escapes inúteis, 3 importações de `editor`
   na camada `ui` (proibidas) e um `prefer-const`. Etapa 4, primeiro item:
   sem o check verde nenhuma etapa pode fechar com ele.
5. **Atualização de 2026-10-09, manhã:** a suíte inteira passa. O que
   restava: `priorityBox` semente 3 (regressão de 77dea566, P86) e os testes
   dos ganchos `guard` e `research`, que testavam arquivos apagados em
   d0caae39 e saíram (bd52d19c; `git revert` os traz de volta se os ganchos
   voltarem). Fuzz: portão e regressões verdes (P82, P83).
   **Atualização de 2026-10-09:** `defects.spec` passa nas 10 cidades
   (P52, `2d466521`) e `fourWay` passa inteiro; `kerb.spec` (pedestre no
   asfalto da esquina) passa. No fuzz restam defeitos de geometria do mundo
   (`elevationStep`, vias que se cruzam sem junção, junção de pernas curtas),
   descritos no `STATUS.md`.
   **Atualização de 2026-10-08, noite:** resolvidas `curvature` (critério
   do v1), `fourWay` velocidade de curva (frenagem em rampa, 0e743d08),
   `shortTail` (geometria válida), `roundabout` ×3 (veículo pesado sem
   saída, 9fc1f050), `buildingMesh`, `heightTopology`, `citizenLocomotion`
   ×2 (limiar em m/s, a7a387cc), `streetFurniture` (achou a cabine no
   meio-fio, 2931820f), `builderCatalog` (achou 5 ícones faltando).
   Restam: `fourWay` locals (pedestre preso na faixa dentro do caminho de
   um carro admitido; o tempo segurado dele volta a zero a cada ~3 s e a
   regra de destravar do SUMO nunca vale), `defects.spec` ×4 (pedestres nas
   esquinas, ver PROBLEMAS), fuzz ×2 (degrau de altura e corpos sobrepostos
   em saídas de cruzamento), `pads` (contrato do piso a decidir),
   `occupantFit` (o script de medida mede corpos glTF que saíram do jogo:
   refazer para os corpos MakeHuman), ganchos ×9 (do jogador).
   Lista original: as 29 falhas da suíte em 2026-10-08 (todas anteriores a esta sessão,
   conferidas): fuzz (6 sequências e `open-road-drawn-over-road`), motor de
   caminhada em 4 cidades (`defects.spec`), Drive v2 (`curvature`,
   `shortTail`, `fourWay` ×2, `roundabout` ×3), `buildingMesh` (camada de
   prédios), `heightTopology`, `citizenLocomotion` ×2 (0,07 m/s),
   `groundCover`, `pads`, `streetFurniture` (prado), `occupantFit` e
   `builderCatalog` (não carregam fora do navegador), e os testes dos hooks
   de `.claude` (`claudeGuard` ×5, `researchHook` ×4), que só o jogador
   pode resolver, porque os hooks são dele. Etapa 4.
6. ~~Interface organizada, visual e testada~~ (pedido do jogador de
   2026-10-09): feita (`722ba4af`, `cb1c6aea`, `e7b08fa0`, `72576787`; P53-P58).
   Falta a conferência do jogador no jogo aberto, e o que não deu para
   testar sem dados: as linhas do transporte (a cidade de teste não tem
   nenhuma) e os painéis internos do Construtor com um prédio selecionado.
7. **Espaço vivo e voo de verdade** (pedido do jogador de 2026-10-11, depois
   do fechamento do P7, "quando possível"):
   - a Terra gira (feito, PL35: no espaço e no voo, de volta à cidade no chão);
   - os asteroides se movem, sem bloco parado (feito, PL32);
   - o espaço tem dinâmica, vida e coisas para explorar ("hoje está morto")
     (em parte, PL36: satélites, estrelas cadentes, estação espacial e marcas
     de navegação no voo);
   - efeitos especiais e gráficos bonitos e otimizados;
   - atmosfera e terreno melhores com zoom próximo e intermediário;
   - no voo, sem captura do mouse: a vista gira com o botão do meio (roda)
     pressionado, para mais controle e precisão (feito, PL33);
   - física de voo que pareça voar de verdade: motion blur pela velocidade,
     arranque e inércia (feito, PL34).
8. **Gelo com volume e árvores nítidas de perto** (jogador, 2026-10-11:
   "o gelo não tem volume, é só uma mancha na terra"; "as árvores perdem
   detalhes em zoom perto"). Em andamento na sessão paralela `gelo-arvores`
   (pedida pelo jogador), a partir de PL30.
9. **Criar vias está lento** (jogador, 2026-10-11, "isso é básico"): medir o
   tempo da edição de uma via no planeta, do clique ao chão pronto, e cortar
   na causa. Primeira rodada feita (PL29). Mecanismo que impede a volta, pedido pelo jogador ("um mecanismo que impeça o desempenho de quebrar"): tabela única `src/core/perfBudget.ts` em catraca; specs de contagem no `npm run check` (`tests/perf`, `tests/planet/perfBudgets.spec.ts`); portão `npm run perf:gate` (cidade 400/400 e vias por cliques, medianas, fotos); aviso no F9 para passo acima do orçamento; regra no CLAUDE.md ("Performance budgets").
10. **Escolha entre o mapa plano e o planeta** (jogador, 2026-10-11): feito, um
   botão na barra de cima leva ao outro modo a qualquer momento (`ui/modeChooser.ts`;
   cada modo guarda seus mapas; `npm run build:modos` serve os dois numa origem,
   `/plano/` e `/planeta/`).
11. **Modo plano com o mapa completo, do tamanho do globo** (jogador, 2026-10-11:
   "no modo plano tem que ter o mapa completo do mesmo tamanho que é no globo"):
   aberto. A pesquisar e desenhar: a área do planeta (6 faces de 6 km, ~216 km²)
   num plano, com a Terra (continentes e oceano) numa projeção, e o terreno do
   modo plano em placas sob demanda como no planeta.
12. **Caçada de fuzz `deep` (60 sequências, 2026-10-11)**: defeitos de tráfego
   antigos contados por categoria - turnOffSurface 135 (46 seq.), stalled 426 (30),
   staleClaim 21 (11), bodyOverlap 23 (5), poseJump 3 (3), overlap 2 (2),
   trimOrder 8 (1), greenBlocked 7 (1), unrelatedBodyOverlap 12 (1). A tratar por
   categoria, do mais frequente.

## Etapa 0 — Arrumar a casa

- O `CLAUDE.md` do Roadcraft de volta: feito pelo jogador em 2026-10-09. De
  2026-10-08 07:11 até então, as sessões trabalharam com o `CLAUDE.md` do
  criador de personagens 3D, que proibia rodar o jogo e os testes. Os ~190
  commits desse período foram conferidos só pela sessão.
- `AGENTS.md` e `maps/cidade-com-estacionamento.json` (usado por
  `roadTiles.spec` e `conflictCache.spec`) restaurados.
- Um registro de desempenho só: `docs/PROBLEMAS.md`. O que ainda estava aberto
  em `docs/performance.md` virou P17, P18 e P19, junto com o roteiro de medida e
  as regras. O `performance.md` ficou congelado como arquivo histórico, não
  apagado, porque cerca de 40 arquivos de código citam os números dele.
- `docs/STATUS.md` só com o estado atual (o histórico fica no git).

**Pronto quando:** as instruções forem as do Roadcraft, existir este plano e
um registro só, e houver commit.

## Etapa 1 — Controlador global de estado e eventos

O que existe hoje e não basta:
- `core/gameState.ts` guarda 7 valores e ninguém o lê.
- `main.ts` tem 91 variáveis soltas no topo do arquivo.
- O diário do mundo (`world/changes.ts`) tem 2 leitores. Cerca de 30
  contadores `*Revision` em `world/doc.ts` decidem o que é refeito, lidos em
  15 arquivos.

### 1a. Estado do jogo

- `GameState.watch(keys, fn)`: observadores chamados uma vez por quadro, num
  ponto só (início de `frame()`), com as mudanças desde o serial que cada um
  viu. Nada é chamado de dentro de `set`.
- **Escolhas do jogador** viram chaves do estado, e a variável solta é apagada:
  - ferramenta;
  - tipo e altura de via, alinhamento;
  - pincel de terreno;
  - cerca, zona, lote, rotatória;
  - perspectiva, congestionamento, trânsito ligado;
  - seleção.
- **Gesto em andamento** vira uma chave `gesture` por ferramenta. Ela é gravada
  no início e no fim do gesto. O estado e os tratadores de cada ferramenta vão
  para um módulo próprio em `src/editor/`.
- **Contabilidade do quadro** vai para `src/frameLoop.ts`.
- Painel, barra de status e inspetor reagem por `watch`.

### 1b. Eventos do mundo

- `changes.serialOf(kind)` substitui cada `doc.xRevision`, incluindo o clone e
  o digest do documento.
- Cada leitor troca a comparação de contador por `changes.since(visto, KINDS)`,
  usando os retângulos onde já sabe refazer por região.
- Ordem: `renderer.ts` → `main.ts` → `lots.ts` → `sim/world.ts` →
  `terrain.ts` → os demais.
- Todo mutador do documento grava no diário.
- `tests/arch` proíbe incrementar revisão fora de `changes.ts`.

### 1c. Inspetor único

O F8 mostra o diário do mundo, o estado do jogo e o monitor, com a corrente de
causa. `__changes()` e `__state()` continuam.

**Pronto quando:**
- nenhum `*Revision` existir no `doc.ts`;
- `main.ts` só tiver variáveis de ligação;
- no jogo, cada ferramenta, opção e seleção aparecer no inspetor com a causa;
- via, terreno, zona, cerca, árvore e poste mostrarem cada um a sua corrente.

## Etapa 2 — Monitor de quebra e de lentidão

Arquivos novos: `src/core/health.ts` (anel de entradas) e `src/ui/healthPanel.ts`.

- **Quebra:**
  - `error` e `unhandledrejection`;
  - contexto WebGL perdido;
  - erro de shader (`renderer.debug.onShaderError`);
  - `onerror` dos workers;
  - invariantes da simulação amostradas no jogo.
  - Cada entrada leva a pilha e a última mudança do diário.
- **Lentidão:**
  - o tempo de cada sistema em `frame()`, com orçamento declarado num lugar só;
  - um quadro acima de 50 ms vira entrada com os sistemas, a atribuição do
    Long Animation Frames e a corrente do diário;
  - os `hitch:…` capturados por `PerformanceObserver`;
  - GPU por amostragem.
- **Visível:** selo no HUD, painel F9, `__health()`, últimas entradas guardadas
  no navegador.
- **Automático:** `npm run check:perf` falha acima do orçamento.

**Pronto quando:** um erro forçado, um quadro lento forçado e uma via
desenhada na vila aparecem no painel com o sistema certo.

## Etapa 3 — Otimização completa

**Linha de base por sistema**, nos cenários:
- mapa vazio com 8 vias;
- vila padrão com vias curtas;
- 400 carros e 400 pessoas em rede grande;
- câmera;
- criação de pessoas;
- pistola e bomba.

**Correção em ordem do custo medido, sem tirar visual:**
- P3, P4 e P7a;
- os 2,8 milhões de triângulos das árvores sem LOD;
- o que o monitor mostrar.

**Metas:**
- nenhum quadro acima de 50 ms;
- mediana até 16,6 ms em 400/400 na RTX 3060;
- edição de via até 100 ms no total.

**Como fechar:** as sessões só medem na iGPU Intel desta máquina, cerca de 5×
mais lenta na GPU. A CPU é comparada com a meta direto, e a GPU contra a
linha de base de 2026-10-08 na própria iGPU (`docs/PROBLEMAS.md`, "Linha de
base"). Com isso cumprido, o item fica "feito, aguardando o jogador", e o
jogador confere uma vez na RTX, pelo F9 com 400/400. Só essa conferência
fecha a etapa.

## Etapa 4 — Todos os defeitos abertos

- Fila acima (árvores).
- **P16:**
  - pedestres girando nos cruzamentos;
  - testes do Drive v2 com critérios do v1;
  - passos a 0,07 m/s;
  - pads;
  - cobertura do chão;
  - mobiliário no prado;
  - camada de prédios;
  - topologia por altura;
  - testes de hooks e de `docs/audit`.
- Fuzz `near-bridge`.
- O que o monitor acusar no passeio completo pelo jogo: cada ferramenta, cada
  aba, salvar e carregar, desfazer.

**Pronto quando:** a suíte da simulação passar sem afrouxar limite, e o passeio
pelo jogo terminar sem quebra no monitor.

## Etapa 5 — Física e realismo visual

Defeitos que o jogador viu no jogo em 2026-10-09 e que a sessão confirmou
jogando (build de produção, painel do navegador à vista). Cada um é uma
classe de defeito: a correção é onde ele nasce, e um detector impede que
volte.

**5a. Detectores de invariantes físicos** (antes de qualquer correção, para
medir o tamanho de cada classe na cidade inteira, e depois como guarda em
`tests/` e no monitor F9):
- peça sem apoio (`unsupportedElements`, `c09a4b2c`): nenhuma peça no ar;
- peça no chão a mais de 5 cm do terreno desenhado (`renderedHeightAt`) sob
  ela: nem flutuando nem enterrada;
- interpenetração: banco ou passageiro contra sólidos do interior de todo
  veículo (ônibus, carro, caminhão), peças do lote entre si e contra o prédio;
- corpo desenhado do pedestre (`PedView`) por tique: deslocamento acima do que
  a velocidade de caminhada permite ou giro brusco é salto. Medir nas
  travessias dos cruzamentos.

Estado em 2026-10-10: feitos o corpo do pedestre (`walkHeight.spec`,
`citySpin.spec`), o apoio no chão desenhado (`lawnGround.spec`) e peça contra
peça do lote (`lotClash.spec`, 2 949 → 0). Falta banco/passageiro contra os
sólidos do interior do veículo: a geometria do interior é uma só, sem nomes, e
uma sonda por caixas do corpo sentado acusa 34-1 937 triângulos por modelo
(pedais e coluna junto às pernas do motorista, peitoril junto ao ombro da
janela no ônibus) que só a imagem separa entre contato e defeito; o passo é
dar nome aos sólidos do interior em `render/vehicleModels.ts` e medir cada
classe com o jogo à vista.

**5b. Objeto composto do lote.** Hoje garagem, pergolado, balanço, mesa e
trampolim são peças soltas (laje + postes) postas uma a uma
(`editor/lotPlan.ts`); o gerador pode recusar ou apagar um poste
(`stepYard`, `lift`) e deixar o teto. No desenho, as peças que não seguem o
terreno ficam numa cota única do lote (`render/buildings/buildingMesh.ts`
`emitLots`, `level`) e as que seguem ficam no chão, por isso caixas e
jardineiras saem enterradas ou altas numa encosta. Solução: um elemento
`prop` (do catálogo) posto inteiro ou recusado inteiro, com a base no
terreno sob a sua pegada (cada poste até o chão; acima do limite de
inclinação, um pódio ou a recusa) e validado pelo apoio (5a). O filtro de
desenho dos lotes já salvos (`looseParts`, `c09a4b2c`) sai quando os lotes
forem migrados para `prop`. O Construtor recusa, com o motivo, peça sem apoio.

**5c. Pedestres nos cruzamentos** (pedido repetido do jogador: deslizam e
"pulam como peça de xadrez"). Medido em 2026-10-09: 3 600 tiques, 36 050
amostras, 2 026 sobre a faixa - a posição da simulação não salta (zero saltos,
zero giros bruscos, `prev` sempre certo) e a freada é suave (até ~1,8 m/s²).
O salto nasce no desenho:
- altura por rótulo (`render/agents.ts:2087-2089`): via + `FOOTWAY_RISE` na
  calçada, via + 0 na faixa, terreno + 4 cm em `open`; a troca é instantânea
  (17 trocas calçada/faixa e 14 calçada/terreno em 60 s) e o `segment` que dá
  a cota muda nas esquinas (20 trocas). Não há rebaixamento de calçada: o
  meio-fio de 15 cm vai até a beira da faixa;
- pose (`render/agents.ts:1040-1053`): sem mistura entre clipes; abaixo de
  0,15 m/s vira `idle` com fase 0 e corpo ainda andando (desliza), e na saída
  volta a `walk` em fase 0 (salta) - 22 paradas e saídas por minuto com 10
  pessoas, quase todas no meio-fio.
Solução: (1) rebaixamento de calçada em cada faixa (rampa até 1:12, largura
mínima 1 m - curb cut/NBR 9050), desenhado e na altura; (2) a altura do corpo
pela superfície de caminhada sob os pés, uma função contínua do mundo
(calçada, rampa, faixa, terreno), lida pelo desenho - nunca por rótulo;
(3) locomoção com mistura idle/andar/correr pela velocidade (blend tree 1D,
como Unity) e transição com peso cruzado (three.js `crossFadeFrom`), fase por
distância mantida; (4) detector de 5a sobre o corpo desenhado (altura e pose
por quadro). Fontes: en.wikipedia.org/wiki/Curb_cut,
docs.unity3d.com/Manual/BlendTree-1DBlending.html,
`node_modules/three/src/animation/AnimationAction.js` `crossFadeFrom`.

**5d. Câmera: arrastar com o botão do meio falha de perto.** Em perspectiva o
alvo fica na altura do terreno (`render/isoViewport.ts:175`) e a câmera é
erguida sobre o chão (`:192`), mas o arraste prende o ponto do plano y = 0
(`view/cameraGestures.ts:79-91`, `isoViewport.ts` `worldAt`/`panTo`): sobre
terreno alto cada pixel move demais; com o raio acima do horizonte do plano o
three.js devolve `null` (`Ray.distanceToPlane`, t < 0) e `worldAt` devolve o
próprio alvo, e a câmera pula; `panTo` corrige em um passo, o zoom em dois.
Solução: agarrar o ponto 3D realmente sob o cursor (altura do que está
desenhado ali), resolver o arraste no plano dessa altura, iterar como
`keeping`, e manter o último ponto válido quando o raio não corta o plano.
Os textos de ajuda trocam `middleDrag`/`rightDrag` (`ui/i18n/pt-BR.ts:383-384`).

**5e. Luzes.**
- Janelas listradas: o vidro é uma placa sem espessura que projeta e recebe
  sombra pelos dois lados (`render/buildings/kit.ts:266, 278`, `shadowSide:
  DoubleSide`) com `normalBias` 0,05 (`environment.ts:245`): acne de sombra.
  Solução: o vidro não projeta sombra (a janela fecha a luz pelo caixilho e
  pela parede), ou recebe sombra só pela face da frente; conferir de noite e
  de dia.
- Sem brilho: o bloom (`postprocess.ts:231`) passa só o que tem luminância
  acima de 0,92 (`LuminosityHighPassShader`, pesos 0,21/0,72/0,07). Janela:
  ~0,42 (`kit.ts:402-409`); lanterna traseira `0xff3b2f` ~0,25 × 3,4
  (`agents.ts:1873`) = 0,84; farol ~3,0 - por isso só o farol brilha. Solução:
  cada luz com a intensidade física da sua classe (farol, lanterna, freio,
  janela, poste) em vez de um fator único, e o limiar acima de qualquer
  superfície só iluminada.
- Casas sem luz externa: não existe peça para isso (o lote só põe `lamp` em
  passagem de prédio não residencial, `editor/lotPlan.ts:590`). Solução: luz
  de fachada e de portão por tipo de lote, com os horários do `roomsAwake`.

**5f. Variedade.** Todo telhado plano com 8 m × 8 m ou mais recebe o mesmo
conjunto (caixa, alçapão, 2 condensadores, placas, mastro, antena, 2
claraboias), só o canto muda entre 4 (`render/buildings/buildingMesh.ts:1136-1209`),
e nada impede uma peça de atravessar outra. Solução: catálogo de
equipamentos com probabilidade por uso, porte e idade do prédio, postos por
empacotamento na área livre do telhado (grade de ocupação, com folgas), com
semente por prédio; o mesmo princípio no quintal (5b).

**5f2. Arquitetura reconhecível** (relatório visual de 2026-10-09, frente a
Cities: Skylines II; a parte de imagem do relatório já foi feita: `fef881e5`
normais, descarte na ortográfica, grão; `bf65609f` vidro dielétrico):
- famílias de prédio com identidade (torre residencial, escritório, hotel)
  por proporção, embasamento, corpo e coroamento, não só altura, cor e janelas;
  diversidade entre famílias, coerência dentro de cada uma, bairros com
  linguagem comum;
- materiais em três escalas (detalhe, painel/junta, envelhecimento por área)
  em vez de ruído genérico;
- janelas com profundidade aparente (interior mapping, van Dongen 2008:
  raio contra os planos do cômodo), já desenhadas sem a luz da fachada
  (`kit.ts` `roomDaylight`);
- térreo que diz o uso (portaria, loja, garagem, marquise) composto com
  calçada e lote;
- `editor/fromReference.ts`: abertura decidida por geometria e profundidade,
  não só pela proporção de amostras escuras, e revisão do resultado.
Pronto quando: algumas famílias representativas reconhecíveis no jogo, numa
quadra e isoladas, com as fotos conferidas pelo jogador.

**5g. Achados da avaliação jogando:**
- pincelada de zona perdida: a proposta de lotes recomeça a cada lote novo
  (`editor/lotTool.ts:135-169`) e, até terminar, `proposedAt` devolve -1 e a
  pincelada é descartada. Solução: manter a proposta anterior válida fora da
  área mudada (ou guardar a pincelada e aplicá-la quando a proposta ficar
  pronta), nunca descartar em silêncio;
- pincel de terreno: o ecossistema relê o mapa inteiro (`render/terrain.ts`
  `refreshEcology`, 82 ms) e as árvores naturais são refeitas com chave no
  `terrainRevision` (`render/renderer.ts:2641-2646`): por isso brotam árvores
  onde se pinta. Solução: região suja só e árvores estáveis fora dela; se o
  pincel pode mudar a vegetação é decisão do jogador;
- monitor F9: conta como quadro longo o tempo em que o navegador ficou parado
  (entradas de 57 s sem trabalho do jogo) e culpa medidas `hitch:` que só se
  cruzam no tempo, mesmo assíncronas (`ui/healthWatch.ts:138`; o
  `person/fit` de ~1 s inclui um `await`, `proceduralCrowd.ts:1450-1465`).
  Solução: descartar quadro sem trabalho (`blockingDuration`, scripts e
  desenho), e só culpar medidas síncronas;
- interface v2 lê e clica a interface antiga escondida a cada 250 ms
  (`ui/v2/shell.ts:1589`, botões em triplicata). Solução: a v2 lê o estado do
  jogo (`gameState.watch`) e a interface antiga sai. **Feito (2026-10-10)**:
  a shell lê `gameState` (chaves novas `canUndo`, `canRedo`, `sky`,
  `inspectorOpen`), recebe os números da cidade e as dicas por evento
  (`onStatus`, `onHint`) e chama os comandos do `main.ts` (`ShellDeps`,
  controles deslizantes num registro `SLIDERS`); o index.html ficou com o
  canvas, a raiz do Builder, o inspetor de vias e o Sobre; saíram o minimapa
  escondido (desenhado 10×/s), a barra de status, o `?ui=v1` e as barras
  escondidas do Builder. DOM de 980 para 257 nós; mutações do DOM com o jogo
  parado de 2/s para 0. Falta a conferência do jogador;
- o servidor de desenvolvimento recarrega o `main.ts` quando outra sessão
  edita, o que zera o desfazer e o relógio: jogue na build
  (`roadcraft-play`).

**5h. Postes que cruzam ruas** (relato do jogador de 2026-10-09). Numa rede
sem quarteirão fechado o contorno do meio-fio é um só (vila de teste: 1
contorno de 1 647 unidades), e `route` (`editor/poles.ts:163-176`) só faz o
vão atravessando a rua quando as pontas estão em contornos diferentes; no
mesmo contorno segue "o caminho curto em volta" - desce uma calçada, contorna
a ponta da rua ou entra na rua paralela e volta. Reproduzido: calçadas a 21,6
unidades uma da outra, plano de 176 unidades com poste na ponta da rua.
Solução: rota de menor caminho (Dijkstra) num grafo com os trechos do
contorno e os vãos de travessia (entre pontos frente a frente sobre a pista,
até `MAX_POLE_SPACING`, quase perpendiculares à rua, fora da caixa do
cruzamento).

**Pronto quando:** os detectores de 5a passarem na cidade de teste e numa
cidade crescida em encosta, e o jogador conferir no jogo cada item de 5b a 5f.
