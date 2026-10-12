# Pesquisa da fase 0 — medir direito (GPU, ritmo de quadros, estatística, escala)

Pesquisa de 2026-10-11, só leitura de código. Ramo `agente/pesquisa`, a partir de
`planeta-esfera` `27a7cb48`. Todo `arquivo:linha` é desse commit. Complementa a
seção 4.1, 9 e 10 do `docs/relatorio-desempenho-mapas-enormes-2026-10-11.md`
(fontes F58, F61–F67); aqui as fontes foram lidas de novo e levadas ao código.

**Como as fontes foram lidas.** Páginas da web: pela ferramenta WebFetch, que
converte a página em texto e a responde por um modelo pequeno, guiado por um
pedido meu; não é o byte bruto, e onde a resposta disse "a página não diz" eu
registrei isso como lacuna em vez de completar de memória. PDFs: baixados pela
própria ferramenta, convertidos com `pdftotext` e lidos por mim no texto. Código
do three.js r186.1: lido direto em `C:/Codex-Shared/roadcraft-planeta-esfera/node_modules/three`.
Nada abaixo foi executado no jogo.

---

## 1. Perguntas que a fase 0 precisa responder

1. Como medir o tempo de GPU de um quadro do jogo com `EXT_disjoint_timer_query_webgl2`
   sem aninhar consultas, sem alocar por quadro, sem bloquear a CPU e sem tomar
   por bom um número "disjoint" ou de clock baixo?
2. Qual instrumento dá o intervalo entre quadros (p50/p95/p99/máx e quadros
   > 33,8 ms) sem confundir "o jogo desenha sob demanda" com "o jogo travou"?
3. O que o Long Animation Frames (LoAF) acrescenta ao que o F9 já tem, e quais
   são os limites dele (limiar fixo de 50 ms, atribuição, o que ele não vê)?
4. Como comparar duas versões do jogo de modo que o veredito sobreviva ao ruído
   de uma máquina compartilhada (rodadas, intercalação, bootstrap, limiar de
   ruído, IC do efeito) e quantas rodadas e quadros bastam para p99?
5. Como transformar as sondas B1/B2 do anexo B em teste de escala determinístico
   (contadores de trabalho, sem relógio) que rode no `npm run check`?
6. Onde cada peça se liga: `scripts/perf-gate.mjs`, `src/core/perfBudget.ts`,
   `src/core/health.ts`, `src/ui/healthWatch.ts`, `src/render/postprocess.ts`,
   `src/render/renderer.ts`, `src/main.ts`?

---

## 2. Fontes lidas

### 2.1 Timer de GPU

**Khronos, `EXT_disjoint_timer_query_webgl2`** (WebGL extension #33, revisão 4,
2023-06-01) — https://registry.khronos.org/webgl/extensions/EXT_disjoint_timer_query_webgl2/
O texto é curto e remete à extensão de base. Traz a IDL (constantes
`QUERY_COUNTER_BITS_EXT 0x8864`, `TIME_ELAPSED_EXT 0x88BF`, `TIMESTAMP_EXT 0x8E28`,
`GPU_DISJOINT_EXT 0x8FBB`, método `queryCounterEXT`), três exemplos (TIME_ELAPSED
com consulta por quadro, par de timestamps, escolha por `QUERY_COUNTER_BITS_EXT`) e
um aviso: usar todos os bits do resultado (64 bits). A única regra específica de
WebGL é que os resultados "só ficam disponíveis em momentos bem definidos".

**Khronos, `EXT_disjoint_timer_query` (WebGL 1)** — revisão 12, 2024-04-19 —
https://registry.khronos.org/webgl/extensions/EXT_disjoint_timer_query/
Diz onde estão as regras: o resultado de uma consulta só pode ficar disponível
"quando o laço de eventos do agente de usuário não está executando uma tarefa",
e não antes de o controle voltar ao laço principal. Consultar
`QUERY_RESULT_AVAILABLE` repetidamente sem ceder o controle devolve sempre o mesmo
valor; ceder uma vez (um `setTimeout(0)` ou um `requestAnimationFrame`) não
garante disponibilidade. Os exemplos pedem ler `GPU_DISJOINT_EXT` antes de
começar e depois de terminar, e refazer as medidas se for verdadeiro; consultas
são apagadas com `deleteQuery` (rev. 9).

