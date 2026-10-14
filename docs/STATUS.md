# Estado — Roadcraft 2

> **HISTÓRICO** (marcado em 2026-10-14): não é o estado atual nem a lista de trabalho. O estado está em `memory/ESTADO.md`; os problemas de desempenho, com a regra de "feito", em `OTIMIZACAO.md`. Leia este arquivo só para saber o que já se tentou e mediu.

Atualizado ao fim de cada etapa. Plano: `docs/PLAN.md`. Problemas: `docs/PROBLEMS.md`.

## Feito

### E0 — Preparação (fechada)
- FONTE: `planeta-esfera` `4cc2926e`; 21 arquivos não commitados e os ramos `agente/*`
  listados em `docs/PLAN.md` 1.1, nada copiado deles.
- Mapas do jogador: backup duplo com manifestos SHA-256 iguais em
  `C:/Codex-Shared/_backup/roadcraft-mapas-2026-10-12` (Chrome Default, Edge, app
  desktop, `backup-mapa-jogador`); conteúdo lido de uma cópia do perfil, nunca das
  origens. Os 9 mapas reabertos no jogo antigo (4299) com fotos.
- Jogo antigo de referência: build de `git archive` da FONTE servida na 4299.

### E1 — Portão (feito; linha de base parcial no planeta)
- `scripts/gate/`: Chrome visível na RTX 3060, cenários nos dois modos pelos controles
  reais, A/B intercalado, ruído A/A, fotos por pixel, envios à GPU por tipo, LoAF,
  heap pelo DevTools, registro de rede. `gate/baseline/` com o ruído A/A e as fotos.
- Primeiros números do jogo antigo (mediana A/A, `gate/baseline/report-aa.json`): abrir
  o mapa grande do jogador no plano com quadro de ~1,4 s; via nova pronta em ~0,5 s
  (com picos de 3 s); gerar cidade com quadro de ~0,7 s; bomba com quadros de 0,2–0,6 s.
- Pendente: ruído A/A das fotos e dos números da cidade no planeta (as execuções
  perderam os passos finais pela quebra do Jolt, R1), refazer com o portão corrigido.

### E2 — Cópia e igualdade (fechada)
- Commits `7ff7726` (cópia fiel, 2.930 arquivos dos blobs, conferidos por
  `git hash-object`), `1993740` e `075ef9a` (retirada do SAI guiada por ferramenta e
  dados de teste), `7513dc0` (provas). Detalhes em `docs/MIGRATION.md`.
- Igualdade: build igual à da FONTE em 4.401 de 4.445 arquivos (as diferenças são o que
  saiu de propósito, o selo e as impressões digitais do cozimento); portão antigo × novo
  dentro da dispersão; os 9 mapas do jogador reabrem com as mesmas contagens e fotos
  dentro do ruído (0,4–2,1%).

### Teste de jogo (build nova, planeta, painel do app)
Visto e fotografado: desenhar vias (rua, avenida elevada a 5–6 m), cruzamento com
faixas, trânsito e pedestres, desfazer e refazer, zonear e casas crescendo, bomba
derrubando uma casa. Defeitos achados e registrados: R10 (poste atravessa a avenida
elevada), R11 (placa verde em pé no lote), R12 (roda do mouse leva a câmera a 14 km),
R13 (relógio pula), R14 (via provisória com seção errada por 1–2 s), R1 (bomba trava a
página).

### R1 — a bomba travava a página (corrigido na causa medida)
Build de depuração do Jolt: 5.394 asserts de eixos de junta inválidos em 12 bombas →
0 depois de `render/ragdollAxes.ts`; ver `docs/research/ragdoll-joints.md`.

