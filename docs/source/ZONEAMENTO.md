# Zoneamento, lotes e prédios que crescem

O que o zoneamento faz hoje, por que é assim e de qual análise veio. Pedido
do jogador de 2026-10-09: zoneamento fácil, prédios variados e sem repetição,
escolhidos com inteligência para o lugar, muros e cercas completos com portão
de pedestre e de carro, portão de carro funcionando até o estacionamento dos
fundos, prédios acompanhando o terreno.

## Como funciona (o fluxo, arquivo por arquivo)

1. **Via** desenhada (`editor/roadTool.ts`). Vias não criam nem mexem em
   lotes (decisão de 96e037f8).
2. **Ferramenta de zona** na mão (`editor/lotTool.ts`): a terra ao longo das
   vias é cortada em lotes em segundo plano, 4 ms por quadro
   (`world/lots.ts` `planLotsSteps`: quarteirão fechado em uma ou duas
   fileiras de lotes iguais; terra aberta numa faixa de 32 m de fundo, lotes
   de cerca de 22 m de frente). Esses lotes **propostos** aparecem em
   contorno fraco; nada é gravado.
3. **Pincel**: passa por lotes desenhados e propostos; ao soltar, os
   propostos pintados são criados e todos são zoneados, num passo de desfazer.
   Lote desenhado à mão (retângulo, polígono, cortar, juntar, curvar) continua
   valendo e tem prioridade.
4. **Crescimento** (`main.ts`, a cada 500 ms → `editor/zoning.ts`
   `growOnLot`): o lote aberto mais perto do último prédio crescido (a rua
   enche em sequência); `planLot` divide o lote em frente, lados e fundos
   (`editor/lotPlan.ts`); `madeToMeasure` faz 4 candidatos para o envelope
   (`world/buildings/procedural.ts`) e fica o menos parecido com os prédios a
   90 m; `furnishLot` mobilia o lote, fecha a divisa e terraceia o quintal em
   encosta; antes dele, na encosta, `stepToSlope`
   (`world/buildings/splitLevel.ts`) põe o fundo do prédio meio andar ou um
   andar acima ou abaixo da rua; `addPlaced` grava (tirando trecho de muro
   que encosta no vizinho).
5. **Carros** (`sim/agents/parking.ts`, `lotTraffic.ts`, `manoeuvre.ts`):
   as vagas do lote são alcançadas só pelos portões de carro; carros do
   trânsito são chamados às vagas livres perto da vista, param antes do
   portão, entram, ficam 40-150 s e saem pelo mesmo portão.
6. **Pessoas** (`sim/agents/lotDoors.ts`, `sim/ambient/ambient.ts`,
   `sim/agents/walk.ts`, P84): de cada lote com portão de pedestre sai o
   caminho da porta até o pé do portão na calçada, achado numa grade de
   pessoa de 20 cm (prédio, muros, cercas, canteiros, bancos e vagas
   sólidos; escada e rampa não) e passando reto pelo meio do portão. Uma
   parte das pessoas sai por uma porta ou entra por uma: a densidade do
   próprio cenário (`PEOPLE` × `busy` × frente do lote) diz quantas pessoas
   cada lote põe na rua àquela hora; a direção (saindo ou entrando) vem das
   curvas de presença do ATUS (trabalho e compras por hora); a outra ponta,
   quando também é um lote, pelo modelo gravitacional (e^(−d/470 m)).
7. **Desenho** (`render/buildings/buildingMesh.ts`): o lote segue
   `lotSurfaces` (terraços inclusos), muros e cercas descem em degraus de
   2 m, os portões de carro e de pedestre aparecem abertos; cada bloco é
   desenhado da sua cota (`Volume.lift`): embasamento, paredes, telhado,
   escadas de entrada, pisos no corte, lajes da explosão.
8. **Cota de um bloco à mão** (`world/buildings/splitLevel.ts` `opSetLift`,
   `editor/buildingTool.ts`): o jogador sobe ou desce o piso de um bloco pelo
   campo "Cota do bloco" do Construtor ou pela alça vertical na quina do
   bloco (passo de meio andar; com Alt, livre), até 6 m para cada lado; os
   blocos empilhados nele e as peças da fachada vão junto.
