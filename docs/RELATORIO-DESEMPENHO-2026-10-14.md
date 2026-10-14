# Relatório de desempenho do Roadcraft 2 — o que foi feito, o que se descobriu e o que falta

Data: 14/10/2026, 11h30. Escrito para o jogador.

## Como este relatório foi feito

- **De onde vêm os números.** Todos vêm de medidas registradas no repositório: `OTIMIZACAO.md`,
  `docs/STATUS.md`, `docs/PROBLEMS.md`, `docs/PLAN.md`, `docs/CIDADE-10KM.md`,
  `docs/PESQUISA-CIDADE-10KM.md`, `docs/research/regression-barrier.md`, as mensagens dos 87
  commits e os relatórios herdados do jogo antigo (`docs/source/performance.md`,
  `docs/source/relatorio-desempenho-mapas-enormes-2026-10-11.md`,
  `docs/reference/auditoria-roadcraft-2026-10-12.md`). Cada número sai com a data e a condição em
  que foi tirado.
- **Do código, li só o que serve de retrato.** Contei arquivos, linhas, workers e linhas de base,
  e li os cabeçalhos das ferramentas de medida (`render/gpuTimer.ts`, `ui/healthWatch.ts`).
- **NÃO MEDIDO NESTA SESSÃO.** Não abri o jogo para medir de novo. Outra sessão está trabalhando
  agora mesmo no repositório: os servidores 5300 e 5301 estão no ar, há arquivos alterados às
  11:22 e trabalho sem commit em `src/render/gardens.ts`, `scenery.ts`, `renderer.ts` e
  `world/walkways.ts`. Medir junto atrapalharia os números dela e os meus. O "como o jogo se
  comporta hoje" (seção 6) é, portanto, a medida mais recente registrada de cada cenário, com data.
- **Máquina das medidas:** i9-12900K (24 threads), 32 GB, RTX 3060 de 12 GB, Windows 10, Chrome
  visível desenhando na RTX. O Chrome sem janela desenha na Intel UHD 770, cerca de 5× mais lenta,
  e os dois nunca são comparados.

---

## 1. Resumo

1. **O jogo é** um construtor de vias e cidade em 3D no navegador (TypeScript + three.js r186 sobre
   WebGL2). Trânsito, pedestres e transporte são simulados ao vivo num mapa plano de 10,24 km.
2. **O objetivo de desempenho** é a cidade densa no mapa inteiro, bonita e fluida: 60 fps na rua e
   no bairro, ≥ 50 fps no mapa inteiro, via nova em ≤ 100 ms sem quadro acima de 33 ms, nenhuma
   compilação de shader durante o jogo, heap estável e nada mais feio do que antes.
3. **A descoberta central:** o custo crescia com o tamanho do mapa e o número de prédios, não com
   o que está na tela. Cada edição, quadro ou geração percorria o mapa inteiro em algum ponto,
   muitas vezes de forma quadrática. Quase toda correção bem-sucedida trocou "percorrer tudo" por
   "olhar só o que muda e o que se vê".
4. **O que foi feito em 3 dias:**
   - HLOD dos prédios (massa longe, detalhe perto, por streaming);
   - sombras só quando algo se mexe;
   - um passe de pós-processamento a menos;
   - desfazer por diferenças (177 → 7–15 ms);
   - abertura e geração da cidade em fatias e em workers;
   - cerca de dez buscas quadráticas trocadas por grade espacial ou árvore de caixas, com o
     resultado provado igual bit a bit;
   - caches com teto (heap 932 → 543 MB numa cidade de 5.400 prédios);
   - salvamento em partes comprimidas (35,8 MB → 2,87 MB).
5. **O processo de proteção mudou.** O portão de 2,5–4 h no Chrome antes de cada envio, que
   acusava pioras falsas, foi trocado por uma barreira que lê o código. São cerca de 1,5 min:
   grafo de chamadas a partir do quadro, contadores de trabalho e teste de escala com mapa pequeno
   contra grande.
6. **Como se comporta hoje (cidade padrão, 1.348 prédios, medidas de 14/10 de madrugada):**
   - 60 fps na rua e no bairro;
   - ~52 fps no mapa inteiro, limitado pela GPU;
   - câmera ~59 fps com a cidade aquecida e ~33 fps no primeiro minuto de uma cidade nova;
   - prédios na tela ~9 s depois do pedido;
   - heap de 335 MB.
7. **O maior custo que resta na CPU é a simulação na thread principal** (7–14 ms por quadro,
   conforme a medida). Em seguida vem a montagem de cada prédio que entra na vista: ~7 ms cada,
   o que derruba a câmera no primeiro minuto.
8. **A cidade no mapa inteiro (~80 mil prédios) ainda não roda.** A conta extrapolada dá ~12 min de
   geração e ~10 GB de heap. O teto do navegador é de ~4 GB de heap e ~537 milhões de caracteres
   por texto. Já existe um plano medido em 8 etapas e uma pesquisa com 59 fontes.
9. **O que mais falta saber:**
   - números do mesmo dia reconciliados com um roteiro fixo (há medidas de CPU que se contradizem);
   - de onde vêm os ~30 MB/s de lixo;
   - quanto a simulação em worker ganha de verdade;
   - se as técnicas para 80 mil prédios mantêm a imagem;
   - como o jogo roda em outra máquina que não a RTX 3060.

---

## 2. O objetivo

### 2.1 O jogo

Roadcraft 2 é um jogo de navegador. O jogador:

- desenha vias sobre um terreno esculpível;
- zoneia lotes;
- vê a cidade crescer;
- acompanha carros, caminhões, pedestres e transporte público simulados ao vivo;
- tem à mão uma pistola e uma bomba (explosão, prédios desmoronando, corpos arremessados, fogo,
  crateras).