### E3 — Proteções (feita; envio pendente do portão corrigido)
- `eslint-rules/` (`catch` mudo, estado solto em módulo), `max-lines` 800,
  `eslint-suppressions.json` (dívida trazida: 131 `catch` mudos, 42 arquivos > 800
  linhas, 343 estados soltos), `tests/arch/imports.spec.ts` (camadas com imports
  relativos; 7 ciclos na linha de base), `knip` com linha de base (481),
  `.githooks/pre-push` + `scripts/prepush.mjs`, `npm run check` sem cobertura.
- Primeiro envio pelo portão (base 7513dc0 × candidato bf76aef, 3 rodadas, 2026-10-12
  10:56–12:00): R1 confirmado no portão — o código antigo quebrou a física na pistola em
  1 de 3 rodadas do plano; com a correção, 0 de 6 execuções (plano e planeta). O envio
  foi barrado por 41 + 73 "pioras" em cenas cujo código não mudou: defeito do próprio
  portão (R17), corrigido com teste estatístico (Mann-Whitney U exato + delta de Cliff,
  regra do Pinpoint/Chromium e do PerfCompare/Mozilla), 6 rodadas, rodadas extras quando
  suspeito, e só erros do candidato barram.

### F1 — Controladores (feita no código; envio junto com a E3)
- `core/statechart.ts` (semântica do SCXML), `editor/toolMachine.ts` (a ferramenta como
  máquina de estados; único caminho que troca a ferramenta; transições no `__state()` e
  no F9), `core/commands.ts` + `editor/gameKeys.ts` (registro de comandos e tabela de
  teclas; um ouvinte de teclado no lugar de quatro). `core/bus.ts` escrito, entra na F2
  com os eventos do documento.
- Defeitos corrigidos e vistos no jogo (sonda com mouse e teclado reais, jogo antigo
  4299 × novo 5300, 46 fotos cada): R16 (uma tecla fazia duas coisas: `=` no Relevo
  mudava força 24→25 E zoom 3,75→7,94; PageUp com Vias subia a via E inclinava a câmera
  0,81→1,17; Ctrl+B pegava Demolir; O e G não abriam a gaveta; um Esc no Construtor
  largava tudo), R18 (anel de foco deixava dois botões do dock parecendo escolhidos).
  No novo: cada tecla uma ação; Espaço, Q/E, Ctrl+Z/Y, desenhar e inspecionar via iguais
  ao antigo.
- "Um clique em Vias liga e desliga a ferramenta" (auditoria 3.8): NÃO reproduzido no
  jogo antigo em 9 estados de partida (mão livre, Informação, Relevo, depois de Esc, de
  desenhar, com via no inspetor, depois da tecla 1, depois de T T); cada clique fez o
  esperado. Fica em aberto em PROBLEMS até haver um relato com os passos.

### F2a — Desfazer por registros (feito; envio junto)
- O desfazer guarda só os registros que a edição mudou (imagem confirmada do
  documento, comparada só onde o diário andou; `world/docImage.ts`). Mapa grande do
  jogador: **quadro do Ctrl+Z/Ctrl+Y 177–185 ms → 7–15 ms**; fotos conferidas (vias
  somem e voltam, saldo devolvido). Teste por modelo: 25 sementes × 30 edições
  aleatórias desfeitas até o início e refeitas até o fim, idênticas.
- Desenhar via: custo igual ao antigo (clone 18–20 ms + 60–100 ms depois da edição):
  próximo passo da F2/F3.

### Semáforos (relato do jogador, 2026-10-12)
"Cruzamentos todos verdes ou todos vermelhos e carros passam": medido no jogo novo,
plano e planeta — 180 cruzamentos sinalizados, 1.571 entradas de carros, nenhuma no
vermelho; fotos de perto batem com a simulação (um verde, os outros vermelhos). Não
reproduzido; aguardando o jogador dizer onde viu (PROBLEMS, Aguardando o jogador).

