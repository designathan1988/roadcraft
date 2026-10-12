# Roadcraft — auditoria integral e proposta de projeto novo (2026-10-12)

Documento para decisão do jogador. Nenhuma linha do jogo foi alterada para
escrevê-lo. Marcas: **[medido]** número desta máquina (RTX 3060, build de
produção, Chrome); **[código]** lido no código; **[pesquisa]** fonte lida (lista
no fim); **[hipótese]** ainda não confirmado.

Código auditado: o ramo `planeta-esfera` (`C:/Codex-Shared/roadcraft-planeta-esfera`,
commit `4cc2926e`), que é o jogo mais avançado, e o `master` (`17c8b7ac`), que é
o jogo plano sem planeta (confirmado: zero arquivos e zero código do planeta no
`master`; só um comentário dizendo que ele saiu).

---

## 0. Revisão do mesmo dia: o jogador mantém planeta e pistola

Com o planeta (mapa menor, plano perto do chão, esfera no zoom distante) e a
pistola mantidos, a recomendação muda: **limpar e corrigir o projeto atual,
no ramo `planeta-esfera`, e não abrir uma pasta nova.**

- O motivo principal da pasta nova era deixar muita coisa para trás. Com o
  planeta e a pistola ficando, o que ainda sai é o código fora de build
  (18 mil linhas), os textos, dependências, laboratórios e scripts sem uso, e
  o modo Jogar. Isso é cerca de 10% do código, e se apaga no próprio projeto
  com o `knip`.
- Os defeitos caros (seção 3) estão em pontos localizados e se corrigem no
  lugar, um por vez, com o jogo funcionando o tempo todo. É a substituição
  incremental de Fowler e a rearquitetura sem jogar código fora de Spolsky.
  Portar 160 mil linhas mantendo tudo seria, na prática, copiar o mesmo
  código, pagando o custo do porte sem ganho.
- O que a pasta nova garantiria também se consegue aqui: portão no pre-push,
  `knip` e a regra contra `catch` vazio na verificação, um ramo e uma sessão
  escrevendo.
- **Não existe "ponto de decisão do jogador" no trânsito.** Verificar se o
  trânsito funciona é trabalho de quem implementa: cada etapa só fecha com o
  portão verde e o jogo jogado e fotografado.

**Planeta no desenho certo.** No código atual, o mundo é um atlas de 864
peças, e as "divisas" entre peças vazaram para 55 arquivos. Além disso, todo
objeto é curvado vértice a vértice no shader, também na sombra (cerca de
10 ms de GPU no zoom). No desenho novo:
- a área jogável é UM mapa plano, menor, sem divisas;
- perto do chão o mapa é desenhado plano, sem custo de curvatura;
- de longe, a cidade vira uma versão simplificada (HLOD, como no 3D Tiles:
  representação grosseira longe, detalhe perto, decidido pelo erro na tela)
  sobre um globo que é só visual;
- a curvatura vale só para essa versão leve.

**Ordem no projeto atual.** Cada passo fecha com causa confirmada, correção,
portão verde, jogo jogado, fotos examinadas e commit.
1. Um ramo só (`planeta-esfera` com o FORMA do `master`); outros worktrees e
   ramos de agentes integrados ou descartados; uma sessão escrevendo.
2. Portão e linha de base com fotos de referência (inclui pessoas de perto),
   bloqueando o push.
3. Limpeza: código fora de build, modo Jogar, textos, dependências e
   laboratórios sem uso; scripts trocados pelo portão; documentação enxuta;
   regra contra `catch` vazio.
4. Costuras, na ordem da cadeia (seção 5):
   - desfazer por comando;
   - derivados por célula (faixas com remendo local, docas, vagas, grama);
   - carros: malha mesclada, LOD, recorte e sombra com orçamento;
   - pessoas: um sistema, roupas encaixadas na build, bonitas de perto;
   - catálogo de shaders compilado no carregamento;
   - sombras em cascata;
   - pós-processamento com orçamento por passe;
   - vazamento de memória e envios de textura.
5. Planeta no desenho acima: mapa plano menor e globo visual com HLOD.

**Pasta nova, se o jogador preferir:** é válida e chega ao mesmo resultado,
desde que a cópia seja automática e conferida:
1. Copiar só o que o jogo realmente usa, calculado pelo grafo de importações a
   partir do jogo, com os testes desses arquivos e os assets que eles
   carregam. Cerca de 430 arquivos de 505. Escolher arquivo por arquivo à mão
   é lento e quebra recursos sem ninguém perceber.