**Khronos, `EXT_disjoint_timer_query` (OpenGL)** —
https://registry.khronos.org/OpenGL/extensions/EXT/EXT_disjoint_timer_query.txt
(a data da revisão não aparece no trecho que li). Regras que o WebGL herda:
só uma consulta de tempo ativa por vez, uma segunda `beginQuery` no mesmo alvo
dá `INVALID_OPERATION`; `queryCounter` pode ser usada dentro de um bloco
`TIME_ELAPSED` sem alterá-lo; o relógio "começa ou para quando os efeitos de todos
os comandos anteriores foram realizados" (isto é, o tempo é de ponta a ponta na
fila da GPU, ver risco 4.2); a disponibilidade é ordenada ("todas as consultas do
mesmo tipo emitidas antes também devem retornar TRUE"); `GPU_DISJOINT_EXT`
devolve não-zero se houve evento disjunto desde a última leitura dele
(portanto **ler zera a janela**) e, se ocorreu, "todos os valores de tempo
preenchidos desde a verificação anterior devem ser considerados indefinidos";
causa citada: a GPU mudou de estado (exemplo: GPU móvel que dorme); a
granularidade do timer depende da implementação, mínimo de 30 bits (cerca de
1 s). O texto discute também preempção por outro contexto (Issue 18).

**Ken Russell (Google), lista public_webgl** — 2018-05-19 e 2018-07-13 —
https://www.khronos.org/webgl/public-mailing-list/public_webgl/1805/msg00013.php e
https://www.khronos.org/webgl/public-mailing-list/public_webgl/1807/msg00034.php
A extensão foi desligada no Chrome em 2018 por poder servir de relógio de alta
resolução para ataques tipo Spectre e para o ataque GLitch. Ele diz que o Chrome
já devolvia resolução de microssegundos (não nanossegundos) e que a extensão
voltaria com Site Isolation; em julho de 2018 escreve que o Site Isolation foi
entregue nos desktops e que a extensão será religada lá. Consequência para nós:
no Chrome o resultado vem em passos de 1 µs e a extensão só existe onde há
isolamento de sites (não precisa de `crossOriginIsolated`: a sonda B3 do
relatório achou a extensão com `crossOriginIsolated = false`).

**ANGLE, `Query11.cpp`** (ramo `main`, via
https://raw.githubusercontent.com/google/angle/main/src/libANGLE/renderer/d3d/d3d11/Query11.cpp,
lido através de extração do WebFetch, não o arquivo cru). No backend D3D11 (o do
jogo no Windows, `--use-angle=d3d11`, `scripts/perf-gate.mjs:24`) uma consulta
`TIME_ELAPSED` é uma consulta D3D11 mais dois `D3D11_QUERY_TIMESTAMP` (um ao
`resume`, outro ao `pause`) mais uma `D3D11_QUERY_TIMESTAMP_DISJOINT`; o tempo é
`(fim − início) × 10⁹ / Frequency`; `GPU_DISJOINT` é marcado quando a consulta
D3D11 diz `Disjoint`, ou quando a conta estoura; `isResultAvailable` faz
`GetData` sem esperar e `getResult` bloqueia até todas as consultas pendentes
terminarem. Ou seja: o número é a diferença de dois carimbos na fila da GPU.

**Microsoft, `D3D11_QUERY_DATA_TIMESTAMP_DISJOINT`** —
https://learn.microsoft.com/en-us/windows/win32/api/d3d11/ns-d3d11-d3d11_query_data_timestamp_disjoint
(atualizado 2024-02-22). `Disjoint` verdadeiro quer dizer que algo entre `Begin`
e `End` tornou o contador de tempo descontínuo — exemplos do texto: tirar o cabo
de força de um laptop, superaquecimento, "throttling up/down". Só vale o
carimbo quando `Disjoint` é falso. O texto não diz que mudança de estado de
energia (P-state) de uma placa de mesa seja marcada como disjoint; **não
sabemos** se o clock baixo da RTX é sinalizado (ver 4.3).

**three.js r186.1, `WebGLTimestampQueryPool.js`** (lido direto em
`node_modules/three/src/renderers/webgl-fallback/utils/WebGLTimestampQueryPool.js`).
É o timer do backend WebGL do `WebGPURenderer`; o `WebGLRenderer` que o jogo usa
**não tem** timer de GPU (`grep disjoint` em `src/renderers/WebGLRenderer.js` não
acha nada). O que ele faz: pega `EXT_disjoint_timer_query_webgl2` ou a de WebGL 1
(l.27–28); cria até 2048 consultas de uma vez (l.19, 38–42); só uma ativa por vez —
`beginQuery` retorna sem fazer nada se `activeQuery !== null` (l.104–107); resolve
em promessa com `setTimeout(checkQuery, 1)` (l.346); **quando vê `GPU_DISJOINT_EXT`
verdadeiro devolve o último valor válido** (`finalizeResolution(this.lastValue)`,
l.335–340). Esse último ponto é um defeito para estatística: um valor repetido
entra na série como se fosse medida nova. Não copiar.

**stats-gl** (RenaudRohlinger/stats-gl, ramo `main`, `lib/core.ts`, 20 336 bytes;
versão npm não confirmada) — https://github.com/RenaudRohlinger/stats-gl .
Lido por extração do WebFetch. Para WebGL: `getExtension('EXT_disjoint_timer_query_webgl2')`;
`begin()` abre uma consulta `TIME_ELAPSED_EXT` (e fecha a anterior se esquecida);
`end()` fecha, empilha em `gpuQueries`; `processGpuQueries()` percorre a lista de
trás para frente, lê `QUERY_RESULT_AVAILABLE` e `GPU_DISJOINT_EXT` para cada
consulta, soma ms (`× 1e-6`) das que estão prontas e sem disjoint, apaga essas;
se disjoint, mantém a consulta e tenta de novo depois; não há teto de consultas
em voo; `patchThreeRenderer()` embrulha `renderer.render` (uma consulta por
chamada, somadas). O fps dele é a contagem de chamadas no último segundo, **não
um intervalo entre quadros**. Pontos fracos para nosso uso: soma o que resolveu
naquela rodada de leitura (não é por quadro), cria e apaga uma `WebGLQuery` por
chamada (alocação por quadro), e relê `GPU_DISJOINT_EXT` por consulta (a segunda
leitura da mesma rodada já não vê o evento: a leitura zera a janela).

**Não lido:** a implementação de `r3f-perf` e de `three-perf` (o README do
primeiro não descreve a medida de GPU e a árvore de `src/` não lista arquivo de
GPU; para o segundo só achei o README do npm). `gl-bench` aparece em busca como
tendo largado a extensão em alguns PCs; não li.

**NVIDIA `nvidia-smi`** — https://docs.nvidia.com/deploy/nvidia-smi/index.html
(lido até o caractere 100 000 de 177 965) e `nvidia-smi --help-query-gpu` rodado
**nesta máquina** em 2026-10-11 (só leitura). Campos: `clocks.gr`/`clocks.current.graphics`,
`clocks.max.gr`, `pstate`, `clocks_throttle_reasons.active` (ou `clocks_event_reasons.active`),
`temperature.gpu`, `power.draw`, `utilization.gpu` (janela de 1 s a 1/6 s);
`--format=csv`, `-lms <ms>` (laço em ms, sem resolução mínima documentada).
`-lgc`/`--lock-gpu-clocks=MIN,MAX` existe para Volta ou mais novo e **exige root**
(administrador): é mudança de configuração do sistema, decisão do jogador, não
minha. Leitura local: **RTX 3060, driver 591.74, parada em P8 a 210 MHz, máximo
2190 MHz, limite de potência 170 W** — o clock de repouso é ~10% do máximo, o que
explica o 52 ms do painel escondido do relatório (5.10/B3).

### 2.2 Ritmo de quadros e travadas

**Chrome, "Long Animation Frames API"** — https://developer.chrome.com/docs/web-platform/long-animation-frames
(Chrome 123+; teste de origem 116–122). Um LoAF é uma atualização de renderização
atrasada além de **50 ms** (limiar igual ao do Long Tasks, **não configurável**;
só dá para filtrar mais alto no observador). Atributos: `startTime`, `duration`
(**exclui o tempo de apresentação**), `renderStart`, `styleAndLayoutStart`,
`firstUIEventTimestamp`, `blockingDuration` (soma, por tarefa do quadro, do que
passa de 50 ms; o tempo de renderização entra na tarefa mais longa; exemplo do
texto: tarefas de 55 e 65 ms + 20 ms de render dão bloqueio 40 ms), `scripts[]`
(só scripts acima de 5 ms; `invoker`, `invokerType`, `sourceURL`,
`sourceFunctionName`, `forcedStyleAndLayoutDuration`, `pauseDuration`). Quadros
sem renderização também são reportados (com `renderStart` 0). Só scripts da thread
principal são atribuídos; workers, iframes de outra origem e extensões não. A
atribuição é o ponto de entrada (o `requestAnimationFrame`), não a função lenta
chamada de dentro. `getEntriesByType('long-animation-frame')` guarda no máximo
200 entradas; o observador (`buffered: true`) é o caminho recomendado. Não há
suporte no Firefox nem no Safari.

**W3C, "Long Animation Frames" (Editor's Draft; a página diz 3 de setembro de
2026)** — https://w3c.github.io/long-animation-frames/ . Confirma 50 ms fixo.
Pelo algoritmo "record rendering time" (passo 4: "se a duração do quadro for menor
que 50 ms, descarte"), `renderStart` e `styleAndLayoutStart` só são preenchidos
quando o **quadro** tem ≥ 50 ms (não só a renderização); o limite de 5 ms dos
scripts é estritamente "maior que" (passo 13 de "record timing info for microtask
checkpoint"); durações têm granularidade de 1 ms; o quadro sem oportunidade de
renderização ainda vira entrada se passar de 50 ms. O texto não relaciona o LoAF
com o carimbo do `requestAnimationFrame`.

**MDN, `requestAnimationFrame`** —
https://developer.mozilla.org/en-US/docs/Web/API/Window/requestAnimationFrame .
O carimbo recebido é o mesmo para todos os callbacks do quadro; para `Window` é
igual a `document.timeline.currentTime`; é "parecido, mas nunca igual" a chamar
`performance.now()` no início do callback, e a MDN avisa que `performance.now()`
não serve para sincronizar callbacks; callbacks param em aba ou iframe oculto; a
frequência acompanha a tela (60/75/120/144 Hz). A MDN descreve o carimbo como o
fim da renderização do quadro anterior; a especificação HTML (seção "animation
frames", https://html.spec.whatwg.org/multipage/imagebitmap-and-animations.html#animation-frames)
só diz que um único `now` por rodada é passado a todos os callbacks, e **não diz
como `now` se relaciona com o instante em que o callback executa**. A MDN não
afirma que a diferença entre carimbos seja o tempo de quadro; essa é inferência
(ver risco 4.4).

**MDN, `Performance.now()`** — https://developer.mozilla.org/en-US/docs/Web/API/Performance/now .
Resolução de **100 µs** sem isolamento entre origens e **5 µs** com
(`crossOriginIsolated`), por proteção contra ataques de tempo. O relógio é
monotônico mas não conta o sono do sistema em Chrome, Firefox e Safari (bug
aberto nos três; Windows conta). Liga-se à fase 8: o `FrameTimer` do jogo arredonda
a 0,1 ms (`core/health.ts:237`), que é a resolução que o navegador já entrega.

**NVIDIA, "Analysing Stutter – Mining More from Percentiles"** —
https://developer.nvidia.com/content/analysing-stutter-%E2%80%93-mining-more-percentiles-0
(sem data visível no texto lido; lido por resumo da ferramenta, não literal).
Percentis de tempo de quadro dão medida objetiva de travada (curva em "L" ou "taco
de hóquei" = problema). Pontos de leitura: 99,0/99,5/99,8/99,9/99,95; depois o
autor adota passos "100 − 2ⁿ"; **não usa o 100º percentil** (um único quadro,
não repetível) nem o 0º; **com 2 000 quadros, o p99,95 é um único valor**; os
jogos do exemplo foram capturados com 41 000 e 19 000 quadros para o rabo ser
repetível, e um conjunto de 1 800 quadros foi tratado como ruidoso; normaliza
subtraindo a média (dividir deixava as curvas parecidas demais); calcula
percentis negativos para ver quadros muito abaixo da média, que costumam seguir
uma travada em sistemas com pipeline fundo. Não dá tempo de captura, só
contagens de quadros.

### 2.3 Estatística de comparação

**Kalibera & Jones, "Rigorous Benchmarking in Reasonable Time", ISMM 2013**
(manuscrito aceito, Kent) — PDF lido por extração de texto:
https://kar.kent.ac.uk/33611/45/p63-kaliber.pdf ; DOI 10.1145/2464157.2464160.
Li as seções 1–4 (introdução, trabalhos relacionados, desafio da repetição e do
resumo), 6 (início), 9.1, 10 e o começo da 11; **não li** 6.1–8 e 9.2–9.4 em
detalhe. O que diz: (i) há níveis de repetição (compilação, execução, iteração);
a repetição é necessária no nível mais alto onde existe variação aleatória, e os
níveis de baixo só servem para economizar tempo; (ii) só faz sentido repetir
medidas depois que o sistema chega a um **estado independente** (tempos de
iteração i.i.d.); se as medidas não são i.i.d. a variância e o intervalo de
confiança saem enviesados — "iterações" não são amostras independentes só por
serem muitas; (iii) testes de significância confundem tamanho de amostra com
relevância prática (com amostra grande quase tudo é "significativo") e devem ser
trocados por **intervalo de confiança do tamanho do efeito**, por exemplo "A é
5,5% ± 2,5% mais rápido"; (iv) para a razão entre dois sistemas usam o intervalo
de Fieller (eq. 5), que não supõe razão normal; quando os dois sistemas têm o
mesmo desempenho e a mesma largura relativa ε, a largura relativa do IC da razão
é cerca de √2·ε; (v) experimento de dimensionamento: partir de 20–30 repetições
por nível e calcular as contagens ótimas por nível pelo custo de cada um; (vi)
não mostram contagens de execuções menores que 5 "pois mal servem para estimar a
variância". Também confirmam o resultado de Mytkowicz de que ordem de ligação
muda o resultado, porém bem menos nos tamanhos de referência.

**Mytkowicz, Diwan, Hauswirth, Sweeney, "Producing Wrong Data Without Doing
Anything Obviously Wrong!", ASPLOS 2009** — PDF lido por extração:
https://users.cs.northwestern.edu/~robby/courses/322-2013-spring/mytkowicz-wrong-data.pdf
(cópia de curso; versão ACM DOI 10.1145/1508244.1508275). Li 1–4 e 7–8; **não li**
as seções 5–6 (levantamento de 133 artigos) com atenção. O tamanho do ambiente
Unix e a ordem de ligação mudam o resultado de uma otimização, em alguns casos de
slowdown a speedup (de 0,92 a 1,10 no perlbench, e de 0,88 a 1,09 no lbm), com
intervalos de confiança estreitos — são reprodutíveis, não ruído; menciona que
até a temperatura da sala altera o clock da CPU. Remédio 1: **aleatorizar o
ambiente do experimento** (484 combinações de ordem de ligação × tamanho de
ambiente, 3 execuções cada) e comparar as duas distribuições com teste t (resultado
1,007 ± 0,003 no perlbench). Remédio 2: análise causal (intervir, medir, confirmar).
Para nós: processo novo por rodada e sementes/ordem aleatorizadas fazem o papel de
"ambientes diferentes".

**Criterion.rs** — https://bheisler.github.io/criterion.rs/book/analysis.html e
https://docs.rs/criterion/latest/criterion/struct.Criterion.html . Processo:
aquecimento por doubling até `warm_up_time`; amostras com contagem de iterações
crescente; classificação de outliers por Tukey (1,5·IQR leve, 3·IQR severo — são
avisados e **mantidos**); regressão linear; bootstrap para IC; comparação com a
execução anterior por teste t com bootstrap das estatísticas t; mudança só é
declarada se passa do **limiar de ruído** (padrão 1%) além da significância (padrão
0,05). Padrões em `docs.rs`: 100 amostras, aquecimento 3 s, medição 5 s, 100 000
reamostras, confiança 0,95. (O livro não lista esses números; vêm da página de
API.)

**Google Benchmark** — `docs/tools.md`, `docs/user_guide.md`,
`docs/reducing_variance.md`, `docs/random_interleaving.md`
(https://github.com/google/benchmark/tree/main/docs). `compare.py` usa o **teste U
de Mann-Whitney** e avisa que exige "não menos de 9" repetições; delta = (novo −
antigo)/|antigo|. `Complexity()` + `SetComplexityN(n)` ajusta a curva de
complexidade (O(N), O(N log N)…) aos tempos e devolve coeficiente e RMS — a mesma
ideia, com tempo, do teste de escala por contadores. `state.counters` permite
contadores nomeados por benchmark. `--benchmark_enable_random_interleaving`
mistura as repetições entre benchmarks; o doc cita uma redução de variância de
cerca de 40% (do issue #1051, **que não li**). `reducing_variance.md`: governador
`performance`, desligar ASLR, desligar turbo, fixar afinidade (`taskset`),
prioridade, SMT, e "fechar programas que usam temporizadores de forma não trivial,
como navegadores".

**Mozilla Perfherder** — `perf-sheriffing` (https://firefox-source-docs.mozilla.org/testing/perfdocs/perf-sheriffing.html)
**não descreve o método estatístico**; diz limiares por framework (Talos,
Browsertime, Build Metrics ≥ 2%; AWSY ≥ 0,25%; instalador ≥ 100 kB; Dromaeo 5%),
que alerta só com ~12 pontos futuros, "retrigger" para ter mais pontos e que ruído
demais leva a remover o teste. O método está em Besbes et al., "A Dataset of
Performance Measurements and Alerts from Mozilla" (ICPE Companion 2025),
https://arxiv.org/pdf/2503.16332 (lido por extração de texto): o Perfherder
calcula o escore t de **Student de duas amostras** entre **no mínimo 12 revisões
anteriores e a atual mais até 11 posteriores**; se o t passa de um limiar fixo,
mede a magnitude da mudança e, se passa de outro limiar, abre o alerta; em 1 ano
(maio de 2023 a maio de 2024) foram 17 989 alertas e 3 912 resumos, dos quais
12,47% foram invalidados por humanos como falsos. Uso para nós: duas portas
(significância e magnitude), e a conta de que alertas automáticos precisam de
triagem.

**Algorithmic Profiling**, Zaparanuks & Hauswirth, PLDI 2012 —
https://static.aminer.org/pdf/20170130/pdfs/pldi/bs9oejsmyuai0hawvh8tbr2c5nekpdvl.pdf
(DOI 10.1145/2254064.2254074); li o resumo e a introdução (cerca de 140 linhas de
681); **não li** as seções do algoritmo. Ideia central: em vez de um número de
custo por execução, determinar uma **função de custo** — passos algorítmicos
(repetições de laços e recursões) contra o tamanho da entrada — ajustada em várias
execuções (exemplo: ordenação por inserção, ajustes `passos = 0,25·n²`,
`passos = n`, `passos = 0,5·n²` conforme a entrada). As funções são aproximações,
sem garantia de limite.

**Bencher / Iai** — https://bencher.dev/learn/benchmarking/rust/iai/ : Iai conta
instruções (Valgrind) em vez de tempo, as contagens "ficam quase idênticas" entre
execuções, o que o torna adequado a CI em máquinas compartilhadas; é um proxy
(dobrar instruções não dobra latência). Linux/macOS x86 apenas. A página
`explanation/benchmarking` não fala disso. É a base dada em `perfBudget.ts:14–17`.

---

## 3. O que se aplica a este código

### 3.1 Timer de GPU

**Onde pendurar.** Uma consulta por quadro de jogo, em volta do que o jogo
chama uma vez por quadro: `post.render(delta)` em `src/render/renderer.ts:3777`,
que cai em `composer.render(delta)` (`src/render/postprocess.ts:592`) ou, sem
cadeia de pós (nível mais baixo), em `renderer.render(scene, camera)`
(`postprocess.ts:191`). Dentro do compositor os passes rodam em sequência
(`EffectComposer.js:230–237` do three r186, `pass.render(...)` um por vez), nunca
aninhados, então uma consulta externa basta e respeita "uma ativa por vez". A
sombra do sol é desenhada dentro da primeira passada (`shadowMap.autoUpdate =
false` em `renderer.ts:503`; `shadowMap.needsUpdate = true` em `renderer.ts:3650`),
portanto está dentro da medida. **Fora** da medida ficam `renderer.render` do
aquecimento (`renderer.ts:3765`, antes de `post.render`) e `drainUploads`,
`drainCompiles` e `drainWarm` (`renderer.ts:3782–3790`, depois): um `texSubImage`
ou compilação enfileirados ali custam GPU no quadro seguinte sem aparecer. Para
esses, uma segunda consulta (nome distinto) no bloco `drain*` diz se há custo
escondido; pode ser feita só no modo diagnóstico.

**Forma que cumpre o CLAUDE.md ("sem alocação em laço quente").** O esboço do
relatório (4.1) cria e apaga uma `WebGLQuery` por chamada. A leitura das fontes
leva a outra forma:
- **Anel de consultas pré-criadas** (por exemplo 16), criadas uma vez; `begin` pega
  a próxima livre; se o anel está cheio ou já há uma ativa, o quadro simplesmente
  **não é medido** (contador `puladas`), nunca bloqueia nem aloca. O Khronos exige
  que o resultado só apareça depois de a tarefa terminar; o texto não garante
  quantos quadros depois, então o tamanho do anel é decidido medindo a idade em
  quadros quando a consulta fica pronta (item 4.2).
- **Ler só a mais velha**: a disponibilidade é ordenada, então se a mais velha
  não está pronta nenhuma outra precisa ser consultada: uma chamada
  `getQueryParameter(QUERY_RESULT_AVAILABLE)` por quadro quando nada está pronto.
- **Disjoint uma vez por rodada de leitura**: ler `QUERY_RESULT` das que estão
  prontas para uma variável temporária, ler `GPU_DISJOINT_EXT` **depois**, e só
  então confirmar (se verdadeiro: descartar tudo daquela rodada e contar
  `disjuntas`). Isso segue a ordem dos exemplos do Khronos e evita os dois
  defeitos vistos: o r186 devolve o último valor em disjoint
  (`WebGLTimestampQueryPool.js:335–340`) e o stats-gl lê o flag por consulta, e a
  segunda leitura já não vê o evento.
- **Resultado como número de 64 bits**: `getQueryParameter` devolve número
  JavaScript; a escala é ns, e o Chrome entrega µs, portanto sem perda.
- **Etiqueta de renderizador**: gravar `WEBGL_debug_renderer_info.UNMASKED_RENDERER_WEBGL`
  junto de cada série (a sonda B3 mostrou `ANGLE (NVIDIA GeForce RTX 3060 …
  Direct3D11)`); o `CLAUDE.md` já proíbe comparar GPU da iGPU com a RTX, e o
  arquivo de resultados deve impedir isso por construção.

**Onde guardar e mostrar.** `core/health.ts` é puro (cabeçalho: "no three, no
DOM"): a parte de dados (anel de amostras em `Float32Array`, percentis) vai para
`core`, ao lado de `percentile` (`health.ts:220`) e `frameStats`
(`health.ts:236`); a parte WebGL (a extensão e o anel de consultas) fica em
`src/render/` (só `render` importa three, `CLAUDE.md`, "Architecture"). A ligação
ao F9 segue o padrão que já existe: `window.__frames` em `main.ts:4450` é a
interface do portão; um `window.__gpu(since)` irmão devolve p50/p95/p99, `puladas`,
`disjuntas`, e a etiqueta do renderizador. No F9 (`ui/healthPanel.ts`) basta uma
linha em "saúde": GPU p95 do último minuto, e um aviso `budget` (tipo já existente
em `HealthKind`, `health.ts:23–24`) quando passa do alvo.

**Orçamento do próprio instrumento.** A regra 3 do `CLAUDE.md` ("novo caminho
quente ganha contador") vale para o timer: medir `hitch:gpu-timer` (CPU de
`begin + end + poll` por quadro) e fazer constar em `STEP_BUDGETS`
(`perfBudget.ts:37–48`). O custo de `getParameter(GPU_DISJOINT_EXT)` no Chrome
não está em nenhuma fonte que li — o relatório (F37, MDN "WebGL best practices", não relida
aqui) manda evitar `getParameter` síncrono —, então ele é chamado só quando há resultado a confirmar (no máximo
uma vez por quadro).

**Atribuição por passe (modo diagnóstico, desligado por padrão).** Embrulhar
cada `pass.render` do compositor com seu próprio par begin/end (não aninhado,
`EffectComposer.js:237`) dá o tempo de sombra+cena, GTAO, bloom, nuvens, SMAA,
saída; a soma dos passes comparada com a consulta externa mede a **ociosidade da
GPU esperando a CPU** (4.2). Aceitável porque nunca há duas ativas ao mesmo tempo.

### 3.2 Intervalo entre quadros e travadas

**O laço do jogo é sob demanda.** `FrameClock.request()` pede um quadro ao
navegador só quando algo muda (`src/frameLoop.ts:41–59`), e quando só as nuvens
andam usa `drift()` a cada 50 ms (`frameLoop.ts:77–84`, `DRIFT_MS = 50` em `:88`);
em `main.ts:3162–3165` a decisão é `requestDraw()` se há movimento, senão
`frameClock.drift()`. Portanto a diferença entre dois `now` consecutivos de
`frame(now)` (`main.ts:3060`, `frameClock.tick(now)` em `:3068`) **não é um
intervalo de quadro** quando o quadro anterior não pediu o seguinte. Duas
formas de medir sem esse erro:
1. **No portão**, com um laço de `requestAnimationFrame` próprio na página,
   como o de `scripts/perf-gate.mjs:126` (hoje só em volta das edições), ligado
   durante todo o cenário e contado só em trechos em que o jogo está desenhando
   continuamente (câmera em trajeto gravado, trânsito rodando). Mede
   "a thread principal esteve livre a cada vsync?", que é o que o jogador sente
   como fluidez, mas **não** o que foi apresentado (4.4).
2. **No jogo (F9)**, no fim de `frame()` (`main.ts:3153`), gravar o `now` e uma
   marca "o próximo quadro foi pedido por `requestDraw`" (contínuo) ou "por
   `drift`/ocioso"; só os intervalos entre dois quadros contínuos entram no anel.

**O que já existe e o que falta.** `perf-gate.mjs:141` já conta intervalos de
rAF acima de 50 ms por via (`roadLongFrames`); `core/health.ts:226–247`
(`FrameStats`) tem só `p50/p95/máx` e mede a **duração do `frame()`** (`end −
start`), não o intervalo; `LONG_FRAME_MS = 50` (`health.ts:148`). Faltam: p99 e
"quadros > 2× o período da tela" (33,8 ms a 59 Hz — 2 × 16,95 ms), por minuto, e
a duração do cenário. Quadros entre 33,8 e 50 ms **não aparecem em nenhum lugar
hoje** (o F9 só escreve `slow-frame` com ≥ 50 ms, `healthWatch.ts:199`; o LoAF
tem limiar fixo de 50 ms).

**Contas de amostra (minhas, a partir dos números da NVIDIA e do período).** Uma
captura de 60 s a 59 Hz tem ≈ 3 540 quadros: o p99 é decidido por ≈ 35 quadros
(aceitável), o p99,9 por ≈ 3,5 (não é repetível), o máximo por 1 (a NVIDIA
descarta o 100º percentil). Para p99,9 estável, seguindo as capturas de 19 000 a
41 000 quadros do exemplo, são 5–12 minutos de quadros — obtidos **somando os
quadros das rodadas** (item 3.3), e nunca por um cenário de 12 minutos. O
`percentile()` do jogo (`health.ts:220`) é por posto mais próximo: devolve sempre
um valor medido, e o máximo é o percentil 100 (a coluna "máx" de `frameStats` é
esse valor, o mesmo que a NVIDIA recomenda não usar como métrica de comparação).

**LoAF.** O jogo já observa `long-animation-frame` com `buffered: true`
(`src/ui/healthWatch.ts:195–209`) e tem `longFrameWork` (`:50–54`) para ignorar
quadros "longos por relógio, sem trabalho". Conferido contra a especificação: a
conta usa `renderStart`, que só vem preenchido quando o quadro tem ≥ 50 ms, o que
é verdade para toda entrada que o observador entrega, e `scripts[]`, que só
contém scripts > 5 ms, então `scripts + render` é um limite inferior do trabalho
(e é por isso que a função toma o máximo com `blockingDuration`). Nada a mudar; o
que falta é o **portão** coletar o mesmo: um `PerformanceObserver` de
`long-animation-frame` no `addInitScript` de `perf-gate.mjs:27`, guardando
(`startTime`, `duration`, `blockingDuration`, `renderStart`, os 3 maiores
`scripts`) em anel, e reportar por cenário: contagem, máx de `duration`, soma
de `blockingDuration`. O LoAF diz *quem* (qual callback) numa travada ≥ 50 ms; o
intervalo de rAF diz *quantas* travadas ≥ 33,8 ms houve. Os dois se completam.

### 3.3 Comparação estatística (liga ao `perf-gate.mjs` e ao `perfBudget.ts`)

**Unidade de análise = rodada, não quadro.** Kalibera e Jones: medidas só entram
no IC se forem independentes; os quadros de uma execução não são (o GC, o ciclo
de sombra `++shadowDepthFrame % 30` em `renderer.ts:3656`, o `panelsDue` a cada
0,4 s (`main.ts:2985`), a fila de topologia tornam o tempo de quadro periódico e
autocorrelacionado). Logo: cada **rodada** (processo de navegador novo, página
nova, mundo novo da mesma semente) produz um número por métrica (mediana de
CPU, p95, p99, contagem de quadros > 33,8 ms por minuto, GPU p95); esses números
são as amostras do nível mais alto. O IC da razão entre versões sai delas. O
esboço do relatório (9.5, `bootstrapRatio`) reamostra um vetor de 5 números:
com n = 5 há C(9,5) = 126 reamostras distintas, e com n = 7 são 1 716, n = 9
24 310 (minha conta) — as pontas do IC ficam grossas. Recomendação das fontes:
pelo menos 5 rodadas por versão (Kalibera: nada abaixo de 5 para estimar variância),
**9 ou mais** se se quiser usar Mann-Whitney (Google Benchmark: "não menos que 9"),
e o relatório do veredito como `razão [IC 95%]` com **limiar de ruído** (Criterion
1%; Mozilla 2% para tempos, o `error` do jogo hoje usa `max` absoluto em
`GATE_BUDGETS`). Semente fixa no bootstrap, para o veredito ser repetível.

**Rodadas intercaladas e ambientes variados.** A, B, A, B… (Google Benchmark mede
~40% menos variância com intercalação aleatória; a lição de Mytkowicz é que o
"ambiente" fixo vira viés). No portão: duas URLs alternadas por rodada
(`perf-gate.mjs:19` já recebe a URL em `argv[2]`), sementes de cidade e fase do
trajeto de câmera sorteadas por rodada e iguais entre A e B dentro de um par.
**Restrição do código:** o portão importa `/src/core/perfBudget.ts` de dentro da
página (`perf-gate.mjs:42`) e lê `window.__gl` (`renderer.ts:751`, só em DEV:
`if (import.meta.env.DEV) Object.assign(window, { __scene, __gl, … })`). Logo
ele só funciona contra um servidor de desenvolvimento (Vite), nunca contra o
build do 4180; comparar duas versões exige **dois servidores de desenvolvimento**
(duas árvores de código, por exemplo `planeta-esfera` e o ramo de teste) e
mede o código de desenvolvimento (por exemplo
`renderer.debug.checkShaderErrors = import.meta.env.DEV`, `renderer.ts:477`, deixa a compilação de shader mais lenta que no build do jogador).
Isso deve constar no cabeçalho de cada resultado ("medido em servidor de
desenvolvimento, iGPU") e pede uma variante que leia os contadores por
`window.__roadcraft` e não pelo módulo.

**O que o `run-limited.mjs` faz com a medida.** Todo o ramo de processos do
trabalho é recolocado em `BelowNormal` e afinidade nos processadores lógicos
0, 2, 4, 6 (quatro núcleos físicos, um thread de cada) a cada 2 s
(`scripts/run-limited.mjs`, bloco `guard`). É coerente entre A e B, e portanto
bom para comparar, mas **os números absolutos não são os do jogador**, que roda
em prioridade normal e todos os núcleos; e o tempo máximo é 480 s por padrão
(`RUN_LIMITED_TIMEOUT_S`): uma matriz de 6 cenários × 60 s × 5 rodadas × 2
versões (≈ 1 h) precisa dessa variável alterada ou de um executor que reentre
o `run-limited` por rodada (cada rodada é uma "tarefa pesada"). Os
limiares de CPU/memória para começar (`MAX_CPU` 70%, `MIN_FREE_GB` 6) são os
do relatório 9.8 (propõe 30%); o `package.json` já passa `--min-free-gb=4`
para o portão (`package.json`, script `perf:gate`).

**Clock da GPU: registrar, não supor.** Em cada cenário na RTX: um
`nvidia-smi --query-gpu=clocks.gr,clocks.max.gr,pstate,clocks_throttle_reasons.active,temperature.gpu,power.draw,utilization.gpu --format=csv,noheader -lms 250`
em processo filho do script do portão, junto da série de GPU; aquecer até
`clocks.gr` ≥ 90% de `clocks.max.gr` por 2 s antes de zerar; marcar a janela como
**inválida** se o clock cair abaixo disso durante a captura. Travar o clock
(`-lgc`) exige administrador e é configuração do sistema: fica como opção para o
jogador, junto da alternativa "Preferir desempenho máximo" no painel da NVIDIA
(que eu não verifiquei).

**Ligação ao `perfBudget.ts`.** `GATE_BUDGETS` (`perfBudget.ts:84–97`) tem só
`max`/`min` absolutos. Para GPU e ritmo: uma segunda tabela (por exemplo
`RTX_BUDGETS`) avaliada **só** quando a etiqueta do renderizador é a RTX e o clock
estava válido, e entradas `warn` até a linha de base da fase 0 existir (relatório
9.6: as metas são "de partida"); a catraca continua só descendo.

### 3.4 Testes de escala por contadores

**O padrão já existe no repositório:** contadores de módulo (`export const padsWork
= { rings: 0 }`, `src/world/buildings/pads.ts:72`; `kerbWork = { edges: 0 }`,
`src/world/poleLines.ts:177`) lidos por `tests/perf/budgets.spec.ts` contra
`COUNT_BUDGETS` (`perfBudget.ts:63–76`), com tabela e `why`. A base teórica são
as duas fontes de "função de custo": Algorithmic Profiling (contar repetições de
laço contra o tamanho da entrada e ajustar) e `Complexity()` do Google Benchmark
(`SetComplexityN`, ajuste de O(N)…).

**Forma proposta (a mesma das sondas B1/B2):** um spec em `tests/perf/`, com a
`closedGrid(n)` de `tests/sim/agents/population.spec.ts:27` (hoje privada ao spec;
terá de ser extraída para `tests/sim/support/`), n ∈ {6, 12, 24, 36}, mesma
população (400/400), e contadores por passo e por edição:
- por passo: controladores avançados, faixas percorridas na limpeza, entradas
  de `entryLanes` recriadas, cruzamentos ordenados;
- por edição de uma via isolada: trechos e cruzamentos visitados, células
  refeitas (fases 1 e 2).
O critério não é "igual" (um contador pode legitimamente crescer), é a
**inclinação do ajuste log-log** contra o lado da grade: `≤ ε` (por exemplo 0,1)
para os que devem ser independentes do mapa. Exemplo do que isso teria pego: o
estágio 1 da B2 tem 1 225 controladores com sinal na 36×36 e 25 na 6×6; um
contador `controllersStepped / passo` teria inclinação ≈ 1 (≈ 2 em área) e
reprova, e deve ficar ≈ 0 depois da fase 1. Determinístico, sem relógio, roda no
`npm run check`. O tempo (`passo p50 36×36 ≤ 1,3 × 6×6`) continua na sonda
(`scripts/bench-sim.mjs` → `tests/bench/pipeline.spec.ts`, 1 worker) porque é
tempo. A API de tempo por estágio já existe: `StepOptions.timings`
(`src/sim/pipeline.ts:28`).

**Custo do contador.** Um `xWork.n++` por iteração de laço quente não aloca e
é praticamente de graça, mas é estado global mutável: o spec deve zerar antes e
depois, e o contador não pode ser lido pelo jogo (só testes e portão).

---

## 4. Riscos e o que medir

1. **Existência da extensão em outros ambientes.** No painel do app a extensão
   está presente (B3 do relatório). No Chrome sem interface do portão (iGPU,
   `--use-angle=d3d11`) não verifiquei. O instrumento deve tolerar `null`
   (como o r186 faz: `warn` e `trackTimestamp = false`) e gravar
   `gpuTimer: 'indisponível'` no resultado em vez de zeros.
2. **O número pode incluir a GPU esperando a CPU.** `TIME_ELAPSED` é a diferença
   de dois carimbos na fila (Khronos, ANGLE `Query11.cpp`). Se o Chrome entrega
   os comandos do quadro aos poucos enquanto o JavaScript do three ainda os
   emite, os vazios entre submissões entram no tempo. As fontes lidas
   (documento do command buffer do Chromium) **não dizem** quando o cliente
   descarrega a fila (só que o cliente "pode escrever muitos comandos com pouca
   ou nenhuma comunicação" e avisa a GPU ocasionalmente). Medida que resolve:
   comparar a consulta externa com a **soma** das consultas por passe (3.1) numa
   cena parada; diferença grande = ociosidade; e correlacionar com
   `utilization.gpu` do `nvidia-smi`.
3. **Latência dos resultados.** O Khronos não garante quantos quadros. Medir a
   distribuição de "idade em quadros quando fica pronta" (mínimo, p99) para
   escolher o tamanho do anel; se o p99 for maior que o anel, `puladas` sobe.
4. **Intervalo de rAF não é apresentação.** Mede quando a thread principal começou
   a rodar o quadro, não quando a tela mostrou. Se o compositor/GPU atrasam, o
   Chrome atrasa o próximo rAF (isto é prática conhecida, **não confirmada
   por fonte que li**); para saber, comparar o p99 do intervalo com o p99 de GPU
   num cenário limitado por GPU (resolução 2560×1080) e num limitado por CPU.
5. **O clock da RTX.** Parada em P8/210 MHz (medido aqui), 2190 MHz de máximo: um
   quadro pode ser medido em 5× o valor "de jogo" só por isso (B3: 52,7 ms). O
   D3D11 só marca `Disjoint` por descontinuidade do contador; **não sei** se
   uma mudança de P-state marca. Medir: contar `disjuntas` durante o
   aquecimento (de 210 a 2190 MHz) com o `nvidia-smi` em paralelo; se o flag não
   dispara, a janela de clock tem de ser validada só pelo `nvidia-smi`.
6. **Overhead do instrumento.** Medir CPU/quadro com e sem o timer, em 400/400,
   mediana de 5 pares intercalados; aceitar < 0,05 ms ou não ligar por padrão.
7. **Dev × build.** O portão mede o servidor de desenvolvimento (3.3). Pode
   esconder ou inventar diferenças de tempo de compilação de shader e de
   alocação; manter a regra de "dizer qual servidor" e, quando possível,
   repetir um cenário no build (4180) com os contadores lidos por
   `window.__roadcraft` (existente em produção).
8. **Variância entre rodadas já vista:** 1,7× entre rodadas iguais (P70, citado
   no relatório 5.14). Com isso, o limiar de ruído de 1% do Criterion está
   longe da realidade desta máquina; o limiar inicial deve ser **calibrado**
   com A contra A (rodadas idênticas intercaladas): a largura do IC da razão
   A/A é o piso do que o portão consegue detectar.
9. **Windows 10 sem Thread Director** (F68 do relatório): rodadas mais numerosas
   em vez de rodadas mais longas; já adotado acima.
10. **Quadros em segundo plano.** O painel escondido corta o rAF (MDN) e a GPU
    baixa o clock: o portão deve abortar o cenário se `document.hidden` ou se o
    intervalo médio passar de 100 ms, em vez de gravar o número.

**O que medir para validar o instrumento (aceite da fase 0):** (a) GPU p50 de uma
cena parada com coeficiente de variação < 3% em 5 rodadas com clock válido;
(b) A contra A com IC da razão contendo 1 e largura registrada; (c) a soma por
passe ≈ consulta externa (± 10%); (d) `puladas` < 1% e `disjuntas` registradas;
(e) contadores de escala: inclinação medida hoje para cada contador (o "antes" da
fase 1).

---

## 5. O que NÃO foi possível ler (ou só em resumo)

- **Khronos, `EXT_disjoint_timer_query_webgl2`**: a página só tem a IDL e remete à
  extensão de base; as regras de aninhamento e de `GPU_DISJOINT_EXT` vieram do
  texto OpenGL (que li) e da página de WebGL 1 (que li).
- **Código do Chromium** que expõe a consulta ao WebGL, e como o Chrome descarrega o
  command buffer (documento lido não diz): lacuna aberta, ver risco 2.
- **ANGLE `Query11.cpp`** e **stats-gl `core.ts`**: lidos por extração do WebFetch
  (descrição de fluxo e trechos curtos), não o arquivo cru.
- **`r3f-perf`, `three-perf`, `gl-bench`**: implementação do timer não lida.
- **Mozilla**: o código do Perfherder (`treeherder`) não foi lido; o método vem do
  artigo ICPE Companion 2025 (cita "no mínimo 12 anteriores e até 11
  posteriores"); os limiares do t fixos não aparecem nos textos que li.
- **Kalibera & Jones**: seções 6.1–8 e 9.2–9.4 (estimadores de variância, ANOVA)
  não lidas em detalhe. **Mytkowicz**: seções 5–6 não lidas com atenção.
  **Algorithmic Profiling**: só resumo e introdução.
- **Google Benchmark**: issue #1051 (origem do "~40%") e `random_interleaving.md`
  completo além do que a ferramenta extraiu (há limites de citação). A página
  `user_guide.md` voltou sem a seção `oAuto/oNSquared` por nome.
- **NVIDIA nvidia-smi**: lido até o caractere 100 000 de 177 965; o resto
  (inclui a seção de clocks_event_reasons completa) não lido. NVIDIA
  "Analysing Stutter": lido em resumo da ferramenta, sem data visível.
- **Event Timing / INP** (latência do gesto até o quadro, item 10.7 do relatório):
  não lido nesta pesquisa.
- **Painel da NVIDIA ("Preferir desempenho máximo") e `SetStablePowerState` do
  D3D12**: não verifiquei fonte; só `-lgc` (que exige administrador) está documentado
  acima.