### F3a — via desenhada sem refazer o mapa inteiro duas vezes (feito)
- Mobiliário por via 38–81 → 15–43 ms (busca por célula, resultado idêntico, fotos de
  perto antigo × novo iguais); quadro depois da via 44–63 → 3–6 ms (postes e mobiliário eram
  refeitos duas vezes). Ainda há 5–9 quadros acima de 33 ms por via: postes e superfícies.

### Barreira de regressão no lugar do portão (2026-10-13)
- Decisão do jogador: nada de processos lentos nem testes intermináveis; a conferência visual
  fica, curta e dirigida. Pesquisa: `docs/research/regression-barrier.md`.
- Portão removido (`scripts/gate`, `gate/baseline`, orçamentos do portão). O `npm run check`,
  também o pre-push, passa a ~1,5 min: 45 specs que levavam 10 s ou mais (3.170 s de 3.382 s)
  ficaram em `tests/slow.json` (`npm run test:slow`, só à mão), com a lista só podendo
  diminuir; todo teste do check tem teto de 10 s, e nenhum pode declarar mais
  (`tests/arch/slowSpecs.spec.ts`). O teste de escala da edição (contadores, mapa pequeno ×
  grande) fica no check: 6 s sozinho. O da escala do passo da simulação (62 s) fica na lista
  até a topologia ficar barata (R20: ~30 ms por cruzamento).
- Enviado ao GitHub (`7513dc0..dacd587`).
- Analisador de código (`scripts/check-code.mjs`, 8 s, no lugar do `tsc --noEmit`): grafo de
  chamadas pelo verificador do TypeScript a partir do quadro e do passo da simulação; nada que o
  quadro alcança cria material ou compila shader; o que roda por quadro não chama JSON,
  `structuredClone` nem cálculo de volume, nem percorre coleção do tamanho do mapa; teclado na
  janela só no `main.ts`. 192 achados na linha de base (`code-rules.baseline.json`, só
  diminui), que é a lista de trabalho; teste das regras em `tests/arch/checkCode.spec.ts`.
  Primeiro corrigido: o `draw` copiava todo o paisagismo a cada quadro numa hora da cidade sem
  planta crescendo. Depois: R21 (Esc com o monitor F9 aberto também largava a ferramenta),
  visto no jogo; e as zonas fracas com as outras ferramentas, que eram refeitas e viravam JSON a
  cada quadro, agora só quando os lotes ou os prédios mudam (`LotTool.overlayKeyed`); visto no
  jogo (zonas aparecem, somem lote a lote enquanto as casas crescem, nada fica da ferramenta
  Zonas ao trocar). Linha de base em 185.

### Só o mapa plano, de 10,24 km, em metros (2026-10-13, decisão do jogador)
- Saíram o planeta esférico (esfera, cartas, atlas, voo livre, botão de modo, build de modos,
  `--mode planet`, specs do planeta), a Terra desenrolada de 24,96 × 13,44 km (oceano, gelo,
  climas por latitude, relevo da Terra) e a unidade de 0,4 m (`__METERS_PER_UNIT__` e os modos
  `-old-unit`; os mapas salvos em 0,4 m continuam convertidos ao abrir). Saiu também o resto da
  câmera do modo Jogar, que nada chamava.
- O mapa: 5 × 5 placas de 2,048 km (`world/bounds.ts`), 10,24 km de lado, célula do terreno de
  6,4 m. Com 10 km exatos a célula virava 6,67 m ou 6,25 m e o nivelamento das encostas deixava
  terra sobre o piso de terraços (`tests/world/steppedYards.spec.ts`, 8 e 1 superfícies).
- Chão: o relevo do próprio mapa em todas as placas (planície nos mapas novos); um mapa com o
  relevo "Terra" (4) abre na planície. Os mapas salvos no modo planeta ficam no armazenamento,
  mas não são lidos (estavam em coordenadas do atlas da esfera).
