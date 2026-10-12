# Problemas — Roadcraft 2

Registro vivo dos problemas abertos. Uma linha só fecha com a medida "depois",
tirada do mesmo jeito que a "antes" (portão ou registro do próprio jogo), e com
o jogo visto. O histórico completo da FONTE está em `docs/source/PROBLEMAS.md`
(só leitura; os números citados pelo código antigo apontam para lá).

## Aguardando o jogador

Decisões que só o jogador pode tomar (tirar recurso, baixar qualidade visual,
afrouxar orçamento ou teste). Cada uma com a recomendação e o porquê.

| # | Decisão | Recomendação | Por quê |
|---|---|---|---|
| A1 | Onde apareceram os semáforos todos verdes ou todos vermelhos com carros passando (planeta ou plano; jogo antigo nas portas 4180/5173 ou o novo)? | Dizer o lugar e, se der, o mapa | No jogo novo, plano e planeta, 1.571 entradas medidas, nenhuma no vermelho, e as fotos batem com a simulação: sem o lugar não há como reproduzir |

## Abertos

Trazidos da FONTE (`docs/source/PROBLEMAS.md`, linhas abertas ou aguardando) e
achados aqui. A etapa que trata cada um está na coluna "Etapa".

| # | Problema | Antes (medida) | Causa (arquivo:linha) | Etapa | Estado |
|---|---|---|---|---|---|
| R1 | **A pistola derruba a página.** Depois de uma bomba, um tiro numa pessoa lança `RuntimeError: table index is out of bounds` dentro do `Step` do Jolt (`render/ragdoll.ts` `step` → `jolt-physics.wasm-compat`), e a página trava (nem a foto sai em 30 s). | Portão no jogo antigo: planeta 1 de 6 execuções (A/A da linha de base), plano 1 de 1 na primeira rodada da E2 Causa medida com a build de depuração do Jolt (`docs/research/ragdoll-joints.md`): eixos de junta não unitários ou não perpendiculares montados em `render/ragdoll.ts` `joltSpec` (cone da coxa inclinado; direção nula entre partículas sobrepostas): 5.394 asserts em 12 bombas. Já tentado: (1) posse única das juntas em `tear` (correto, mas a página ainda travou na bomba seguinte). (2) Eixos sempre válidos (`render/ragdollAxes.ts`) e junta inválida recusada antes do Jolt: 0 asserts nas mesmas 12 bombas. | Antecipado para a E2/E3 (a bomba é recurso central e travava o teste de jogo) | corrigido na causa medida; aguardando o portão (bomba e pistola em toda execução) para fechar |
| R2 | **Envio de textura enorme a cada quadro** nas vistas da cidade (contagem por tamanho e formato no portão). | Primeira medida: a ordem de GB por 8 s; a contagem foi corrigida (largura × altura × bytes por pixel do formato) e a linha de base refeita — números em `gate/baseline/report-aa.json` | A atribuir: o portão grava os 5 maiores tipos de envio por janela (`uploadTop`) | F5 | aberto |
| R3 | **Abrir o mapa grande do jogador trava a página**: quadro de ~1,4 s no plano (cidade de 1.348 prédios, 11,6 MB). | `openMap.loafMax` 1.438 ms (A/A, plano) | A atribuir pela autoria do LoAF | F3/F5 | aberto |
| R4 | **Gerar a cidade bloqueia a página**: quadro de 675 ms no planeta; no plano o crescimento leva ~9 s. | `grow.loafMax`, `growMs` | A atribuir | F3/F11 | aberto |
| R5 | (corrigido, ver R5b) **Testes vermelhos herdados:** `tests/ui/decimals.spec.ts` (o cockpit de voo escreve números com `toFixed`, ponto decimal em português: `ui/flightCockpit.ts:110-146`, `ui/flightStick.ts:50`). Já falhava na FONTE. | 1 spec vermelho | `toFixed` no texto do jogador | E3 (corrigir para o check ficar verde) | aberto |
| R6 | **Em desenvolvimento, o botão de modo leva às origens do jogador** (`ui/modeChooser.ts:32`: 5177 e 5175 por padrão); abrir o jogo lá pode migrar e regravar mapas. Só no servidor de desenvolvimento (a build de modos usa `/plano/` e `/planeta/`). | — | endereço padrão | E3 | corrigido: padrão 5300 (`ui/modeChooser.ts`) |
| R8 | **Uma via nova pode levar 9–10 s para aparecer.** Numa execução do portão (plano, lado B, código idêntico ao antigo), todas as vias depois da primeira levaram 8,5–10,5 s, com a reconstrução cravada em ~4.021 e ~5.030 ms; nas outras execuções, ~0,5 s. | `gate/runs/e2-igualdade/plano/B-r1/city.json` | Hipótese (lida no código): `render/renderer.ts:1894-1897` — enquanto a leitura dos tiles guardados (IndexedDB, `storedRead`) não termina, cada reconstrução fatiada espera até `KEPT_TILES_WAIT_MS` = 3 s; se a leitura nunca termina, toda edição paga essa espera. Confirmar onde a leitura parou. | F3 | aberto |
| R9 | **A 8ª via do cenário do planeta nunca é construída** (k = 7, 600 m a leste, y = centro − 30), nos dois lados e em todas as rodadas. | `edits[7].readyMs = -1` em 6 de 6 execuções | A investigar (posição recusada? regra de edição?) | F12 | aberto |
| R10 | **Poste atravessa a avenida elevada.** Uma avenida a 6 m sobre uma rua com postes: um poste de madeira da rua de baixo fica no meio do tabuleiro, e os fios descem cruzando a pista. Nada pode atravessar coisas. | Teste de jogo, build nova (igual à FONTE), planeta: fotos do painel às 21:19–21:37 | A investigar: postes e fios da rua de baixo não consideram estruturas acima (`world/utilities.ts`, `poleLines.ts`) | F12 | aberto |
| R11 | **Placa verde translúcida em pé** na borda de um lote zoneado ainda vazio, vista com a câmera baixa (deveria ser marcação deitada no chão). | Foto do painel, câmera na altura da rua, 20:44 | A investigar (sobreposição do lote/zona) | F12 | aberto |
| R12 | **A roda do mouse com a câmera baixa leva a câmera a 14 km do mapa.** Com a câmera quase no horizonte, "afastar" mira o ponto sob o cursor, que está no horizonte: o centro foi para (12.128; 7.644) com os nós perto de (0; 0), e a vista virou deserto e mar. A tecla Home traz de volta. | Teste de jogo, planeta | A investigar: `zoomAt` sobre um ponto no horizonte (`render/isoViewport.ts`) | F12 | aberto |
| R13 | **O relógio do jogo pula**: 20:44 → 00:08 → 00:16 → 21:04 em cerca de um minuto, a 1×, depois de recarregar a página. | Teste de jogo, planeta | A investigar (relógio do dia e o modo do céu) | F12 | aberto |
| R14 | **Via nova desenhada provisoriamente com a seção errada por 1–2 s** (pista simples, tracejado branco largo, sombra oval) antes da avenida de verdade, com canteiro e árvores, aparecer; e desfazer só some com a via depois de 2–3 s. | Teste de jogo, planeta: fotos 21:14 e 21:16 | Reconstrução fatiada do mundo (`renderer.ts` `worldSteps`); meta da F13: via nova visível em ≤ 100 ms | F3 | aberto |
| R15 | **Membro arrancado volta a ser simulado no corpo.** `render/ragdoll.ts` `joltSpec` monta sempre as 12 peças: um corpo que perdeu um membro e é recriado no Jolt (`prepare`, partículas a mais de 8 cm) ganha o membro de volta; o pedaço arrancado é recriado como corpo inteiro. | Lido no código | `joltSpec` ignora `lostParts` e `pin` | F12 | aberto |
| R16 | **Uma tecla fazia duas coisas.** Na FONTE quatro ouvintes de `keydown` (voo, jogo, câmera em `main.ts`; gaveta em `ui/v2/shell.ts`) liam toda tecla, e o `return` de um não parava os outros: Esc no Construtor dava um passo atrás no prédio E largava a ferramenta; `+`/`-` no Relevo mudavam a força E davam zoom; PageUp num nó suave subia o nó E inclinava a câmera (e com a ferramenta de via, a altura da via E a câmera); Ctrl+F, Ctrl+T, Ctrl+P, Ctrl+B pegavam ferramentas além do atalho do navegador; Ctrl+1 escolhia classe de via; a gaveta abria por uma lista própria de letras sem O e G (com K, que não é atalho), e um atalho que larga a ferramenta abria a gaveta de Informação. | Lido no código (`main.ts` linhas 931, 1968, 2993; `shell.ts` 2160) | Vários ouvintes globais para a mesma tecla, sem resolvedor | F1: um registro de comandos (`core/commands.ts`) e uma tabela (`editor/gameKeys.ts`), um ouvinte; cada tecla roda um comando, e a ferramenta que lê as próprias teclas devolve `pass` nas outras (PASS_THROUGH do Blender). `tests/editor/gameKeys.spec.ts` | F1 | corrigido; teste no jogo pendente |
| R17 | **O portão acusava piora que não existe.** O envio da E3 foi barrado com 41 métricas "piores" no plano e 73 no planeta, inclusive em cenas (mapa vazio, cidade crescendo, vistas) cujo código não mudou entre base e candidato (só ragdoll, carregado na bomba, e dois contadores). | `node scripts/gate/verdict.mjs gate/runs/2026-10-12T13-56-10-667Z`; `git diff --stat 7513dc0 bf76aef -- src` | A regra comparava medianas de 3 rodadas com o ruído de UMA sessão A/A (e o A/A do planeta estava incompleto): nenhum teste estatístico; com 3×3 nem seria possível significância (p mínimo do Mann-Whitney = 0,1). E um erro do lado BASE barrava o candidato | Regra do Pinpoint do Chromium e do PerfCompare da Mozilla (docs/research/gate.md, "Statistics"): Mann-Whitney U exato + delta de Cliff; PIOR só com p ≤ 0,01, delta ≥ 0,47 e diferença acima da margem; "suspeito" (p ≤ 0,05) pede mais 2 rodadas até 12; 6 rodadas por padrão; só erros do candidato barram. `tests/arch/gateStats.spec.ts` | E3 | corrigido; confirmação no próximo envio |
| R18 | **Dois botões do dock parecem escolhidos.** Clicar em Vias e depois apertar O (ou G, T...) deixa Transporte aceso e Vias com o anel de foco. | Sonda com mouse e teclado reais, jogo antigo (4299) e novo: fotos `keys-old/31`, `keys-new/29` | O botão clicado guarda o foco, e uma tecla faz o Chrome mostrar o anel `:focus-visible` (heurística de modalidade do navegador) | O ouvinte único de teclas solta o foco do controle clicado quando a tecla aciona um comando do jogo (a regra que a Barra de espaço já usava, `ui/chrome.ts`); foco por Tab mantém o anel | F1 | corrigido; foto conferida |
| R19 | **"Um clique em Vias liga e desliga a ferramenta"** (auditoria 3.8, sem passos). | Sonda com clique real em Vias partindo de 9 estados, no jogo antigo e no novo: em todos o clique deixou a via na mão com a gaveta aberta, ou a largou quando Vias já estava aberta (o segundo clique, de propósito) | Não reproduzido | A regra do botão agora é uma transição testada (`editor/toolMachine.ts`, comparada com a da FONTE para todo par de ferramentas) | F12 | aberto: falta um relato com os passos |
| R5b | `decimals.spec` reprovava coordenadas e opacidades de SVG do cockpit de voo escritas por `set(el, chave, 'd' / 'x' / 'opacity', ...)`: valores de máquina, que precisam de ponto. | — | O padrão de exceção do spec não reconhecia o auxiliar `set` | E3 | corrigido no spec (texto do jogador continua proibido) |
| R7 | Faixas verdes tipo aurora no céu de dia, na vista de globo (foto do mapa 127.0.0.1:5177 reaberto no jogo antigo). | foto `reopen-old/planeta__127-5177.png` | A investigar | F8 | aberto |