9. **Estacionamento e pátio de carga em degrau** (`zoning.ts`, `lotPlan.ts`
   `yardRamp`, `splitLevel.ts` `stepToSlope` com `yard`): o pátio de trás vai
   para a cota dos fundos do prédio, escolhida pelo corte e aterro sob os
   fundos e sob o pátio; aceita meio andar, um andar ou um número inteiro de
   espelhos de 17 cm. Só vai até onde o acesso alcança como rampa
   (`Volume.ramp`): plano nos primeiros 6 m depois do portão, depois até
   12,5% para carros e 10% para caminhões. O estacionamento acompanha o
   terreno até 5%; a rampa tem muro de arrimo de pedra do lado de fora onde
   corre em corte ou aterro. A linha do degrau passa para trás dos poços e
   das torres sobre o pódio.
10. **Garagem no andar de baixo** (`splitLevel.ts` `garageUnder`,
   `lotPlan.ts` `garageRamp`): casa com os fundos um andar inteiro abaixo da
   rua e com acesso de carro ganha porta de garagem na face dos fundos do
   bloco rebaixado, na baia mais perto do acesso (2,6 m de largura no
   mínimo). O acesso é plano no jardim da frente e 1 m depois do portão
   (transição), depois rampa de até 25% até a cota dos fundos, com muro de
   arrimo de pedra do lado de fora onde corre em corte ou aterro e um pátio
   de 6 m diante da porta; sem abrigo de carro na rampa. O jardim em degrau
   fica atrás do pátio.
11. **Lance entre meios-níveis** (`interior.ts` `levelFlights`, desenhado no
   corte em `buildingMesh.ts` `emitInterior`): dois blocos lado a lado em
   cotas diferentes (de 0,3 m a um andar) ganham um lance no bloco mais
   baixo, em ângulo reto com a linha onde se encontram, no meio dela: 1 m de
   largura, espelhos de até 18 cm, pisos de 28 cm. Os móveis gerados ficam
   fora do lance.
12. **Frente na cota da calçada** (`foundation.ts`, `validate.ts`,
   `zoning.ts` `reachStreet`, `streetDoors.ts`): o térreo fica na cota da
   calçada em frente, também na subida, com o terreno de trás cortado (loja
   com porta "at-grade": Fircrest, tipo "shopfront"; Santa Clara, piso da
   loja a 0 ft). A regra de encosta ('slope', 5,5 m) mede o chão de cada
   bloco a partir do piso dele: o prédio em degrau é aceito no lote da
   frente. Quando a tentativa recua o prédio (1,5 a 4 m), as superfícies e
   os caminhos da frente vão até a calçada e a rua é lida na frente do lote.
   `streetDoors` dá as portas de pessoa do térreo que abrem direto na
   calçada (soleira e normal), para a loja sem recuo.
13. **Docas de caminhão** (`lotPlan.ts` caso 'loading', `docks.ts`
   `lorryDocks`): cada doca do pátio de carga fica diante de uma porta de
   carga dos fundos do galpão, a partir da parede (até 0,6 m de desvio perto
   da divisa); galpão sem porta de carga nos fundos fica com o espaçamento
   antigo. `lorryDocks` dá de cada doca a ponta da porta, a ponta de entrada
   de ré, a largura e a cota.

## Por que cada coisa

- **Lotes propostos pelo pincel.** Medido: via nova + pincel = 0 lotes, nada
  crescia; o jogador tinha de desenhar cada lote. Cities: Skylines mostra a
  terra zoneável ao longo de toda via com a ferramenta na mão e o jogador só
  pinta. Aqui a proposta só existe com a ferramenta na mão e só é gravada ao
  pintar, então a decisão de 96e037f8 (vias não geram lotes) continua: o que
  gerava lentidão era replanejar o mapa a cada via, e a proposta roda em
  fatias de 4 ms (medido: máx 6-8 ms por quadro).
- **Rua enchendo em sequência.** Sorteado no mapa inteiro, o prédio surgia
  longe de onde o jogador pintou; o mais perto do último dá retorno onde ele
  olha.
- **Forma por caso + candidato menos parecido.** Medido: casa tinha uma forma
  só e todos os lotes têm 22×32 m, logo todas as casas eram a mesma massa;
  com um sorteio, 19-30% dos prédios tinham quase-gêmeo a menos de 100 m. A
  forma vem das proporções do envelope (como o `LUShape` do CityEngine) e de
  um ramo aleatório; entre 4 candidatos fica o mais distante, em aparência, dos
  vizinhos (melhor candidato de Mitchell: espalha sem aglomerar e custa 4
  geradores de massa, alguns ms). Depois: 2-8 de 54 com quase-gêmeo.