Toda edição vale na hora. O mundo é UM mapa plano de 10,24 × 10,24 km: 5 × 5 placas de 2,048 km,
um metro por unidade. O planeta esférico e a "Terra desenrolada" saíram em 13/10 por decisão do
jogador. Existe também um app de desktop (Electron).

O Roadcraft 2 substitui o Roadcraft antigo. Foi feito a partir da cópia fiel, calculada por
ferramenta, do que o jogo antigo realmente usava (ramo `planeta-esfera`, commit `4cc2926e`): 2.930
arquivos conferidos por hash. Depois disso, cada defeito de engenharia é corrigido na causa.

### 2.2 As metas de desempenho

**Metas finais do plano (`docs/PLAN.md`, etapa F13):**

- cidade com 400 pessoas e 400 veículos, vista de rua, p99 ≤ 20 ms;
- nenhum quadro acima de 50 ms movendo a câmera depois do aquecimento;
- via nova visível em ≤ 100 ms, sem quadro acima de 33 ms, com custo igual em qualquer tamanho de
  mapa;
- zero compilações de shader durante o jogo;
- heap estável em 10 min parado;
- nenhuma métrica pior que a linha de base.

**Orçamentos da cidade no mapa inteiro (`docs/CIDADE-10KM.md`, pedido de 14/10):**

| O quê | Orçamento |
|---|---|
| Heap JS vivo | ≤ 1,5 GB (≤ ~15 KB por prédio) |
| Geração até a cidade de pé | ≤ 90 s, com a página respondendo o tempo todo |
| Vista de rua e de bairro | 60 fps |
| Vista do mapa inteiro | ≥ 50 fps |
| Explorar uma área nova | ≥ 50 fps, com os prédios no lugar (massa) até o detalhe chegar |
| Arquivo salvo | ≤ ~50 MB |

**Regra que vale para tudo:** otimizar é manter ou melhorar a imagem com menos tempo. Nenhuma
otimização corta prédio, distância, sombra, resolução, textura ou efeito sem o "sim" do jogador.

---

## 3. Como o jogo é construído

### 3.1 Tecnologias

| Área | Tecnologia |
|---|---|
| Linguagem | TypeScript 5.9 (451 arquivos, ~156 mil linhas em `src/`) |
| Gráficos | three.js r186, `WebGLRenderer` (WebGL2) |
| Pós-processamento | alvo HalfFloat com MSAA 8×, GTAO em meia resolução, bloom só à noite, SMAA (16 passos), tone mapping ACES + sRGB + grade (nitidez CAS, contraste, vibrância, vinheta) num passe de saída |
| Física dos corpos (bomba, pistola) | Jolt Physics em WebAssembly (`jolt-physics`) |
| Geometria 2D | `clipper2-ts`, `polygon-clipping`, `earcut` |
| Simplificação de malhas | `meshoptimizer` 1.2 (peças de prédio de longe) |
| Build e servidor | Vite 8 |
| Testes | Vitest 4 (270 arquivos de spec), happy-dom, Playwright (fotos no Chrome visível) |
| Análise de código | ESLint 10 + typescript-eslint + regras próprias (`eslint-rules/`), `knip` (código sem uso), analisador próprio `scripts/check-code.mjs` (API do compilador TypeScript) |
| Concorrência | 8 tipos de Web Worker: pares de conflito do tráfego, fratura dos prédios, cozimento de pessoas, ecologia (árvores), chão plano, acolchoado de roupa, superfícies, luz do terreno |
| Persistência | localStorage e IndexedDB; a partir de 3.000 prédios, partes gzip (`CompressionStream`) |
| Desktop | Electron 44 |

### 3.2 Camadas e controladores

```
core → world → sim, render;  world → editor → ui;  core → view → render, ui
```

As camadas são impostas por lint e por `tests/arch`:

- `core`: matemática pura;
- `world`: o documento e tudo o que deriva dele e não é imagem (rede, alturas, faixas, calçadas,
  lotes, planos dos prédios);
- `sim`: veículos, pessoas, transporte e semáforos;
- `render`: o único que usa three.js;
- `editor`: transforma entrada em comandos;
- `ui`: o DOM;
- `main.ts`: só faz a ligação entre os módulos.

Cada dado tem um único escritor:

- o documento muda só por comandos com inverso;
- o estado da sessão vive num store com mudanças registradas;
- a ferramenta é uma máquina de estados (semântica SCXML);
- há um registro único de comandos e uma tabela de teclas.

### 3.3 A cadeia de uma edição

```
comando → documento (registros) → diário de mudanças (tipo, retângulos, causa)
        → células sujas de uma grade fixa → produtos derivados por célula
        → simulação e desenho só das células afetadas e vistas
```

O diário de mudanças (`world/changes.ts`) é a peça que permite a qualquer derivado saber o que
mudou e onde. A meta é que nenhum derivado leia o mapa inteiro numa edição. Hoje parte deles já
segue isso e parte ainda não (seção 7).

### 3.4 Um quadro

**Laço de quadro sob demanda** (`frameLoop.ts`): parado quando nada se mexe; nuvens a 20 Hz.

**Simulação** num relógio de passo fixo de 1/60 s:

- teto de 8 ms por quadro (`SIM_FRAME_BUDGET_MS`); passado dele, a simulação desacelera em vez de
  esticar o quadro;
- um governador de população (`sim/populationGovernor.ts`, no modelo do Adaptive Performance do
  Unity) baixa e sobe os tetos de pessoas e veículos pelo custo do passo.

**Trabalho de reconstrução** (vias, chão, prédios) em fatias, com cota de tempo por quadro.

