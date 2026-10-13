# Estado — Roadcraft 2

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
