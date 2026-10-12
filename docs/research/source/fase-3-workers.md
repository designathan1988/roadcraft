# Pesquisa da fase 3 — pool único de workers, derivados em workers e fatia do quadro

Pesquisa de 2026-10-11, só leitura de código. Ramo `agente/pesquisa`, a partir de
`planeta-esfera` `27a7cb48`; todo `arquivo:linha` é desse commit. Complementa as
seções 4.9, 5.4 e 6.3 do `docs/relatorio-desempenho-mapas-enormes-2026-10-11.md`
(fontes F53–F57, F59, F68) e o bloco E (fase 3) do `PROMPT-PENDENCIAS.md`
(aceite do relatório: p99 do intervalo durante 20 edições seguidas; CPU total gasta
não pode subir mais que o tempo economizado).

**Como as fontes foram lidas.** Páginas e código de terceiros: WebFetch (a página ou o
arquivo convertido em texto e respondido por um modelo pequeno a um pedido meu; não é o
byte bruto — onde a resposta disse "não consta", registrei como lacuna). Código do
three.js r186.1: lido direto em `C:/Codex-Shared/roadcraft-planeta-esfera/node_modules/three`.
Código deste repositório: lido por mim. Nada foi rodado.

---

## 1. Perguntas que a fase 3 precisa responder

1. Que pools de workers existem hoje, com que tamanho, ordem e cancelamento, e o que
   cada um guarda de estado no worker (afinidade)?
2. Como é um pool com **prioridade recalculada pela vista** e **cancelamento por chave**
   em produção (Cesium, Piscina, three)? O que acontece com um job **já em execução**
   quando o pedido é cancelado?
3. Que tamanho de pool usar, e o que as fontes dizem sobre `hardwareConcurrency`?
4. Qual o custo de mandar dados (clone, transferência, entrega da mensagem) e o que
   isso exige do formato do que os workers recebem e devolvem?
5. Como orçar a fatia da thread principal "pelo que sobra do quadro": `requestIdleCallback`,
   `scheduler.postTask/yield`, `isInputPending`, ou medida própria?
6. Como os resultados que chegam dos workers entram no quadro sem formar rajadas
   (a lição do PA-U2: peças da fratura subindo à GPU sem orçamento)?

---

## 2. Fontes lidas

### 2.1 Pools de workers em produção

**Cesium, `TaskProcessor.js`** (ramo `main`,
https://raw.githubusercontent.com/CesiumGS/cesium/main/packages/engine/Source/Core/TaskProcessor.js ;
extração dirigida). Um `TaskProcessor` possui **no máximo um** worker, criado
preguiçosamente no primeiro `scheduleTask`; `maximumActiveTasks` (padrão infinito) é um
**limite de tarefas em voo**, não de workers; **`scheduleTask` devolve `undefined` quando
o limite foi atingido**, e o chamador tenta depois (contrapressão explícita); cada tarefa
tem um id (`_nextID++`) e um ouvinte de `message` que ignora ids diferentes; a lista de
transferíveis é passada ao `postMessage` (e **esvaziada** se o navegador não consegue
transferir `ArrayBuffer`, detectado por um teste de ida e volta com `Int8Array`, porque
"algumas versões do Firefox falham em silêncio"); **não há cancelamento**: `destroy()`
termina o worker e as promessas pendentes nunca resolvem. Ou seja, o paralelismo do
Cesium é "um processador por tipo de tarefa", e quem quer mais concorrência cria mais
processadores.

**Cesium, `RequestScheduler.js`** (extração dirigida). Escalonador de pedidos de rede com
prioridade: `priority` numérico recalculado por `priorityFunction()` em **cada
`update()`**, heap ordenada (`a.priority − b.priority`, menor = mais urgente) com
tamanho máximo `priorityHeapLength = 20`; se a heap enche, o menos prioritário é
**descartado** (cancelado, se já estava na fila; ou o pedido novo recebe `undefined`);
limites `maximumRequests = 50` e `maximumRequestsPerServer = 18`; estados `UNISSUED →
ISSUED → ACTIVE → RECEIVED | FAILED | CANCELLED`; **cancelamento por bandeira**
(`request.cancelled`, verificada no `update()`) com `cancelFunction` opcional para abortar o
trabalho de fundo, e respostas que chegam depois do cancelamento são ignoradas; estatísticas
de tentados/ativos/cancelados. Esta é a forma que o projeto precisa: **a prioridade é uma
função da vista de agora, reavaliada a cada quadro**, não um número fixo no momento do
pedido.