- **Cores como dados.** As cores entram por vértice num material por
  acabamento (`render/buildings/finishes.ts`): paleta maior não cria material
  nem chamada de desenho. Famílias brasileiras (cremes, amarelos, pêssegos,
  verdes, azuis, lilases, cinzas), contorno que contrasta, telhados de barro,
  ardósia, fibrocimento e metal, e uma variação de tom por prédio.
- **Altura vizinha.** Prédio médio ao lado de casa baixa fica até 3 andares
  acima dela: um degrau, não um paredão.
- **Esquina.** Lote com rua no lado também ganha faixa de jardim e divisa
  baixa nesse lado, em vez de parede cega e muro de 2,2 m para a rua.
- **Divisa completa.** As peças eram postas por regra e as recusadas deixavam
  buraco; o passe final mede a borda inteira e fecha o que falta. Medido no
  teste: menos de 2% da borda aberta em todos os usos.
- **Portão de carro funcional.** Medido: 39 de 413 vagas alcançáveis, porque a
  saída era procurada na borda do próprio estacionamento, a 20-35 m da rua, e
  as cercas de 12 cm não apareciam na grade de 75 cm. Agora a saída é o
  portão (como a área de estacionamento do SUMO, presa à faixa do acesso), a
  grade marca toda célula que uma peça toca, o acesso fica livre e nenhuma
  vaga de rua é pintada na frente do portão (CTB art. 181 IX). Depois:
  430/430 (semente 3).
- **Terraços.** Na encosta o quintal inteiro era cortado ou aterrado até o
  piso. O quintal agora é uma plataforma perto do terreno natural, com muro de
  arrimo e escada (17 cm de espelho, 30 cm de piso). Medido em 30 casas numa
  encosta de 18%: corte e aterro no meio dos jardins 209 m → 95 m.
- **Meio-nível.** Com só o quintal em terraço, o prédio ficava num piso só e
  o chão sob ele era cortado ou aterrado: no morro feito com o pincel (11-22%
  de declive) aterro médio de 2,35 m sob os blocos e terra encostada até
  3,9 m acima do piso nas quinas. Na vida real a casa na encosta se divide
  em platôs a meio andar um do outro, ligados por lances curtos (McCarthy
  Homes; split-level na Wikipedia), ou ganha um andar de baixo aberto para o
  jardim (daylight basement, 10-20% de declive: studiomatrx); corte e aterro
  ficam perto de 1 m (Camden DCP 4.2.2) e corte é preferido a aterro. Aqui:
  o bloco da porta e os blocos ao lado dele ficam na cota da rua; atrás de
  uma linha (o fundo do bloco da porta, ou o meio dele, partido em dois) os
  blocos vão juntos para a cota de meio andar ou de um andar que deixa menos
  terra cortada e aterrada sob eles (aterro pesa 1,3×), se isso poupar ao
  menos 0,45 m em média. Um andar abaixo: o bloco ganha um andar de baixo
  com a porta dos fundos no jardim; um andar acima: perde o andar de baixo
  para o morro. Cada bloco tem seu platô (como o "Align terrain to shapes"
  do CityEngine, forma por forma); onde dois se encontram, a escavação do
  mais baixo segue sob a borda do mais alto (a célula do terreno tem 6,4 m;
  sem isso a rampa de terra subia dentro do cômodo de baixo). Parede contra
  bloco de outra cota fica sem janela (o `touches` do CityEngine faz da
  janela parede). O terraço dos fundos, o quintal, os pátios atrás da linha
  e o fundo do jardim lateral ficam na cota dos fundos, com muro de arrimo e
  escada na passagem; a entrada de carro fica na cota da rua (com os fundos
  um andar abaixo, desce em rampa até a garagem do andar de baixo, item 10).
  Medido: 16 de 30 casas numa encosta de 18% no teste, terra sob os fundos
  72 m → 25 m; no navegador 6 de 22 casas, terra encostada nas quinas média
  0,53 → 0,16 m (máx. 3,9 → 1,4 m), aterro médio 2,35 → 1,82 m.

## O que ainda falta

- A porta da loja colada na calçada já é dado (`streetDoors`); falta
  `sim/agents/lotDoors.ts` usá-la quando não há portão (pedido à
  coordenadora).
- O primeiro traço do pincel numa sessão tem um quadro de cerca de 360 ms de
  compilação de shader (P75); pré-compilar fica em `render/renderer.ts`.
- Caminhões indo até as docas (`lorryDocks`): pedido ao agente de trânsito,
  pela coordenadora.