- Linhas de base só encolheram: lint (supressões), knip (448), analisador de código (176).
- Visto no jogo (painel do app, servidor 5300): mapa inteiro de longe (quadrado com a laje,
  sem oceano nem gelo), canto do mapa a 4,4 km (laje e matas), via urbana desenhada (asfalto,
  faixas, meio-fio, postes, fios, carros andando, dinheiro descontado), ajuda sem o voo, console
  sem erros.

### Simulação no orçamento, população regulada, chão sem manchas, elenco fixo (2026-10-13)
- Medido no jogo (cidade padrão, 624 carros, 1.001 pessoas): passo de 9–12 ms (pedestres 3,4;
  despacho e rotas 2,1; admissão 1,8; restrições 1,8; integração 1,5).
- `SimClock.advance` com orçamento de 8 ms por quadro (`SIM_FRAME_BUDGET_MS`): passado dele, a
  simulação desacelera em vez de esticar o quadro. `sim/populationGovernor.ts` baixa e sobe a
  fatia dos tetos de população pelo custo do passo (Unity Adaptive Performance), e o ambiente
  tira, fora da vista, quem passa dos tetos. Sonda no jogo: pessoas 850 → 443 em 15 s, passo
  10–12 → 5,5–8 ms.
- Relevos antigos (1, 2) só na placa de antes (±960 m), suavizados em 480 m até a planície:
  espalhados nos 10 km, o ruído de valor iluminado virava manchas em degraus por todo o chão
  (foto do jogador). A cidade gerada nasce na planície.
- Elenco fixo (`cook-plugin.ts` CAST): os bonecos cozidos não dependem mais do código; o build
  não pede `cook:people` a cada mudança. `DT` num módulo próprio (`sim/dt.ts`).

### Prédios sem faces sobrepostas piscando (2026-10-13, fotos do jogador)
- Detector `tests/render/coplanar.spec.ts`: arquiva cada face dos prédios pelo plano (1 mm) e
  soma a área de faces de aspectos diferentes, no mesmo plano e no mesmo sentido, que se
  cobrem. Antes: cerca de 5.000 m² em 150 prédios da cidade pequena. Depois: cerca de 5 m²,
  e o teste trava 3,6 m² em 100 prédios (só diminui; 5 s).
- Causas e camadas (`buildingMesh.ts`): as peças instanciadas ganham das paredes pelo
  `polygonOffset` (`kit.ts`, glPolygonOffset). O meio-fio dos lotes fica 1,2 cm para dentro, sob a
  placa, e as laterais das calçadas 6 mm para dentro: o muro sobre a borda fica com a face. O
  embasamento fica 1,2 cm acima do piso (o pátio no nível do piso batia no topo dele), e a
  soleira das portas também. O calçamento em volta dos prédios e as faixas rentes vão em
  cata-vento (cada canto uma vez). O muro de divisa fica sobre o rodapé, sem sobrepor a ele.
  A pingadeira das marquises, a grelha do ar-condicionado, as cortinas, as venezianas e a
  casa de máquinas ficam afastadas dos planos vizinhos.
- Duas causas no gerador: a viela levava calçamento duplo, com pavers e pedras no mesmo
  retângulo (`editor/lotPlan.ts`); e a marquise sobre um gramado era assentada no chão como
  uma laje (agora só o que está de pé na terra é assentado). Mapas salvos antes guardam a
  viela dupla até a cidade ser gerada de novo.
- Visto no jogo (5300, cidade gerada de novo): centro com casas de máquinas recuadas, loja
  com toldos e grade, casa com marquise na parede e pátio de lajotas, pé da casa de perto.
  Nenhuma faixa de pisca em quadro parado; o movimento foi visto só com zoom pela roda.

### Câmera: menos engasgos (2026-10-13, relato do jogador: "trava", "trepidação")
- Medido no jogo (5300, cidade gerada, 1775×922): a câmera anda certo por quadro (velocidade ×
  tempo); o engasgo era o tempo de quadro. Antes: CPU 28 ms (simulação 12–14, desenho 16), GPU
  25 ms, picos de 50–117 ms e passos da simulação de até 61 ms.