2. Provar que o jogo copiado é igual ao antigo antes de mexer: mesmo portão,
   mesmos números, mesmas fotos.
3. Só então corrigir as costuras da seção 3.

As partes ruins não são arquivos separados: estão dentro de arquivos
necessários (o desfazer no `main.ts`, as faixas no `lanelets.ts`, as peças dos
carros no `agents.ts`) e precisam ser reescritas em qualquer caminho. O
repositório antigo fica arquivado, só para consulta do histórico.

As seções 2, 3, 5 e 6 abaixo continuam valendo. As seções 1, 4 e 7, sobre a
pasta nova, ficam como registro da primeira análise.

## 1. Resposta: compensa um projeto novo?

**Sim, desde que seja um PORTE seletivo, e não uma reescrita do zero.**

- Reescrever do zero joga fora as correções que o código carrega ("quando você
  joga fora o código e começa do zero, joga fora todo esse conhecimento",
  Spolsky) e deixa o projeto meses sem jogo (Fowler: a substituição total
  "geralmente falha") **[pesquisa]**.
- Portar módulo por módulo para uma pasta nova, revendo cada um na cadeia,
  corrigindo a engenharia antes de entrar e trazendo os testes junto, é o
  caminho do "Strangler Fig" de Fowler: o novo cresce ao lado do antigo, e o
  antigo só sai quando o novo o supera **[pesquisa]**.
- Neste projeto o porte compensa por três motivos medidos:
  1. **Muito do que existe não vai para o jogo** (seção 2): o planeta inteiro
     e o "plano da Terra"; a pistola e o modo Jogar; 18 mil linhas que não
     entram em build nenhuma; 850 de 2.842 textos sem uso; dois sistemas de
     pessoas; dez páginas de laboratório; 146 scripts avulsos; 10 worktrees.
  2. **Os custos graves são de costura entre sistemas** (seção 3): a edição
     que refaz o mapa inteiro, o desfazer que copia a cidade, os carros em 20
     peças, as pessoas animadas na CPU e vestidas durante o jogo, os 190
     shaders. Isso é mais barato acertar ANTES de religar cada recurso do que
     remendar por baixo de 179 mil linhas.
  3. **O processo atual produz bagunça** (seção 3.9): ramos divergentes, sessões
     e agentes editando ao mesmo tempo, regras que se contradizem, testes que
     nunca olham a imagem. Fowler avisa que o mesmo processo produziria outra
     bagunça **[pesquisa]**; por isso o processo muda junto (seção 6).
- O ganho não vem da pasta nova em si. Vem do método: nada entra sem revisão
  da cadeia, correção, teste, portão de desempenho e foto. A pasta nova é o
  que torna esse método obrigatório, porque o jogo novo começa vazio e cada
  peça precisa passar pelo portão para entrar.

**Riscos e como o plano os trata**

| Risco | Fonte | Defesa no plano |
|---|---|---|
| Perder correções embutidas no código antigo | Spolsky | Porta-se código, não se reescreve. Cada arquivo é lido inteiro antes; os specs vêm junto; "Já tentado" e "Regras que custaram caro" viram testes ou regras de lint |
| Ficar meses sem jogo | Fowler | O jogo antigo continua rodando (porta 4180) até o novo superá-lo. Primeira fatia jogável cedo (fase F3). Ponto de decisão do jogador ao fim da F3 |
| "Segundo sistema" inchado | Brooks | Nada novo durante o porte: só o que o jogo já faz, com a engenharia corrigida. Recurso novo só depois do corte |
| Mesmo processo, mesma bagunça | Fowler | Um repositório, um ramo, uma sessão escrevendo; portão automático que bloqueia o push |

---

## 2. Inventário: o que existe e o que é lixo

### 2.1 Tamanho [medido]
| | Ramo `planeta-esfera` |
|---|---|
| Código do jogo (`src`) | 179.073 linhas, 505 arquivos |
| Testes | 33.626 linhas, 307 arquivos |
| Scripts | 146 arquivos, 15.189 linhas |
| Documentação | 23 arquivos, 886 KB (só `PROBLEMAS.md` tem 221 KB) |
| Instruções para a IA | 5 `CLAUDE.md`, 33 KB, e o do ramo diverge do `master` |
| Assets | 342 MB (272 MB em `models/people`, 63 MB em `models/humans`) |
| JavaScript da build | 8,7 MB por modo (3,1 MB do jogo, 0,9 MB do three, 1,3 MB de outras bibliotecas) |

