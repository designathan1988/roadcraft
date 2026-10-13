# Plano — Roadcraft 2

O único plano deste repositório. A etapa ATUAL está marcada com **← ATUAL**.
Regras de trabalho: `CLAUDE.md` (vale por inteiro). Estado: `docs/STATUS.md`.
Problemas abertos e "Aguardando o jogador": `docs/PROBLEMS.md`. Arquitetura e a
cadeia: `docs/ARCHITECTURE.md`. Pesquisa: `docs/research/`.

Idioma dos documentos: os de acompanhamento que o jogador lê (`PLAN`, `STATUS`,
`PROBLEMS`, `MIGRATION`) em português; `ARCHITECTURE.md` e `docs/research/` em
inglês, como o código (CLAUDE.md: "Code, comments and docs are in English").

---

## 1. Inventário (conferido em 2026-10-12, 04:24, só leitura)

### 1.1 FONTE
- Ramo `planeta-esfera`, worktree `C:/Codex-Shared/roadcraft-planeta-esfera`,
  commit **`4cc2926ee22df6f69a3f047b180f2e1121a3437a`** ("Pessoas cozidas lidas no
  build de modos: caminho pela base do build (PL53)"). Igual ao último conhecido.
- Última escrita no worktree: 01:36 (nenhuma sessão escrevendo às 04:24).
- **Mudanças não commitadas (NÃO entram; só referência do que foi tentado):**
  18 modificados — `scripts/perf-gate.mjs`, `src/core/cubeSphere.ts`,
  `src/core/perfBudget.ts`, `src/core/planetTiles.ts`, `src/editor/persistence.ts`,
  `src/main.ts`, `src/render/buildings/buildingMesh.ts`,
  `src/render/buildings/finishes.ts`, `src/render/buildings/kit.ts`,
  `src/render/markings.ts`, `src/render/postprocess.ts`, `src/render/terrain.ts`,
  `src/render/terrainRelief.ts`, `src/render/wear.ts`, `src/ui/i18n/en.ts`,
  `src/ui/i18n/pt-BR.ts`, `src/ui/v2/shell.ts`, `src/world/doc.ts`; e 3 não
  rastreados — `src/core/worldSize.ts`, `src/render/glslHash.ts`,
  `tests/render/coplanar.spec.ts`. (O pedido falava em 15; são 21.)
- **Ramos com commits não integrados no `planeta-esfera` (NÃO entram):**
  - `agente/ceu` — 1: `fe93609a` "WIP não verificado (agente do céu encerrado):
    estrelas, Via Láctea e Lua fora de dia e nuvens só acima do ar";
  - `agente/transito` — 6: `14cc0508` AT5, `95d75c37` reverte AT5, `5c46dc6b` AT6,
    `f557e1dc` AT7, `b5c81ab2` AT7 (4ª tentativa), `0d1220b5` AT8;
  - `agente/populacao` — 1;
  - `master` — 49 (FORMA e o jogo plano de 2026-10-11 em 0,4 m/unidade).
  - Sem commits a integrar: `agente/construcao`, `agente/pesquisa`, `terrario`,
    `planeta-cubo`, `claude/compassionate-leakey-d8e774`, `codex/performance-audit`.
  - Os itens do `agente/transito` (AT5–AT8) e do `agente/ceu` só entram, se
    entrarem, como correção de uma etapa F, com pesquisa, teste e verificação.
- **Sessões do app (04:24):** "Roadcraft projeto novo e limpo" marcada como
  rodando, sem atividade desde 05:25 UTC (02:25 local), parada esperando
  resposta; não escreve (o worktree não muda desde 01:36). Não interajo com ela.
  "AUDITORIA", "FORMA", "Auditoria integral", "Diagnóstico e validação": paradas.
  "FORMA suite completo": outro projeto, nunca tocada (nem as portas 5181,
  5792-5796).

### 1.2 Tamanho da FONTE (commit)
- `src`: 528 arquivos no git (505 `.ts` pela auditoria, 179 mil linhas).
- `tests`: 352 arquivos. `scripts`: 73 no git (146 no worktree, contando `zz-*`
  não rastreados). `public`: 2.139 arquivos, 351 MB. `labs`: 226 (FORMA, fora).
- Documentação da FONTE: `docs/*.md` 565 KB + `docs/pesquisa` 335 KB.
- Pessoas cozidas (`cooked/`): geradas por `npm run cook:people`, fora do git.
- Fora de qualquer build (auditoria, source maps): 72 arquivos, ~18 mil linhas —
  `backup/`, `people/gen`, `render/people/generator`, `ui/creator`, `weaponsLab`,
  `humanGenerator`, `sandbox`, `studios`, `world/defaultTown`, `world/town`,
  `world/sampleTown`. A lista final sai da ferramenta (E2), não daqui.

### 1.3 O que entra e o que fica fora (regra; a lista arquivo a arquivo é do E2)
| entra | por quê |
|---|---|
| fecho de importações a partir de `index.html` → `src/main.ts`, workers (`new URL(..., import.meta.url)`, `?worker`) e importações dinâmicas, nas builds plano e planeta, conferido pelos BYTES que cada arquivo põe nos source maps de produção | é o que o jogo executa |
| specs cujo fecho de importações cai só em arquivos que entram | protegem o que entra |
| assets referenciados (estático + registro de rede de todos os cenários do portão e do teste de jogo) | o jogo carrega |
| `vite.config.ts`, `cook-plugin.ts`, `model-urls-plugin.ts`, `build-stamp.ts`, `tsconfig.json`, configs do vitest, `eslint.config.js` | build e verificação |
| scripts: `run-limited.mjs`, `cook-people.mjs`, `build-modes.mjs` (se usado), portão novo | usados |
| `desktop/` (Electron) — **a decidir pela ferramenta e registrado**: há mapas do jogador em `app://roadcraft` (perfil Electron), ou seja, o jogador usou o app desktop | recurso existente não sai sem o "sim" |

| fica fora | por quê |
|---|---|
| modo Jogar (`__PLAY_MODE__`), laboratório de armas, textos `play.*`/`player.*` sem uso | escopo (SAI) |
| `backup/crime`, `backup/residents` | escopo (SAI) |
| gerador de humanos, criador, people-lab, sandbox, studios, `*-system.html` | escopo (SAI) |
| `labs/` (FORMA) | outro projeto |
| `recast-navigation` e qualquer dependência sem import | sem uso (`knip`) |
| textos sem referência (850 de 2.842 pela auditoria) | sem uso (ferramenta) |
| `zz-*`, sondas avulsas, relatórios, `dist`, `cooked` | rascunho ou gerado |
| mudanças não commitadas e ramos não integrados | não verificados |

Ambiguidade a resolver na E2 pela ferramenta: a pistola fica (escopo), e o
`__PLAY_MODE__ = false` deixa fora do build as armas, os tiros, os ragdolls, o
sangue, as explosões e a destruição **do modo Jogar**; a BOMBA do dock de Ações usa
`render/blast.ts`, `destruction.ts`, `ragdoll.ts` (Jolt). O que entra é o que os
source maps das duas builds mostram com bytes, mais o que só carrega por
importação dinâmica ao escolher a bomba (registro de rede do cenário "bomba").

### 1.4 Mapas do jogador (achados só lendo; backup feito)
Backup: `C:/Codex-Shared/_backup/roadcraft-mapas-2026-10-12/` — duas cópias brutas
(`copia-1`, `copia-2`, 1.190 arquivos, 663 MB) com manifestos SHA-256 iguais,
`fontes.txt` (origem de cada pasta) e `extraido/` (conteúdo lógico lido de uma
CÓPIA do perfil num Chrome visível, com toda requisição respondida por página em
branco: o jogo nunca rodou nos dados). Onde procurei:
- Chrome `Default`: Local Storage + IndexedDB de todas as origens locais.
  Mapas achados:
  | origem | chave | tamanho |
  |---|---|---|
  | `127.0.0.1:4180` | IndexedDB `roadcraft-saves/sessions` `roadcraft.world.v7` | 11,6 MB (cidade gerada, plano) |
  | `127.0.0.1:5173` | idem | 11,4 MB |
  | `localhost:5173` | localStorage `roadcraft.world.v7` | 2,1 MB |
  | `localhost:4181` | localStorage `roadcraft.planet.atlas864.v1` | 1,5 MB (planeta) |
  | `127.0.0.1:5177` | `roadcraft.planet.atlas864.v1` | 7,6 KB |
  | `localhost:5175`, `localhost:5178` | `roadcraft.planet.atlas864.v1` | 1,3 KB cada |
  | `localhost:4180` | `roadcraft.world.v7` | 1,8 KB |
  Nada de mapa em 4182, 4183, 5176.
- Chrome `Profile 1` e `Profile 2`: nenhum mapa do Roadcraft.
- Edge `Default`: só `roadcraft.health.v1` e `roadcraft.atmosphere.v5`.
- App desktop (Electron, origem `app://roadcraft`; pastas `%APPDATA%/Electron` e
  `%APPDATA%/Roadcraft`): chaves `roadcraft.world.v7` presentes; copiadas em
  bruto (a leitura lógica exige o Electron; feita na prova de reabertura).
- Navegador do app Claude: suas pastas (`%APPDATA%/Claude`, partições
  `launch-preview-*`) não guardam nenhuma origem local do jogo.
- `C:/Codex-Shared/backup-mapa-jogador/roadcraft.planet.atlas864.v1.2026-10-11.json`
  (planeta, 0,4 m/unidade, `planetHalf` 7500).
- Prova de reabertura: cada mapa é injetado numa origem de rascunho (5301) no
  jogo antigo (build da FONTE) e depois no novo; contagem de nós, vias, prédios e
  foto de cada um. Nunca nas origens do jogador.

---

## 2. Portão (E1) — especificação

> **Substituído em 2026-10-13** (decisão do jogador: nada de processos lentos nem testes
> intermináveis; a conferência visual fica, curta). O portão foi removido; a barreira de regressão
> é o `npm run check` de ~1 min (análise do código, testes de segundos, contadores) — ver
> `docs/research/regression-barrier.md`. Onde as etapas abaixo dizem "portão", vale: contadores
> de trabalho mapa pequeno × grande e a conferência visual curta. A especificação abaixo fica
> como registro.

`scripts/gate.mjs <url> [--modo plano|planeta] [--cenarios ...] [--base <url>]`.
- **Onde:** build de produção servida por `vite preview`; Chrome com JANELA
  visível (`channel: 'chrome'`, `headless: false`, `--use-angle=d3d11`), na RTX
  3060. Cada rodada lê e registra o `GL_RENDERER` (rodada com outra GPU é
  inválida) e a carga da máquina antes (CPU total e memória livre; rodada com
  CPU > 40% de outros processos ou < 6 GB livres espera, e depois de 10 min sai
  com "NÃO VERIFICADO: máquina ocupada").
- **Rodadas:** cada cenário em rodadas A/B intercaladas (A = base, B = candidato),
  no mínimo 3 por lado, cada uma num processo novo do Chrome com perfil
  temporário limpo; resultado = mediana e dispersão (mín–máx); o ruído de cada
  métrica é medido por A/A (base contra ela mesma) e guardado com a linha de base.
  Reprova quando a mediana de B passa da de A além do ruído medido (e da
  tolerância registrada) ou quando um orçamento absoluto quebra.
- **Cenários (nos dois modos, plano e planeta):**
  1. mapa vazio (abertura, parado);
  2. cidade gerada com 400 pessoas e 400 veículos: vistas de rua, bairro e alto;
  3. girar, passear e zoom em todas as distâncias (da rua ao globo no planeta);
  4. 10 edições seguidas de via, perto e longe da cidade (cliques reais);
  5. zonear e crescer a cidade;
  6. bomba e pistola (dock de Ações, cliques reais);
  7. abrir um mapa grande (cópia do mapa de 11,6 MB do jogador);
  8. trocar de modo;
  9. 10 minutos parado (heap).
- **Métricas:** intervalo entre quadros (p50, p95, p99, máx) e quadros longos com
  autoria (LoAF, scripts); GPU p95 (`EXT_disjoint_timer_query_webgl2`, já no
  jogo: `__gpu`); draw calls e triângulos (`renderer.info`); programas de shader
  compilados depois de pronto (contagem de `renderer.info.programs` e
  instrumentação de `WebGL2RenderingContext.linkProgram`); bytes enviados à GPU
  durante movimento (instrumentação de `bufferData`, `bufferSubData`,
  `texImage2D`, `texSubImage2D`, `compressedTex*`); heap
  (`performance.memory`) e crescimento por minuto; tempo do clique até a via
  aparecer (primeiro quadro em que a malha nova é desenhada); tempo de abertura.
- **Fotos de referência por cenário,** comparadas por pixel (pixelmatch) no mesmo
  ambiente: simulação pausada e relógio do dia fixo para a foto, DPR 1, janela
  fixa 1280×720; inclui pessoas, carros e prédios de perto com câmera baixa. O
  ruído de foto é medido A/A (duas fotos da mesma build) e a tolerância nunca
  passa dele. Toda diferença é aberta e examinada antes de aceitar uma
  referência nova.
- Linha de base guardada em `gate/baseline/<modo>/` (números JSON + fotos PNG)
  com o hash da build e o nome da GPU.

---

## 3. Pesquisa: lida e a ler, por etapa
Ponto de partida: `docs/reference/` (auditoria e pesquisa do FORMA) e a pesquisa
da FONTE (`docs/pesquisa/fase-0` a `fase-8`, copiada para `docs/research/source/`
na E2). Cada fato que decide algo é reconferido na fonte e registrado em
`docs/research/<tema>.md` com o link aberto. O que não abrir fica como "não lido".

| etapa | ler (fontes primárias) |
|---|---|
| E1 portão | Chrome LoAF; `EXT_disjoint_timer_query_webgl2` (Khronos); Playwright `launchPersistentContext`, screenshots; pixelmatch; `performance.memory`; three `WebGLInfo` |
| E2 cópia | Vite build (`build.sourcemap`, workers), source map v3 (`sourcesContent`, mappings), TypeScript `preProcessFile`, `git hash-object` |
| E3 proteções | ESLint (`max-lines`, `no-empty`, `no-useless-catch`, regras locais, bulk suppressions), eslint-plugin-boundaries ou regra própria, dependency-cruiser (ciclos), knip (workers, produção), git `core.hooksPath`/pre-push |
| F1 controladores | SCXML (W3C), Redux style guide, mitt (código), operadores do Blender, keybindings do VS Code |
| F2 comandos | Nystrom *Command*; tldraw `HistoryManager`/RecordsDiff; Excalidraw `history.ts`; fast-check `fc.commands`; MDN IndexedDB (transações, durabilidade) |
| F3 células | Nystrom *Spatial Partition*/*Dirty Flag*; Build Systems à la Carte; Salsa; Unreal World Partition; SUMO (rede e reroteamento); OpenDRIVE (junctions) |
| F4 divisão | Fowler, *Refactoring* (Extract Module/Function); TypeScript project refs (se útil) |
| F5 shaders | three `WebGLRenderer.compileAsync`, `WebGLPrograms` (chave do programa), `KHR_parallel_shader_compile`; ANGLE/D3D11; KTX2Loader, Basis Universal |
| F6 veículos | three `BatchedMesh`, `InstancedMesh`, `LOD`; meshoptimizer `simplify`; ANGLE multi-draw |
| F7 pessoas | GPU Gems 3 cap. 2 (Animated Crowd Rendering); three skinning chunks; VAT; mip-mapping/aniso de texturas de pele; cartas de cabelo (alpha to coverage) |
| F8 sombras e pós | Microsoft *Cascaded Shadow Maps*; three `CSM`, `WebGLShadowMap`, `shadowMap.autoUpdate`; GPU timer por passe; `EffectComposer` |
| F9 memória | Chrome DevTools heap snapshots; `measureUserAgentSpecificMemory`; V8 alocação |
| F10 planeta | 3D Tiles (HLOD, geometric error); CDLOD (Strugar); AGI *Precisions, Precisions* (RTC); Cesium |
| F11 simulação | MDN Workers e Transferables; SUMO meso; IDM/MOBIL; A* e ALT |
| F12 defeitos | por item |

---

## 4. Esqueleto da arquitetura (detalhe em `docs/ARCHITECTURE.md`)
Camadas (impostas por lint e `tests/arch`):
`core → world → sim, render; world → editor → ui; core → view → render, ui`.
Controladores globais, cada um o único escritor dos seus dados: Documento (só
por comandos com inverso), Store da sessão (mudanças registradas, visível no
F9), máquinas de estado de ferramenta e modo, barramento tipado (lista fechada,
ordem documentada), registro único de comandos, Simulação (dona dos agentes),
Render (dono dos objetos de cena). A cadeia: comando → diário (retângulos) →
células sujas de uma grade fixa → derivados por célula → simulação e desenho só
das células afetadas e vistas.

---

## 5. Etapas

Toda etapa: antes, o que muda na cadeia escrito em `docs/ARCHITECTURE.md` e
conferido no código; pesquisa lida e mensagem curta antes de editar; fecha com
`npm run check`, portão (números antes → depois, mesma sessão), teste de jogo
com fotos examinadas uma a uma, `docs/STATUS.md` atualizado, commit e push.

| etapa | entrada | saída (pronto quando) | medições | fotos | riscos |
|---|---|---|---|---|---|
| E0 Preparação (feita) | — | sessões conferidas; FONTE registrada; backup duplo dos mapas com manifesto; repositório com `origin`, `.gitignore`, `.gitattributes`; jogo antigo (build de `git archive` da FONTE) servido na 4299; `.claude/launch.json` com 5300/5301/4299/4300; mapas reabertos no antigo numa origem de rascunho | — | cada mapa aberto no antigo | build da FONTE sem pessoas cozidas → cozinhar fora do jogo do jogador, com `run-limited` |
| E1 Portão | E0 | `scripts/gate.mjs` rodando no ANTIGO, nos dois modos, todos os cenários; ruído A/A; linha de base (números e fotos) guardada | todas as da seção 2 | todas as dos cenários | ruído alto (variação de 1,7× já vista) → mais rodadas, máquina conferida |
| E2 Cópia e igualdade | E1 | cópia calculada por ferramenta e conferida por `git hash-object`; `docs/MIGRATION.md`; SAI removido guiado por `tsc`/`knip`/lint; portão novo × antigo dentro do ruído e fotos iguais por pixel; mapas abrem iguais; specs verdes; teste de jogo inteiro | portão A/B antigo × novo | todas, lado a lado | arquivo carregado só em execução escapar → registro de rede |
| E3 Proteções (feita; envio junto com F1) | E2 | `npm run check` (lint de camadas, 800 linhas, `catch` mudo, estado de módulo, knip, ciclos, tipos, specs, arquitetura, escala); `.githooks/pre-push` com check + portão; dívida trazida em linha de base que só diminui; documentos vivos | o próprio check provocado de propósito (cada regra reprova uma vez) | — | dívida grande → linha de base com contagem que o `tests/arch` reprova se crescer |
| F1 Controladores (feita: ferramenta e teclado; barramento entra na F2) | E3 | store da sessão, máquinas de estado, barramento, registro de comandos; `main.ts` só conecta | portão igual | iguais | acoplamento em `main.ts` (4.777 linhas) → extração guiada por testes e portão |
| **F2 Documento por comandos** ← ATUAL | F1 | desfazer/refazer/autosave por diferenças; persistência sem regravar o mapa inteiro; mapas migrados com backup renovado; testes por modelo | bytes por edição (hoje 12,7 MB) e ms por edição | mapas reabertos | perda de dados → backup e ida e volta |
| F3 Derivados por célula | F2 | grade fixa alimentada pelo diário; superfícies, chão, grama, estruturas, postes, mobiliário, faixas e cruzamentos com remendo local, calçadas, vagas, pátios e docas, prédios por célula; trânsito remapeado sem parar; testes de escala por contadores | via isolada em mapa pequeno e grande (hoje 55 ms × 6,8 s) | vias, cruzamentos, trânsito correndo durante a edição | regressão de geometria → fotos e specs |
| F4 Divisão dos arquivos grandes | F3 | nenhum arquivo > 800 linhas; dívida de lint zerada | nada piora | iguais | regressão escondida → portão e fotos |
| F5 Shaders e texturas | F4 | catálogo fechado compilado na carga (com sombra e SHARP_MASK); 0 programas depois de pronto; envios com orçamento; causa dos 3 s de `texSubImage2D` eliminada; KTX2 onde reduzir memória sem perder aparência | programas, travadas, bytes enviados | iguais | `compileAsync` não cobre a sombra → quadro de aquecimento fora da tela |
| F6 Veículos | F5 | malha mesclada por modelo (vidro à parte), LOD real na build (meshoptimizer), recorte por instância, sombra com orçamento, sem matriz por peça na CPU | draw calls, triângulos, CPU | carros de perto iguais ou melhores | aparência do LOD → fotos de perto |
| F7 Pessoas | F6 | um sistema na GPU, preparado na build; bonitas de perto (causa confirmada antes) | CPU, envios, travadas | perto, aprovadas pelo jogador | fotos de perto pedem o "sim" do jogador → "Aguardando o jogador" |
| F8 Sombras e pós | F7 | cascatas, sombra refeita só quando algo se moveu, objeto pequeno sem sombra longe, orçamento por passe, nada desenhado sem ser visto | GPU por passe | iguais ou melhores | mudança visual da sombra → fotos antes/depois |
| F9 Memória | F8 | crescimento parado eliminado; nenhuma alocação em laço quente | heap/min, MB/s | — | causa não achada → instantâneos comparados |
| F10 Planeta e plano | F9 | curvatura só onde aparece; cartas e divisas num módulo; abertura sem travada; transição contínua; experimento de tamanho de mundo | GPU no zoom, abertura | transição, perto e longe | quebrar mapas existentes → importador testado |
| F11 Simulação | F10 | pedestres, lotes, caminhões e A* medidos e corrigidos; worker só se o portão pedir | ms de passo | trânsito ao longo do tempo | — |
| F12 Defeitos abertos | F11 | cada item de `PROBLEMS.md` + os do pedido, com causa e teste | por item | por item | — |
| F13 Fechamento | F12 | check, fuzz, portão, teste de jogo, docs; metas finais da seção 7 do pedido | todas | todas | — |

Metas finais (F13): cidade 400/400 na rua, nos dois modos, p99 ≤ 20 ms e nenhum
quadro > 50 ms movendo a câmera depois do aquecimento; via nova visível em
≤ 100 ms sem quadro > 33 ms, custo igual em qualquer mapa; 0 compilações de shader
durante o jogo; heap estável em 10 min parado; nenhuma métrica pior que a linha
de base.

## 6. Decisões sem o jogador
Técnicas: resolvidas pela pesquisa e medição, registradas em `docs/research/`.
Tirar recurso, baixar qualidade visual, afrouxar orçamento ou teste: não faço;
vai para `docs/PROBLEMS.md`, "Aguardando o jogador", com a recomendação.
Bloqueio real numa etapa: registrado em `STATUS` e `PROBLEMS`, sigo com a próxima
etapa que não dependa dela.