- Causas corrigidas: o orçamento de 8 ms rodava um segundo passo de 7 ms (agora só começa o passo
  que cabe); o pátio de doca dos caminhões era montado inteiro num passo, 30 ms, varrendo todos os
  lotes, prédios e o asfalto do mapa (agora em fatias de 40 mil células, com o que está perto
  por um índice por revisão); a fumaça dos escapamentos estava 2,5× maior (unidade antiga de
  0,4 m lida como metro); as molduras e grades de janela a mais de 150 m usam a versão de fachada
  (LOD por célula, com histerese, como o `LOD.update` do three).
- Depois, com a câmera andando 11 s: simulação p50 8 ms, máx. 16; CPU p50 23 ms; GPU p50 17–23 ms;
  sem picos de script. Ainda ~40 quadros/s com quadros de 50 ms às vezes: falta GPU (sombras 4 ms,
  pessoas 3,7, prédios 3,7, chão 2,4, pós 5,8) e o desenho na CPU (1.273 chamadas).

### S1a — Prédios de longe (HLOD) (2026-10-13, etapa S do plano)
- Pesquisa lida: HLOD do Unreal (World Partition), *Interior Mapping* (van Dongen 2008), erro de
  tela do Cesium (`Cesium3DTile.getScreenSpaceError`), `LOD.update` do three, `BatchedMesh`,
  procedurais filtráveis (Quilez), POM (Tatarchuk 2006), impostores octaédricos, CityGo.
- `render/buildings/massing.ts`: cada prédio em volumes a partir das MESMAS baias do detalhe
  (`facadeBays`: só paredes externas, relevos, galerias, cor por andar), telhados com beiral,
  platibanda onde o telhado termina, casas de máquinas e equipamento de telhado do mesmo plano
  (`roofPlan.ts`), lotes pavimentados. `massingMaterial.ts`: janelas no shader por baia e andar,
  filtradas por pixel, acesas à noite como as do detalhe. `massCells.ts`: uma malha por célula
  de 240 m, trocada pelo erro de tela (1,5 m, 2 px, histerese 0,85).
- Causas achadas no detalhe pelo teste e corrigidas: faixa de andar desenhava uma laje escondida
  na planta inteira a cada andar; embasamento e calçamento dentro do prédio nos lados encostados.
- `tests/render/massing.spec.ts`: distância de Hausdorff 3D entre os dois níveis (área ≤ 3 %
  além de 1,5 m), 54 prédios, 4,6 s.
- Medido (cidade de 1.348 prédios, 1775×922): visão geral GPU 25 → 11 ms, chamadas 1.273 → 340;
  ~56 triângulos por prédio de longe contra ~13 mil no detalhe. Visto: dia, noite, transição.
- Ainda não: o detalhe continua montado para todas as células (S1b: só perto), e o nível
  intermediário com relevo (POM) e *Interior Mapping* de verdade.

### Auditoria de desempenho e de imagem, e as correções medidas (2026-10-13)
- Sete investigações somente-leitura em paralelo (render, simulação, documento/edição, thread
  principal e interface, pessoas, edição de via, qualidade de imagem), cada achado com arquivo,
  linha, frequência e classe de custo. Os achados abertos viraram R26–R30 em `docs/PROBLEMS.md`.
- **Medido no jogo (RTX 3060, 1920×1080, dpr 1, cidade de 1.348 prédios, 615 veículos, 443
  pessoas):** GPU p50 16,9 ms e CPU p50 12 ms na rua; 1.408 chamadas de desenho e 44,2 M de
  triângulos de perto; 42,1 ms de GPU na vista do mapa inteiro. Por passe: **sombras 4,8 ms**
  (28% da GPU), GTAO 0,87, SMAA 0,21, nuvens e luz do cânion ~0 (ruído).
