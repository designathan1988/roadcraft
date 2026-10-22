## 9. Os 6 defeitos de medição do relatório de auditoria: o que foi consertado em scripts/ e o que fica para src/ (aguardando aprovação)

Relatório de auditoria, seção "Testes, métricas e ferramentas de medição": TST-09, TST-10, TST-11, UI-15, AST-15, JOB-15.
Conferido no código em 2026-10-19 (commit 9569b704) antes de escrever cada linha abaixo.

### Consertado na Etapa 0 (só scripts/, nada em src/)

| Defeito | O que mudou | Arquivo |
|---|---|---|
| AST-15 (4) e um defeito novo | A checagem de CPU da máquina livre lia os contadores do Windows pelo nome em inglês. Num Windows em português esses contadores não existem, então ela sempre respondia "livre". Agora lê o tempo de CPU de cada processo duas vezes, com 1 s de intervalo, e exclui por número de processo (a própria medição, o servidor da porta), não por nome. Antes, todo `chrome` e todo `node` ficavam de fora, inclusive o navegador do jogador com o jogo aberto. | `scripts/lib/measureCity.mjs` `cpuNeighbours` |
| AST-15 (3) | A assinatura da cena inclui o número de programas compilados: uma janela que compilou um programa deixa de passar por "cena igual". | `scripts/lib/measureCity.mjs`, `scripts/sonda/pagina.mjs` |
| AST-15 (2) e UI-15 (a) | O `frames.mjs` abre a cidade pelo `openCity`: recusa máquina ocupada, espera a cena assentar e diz a cena de cada janela. Cada vista é medida duas vezes, com a simulação parada e rodando, lado a lado. Os campos de antes continuam sendo os da janela rodando, para comparar com `test-results/frames-before.json`. | `scripts/frames.mjs` |
| AST-15 (5) | O vsync do `look.mjs` é estimado pelo percentil 10 dos intervalos, em vez de 60 Hz fixos. O relatório do quadro diz o período usado em `vsyncMs`. | `scripts/look.mjs` `frameStats` |
| TST-11 (parte de scripts) | A lista `ALWAYS` do check citava um teste apagado (`tests/ui/statusScope.spec.ts`) e o check passava sem ele. A entrada saiu, e uma entrada que sumir agora para o check com o nome dela. | `scripts/check.mjs` |
| UI-15 (a), na sonda | A sonda não usa `measure(true)`. A cena parada usa a pausa do jogador (`setTraffic(false)`), e a cena 3 mede com a simulação rodando. | `scripts/sonda/roteiro.mjs` |
| `__frames` guarda só 240 quadros (defeito novo) | A sonda conta todos os quadros desenhados pelos disparos do `requestAnimationFrame`, sem pedir quadro nenhum. O `__frames` aparece ao lado, com o aviso de que cobre só os últimos 240. | `scripts/sonda/pagina.mjs` |

### O que esta rodada mostrou (v0 da cidade pequena, 19/10/2026, máquina livre)

Os achados estão na seção 2, ordenados pelo custo medido. Os que pesam, lidos do relatório:

