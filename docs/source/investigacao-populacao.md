# Investigação: as cidades ficam vazias (2026-10-11)

Relato do jogador (2026-10-11): "A cidade não tem trânsito de carros e nem de
pessoas. Todas as cidades são sempre vazias. Deve haver algum problema."

Ramo `agente/populacao` (a partir de `planeta-esfera` 27a7cb48). Só
investigação: nada do jogo foi mudado. Spec que reproduz:
`tests/sim/populationDefaults.spec.ts`. Sonda: `scripts/zz-population-probe.mjs`.

## Causa

O jogo pede **10 carros e 10 pessoas**, um número absoluto que não depende da
cidade, e esse número é o teto de todo nascimento.

1. **O padrão.** `src/editor/persistence.ts:457-458`:
   `DEFAULT_TRAFFIC_COUNT = 10`, `DEFAULT_PEDESTRIAN_COUNT = 10`. Chega à
   simulação por todos os caminhos:
   - jogo aberto sem nada salvo: `src/main.ts:387-388`
     (`sim.trafficCount = savedSession?.settings.cars ?? DEFAULT_TRAFFIC_COUNT`);
   - de novo, já limitado ao slider: `main.ts:2334-2335`;
   - mapa aberto de arquivo: `main.ts:2815-2816` (`restoreSettings`); um
     arquivo só com a geometria recebe `defaultSettings()`
     (`persistence.ts:577`), sem `cars`/`people`, e cai no 10;
   - cidade gerada (`generateCity`, `main.ts:2600`) não toca nos números:
     herda o 10 que está valendo.
   - `sessionSettings()` (`main.ts:452-453`) grava `cars: 10, people: 10` em
     toda sessão salva no navegador e em todo arquivo exportado: o 10 se
     perpetua mapa a mapa.
2. **O número é o teto de tudo.**
   - carros: `src/sim/vehicles/spawn.ts:48`
     `trafficTarget = min(FLEET_CEILING, trafficCount, via/12 m)` = 10;
     `stepDispatch` só deixa entrar pelas pontas enquanto
     `vehicles.size < trafficTarget` (`spawn.ts:99`, `spawn.ts:132-134`);
     os carros dos lotes só saem das vagas enquanto faltam carros para o
     mesmo alvo (`src/sim/agents/lotTraffic.ts:163`, `:193`);
   - pessoas: `src/sim/ambient/ambient.ts:349-351`
     `peopleTarget = min(pedestrianCount, via/8 m)` = 10; o enchimento do mapa
     aberto (`open`, `ambient.ts:519-523`) e a entrada pelas pontas e portões
     (`edgePeople`, `ambient.ts:365-368`) param nele.
3. **O modelo da própria simulação nunca é usado.** `spawn.ts:49-53` tem o
   alvo pela rede (comprimento das vias × `TRAFFIC_DENSITY` = 1 carro por
   45 m, `src/sim/params.ts:164`, × intensidade × demanda), com o comentário
   de `params.ts:167-178`: "The fleet is meant to follow the city... The
   `min` swallowed the whole city". Só vale com `trafficCount === null`, o que
   o jogo nunca tem. Para pessoas, a tabela do cenário por uso e hora
   (`src/sim/ambient/demand.ts:71` `PEOPLE` × `busy`, pessoas por 100 m de
   rua, como o `popcycle` do GTA) só decide o número no modo `?ambient=view`
   (`ambient.ts:194-197`); no modo do jogo (`edges`) ela só reparte os 10
   entre portões e pontas (`ambient.ts:375-394`).