- **Sombras (R24/S/F8):** o custo é o REDESENHO do mapa, não a amostragem — com o mapa de sombra
  congelado a GPU cai os mesmos 3,15 ms que desligando a sombra por inteiro, e o tamanho do mapa
  quase não pesa (1024 → 30,19 ms, 2048 → 30,55, 4096 → 30,68: 0,5 ms entre um quarto e o dobro
  dos texels). O passe passa a ser desenhado só quando pode ter mudado: o sol ou a grade andaram
  (`environment.follow` responde), um caster novo apareceu (reconstrução, carga de asset, troca de
  nível), a simulação avança ou o vento sopra (a cada quadro de perto, a cada 3 onde a sombra é
  menor que um texel). Vista do mapa inteiro: o custo da sombra caiu de 4,8 para **2,25 ms**.
- **Contornos (serrilhado/nitidez):** o `SMAAPass` do three vem no preset *1x Medium* — oito passos
  de busca e limiar 0,1 — e é executado antes do `OutputPass`, sobre a imagem LINEAR HDR, onde 0,1
  não é um décimo da faixa de exibição: as arestas de baixo contraste de todas as sombras ficavam
  abaixo do limiar e não eram detectadas. Passa a 16 passos (preset *High*, mesma textura de área) e
  limiar 0,04. O alvo multi-amostrado sobe de 4 para 8 amostras (o máximo da GPU), com custo neutro.
- **Caminhada (R28):** a travessia de cada perna de cada cruzamento refazia uma cópia e um filtro de
  TODAS as faixas do mapa — o termo quadrático do `tests/scale/edit.spec.ts`, x196,84. As faixas
  passam a ser baldeadas por segmento uma vez: **x13,98**, e a linha de base fica no valor medido.
- **Admissão (R23):** a passagem pedia a alocação de TODOS os veículos, três conjuntos cada, a cada
  tick, para os que não seguram nada (a maioria). Uma checagem sem alocação responde o mesmo.
- **Placas de rua:** eram refeitas em toda reconstrução de mobiliário, inclusive a da hora do
  crescimento, e construir uma placa percorre todas as faixas do mapa por nome de rua. Só são
  refeitas quando as vias, o terreno ou o paisagismo andaram.
- **Escapamento (R29):** os seis atributos do conjunto de 4.000 partículas iam inteiros (128 KB) à
  GPU em todo quadro com qualquer motor fumegando; agora sobe só a faixa do slot escrito.
- **Medido e NÃO mexido, para não refazer o que já está certo:** `performance.measure` custa
  1,15 µs por chamada (sete por quadro = 7 µs, 0,04% do quadro) e é o que o monitor F9 lê para
  explicar um quadro longo — fica. O `keepGrassInputs` (147 mil amostras de terreno e quatro
  uniões) está MORTO: só é chamado atrás de `const show = false`, a grama de lâminas saiu por
  decisão do jogador em 2026-10-06.
- **Aberto e gravado:** R26 (o conjunto de armadilhas de rota fica velho depois de uma edição; a
  correção é de uma linha mas exige acrescentar `routing` à linha de base — aguardando o jogador,
  A2), R27 (cada edição recopia e re-difere o documento inteiro, ~18–20 ms só o clone) e R30
  (oito luzes pontuais fixas, ~1 ms de GPU).

### Auditoria de desempenho pelo código, e cinco correções (2026-10-13, noite)
- Varredura do repositório inteiro (render, shaders, workers, simulação, documento, editor,
  interface, configs de build), sem agentes (decisão do jogador), com pesquisa por item. A lista
  completa, com arquivo:linha, técnica e fonte, está em `OTIMIZACAO.md` (raiz), que passa a ser
  a lista de trabalho desta frente; o que foi conferido e está certo está lá para não ser reaberto.
