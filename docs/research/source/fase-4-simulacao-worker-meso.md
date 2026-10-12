# Pesquisa da fase 4 — simulação em worker, níveis de simulação (micro, micro grosso, meso, agregado) e rotas

Pesquisa de 2026-10-11, só leitura de código. Ramo `agente/pesquisa`, a partir de
`planeta-esfera` `27a7cb48`; todo `arquivo:linha` é desse commit. Complementa as
seções 3.5, 3.6, 4.6, 4.7, 5.3, 5.12 e 6.5 do
`docs/relatorio-desempenho-mapas-enormes-2026-10-11.md` (fontes F3, F8, F10–F15, F57) e
o bloco E (fase 4) do `PROMPT-PENDENCIAS.md`. Aceite do PROMPT: `defects.spec` igual
na vista; fluxo meso dentro de ±10% do micro; maior população sustentada a 4×, antes
e depois; população sem teto fixo (decisão 2 do jogador).

**Como as fontes foram lidas.** Páginas e código de terceiros: WebFetch (a página ou o
arquivo convertido em texto e respondido por um modelo pequeno a um pedido meu;
onde a resposta disse "não consta", virou lacuna). PDFs: baixados pela ferramenta e
lidos como texto com `pdftotext` — a tese de Burghout (KTH, 2004) foi lida **no texto
completo** (4 373 linhas) nos capítulos 3 e 4 e nas partes do 5 citadas; o artigo de
Goldberg e Harrelson (ALT), o de Delling et al. (CRP, SEA 2011) e o de Kring et al.
(DHPA\*) foram lidos como texto. Código do repositório: lido por mim. Nada foi rodado.

---

## 1. Perguntas que a fase 4 precisa responder

1. O que o desenho e a interface leem hoje do `SimWorld`, e o que escrevem nele a
   thread principal e os editores? Ou seja: qual é a superfície de um protocolo
   principal ↔ worker?
2. Como uma simulação em worker entrega um estado que o desenho interpola (Gaffer on
   Games), e quem manda no relógio?
3. Que modelo de tráfego mesoscópico (SUMO, Mezzo, MATSim) cabe neste jogo, com que
   parâmetros e como se calibra contra o micro (aceite ±10%)?
4. Como um veículo passa do micro ao meso e de volta sem criar ondas de choque (a
   literatura de simulação híbrida), com a região micro seguindo a câmera?
5. O IDM aceita passo maior (a "faixa micro grossa")? E os pedestres, que já têm um
   `COARSE`?
6. Que roteamento (A\* com heurística admissível, ALT/marcos, HPA\*, CRP) combina com o
   Dijkstra atual e com o grafo que muda a cada edição?
7. O que o Unreal Mass faz de níveis de simulação e que parte serve a um orçamento por
   contagem?

---

## 2. Fontes lidas

### 2.1 Simulação em worker, instantâneos e passo fixo

**Glenn Fiedler (Gaffer On Games), "Fix Your Timestep!"** —
https://gafferongames.com/post/fix_your_timestep/ : o renderizador "produz tempo" e a
simulação o "consome" em passos `dt` fixos; o resto do acumulador é `alpha = acumulador /
dt` e o estado desenhado é `atual·alpha + anterior·(1 − alpha)` (slerp para
quaterniões); a "espiral da morte" se evita limitando o tempo de quadro (`if
(frameTime > 0.25) frameTime = 0.25`) ou o número de passos; o artigo diz que sem
interpolação se mostra um estado "levemente diferente do tempo de render" e que a mistura
implica que o desenho fica **atrás** do passo mais novo (a frase explícita "atraso de um
passo" não consta). É exatamente o que `src/sim/clock.ts` faz (`MAX_FRAME = 0,25`,
`MAX_SUBSTEPS = 5`, `advance` devolve o `alpha`).
**Gaffer, "Snapshot Interpolation"** — https://gafferongames.com/post/snapshot_interpolation/ :
envia-se o estado **visual** da simulação inteira e reconstrói-se do outro lado; o
desenho roda **atrás** do instantâneo mais novo e interpola entre os dois que o
cercam ("um pouco de latência a mais por suavidade"); extrapolar falha para corpos
rígidos; a profundidade do buffer é pensada para perda de pacotes (3× o intervalo de
envio com 2–5% de perda; 350 ms a 10 pacotes/s, 150 ms a 30, 85 ms a 60); posição por
**spline de Hermite** com a velocidade de cada amostra remove o tremor de amostras a 10 Hz
(à custa de mandar velocidade), orientação por `slerp`. O artigo é sobre UDP — numa
mensagem entre threads não há perda, mas há *jitter* de agendamento.
**Gaffer, "State Synchronization"** — https://gafferongames.com/post/state_synchronization/ :
não manda tudo: um **acumulador de prioridade** por objeto (jogador 1 000 000, cubos
interagindo 100, parados 1), ordenado do maior para o menor, preenchido até o orçamento do
pacote; o acumulado só zera para quem foi enviado, e quem não coube vai primeiro no
seguinte; delta contra o último estado confirmado (5 bits de deslocamento da base);
objetos em repouso mandam um bit `at_rest` e **não mandam velocidades**; quem acabou de
parar ganha prioridade até a confirmação ("compromete" a posição final). O exemplo limita
a 64 atualizações por pacote de 901 cubos.
**Factorio, FFF #421** — o robô guarda uma **intenção de movimento** e o desenho
interpola por ela; a atualização real roda no instante de chegada e no máximo a cada 20
ticks em movimento e 60 parado (≈ 15% mais rápido no save de escritório): é o mesmo
raciocínio de um veículo meso com horário de saída, desenhado por interpolação
(ver 2.2).
**Treiber, "IDM"** — https://traffic-simulation.de/info/info_IDM.html : integração
balística (`x += v·Δt + ½·a·Δt²`, `v += a·Δt`, com parada exata se `v + a·Δt < 0`);
**"qualquer passo de atualização abaixo de 0,5 s levará essencialmente ao mesmo
resultado"**; semáforo e parada = um veículo parado virtual de comprimento zero na linha
de parada; valores da página: `T` 1,5 s (carro) e 1,7 s (caminhão), `s0` 2 m. A página
trata do IDM puro; o resto do passo do jogo (admissão, reservas, sinais) não está nela.