**three.js r186.1, `examples/jsm/utils/WorkerPool.js`** (lido inteiro). Pool de tamanho
fixo (padrão 4) com fila **FIFO**, máscara de bits para "worker ocupado", `postMessage(msg,
transfer)` que devolve uma promessa resolvida na primeira resposta daquele worker; sem
prioridade, sem cancelamento, sem chave. Usado pelo `KTX2Loader` (`KTX2Loader.js:157,
196–198, 332, 497, 514`), que cria **o seu próprio** `WorkerPool` e aceita `setWorkerLimit`:
na fase 6 isso é mais um pool de 4 que precisa entrar no pool único (o campo
`workerPool` é público; um adaptador com `postMessage`, `setWorkerCreator`,
`setWorkerLimit` e `dispose` o substitui).

**Piscina (pool de workers do Node)** — https://raw.githubusercontent.com/piscinajs/piscina/current/README.md
(extração dirigida). `minThreads/maxThreads`, `idleTimeout`, `concurrentTasksPerWorker`
(padrão 1); `taskQueue` customizada (interface `size`, `shift()`, `remove(task)`,
`push(task)`) — **prioridade só por fila própria**, o README não traz API de prioridade;
cancelamento por `AbortSignal` em `run()`: **"se a tarefa já está executando, a thread do
`Worker` será parada"** (a thread é perdida; tarefas canceláveis nunca dividem thread);
`maxQueue` (padrão sem limite; `'auto'` = quadrado de `maxThreads`) com eventos `drain`/
`needsDrain` para contrapressão; `transferList` e `Piscina.move(valor)` para devolver por
transferência; estatísticas `runTime`/`waitTime` com percentis e `utilization`;
`niceIncrement` baixa a prioridade do SO dos workers (pacote nativo opcional).