- Feito, um commit por correção, build e typecheck verdes em cada um:
  1. **Detalhe dos prédios só nas células perto, com streaming (HLOD de verdade)** —
     `render/buildings/layer.ts`, `massCells.ts`, novo `layerCells.ts`, `renderer.ts`. O detalhe
     de uma célula só existe enquanto ela é perto pelo erro de tela e dentro do alcance da vista;
     longe, só a massa; célula que fica perto chega em fatias por quadro (aquecida na GPU antes
     de aparecer), célula longe há 10 s solta malhas e arrays. Visto no painel: rua, bairro e canto
     em detalhe, mapa inteiro em massa; geometrias 920 → 712 ao afastar, 518 no canto a zoom 9.
  6. **Um passe de saída**: tone mapping, sRGB e o grade (CAS, contraste, vibrância, vinheta) no
     mesmo fragmento (`render/postprocess.ts`); um passe de tela cheia a menos por quadro. Visto
     de dia e de noite.
  7. **Materiais compartilhados** nas cercas e nas placas (`render/barriers.ts`, `signs.ts`).
  9. **Desgaste dos prédios por prazo** (`main.ts` `decayWatch`): só os prédios vencidos, pelo
     diário, não o mapa inteiro a cada 3 s.
  10. **Um material para os lampejos de via** (`render/renderer.ts`).
  2. **Cascas dos prédios num `BatchedMesh` por acabamento** (`render/buildings/shellBatches.ts`,
     materiais próprios dos lotes em `kit.shellBatched`, variante de profundidade na sombra):
     bairro 916 → 498 chamadas, rua 654 → 528, mapa inteiro 1.111 → 847.
  12. **Lacuna do streaming** (foto do jogador: lotes vazios): a massa fica até o detalhe chegar
     (`massCells.holdMass`); os chunks completos ficam num cache por bytes (768 MB) com LRU por
     célula (Cesium `cacheBytes`); até 4 células por quadro.
  13. **Abertura da cidade gerada**: crescimento 100 ms por quadro com os prédios e a
     sobreposição dos lotes segurados (`holdBuildings`, `LotTool.holdOverlay`), só as células
     perto emitidas na abertura, massas antes do detalhe, prédios longe num backlog nas sobras do
     quadro. Prédios na tela a 7,5 s do pedido (eram 11,8 s), sem travar a página.
  4. **R27 (metade)**: `replaceWith` compara só os tipos que o diário da cópia diz que mudaram
     (`forkedFrom`/`movedIn` em `world/doc.ts`); feito por agente supervisionado, diff revisado,
     825 specs de `world`/`editor` verdes. Fica o `clone()` por edição.
  14. **Traçado da cidade gerada em fatias**: `layPowerLinesSteps`, `greenCitySteps`,
     `layoutSteps`; chamada síncrona 1.534 → 157 ms, cidade íntegra.
  15. **Vistas de rua** (`massCells.ts`): com o olho baixo o erro permitido cresce com a
     distância (Cesium `dynamicScreenSpaceError`): rua 984 → 660 chamadas, GPU 16,9 → 16,0 ms,
     desenho CPU 8,9 → 7,4 ms. Medido ao vivo: um passo de simulação por quadro, 7,1 ms no quadro
     (4,7 ms em laço apertado), desenho 7,4 ms.
- **R30 derrubado medindo** (2026-10-14): as oito luzes pontuais escondidas não mudam a GPU
  (18,7 / 18,9 / 19,0 ms em A/B na mesma vista); a mudança foi desfeita e vai para os falsos
  positivos. Células de 120 m (culling mais fino) também pioraram (19,1 ms, 1.266 chamadas).
- Medido a 1920×1080 na rua, cidade de 1.348 prédios: GPU 14,6 ms (sombra 4,1); CPU p50 32 ms,
  simulação 13,7 e desenho 18,5. **O maior custo de quadro é a simulação na thread principal.**