4. **A regressão.** Commit `2a1cbacd` (2026-10-06, "Carros e pedestres
   entram e saem só pelas pontas das vias, na quantidade do painel"): os
   controles Tráfego e Pessoas eram uma intensidade em % sobre a densidade
   (100 % de padrão) e viraram um número de carros e de pessoas, padrão 10,
   máximo 400.
5. **Teto fixo.** `MAX_TRAFFIC_COUNT = MAX_PEDESTRIAN_COUNT = 400`
   (`persistence.ts:459-460`), aplicado no slider (`main.ts:2325-2328`), ao
   abrir (`main.ts:2334-2335`, `2815-2816`) e ao ler o salvo
   (`normalizeSettings`, `persistence.ts:450-451`). Mesmo no máximo o painel
   fica abaixo do que a própria simulação pede para a cidade plana gerada
   (624 carros). Contraria a decisão do jogador de 2026-10-11 (sem teto fixo).
6. **Controle sem efeito.** A "Demanda" do painel (baixa, normal, pico,
   `src/ui/v2/shell.ts:721-723`) só entra no cálculo com
   `trafficCount === null` (`spawn.ts:52`, `:101`): no jogo não muda nada.

Ninguém some antes da hora nem deixa de nascer por rota impossível ou faixa
sem saída: a população fica parada exatamente no número pedido, e com o
número maior ela sobe (controle abaixo).

## Evidência

### No jogo (Chrome sem interface, iGPU, servidor 5184 do ramo)

Navegador novo a cada parte (nenhuma configuração salva: o que um jogador novo
recebe). Amostra a cada 5 s; "efetivo" é a velocidade medida pelos tiques da
simulação. Carros = na via + manobrando no lote (como a barra de cima conta).

**Mapa plano** (`node node_modules/vite/bin/vite.js --port 5184`):

| Parte | Cidade | Velocidade | Carros | Pessoas | Barra | O que a simulação pediria |
|---|---|---|---|---|---|---|
| ao abrir | — | — | painel 10 | painel 10 | sliders 10 (0-400, passo 10) | — |
| (a) gerada, seed 4242 | 294 vias, 1 348 prédios, 28,1 km, 0 pontas | 1× (0,93×), 2 min | 10 em todas as 24 amostras | 10 em todas | "10 veículos · 10 pessoas" | 624 carros (densidade) |
| (a) gerada | idem | 4× (3,97×), 2 min | 9-10 | 10-12 | "10 veículos · 11 pessoas" | 624 |
| (b1) recarregada (sessão do navegador) | idem | 4× (3,69×), 1 min | 10 | 10 | sliders voltam em 10 | 624 |
| (b2) salva em arquivo e aberta pelo menu | idem | 4× (3,98×), 1 min | 10 | 11-12 | "10 veículos · 12 pessoas" | 624 |
| controle: sliders a 400/400 pela interface | idem | 4× (3,10×), 1 min | 69, 128, 183, 226, 270, 305, 338, 359, 378, 400, 400, 400 | 65, 118, 170, 218, 257, 303, 339, 368, 396, 400, 402, 400 | "399 veículos · 400 pessoas" | 624 |
| (c) à mão: 9 vias por cliques, pincel de zona | 16 lotes, 16 casas, 0,74 km, 2 pontas | 1×, 1 min | 10 | 9-10 | "10 veículos · 10 pessoas" | 16 |
| (c) à mão | idem | 4× (3,97×), 1 min | 10 | 10-11 | "10 veículos · 10 pessoas" | 16 |

Onde nascem e por que somem (contadores da simulação no mesmo intervalo):

- Cidade gerada (sem ponta de via): os 10 carros entram no enchimento do
  mapa aberto (`AmbientWorld.open`); depois entram e saem pelos lotes. A 4×,
  em 2 min: 25 carros nasceram e 26 saíram, 27 estacionaram num lote e 25
  saíram de um (`lotTraffic` `parkedIn`/`leftBy`); vida mediana de 40 a 190 s
  por intervalo. Pessoas: 11 caminhadas novas, 2 saindo de portão e 9
  entrando; vida de 370-570 s. Nenhuma chegada perdida.
- Cidade à mão (2 pontas): carros entram por uma ponta e saem na outra
  (32 viagens completas em 1 min a 4×, vida mediana ~60 s); 81 chegadas
  recusadas na entrada porque o mapa já tinha os 10 (`entryDemandLost`).
  Pessoas: 31 caminhadas, 22 saindo de portão e 22 entrando.
- Com 400 pedidos (controle): em 1 min a 4×, 473 carros nasceram e 146
  saíram, 414 pessoas nasceram e 30 saíram; 290 caminhadas saíram de portões.

**Planeta** (`node node_modules/vite/bin/vite.js --mode planet --port 5184`,
mesma sonda, mesmo código do ramo):

| Parte | Cidade | Velocidade | Carros | Pessoas | Barra | O que a simulação pediria |
|---|---|---|---|---|---|---|
| ao abrir | — | — | painel 10 | painel 10 | sliders 10 (0-400, passo 10) | — |
| (a) gerada, seed 4242 | 66 vias, 237 prédios, 4,25 km, 0 pontas | 1× (0,99×), 2 min | 10 em todas as 24 amostras | 11 em todas | "10 veículos · 11 pessoas" | 94 carros |
| (a) gerada | idem | 4× (3,92×), 2 min | 9-10 | 9-11 | "9 veículos · 10 pessoas" | 94 |
| (b1) recarregada | idem | 4× (3,91×), 1 min | 10 | 11 | sliders voltam em 10 | 94 |
| (b2) arquivo aberto pelo menu | idem | 4× (3,94×), 1 min | 10 | 10-12 | "10 veículos · 11 pessoas" | 94 |
| controle: sliders a 400/400 | idem | 4× (3,56×), 1 min | 73, 130, 185, 238, 284, 329, 354 … 354 | 66, 111, 155, 201, 238, 280, 313, 351, 391, 398, 399, 400 | "354 veículos · 400 pessoas" | 94 |
| (c) à mão: 13 trechos por cliques (cortados nas divisas), pincel | 16 lotes, 15 casas, 0,74 km, 2 pontas | 1×, 1 min | 10 | 9-10 | "10 veículos · 10 pessoas" | 16 |
| (c) à mão | idem | 4× (3,99×), 1 min | 10 | 10-12 | "10 veículos · 10 pessoas" | 16 |

No controle do planeta os carros param em 354: é o limite físico de
`trafficTarget` (um carro a cada 12 m de via, `spawn.ts:48`) nos 4,25 km da
cidade, não um defeito. Nascimentos e saídas se equilibram como no plano
(cidade gerada a 4×: 21 nascem e 22 saem em 2 min, 26 estacionam num lote e
23 saem de um; cidade à mão: 23 viagens completas e 108 chegadas recusadas na
entrada por já haver 10). Nenhum erro na página em nenhuma das duas rodadas.

Fotos do planeta: `a-gerada-4x.png` (237 prédios, "9 veículos · 10
pessoas"), `controle-400.png` (mesma vista, "354 veículos · 400 pessoas", os
carros aparecem nas ruas), `c-desenhada-4x.png` (duas quadras, 15 casas e um
lote zoneado ainda sem casa, "10 veículos · 10 pessoas"). Na barra do planeta
o relógio mostra a hora local de onde se olha (00:01 sobre a cidade gerada),
enquanto as tabelas de hora das pessoas e dos lotes (`busy`, `outShare`) leem
o relógio da simulação (`sim/city/city.ts` `minutes`, começando às 6h30):
cuidado na correção abaixo (item 1) - no planeta a hora da tabela tem de ser a
mesma que o jogador vê (`planetLocalMinutes`, `main.ts:4328`).

Fotos do plano (pasta da sonda): `a-gerada-1x.png` e `a-gerada-4x.png` (cidade de
1 348 prédios, barra "10 veículos · 10 pessoas"; na rua quase nada se move),
`controle-400.png` (mesma vista, "399 veículos · 400 pessoas"),
`c-desenhada-4x.png` (duas quadras com 16 casas, "10 veículos · 10 pessoas").
Na primeira rodada as fotos de 4× mostravam o botão 1× aceso porque a sonda
mudava `sim.clock.speed` direto; a sonda agora aperta os botões da barra.

Como repetir (servidor de rascunho na 5184, nunca o mapa do jogador):

```bash
node node_modules/vite/bin/vite.js --port 5184 --strictPort            # plano
node node_modules/vite/bin/vite.js --mode planet --port 5184 --strictPort  # planeta
node scripts/run-limited.mjs node scripts/zz-population-probe.mjs http://127.0.0.1:5184/ flat
# POP_PARTS=ab só (a) e (b); POP_PARTS=c só a cidade à mão; POP_SHORT=1 fases de 20 s
```

### Spec

`tests/sim/populationDefaults.spec.ts`, com a simulação montada como o
`main.ts` começa (padrões do painel, motor de caminhada, cenário pelas pontas
e lotes). Falha hoje:

```
cars asked for: crossroads 10, town of 264 buildings 10: expected 10 to be greater than 10
5.1 km of road, 264 buildings at 6.5 h: 10 cars (density 113), 10 people (street table 224); panel 10/10: expected 10 to be greater than or equal to 90
```

Contraprova (cópia temporária do spec, apagada): com `trafficCount = null`
(o alvo pela densidade) e 230 pessoas pedidas, os dois testes passam em 4 s
de simulação. O nascimento, as rotas e as faixas dão conta; falta só pedir o
número da cidade.

## Correção proposta (sem cortar ninguém)

1. **O painel volta a ser densidade, não contagem.** Tráfego e Pessoas em %
   do que a própria cidade pede, 100 % de padrão:
   - carros: `trafficTarget` pela rede (`spawn.ts:49-53`, que já existe):
     comprimento das vias × `TRAFFIC_DENSITY` × % × demanda; a Demanda do
     painel volta a valer;
   - pessoas: um `peopleTarget` pela tabela de rua do próprio cenário
     (`demand.ts` `PEOPLE` × `busy`, pessoas por 100 m pelo uso dos lotes da
     frente e pela hora; o mesmo cálculo de `ambient.ts:194-197` com a mistura
     de usos do mapa inteiro) × %. Assim a população segue a cidade e a hora,
     como o `popcycle` do GTA (densidade por região e hora, com uma densidade
     global nas configurações) e como o `--insertion-density` do `randomTrips`
     do SUMO (veículos por hora por km de via).
   Onde: `persistence.ts` (chaves novas, por exemplo `trafficDensity` e
   `peopleDensity`, separadas de `cars`/`people`, como `2a1cbacd` fez com as
   antigas: um `cars: 10` salvo vira 100 %), `main.ts:387-388`, `452-453`,
   `2325-2335`, `2815-2816`, `spawn.ts:43-54`, `ambient.ts:349-351`.
2. **Sem teto fixo.** Tirar `MAX_TRAFFIC_COUNT`/`MAX_PEDESTRIAN_COUNT`
   (`persistence.ts:459-460`) e o corte de `normalizeSettings`
   (`persistence.ts:450-451`). O que resta como teto é `FLEET_CEILING = 1200`
   e `PED_CEILING = 1000` (`params.ts:185-186`), que também são o tamanho dos
   buffers de instância do desenho (`render/agents.ts:76`). No three r186 o
   `InstancedMesh` aloca `count × 16` floats no construtor
   (`node_modules/three/src/objects/InstancedMesh.js:57`) e `count` só pode
   descer até esse tamanho: crescer é criar um atributo maior (dobrando, para
   não refazer a cada carro). Com o item 1 a cidade plana gerada já pede 624
   carros e ~1 200 pessoas pela tabela da rua às 6h30: esse teto será
   alcançado e precisa crescer junto (decisão do jogador: o limite é o que a
   máquina sustenta a 4×; medir e empurrar).
3. **Encher quando o alvo sobe.** Depois da abertura, pessoas entram no
   máximo 2 por segundo de simulação (`ambient.ts:391`): com o alvo da
   cidade (centenas) a rua leva minutos a 1× para encher quando o jogador
   sobe o slider ou a cidade cresce depois de aberta. Medido no controle:
   ~50 a cada 5 s a 4× (~12 por segundo real). Proposta: lote de entrada
   proporcional ao que falta, ainda só nas pontas e nos portões.

Verificação da correção, quando feita: o spec acima passa; a sonda nos dois
modos e nos três caminhos mostra a barra perto do alvo da cidade a 1× e a 4×;
`npm run perf:gate` sem forçar `trafficCount = 400` (o portão passa a medir a
população que a cidade pede, não a forçada) e com a tabela de orçamento
conferida.

### Fontes lidas

- SUMO, `randomTrips.py` ("Tools/Trip"): `--insertion-density` é "the number
  of vehicles per hour per kilometer of road"; com `--period` o número de
  viagens é fixo e não acompanha a rede.
  https://sumo.dlr.de/docs/Tools/Trip.html
- GTA, `popcycle.dat` (gtamods): o arquivo controla a população de cada
  região do mapa; os valores "#" dão a densidade relativa entre regiões e a
  densidade geral fica nas configurações.
  https://gtamods.com/wiki/Popcycle.dat
- Colossal Order, diário de desenvolvimento do Cities: Skylines II sobre IA de
  trânsito: sem limites rígidos de agentes; o limite é o hardware.
  https://colossalorder.fi/?p=1597
- Cities: Skylines, diário de simulação (resumo do Gamewatcher): cada cidadão
  tem casa e trabalho, os prédios geram as viagens; comércio gera caminhões.
  https://www.gamewatcher.com/2015-08-01-new-cities-skylines-dev-diary-talks-simulation-everyone-has-a-name-and-a-logical-pattern
- three.js r186, `src/objects/InstancedMesh.js` (no `node_modules` deste
  repositório): o buffer de instâncias tem o tamanho do construtor.