1. **Trocar a sombra de lugar compila programas no quadro: 6,9 s parados** (cena 8, LoAF de 6938 ms). Dentro do quadro, o perfil mostra 6817 ms em `getProgramInfoLog`, chamado por `scenePass.render` em `src/render/postprocess.ts:145`. Desligar e religar a sombra recompila os programas do pós e o jogo espera cada um. A regra compila-no-quadro (Etapa 1) vai contar isso por programa; o contador de prova é `gl.lateCompiles → 0` depois do aquecimento.
2. **A abertura leva 62 s para assentar depois de 4,6 s para mostrar a cidade** (cena 1). As tarefas longas da abertura: `intern` em `src/world/buildings/intern.ts:72` (1624 ms numa tarefa só), `scenePass.render` (20 tarefas, pior 254 ms, o tempo em compilar programas), `word` em `src/core/digest.ts:72`, `hypot2` em `src/core/hypot.ts:7` chamado por `nearest` em `src/world/roadField.ts:479`. Tudo isso é carga, mas o jogador vê a cidade e ela continua travando por quase um minuto.
3. **A cena 2 (pausa do jogador, câmera parada) desenha 0 quadros em 5 s.** Nada do jogo roda além de dois timers de interface (`src/ui/profilerHud.ts:34` a cada 250 ms, `src/ui/healthPanel.ts:259` a cada segundo) e nenhuma mensagem vai aos workers. Esse é o estado que a regra parado-rodando exige; a cidade pequena já o cumpre com o jogo pausado. O que resta é a regra todo-quadro com a simulação rodando (cena 3: 330 quadros em 5 s com a câmera parada), que precisa dos ganchos da Etapa 1.
4. **Mensagens de 1 a 6 MB entre a página e os workers: 1,4 GB copiados no roteiro.** `src/jobs/jobPool.ts:446` manda 138 mensagens de até 4,9 MB para o `citizenBake` (641 MB) e recebe 84 de até 5,7 MB do mesmo worker (162 MB); os workers 4 e 5 devolvem mais 177 MB. A sonda só vê o tamanho, não se foi copiado ou transferido; a Etapa 1 embrulha o `postMessage` e lê a lista de transferência.
5. **Memória da aba: 1,2 GB na abertura e 1,4 GB no fim**, 826 MB na página e 340 MB em cinco workers (`measureUserAgentSpecificMemory`). O `__roadcraft.memory()` do jogo diz 467 MB de alvos de render e 275 a 543 MB de geometria. O orçamento do plano para alvos é 300 MB; passa em todas as nove cenas.
6. **A cena 9 remove 10 prédios e 5 vias e o heap sobe 23 MB**, com 3492 `JSArrayBufferData` a mais (16,5 MB) e 520 `BufferAttribute` a mais. Remover prédios cria buffers em vez de soltar. A regra zumbi (Etapa 1) diz de quem são.
7. **A GPU passa do orçamento de 12 ms em toda vista de bairro e rua** (18 a 20 ms no bairro, 15 a 17 ms na rua, p95). O tempo por desenho é da Etapa 2.
8. **Código que nunca rodou:** 953 de 6240 funções carregadas; 15 exports sem uso (knip) em arquivos que a página nunca carregou (`src/editor/mapExport.ts offerFile`, `src/render/farRoadTiles.ts bakePlanRoads`, `src/render/nearRoadTiles.ts noRoads`...). Decisão humana: lista em `codigo-morto.md`.

Defeitos da própria sonda achados e consertados nesta rodada, para o registro: o trace de 892 MB não cabia numa string e ficou sem leitura (agora é lido em fluxo); o buffer de trace do Chrome encheu na cena 7 e as cenas 8 e 9 ficaram só com LoAF e perfil (próxima rodada: um trace por cena); cada tarefa longa era contada duas vezes (`RunTask` dentro de `ThreadControllerImpl::RunTask`); o cruzamento com o knip dava zero porque os caminhos dos mapas do Vite vinham sem a pasta; as chamadas da própria sonda no início da janela apareciam como trabalho do jogo.

### Feito em src/ com o sim do jogador (19/10/2026): os itens 1 a 12 abaixo

- **Itens 1, 2 e 10:** o renderer guarda chamadas e triângulos logo depois do pós (`frameDrawn`), e `budget()` lê isso. `memory()` separa `builtTriangles` de `drawnTriangles`. O `autoReset` já estava desligado e o `info.reset()` já era um por quadro.
- **Item 3:** `budget()` tira o fps da mediana dos intervalos dos últimos 2 s. Sem 60 quadros seguidos, diz "não medido".
- **Item 4:** o `countMemory` conta os mips, o array real das texturas de dados, os níveis dados (sem multiplicar pelas camadas), o canvas das placas pelo tamanho enviado e as texturas dos uniforms compilados. Deixa as texturas de alvo de render para a conta dos alvos e não conta como residente um buffer solto sem tamanho. Medido na cidade pequena: texturas de 41 MB para cerca de 385 MB.
- **Item 5:** `dispose.target` no pico e no "último" do HUD.
- **Item 6:** `growTimed` pede ao worker e mede até o prédio escrito. O teste de arquitetura agora proíbe qualquer `growOnLot` na página.
- **Item 7:** `longFrameWork` soma os passos medidos pelo jogo e o tempo antes do render quando nenhum script foi listado.
- **Item 8:** `perfBudget` reprova o grupo `other` e lista os nomes a classificar, compara o heap com 1,5 GB e soma os workers quando medidos. O comentário do governador de tempo foi corrigido.
- **Item 9:** `npm run build:probe` e `npm run preview:probe` (porta 5301) expõem as sondas num build de produção, sem os painéis de DEV.
- **Item 11:** o `FrameTimer` guarda 30 s de quadros (até 4096), não 240.
- **Item 12:** `measure('running')` roda a simulação com passo fixo de 1/60 s por quadro.

### A lista original (todos feitos, mantida como referência)