- Pendente, com o porquê em `OTIMIZACAO.md`: simulação em worker (#3: o `SimWorld` lê documento e
  rede por referência em todos os estágios e o renderer lê as estruturas da simulação; precisa de
  um plano próprio com o jogador), o `clone()` por edição (resto do #4) e o registro compacto de
  prédio (#8).
- NÃO rodado: `npm run check` inteiro (o pedido desta rodada limitou a verificação a build e
  typecheck); por isso nada foi enviado ao GitHub.

### Carregamento e travadas, oito correções medidas (2026-10-14)
- Perfil de CPU e Long Animation Frames da geração de uma cidade e de um movimento de câmera por
  ela; itens 17 a 24 de `OTIMIZACAO.md`, cada um com arquivo:linha, técnica, fonte e medida, um
  commit por correção, `check:all` verde em cada um, todos enviados.
  - **Cor dos lotes**: deixou de ser redeitada a cada prédio colocado (`lotOverlay.ts`
    `GROUND_KINDS` sem 'buildings'; 3,7 → 1,3 s) e é deitada em fatias de 12 ms, mostrada em
    pedaços (o quadro de 1,27 s sumiu; pior quadro visível 550 → 133 ms).
  - **Pessoas**: a cor média das texturas lida num canvas em software (`willReadFrequently`):
    1.307 → 31 ms.
  - **Tráfego**: os pares de conflito medidos em até 4 workers (`conflictPool.ts`,
    `conflictTable.worker.ts`, `world/conflictTable.ts` puro): thread principal 3.563 → 1.021 ms,
    primeiro quadro visível 6,6 → 5,0 s, mesmos 6.180 pontos.
  - **Elevação** memoizada (`has`), **validação de prédio** por caixa antes do recorte
    (740 → 237 ms), **peças instanciadas compiladas na abertura** (`partWarm.ts`: nenhuma
    compilação num movimento), **interiores** numa grade de 2 m (192 → 73 ms, mobília idêntica).
- Tentado e desfeito: dar à massa as cores do detalhe para usá-la mais cedo no mapa inteiro
  (a diferença medida piorou; detalhes no `OTIMIZACAO.md`).
- Medido no painel (1688×922, cidade padrão): prédios na tela ~9 s após o pedido; bairro e rua a
  60 fps (GPU 12,4 / 11,1 ms); mapa inteiro 46 fps, limitado pela GPU (~20 ms: cascas 6,5 M de
  triângulos, peças 7,0 M, sombra 2,6 ms); movimento de câmera ~59 fps com a cidade aquecida e
  ~33 fps no primeiro minuto de uma cidade nova (montagem dos prédios que chegam, #16).
- Pendente: nível intermediário de detalhe para o mapa inteiro (cascas e peças simplificadas
  abaixo de um pixel, meshoptimizer, e peças do mesmo tipo de células vizinhas numa só malha),
  montagem de prédio num worker (#16), simulação em worker (#3), registro compacto (#8, decisão do
  jogador).

## Próxima etapa
- Corrigir a lista do analisador pelos achados por quadro (sobreposição dos lotes, cercas,
  tela de sobreposição, AmbientWorld), contadores em todos os produtos derivados, e os specs
  lentos reescritos para segundos.

## NÃO VERIFICADO
- O crescimento das plantas por hora da cidade (`renderer.ts` `growPlants`) não foi visto no
  jogo: uma hora da cidade leva 3 min reais a 1× e uma hora de crescimento é 1/72 do total,
  nada que uma foto curta mostre. A mudança só tira a cópia por quadro; a regra de quando
  refazer ficou a mesma.
- **O painel do navegador do app ficou oculto às ~08:20** e só o jogador o reabre
  (Ctrl+Shift+B). Desde então o que é visual foi verificado em janelas do Chrome
  abertas pelo Playwright (visíveis, na RTX 3060), não no painel.
- R1: a quebra da build normal é intermitente; a sonda não a reproduziu nem no jogo
  antigo. Fecha quando o portão (bomba e pistola em toda execução) passar limpo.