## Já tentado e que não resolveu

Trazido da FONTE, para não repetir.

- **R17, regra do portão, tentativa 1 (2026-10-12):** mediana de 3 rodadas contra o
  ruído de uma sessão A/A → 114 "pioras" falsas. **Tentativa 2:** Mann-Whitney +
  delta de Cliff em TODAS as ~300 métricas, "suspeito" a p ≤ 0,05 pedindo rodadas →
  a cada 2 rodadas outras métricas ficavam suspeitas por acaso (comparações
  múltiplas) e o portão ia sempre a 12 rodadas; envio interrompido. **Tentativa 3**
  (depois de ler Holm 1979): 12 métricas principais por modo (as metas do pedido)
  formam uma família sob Holm a α = 0,05 e só elas barram; as outras só informam.

- **Lista vazia compartilhada em `shadowsAhead` (`leaderIndex.ts`, P70), 2026-10-09.**
  Desfeito sem medir; ganho esperado pequeno. Medir antes de refazer.
- **Troca de faixa por vontade a cada 0,25 s (P70), 2026-10-09.** Revertida: mudou o
  tráfego das avenidas e expôs uma entrada no vermelho ligada ao amarelo fixo; o
  amarelo pelo ITE entrou depois (P90). Refeita sobre o P90, só falhou a mediana
  das conversões livres à direita (16,99 contra 17 km/h, amostra de 7). Não
  adotada para não mexer no limite do teste.