### 2.2 Modelos mesoscópicos

**SUMO, modelo mesoscópico (MESO)** — https://sumo.dlr.de/docs/Simulation/Meso.html (lido
inteiro por extração dirigida). `--mesosim`; "até 100× mais rápido" que o micro; baseado no
modelo de Eissfeldt; cada aresta é dividida em filas ("segmentos") de igual comprimento
(`--meso-edgelength`; a página cita 100 m na seção da GUI, sem padrão na opção);
**FIFO**; o horário de saída depende do estado da fila atual e da seguinte, do tempo
mínimo de viagem (velocidade máxima e limite) e, na última fila, da junção; cada fila é
*livre* ou *engarrafada* e o espaçamento mínimo (`headway`) tem quatro valores — `tauff`
1,13 (livre→livre), `taufj` 1,13 (livre→engarrafada), `taujf` 1,73 (engarrafada→livre),
`taujj` 1,4 (propagação do engarrafamento para trás; fila cheia: nº de veículos ×
`taujj`) —, divididos pelo número de faixas e multiplicados pelo `tau` do tipo; `tauff`,
`taufj` e `taujf` são espaços líquidos (os brutos somam o comprimento do líder);
`--meso-jam-threshold` (padrão −1: ocupação de fluxo livre calculada à velocidade-limite;
> 0 é a fração direta, 1 desliga); a velocidade atual **não** é modelada (aceleração e
velocidade de partida não valem); o controle de junção é desligado por padrão
(`--meso-junction-control false`); com `true` as junções são modeladas como no
microscópico simplificado; `--meso-junction-control.limited`: sem controle enquanto a fila
de destino está livre; **penalidade de semáforo** `--meso-tls-penalty`: tempo de viagem `p ·
(vermelho² + vermelho) / (2 · ciclo)` com `p` de 1 (sem coordenação) a ≈ 0 (coordenação
perfeita), avisa se a aresta antes do semáforo tem < 15 m; `--meso-tls-flow-penalty`:
`headway = headway padrão / fração de verde`, a fração `= min(1, (ciclo − vermelho) / ciclo)
/ penalidade`; `--meso-minor-penalty` (tempo fixo em ligações sem prioridade);
`--meso-overtaking`; `--meso-lane-queue` (uma fila por faixa) para bicicletas e vias que
excluem carros; **não** suporta saída por faixa, detectores E2/E3, travessia em sentido
contrário nem subfaixas. A página **não** traz padrão para `--meso-edgelength`,
`--meso-overtaking`, `--meso-minor-penalty`, nem orientação de calibração.
**MATSim, `QueueWithBuffer.java`** —
https://raw.githubusercontent.com/matsim-org/matsim-libs/main/matsim/src/main/java/org/matsim/core/mobsim/qsim/qnetsimengine/QueueWithBuffer.java
(extração dirigida). Cada faixa/ligação tem três partes: `vehQueue` (veículos em
viagem a velocidade livre), `buffer` (prontos para cruzar o nó) e `flowcap_accumulate` (o
orçamento de fluxo); o horário de saída é `agora + tempo de viagem livre` **arredondado
para baixo ao passo de tempo**; um veículo passa da fila ao buffer só se já passou do
horário de saída **e** o acumulador de fluxo é positivo (`veículo.PCU / eficiência` é
debitado); a capacidade de fluxo por passo é `capacidade por segundo × passo`; o
**armazenamento** é `comprimento × faixas / célula efetiva × fator`, nunca menos que o do
buffer nem que o fluxo que a viagem lenta exige (`tempo livre × fluxo`); um **transbordo**
(spillback) é simplesmente `usedStorageCapacity < storageCapacity` falso: a ligação cheia
não aceita mais entradas; o código tem `bufferLastMovedTime` para detectar impasses
("deadlocks") e o texto observa que a ligação seguinte é ativada cedo demais pelo buffer.
Limitações citadas por um artigo de calibração: o fluxo não cai com a densidade (satura
no valor de capacidade enquanto o seguinte estiver livre).
**Burghout, "Hybrid microscopic-mesoscopic traffic simulation"** (tese, KTH, 2004) —
https://kth.se/polopoly_fs/1.742065.1600688570!/hybrid%20mesoscopic.pdf (texto completo).
**Capítulo 3 (Mezzo):** a ligação tem uma parte **de percurso** e uma **de fila**: a fila
começa no nó de jusante e cresce para montante quando a entrada excede a saída; o veículo
que entra no percurso ganha velocidade `V(k)` da **densidade só da parte de percurso**
("para não contar duas vezes o atraso"); seu horário de saída mais cedo ordena o veículo,
e "a fila contém, no instante `t`, os veículos com horário mais cedo menor que `t`";
movimentos de curva são **servidores de fila** com intervalos estocásticos (normal
truncada) ligados ao fluxo de saturação, **um servidor por faixa da ligação de saída**, com
um **limite de olhar para trás** da fila (p.ex. 6 veículos) para a fila de uma curva
bloquear as outras; função velocidade-densidade `V(k) = Vlivre` para `k < kmin`, `Vmin +
(Vlivre − Vmin)(1 − ((k − kmin)/(kmax − kmin))^a)^b` entre, `Vmin` para `k > kmax` (a forma
do DYNAMIT, com `Vmin` para a fila dissipar e `kmin`, `kmax` observados); **simulação
dirigida por eventos** (3.9.1): o meso é "ideal" para eventos porque só se registram
entradas e saídas; a lista de eventos chama cada `Action` e ela se reagenda; já o micro
é de tempo discreto porque é difícil prever o próximo evento de cada veículo e há risco de
impasse; a rede de 2 173 ligações e 1 181 nós de Estocolmo rodava 3× mais rápido que o
tempo real num Pentium 1 GHz com 256 MB (sem otimização). **Capítulo 4 (MiMe, o híbrido):**
requisitos — rede e escolha de rota consistentes (um **módulo comum** com grafo,
tempos de viagem e rotas, e "ligações virtuais" para os caminhos dentro da outra região),
dinâmica consistente nas fronteiras, desempenho similar onde os dois são suficientes
("para as instalações bem simuladas pelos dois, resultados quase iguais **no nível meso**
de agregação"), comunicação mínima; **fronteira num nó fictício no meio de uma ligação,
com tradução instantânea** (a "zona de transição" com controle duplo foi descartada como
complicada); **meso→micro**: o micro avisa quando a entrada bloqueia e desbloqueia (a fila
do micro até a fronteira para o meso) e manda a densidade/fluxo perto da fronteira (calcula a
onda de choque que segue no meso); o veículo ganha as variáveis que o meso não tem — faixa
(entre as candidatas, sem faixas proibidas nem sem ligação com a rota, a de **maior
folga**), intervalo (vem do meso), **velocidade** (3 regimes pelo intervalo `th` ao líder
da faixa: ≤ `t2`, `V = V_líder`; entre `t2` e `t3`, `V = α·V_desejada + (1 − α)·V_líder`
com `α = (th − t2)/(t3 − t2)`; > `t3`, `V = V_desejada`; limiares calibrados com dados de
campo) e aceleração 0; os métodos antigos (MITSIMLab: velocidade desejada ajustada ao
comprimento da fila de entrada; VISSIM: velocidade pelo líder e o espaço à frente)
carregam o veículo mais rápido que o da frente e geram frenagem forte nos 2 primeiros
segundos e **capacidade da entrada reduzida** (≈ 2 000 veic/h/faixa contra > 2 600 com
tempos determinísticos); **micro→meso**: o micro segue um **veículo virtual** na
continuação da ligação, na posição `fim do trecho micro + v_virtual · (t_agora −
t_saída)` e com a velocidade que o meso atribuiu ao último a sair (função da densidade
do meso), o que exige guardar o instante da última saída por faixa; o meso avisa o micro
quando a ligação a jusante bloqueia e desbloqueia. **Calibração (5.4.1):** rede de teste
de 5 km (10 trechos de 500 m, 2 faixas, demanda 3 000 veic/h, incidente fechando as duas
faixas por 5 min); servidores de curva calibrados contra o micro com **10 repetições** (15
min de pico) para **intervalo médio de 1,44 s/faixa e desvio 0,1 s** (capacidade média
2 500 veic/h/faixa, desvio 360), e a curva velocidade-densidade ajustada à mão, com `Vmin` = 6
m/s. **Resultado na rede de Brunnsviken (5.5):** erro quadrático médio (RMSE) por 15 min
de 75,4 (micro), 82,5 (meso) e 80,6 (híbrido) veículos por ponto; erro normalizado
(RMSNE) 9%, 14% e 12%; viés (MNE) 3%, 6% e 6%; Theil U 0,051/0,055/0,054 — "os três
modelos ajustam bem".
**Burghout e Koutsopoulos, "Hybrid Traffic Simulation Models: Vehicle Loading at Meso-Micro
Boundaries"** (KTH, CTR 2006) — https://intra.kth.se/polopoly_fs/1.742068.1600688336!/ctr2006_06.pdf :
repete os requisitos e a fronteira no meio da ligação com uma entrada e uma saída;
carregar o veículo com velocidade incompatível com o intervalo gera "frenagem e aceleração
excessivas, volatilidade e **entrada atrasada**, capacidade reduzida e ondas de choque
para montante"; mostra a correlação entre as velocidades de veículos consecutivos
medidos na Essingeleden: alta para intervalos de 0–3 s, decai de 3 a 6 s; o método de três
regimes é o proposto.

### 2.3 Rotas

**Goldberg e Harrelson, "Computing the Shortest Path: A\* Search Meets Graph Theory"**
(SODA 2005; texto lido em PDF de curso de Princeton,
https://www.cs.princeton.edu/courses/archive/spring06/cos423/Handouts/GH05.pdf).
Um potencial `π` é **viável** se o custo reduzido `l(v,w) − π(v) + π(w)` é ≥ 0 em todo
arco; com `π(t) ≥ 0` viável, `π(v)` é um limite inferior da distância `v→t`, e A\* é o
Dijkstra com os custos reduzidos (Pohl); o máximo de potenciais viáveis é viável
(Lema 2.1); **marcos (ALT)**: guardar as distâncias de e para poucos vértices e usar a
desigualdade triangular como limite inferior; escolha de marcos (mais distante, plana
por setores, versões otimizadas); 16 marcos, subconjunto de 4 por consulta; "para redes
viárias, os limites euclidianos exatos **quase não ajudam**, mesmo para o comprimento por
distância" (os autores só obtiveram ganho escalando-os além do exato, o que dá caminhos
até > 10% mais longos); mesmo com **um** marco, ALT supera os códigos sem marcos; vale
para qualquer grafo direcionado; os limites precisam de uma fila de prioridade comum
(heap) quando os custos reduzidos podem ser negativos.
**Delling, Goldberg, Pajor, Werneck, "Customizable Route Planning"** (SEA 2011; PDF em
https://www.microsoft.com/en-us/research/wp-content/uploads/2011/05/crp-sea.pdf). Três
estágios: **pré-processamento independente da métrica** (só a topologia), **customização
da métrica** (segundos) e **consulta** (≈ 1 ms em 18 M vértices com 4 núcleos); a
topologia (comprimento, categoria, curva) e a métrica (custo de atravessar) são separadas;
um grafo **sobreposto** (overlay) de cada célula guarda uma "clique" com as distâncias
entre os vértices de fronteira da célula (partição PUNCH); métodos com forte hierarquia
(CH, reach, SHARC, transit nodes, hub labels) são **sensíveis à métrica**; "se uma única
aresta muda de custo recalcula-se **no máximo uma célula por nível**, e o MLD-4 faz isso em
menos de um milissegundo"; customizar tudo (trânsito em tempo real): 5 s (MLD-2, 20 MB,
< 5% do grafo); CH para uma mudança pequena de métrica reconstrói em ~1 minuto, e CH
"pode ficar impraticável em espaço e tempo para métricas ruins". Custos de curva: cada
tipo de interseção é guardado uma vez (milhares de tipos).
**Kring, Champandard, Samarin, "DHPA\* and SHPA\*"** (AIIDE 2010) — lido como texto. Resume
o **HPA\*** de Botea, Müller e Schaeffer (2004): o algoritmo de construção particiona o
terreno em **clusters disjuntos**, cria nós abstratos nas fronteiras e um **cache de
pesos** entre os nós abstratos de cada cluster; em tempo de execução, "a construção roda
**localmente nos clusters danificados** e refaz os nós abstratos e a parte do cache";
o DHPA\* guarda um cache extra (caminho mais curto de cada nó do cluster a cada nó
abstrato; `O(b·n²·c²)` entradas, um fator `n` mais que o HPA\*), ≈ 11× mais rápido
na melhor busca e 1,9× em média, com < 1% de sub-otimalidade em relação ao HPA\*; o
mapa maior dos testes tem cache de 4,2 MB (DHPA\*) contra 142 KB (HPA\*). A **fonte
primária do HPA\*** (Botea et al., *Journal of Game Development* 1(1), 2004) **não foi
lida**: os endereços tentados deram 404; o número "até 10× mais rápido, < 1% de erro"
que o relatório (F12) cita aparece só em resumos de busca.
**Emerson, Game AI Pro, cap. 23 (flow field tiles)** e **Delling et al. (resumo)** —
descritos no relatório (F12, F13); não relidos.

### 2.4 Níveis de simulação em engines

**Unreal Engine, "Overview of Mass Gameplay"** —
https://dev.epicgames.com/documentation/en-us/unreal-engine/overview-of-mass-gameplay-in-unreal-engine
(extração dirigida): o sistema LOD devolve **quatro valores** — Alto, Médio, Baixo,
Desligado — e uma *significância* de 0,0 a 3,0; há distâncias e **contagem máxima por
nível**; os clientes são LOD de representação, de **simulação** e de replicação; o de
simulação "equilibra a carga agrupando entidades do mesmo nível em chunks" e permite
**frequência de atualização variável**; cada nível pode ter representação diferente (ator
de alta resolução, ator simples, instância de malha estática, nenhuma) com um subsistema
que faz as transições e recicla/reaproveita atores. A página **não traz** valores padrão
de distância/contagem/frequência, histerese ("buffer"), nem os nomes dos processadores.
**Unity, Job System** (fase 3) e **Factorio #421** (acima): coerentes com "orçamento
por contagem".

### 2.5 Código do repositório lido

`src/sim/clock.ts`, `pipeline.ts`, `world.ts` (fase 1), `pose.ts:1–120`, `vehicles/spawn.ts`
(inteiro), `vehicles/archetypes.ts`, `drive/tactical.ts:50–209`, `agents/walk.ts:360–372,1840–1880`,
`snapshot.ts`, `params.ts:60–75,164–205`, `editor/persistence.ts:450–470`, `main.ts` (usos de
`sim.`), `render/agents.ts`, `tests/sim/agents/defects.spec.ts`.

---

## 3. O que se aplica a este código

### 3.1 A superfície entre a thread principal e o `SimWorld`

**O que o desenho lê** (`grep` em `src/render/*`): `render/agents.ts` usa
`world.vehiclesInIdOrder()`, `world.lanelet(...)` (a geometria da faixa, para a pose),
`world.pedViews` (já é uma **vista publicada**, "na ordem de id, ao fim de cada tick",
`world.ts:105–110`), `world.clock.time`, `world.ambient.parked`, `world.net`/`doc`;
`render/signals.ts` lê `world.controller(node)`, `graph.junctions` e as revisões de
rede; `renderer.ts` lê `sim.city.minutes`, `sim.city.transit`, `sim.pedViews`, e
**escreve** `sim.focus` (a vista, `world.ts:204–215`); `roomLamps.ts` lê `doc.buildings`;
`playEffects.ts` lê `pedViews`. Dos veículos o desenho usa (contagem de usos em
`agents.ts`, `vehicleSignals.ts`, `carBody.ts`, `vehicleModels.ts`): `id`, `archetype`
(forma, assentos, id), `color`, `s`, `v`, `lanelet`, `lateral`, `lateralSlope`, `age`,
`prev` (o estado do tick anterior), `free` (fora da pista: vaga), `kerbStop` (porta
aberta, assento), `doors`, `people` (ocupantes), `route`, `desiredLane`, `laneIntent`
(setas), `slain`. **A pose** (`pose.ts:1–120`, `vehiclePoseInto`) é calculada **na thread
principal** a cada quadro a partir da faixa (`lane.centre.sampleAt`), `s`, `lateral`,
`lateralSlope` e `prev`, e interpola o ângulo "pelo caminho curto" — em um worker isso
vira função do worker ou obriga a réplica da geometria das faixas no desenho.
**O que o resto escreve em `SimWorld`:** `main.ts` toca em ~30 campos (contagens do
painel `trafficCount`/`pedestrianCount`, `demandMultiplier`, `trafficIntensity`,
`clock.speed`/`paused`, `ambient.source/enabled/reset`, `usePedestrianEngine`, `reset`,
`rebuildTopology`, `auditLevel`) e fora do `main.ts` só ~20 arquivos importam o `SimWorld`:
`actionsWiring.ts`, `frameLoop.ts`, `ui/inspector.ts`, `ui/roads/junctionPanel.ts`,
`weaponsLab.ts`, `editor/persistence.ts`, e `world/{doc,lanelets,walkways}.ts` (que importam
tipos/constantes de `sim`), mais os arquivos de `render/` acima. O número é pequeno: o
protocolo é viável.

**Dimensão do instantâneo (conta minha).** 1 000 veículos × 12 campos `float32` = 48
KB por tick; a 4 ticks por quadro e 60 quadros/s, ≈ 11,5 MB/s — desprezível como
transferência (a Gaffer chegou a 25 KB por pacote para 900 cubos); o que pesa é o
**tempo de serializar e de aplicar**, não a banda. Pedestres: `pedViews` já é o formato.

### 3.2 Forma do protocolo

Das fontes (Gaffer, Factorio, Unity) e do código:

- **Quem manda no relógio.** `SimClock.advance` (`clock.ts:44–66`) já faz o acumulador,
  `snapToTicks`, o teto de 5 passos e devolve `alpha`. O mais simples é a thread
  principal continuar dona dele e **pedir passos** (`advance(n)`) ao worker, que responde com
  o instantâneo do último tick e o anterior (como `prev`/`atual` hoje); o desenho fica um
  quadro atrás. Um worker que roda livre com cronômetro próprio (sem pedir) exige o *buffer
  de interpolação* da Gaffer (2–3 instantâneos) e lida pior com pausa e velocidade 4×.
- **Estático × dinâmico.** O que não muda por tick (`archetype`, `color`, ocupantes,
  rota) vai uma vez no nascimento e em eventos (porta, assento, fim); o que muda todo tick
  (x, y, ângulo, `s` ou velocidade para a roda, `lateral`, bits de luz de freio/seta/pisca,
  abertura de portas) vai em *slots* fixos por veículo (como o esboço do relatório 4.6);
  **repouso**: um veículo parado fora da vista pode não ser reenviado (o `at_rest` da
  Gaffer: não manda velocidade para quem está parado; e a prioridade extra "até
  confirmar" só importa para rede com perda).
- **Prioridade por distância e contagem.** O *acumulador de prioridade* da Gaffer serve
  para escolher **quem** é enviado quando há limite: aqui, o orçamento de envio não é de
  banda mas de CPU de aplicação no desenho — enviar só os veículos que o desenho
  mostra (a vista, `focus`) com o resto contado, não enviado.
- **Entrada.** Edições chegam como **comandos** (fase 2: diff por registro) e o worker
  refaz a topologia das células sujas (`TopologyCatchUp` passa para o worker; hoje a
  simulação para durante o preparo fatiado, `frameLoop.ts:133–183`). O `focus` (a vista) vai
  a cada quadro (pequeno). As contagens do painel e velocidade/pausa também.
  Consultas síncronas da interface (`ui/inspector.ts`, `junctionPanel.ts`, as Ações de
  pistola e bomba) viram mensagens assíncronas ou leem o último instantâneo.
- **Determinismo.** `world` e `sim` não chamam `Math.random` (`core/rng.ts`) e o passo é
  determinístico; com o worker, a mesma lista de comandos e o mesmo `focus` por tick dão
  o mesmo resultado — o `hashSim` (`snapshot.ts`) compara a thread principal com o
  worker; com LOD (3.3) o resultado **passa a depender da câmera** (decisão a registrar).
- **Pose no worker.** Calcular a pose lá (a geometria das faixas já está no worker) e
  mandar x/y/ângulo/lateral evita replicar `LaneletGraph` no desenho; o ângulo é
  interpolado "pelo caminho curto" no desenho (a mesma regra de `pose.ts`). A elevação
  do convés (`elevationAt`, `render/agents.ts:229`) hoje vem do renderizador/terreno: o
  worker manda segmento + `s`, ou o desenho calcula só `z`.

### 3.3 Níveis de simulação

Quatro níveis, como no relatório 3.5/6.5, com o que as fontes acrescentam:

1. **Micro (vista + margem)**: o passo atual a 1/60 s. Orçamento **por contagem**, como o
   Mass (distância e **máximo por nível**): os N mais próximos da câmera, onde N é o que o
   quadro suporta, medido (aceite: maior N sustentado a 4×).
2. **Micro grosso**: o IDM aceita passo de até 0,5 s com o mesmo resultado (Treiber), mas só o
   *seguimento de carro*. O passo do jogo tem admissão por conflito, reservas e claims
   (`pipeline.ts:114–126`, `admission.ts`), troca de faixa e sinais; o passo maior
   desses precisa de teste próprio. Para pedestres o `COARSE = 4` já existe
   (`agents/walk.ts:372,1876–1879`: fora da vista, **um passo a cada 4 ticks, com 4 ticks de
   tempo e sem negociar com os outros**) — é o padrão a estender aos veículos, com o
   mesmo preço: o resultado fora da vista é aproximado.
3. **Meso**: filas (ver 3.4); evento a evento (Mezzo 3.9.1: "ideal para eventos porque só
   registra entradas e saídas"), o que também **combina com a fase 1** (dormir até o próximo
   evento) — o veículo meso é um item da lista de eventos, não um objeto atualizado.
4. **Agregado**: contagens por ligação e hora; só para células sem ninguém olhando há
   muito. Pedestres longe: `COARSE` e depois contagem por calçada.

**Ceilings.** `FLEET_CEILING = 1200` e `PED_CEILING = 1000` (`params.ts:185–186`) dimensionam
também os buffers de instância do desenho (comentário `params.ts:176–184`), e o painel limita a
400/400 (`persistence.ts:459–460`). "Sem teto fixo" separa três números: *existentes*
(milhares, meso/agregado), *simulados em detalhe* (os N do quadro) e *desenhados* (os
visíveis); só o último dimensiona os buffers do desenho.

### 3.4 Modelo meso para este jogo

Combinando SUMO, Mezzo e MATSim:

- **Estrutura.** Um item por faixa de ligação (a granularidade do grafo de faixas,
  `lanelets.ts`; SUMO tem opção `--meso-lane-queue` para bicicleta, Mezzo cria um
  servidor por faixa de saída): `fila` FIFO de `{ veículo, horário de saída mais cedo }`,
  comprimento, velocidade livre (limite × fator do arquétipo, como `spawnAt` já calcula,
  `spawn.ts:206–214`), `última saída`, e *armazenamento* =
  `comprimento / (comprimento do veículo + JAM_GAP)` (MATSim: `comprimento × faixas /
  tamanho de célula`; o jogo usa o comprimento médio por vez em `tactical.ts:108`,
  `m(4.8)`; `JAM_GAP = m(2)`, `params.ts:71`).
- **Fluxo.** Capacidade por intervalo mínimo entre saídas. Valores publicados:
  SUMO 1,13 s livre e 1,73 s depois de engarrafado, `taujj` 1,4 s para trás (÷ faixas);
  Mezzo calibrado contra o micro: 1,44 s/faixa com desvio 0,1 s (2 500 veic/h/faixa). Do
  parâmetro do jogo (conta minha): `T` de carro entre 1,0 e 1,4 s
  (`archetypes.ts:105,127,149,173`), comprimento 3,9–5,6 m, `s0` 1,8–2,1 m, velocidade
  de 50 km/h = 13,9 m/s dá `1/(T + (L + s0)/v) ≈ 1/(1,2 + 6,7/13,9) ≈ 0,6 veic/s ≈
  2 200 veic/h/faixa` — a ordem de grandeza dos 2 500 do Mezzo; **o valor para o meso do
  jogo deve ser medido no próprio micro** (protocolo do Burghout: 10 repetições, 15
  minutos de pico, média e desvio do intervalo).
- **Armazenamento e transbordo.** Fila cheia ⇒ a ligação de montante não libera o primeiro
  (MATSim `usedStorageCapacity < storageCapacity`; SUMO: `headway = nº de veículos ×
  taujj`; ambos propagam o engarrafamento para trás). O jogo tem a regra
  `hasDownstreamStorage` (`intersections/spillback.ts`, usada em `world.ts:634`) para o
  micro: deve ser a mesma regra, em fila.
- **Semáforos no meso.** As opções são: (a) *penalidade* de tempo de viagem do SUMO,
  `p · (R² + R) / (2 · C)` por semáforo, mais `tls-flow-penalty` (`headway / fração de
  verde`); (b) controlador de verdade acionado pelo tamanho da fila — o Mezzo diz que
  "detectores não podem ser simulados diretamente porque as posições não são conhecidas" e
  sugere que as fases de verde/vermelho virem eventos. O jogo tem controladores atuados
  (`signals/fsm.ts`) que dormem (fase 1); no meso, a demanda do estágio seria a fila da
  ligação (contagem), e o controlador seria o mesmo — mantém um único comportamento nos
  dois níveis.
- **Prioridade de movimento** (`--meso-minor-penalty`, `junction-control.limited`): usar o
  controle de junção só quando a fila de destino está engarrafada (SUMO limited).
- **Calibração** (aceite ±10%): Burghout mediu o híbrido com RMSE de 80,6 contra 75,4 do
  micro, RMSNE 12% contra 9%, MNE 6% contra 3% — o meso puro 14% e 6%: o critério de ±10% do
  PROMPT é **mais apertado** que o do Mezzo contra o MITSIM no corredor real (viés de
  3 a 6%, erro normalizado 9–14%); definir por fluxo médio por trecho **numa hora de
  simulação**, com a banda de ruído do próprio micro entre sementes.

### 3.5 Transições micro ↔ meso

Regras da literatura (Burghout 2004 e 2006) aplicadas às peças do jogo:

- **Fronteira no meio da ligação**, uma entrada e uma saída. A região micro do jogo segue a
  câmera (`focus`), então a fronteira **se move**; os veículos mudam de nível em massa
  quando a câmera salta ou voa (`flight.ts`, `lookAt`). Precisa de histerese (distância
  de entrada < de saída), um **orçamento de transições por tick** e prioridade pela
  distância (a lição do Assassin's Creed Unity, relatório F8, e da Mass: recriar o agente
  barato por completo sem o jogador perceber).
- **Meso→micro.** Reaproveitar o que o jogo já tem: `spawnVehicleAt` (`spawn.ts:250–306`,
  "como o SUMO insere", P100) escolhe a faixa utilizável, recusa se há corpo a menos de
  `JAM_GAP`, recusa se há pessoa na posição, dá a **velocidade de nascimento** do
  líder (`birthSpeed`, `spawn.ts:315–327`: busca binária da maior velocidade ≤ `usual` cuja
  aceleração IDM não passa de `−b`, a versão do jogo dos "3 regimes" do Burghout) e recusa
  se o seguidor teria de frear acima do conforto; a **faixa de maior folga entre as
  candidatas** é a regra do Burghout para a lacuna entre `spawnAt`/`spawnVehicleAt`. O
  veículo mantém o `id` (hoje `createVehicle` com `nextVehicleId++`).
- **Micro→meso.** Tirar o veículo do micro (`removeVehicle`, `world.ts:787–792`: solta
  sombra, ocupação e reservas) e entrar na fila da faixa com o horário de saída
  `agora + distância restante / velocidade livre`; a ordem de entrada preserva a ordem da
  faixa. O **veículo virtual** de Burghout (posição `fim + v·(t − t_saída)`) aplica-se
  aos veículos do micro perto da fronteira: o último saiu da faixa para o meso, e o seguidor
  do micro frea para um líder que já está no meso.
- **Pessoas dentro do veículo, ocupação de vaga, kerbStops** (`vehicles/kerbStops.ts`)
  e reservas (`claims`): devem ser resolvidos **antes** de baixar o nível (um veículo com
  `admittedConnector` ou `clearingConnectors` não baixa; `pipeline.ts:317–331`).
- **Rotas compartilhadas** (módulo comum do Burghout): a rota do veículo (`v.route`,
  alternando faixas e conectores) deve existir nos dois níveis; no meso, a rota como
  lista de ligações basta.

### 3.6 Rotas

**Estado.** `planTrip` (`drive/tactical.ts:120–201`) é Dijkstra sobre faixas e conectores
com troca de faixa: nós `{key, lane, changed, cost}` com `key` **string** (`keyOf`,
`tactical.ts:69`: `lane` ou `` `${lane}|c` ``), `Map<string,number>` para custo e pai,
heap de objetos com desempate por comparação de strings (`:71`); o custo de um conector
(`connectorCost`, `:102–112`) é `comprimento do conector/(limite × 0,65) + viagem × (1 +
densidade × 2,6) + curva`, onde a **densidade lê o runtime vivo da ligação seguinte**
(`w.rt(out.id).order.length / (out.length/m(4.8))`, **criando** a entrada do runtime
como efeito colateral). Observações sobre admissibilidade: o custo vivo é sempre ≥ o de
fluxo livre (`1 + densidade·2,6 ≥ 1`), então uma heurística que subestima o custo de
fluxo livre continua **admissível** quando há congestão; a heurística precisa ser calculada
na métrica de fluxo livre.

**Opções, pelas fontes:**
1. *A\* com heurística geométrica* (distância euclidiana ÷ maior limite de velocidade): é
   a mais simples, porém a fonte mais forte diz que em rede viária "limites euclidianos
   exatos quase não ajudam" (Goldberg–Harrelson); aqui o custo é tempo com limites
   diferentes e conectores, o que enfraquece mais. Útil, mas **não decisiva**.
2. *ALT (marcos)*: 16 marcos, 4 por consulta, com distâncias de/para cada marco **na
   métrica de fluxo livre**. Os limites ficam válidos enquanto as distâncias do grafo
   não **diminuem**; uma edição que **acrescenta** via (ou conector) pode encurtar caminhos
   e invalidar os limites (superestimam); uma que remove só os enfraquece. Logo os
   marcos precisam ser refeitos (16 Dijkstras do grafo, em worker) a cada revisão de
   topologia que acrescenta algo, e as consultas durante o intervalo usam a heurística
   geométrica ou o Dijkstra. Custo de memória: 16 × 2 × nº de nós × 4 B.
3. *Hierarquia por células (HPA\*/DHPA\*, CRP)*: encaixa na partição da fase 2: portais nas
   bordas das células, caches de pesos intra-célula **refeitos só nas células danificadas**
   (HPA\*: "a construção roda localmente nos clusters danificados"; CRP: "no máximo uma
   célula por nível" para uma aresta alterada). A métrica do jogo é *dinâmica* (a densidade
   muda a todo momento): o CRP separa **topologia** (pré-processamento) e **métrica**
   (customização em segundos), e o jogo pode customizar só a métrica de fluxo livre por
   célula e deixar a congestão viva para o refinamento de baixo nível.
4. *Contraction Hierarchies*: descartada (o relatório 3.6): sensível à métrica e a edições
   (CRP 2011: "pode ficar impraticável para métricas ruins"; "reconstrói em ~1 minuto uma
   mudança pequena").

**Antes de qualquer algoritmo, os dados** (relatório 5.12 e fase 1, 3.7): ids inteiros e
arrays tipados no lugar de `Map<string,…>`, nós sem alocação (um heap de índices,
`core/heap.ts` já existe com `push(item, key)`), chave de estado `(faixa, trocou)` como
inteiro `2·faixa + trocou`, e *nenhum* `w.rt()` com efeito colateral dentro da busca.
O volume: o estágio 2 da B2 sobe de 0,194 para 1,276 ms entre 6×6 e 36×36 (relatório
5.1); medir nós expandidos por rota antes e depois (aceite do relatório).

### 3.7 Validação da fase

- **`defects.spec`** (`tests/sim/agents/defects.spec.ts`, `measureDefects(city, segundos)`
  em `tests/sim/support/agentDefects.ts`) já mede, por cidade, pessoas paradas na faixa de
  pedestres, deslizes, saltos, impasses de junção, carro parado > 100 s: aceite "igual na
  vista" = rodar **a mesma bateria com e sem LOD/worker** com a vista fixada e comparar as
  métricas dentro da banda de ruído (um spec com `focus` em volta da cidade inteira deve dar
  o mesmo que hoje).
- **Fuzz** (`tests/fuzz/`, `simCheck.ts`) com e sem níveis.
- **Fluxo meso × micro** por ligação num mapa de teste: protocolo do Burghout (10
  repetições, 15 min de pico), tabela de erro normalizado.
- **Fronteira**: a rede de 5 km com incidente (5.4.1 da tese) é um teste de bancada
  imediato do jogo: dois trechos micro no meio de meso, incidente que fecha as duas
  faixas por 5 minutos, e fluxo cumulativo antes e depois da fronteira.
- **Maior população sustentada a 4×** (aceite do PROMPT): pesquisar crescendo N até o
  quadro estourar; relatar N, passo p99, CPU da thread principal e do worker.

---

## 4. Riscos e o que medir

1. **Latência de um quadro** com o worker (o desenho mostra o quadro anterior): medir o
   intervalo entre o clique e o efeito (cenário G da fase 0); aceitável a 60 Hz, mas
   o `holdSim` do arrastar de nós (`main.ts:3087`) e o Play (controle do jogador)
   precisam do estado em tempo real; o modo **Play** (câmera no chão atrás do jogador) e
   as Ações podem exigir um caminho síncrono ou a simulação perto do jogador na thread
   principal.
2. **Onda de choque nas transições** e **capacidade reduzida na entrada** do micro
   (Burghout: ≈ 2 000 contra > 2 600 veic/h/faixa): medir a capacidade da entrada de
   uma região micro alimentada pelo meso, com `birthSpeed` e com velocidade desejada.
3. **LOD dependente da câmera** quebra reprodutibilidade (e `hashSim`): os testes
   precisam fixar `focus` por tick; decidir se o worker aceita um "modo sem LOD" para
   regressão.
4. **Hierarquia das células e a rota**: custo de recalcular marcos/portais por edição
   (medir no mapa de 4,3 km; fase 2).
5. **Memória**: `Vehicle` pesado (motorista, claims, constraints) × milhares de veículos
   meso: o item meso precisa ser leve (≈ 64 B); contar bytes por nível.
6. **Ordem de eventos meso** com o passo micro: sincronizar na grade de ticks (Mezzo:
   "os passos do micro são eventos extras do meso"); hoje o tick é a unidade.
7. **Pessoas**: nenhuma fonte lida cobre meso de pedestres; `COARSE` existe, o agregado
   por calçada seria desenho próprio (a decidir com o agente das pessoas, depois da fase 4).
8. **Teto de desenho**: os buffers por `FLEET_CEILING`/`PED_CEILING` precisam passar a ser
   dimensionados pelos visíveis (3.3).
9. **Admissão com passo grosso** não verificada: nenhuma fonte garante que reservas e
   claims se comportam com Δt > 1/60.

---

## 5. O que NÃO foi possível ler (ou só em resumo)

- **HPA\* original** (Botea, Müller, Schaeffer 2004): 404 nos endereços tentados; usei o
  texto de Kring et al. (que o descreve e propõe DHPA\*/SHPA\*). O número "10× / 1%" é de
  resumos de busca, não da fonte.
- **CRP, versão de periódico** (Transportation Science 2017): só o artigo SEA 2011 e um
  resumo estendido (SoCS 2013) foram obtidos como texto, e o resumo estendido veio quase
  vazio.
- **Eissfeldt (tese, Colônia, 2004)**, base do meso do SUMO: não lida; os valores de
  `tau*` vêm da documentação do SUMO.
- **MATSim**: só `QueueWithBuffer.java` por extração dirigida (o resto do `QNetsimEngine`,
  o nó e o movimento, não); o capítulo do livro (Horni et al., 2016) não foi lido. O valor
  padrão do tamanho efetivo de célula **não** consta no trecho lido.
- **Unreal Mass**: só a visão geral (sem valores); o código dos processadores LOD está
  em repositório fechado; a palestra "Large Crowds and Traffic in The Matrix Awakens" não
  foi lida (só resumos).
- **SUMO**: a documentação do modelo, sem o código de `MESegment`/`MELoop` (como a saída
  é agendada na prática) — o relatório F11 já cita a fonte, não relida em código.
- **Gaffer**: "Snapshot Compression" e "Networked Physics" não lidos; o artigo de
  interpolação foi lido por extração (o resumo retornou sem código).
- **Mass/AC Unity "AI recycling"** (F8): só o resumo do relatório.
- **Admissão/reservas com Δt maior**: nenhuma fonte; código de `admission.ts` e
  `claims.ts` não lido por inteiro.