| # | Defeito | O que fazer | Onde (conferido) |
|---|---|---|---|
| 1 | UI-15 (b) | Guardar `{calls, triangles}` logo depois do `post.render` do quadro e fazer `budget()` e o HUD lerem esse instantâneo. Hoje `budget` lê `gl.info.render` na hora em que é chamado, e o que for desenhado depois do quadro (aquecimento de programas) entra na conta. | `src/main.ts` `budget` (lê `scene.gl.info.render.triangles/calls`); `src/render/renderer.ts:3294` `drainCompiles` |
| 2 | UI-15 (c) | Renomear `memory().triangles` para `builtTriangles` e acrescentar `drawnTriangles`: hoje o mesmo nome é "construídos" num lugar e "desenhados" no outro. | `src/main.ts` `memory` e `budget` |
| 3 | UI-15 (d) | Tirar o `fps` de `scene.stats.fps`, que é média de 1/delta com o laço sob demanda. Usar o `frameTimer` ou recusar sem modo de medição. | `src/main.ts` `budget` |
| 4 | UI-15 (e) e TST-09 (a) | `countMemory`: somar os mips (×4/3 ou por nível), os bytes reais por formato, os alvos de render, o canvas já enviado (guardar o tamanho antes de zerar) e as texturas injetadas por `onBeforeCompile`. Para buffer liberado, usar o `BYTES_PER_ELEMENT` em vez de 4. | `src/render/memoryCounters.ts:17`, `:41-42`, `:73-74`, `:90` |
| 5 | UI-15 (f) | Pôr `dispose.target` no pico e no "último" do HUD. | `src/ui/profilerHud.ts:64`, `:68` |
| 6 | UI-15 (g) | `growTimed` mede o crescimento na página, mas o jogo cresce no worker. Medir `growth.ask` mais o tempo do worker. | `src/main.ts` `growTimed` |
| 7 | TST-09 (b) | `longFrameWork` não vê quadro feito de muitos scripts curtos (o LoAF só lista scripts acima de 5 ms). Somar os passos medidos pelo jogo (`stepsWithin`) e usar `renderStart - startTime` quando não houver script listado. | `src/ui/healthWatch.ts:32-36` |
| 8 | JOB-15 | `perfBudget`: orçamento para `other` (ou falhar com nome não classificado), texturas com mips, teto de alvos lido do plano, `over` no heap somando os workers. Corrigir o comentário do "time governor", que não existe mais. | `src/core/perfBudget.ts:43`, `:65`, `:74-83`, `:124` |
| 9 | AST-15 (1) | Um modo `vite build --mode probe` com `__frames`/`__gpu`/`__measure` sem o painel de DEV, para medir o build de produção. Hoje tudo isso só existe em DEV. | `src/main.ts` (`import.meta.env.DEV` em `__roadcraft`, `__frames`, `__gpu`) |
| 10 | AST-15 (7) | Triângulos desenhados de `renderer.info.render` com `autoReset=false` e zerados uma vez por quadro do jogo. | `src/render/renderer.ts` |
| 11 | Defeito novo | O `FrameTimer` guarda só 240 quadros. Uma janela de 5 s a 60 Hz perde o primeiro segundo. Guardar por tempo, ou deixar o tamanho ser pedido pela medição. | `src/core/health.ts:139` |
| 12 | UI-15 (a) | Um modo de medição com passo fixo e semente fixa, em vez de parar o relógio: hoje `measure(true)` faz `sim.clock.paused = true`, e agentes, crescimento e desgaste param. | `src/main.ts` `measure` |

Ficam fora de scripts/ e de src/ e também precisam de aprovação: TST-10 (guardas em `tests/` que não conseguem falhar) e o resto do TST-11 (`tests/arch/*`, `tests/ui/noBackdropBlur.spec.ts`, `scripts/check-refs.mjs` com nomes curtos). Fora da lista dos 6: o AST-17 (o cão de guarda do `look.mjs` mata todo Chrome headless da máquina).

### O que a Etapa 1 da sonda precisa em src/ (plano §3 [A], só em DEV, atrás de `?sonda`)

| # | Gancho | Para quais regras |
|---|---|---|
| 13 | Embrulho do contexto WebGL (modo leve e gravação), com a memória de GPU exata somada dos envios | upload-igual, sincrono-na-gpu, compila-no-quadro, nan, memória de GPU |
| 14 | Construtores do three (`BufferGeometry`, `Material`, `Texture`, `WebGLRenderTarget`, `Object3D`) e `dispose`, com a pilha | zumbi, churn, duplicado |
| 15 | Assinar o `ChangeJournal` (`doc.changes`) e o `gameState.set` | regiao-inteira, desligado-rodando |
| 16 | Embrulho do `jobPool` (despacho e resposta) e dos `postMessage` dos workers, incluindo os workers de workers, que o Playwright não vê | clone-grande completo, sim-a-toa |
| 17 | Timers e ganchos com o dono (`setTimeout`, `requestAnimationFrame`, `addEventListener`, `ResizeObserver`) | gancho-orfao |
| 18 | Buffers em SoA transferidos ao piloto no fim, sem objeto por evento | a sonda não pode virar o lixo que ela procura |