**Unity, Job System** — https://docs.unity3d.com/Manual/job-system-overview.html e
`job-system-jobs.html` (extração dirigida). O número de threads de trabalho depende dos
núcleos (a página **não** dá a fórmula "núcleos − 1"); cada thread tem a sua fila e, ao
terminar, **rouba** tarefas das outras ("evens out task distribution because some workers
run faster than others"); o sistema de segurança manda a cada job **uma cópia** dos dados
em vez de uma referência (sem corrida); "só a thread principal pode agendar e completar
jobs"; tipos `IJob`, `IJobParallelFor` (índice exclusivo por trabalhador), com cadeias de
dependência. Nem tamanho de lote nem a diferença `Schedule`/`Run`/`Complete` aparecem nessas
páginas.

**Factorio, FFF #421** — a fase 1 já descreveu: a rede elétrica paralela foi descartada
(0,5 → 0,39 ms, CPU de 0,5% a 15%, sem ganho no jogo porque o gargalo era memória) e
só os combinators só-leitura deram 9,5% (14,9× no teste sintético). Mensagem para o pool:
**medir o CPU total gasto**, não só o tempo do quadro.

### 2.2 Mensagens, transferência e tamanho do pool

**MDN, "Using Web Workers"** —
https://developer.mozilla.org/en-US/docs/Web/API/Web_Workers_API/Using_web_workers :
dados entre página e worker são **copiados, não compartilhados** (clone estruturado);
objetos transferíveis vão com cópia zero (o original é "limpo" e deixa de ser usável);
`terminate()` mata o worker "imediatamente"; `new Worker(new URL('worker.js',
import.meta.url))` é o que Webpack, Vite e Parcel pedem; a página **não** trata de custo de
criação, nem de limite de workers, nem de pool, e diz que o `Worker` cria "threads reais
do sistema operacional".
**MDN, "Transferable objects"** —
https://developer.mozilla.org/en-US/docs/Web/API/Web_Workers_API/Transferable_objects :
após a transferência o objeto fica **desanexado** (`byteLength` 0; ler ou escrever
lança); `TypedArray` **não** é transferível, o `ArrayBuffer` por baixo é (passar o
`TypedArray` na lista lança); `structuredClone(valor, { transfer })` faz o mesmo; os
tipos transferíveis incluem `ArrayBuffer`, `ImageBitmap`, `OffscreenCanvas`, `MessagePort`,
`ReadableStream`, `VideoFrame`…; a página não traz tempo de transferência (cita o artigo
"Transferable Objects: Lightning Fast!", que não li).
**Surma, "Is postMessage slow?"** — https://surma.dev/things/is-postmessage-slow/ :
microbenchmarks de worker para a thread principal (profundidade e largura de 1 a 6,
1 000 objetos por combinação, p95; MacBook Pro 2018, Pixel 3 XL, Nokia 2); o tempo
acompanha o tamanho do JSON equivalente, **só importa acima de ~100 KiB**; **até 10 KiB cabe
no orçamento de quadro de 16 ms** e até 100 KiB cabe nos 100 ms de resposta nos aparelhos
mais lentos; Chrome e Safari **adiam a desserialização até `.data` ser lido**, o Firefox a
faz antes de despachar; `JSON.stringify/parse` à mão não ganha do clone; a transferência de
`ArrayBuffer` "extremamente rápida e independente do tamanho" (sem números); o artigo só tem
gráficos para o resto; recomenda enviar **remendos** em vez de estado inteiro, em lotes
pequenos, e binário transferível.
**MDN, `navigator.hardwareConcurrency`** —
https://developer.mozilla.org/en-US/docs/Web/API/Navigator/hardwareConcurrency : é "um número
entre 1 e o número de processadores lógicos potencialmente disponíveis ao agente de
usuário"; o navegador "pode relatar um número menor"; **não é a garantia de threads
livres**; o exemplo da página cria um worker por processador lógico; a página não fala de
outras abas/processos competindo nem de limites de privacidade. Neste PC são 24.
**Nenhuma fonte lida dá o custo de memória nem o de partida de um worker no Chrome**
(a busca só achou números de contêineres/isolates de servidor da Cloudflare e uma
discussão de 2009 que não vale para o Chrome de hoje); o único dado local é o comentário
de `terrainLightPool.ts:3–11`: 864 workers, "cada um com o seu heap, todos assando de uma
vez na abertura — a máquina toda tomada, e gigabytes de memória".

### 2.3 Agendar a fatia da thread principal

**MDN, "Prioritized Task Scheduling API"** —
https://developer.mozilla.org/en-US/docs/Web/API/Prioritized_Task_Scheduling_API :
`scheduler.postTask(cb, { priority, signal, delay })`; prioridades `user-blocking`,
`user-visible` (padrão) e `background`, "muito granulares"; a prioridade é **imutável** se
`options.priority` for dado e **mutável** só com um `TaskSignal` sem `priority`
(`TaskController.setPriority`, evento `prioritychange`); `TaskController.abort()` rejeita a
promessa com `AbortError` (também serve `AbortController`); "as tarefas rodam em ordem de
prioridade e depois na ordem em que foram adicionadas"; disponível em janelas e workers.
**WICG, "Prioritized Task Scheduling"** (rascunho) — https://wicg.github.io/scheduling-apis/ :
as tarefas rodam "em ordem estrita de prioridade" dentro de um `Scheduler`; **a escolha
entre tarefas do escalonador e as demais do laço de eventos é "definida pela
implementação"** — o texto sugere que prioridade ≥ 3 poderia rodar "com prioridade elevada",
abaixo de entrada e renderização, e diz que `user-blocking` não é "necessariamente
bloqueante da renderização"; a fila por (prioridade, continuação); "continuações têm
prioridade efetiva maior que tarefas da mesma `TaskPriority`"; a prioridade dinâmica muda a
prioridade da fila, sem mover tarefas; **abortar uma tarefa na fila a remove da fila**; o
texto não trata de fome de tarefas `background` (só sugere ciclar tarefas de menor prioridade
por mitigação de canal lateral).
**MDN, `scheduler.yield()`** — https://developer.mozilla.org/en-US/docs/Web/API/Scheduler/yield :
a continuação é uma tarefa **priorizada** (entra na frente da fila do seu nível; não passa
de prioridade maior); herda a prioridade e o sinal de aborto do `postTask` que a contém
("abortar a tarefa também aborta os yields pendentes"); disponível em workers; a página
marca "disponibilidade limitada" (não Baseline).
**web.dev, "Optimize long tasks"** — https://web.dev/articles/optimize-long-tasks : tarefa
longa é > 50 ms; `scheduler.yield()` em Chrome 129, Edge 129 e Firefox 142 (Safari não);
**yield a cada iteração custa: agrupar os jobs e ceder só quando passou um prazo** (padrão:
`if (performance.now() − lastYield > 50) await yieldToMain()`); `isInputPending` (Chrome e
Edge 87) é **desencorajado**: "pode devolver falso mesmo havendo interação", e entrada não é a
única razão para ceder (animações e atualizações de interface também); recomendação: ceder
independentemente de haver entrada pendente. **MDN, `isInputPending`** — marcada
**Deprecated/Experimental** ("evite em projetos novos"), recomenda `scheduler.yield()`.
**web.dev, INP** — https://web.dev/articles/inp : INP = atraso de entrada + duração do
processamento + atraso de apresentação; bom ≤ 200 ms, ruim > 500 ms (p75 de cargas de
campo); tarefas longas são causa comum do atraso de entrada.
**MDN, `requestIdleCallback`** e **W3C, "Cooperative Scheduling of Background Tasks"** —
https://w3c.github.io/requestidlecallback/ : o **período ocioso** é o tempo entre agora e o
prazo, e começa quando o laço de eventos fica ocioso **depois de um quadro ter sido
processado, renderizado e composto**; é encerrado no prazo ou antes se chega trabalho
prioritário; "em 60 Hz os períodos ocioso são típicamente muito curtos (menos de 16 ms)";
o teto de **50 ms** vale quando nada mais próximo limita; só callbacks postos **antes** do
período começar rodam nele; `timeRemaining()` = prazo − agora (negativo vira 0) e é
**grosseiro de propósito**; o `timeout` do MDN faz a tarefa ser enfileirada "mesmo que
arrisque desempenho". O MDN lido **não** menciona o teto de 50 ms nem o suporte do Safari.
É o único mecanismo padrão que expõe "o que sobra do quadro" ao código.

### 2.4 Código deste repositório lido

`src/core/frameWork.ts` (cota de quadro), `src/frameLoop.ts:113–183` (`TopologyCatchUp`),
`src/render/renderer.ts:1008–1045` (`WORLD_SLICE_MS`, `pumpWorld`), `src/render/uploads.ts`,
`src/render/bakePool.ts`, `terrainLightPool.ts`, `ecologyPool.ts`, `flatGroundPool.ts`,
`surfaceBakeClient.ts`, `people/lodPool.ts`, `people/garmentPaddingPool.ts`,
`destruction.ts:95–140`, `terrain.ts:3495–3530`, `src/main.ts:3060–3166`.

---

## 3. O que se aplica a este código

### 3.1 O que existe hoje (inventário de workers)

| Cliente | Arquivo | Workers | Ordem e cancelamento | Estado no worker |
|---|---|---|---|---|
| Assar corpos/clipes de pessoas | `render/bakePool.ts:15,48` | até `min(6, hw − 1)`, cresce com a demanda, termina ao esvaziar (`releaseIdleBakeWorkers`, `:114–118`) | fila FIFO, sem prioridade; erro ⇒ `resolve(null)` e o chamador assa na thread principal | bibliotecas de movimento decodificadas (por isso termina ao esvaziar) |
| Fratura de prédios | `render/destruction.ts:105–107` | até `min(4, hw − 1)`, **rodízio** (`nextWorker++ % n`) | sem fila nem prioridade; resultado entra em `onmessage` e já monta a geometria (`place`, `:127–150`) | nenhum |
| Luz do terreno (planeta) | `render/terrainLightPool.ts:19,44` | 2 fixos | **cada placa vai sempre ao mesmo worker** (afinidade por chave), mais próxima da vista primeiro (`rank`, `:62–68`) | a forma do chão da placa, guardada entre pedidos |
| Luz do terreno (plano) | `render/terrain.ts:3508` | **1 por placa** (`plate < 0`) | 1 em voo (`lightBusy`) | a grade de luz (`postMessage({ grid })`) |
| Ecologia | `render/ecologyPool.ts:35–50,89` | 1 | **substitui o job enfileirado da mesma chave** (`:92–95`), mais próxima primeiro; o job em execução termina e seu resultado é usado | nenhum |
| Terreno do plano (chão) | `render/flatGroundPool.ts:44–60` | 2 faixas | mais próxima primeiro; `cancel` tira da fila | nenhum |
| Superfícies de textura | `render/surfaceBakeClient.ts:23` | 1, na abertura | único | cache em IndexedDB |
| LOD (simplificação) | `render/people/lodPool.ts:18` | 1 | promessas por id, sem prioridade | nenhum |
| Enchimento de roupas | `render/people/garmentPaddingPool.ts:69` | 1; termina após 30 s ocioso (`:46–52`) | por id | nenhum |

Soma dos tetos: 6 + 4 + 2 + (1 por placa plana) + 1 + 2 + 1 + 1 + 1 ≥ 18 mais o
`KTX2Loader` (4, fase 6) e o worker de simulação (fase 4). Padrões reaproveitáveis já
estão lá: **afinidade por chave** (`terrainLightPool`), **substituição por chave**
(`ecologyPool`), **mais próxima primeiro** (os três de terreno), **queda graciosa para a
thread principal** (cada pool tem `failed()`/`resolve(null)`). O que **não** existe em
nenhum: cancelamento de job em execução, orçamento comum, prioridade que acompanhe a
vista **depois** de enfileirar (a pontuação `rank` só é lida quando um worker fica livre,
com `focus` do momento — isso já é a ideia de `priorityFunction` do Cesium, só que
repetida em cada pool), e contrapressão.

### 3.2 Um pool só: forma proposta

Do Cesium, Piscina e three, e do que o projeto já faz bem:

- **Fila única, com prioridade como função** (`RequestScheduler`): cada job traz uma
  `urgency()` lida quando um worker fica livre (e opcionalmente a cada quadro para descartar
  o que saiu da vista), em vez de um número fixo. As três faixas do relatório
  (0 edição em curso, 1 streaming perto da vista, 2 fundo) são o primeiro corte da
  função: faixa × distância (o `rank` atual do terreno é `1 − centro·foco`, de 0 a 2,
  `terrainLightPool.ts:62–68`).
- **Chave**: um job com a mesma `key` **substitui** o pendente (`ecologyPool.ts:92–95`),
  como o relatório pede.
- **Fila limitada com descarte do menos urgente** (`priorityHeapLength = 20` do Cesium,
  `maxQueue` da Piscina) e **contrapressão** explícita: `submit` devolve `undefined`/`false`
  quando a fila enche, para o produtor tentar no quadro seguinte — o desenho do Cesium
  (`scheduleTask` → `undefined`). Isso substitui a rajada das 864 placas pedindo luz na
  abertura.
- **Afinidade opcional por chave** para jobs *com estado* (luz do terreno guarda a forma do
  chão no worker): preferir o worker da chave, e só um worker **ocioso** pode "roubar"
  (Unity: roubo de trabalho) jobs **sem estado**. Sem isso, trocar três pools por um
  perde o ganho de não reenviar a malha a cada pedido.
- **Tamanho**: o relatório sugere `max(2, min(6, hw − 4))` (4.9). A MDN define
  `hardwareConcurrency` como "potencialmente disponíveis" e não como livres; o relatório 2.7
  lembra que o Chrome precisa de núcleos para o processo da GPU, o compositor e a thread
  principal; a Factorio mostrou que **mais threads piora** quando o limite é memória. O
  tamanho certo não está em nenhuma fonte; **sai de uma curva** (medir jobs/s e CPU total
  para 2, 4, 6, 8 e 10 workers com o trabalho real de assar corpos, que é o mais pesado), no
  processador com 8 P + 8 E e Windows 10 (sem Thread Director, F68).
- **Um script de worker, vários núcleos de cálculo** (kernels): o `new Worker(new
  URL(...), { type: 'module' })` do projeto (`bakePool.ts:48`, etc.) é o padrão que a MDN
  nomeia para bundlers; hoje há 9 scripts diferentes. Para um pool de workers
  intercambiáveis, o script de entrada despacha por `kind` e carrega o núcleo sob demanda
  (importação dinâmica em worker de módulo — **não verifiquei na documentação**; é o que
  evita que cada worker pague o código de todos os kernels). A alternativa, um pool por
  família de scripts (cálculo de terreno, de pessoas, de prédios), é mais simples de
  migrar e mantém o ganho de aquecimento; decidir pela curva acima.
- **Worker da simulação fora do pool** (fase 4): uma thread dedicada de longa duração, como
  o `sim` precisa de latência previsível, e não disputa a fila.

### 3.3 Cancelamento

- **Na fila**: remover (o mesmo que o abortar de `postTask` faz na fila, WICG) — trivial.
- **Em execução**: nas fontes lidas o único mecanismo geral é **matar a thread** (Piscina:
  "a thread do Worker será parada") — no navegador, `terminate()` (MDN: "o worker é morto
  imediatamente"), o que joga fora o aquecimento (decodificação de movimentos, forma do
  chão) e custa recriar o worker. Alternativa **cooperativa**: o núcleo de cálculo é escrito
  em fatias, e entre fatias cede ao laço de eventos do worker (`await scheduler.yield()`,
  disponível em workers segundo a MDN, ou `MessageChannel`), onde processa a mensagem
  `cancel(key)` e verifica uma "geração" da chave; o resultado de uma geração velha é
  descartado na chegada de qualquer forma (um contador por chave na thread principal).
  Para núcleos curtos (< 10 ms) não vale cancelar. Um `SharedArrayBuffer` com uma
  bandeira de `Atomics` permitiria cancelar sem ceder, mas exige a fase 8 (isolamento
  entre origens).
- **Queda**: o contrato atual (cada pool tem um `failed()`/`resolve(null)` que faz o chamador
  refazer na thread principal) precisa ser mantido; o `Cesium` não faz nada disso (as
  promessas pendentes nunca resolvem).

### 3.4 Derivados de célula em workers: o que viaja

Os derivados da fase 2 (faixas, conflitos, calçadas, superfícies, cenário, prédios) hoje
são funções de `RoadDoc` e `Network` (`Map`s de objetos de classe, `world.ts`,
`lanelets.ts`), que **não são transferíveis nem baratos de clonar**. Surma: até 10 KiB cabem
num quadro de 16 ms; uma célula de ~250 m de cidade gerada tem centenas de KB (12,7 MB por
~30 células, conta da fase 2, estimativa). Três formas, em ordem de custo de migração:

1. **Sem estado, serializada**: o texto JSON por célula (e halo) que o **autosave** da fase 2
   já produz é o corpo da mensagem (uma `string` é copiada por `memcpy`, sem percorrer um
   grafo de objetos); o worker faz `fromJSON` da célula e do halo, roda a camada e devolve
   **buffers tipados transferidos**. O custo na thread principal passa a ser o
   `JSON.stringify` da célula suja (que o autosave paga de qualquer jeito, uma vez) e a
   aplicação do resultado. Cabe em núcleos puros: superfícies (`surfaceBake.worker.ts` já
   faz isso para texturas), luz, HLOD.
2. **Com réplica**: um worker dono de uma cópia do documento atualizada por comandos (o
   desenho da simulação em worker, 4.6); serve às camadas que dependem de muitas células.
   Memória ×(número de réplicas); por isso uma réplica só, no worker da simulação ou num
   "worker do mundo".
3. **Compartilhado** (`SharedArrayBuffer`): só depois da fase 8.

Regras gerais tiradas das fontes: o que entra e sai viaja em `ArrayBuffer` transferido
(**a lista de transferência deve receber o `.buffer`, não o `TypedArray`**; todas as vistas
sobre o buffer ficam inutilizadas — MDN); só a thread principal agenda e completa
(Unity), e o resultado é aplicado **numa ordem determinística por chave** ou tolerando a
reordenação; a troca final no quadro seguinte (o padrão que o jogo já usa, relatório 6.3).

### 3.5 A fatia do quadro: o que sobra

**O que existe.** `FRAME_WORK_MS = 10` (`frameWork.ts:10`) é a cota por quadro de **todo o
trabalho espalhado**; o primeiro job do quadro abre a cota (`workUntil`, `:23`) e os outros
só trabalham até ela fechar. A ordem em `frame()` (`main.ts:3060–3166`): topologia da
simulação (`TOPOLOGY_SLICE_MS = 6`, `frameLoop.ts:113`) → passos da simulação → rede →
prédios (`WARM_SLICE_MS = 6`, `layer.ts:563`) → `scene.draw`, que inclui o `pumpWorld`
(`renderer.ts:1033`) com `WORLD_SLICE_MS = 28` (`renderer.ts:1017`). A cota **não conta**
a simulação (3–5 ms) nem o desenho (8–10 ms de CPU no portão); e como o `pumpWorld` abre a
cota com 28 ms quando é o primeiro (sem topologia pendente), um quadro de reconstrução do
mundo pode custar ≈ 28 + 4 + 9 ≈ 40 ms (conta minha, dos números do código e do
`perfBudget.ts`) — ou seja, dois vsyncs perdidos por quadro durante toda a edição de uma
via (`road-edit/world rebuilt`: até 2,5 s no orçamento, `perfBudget.ts:41`). O `pumpWorld`
já estima o custo do próximo passo pelo **máximo dos últimos 8** (`stepCosts`,
`renderer.ts:1025–1045`) e só começa um passo que caiba — a regra certa de fatia
cooperativa.

**Opções para "o que sobra".**
- *Medida própria* (a do relatório, `min(8, max(1, alvo − sim − desenho − 2))`): usa o que o
  jogo mede (`FrameTimer`, `core/health.ts:182`). Sem dependência de API, funciona no
  painel do app e no navegador.
- *`requestIdleCallback`*: é o único mecanismo padrão que dá o "o que resta do quadro"
  (`timeRemaining()`), e o W3C diz que em página animada há períodos entre os quadros,
  típicamente curtos. **Não verifiquei** como o Chrome os produz sob carga contínua (a
  especificação deixa "o agente de usuário decide o que é ocioso"); medir a distribuição de
  `timeRemaining()` na cena do portão antes de confiar. A resolução é grosseira de propósito.
- *`scheduler.postTask({ priority: 'background' })`*: rodar fatias **fora do callback do
  `requestAnimationFrame`**, nos intervalos entre quadros. Pelo WICG, a ordem entre tarefas
  do escalonador e o resto (renderização incluída) é definida pela implementação, e
  `user-blocking` "não é necessariamente bloqueante da renderização": nenhuma fonte garante
  que a fatia caiba antes do próximo vsync, então ela precisa **medir o seu prazo** (hora do
  próximo quadro estimada pelo carimbo do rAF + período) e ceder (`scheduler.yield()`, que
  herda a prioridade e o sinal de aborto).
- *`isInputPending`*: **não usar** (MDN: "evite em projetos novos"; web.dev: pode devolver
  falso e entrada não é a única razão para ceder). Em um jogo cujo laço é o `rAF`, a entrada
  é tratada entre quadros; a coisa a proteger é o prazo do quadro, não a entrada.
- *`scheduler.yield()` no meio de fatias longas*: só onde houver `async` e fora do `rAF`
  (a tarefa do `rAF` não pode ser dividida sem perder o quadro). web.dev: ceder a cada
  iteração é caro; ceder só passado um prazo.

**Troca que as fontes não resolvem.** Reduzir a fatia de 28 ms para os ~2–3 ms que sobram
alonga a reconstrução (de 0,3–1,6 s para alguns segundos, conta minha de proporção) em vez
de encurtá-la: a única saída que mantém o quadro em dia **e** a rapidez é tirar o trabalho
da thread principal (3.4), ou dividi-lo em células cada vez menores (fase 2). Pior: com a
cota variável, o orçamento de 4 ms de simulação a 4× (P70) tem de ser contado **dentro** do
alvo, não ao lado dele.

### 3.6 Entrega dos resultados: caixa de entrada com orçamento

Hoje o `onmessage` de cada pool já **constrói e coloca** o resultado: `destruction.ts:111–128`
(`place`, `strike`, `onRuined`), `ecologyPool.ts:38–47` (`job.done`), `terrainLightPool.ts:
47–52`. Várias mensagens chegando juntas viram várias tarefas seguidas, cada uma com sua
construção de geometria e (no primeiro desenho) seu envio à GPU: é a origem do PA-U2
("quadros de 1–1,5 s"; `uploads.ts:141–151` já limita o envio por quadro a 6 ms de malhas
soltas). O padrão: o `onmessage` só **empilha** o resultado (barato: o Chrome adia a
desserialização até `.data` — Surma), e uma **caixa de entrada** esvaziada **dentro da cota
do quadro** (`workUntil`) aplica até acabar o prazo, na ordem da urgência; o envio à GPU é
medido em **bytes**, não em unidades (a fila de `uploads.ts` conta texturas, `drainUploads`
`count`; as malhas, tempo, `WARM_SLICE_MS`): um prédio da fratura são MB.

---

## 4. Riscos e o que medir

1. **CPU total** (Factorio): somar o tempo de CPU de todos os workers + principal por
   cenário e comparar antes/depois; o ganho de tempo de quadro não pode custar mais CPU do
   que economiza (aceite do relatório, 5.4).
2. **Tamanho do pool**: curva de jobs/s × workers (2…10) com o trabalho real; cuidado com
   núcleos E (F68, Windows 10); medir a memória por worker (heap de cada worker, por
   instantâneo; **nenhuma fonte lida dá o número**); uma `performance.measureUserAgentSpecificMemory`
   só existe com isolamento (fase 8).
3. **Latência de edição**: p99 do intervalo entre quadros durante 20 edições seguidas
   (cenário G da fase 0), tempo da via clicada até o mundo refeito, maior quadro depois.
4. **Cancelamento cooperativo**: a granularidade das fatias dentro do worker; sem ceder, o
   `cancel` só chega ao fim do job. Medir `cancel → worker livre`.
5. **Tamanho das mensagens**: bytes por mensagem e por quadro de **entrada** e **saída**,
   desserialização (primeira leitura de `.data`) e tempo da aplicação do resultado,
   separadamente (Surma só tem gráficos).
6. **Afinidade × roubo**: com 6 workers e jobs com estado, a taxa de acertos de afinidade e o
   tempo ocioso; jobs sem estado que esperam mesmo havendo worker livre.
7. **Quedas silenciosas**: cada pool atual faz fallback para a thread principal em erro; o
   pool único deve manter, e **contar** quantos jobs caíram (o `HealthLog` tem `worker`,
   `ui/healthWatch.ts`).
8. **Ordem e determinismo**: resultados aplicados em ordem diferente da dos pedidos; manter a
   regra "um escritor por campo" e a troca no quadro seguinte.
9. **`requestIdleCallback`**: se `timeRemaining()` sob carga contínua é útil (histograma na
   cena do portão); o Safari não suporta (o app usa Chromium; o jogo roda em navegador comum
   também).
10. **Vite**: um script de entrada para vários núcleos muda o grafo de worker do build
    (`new URL(..., import.meta.url)` já usado); conferir o build e o tamanho do worker.

**Aceite medido:** p99 do intervalo ≤ 25 ms (meta de partida do relatório) nos 20
cliques; nenhum quadro > 100 ms; CPU total ≤ antes; número de workers vivos ≤ pool + 1
(simulação); jobs de placa fora da vista cancelados antes de rodar.

---

## 5. O que NÃO foi possível ler (ou só em resumo)

- **Cesium**: lido por extração dirigida (`TaskProcessor.js`, `RequestScheduler.js`), não o
  arquivo cru; a classe `Request` e o `Heap` não foram lidos, a ordem de saída do heap é
  inferida do comparador.
- **Piscina**: README lido por extração; o código (`FixedQueue`, `loadBalancer`) não.
- **Unity**: as duas páginas lidas não trazem fórmula de threads de trabalho, tamanho de
  lote, nem `Schedule/Run/Complete`.
- **Custo de memória e de partida de um worker no Chrome**: nenhuma fonte; busca só
  achou material de servidor e uma discussão de 2009. **"Transferable Objects: Lightning
  Fast!"** (a fonte dos tempos de transferência) e o código-fonte de `Worker` do Chromium
  não foram lidos.
- **MDN `requestIdleCallback`**: a página lida não traz o teto de 50 ms nem Safari;
  o W3C traz. O comportamento real do Chrome em página com `rAF` contínuo é lacuna.
- **WICG scheduling-apis**: extração dirigida; as tabelas de prioridade efetiva e a seção
  de integração com o laço de eventos não foram lidas por inteiro.
- **MDN `scheduler.yield` e `postTask`**: a tabela de compatibilidade não veio na extração;
  as versões (Chrome 129, Firefox 142) vêm do web.dev.
- **Importação dinâmica em worker de módulo** e o comportamento de `new Worker(new URL(...))`
  empacotado pelo Vite 8 para vários núcleos: não li a documentação do Vite nem da
  especificação HTML.