Arquivos maiores: `main.ts` 4.777 linhas, `render/terrain.ts` 4.346,
`render/renderer.ts` 3.862, `render/buildings/buildingMesh.ts` 3.427,
`editor/buildingTool.ts` 2.770, `sim/agents/walk.ts` 2.622.

### 2.2 Fora de qualquer build [medido pelos source maps]
72 arquivos e 18.061 linhas não chegam nem à build do plano nem à do planeta:

- `src/backup/residents`, 7.039 linhas, e `src/backup/crime`, 454 linhas.
  Crime e moradores com vida interior, fora do jogo por decisão do jogador.
- `src/people/gen`, `render/people/generator` e `ui/creator`, cerca de 5.800 linhas.
  Gerador de humanos e criador de personagem, que são páginas de laboratório.
- `weaponsLab.ts` (540), `humanGenerator.ts` (464), `sandbox` (1.058), `studios` (796).
- `world/defaultTown.ts` (958), `world/town.ts` (444), `world/sampleTown.ts`: cidades antigas.

### 2.3 Fora do escopo decidido
- **Planeta, esfera, voo, espaço.** Cerca de 9.800 linhas em módulos próprios:
  `render/planet/*`, `world/planet/*`, `core/cubeSphere`, `core/planetTiles`,
  `world/flatEarth`, `render/flatAtlas`. Fora deles, há 278 linhas de
  acoplamento ("divisas" entre peças, cartas, `__PLANET__`) espalhadas por
  55 arquivos, incluindo `main.ts`, `renderer.ts`, `terrain.ts`, `walk.ts`,
  `commit.ts`, `elevation.ts` e `lots.ts`.
  **No ramo `planeta-esfera` o modo plano é a Terra desenrolada:** usa as
  cartas, o relevo e o gelo da esfera, e mede 335 km². No jogo novo, o plano
  volta a ser um mapa plano de verdade, como o do `master`.
- **Pistola e modo Jogar** (andar, dirigir, 1ª e 3ª pessoa, armas). O modo
  Jogar está desligado na compilação (`__PLAY_MODE__ = false`), mas a pistola
  continua no dock de Ações (`actionsWiring.ts` `shootAt`), e o laboratório de
  armas continua no código. Ficam fora `shootAt`, `shootBody`, o laboratório e
  os textos `play.*` e `player.*`.
- **A bomba fica** (decisão do jogador). Ela usa a explosão (`render/blast.ts`),
  a queda dos prédios em pedaços (`render/destruction.ts` e o worker de
  fratura), o arremesso de pessoas e carros (`render/ragdoll.ts` com Jolt,
  908 KB), as vítimas (`casualties`, `gore`), o fogo e a fuligem, a água dos
  canos (`geyser`, `leak`) e as crateras. Tudo isso é portado; o Jolt e os
  efeitos carregam ao escolher a ferramenta da bomba, não na abertura do jogo.

### 2.4 Duplicações e peso morto [código]
- **Dois sistemas de pessoas.** Corpos detalhados (`riggedCitizens.ts`,
  animação na CPU) e multidão procedural (`proceduralCrowd.ts`, animação na
  GPU, 1.587 objetos na cena). São dois conjuntos de materiais, shaders e
  assets (272 MB + 63 MB).
- **Duas bibliotecas de recorte de polígonos:** `polygon-clipping` e `clipper2-ts`.
- **`recast-navigation` instalado e não usado.**
- **850 de 2.842 textos de interface sem referência no código.** A contagem é
  aproximada, porque chaves montadas dinamicamente escapam. Os prefixos que
  mais aparecem: `person`, `creator`, `building`, `agent`, `hgen`, `play`, `player`.
- **Dez páginas HTML de laboratório** além do jogo: `human-generator`,
  `people-lab`, `sandbox` e as `*-system.html`.
- **68 `catch` que engolem o erro em silêncio.** Foi um deles que escondeu,
  durante semanas, que as pessoas pré-cozidas nunca eram carregadas.

---

## 3. Falhas encontradas

