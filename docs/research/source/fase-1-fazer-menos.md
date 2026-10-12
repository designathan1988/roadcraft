# Pesquisa da fase 1 — "fazer menos" na simulação

Pesquisa de 2026-10-11, só leitura de código. Ramo `agente/pesquisa`, a partir de
`planeta-esfera` `27a7cb48`; todo `arquivo:linha` é desse commit. Complementa as
seções 5.1 e 4.8 do `docs/relatorio-desempenho-mapas-enormes-2026-10-11.md` (fontes
F4–F7, F48, F49) e o bloco B do `PROMPT-PENDENCIAS.md` (aceite: na sonda B2,
estágios 1 e 7 iguais em 6×6 e 36×36; passo da 36×36 ≤ 1,3× o da 6×6; fecha o P70).

**Como as fontes foram lidas.** Páginas: WebFetch (a página convertida em texto e
respondida por um modelo pequeno a um pedido meu; não é o byte bruto). Código do
SUMO, do ANGLE e do V8: arquivos `raw.githubusercontent.com` passados pela mesma
ferramenta, com perguntas dirigidas; onde a resposta disse "o trecho não mostra",
ficou como lacuna. PDFs: baixados pela ferramenta e lidos como texto com
`pdftotext`. Código deste repositório: lido por mim com Read. Nada foi rodado.

---

## 1. Perguntas que a fase 1 precisa responder

1. Quais partes do passo da simulação percorrem o mapa inteiro e podem passar a
   percorrer só o que mudou ou só o que está ativo (semáforos, limpeza de faixas,
   entradas de tráfego, comprimento da rede, ordem dos cruzamentos, dependências
   do sinal, `busNear`)?
2. Um controlador de semáforo pode "dormir até o próximo evento" **sem mudar o
   resultado** (mesmos `stageIndex`, `sub`, `elapsed` a cada tick)? Quais eventos
   o acordam, e o que o SUMO e as engines de física/jogos fazem de equivalente?
3. Que cache por revisão é seguro para cada derivado, e que chave o invalida?
4. O que as fontes dizem sobre o custo de `Map<string,…>` e de chaves de texto
   montadas por chamada no V8, e onde isso morde neste código?
5. Basta corrigir os estágios 1 e 7 para cumprir "passo da 36×36 ≤ 1,3× o da
   6×6"? (Resposta curta da conta de 3.1: **não**.)