**Desenho, nesta ordem:**

1. mapa de sombra, um mapa de 4096 ajustado à vista, redesenhado só quando o sol ou algo que
   projeta sombra se moveu;
2. a cena;
3. a cadeia de pós-processamento.

**Prédios:**

- casca (paredes, lajes, telhados) numa malha por acabamento e por célula;
- peças (janelas, varandas, condensadoras, móveis, plantas) em `InstancedMesh`, uma por tipo e
  por célula;
- longe, uma "massa" por célula de 240 m: volumes com as janelas desenhadas no shader, acesas à
  noite;
- o detalhe só existe nas células "perto", escolhidas pelo erro de tela (fórmula do Cesium); ele
  chega por streaming com cache LRU de 128 MB.

### 3.5 Instrumentos de medida que já estão no jogo

| Instrumento | O que mede |
|---|---|
| `render/gpuTimer.ts` | tempo de GPU de cada quadro, por consultas `TIME_ELAPSED` da `EXT_disjoint_timer_query_webgl2`. É um anel de consultas lido em ordem; o quadro marcado como "disjunto" é descartado, como manda a Khronos |
| `ui/healthWatch.ts` | Long Animation Frames (quadros que atrasam mais de 50 ms, com o script culpado) e long tasks |
| Monitor F9 | estado da sessão, transições da ferramenta, quadros longos explicados por `performance.measure` (marcas `hitch:*`) |
| `renderer.info` | chamadas de desenho, triângulos, programas de shader |
| Superfície de depuração (`__gpu`, `__frames`, `__health`, `__state`) | o que as sondas leem para medir sem mexer no jogo |
| Contadores de trabalho (`laneletWork`, `cellWork`, `kerbWork`, `tickWork`…) | quantas unidades de trabalho uma edição ou um passo fez, independentemente do relógio |

---

## 4. Linha do tempo da frente de desempenho

| Quando | O que aconteceu |
|---|---|
| até 08/10 (jogo antigo) | 50 travadas catalogadas com causa e correção (`docs/source/performance.md`): cache com chave global, chão remodelado inteiro, materiais criados por reconstrução, cabelo por força bruta, malha das vias reenviada inteira (50–80 MB por via), autosave do mapa inteiro etc. Pior quadro ao desenhar vias 553 → 59–111 ms |
| 11/10 | Relatório "mapas enormes": o custo cresce com o mapa, não com a vista; tudo roda numa thread; recomendação de uma partição espacial única como espinha |
| 12/10 | Auditoria integral → decisão de porte seletivo (Roadcraft 2). Cópia fiel, provas de igualdade (build igual em 4.401 de 4.445 arquivos; os 9 mapas do jogador reabrem iguais). Portão de desempenho no pre-push. F1 (teclado e ferramenta), F2a (desfazer por diferenças), F3a (via sem refazer o mapa duas vezes) |
| 13/10 madrugada | Portão condenado pelo jogador (horas por envio, pioras falsas) e trocado pela barreira que lê o código. Analisador de chamadas em 8 s |
| 13/10 tarde | Planeta e Terra desenrolada fora; mapa único de 10,24 km em metros. Simulação no orçamento, governador de população, câmera com menos engasgos. HLOD dos prédios de longe (S1a) |
| 13/10 noite | Auditoria de desempenho e de imagem pelo código inteiro. Lista viva `OTIMIZACAO.md`; itens 1, 2, 4, 6, 7, 9, 10, 12–15 |
| 14/10 madrugada | Regressão minha corrigida (BatchedMesh com 1,1 GB de arrays). Itens 17–25: carregamento, travadas e sombras |
| 14/10 manhã | Pedido da cidade no mapa inteiro: plano medido, pesquisa de 59 fontes, caches com teto, grades espaciais na geração, salvamento em partes, postes no ritmo do custo |
| agora (sem commit) | Jardins dos prédios mantidos prédio a prédio (reconstruir os jardins da cidade inteira a cada prédio custava 36 s dos 64 s de crescimento numa cidade de 2.560 m); poda das linhas de calçada pela distância mínima à caixa (8,6 s na mesma cidade). Em stash: massa por ladrilho (`emitTileMass`) e montagem de prédio em worker |

---

## 5. O que foi feito (com antes → depois)

As medidas são da cidade padrão, salvo indicação. "Igual" quer dizer que se provou o mesmo
resultado (digest, byte a byte ou foto 1:1).

### 5.1 Desenho: GPU e CPU de desenho