### 3.1 Vias: cada edição refaz o mapa inteiro [código + medido]
1. **O desfazer copia a cidade inteira a cada edição** (`main.ts:1247-1261`,
   `editor/history.ts`). O documento todo vira texto antes e depois, os dois
   textos são comparados e a cópia inteira vai para a pilha. Numa cidade
   gerada, são cerca de 12,7 MB por edição. O padrão certo é o comando com
   inverso, que guarda só o que mudou ("é mais barato guardar só o que você
   muda", Nystrom) **[pesquisa]**.
2. **A rede de faixas da simulação é refeita do zero a cada edição**
   (`world/lanelets.ts:220-243`: apaga tudo e percorre todos os trechos e
   cruzamentos). O trânsito fica parado durante esse preparo. Para uma mesma
   via isolada, custa 55 ms numa rede de 0,7 km e 6,8 s numa de 4,3 km, mais
   um quadro de 458 ms. A rede de calçadas segue o mesmo padrão: 1,35 s.
3. **Qualquer via invalida as manobras de todas as docas da cidade**
   (`sim/agents/lorryDocks.ts:323`: a chave de validade inclui `net.revision`),
   e cada manobra é recalculada pela busca A* de manobra.
4. **A grama do mapa todo é refeita a cada via** (`renderer.ts:1915`
   `buildScenery`).
5. **As vagas dos lotes são relidas no mapa todo** a cada mudança das faixas
   (`lotTraffic.ts:243`).
6. **Resultado [medido]:** 678 ms ao refazer o mundo numa via; 1,3 s de
   superfícies durante o crescimento da cidade; 9,7 s de mundo refeito
   enquanto a cidade é povoada. Abrir um mapa de 4,3 km sem cache leva 48 s.

O padrão que resolve é a partição espacial: o mundo dividido em células, cada
dado derivado guardado por célula, e a edição refazendo só as células sujas
(Nystrom, *Spatial Partition*; Unreal *World Partition*) **[pesquisa]**. O
projeto já tem o embrião disso, o diário de mudanças com retângulos em
`world/changes.ts`, mas os consumidores acima não o usam.

### 3.2 Carros [código + medido]
1. **Cerca de 20 malhas separadas por modelo** (`render/agents.ts:786-804`):
   carroceria, vidro, interior, 4 portas, 4 vidros, 4 forros, teto, vidro do
   teto, acabamento e outras. Cada uma é um draw call, mais outro na passada
   de sombra. O three oferece `BatchedMesh` (geometrias diferentes, um
   material, menos draw calls, recorte por instância) e `InstancedMesh`
   **[pesquisa]**.
2. **Não existe nível de detalhe intermediário.** A versão "leve" usa a mesma
   geometria da completa (`shellLite` = `model.shell`, linha 799). Um carro de
   8 px ainda desenha cerca de 5 mil triângulos.
3. **Sombra com a malha completa:** 2,3 M de triângulos de sombra de carros
   numa rua do planeta **[medido]**.
4. **Sem recorte por instância** (`frustumCulled = false`). O `InstancedMesh`
   só se recorta inteiro, por uma esfera única **[pesquisa]**.
5. **A matriz de cada peça de cada carro é recalculada na CPU a cada quadro**
   (cerca de 5% do tempo de CPU) **[medido]**.

### 3.3 Pessoas [código + medido]
1. **Os dois sistemas paralelos** (2.4). Os cerca de 13 corpos detalhados
   geram cerca de 400 draw calls e cerca de 6 M de triângulos numa vista
   **[medido]**.
2. **Os corpos detalhados são animados na CPU:** a pose de cada osso de cada
   pessoa é calculada a cada quadro, e a textura de poses é reenviada inteira
   (`riggedCitizens.ts:1045-1077`). A técnica do GPU Gems 3, cap. 2, pré-calcula
   as poses numa textura e lê na GPU **[pesquisa]**. A multidão procedural já
   faz assim; os corpos detalhados não.
3. **O encaixe das roupas (`person/fit`) e o preparo de animações de
   passageiro rodam durante o jogo, na thread principal:** quadros de até
   400 ms e cerca de 9 s de travadas ao povoar a cidade **[medido]**.
4. **De perto, as pessoas ficam feias**, como na foto do jogador (PL52, aberto).
   [hipótese] O nível "longe" da multidão pinta a cor das roupas por vértice
   a partir de uma amostra de 128 px (`proceduralCrowd.ts:712-760`, `1502`), e
   os rostos usam cartas de 256 px. É preciso confirmar no jogo qual nível
   aparece de perto.
5. **Na build de modos, as pessoas pré-cozidas nunca eram lidas** (caminho
   absoluto num `fetch`, erro engolido). Corrigido no `planeta-esfera`
   (`4cc2926e`).

### 3.4 Shaders e travadas [medido + pesquisa]
- **Cerca de 190 programas de shader.** Há um material por tipo de fachada,
  um por peça de carro, os dois sistemas de pessoas, as variações de sombra e
  a curvatura do planeta em todo material.
- **No Windows o Chrome usa o ANGLE sobre Direct3D 11**, onde compilar e ligar
  programas é caro e pode bloquear. Há relatos de consulta de status custando
  até cerca de 250 ms e de recompilação por formato de vértice **[pesquisa]**.
- **Cada material novo trava de 50 a 1.300 ms** quando aparece pela primeira
  vez. O passe de nitidez do pós-processamento travou um quadro por 0,8–1,3 s.
- **Envio de texturas durante o jogo:** num giro de câmera de 6 s, 3 s foram
  de `texSubImage2D` **[medido]**. A origem não foi atribuída; o suspeito é a
  textura de poses reenviada a cada quadro.
- O caminho certo (documentação do three) é `compileAsync`, que usa o
  `KHR_parallel_shader_compile`, antes do primeiro desenho **[pesquisa]**. A
  base disso é um catálogo fechado e pequeno de materiais, todos compilados
  na tela de carregamento.

### 3.5 Sombras, pós-processamento e GPU [medido + código]
- **Um mapa de sombra refeito a cada quadro com todos os objetos**, incluindo
  pequenos e distantes: a sombra é cerca de metade dos triângulos. As sombras
  em cascata usam resolução por distância e mapas por sub-frustum, e cada
  cascata só precisa dos objetos que a afetam **[pesquisa]**.
- **Mapa vazio, GPU de 7 a 15 ms**, quase tudo em pós-processamento pago por
  pixel. Os passes não foram medidos separadamente.
- **A curvatura do planeta é calculada por vértice várias vezes**, também na
  sombra, e custa cerca de 10 ms de GPU no zoom. Com a saída do planeta, esse
  custo desaparece.

### 3.6 Simulação [código + medido]
- Os laços do mapa inteiro a cada passo já foram tratados (`doLess = true`):
  semáforos que dormem, limpeza só das faixas afetadas, comprimento da rede
  em cache.
- O que ainda pesa: pedestres (cerca de 7%), trânsito dos lotes e caminhões
  (cerca de 10%), A* de manobra nas docas.
- Tudo roda na thread principal. Workers com dados transferíveis, sem cópia
  (MDN), são o passo seguinte, depois do porte **[pesquisa]**.

### 3.7 Memória [medido]
- Mapa vazio do planeta: 630–685 MB de heap. Com uma cidade pequena:
  1,2–1,4 GB.
- O heap cresce cerca de 600 MB/min com o jogo parado. O jogo aloca cerca de
  170 MB/s. A causa ainda não foi achada.
- 1.023 WebP descompactadas em RGBA na GPU. O formato KTX2/Basis mantém as
  texturas comprimidas na placa **[pesquisa]**.

### 3.8 Funcionamento e aparência [medido + PROBLEMAS.md]
- Um clique em Vias liga e desliga a ferramenta.
- A via nova aparece branca por cerca de 1 s antes do asfalto.
- A câmera de rua cai dentro da fachada.
- Asteroides e espaço aparecem de dia.
- Cidade no relevo com lotes faltando (AC8, aberto depois de 3 tentativas).
- 36 linhas abertas ou aguardando em `PROBLEMAS.md`.

### 3.9 Testes e processo [medido + código]
- **307 specs que rodam em Node sem desenhar nada.** Nenhum teste automático
  olha a imagem do jogo. A verificação visual e de desempenho depende de
  sondas manuais (146 scripts) e de quem as roda.
- **O portão de desempenho media pouco:** uma cena, uma rodada, sem p99 nem
  GPU, sem fotos de referência. A variação entre rodadas iguais chega a 1,7×.
- **10 worktrees e ramos vivos:** `master` (FORMA), `planeta-esfera`
  (189 commits de correções que o `master` não tem), `agente/ceu`,
  `agente/transito` e `agente/construcao` com commits não integrados,
  `terrario`, `planeta-cubo`, além de dois worktrees do Codex. Correções
  feitas num ramo não chegam ao outro.
- **Sessões editando o mesmo worktree ao mesmo tempo.** Agora mesmo, a sessão
  "Auditoria integral" altera `cubeSphere.ts`, `planetTiles.ts` e `main.ts`
  no `planeta-esfera`.
- **Instruções contraditórias.** O `CLAUDE.md` do `master` manda trabalhar no
  `master`, mas o jogo mais novo está no `planeta-esfera`. Há 886 KB de
  documentação, mais do que qualquer sessão consegue ler, e planos
  abandonados.
- **O próprio projeto já documentou o padrão de falha**
  (`PROBLEMAS.md` "Já tentado"): várias tentativas revertidas sem diagnóstico
  completo e otimizações "anunciadas sem medir".

---

## 4. Escopo do jogo novo

**Fica (portado e corrigido):**
- vias: traçado, cruzamentos, rotatórias, elevação, pontes, túneis, marcações, sinalização;
- terreno plano esculpível e água;
- prédios, construtor, lotes, zoneamento e cidade gerada;
- trânsito: faixas, semáforos, admissão, estacionamento, ônibus e caminhões com docas;
- pedestres;
- postes e fios, mobiliário, árvores e natureza;
- céu e clima: sol, nuvens, chuva e neblina, sem espaço;
- **bomba** e tudo o que ela usa (2.3);
- interface v2, salvar e carregar, desfazer;
- qualidade gráfica atual ou melhor.

**Sai:** planeta, esfera, voo, espaço, "plano da Terra"; pistola e modo Jogar;
crime e polícia; moradores com vida interior; gerador de humanos, criador,
laboratórios, sandbox, studios; um dos dois sistemas de pessoas; textos,
dependências e scripts sem uso.

**Decisões do jogador:**
1. **FORMA** (laboratório de construção em `labs/building/forma`, com sessões
   próprias): fica como projeto separado e entra no jogo depois do corte, ou
   já entra no porte?
2. **Trens e metrô:** ficam? O `planeta-esfera` tem trilhos e trens que andam.
3. **Mapas antigos:** o jogo novo deve abrir os mapas salvos (por exemplo,
   `C:/Codex-Shared/backup-mapa-jogador`)? A recomendação é sim, por um
   importador testado com esses arquivos.

---

## 5. Arquitetura do jogo novo: a cadeia, escrita antes do código

O erro que se repetiu foi implementar cada coisa sem olhar o que depende
dela. No projeto novo, a cadeia fica escrita num documento só
(`docs/ARQUITETURA.md`) e é imposta por testes.

```
Documento (vias, prédios, terreno, objetos)
  │  toda mudança é um COMANDO com inverso (desfazer = O(mudança))
  ▼
Diário de mudanças: retângulos sujos → CÉLULAS sujas (grade fixa)
  │
  ├─► Rede viária (por célula + vizinhança) ─► Alturas das vias ─► Chão moldado
  │        │                                        │
  │        │                                        ├─► Superfícies das vias (por célula)
  │        │                                        ├─► Estruturas, mobiliário, grama (por célula)
  │        │                                        └─► Postes e fios (por célula)
  │        └─► Faixas e cruzamentos (remendo local) ─► Simulação: rotas, vagas, docas (por célula)
  │
  ├─► Prédios e lotes (por célula) ─► Malhas de prédio (por célula, catálogo fixo de materiais)
  │
  └─► Salvamento automático por célula suja
Desenho: só as células vistas; tudo derivado montado fora do quadro e
compilado antes de aparecer.
```

Regras que valem para todo recurso, atual ou futuro:
1. **Nenhum derivado lê o mapa inteiro numa edição.** Cada derivado declara
   suas entradas (tipo de dado + célula + vizinhança). Um teste de escala
   conta o trabalho de uma mesma edição num mapa de 0,7 km e num de 4,3 km,
   e as duas contagens precisam ser iguais.
2. **Toda edição é comando com inverso.** Não existe cópia do documento por
   edição.
3. **Catálogo fechado de materiais e shaders.** Cada variação de shader é
   enumerada e compilada na tela de carregamento com `compileAsync`. O
   portão reprova qualquer compilação durante o jogo.
4. **Um sistema por coisa:** um de pessoas (animação na GPU), um de veículos
   (malha mesclada por modelo, LOD real gerado offline com o simplificador do
   meshoptimizer, recorte por instância), uma biblioteca de recorte de
   polígonos.
5. **Nada de preparo durante o jogo.** Encaixe de roupas, LODs, cozimento e
   compressão KTX2 acontecem na build. O que for inevitável vai para workers,
   com dados transferidos sem cópia.
6. **Sombra com orçamento:** cascatas, e objeto pequeno deixa de projetar
   sombra a partir de uma distância. A sombra só é refeita quando algo que
   projeta sombra se moveu dentro da cascata.
7. **Nenhum erro engolido:** regra de lint contra `catch` vazio.
8. **Nenhum código morto:** o `knip` roda na verificação e reprova arquivo,
   export ou dependência sem uso **[pesquisa]**.

---

## 6. Proteção permanente: o portão

Começa no primeiro dia, antes de qualquer porte. Mede o jogo ANTIGO para
criar a linha de base, e depois reprova qualquer passo que piore.

- **Onde mede:** build de produção, Chrome com janela visível, na RTX 3060,
  sem outra tarefa pesada rodando (o portão confere isso antes de começar).
  Cada cenário roda 3 vezes, e o resultado é a mediana com a dispersão.
- **Cenários:**
  - mapa vazio;
  - cidade gerada com 400 pessoas e 400 carros, vista de rua, bairro e alto;
  - girar, passear e zoom;
  - sequência de 10 edições de via;
  - construir, zonear e crescer a cidade;
  - bomba;
  - abrir um mapa grande;
  - 10 minutos parado (vazamento de memória).
- **Métricas:** intervalo entre quadros (p50, p95, p99, máximo), quadros
  longos com autoria pelo LoAF **[pesquisa]**, GPU p95, draw calls,
  triângulos, programas compilados durante o jogo (meta 0), heap e
  crescimento por minuto, tempo do clique até a via aparecer, tempo de
  abertura.
- **Imagens:** fotos de referência por cenário, com comparação por pixel
  (`toHaveScreenshot` do Playwright, no mesmo ambiente da referência)
  **[pesquisa]**. Inclui pessoas, carros e prédios de perto, na câmera baixa.
  A diferença é aberta e examinada antes de aceitar uma referência nova.
- **Testes de escala** por contagem de trabalho (regra 1 da seção 5).
- **Bloqueio:** hook de pre-push. Piorar qualquer métrica além da tolerância,
  ou mudar uma foto sem aprovação, impede o push.
- **Metas iniciais**, a calibrar na F0. O jogo novo nunca pode ser pior que o
  antigo em nenhuma métrica:
  - cidade com 400/400 na rua: p99 ≤ 20 ms e nenhum quadro acima de 50 ms ao
    mover a câmera, depois do aquecimento;
  - via nova visível em até 100 ms, sem quadro acima de 33 ms durante a
    reconstrução, com custo igual em mapa pequeno e grande;
  - 0 compilações de shader durante o jogo;
  - heap estável em 10 minutos parado.

---

## 7. Plano em fases

Cada fase segue a ordem da cadeia: nada entra antes daquilo de que depende.
Em todo módulo portado:
1. Ler os arquivos originais inteiros, nos dois ramos.
2. Listar o que ele lê e o que depende dele.
3. Listar os defeitos conhecidos dele em `PROBLEMAS.md`.
4. Pesquisar e escrever a fonte antes de qualquer técnica nova.
5. Portar e corrigir.
6. Trazer os specs.
7. Passar no portão.
8. Tirar as fotos e examiná-las.
9. Commit.

| Fase | O quê | Pronto quando |
|---|---|---|
| **F0 Fundação** | Repositório novo; build, lint (com a regra contra `catch` vazio), `knip`, portão, cenários e fotos de referência medidos no jogo antigo | Linha de base registrada; portão roda e bloqueia |
| **F1 Núcleo do mundo** | Geometria (`core`), unidades em metros, documento, comandos com inverso, diário, grade de células, salvar e carregar, importador de mapas antigos | Specs portados verdes; mapa do jogador importado; desfazer por comando |
| **F2 Vias e terreno** | Rede, cruzamentos, alturas, superfícies e chão moldado por célula, marcações, estruturas, água | Via nova visível em ≤ 100 ms em mapa pequeno e grande (contagem igual); fotos iguais ou melhores |
| **F3 Trânsito** (primeira fatia jogável) | Faixas com remendo local, simulação, semáforos, estacionamento; carros com malha mesclada, LOD offline, recorte por instância e sombra com orçamento | Cidade com 400 carros dentro das metas. **Ponto de decisão do jogador:** joga a fatia e decide se o porte continua |
| **F4 Pessoas** | Um sistema, animação na GPU, roupas encaixadas na build, LOD e texturas que ficam bonitas de perto; pedestres | Foto de perto aprovada pelo jogador; 400 pessoas dentro das metas; 0 preparo durante o jogo |
| **F5 Prédios e cidade** | Prédios, construtor, lotes, zoneamento, cidade gerada, docas e vagas por célula; catálogo fechado de materiais | Cidade gerada dentro das metas; 0 compilação durante o jogo |
| **F6 Ambiente** | Postes e fios, mobiliário, natureza, céu e clima, pós-processamento com orçamento por passe | GPU por passe medida; fotos aprovadas |
| **F7 Bomba** | Explosão, destruição, arremesso (Jolt carregado ao escolher a bomba), fogo, crateras | Bomba sem quadro acima do teto; fotos |
| **F8 Interface e tamanhos de mapa** | Interface v2 completa, tamanhos de mapa (o custo por célula torna a escolha honesta), trens e metrô se ficarem | Todos os cenários do portão verdes |
| **F9 Corte** | O jogo novo supera o antigo em todos os cenários e fotos; o antigo é arquivado | Jogador confirma |

O ponto de decisão ao fim da F3 limita o risco: com vias, terreno e trânsito
no projeto novo, os números e o jogo mostram se o método funcionou antes de
gastar com o resto.

---

## 8. Processo durante o porte
- **Um repositório, um ramo, uma sessão escrevendo de cada vez.** Sem
  worktrees paralelos. Agentes só nas regras do `PROMPT-AGENTES.md`.
- **Três documentos vivos:**
  - `ARQUITETURA.md`: a cadeia e as regras;
  - `PLANO.md`: as fases e a fase atual;
  - `PROBLEMAS.md`: só os itens abertos. O histórico vai para um arquivo à parte.
  - O `CLAUDE.md` fica curto e coerente com os três.
- **"Pronto" é portão verde, fotos examinadas e o jogador vendo.** Sem relatório
  de intenção.
- **Antes de começar:** encerrar as sessões e worktrees que editam o jogo antigo
  (a "Auditoria integral" está alterando o `planeta-esfera` agora) e integrar
  ou descartar os ramos dos agentes. Essa decisão é do jogador.

---

## Fontes lidas
- Joel Spolsky, *Things You Should Never Do, Part I*: https://www.joelonsoftware.com/2000/04/06/things-you-should-never-do-part-i/
- Martin Fowler, *Strangler Fig Application*: https://martinfowler.com/bliki/StranglerFigApplication.html
- *Second-system effect* (Brooks): https://en.wikipedia.org/wiki/Second-system_effect
- Robert Nystrom, *Game Programming Patterns*, Command: https://gameprogrammingpatterns.com/command.html
- Robert Nystrom, *Game Programming Patterns*, Spatial Partition: https://gameprogrammingpatterns.com/spatial-partition.html
- Unreal Engine, *World Partition*: https://dev.epicgames.com/documentation/en-us/unreal-engine/world-partition-in-unreal-engine
- three.js, `BatchedMesh`: https://threejs.org/docs/pages/BatchedMesh.html
- three.js, `InstancedMesh`: https://threejs.org/docs/pages/InstancedMesh.html
- three.js, `LOD`: https://threejs.org/docs/pages/LOD.html
- three.js, `WebGLRenderer` (`compile`, `compileAsync`): https://threejs.org/docs/pages/WebGLRenderer.html
- three.js, `KTX2Loader`: https://threejs.org/docs/pages/KTX2Loader.html
- NVIDIA, *GPU Gems 3*, cap. 2, *Animated Crowd Rendering*: https://developer.nvidia.com/gpugems/gpugems3/part-i-geometry/chapter-2-animated-crowd-rendering
- Microsoft, *Cascaded Shadow Maps*: https://learn.microsoft.com/en-us/windows/win32/dxtecharts/cascaded-shadow-maps
- Khronos, lista public_webgl, compilação no ANGLE/D3D11 e `KHR_parallel_shader_compile`: https://www.khronos.org/webgl/public-mailing-list/public_webgl/1904/msg00032.php
- meshoptimizer (simplificação para LOD, quantização): https://github.com/zeux/meshoptimizer
- MDN, *Transferable objects*: https://developer.mozilla.org/en-US/docs/Web/API/Web_Workers_API/Transferable_objects
- Chrome, *Long Animation Frames API*: https://developer.chrome.com/docs/web-platform/long-animation-frames
- Playwright, *Visual comparisons*: https://playwright.dev/docs/test-snapshots
- Knip: https://knip.dev/
- Paradox / Colossal Order, *Cities: Skylines II*, Traffic AI: https://paradoxinteractive.com/games/cities-skylines-ii/features/traffic-ai
- Medições desta máquina: transcrição da sessão "Auditoria integral" de 2026-10-12 e `docs/relatorio-desempenho-mapas-enormes-2026-10-11.md` (no `planeta-esfera`).
