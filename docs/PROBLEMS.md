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
| — | (nenhuma até agora) | | |

## Abertos

Trazidos da FONTE (`docs/source/PROBLEMAS.md`, linhas abertas ou aguardando) e
achados aqui. A etapa que trata cada um está na coluna "Etapa".

| # | Problema | Antes (medida) | Causa (arquivo:linha) | Etapa | Estado |
|---|---|---|---|---|---|
| R1 | **A pistola derruba a página.** Depois de uma bomba, um tiro numa pessoa lança `RuntimeError: table index is out of bounds` dentro do `Step` do Jolt (`render/ragdoll.ts` `step` → `jolt-physics.wasm-compat`), e a página trava (nem a foto sai em 30 s). | Portão no jogo antigo: planeta 1 de 6 execuções (A/A da linha de base), plano 1 de 1 na primeira rodada da E2 | Hipótese (lida no código, não confirmada): `render/ragdollJolt.ts:390` `tear()` dá ao pedaço arrancado as juntas inteiras dentro dele (`pieceJoints`) sem tirá-las do ragdoll original (`this.joints[i]` fica com elas; só as peças são anuladas, linha 391): duas donas para a mesma junta. Destruída uma (`destroy()`, linha 405, chamado por `prepare` em `render/ragdoll.ts:1451` ou por `release`), a outra guarda um ponteiro para junta já retirada do sistema. Confirmar com o rastro e a documentação do Jolt (posse e contagem de referência de `Constraint`, `PhysicsSystem::RemoveConstraint`) antes de corrigir. O portão passou a medir bomba e pistola depois das vias, para a quebra não apagar o resto. | F12 | aberto |
| R2 | **Envio de textura enorme a cada quadro** nas vistas da cidade (contagem por tamanho e formato no portão). | Primeira medida: a ordem de GB por 8 s; a contagem foi corrigida (largura × altura × bytes por pixel do formato) e a linha de base refeita — números em `gate/baseline/report-aa.json` | A atribuir: o portão grava os 5 maiores tipos de envio por janela (`uploadTop`) | F5 | aberto |
| R3 | **Abrir o mapa grande do jogador trava a página**: quadro de ~1,4 s no plano (cidade de 1.348 prédios, 11,6 MB). | `openMap.loafMax` 1.438 ms (A/A, plano) | A atribuir pela autoria do LoAF | F3/F5 | aberto |
| R4 | **Gerar a cidade bloqueia a página**: quadro de 675 ms no planeta; no plano o crescimento leva ~9 s. | `grow.loafMax`, `growMs` | A atribuir | F3/F11 | aberto |
| R5 | **Testes vermelhos herdados:** `tests/ui/decimals.spec.ts` (o cockpit de voo escreve números com `toFixed`, ponto decimal em português: `ui/flightCockpit.ts:110-146`, `ui/flightStick.ts:50`). Já falhava na FONTE. | 1 spec vermelho | `toFixed` no texto do jogador | E3 (corrigir para o check ficar verde) | aberto |
| R6 | **Em desenvolvimento, o botão de modo leva às origens do jogador** (`ui/modeChooser.ts:32`: 5177 e 5175 por padrão); abrir o jogo lá pode migrar e regravar mapas. Só no servidor de desenvolvimento (a build de modos usa `/plano/` e `/planeta/`). | — | endereço padrão | E3 | aberto |
| R8 | **Uma via nova pode levar 9–10 s para aparecer.** Numa execução do portão (plano, lado B, código idêntico ao antigo), todas as vias depois da primeira levaram 8,5–10,5 s, com a reconstrução cravada em ~4.021 e ~5.030 ms; nas outras execuções, ~0,5 s. | `gate/runs/e2-igualdade/plano/B-r1/city.json` | Hipótese (lida no código): `render/renderer.ts:1894-1897` — enquanto a leitura dos tiles guardados (IndexedDB, `storedRead`) não termina, cada reconstrução fatiada espera até `KEPT_TILES_WAIT_MS` = 3 s; se a leitura nunca termina, toda edição paga essa espera. Confirmar onde a leitura parou. | F3 | aberto |
| R9 | **A 8ª via do cenário do planeta nunca é construída** (k = 7, 600 m a leste, y = centro − 30), nos dois lados e em todas as rodadas. | `edits[7].readyMs = -1` em 6 de 6 execuções | A investigar (posição recusada? regra de edição?) | F12 | aberto |
| R7 | Faixas verdes tipo aurora no céu de dia, na vista de globo (foto do mapa 127.0.0.1:5177 reaberto no jogo antigo). | foto `reopen-old/planeta__127-5177.png` | A investigar | F8 | aberto |

## Já tentado e que não resolveu

Trazido da FONTE, para não repetir.

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