6. Como provar que o caminho novo é igual ao antigo (oráculo "dormindo = passo a
   passo") e como medir o ganho?

---

## 2. Fontes lidas

### 2.1 Dormir até o próximo evento

**SUMO, controle por eventos de semáforos** —
`src/microsim/traffic_lights/MSTrafficLightLogic.cpp` (ramo `main`, via
https://raw.githubusercontent.com/eclipse-sumo/sumo/main/src/microsim/traffic_lights/MSTrafficLightLogic.cpp).
O construtor registra um `SwitchCommand` no controle de eventos de começo de passo
(`getBeginOfTimestepEvents()->addEvent(cmd, delay)`); `SwitchCommand::execute(t)`
chama `trySwitch()`, que **devolve o tempo relativo até a próxima chamada**; se
devolve 0 chama de novo (fase de duração zero é pulada); o comando guarda o próximo
instante absoluto. Ou seja: o semáforo do SUMO não é avaliado em todo passo; ele
diz quando quer ser chamado de novo. (Como o laço de eventos consome o valor
devolvido não aparece no trecho; é a suposição natural.)

**SUMO, lógica atuada** — `MSActuatedTrafficLightLogic.cpp` (mesmo ramo; lido por
extração). `trySwitch()` mede `actDuration = now − myPhases[myStep]->myLastSwitch`
(**diferença de carimbos**, não soma de passos), chama `gapControl()` (menor tempo
desde a última detecção entre os laços relevantes, dentro de `max-gap` e não
engarrafados; devolve "máximo" quando a fase deve acabar: fase que não é verde,
`maxDur` atingido, etc.), e devolve: com fase abaixo do `minDur`, o **tempo que falta
até `minDur`**; segurando a fase por lacuna, `max(minDur − act, detector-gap −
lacuna, 1)` arredondado a segundos e limitado por `maxDur − act`; ao trocar,
`max(minRetry, minDur − act, earliest)`, com `minRetry = 1 s` se não trocou. Não há
trava contra duas chamadas no mesmo passo (`myLastTrySwitchTime` é um carimbo, não
uma trava). Fases de transição (amarelo/vermelho total) não têm lógica própria:
`gapControl` devolve "máximo" e o controlador avança.

**SUMO, documentação dos semáforos atuados** —
https://sumo.dlr.de/docs/Simulation/Traffic_Lights.html . `type="actuated"` com
`minDur`/`maxDur` por fase; laços de indução postos a `detector-gap` segundos antes
da linha; `max-gap` (maior lacuna que ainda prolonga a fase), `passing-time`,
`jam-threshold`; `earliestEnd`/`latestEnd` para coordenação. A página não diz com
que frequência a lógica é avaliada.

**Factorio, FFF #148** — https://factorio.com/blog/post/fff-148 : "a maioria das
entidades vai dormir quando não tem nada a fazer — consumindo zero de processamento
dormindo"; belts e pipes, os mais caros, só são atualizados um a um; a proposta é
trocar por segmentos contíguos e mover um segmento mudando um deslocamento. **O
artigo não dá tempos por tick, nem estruturas de lista ativa, nem condições de
despertar** (o que o relatório 2.1 atribui a ele em medidas vem do #421).

**Factorio, FFF #421** — https://factorio.com/blog/post/fff-421 : roboports ociosos
desligados (de 1 ms para 0,025 ms por tick no save de teste), acordados quando um
robô precisa carregar ou estacionar ou em outro caso raro (o artigo não detalha a
condição exata); radares e roboports num registro de "mantém revelado" por chunk
com contador; robôs guardam uma **intenção de movimento** e o desenho interpola
por ela, enquanto a atualização real acontece no instante de chegada, com limite de
no máximo 20 ticks se se move e 60 se parado (ganho de ~15% no save de escritório,
10–25% nos de muitos robôs); a rede elétrica paralela foi **descartada** (0,5 → 0,39 ms,
CPU de 0,5% para 15%, sem ganho no jogo) porque o gargalo era memória. Os combinators
multi-thread deram 9,5% no save e 14,9× no teste sintético, mas só onde os dados
são só-leitura e independentes.

**Factorio, fórum (Rseding91, 2023-07-17)** — https://forums.factorio.com/viewtopic.php?p=587846 :
"chunks ativos têm o custo das entidades que precisam ser atualizadas"; fantasmas,
vigas e cadáveres atualizam a cada ~150 ticks; as demais entidades "atualizam
globalmente quando preciso". A discussão sobre "dormir = sair do laço de
atualização até um evento externo ligar de novo" que a busca achou está em
Reddit/fórum que **não abri**; não a uso como fonte.

**Box2D** — https://box2d.org/documentation/md_simulation.html (lido até o caractere
100 000 de 139 164): corpo em repouso entra em sono "com muito pouco custo de CPU";
desperta por contato com um corpo acordado, destruição de junta/contato, `SetAwake`,
ou força/impulso com a bandeira de acordar (sem a bandeira, o impulso num corpo
dormindo é **ignorado**); `enableSleep` por corpo ou por mundo; o evento
`fellAsleep` existe para a aplicação otimizar. **PhysX** —
https://nvidia-omniverse.github.io/PhysX/physx/5.1.3/docs/RigidBodyDynamics.html :
dorme quando a energia cinética fica abaixo do limiar o bastante para o
`wakeCounter` chegar a zero (histerese: "contador zero não significa que o ator
tenha de estar dormindo"); acorda por força, velocidade, pose, toque num ator
acordado, perda de contato com um estático ou removendo um ator em contato; um
ator dormindo tem velocidades zero e nenhuma atualização de força pendente. As
duas dão a mesma regra: **dormir é permitido em repouso, e todo caminho que
altera a entrada precisa acordar**.

**Nystrom, "Dirty Flag"** — https://gameprogrammingpatterns.com/dirty-flag.html :
um dado derivado caro é recalculado só quando pedido e sujo; condições de uso (cálculo
caro; dado primário muda mais do que o derivado é lido; atualização incremental
difícil); riscos: limpar tarde demais atrasa de uma vez, a bandeira precisa ser
marcada em **todo** ponto de escrita ("invalidar é a parte difícil": passar toda
escrita por uma interface estreita), o derivado fica na memória; granularidade
fina custa memória e metadados, grossa reprocessa o que não mudou. Cita que
motores de física usam "está se movendo" como bandeira suja. É o padrão que o
projeto já usa com `revision` (`CLAUDE.md`, "Architecture").

**Unreal, "Actor Ticking"** — https://dev.epicgames.com/documentation/en-us/unreal-engine/actor-ticking-in-unreal-engine :
`SetActorTickEnabled`/`SetComponentTickEnabled` ligam e desligam o tick, grupos
de tick e pré-requisitos; a página **não** documenta intervalo mínimo de tick nem
orientação de desligar quando ocioso.

**Não lido:** o artigo de rodas de temporizador (Varghese & Lauck, SOSP 1987): o
PDF baixado é digitalização sem texto extraível. Para o projeto é secundário (os
eventos de semáforo são dezenas por segundo).

### 2.2 Custo de `Map<string>` e de chaves de texto no V8

**V8, `src/objects/name.h`** (ramo `main`; extração) — cada `Name` (string ou
símbolo) guarda o hash no campo `raw_hash_field_` dentro do próprio objeto;
`HasHashCode`/`TryGetHash`/`EnsureHash` (computado sob demanda; "campo vazio" é o
estado "ainda não computado"); para strings acima de `kMaxHashCalcLength = 16383`
o comprimento serve de hash; strings que são índices de array de até 7 dígitos
guardam o índice no próprio campo. **V8, `src/objects/string.h`** — `ConsString` é
um par (primeiro, segundo) que descreve a concatenação; `kMinLength = 13` (abaixo
disso a concatenação copia); achatar copia para uma string sequencial; uma string
"internalizada" é uma entrada única da tabela de strings; a que não pode ser
internalizada no lugar vira `ThinString` apontando para a internalizada; `SlowEquals`
é o caminho lento ("mais eficiente em strings quase planas"). **V8,
`src/builtins/builtins-collections-gen.cc`** (lido inteiro por duas extrações) — o
despachante `TryLookupOrderedHashTableIndex` (usado por `Map.prototype.get/has`)
decide pelo tipo da chave: **Smi** → hash `ComputeUnseededHash` e comparação inline;
**string internalizada** → usa a chave como está; **`ThinString`** → troca pela string
embrulhada; **string não internalizada e não fina** (por exemplo, a que acabou de ser
montada por um template literal) → `CallRuntime(Runtime::kInternalizeString, …)`,
isto é, **uma chamada de runtime** para internalizar antes de procurar; o resultado
vai para `FindOrderedHashTableEntryForStringKey`, que lê o hash "assumido
calculado" e compara por **identidade**. Para inserir, o caminho de strings assume
chave internalizada (`CSA_DCHECK(IsInternalizedStringInstanceType)`). O que isso diz
sobre este código: uma chave string que **já é** a mesma string do grafo (id de faixa
guardado em `Vehicle.lanelet`, vindo de `LaneletGraph`) custa hash em cache +
comparação por ponteiro; uma chave **montada por chamada** (template literal) custa
alocação + chamada de runtime para internalizar a cada procura. O trecho não dá
nanossegundos: **o custo é qualitativo, a medir** (item 4, microbenchmark).

**V8, "Optimizing hash tables: hiding the hash code"** — https://v8.dev/blog/hash-code :
o código de hash de **objetos** usados como chave é um número aleatório guardado no
armazenamento de propriedades (ganho de ~500% no SixSpeed, 5% no ARES6 Basic, 18% no
Emberperf, V8 6.3); a página **não trata strings** como chave. **V8, "hash flooding"** —
https://v8.dev/blog/hash-flooding : a semente de hash é escolhida ao iniciar e
semeia todo hash; o post não diz onde o hash de string fica nem como é calculado.

**V8, "Elements kinds"** — https://v8.dev/blog/elements-kinds : `PACKED_SMI` →
`PACKED_DOUBLE` → `PACKED_ELEMENTS` e as variantes `HOLEY`, 21 tipos; transições só
descem e nunca voltam; `new Array(n)` já nasce com buracos; ler fora do limite
degrada o acesso de forma permanente (o artigo cita ~6× ao corrigir `<=` para `<`);
usar `TypedArray` para trabalho numérico em dados grandes. Base do conselho "arrays
tipados nos campos quentes" (relatório 5.1, solução 2).

**Nystrom, "Data Locality"** — https://gameprogrammingpatterns.com/data-locality.html :
a RAM custa "centenas de ciclos"; a CPU carrega linhas de cache de 64–128 bytes;
seguir ponteiros entre entidade e componentes perde linhas de cache; o autor mede
~50× entre um laço sobre ponteiros e um sobre arrays contíguos (o ambiente do teste
não é descrito); separar dados quentes e frios; ressalva: **só depois de medir que são
faltas de cache** (ele cita Cachegrind).

**Node.js CLI** — https://nodejs.org/api/cli.html : `--cpu-prof` grava um
`.cpuprofile` ao sair (estável em 22.4/20.16; este projeto exige Node ≥ 22, e a
máquina tem v24.20), `--cpu-prof-dir`, `--cpu-prof-name`, `--cpu-prof-interval`
(microssegundos, **padrão 1000**), `--heap-prof` (intervalo em bytes, padrão 512 KiB).
A página não diz como abrir o arquivo (o DevTools abre; isso não vem da página).

---

## 3. O que se aplica a este código

### 3.1 O que o passo faz hoje e o que cresce com o mapa

Estado do código (ramo, não do relatório; os números de linha mudaram um pouco):

| Item | Onde | O que cresce com o mapa |
|---|---|---|
| Ordem dos cruzamentos | `world.ts:337–339` `junctionNodesInOrder()` | copia as chaves de `graph.junctions` e **ordena**, chamada a cada passo em `pipeline.ts:82` (e em `snapshot.ts:44`) |
| Dependências do sinal | `world.ts:513–591` `signalDeps()` | cria a cada passo (`pipeline.ts:81`) ~12 fechamentos, e um `Map` aninhado de demanda; a cada pergunta `demandOf` navega 3 `Map`s |
| Laço dos controladores | `pipeline.ts:82–87` | por nó: `w.controllers.get(node)` e `w.graph.junctions.get(node)?.signalised`, depois `stepController`; também nós sem sinal |
| Decisão do verde | `fsm.ts:195–281` | todo tick, para cada controlador verde acima do mínimo: `competingDemand` pergunta a demanda de cada outro estágio (`:237–239`), que percorre as faixas de entrada (`world.ts:611–641`) |
| Limpeza de faixas fantasma | `pipeline.ts:196–206` `collectGhosts` | `[...w.runtime]` **copia o mapa inteiro de runtime** (um array `[id, rt]` por faixa) e o percorre, **todo passo** |
| Ordenação das faixas | `integrate.ts:170–172` | `for (const rt of w.runtime.values()) if (rt.order.length > 1) sortLane(rt)` — percorre o runtime inteiro, todo passo, no estágio 6 (**arquivo do agente de trânsito**, não da coordenadora) |
| Entradas do mapa | `spawn.ts:57–65` `entryLanes` | percorre `graph.lanelets`, chama **`w.rt(lane.id)`** (cria entrada no runtime como efeito colateral), `doc.mapEdge`, e ordena; chamada em `stepDispatch:102` a cada passo |
| Tamanho da rede | `spawn.ts:43–54` `trafficTarget` | soma `ribbon.full.length` de todas as fitas; chamada 2× em `stepDispatch` (`:99`, `:132`) e por `lotTraffic.ts:163` e `ambient.ts:519` |
| `stepDispatch` | `spawn.ts:104–105` | `new Set(entries)` e `[...entryDemand.keys()]` por passo |
| `busNear` | `world.ts:647–657` | percorre **todos** os veículos a cada pergunta; só é chamada se `settings.busPriority` (`fsm.ts:222,224,296`) |

**Conta do aceite (minha, sobre os números da B2 do relatório).** B2, 36×36: total
9,85 ms; 6×6: 3,27 ms; 1,3 × 3,27 = 4,25 ms. Corrigir só os estágios 1 e 7 tiraria
≈ 1,69 + 0,68 = 2,37 ms (cada um ficando como na 6×6): 36×36 passaria de 9,85 a ≈ 7,5
ms, razão **2,3×**. Somando o estágio 2 (+1,08 ms, a parte de `entryLanes` e
`trafficTarget`), ≈ 6,4 ms, razão **≈ 2,0×**. O que sobra, ≈ 3,95 ms, está nos estágios
3, 4, 5 e 6 (+0,61, +1,01, +0,64, +0,61 ms) e o relatório rotulou como "hipótese:
mapas e `Map` maiores, mais faltas de cache". Duas explicações possíveis, que pedem
medidas diferentes:
- **Laço escondido sobre o mapa** (como `integrate.ts:170` no estágio 6): a *contagem
  de chamadas* de alguma função cresce com o mapa. Aparece no perfil como número de
  amostras em funções que percorrem coleções.
- **Memória fria**: 400 veículos tocam as mesmas centenas de faixas na grade 6×6
  (596 lanelets) e faixas espalhadas na 36×36 (20 876); o conjunto ativo é pequeno nos
  dois, mas está espalhado em dados com ponteiros por todo o mapa — a lição de
  Data Locality e de Factorio (#421: "o gargalo era memória"). Aqui o *tempo por
  chamada* sobe com o número de chamadas constante.
Como distinguir sem adivinhar: dois `.cpuprofile` da sonda B2 (6×6 e 36×36) com
`node --cpu-prof --cpu-prof-interval=200` (o padrão de 1000 µs dá poucas amostras em
passos de 3–10 ms; é a minha escolha, não está na documentação), comparando por função
(a) amostras próprias por passo e (b) contagem de chamadas por passo (esta última por
contador de trabalho, não pelo perfil). Função com contagem constante e tempo
crescente = memória; contagem crescente = laço. **A conclusão para a coordenadora: o
critério "≤ 1,3×" não está garantido pelos itens da lista; pode exigir arrays tipados
com ids inteiros para os campos quentes de faixa (fase 4 do relatório) ou estágios 3–6
separados do mapa por região.**

### 3.2 Semáforos que dormem

**Os controladores são independentes dentro do estágio 1.** `stepController(c, deps)`
(`fsm.ts:195`) só escreve em `c` (`elapsed`, `sub`, `stageIndex`, `lastServed`,
`stageServed`); as perguntas do `SignalDeps` (`fsm.ts:61–84`) leem vehicles, runtime,
crossings e documento, nunca outro controlador (`grep controller(` mostra leitores
no estágio 3 e nos seguintes: `crossings/permission.ts:39`, `admission.ts:326…`,
`obstacles.ts:226`, `invariants.ts`, `snapshot.ts:45`, renderizador). Por isso a **ordem**
de `junctionNodesInOrder()` não afeta o resultado do estágio — **hipótese a confirmar
com o oráculo** de 3.6 — e a ordenação a cada passo (`world.ts:338`) só serve a
`hashSim` (`snapshot.ts:44`), que já ordena por conta própria se precisar.

**Três tipos de estado, três regras de sono, todas sem mudar o resultado** (leitura
de `fsm.ts:195–305`):
1. **AMBER e ALL_RED** (`:282–303`): só tempo — `elapsed >= st.amber` / `st.allRed`;
   no fim do ALL_RED roda `pickNextStage` (consulta demanda). Não há consulta antes.
2. **Verde antes do mínimo** (sem `settings.mode === 'fixed'` e sem `busPriority`):
   `mayEnd = elapsed >= st.minGreen && !pedestriansInside` (`:206–208`) e
   `if (!mayEnd && c.elapsed < st.maxGreen) break;` (`:236`) — nada muda até
   `elapsed >= minGreen`. Hoje, antes de chegar à linha 236 o código ainda chama
   `deps.pedestriansCrossing` (`:206–207`) e `deps.settings` (`:209`): leituras puras,
   dá para reordenar para depois do teste de tempo sem mudar o resultado (e guardar
   `settings` por controlador, pois só muda quando o jogador edita o nó).
3. **Verde em repouso** (após o mínimo, sem chamada de outro estágio): se *nenhum*
   outro estágio tem demanda (veículo, pedestre ou reserva) o ramo `gapOut`,
   `yieldAtTarget`, `reservedElsewhere` e o ramo de `maxGreen` (`:260–279`) são todos
   falsos e nada muda. "Quiescente(nó)" ≡ nenhuma faixa de entrada com veículo, nenhum
   pedestre esperando/atravessando nas travessias do nó, nenhuma reserva apontando
   para o nó (`reservedGroups()`, `world.ts:534–560`, depende de veículos que
   estejam em conector de **outro** nó), sem `busPriority` (que pergunta `busNear` a
   todo tick) e sem `mode: 'fixed'` (que tem seu próprio relógio).

**Como cada evento acorda (pontos de escrita únicos no código):**
- Veículo entra numa faixa de entrada do nó: `rt.order` só é escrito em
  `enterLanelet` (`world.ts:697`), `exitLanelet` (`:715`) e `sortLane` (`:719`);
  um contador "veículos nas faixas de entrada do nó" (inteiro por nó, mantido nesses
  dois pontos) transforma a pergunta "há demanda de veículo?" em O(1). É também a
  base para `signalDemand` retornar `{0,0}` sem varrer (`world.ts:611–641`).
- Pedestre: `crossingStates` é publicado no fim do estágio 3 (`world.ts:99–103`);
  `occupants.length`, `demand`, `longestWait` por travessia (`world.ts:574–583`).
  O repouso depende deles: ler 2–6 entradas de `Map` por nó, ou despertar por evento
  quando `publish` altera o estado de uma travessia do nó.
- Reserva: `reservedConnectors[0]` do veículo (escrito em `admission.ts`, outro
  agente): a varredura única por passo de `reservedGroups()` (`O(V)`) já existe como
  função preguiçosa; chamá-la **uma vez por passo** (400 veículos) alimenta o
  teste "quiescente" de todos os nós sem custo por nó.
- Mudança de plano, de topologia, de `settings` do nó (editor): `syncControllers`
  (`world.ts:664–690`) → acorda todos; `rebuildController` (`fsm.ts:418`) muda
  `stageIndex`/`elapsed`.

**Duas formas de implementar; a primeira basta para o aceite de 1 369 nós ociosos.**
- *Forma A (recomendada, sem fila de eventos):* manter o laço atual sobre uma
  **lista de cruzamentos com sinal montada por revisão** (nada de ordenar ou fazer
  `Map.get` por nó por passo), fazer `c.elapsed += DT` como hoje (**bit a bit igual**:
  `snapshot.ts:50` e `query.ts:50–54` leem `elapsed`; trocar para tick inteiro ou
  carimbo mudaria os arredondamentos) e **pular a decisão** quando `AMBER/ALL_RED`
  não chegou ao fim, quando o verde não passou do mínimo, ou quando o nó está
  quiescente. O custo por nó ocioso é um `+=`, uma comparação e um contador:
  1 369 × alguns ns ≈ 10 µs (minha estimativa; a medir) contra 1,74 ms (B2).
- *Forma B (fila de eventos, como o SUMO):* um `Heap` (`src/core/heap.ts`: item
  inteiro, chave numérica, desempate por ordem de inserção; **sem remover nem
  diminuir chave**, então acordar mais cedo é empurrar de novo e ignorar a entrada
  velha pelo `wakeAt` do controlador) com a chave "tick do próximo evento" e
  `elapsed` calculado de forma preguiçosa. Só vale se, depois da Forma A e da fase
  de dados, o laço sobre os nós ainda aparecer no perfil: o ganho é de O(N) para
  O(eventos) e o preço é mudar a leitura de `elapsed` e a ordem de empate. O SUMO
  e a Factorio têm essa fila porque têm milhares de entidades e cada passo custa
  caro; aqui o laço da Forma A já é desprezível.

**Variante com mudança de comportamento (não recomendada ainda):** o SUMO só
reavalia a lógica atuada a cada 1 s (`minRetry = TIME2STEPS(1)`), que no passo padrão
de 1 s é todo passo. No jogo seriam 60 ticks; uma cadência de 0,1–0,25 s para a
**decisão de demanda** reduziria o custo dos nós ocupados, mas deslocaria trocas de
verde em até 15 ticks e precisaria reaprovar `defects.spec`, `fourWay.spec` e o
fuzz. Só se os nós ocupados ainda pesarem.

### 3.3 Limpeza de faixas só na mudança de topologia

`collectGhosts` (`pipeline.ts:196–206`) copia `[...w.runtime]` (aloca um par `[id, rt]`
por entrada — a ordem de grandeza é de ~20 mil pares por passo em 36×36, **estimativa
minha** a confirmar com `--heap-prof`) e testa `graph.lanelets.has(id)` em cada um,
todo passo, para tratar um caso que só existe logo depois de uma edição (faixa que
deixou de existir com veículos nela). A regra do Dirty Flag aplica-se: o dado
primário (o grafo) muda em `rebuildVehicleTopology` (`world.ts:406`) e não em todo
passo; o dado derivado ("quais entradas do runtime são fantasmas") é recalculado
nesse ponto e guardado como conjunto/lista de candidatos. O laço por passo passa a
percorrer só esses candidatos (em geral vazio) para apagar os que esvaziaram
(`order.length === 0`), com o mesmo efeito observável. Pontos de cuidado:
- `rt(id)` cria entradas para qualquer id (`world.ts:306–313`), inclusive os que **não**
  estão no grafo (veículo cuja faixa foi apagada antes do `rebind`): o conjunto precisa
  também ser alimentado em `enterLanelet` quando `!graph.lanelets.has(id)`, e em
  `rebindVehicles` (`pipeline.ts:155–188`).
- `runtime` nunca encolhe fora dos fantasmas: `entryLanes` o enche com todas as faixas
  longas (efeito colateral de `w.rt(lane.id)`, `spawn.ts:61`), e `integrate.ts:170`
  o varre por passo. Tirar esse efeito colateral (a verificação `ghost` é inútil ali:
  as faixas do grafo nunca são fantasmas) encolhe o runtime ao conjunto de faixas que
  alguém usou — o laço de `integrate.ts:170` poderia ainda assim virar uma lista de
  "faixas com ≥ 2 veículos" mantida em `enterLanelet/exitLanelet`.
- Auditoria (`invariants.ts:195`) percorre `w.runtime.values()` mas roda a 1 Hz
  (`main.ts`, `auditEvery`).

### 3.4 Caches por revisão

Revisões que já existem: `net.trafficRevision` (`network.ts:165,303,423`),
`w.vehicleTopologyRevision`/`w.topologyRevision` (`world.ts:223–226,416,486`),
`net.revision`, `doc.revision`, `graph.revision`.

| Cache | Chave | Invalidação | Notas |
|---|---|---|---|
| `entryLanes` (`spawn.ts:57`) | `vehicleTopologyRevision` + `doc.revision` | refeito quando uma delas muda | `doc.mapEdge` (`doc.ts:567`) lê `incident.length` e `end` do nó; um edit que muda isso muda também as faixas; incluir `doc.revision` na chave é a opção segura (custo: refazer a lista em cada edição, uma vez). **Sem** chamar `w.rt()` (ver 3.3). A ordem `sort()` por id fica igual (a lista é a mesma) |
| `trafficTarget` (`spawn.ts:43`) | `net.revision` para o comprimento total; escalares (`trafficCount`, `populationShare`, `trafficIntensity`, `demandMultiplier`) lidos na hora | o comprimento total muda com as fitas | o campo naturalmente pertence a `Network` (derivado do documento, "world"); `stepsIn(total,12)` e as multiplicações ficam por chamada (O(1)). Quatro chamadores: `spawn.ts:99,132`, `lotTraffic.ts:163`, `ambient.ts:519` |
| lista de cruzamentos com sinal | `vehicleTopologyRevision` (e mudanças de `signalised` por `applyAutoControl`, `world.ts:429–441`) | refeita em `syncControllers` (`world.ts:664`), que já é o único lugar que cria/apaga controladores | guarda pares `{node, controller, junction}` para não fazer 2 `Map.get` por nó por passo; ordem de inserção basta (3.2) |
| `signalDeps()` | um objeto por revisão de topologia; memória de demanda **por passo** | a memória de demanda zera a cada passo | trocar `new Map()` aninhado por arrays com carimbo de passo (`memo.stamp === tick`) tira a alocação por passo; as perguntas são as mesmas |
| `settings(node)` | `doc.revision` do nó | `fsm.ts:209` chama a cada tick | ler uma vez por controlador e por revisão |
| `reservedGroups()` | passo | já preguiçosa por passo (`world.ts:533–560`) | chamar sob demanda **uma vez** por passo, não por nó |

Regra do `CLAUDE.md` ("derived data built behind revision gates") e a regra 9.7.2 do
relatório pedem um **contador de trabalho** em cada um: sugestão — `simWork =
{ controllersStepped, controllersRested, ghostScans, entryLanesBuilt,
runtimeSorts }` no padrão de `padsWork`/`kerbWork` (`pads.ts:72`, `poleLines.ts:177`)
e linhas em `COUNT_BUDGETS` (`perfBudget.ts:63–76`).

### 3.5 `busNear` por faixa

`busNear` (`world.ts:647–657`) percorre `this.vehicles.values()` e filtra por
`archetype.shape === 'bus'`, `lane.to === node` e distância; só roda se
`settings.busPriority` (`fsm.ts:222,224,296`, e `greenWave.ts:41` copia a bandeira).
Padrão dado pelo próprio `signalDemand` (`world.ts:615`): percorrer `junction.inbound`
e, de cada faixa, `runtime.get(laneId).order` do mais próximo da saída para trás até
passar de `BUS_REACH` (`world.ts:20`, 90 m), com `break` assim que `lane.length − v.s`
passa do alcance — custo proporcional aos veículos *nas faixas do nó*, não à frota. Um
contador de ônibus por nó (mantido em `enterLanelet/exitLanelet` como o de veículos)
daria o "sem ônibus por perto" em O(1). Com a prioridade ligada, o controlador **não**
pode dormir em verde (a pergunta muda a cada tick): isso é uma regra do
"quiescente", não um defeito.

### 3.6 Como provar que é igual (oráculo) e medir

- **Oráculo "dormindo = passo a passo"**, no espírito de `incrementalRebuild.spec`:
  dois mundos da mesma semente, um com a decisão pulada e outro com a decisão em todo
  tick; a cada tick comparar, **exatamente** (não por `hashSim`, que arredonda a
  1 ms: `snapshot.ts:26`, `q = Math.round(v*1000)`), a tupla `(stageIndex, sub,
  elapsed, lastServed, stageServed)` de todos os controladores; em `closedGrid` 6×6
  e 12×12 (`tests/sim/agents/population.spec.ts:27`), na cidade padrão, em semente
  fuzz e com `busPriority`, `fixed`, bloqueio de movimentos e edições entre ticks.
  O `tests/sim/signalRest.spec.ts` mostra como montar um controlador à mão e
  conduzir `stepController` com `deps` falsos.
- **Rede de segurança contra despertar perdido**: um despertar esquecido faz um carro
  esperar para sempre; a auditoria `groupStarved` (`invariants.ts:56–72`) já mede
  "demanda esperando com vermelho acima de 1,5 ciclos" e o fuzz `deep` a roda; manter o
  modo "sombra" (a cada K ticks executar a decisão completa e afirmar que é no-op para
  todo nó dormindo) enquanto a fase não fechar.
- **Contadores de escala** (relatório 9.4, fase 0): `controllersStepped` por passo
  igual na 6×6 e na 36×36 com a mesma população; `ghostScans` por passo = nº de
  candidatos; `entryLanesBuilt` = 0 em passos sem edição.
- **Medidas**: B2 (tempo por estágio) antes/depois, a mesma máquina e o mesmo
  `run-limited`; os dois `.cpuprofile` de 3.1; `--heap-prof` ou `process.memoryUsage()`
  em 600 passos para a alocação por passo (hoje o portão mede 168–176 MB/s na cidade
  pequena, `perfBudget.ts:88`).

### 3.7 Chaves de texto no caminho quente (além da fase 1)

O V8 (2.2) deixa claro onde está o risco: chaves **montadas** por chamada. Achados no
código (`grep` de template literal fora de mensagens de erro e diagnóstico em
`src/sim`): `admission.ts:1277,1317,1395` (`${conn.node}:${segment}`, id de travessia
montado por veículo por tick perto de uma travessia), `crossingSpans.ts:71,98,101,124`
(montado só ao reconstruir), `tactical.ts:69` (`keyOf(lane, changed)` = `${lane}|c`,
montado a cada expansão do Dijkstra), `routing/destination.ts:67`
(`${start}|${body}`), `ambient.ts:752` (`${topologyRevision}:${vehicleTopologyRevision}`),
`ambient.ts:324,565,841` (chaves de cache de revisão, montadas por chamada). O comentário em `world.ts:515–518` mostra que a equipe já mediu o efeito:
"uma chave de texto montada a cada pergunta era a maior parte do tempo dos controladores
num mapa parado (auditoria, 2026-10-09)" — por isso a memória de demanda é
indexada pelos próprios arrays. A regra 9.7.5 do relatório (regra de lint para template
literal como chave no passo) é consistente com a fonte; **onde** pôr o limite de
alocação é decisão da fase 4 (ids inteiros).

---

## 4. Riscos e o que medir

1. **Determinismo.** Qualquer atalho que mude a ordem das somas de `elapsed` (por
   exemplo, trocar `+= DT` por multiplicação) muda o último bit e, com ele, em que
   tick uma comparação `elapsed >= st.amber` vira verdadeira. Regra: `elapsed += DT`
   fica; o que se pula é a *decisão*.
2. **Despertar perdido ⇒ cruzamento parado.** Mitigação: oráculo exato, auditoria
   `groupStarved`, modo sombra.
3. **Efeito colateral de `rt()` em `entryLanes`.** Tirá-lo muda o conteúdo (não a
   semântica) de `runtime`; `invariants.ts:195` e `integrate.ts:170` iteram o runtime.
   Conferir que nada lê `runtime.get(id)` esperando que exista (`rt(id)` cria sob
   demanda; leitores com `?.` toleram a falta).
4. **O ganho pode ser menor que o esperado na cidade real.** A sonda B2 é uma grade
   sintética com sinal em quase todo cruzamento (pior caso). Num mapa com tráfego
   espalhado, os nós ocupados continuam a custar; o ganho garantido é só o dos ociosos
   (relatório 10.5). Medir também no mapa do jogador e na cidade gerada grande.
5. **Cruzamento `integrate.ts:170` e `admission.ts` pertencem ao agente de trânsito**
   (PROMPT-AGENTES): a mudança do laço de ordenação de faixas, e os contadores por
   faixa de entrada em `enterLanelet` (arquivo da coordenadora, `world.ts`), precisam de
   acordo de quem edita o quê.
6. **Memória fria (estágios 3–6).** Se o perfil mostrar tempo por chamada crescendo,
   o remédio sai da lista da fase 1 (dados contíguos, ids inteiros, hot/cold). Medir
   o conjunto de trabalho: bytes por `Lanelet` e por `LaneletRuntime`.
7. **Custo do próprio contador de trabalho** (um `x.n++` por laço quente): desprezível,
   mas é estado global mutável — zerar em cada teste (padrão `padsWork`).
8. **Alocação por passo do `signalDeps()`**: ~12 fechamentos e um `Map` por passo
   parecem pequenos; medir com `--heap-prof` antes de gastar tempo.
9. **Aceite "estágio de semáforos ≤ 0,2 ms com 1 369 cruzamentos ociosos"**
   (relatório 5.1): só vale para cruzamentos *ociosos*; com tráfego a medida certa é
   por cruzamento ocupado.

---

## 5. O que NÃO foi possível ler (ou só em resumo)

- **FFF #148**: a página lida não traz medidas nem condições de despertar (apenas a
  frase de que as entidades dormem e custam zero). O mecanismo de despertar da
  Factorio vem de discussões de fórum/Reddit que a busca achou e eu **não abri**.
- **SUMO**: `SwitchCommand::execute` lido por extração; como o controle de eventos
  reagenda o valor devolvido não apareceu; `MSActuatedTrafficLightLogic.cpp` lido
  por extração (`trySwitch`, `duration`, `gapControl`), não o arquivo inteiro.
  Documentação: não diz a frequência de avaliação.
- **V8**: `name.h`, `string.h` e `builtins-collections-gen.cc` lidos por extração
  dirigida; não li `Runtime_InternalizeString` nem a tabela de strings; não há
  nanossegundos em nenhuma fonte lida. A relação "template literal ⇒ chamada de
  runtime por procura" é **dedução do código do despachante**, não medida; falta um
  microbenchmark (`Map.get` com chave pronta × chave montada × id inteiro).
- **Box2D**: lido até o caractere 100 000 de 139 164; a página não traz limiar de
  sono nem ilhas. **PhysX**: sem ilhas no trecho.
- **Timing wheels (SOSP 1987)**: PDF digitalizado, sem texto extraível.
- **Unreal**: a página de ticking não documenta intervalo de tick.
- Não li o código de `admission.ts`, `obstacles.ts`, `drive/*` nem `pedEngine.step` além
  de `grep`; a causa do crescimento dos estágios 3–6 (3.1) é **desconhecida**: só
  há duas hipóteses e o método para decidir entre elas.