| Mudança | Técnica | Antes → depois |
|---|---|---|
| Prédios de longe em massa (S1a) | HLOD por célula de 240 m, volumes a partir das mesmas baias do detalhe, janelas no shader, troca pelo erro de tela com histerese | visão geral: GPU 25 → 11 ms, chamadas 1.273 → 340; ~56 triângulos por prédio de longe contra ~13 mil no detalhe |
| Detalhe só nas células perto (#1) | streaming: detalhe emitido em fatias e aquecido na GPU antes de aparecer; célula longe há 10 s solta malhas e arrays | a cidade inteira deixa de existir em detalhe na memória; geometrias 920 → 712 ao afastar |
| Lacuna do streaming (#12) | a massa fica até o detalhe chegar; cache de chunks por bytes com LRU (Cesium `cacheBytes`); até 4 células por quadro | lotes vazios na tela → massa a 0,5 s e detalhe completo a 3 s num salto de câmera |
| Vistas de rua (#15) | `dynamicScreenSpaceError` do Cesium: com o olho baixo, o erro permitido cresce com a distância | rua: chamadas 984 → 660, triângulos 28,0 → 22,5 M, GPU 16,9 → 16,0 ms, desenho na CPU 8,9 → 7,4 ms; fachada da frente igual |
| Sombras redesenhadas só quando algo mudou | mapa de sombra estático até o sol, a grade ou um caster se mover. Medido: o custo é o redesenho, não a amostragem (1024² → 4096² muda só 0,5 ms) | sombra 4,8 → 2,25 ms na vista do mapa inteiro |
| Sombras só com caster móvel (#25) | rodas, motos e bicicletas de 2–3 px com sombra em bolha, como os carros; "movendo" = vento ou simulação com caster móvel visível | mapa inteiro 46 → 51,8 fps, GPU 20,3 → 18,6 ms, passes de sombra ~20 → 1,8 por segundo |
| Um passe de saída (#6) | tone mapping, sRGB e grade no mesmo fragmento, como o `EffectPass` do pmndrs | um passe de tela cheia a menos por quadro, mesma imagem |
| Contornos | o SMAA do three vinha no preset médio e rodava sobre a imagem linear HDR, onde o limiar 0,1 não pegava bordas de sombra → 16 passos, limiar 0,04; MSAA 4 → 8× | melhor imagem, custo neutro |
| Materiais compartilhados (#7, #10) | cercas, placas e lampejo da via com materiais feitos uma vez (o lampejo escreve o tempo em `onBeforeRender`) | nenhum material criado em reconstrução nesses três |
| Peças compiladas antes de aparecer (#23) | pré-compilação no estilo do cache de PSO do Unreal (`compileAsync` + `KHR_parallel_shader_compile`), com a mesma variante que a camada usa | 8 programas compilados num movimento de câmera → 0 |
| Escapamento (R29) | sobe à GPU só a faixa do slot escrito (`addUpdateRange`) | 128 KB por quadro → só o que mudou |
| Molduras e grades de janela a mais de 150 m | LOD por célula com histerese, como o `LOD.update` do three | menos triângulos na rua |
| Faces sobrepostas piscando | detector de faces coplanares no teste e correção nas camadas (`polygonOffset`, recuos de mm) | ~5.000 m² → ~5 m² em 150 prédios (qualidade de imagem) |

### 5.2 Abertura do jogo e geração da cidade

| Mudança | Técnica | Antes → depois |
|---|---|---|
| Crescimento da cidade em fatias (#13) | 100 ms por quadro, prédios segurados até o fim, massas antes do detalhe | prédios na tela 11,8 → 7,5 s, sem travar a página |
| Traçado da cidade em fatias (#14) | linhas de energia, lotes e zonas como geradores fatiados | chamada síncrona 1.534 → 157 ms |
| Cor dos lotes (#17, #20) | não é mais refeita a cada prédio colocado, e é feita em fatias de 12 ms, mostrada aos pedaços | camada 3,7 → 1,3 s; pior quadro visível 550 → 133 ms; quadro parado de 1,27 s eliminado |
| Cor média das texturas das pessoas (#18) | canvas em software (`willReadFrequently`) em vez de ler pixels da GPU | 1.307 → 31 ms |
| Pares de conflito do tráfego (#19) | até 4 workers, resposta por promessa (como o `TaskProcessor` do Cesium) | thread principal 3.563 → 1.021 ms; primeiro quadro 6,6 → 5,0 s; mesmos 6.180 pontos |
| Elevação (#21) | memoização das estruturas presentes | −386 ms na abertura |
| Validação de prédio (#22) | caixa envolvente antes do recorte de polígonos | 740 → 237 ms |
| Lotes da cidade (8c7d33e) | índice espacial do calçamento e lotes arquivados em grade de 64 m (eram O(n²)) | cidade de 1.280 m: plano 7.219 → 2.346 ms; `onLand` 982 → 45 ms; digest igual |
| Polilinha (c507465) | árvore de caixas em dois níveis | até 7,5 s a menos numa cidade de 2.560 m; resultado bit a bit igual |
| Bordas de calçada (9b9a267) | grade de 32 m | até 6,6 s a menos numa cidade de 2.560 m; 2,7 e 5,6 milhões de valores iguais |
| Postes (281d9c6) | direção do meio-fio guardada entre reconstruções e reconstrução no ritmo do próprio custo | cidade de 1.280 m: 5.000 prédios em 38,5 → 25,3 s |

### 5.3 Edição

| Mudança | Técnica | Antes → depois |
|---|---|---|
| Desfazer e refazer (F2a) | só os registros que a edição mudou (diferenças por registro, como o tldraw e o Excalidraw); provado com 25 sementes × 30 edições aleatórias | quadro do Ctrl+Z 177–185 → 7–15 ms no mapa grande do jogador |
| Via desenhada (F3a) | mobiliário por célula; postes e mobiliário deixaram de ser refeitos duas vezes | mobiliário 38–81 → 15–43 ms; quadro após a via 44–63 → 3–6 ms |
| Cópia de trabalho do documento (R27, #4) | `replaceWith` compara só o que o diário diz que mudou; `clone` campo a campo, sem JSON | clone 5,3–8,3 → 0,5–1,3 ms (era 18–20 ms antes da F2a) |
| Calçadas na topologia (R28) | faixas baldeadas por segmento uma vez | termo quadrático ×196,84 → ×13,98 entre mapa pequeno e grande |
| Placas de rua | refeitas só quando vias, terreno ou paisagismo mudam | fora da reconstrução de cada hora da cidade |

### 5.4 Simulação

| Mudança | Antes → depois |
|---|---|
| Orçamento de 8 ms por quadro e só começa o passo que cabe (era um segundo passo de 7 ms) | passos de até 61 ms → simulação p50 8 ms, máx. 16, com a câmera andando |
| Governador de população pelo custo do passo | pessoas 850 → 443 em 15 s; passo 10–12 → 5,5–8 ms |
| Pátio de doca dos caminhões em fatias de 40 mil células | 30 ms num passo → fatiado |
| Admissão sem alocar três conjuntos por veículo a cada tick (R23) | menos lixo por passo |
| Fumaça 2,5× maior (unidade antiga lida como metro) | corrigida |

### 5.5 Memória e persistência

| Mudança | Antes → depois |
|---|---|
| Caches com teto (LRU): linhas de postes (64 regiões) e baias de fachada (1.024 prédios) | cidade de 5.400 prédios: heap vivo 932 → 543 MB |
| Desgaste dos prédios por prazo (#9): fila por vencimento em vez de percorrer todos os prédios a cada 3 s | custo proporcional aos que vencem |
| Interiores numa grade de 2 m (#24) | `interiorAt` 192 → 73 ms; mobília idêntica byte a byte (3,0 MB) |
| Salvamento em partes (ca35f7d): a partir de 3.000 prédios, cabeça + partes de 512 prédios em gzip, só as que mudaram, numa transação | 5.400 prédios: 35,8 MB de texto → 12 partes com 2,87 MB; leitura completa em 610 ms |

### 5.6 Processo: como se impede a regressão

| Antes | Agora |
|---|---|
| Portão no pre-push: Chrome visível, cenários A/B, 2,5–4 h por envio, 114 pioras falsas na 1ª versão | `npm run check` de ~1,5 min, que roda só o que a mudança pode afetar (`vitest related`) |
| `npm run check` de ~20 min, 45 specs de 10 s ou mais | teto de 10 s por teste; lentos fora do check: 45 → 1 (`lorryDocks`, 13 s) |
| Nenhuma regra sobre o que roda por quadro | analisador (`scripts/check-code.mjs`, 8 s): grafo de chamadas a partir de `@perFrame` (10.429 funções, 4.576 alcançadas por quadro). Recusa material criado, shader compilado, JSON, `structuredClone`, cálculo de volume e laço do tamanho do mapa no caminho do quadro. Achados: 192 → 169 |
| Tempo de relógio como prova | contadores de trabalho e teste de escala (mesma edição em mapa pequeno e grande) |
| Dívida trazida | linhas de base que só encolhem: `catch` mudo 131 → 118, arquivos > 800 linhas 42 → 36, estado solto em módulo 343 → 303, `knip` 481 → 439 |

---

## 6. Como o jogo se comporta hoje

Medidas mais recentes registradas. **Não medi de novo nesta sessão** (motivo no início).

### 6.1 Cidade padrão (1.348 prédios, ~615 veículos, ~440–1.000 pessoas)

| Cenário | Medida | Quando e como |
|---|---|---|
| Rua | 60 fps, GPU 11,1 ms | 14/10 madrugada, 1688×922 |
| Bairro | 60 fps, GPU 12,4 ms | idem |
| Mapa inteiro | 51,8 fps, GPU 18,6 ms; limitado pela GPU (cascas 6,5 M triângulos, peças 7,0 M) | 14/10, depois do item 25 |
| Câmera andando, cidade aquecida | ~59 fps | 14/10 |
| Câmera andando, 1º minuto de cidade nova | ~33 fps: cada prédio que entra na vista custa ~7 ms para montar (mediana 3,4, p90 8,8, máx. 15,6 ms; 422 prédios num movimento de 8 s) | 14/10 |
| Prédios na tela depois de "gerar cidade" | ~9 s; cidade pronta ~15 s | 14/10 |
| Heap vivo | 335 MB | 14/10 |
| Lixo coletado | ~30 MB/s (heap sobe ~150 MB a cada 5 s e cai) | 13/10, **não remedido** |
| Desfazer | 7–15 ms por quadro | 12/10, mapa grande do jogador |
| Desenhar via | mobiliário 15–43 ms; ainda 5–9 quadros acima de 33 ms por via | 12/10, **não remedido** desde as correções seguintes |

### 6.2 Cidades maiores

| Cidade | Medida |
|---|---|
| Raio 1.280 m (~5.000–5.400 prédios, 1.128 vias) | lotes em 2,8 s; 5.000 prédios em 25,3 s; heap 543 MB; salvamento 2,87 MB |
| Raio 2.560 m (~21 mil prédios) | antes das correções de hoje: mais de 3 min sem lotes, heap 2,5 GB e a aba caiu. Depois delas: **não remedido** |
| Mapa inteiro (~80 mil prédios, ~15.700 trechos) | **não roda**; a extrapolação dá ~12 min e ~10 GB |

### 6.3 Medidas que não batem entre si

- Na noite de 13/10, a 1920×1080 na rua: GPU 14,6 ms e **CPU p50 32 ms** (simulação 13,7 +
  desenho 18,5). Isso daria ~30 fps.
- Em 14/10, a 1688×922 na rua: **60 fps**. Na mesma noite de 13/10, depois do item 15: simulação
  7,1 ms por quadro e desenho 7,4 ms.
- As condições diferem: resolução, número de pessoas pelo governador e correções feitas entre uma
  medida e outra. Não houve uma rodada única, com roteiro fixo, que reconcilie os números (seção 8).

---

## 7. O que ainda falta

Por ordem de impacto, com o motivo de ainda estar aberto.

### 7.1 Custos de quadro e de exploração

| # | Pendência | Por que importa | Estado |
|---|---|---|---|
| 1 | **Simulação num worker** (OTIMIZACAO #3) | é o maior custo de CPU por quadro (7–14 ms). O `SimWorld` lê documento e rede por referência em todos os estágios, então a mudança não é pontual | Plano escrito: (a) o worker recebe documento e rede na abertura e os deltas do diário; (b) poses, semáforos e trens num `SharedArrayBuffer` (ou buffers transferidos); (c) a página mantém um mundo só de leitura e interpola; (d) inspetor, lotes e efeitos leem o instantâneo |
| 2 | **Montagem de prédio cara** (#16) | ~7 ms por prédio que entra na vista: 50% fachadas e recortes, 16% lotes, 27% empacotamento | Caminhos: cache por registro, fatias menores e montagem em worker (stash "montagem de prédios em worker") |
| 3 | **Vista do mapa inteiro mais barata sem perder imagem** | a GPU ainda fica em ~18,6 ms com 13,5 M triângulos (~4 por pixel) | A massa com as cores do detalhe ficou pior e foi desfeita. Caminhos que restam: corte de peças e de sombras por tamanho na tela (abaixo de 1 px), casca simplificada abaixo de um pixel (meshoptimizer), ladrilhos fundidos (stash "massa por ladrilho"), vértice enxuto (48 → 12 B) |
| 4 | **Rua com menos triângulos** | 22,5 M triângulos na rua, quase todos atrás dos prédios da frente | Oclusão na CPU em worker com as massas como oclusoras (etapa E8 da pesquisa) |
| 5 | **Lixo de ~30 MB/s** (R23) | coleta frequente causa engasgo | Causa ainda não atribuída: falta um perfil de alocação |

### 7.2 Edição e topologia (o custo ainda cresce com o mapa)

| # | Pendência | Medida | Estado |
|---|---|---|---|
| 6 | **Topologia da simulação por edição** (R20, R28) | ~30 ms por cruzamento (1.369 cruzamentos = 51 s ao abrir sem cache); faixas, conflitos, calçadas e semáforos de ×9,5 a ×15,8 entre mapa pequeno e grande | Cache por forma de cruzamento e remendo local das faixas (etapa F3) |
| 7 | **Rotas velhas depois de uma edição** (R26) | correção de uma linha, mas o produto `routing` entra no teste de escala com ×15,26 | **Aguardando o jogador (A2):** a regra diz que a lista de exceções só encolhe |
| 8 | **Via nova em ≤ 100 ms** (R14, R8) | via provisória com a seção errada por 1–2 s; numa execução, vias levaram 9–10 s | R8 tem hipótese (espera de 3 s pela leitura do IndexedDB), não confirmada |
| 9 | **Contador de trabalho em todo derivado** | hoje só parte deles tem (rede, elevação, lotes, superfícies, mobiliário, placas e prédios ainda não) | Meta: razão ≤ 1,05 entre mapa pequeno e grande para cada um |
| 10 | **Abrir o mapa grande do jogador** (R3) | quadro de 1,4 s no jogo antigo | Não remedido no jogo novo |

### 7.3 Escala para o mapa inteiro (`docs/CIDADE-10KM.md`)

| Etapa | Situação |
|---|---|
| 1. Caches com teto | feita em parte (postes, baias); falta o texto dos registros e as massas em JS |
| 2. Registro compacto do prédio (semente + versão + alterações; R22, #8) | **decisão do jogador.** Exige gerador determinístico e versionado: uma versão nova do gerador mudaria a cidade salva |
| 3. Geração em escala (perfil a 2× e 4× do raio, workers) | em andamento: grades de hoje e jardins sem commit |
| 4. Desenho em três níveis (detalhe, massa, ladrilho fundido) | stash "massa por ladrilho" |
| 5. Montagem em workers | stash |
| 6. Vias a 15 mil trechos | não começada (malha das vias 24 s e faixas 15 s na cidade de 2.560 m) |
| 7. Simulação com nível de detalhe (micro perto, meso longe, fronteiras de Burghout) | não começada |
| 8. Opção "mapa inteiro" no gerador | não começada |

### 7.4 Etapas do plano ainda abertas (`docs/PLAN.md`)

- **F4:** dividir os arquivos grandes. `main.ts` tem 4.229 linhas, `renderer.ts` 3.703,
  `buildingMesh.ts` 3.686. Isso também limita a precisão do analisador, porque os guardas dentro
  do `draw` são linhas, não funções.
- **F5:** catálogo fechado de shaders e uploads.
  - 3 chamadas `compileAsync` alcançáveis do quadro, 25 materiais criados no caminho do quadro,
    51 chamadas pesadas e 89 laços do tamanho do mapa na linha de base;
  - envio de textura enorme por quadro (R2);
  - KTX2.
- **F6:** veículos em malha mesclada com LOD feito fora do jogo.
- **F7:** pessoas animadas na GPU.
- **F8:** sombras e pós com orçamento por passe.
- **F9:** memória.
- **Persistência:**
  - a cabeça do documento ainda é um JSON só;
  - o gzip e o `JSON.stringify` rodam na thread da página;
  - falta gravar em worker, com OPFS e `navigator.storage.persist()`.
- **Defeitos abertos ligados a fluidez:** R24 (60 fps com a câmera andando, ainda não garantido) e
  R25 (caminhão que não encosta na doca, o que mantém o único spec lento).

---

## 8. O que ainda não se sabe e precisa ser descoberto

| Pergunta | Por que importa | Como descobrir |
|---|---|---|
| Qual é o custo real de hoje, num roteiro fixo? | As medidas de 13/10 e 14/10 se contradizem (seção 6.3); cada sessão mediu de um jeito | Banco de medição da etapa E1 da pesquisa: caminhos de câmera fixos (rua, bairro, mapa, ortográfica), GPU por `gpuTimer`, chamadas e triângulos, heap, tempo de geração por fase, mesma resolução, mesma população, antes e depois de cada etapa |
| A cidade de 2.560 m (~21 mil prédios) já se sustenta depois das correções de hoje? | A aba caiu antes das correções | Gerar com a mesma sonda de perfil e comparar fase por fase |
| De onde vêm os ~30 MB/s de lixo? | Engasgo por coleta | Perfil de alocação do DevTools durante o jogo parado e com a câmera andando |
| Quanto o worker de simulação ganha? | É a maior aposta de CPU, com custo de cópia ou de `SharedArrayBuffer` (que exige COOP/COEP; o efeito no app Electron e nas origens dos mapas do jogador não foi verificado) | Protótipo medindo ms por quadro na página e latência das poses |
| Quanta memória de GPU o jogo usa de verdade? | A RTX tem 12 GB; a conta de ~0,6 MB por prédio em detalhe é estimativa | Contabilidade de bytes por buffer e textura (a instrumentação de `bufferData`/`texImage2D` existia no portão) |
| O corte de peças e sombras abaixo de 1 px muda a imagem? | A regra é não perder beleza; a massa colorida já falhou nesse teste | Fotos 1:1 na distância de troca, por tipo de peça, e comparação por pixel |
| O vértice em int16 abre fendas? | A proposta corta a VRAM das cascas a ~1/4 | Fotos de fachada de perto e teste de costura entre células |
| O multi-draw do Chrome tem um gargalo? | Afeta qualquer estratégia de lote | A issue citada no fórum do three não abriu (pedia login); medir antes de apostar |
| Por que ~30 ms por cruzamento na topologia (R20)? | Abrir um mapa grande sem cache leva minutos | Perfil por par de movimentos em `conflictPoints`; teste de cache por forma |
| Como o jogo roda fora desta máquina? | Tudo foi medido numa RTX 3060 com i9-12900K; a iGPU é ~5× mais lenta. Firefox e Safari não têm LoAF, e nem todo navegador tem o timer de GPU | Uma rodada do banco de medição na iGPU e noutro navegador, comparando só consigo mesma |
| As sombras precisam de cascatas? | Contradição registrada: `CLAUDE.md` pede cascatas, e a auditoria mediu que um mapa ajustado à vista basta para a câmera de cima. Na rua, com o horizonte, não se mediu | Medir a qualidade e o custo da sombra na vista de rua com e sem CSM |
| A meta de 60 fps na rua vale com 400/400 e p99 ≤ 20 ms? | É a meta final do plano | Rodada longa com p99 e quadros acima de 50 ms, câmera andando |
| O gerador é determinístico entre versões e entre workers? | É a condição do registro compacto (R22) | Hash da saída do gerador em dois workers, duas sessões e duas versões |
| Por que uma via levou 9–10 s numa execução (R8)? | Pode ser espera do IndexedDB | Registrar onde a leitura parou quando acontecer de novo |
| O R1 (Jolt quebrando) voltou? | Correção feita na causa medida, mas intermitente | Bomba e pistola em toda rodada do banco de medição |

---

## 9. Metodologias usadas

1. **Pesquisa antes de mudar.** Toda mudança não trivial começou pela leitura de fontes primárias:
   - documentação do three.js, Khronos, MDN, Chrome, V8 e Unreal (World Partition, PSO precaching);
   - Cesium (3D Tiles, `cacheBytes`, `dynamicScreenSpaceError`, `TaskProcessor`);
   - Unity (Adaptive Performance, `backgroundLoadingPriority`);
   - artigos (Greuter 2003, Burghout 2004, Jin et al. PLDI 2012, Selakovic & Pradel ICSE 2016);
   - análises de jogos (Cities: Skylines II por Huhtala).
   As fontes de cada item estão em `OTIMIZACAO.md`, `docs/PESQUISA-CIDADE-10KM.md` (59 fontes) e
   `docs/research/regression-barrier.md`.
2. **Medir no jogo real, na GPU do jogador.**
   - Chrome visível na RTX 3060, DPR 1, resolução registrada;
   - GPU por consultas de tempo, chamadas e triângulos por `renderer.info`;
   - quadros longos com autoria (LoAF), perfil de CPU do DevTools;
   - heap vivo depois de coleta, marcas `hitch:*`.
3. **A/B na mesma sessão e na mesma vista.** A build antiga fica servida à parte (5301), a câmera é
   posta no mesmo lugar (tecla Home) e as três medidas são intercaladas. Foi assim que se derrubou
   o R30 e se mediu a regressão do BatchedMesh contra o código anterior.
4. **Contar em vez de cronometrar** na barreira de envio, porque o relógio é ruído (o rustc mede
   instruções: ±0,2% contra ±9% do relógio):
   - contadores de trabalho por produto derivado;
   - teste de escala com mapa pequeno contra grande;
   - testes sem relógio real, com teto de 10 s por teste.
5. **Análise estática do caminho quente.** Grafo de chamadas pela API do compilador TypeScript a
   partir das funções marcadas `@perFrame` (no modelo do Clang Function Effect Analysis e dos
   grafos de chamadas de JavaScript de Feldthaus et al.). A linha de base só encolhe.
6. **Provar que a otimização não mudou o resultado:**
   - digest e byte a byte (lotes, calçadas, mobiliário dos interiores, superfícies de dois mapas);
   - distância de Hausdorff 3D entre massa e detalhe;
   - detector de faces coplanares;
   - teste por modelo do desfazer (fast-check);
   - fotos 1:1 da mesma vista.
7. **Uma correção por commit**, com arquivo:linha, técnica, fonte e número antes e depois.
8. **Registro do que falhou** (`PROBLEMS.md` "Já tentado", `OTIMIZACAO.md` "Tentado e desfeito",
   "Falsos positivos já pagos"), para não repetir:
   - BatchedMesh grande para geometria que muda (1,1 GB de arrays, 14 fps);
   - massa com as cores do detalhe (diferença 17,6 → 20,6, pior);
   - oito luzes pontuais escondidas (sem diferença fora do ruído);
   - células de 120 m (mais chamadas e GPU pior);
   - ritmo fixo de 30 fps (23 fps irregulares);
   - portão estatístico (3 versões, pioras falsas por comparações múltiplas).
9. **Conferência visual curta e dirigida** depois de cada mudança visível: ir direto ao lugar
   mudado, poucas fotos, cada uma examinada.

### Técnicas aplicadas (catálogo)

- **Nível de detalhe e seleção:**
  - HLOD por célula com a fórmula de erro de tela do Cesium e histerese;
  - erro dinâmico com a distância nas vistas de rua;
  - streaming com cache LRU por bytes e "massa segura até o detalhe chegar".
- **Tempo:**
  - trabalho em fatias com cota por quadro;
  - geradores que cedem a vez;
  - fila por prazo (desgaste);
  - reconstrução no ritmo do próprio custo (postes).
- **Paralelismo:** pools de workers com transferência de `ArrayBuffer`.
- **Estruturas espaciais:**
  - hash em grade (2 m nos interiores, 32 m nas bordas de calçada, 64 m nos lotes);
  - árvore de caixas em dois níveis (polilinha);
  - poda pela distância mínima à caixa (calçadas).
- **Memória:**
  - caches com teto (LRU);
  - arrays soltos depois de subir à GPU;
  - upload só da faixa mudada (`addUpdateRange`).
- **GPU:**
  - sombra redesenhada só quando um caster se move;
  - passe de saída fundido;
  - pré-compilação de programas (`compileAsync`);
  - materiais únicos por combinação.
- **Documento:** diferenças por registro guiadas pelo diário de mudanças; cópia campo a campo sem
  JSON.
- **Persistência:** partes comprimidas, só as que mudaram, numa transação.

---

## 10. Observações sobre o estado do repositório agora (11h25)

- **Arquivos de proteção apagados na cópia de trabalho, sem commit:** `CLAUDE.md`,
  `.claude/settings.json`, `.claude/launch.json` e `.githooks/pre-push`.
  - Se foi de propósito, a trava de fim de turno e o check no pre-push estão desligados nesta
    pasta.
  - Se não foi, `git restore` traz os quatro de volta.
  - Não mexi neles.
- **Trabalho sem commit de outra sessão:** jardins incrementais, poda das calçadas e linhas de base
  ajustadas.
- **Stashes com trabalho de desempenho parado:** massa por ladrilho, montagem de prédio em worker,
  sonda parcial do "pesquisador-desempenho" e o trabalho dos agentes parados em 13/10.
- **Este relatório** é o arquivo `docs/RELATORIO-DESEMPENHO-2026-10-14.md`, sem commit.

---

## 11. Fontes principais

Lidas nesta sessão para as seções de método e de limites:

- Chrome, Long Animation Frames API: https://developer.chrome.com/docs/web-platform/long-animation-frames
- V8, Pointer Compression (faixa de 4 GB; heap até 43% menor): https://v8.dev/blog/pointer-compression
- Khronos, EXT_disjoint_timer_query_webgl2: https://registry.khronos.org/webgl/extensions/EXT_disjoint_timer_query_webgl2/

Usadas nas correções (lidas nas sessões anteriores e registradas nos documentos do repositório):

- Unreal, World Partition HLOD: https://dev.epicgames.com/documentation/en-us/unreal-engine/world-partition---hierarchical-level-of-detail-in-unreal-engine
- Unreal, PSO precaching: https://dev.epicgames.com/documentation/en-us/unreal-engine/pso-precaching-for-unreal-engine
- 3D Tiles (refinamento e erro geométrico): https://github.com/CesiumGS/3d-tiles/blob/main/specification/README.adoc
- Cesium3DTileset (`cacheBytes`, `dynamicScreenSpaceError`): https://cesium.com/learn/cesiumjs/ref-doc/Cesium3DTileset.html
- Cesium TaskProcessor: https://cesium.com/learn/cesiumjs/ref-doc/TaskProcessor.html
- three.js WebGLRenderer (`compileAsync`): https://threejs.org/docs/pages/WebGLRenderer.html
- three.js BatchedMesh: https://threejs.org/docs/pages/BatchedMesh.html
- pmndrs/postprocessing #82 (passes fundidos): https://github.com/pmndrs/postprocessing/issues/82
- MDN, `getContext` / `willReadFrequently`: https://developer.mozilla.org/en-US/docs/Web/API/HTMLCanvasElement/getContext
- MDN, WebGL best practices: https://developer.mozilla.org/en-US/docs/Web/API/WebGL_API/WebGL_best_practices
- Unity, `backgroundLoadingPriority`: https://docs.unity3d.com/ScriptReference/Application-backgroundLoadingPriority.html
- Huhtala, desempenho do Cities: Skylines II: https://paavo.me/cities-skylines-2-performance/
- Greuter et al. 2003, cidades pseudo-infinitas: https://svn.sable.mcgill.ca/sable/courses/COMP763/oldpapers/greuter-03-real-time.pdf
- Burghout 2004, tráfego híbrido micro/meso: https://kth.se/polopoly_fs/1.742065.1600688570!/hybrid%20mesoscopic.pdf
- rustc, instruções em vez de relógio: https://internals.rust-lang.org/t/what-is-perf-rust-lang-org-measuring-and-why-is-instructions-u-the-default/9815
- Software Engineering at Google, cap. 23: https://abseil.io/resources/swe-book/html/ch23.html
- Clang Function Effect Analysis: https://clang.llvm.org/docs/FunctionEffectAnalysis.html