- **Pedestres girando nas esquinas (P16), 2026-10-08.** Três tentativas revertidas
  (segurar o rumo parado; manter a listra; pure pursuit); resolvido em 2026-10-09
  (P52) pelas regras do SUMO e pela tangente contínua, com rastro tick a tick.
- **LOD das pessoas.** Reduz o custo por quadro, mas não resolve a criação lenta
  (o custo está no cozimento, no encaixe e no rosto: P4–P6 da FONTE).
- **"Otimização" das vias anunciada sem medir.** A causa real era P1 e P2 da FONTE.
- **Árvores do Nature Kit "com LOD".** Não carregavam (P10 da FONTE).
- **Cozinhar pessoas automaticamente no servidor de desenvolvimento.** Abria um
  Chrome invisível a cada reinício e travou o computador (2026-10-06). Cozinhar à
  mão, uma vez, depois de mexer em código de pessoas.
- **Não são causa:** o coletor de lixo na vila; `forestPlants` no topo das
  amostras; "7 MB por quadro" de buffers de veículos (erro de contagem).
- **Cidade gerada seguindo o relevo (AC8), 2026-10-11.** Três tentativas (parar a
  rua acima de 12%; rua que sobe vira rampa; quarteirão irregular em faixas): 446
  prédios no plano e 163 no planeta contra 514 e 234 da grade. Antes da quarta,
  medir onde os lotes somem e comparar no mesmo terreno.

## Regras que já custaram caro

- Nada em `render/` usa um contador global como chave de cache de coisa local. O
  que depende do chão ou do mundo lê o diário (`world/changes.ts`) pela área.
- Nunca criar material dentro de uma reconstrução: um material por combinação de
  parâmetros, feito uma vez (cada material novo relinka um shader).
- O que fica sobre o chão espera o job da edição terminar, e é testado contra o
  retângulo de cada item, não contra a união da camada.
- Um registro novo de prédio não é um lote novo: nivelamento e vagas comparam o
  texto do registro sem idade, nome e versão do plano do lote.
- Conteúdo que depende só dos assets e do código é cozido (`npm run cook:people`)
  ou guardado no cache derivado (`render/derivedCache.ts`), não refeito em jogo.
- Um `fetch` com caminho absoluto e um `catch` mudo fizeram as pessoas cozidas
  nunca carregarem na build de modos (PL53): nenhum erro é engolido.
- Editar com script de substituição de texto é proibido (regra do pedido de
  2026-10-12): só o Edit, para cada mudança ser lida antes.
