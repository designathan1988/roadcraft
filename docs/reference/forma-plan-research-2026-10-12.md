<!-- Plano escrito pela sessão "FORMA suite completo" em 2026-10-12, colado pelo jogador. Referência de PESQUISA para o Roadcraft 2: fontes lidas, fatos que decidem e direções sobre vias, trânsito, pessoas, terreno, comandos e desfazer, arquitetura de estado e eventos, desenho, persistência e qualidade. Não é o plano do Roadcraft 2; cada fato decisivo é reconferido na fonte antes de usar. -->

# Plano — FORMA completo (suíte de cidade) no repositório novo

## Resumo (o que este plano faz, em ordem)

1. **Migração (etapa M)**: backup dos projetos da 5792 (só no perfil Default do Chrome) por cópia e leitura offline, sem
   tocar a origem; cópia por ferramenta, a partir dos blobs do commit `f4e9969c`, de só o que o editor usa (116 arquivos,
   29.140 linhas); prova de igualdade (mesmo JSON com IDs semeados, mesmas fotos por pixel com o ruído medido, mesmos
   números lado a lado, testes verdes); origens próprias; a 5792 passa a servir esta pasta como build de entrega
   (autorizado), nunca como servidor de desenvolvimento.
2. **Pesquisa (etapa R)**: os 22 temas viram `docs/research/*.md`. Boa parte já foi lida neste modo plan (seção 3:
   centenas de fontes abertas por mim e por agentes só de leitura, cada uma listada, e o que não abriu marcado como não
   lido); a etapa R reconfere cada fato decisivo na fonte, completa o que faltou (DNIT/MBST, NACTO, OpenDRIVE normativo,
   TCQSM, USDA) e mede o que só se decide medindo.
3. **Definição (etapa D)**: `ARCHITECTURE.md`, `INTERFACE.md` com protótipos navegáveis na 5796 fotografados nas duas
   telas, `PLAN.md` com a lista fechada (74 ferramentas de construção + vias, lotes, paths, paisagismo, assets, terreno,
   simulações) e orçamentos, `PROBLEMS.md` com todas as pendências; proteções (`npm run check`, camadas, escala,
   `pre-push` com portão de imagem e desempenho). **Parada única para aprovação.**
4. **Desenvolvimento (etapas 1–23, com a 4b)**, na ordem da cadeia, cada etapa pronta só com e2e, fotos examinadas,
   números antes/depois e push; a 5792 recebe a build de cada etapa pronta.

Decisões técnicas que a pesquisa já aponta (a etapa R confirma ou corrige): WebGLRenderer com three r186 (não WebGPU
agora); BatchedMesh só para arquitetura parada e InstancedMesh para agentes e vegetação; catálogo fechado de shaders;
Manifold mantido e núcleo forma/4 por nós com referências persistentes; documento em registros com comandos e patches;
diário no OPFS e arquivo zip; statechart, store, barramento e registro de comandos próprios; terreno em grade com
modificadores no modelo do Civil 3D e CDLOD; vias no modelo OpenDRIVE com seção estilo Civil 3D; lotes por quarteirão
com envelope pelos índices brasileiros (SP primeiro); trânsito IDM+MOBIL com meso longe e rotas CRP/CCH por célula;
pessoas com rede de calçadas, ORCA perto e um só sistema de personagens assado na build; transporte por linhas no modelo
GTFS; física Rapier sob demanda; sol/sombra, clima, ruído, redes e economia como demais simulações.

## Contexto

O FORMA atual vive em `C:/Codex-Shared/Roadcraft/labs/building/forma` (só leitura), misturando três gerações de
código, com um `editor.ts` de 4.977 linhas, desfazer por cópia do projeto inteiro em JSON, um único evento
(`change | history`) e projetos só em `localStorage`. O usuário quer o FORMA terminado — qualquer construção sobre
terreno real, criador de assets, paths, vias, lotes que crescem, paisagismo e simulações de trânsito, pessoas,
transporte público, física e as demais que a pesquisa definir — num repositório novo (`C:/Codex-Shared/forma`,
remoto `designathan1988/forma`, ramo `main`), na ordem: migrar só o que é usado e provar igualdade → pesquisar a
fundo → definir por escrito (arquitetura, interface, plano) → **uma parada para aprovação** → desenvolver até o fim.

Tudo o que segue foi conferido por mim nesta sessão (comandos só de leitura), salvo onde está escrito "a conferir".

---

## 1. Inventário confirmado

### 1.1 Fonte, sessões e estado

| item | valor conferido |
|---|---|
| FONTE | Roadcraft `master` **`f4e9969cd6e835a116bb880e7825479fed0bd02f`** (2026-10-12 02:53 −0300), 73 commits em `labs/building/forma` desde `2f1d223a` (2026-10-11) |
| Mudança sem commit em `labs/building/forma` | **nenhuma** (`git status`: 0 modificados, 0 não rastreados); último arquivo gravado às 02:52, já no commit |
| Sessões do app | "FORMA" e "AUDITORIA" **paradas** (`isRunning: false`, cwd Roadcraft); "Roadcraft projeto novo e limpo" **rodando** (cwd Roadcraft); "Auditoria integral do Roadcraft" e "Diagnóstico e validação" paradas |
| Remoto `designathan1988/forma` | vazio (`git ls-remote` sem referências) |
| Repositório novo | só `CLAUDE.md` (sem `.git`) |
| Servidores vivos agora | 5794, 5796 e 5182 (configs `forma-scratch`, `forma-proto`, `forma-builds` do Roadcraft, servindo `forma-work`); **5792 desligado** |
| Onde estão os projetos da 5792 | **só no perfil "Default" do Chrome** (`%LOCALAPPDATA%/Google/Chrome/User Data/Default/Local Storage/leveldb`; chaves `forma3_*` achadas nas tabelas `.ldb` — a pasta compacta sozinha com o Chrome aberto, então a lista de arquivos muda). Nenhuma cópia no navegador do app nem nos perfis "Profile 1"/"Profile 2"; nenhum `*.forma3.json` em Downloads, Documentos ou Área de Trabalho |
| Chaves que o código usa | `forma3_project` (autosave), `forma3_project_invalid` (cópia de um salvo que não abriu), favoritos do catálogo, seções fechadas (`kit.ts`), `forma3_aside_w`; o forma/2, que a 5792 também servia em `/`, usava `forma_project_v2`, `forma_project_v1`, `forma_project_v2_invalid` e `COACH_KEY` — o backup lista quais existem e com que tamanho, e os do forma/2/v1 são provados pelo "Open" antes de `/` passar a levar ao editor |

### 1.2 O que entra (calculado por ferramenta: `ts.preProcessFile` a partir das entradas)

Entradas: `src/app/editor.html` → `src/app/editor.ts`, mais o worker `src/f3/worker/eval.worker.ts`, que entra por
importação dinâmica `import('../worker/eval.worker?worker&inline')` em `src/f3/eval/pool.ts`.

**116 arquivos `.ts`, 29.140 linhas** (com linhas em branco):

| pasta | arquivos | linhas |
|---|---|---|
| `src/f3/editor` | 8 | 7.003 (`editor.ts` 4.977, `view.ts` 1.012) |
| `src/f3/families` | 17 | 3.779 |
| `src/f3/eval` | 15 | 3.603 |
| `src/f3/ui` | 13 | 3.422 (`inspector.ts` 893) |
| `src/f3/model` | 13 | 2.966 |
| `src/f3/render` | 11 | 2.737 |
| `src/f3/io` | 4 | 1.348 |
| `src/f3/kernel`, `src/f3/worker` | 2 | 86 |
| forma/2 usado: `src/geometry` (13), `src/core` (9, inclui `migrate/v1.ts`), `src/styles` (5), `src/render` (`context`, `build-building`, `modules`, `textures`), `src/ui/icons.ts` | 32 | 4.052 |
| `src/app/editor.ts` | 1 | 144 |

Mais: `src/app/editor.html`, `src/vite-env.d.ts` e `src/worker/inline.d.ts` (declarações de tipo de `?url` e
`?worker&inline`), as **24 texturas** `src/app/public/tex/*/{color,normal,rough}.jpg` (8 conjuntos, 23 MB, todos
referenciados por `f3/render/pbr.ts`), o `.wasm` do `manifold-3d` (pacote).

Dependências externas usadas: `three` (core, `GLTFExporter`, `OBJExporter`, `GLTFLoader`, `EffectComposer`,
`RenderPass`, `GTAOPass`, `OutputPass`, `UnrealBloomPass`), `manifold-3d` (+ `.wasm?url`), `polygon-clipping`,
`earcut`. Ficam fora: `three-mesh-bvh` (só o forma/2 `render/lod.ts`), `vite-plugin-singlefile` (só o HTML único
do forma/2).

**Testes que entram**
- Unitários que só tocam código que vem (22 arquivos): os 20 `test/unit/f3-*.test.ts`, `roofs.test.ts`,
  `skeleton.test.ts`.
- Unitários ligados ao **v1** por `test/unit/legacy.ts`, que carrega `test/legacy/forma-core.js` ao ser importado:
  `migrate.test.ts` e `polygon.test.ts` usam o oráculo (`Legacy.worldPolygon`, `Legacy.cutVolume`, mensagens de erro);
  `parity.test.ts` não usa o oráculo, só `fixtures()` e `baselines()` (dados). O código que testam vem (a migração v1
  abre arquivos antigos), mas o v1 fica fora. Decisão: dividir `legacy.ts` (ficam `rng`, `randomPolygon`, `fixtures`,
  `baselines`, sem o `require` do v1) e **gravar as saídas do oráculo**, inclusive as exceções (o `cutVolume` que recusa
  e vira `continue`; a igualdade de mensagens de erro), em `test/fixtures/legacy-oracle/*.json`, rodando-o na cópia
  congelada; trocar só a origem do valor esperado. Prova de equivalência: na cópia congelada, cada valor gravado é igual
  à saída viva do oráculo e o número de asserções é o mesmo antes e depois; prova de sensibilidade: o teste adaptado
  reprova quando a função é quebrada de propósito numa cópia de rascunho. Os projetos v1 (`test/fixtures/v1/*.json`) e
  `legacy-baselines.json` entram como dados.
- Unitários mistos (casos que só usam código que vem + casos do forma/2 que não vem): `styles.test.ts` (linhas
  1–62 só `src/styles`), `lot.test.ts` (`core/indices`, `geometry/lot` vs `editor/ops`, `editor/lot-ops`). Entram só
  os casos que usam código que vem, cada um idêntico ao original; os outros ficam fora com o motivo.
- Fora (testam só código que não vem): `interiors`, `lod`, `ops`, `ring-ids.fuzz`, `templates`.
- e2e: `e2e/f3.spec.ts` (1.713 linhas, 39 testes) entra; `e2e/editor.spec.ts` (forma/2 em `/` e `/host-scene.html`) fica.
- Desempenho: `test/perf/eval.perf.ts` (`perf:gate`) entra.
- Contagem atual: 271 `it(` nos unitários (todos os arquivos), a reconferir por arquivo na cópia.

**Scripts que entram**: `scripts/perf-app.mjs` (cenário no Chrome visível; aponta para 5794 e limpa o storage; importa
`playwright`, que hoje só vem como dependência transitiva — passa a ser declarado com a versão do lockfile).
Ficam: `extract-legacy.mjs`, `record-legacy.mjs`, `make-fixtures.mjs` (v1), `port-css.mjs` (CSS do forma/2).

**Configurações e demais arquivos** (classificados um a um no `docs/MIGRATION.md`): `package.json` entra editado (sem
`build:lib`, `exports`, `main`, `vite-plugin-singlefile`, `three-mesh-bvh`; com `playwright`); `package-lock.json` entra e é
a fonte das versões (`npm ci` e depois `npm uninstall` do que saiu); `tsconfig.json` entra sem `examples` no `include`;
`vite.config.ts` é refeito só para o editor (o de hoje constrói o forma/2 em arquivo único e guarda a config do vitest);
a config do vitest vai para `vitest.config.ts` com `maxWorkers: 6`; `vitest.perf.config.ts` e `playwright.config.ts`
entram (este com `CI=1`); `test/unit/legacy.ts` entra dividido; `test/fixtures/styles/ornate.json` só se algum caso que
entra o usar (decidido pela ferramenta); `examples/` (forma/2), o `README.md` (só do forma/2) e o `CLAUDE.md` antigo
ficam fora (há um `CLAUDE.md` novo; o README é reescrito na etapa D).

**Documentos que entram** (como histórico, convertidos para a estrutura nova na etapa D): `docs/RESEARCH.md`,
`docs/research/workspaces-and-nodes.md`, `docs/TOOLS.md`, `docs/SELECTION.md`, `docs/INTERFACE.md`,
`docs/AUDIT-2026-10-11.md`, `docs/PLAN.md` (o plano antigo vira seção "histórico" do `docs/PLAN.md` novo).

### 1.3 O que fica fora (e por quê)

| o quê | motivo |
|---|---|
| 30 arquivos de código, ≈6,5 mil linhas: app forma/2 (`app/index.html`, `main.ts`, `host-scene.*`, `v3.*`), `src/editor/*` (8), `src/index.ts` (lib do jogo), `src/io/*` (2), `src/render/{collision,lod,lot,worker-client}.ts`, `src/geometry/{collision,ring-ids,rooms}.ts`, `src/ui/{legacy.css,panels.ts,shell-html.ts,shell.ts,styles.css}`, `src/worker/parts.worker.ts` | fora do grafo de importações do editor e do worker |
| v1: `test/legacy/*`, `scripts/{extract,record}-legacy.mjs`, `make-fixtures.mjs` | pedido do usuário; o oráculo vira arquivos de referência |
| `vite.lib.config.ts`, `exports` e `main` do `package.json` | biblioteca do forma/2 para o jogo |
| `dist/`, `dist-app/`, `test-results/`, `node_modules/`, caches `.vite*` | gerados |
| fotos, relatórios e sondas de `forma-audit`, `forma-work`, `forma-lab`, `forma-proto` | fora do código; ficam onde estão, só leitura |

A lista final, arquivo por arquivo, sai da ferramenta e vai para `docs/MIGRATION.md` com o motivo de cada exclusão.

### 1.4 Pendências encontradas (todas)

Lidos por inteiro: `forma-audit/{RELATORIO,RELATORIO-2,RELATORIO-3,AUDITORIA,CONSTRUCOES,DESEMPENHO,PROPOSTA-rascunho}.md`,
os `docs/*.md` da FONTE, `README.md`, `CLAUDE.md` e `forma-work/relatorio/corpo.html` (último relatório, 12/10 00:36;
`forma-work` não tem nenhum `.md`). Aberto/fechado decidido por `[x]` no `PLAN.md`, nota de correção ou commit.
Contagem do levantamento: **49 itens abertos** (defeitos e funcionalidades), **24 incertos**, **13 perguntas nunca
respondidas**, **11 números não alcançados**; mais de 60 itens fechados conferidos por commit. A tabela completa, com
`arquivo:linha` de cada item (já levantada nesta sessão e salva no passo M0b), vira `docs/PROBLEMS.md` na etapa M.
Todos os itens, agrupados:

**A. Defeitos abertos**
- D27: arcos de canto arredondado nunca recebem janelas. D16: depois de um arrasto real, 1/2/3 vão para a caixa de medida.
- E3: offset que cai no Clipper2 perde a identidade dos lados (materiais por lado e peças hospedadas).
- A2 "tijolo aparente" mantém a cor do reboco; B2 segunda mensagem do corte Shift com altura relativa; B3 peças divididas
  chamadas "(upper) (upper)" copiando todas as regras; C3 regras na mesma face se sobrepõem; C4 largura cresce do centro e
  engole o anexo sem aviso; C-D4 modo subtrair fica ligado; C-D6 parede curva facetada; C-E8 cartão do catálogo errado.
- F11 ação sem efeito anuncia sucesso; F13 dois volumes sem "Duplicar"; normais não normalizadas no GLB.
- 1.11a sem "voltar ao valor do tipo" por campo; 1.11b editar parâmetro com tipos diferentes não faz nada nem avisa.

**B. Funcionalidades pendentes do plano antigo** (todas entram na lista fechada da etapa D)
- Workspaces; vistas ortográficas, várias vistas, wireframe/raio-X, plano de corte livre; predefinições de navegação.
- Núcleo forma/4 (sólido livre, referências persistentes, combinar/descombinar, painel de histórico).
- Modos Objeto/Componente, Alt atravessa, selecionar ligado/anel/laço; rótulos editáveis de offset e arrasto.
- Ponte, revolução, varredura (Follow Me), loft, arrays linear/grade/radial/caminho, escala proporcional, encaixe 3D por
  contato, arco desenhado direto, offset "cópia" como grupo com espessura, campo de raio, array de volumes e cortadores.
- Encaixe em faces, interseções, cumeeiras, componentes e arestas verticais; guias, réguas, eixos, plano de trabalho em
  qualquer face, pivô configurável, grade adaptativa; caixa de medida com expressões, coordenadas e ângulo.
- Pré-visualização e escolha na composição por contato, nó Combinar, descombinar, solda de vértices.
- Propriedades: identidade/etiquetas, trava de proporção, tabela de pavimentos, lote/índices, informação (áreas, volume),
  expressões nos campos, arrastar para agrupar na árvore; pavimentos por volume (C5); sótão (C-E2); mezanino (C-E4);
  janela de canto (C-E5); cortes planos por volume, telhado cortado por componente, perfis varridos; sólido livre.
- Catálogo paramétrico de centenas de tipos (mobiliário, vegetação, mobiliário urbano) e editor de famílias no app.
- Biblioteca de materiais do projeto e editor de materiais em camadas.
- Interior: paredes, portas e janelas internas, lajes com recortes, escadas entre níveis, replicar pavimentos, caminhar;
  escadas, rampas, pilares e vigas presos aos pavimentos, com abertura na laje e grade estrutural.
- Histórico que sobrevive ao recarregar, versões, arquivo `.forma`; importar IFC/DXF/glTF, exportar IFC.
- Sol geográfico, edição de UV, plantas/cortes/elevações 2D, áreas e quantitativos, cenas salvas e exportação em alta.
- LOD para projetos grandes; dividir `editor.ts`; contornos e alças sem alocar por quadro.

**C. Números não alcançados**
- Explodido: ~1,2 s nas 11 amostras; 200 prédios desenhados em 5,4 s (p95 33,4 ms, pior 50 ms, medido sem interface).
- Corte (cutaway) em 200 prédios: clique 9–14 ms, mas 3,5–6 s para desenhar tudo; "Show all" ~4,5 s no grande (proposta 3).
- Edição numa torre de 40 pavimentos congela 0,3–0,55 s (avaliação de edição fora do worker: P5); torre de 20 pavimentos
  124 ms contra a meta ≤60 ms (P6: cache por volume/fachada, aberturas 2D); P4 cortar peças por faixa uma vez; P7 chave de
  material por face; reabrir o grande 4,5 s; quatro vistas dobram a CPU (7,4 → 15,8 ms); histórico ≤50 MB não construído.
- Números de quadro registrados em Chrome sem interface: não fecham pergunta de quadro (CLAUDE.md); refazer na RTX visível.

**D. Incertos (reverificar na cópia, etapa M)**: D3 (cota com toldos?), C-D1 ("NÃO VERIFICADO na imagem"), C1 (galpão
de 8 m), C-D5, F12, F2–F10 (corrigidos sem reconferência), P3, P8 (`Box3.setFromObject` na cena toda), dica que segue o
ponteiro, contorno em espaço de tela, registro de comandos (atalhos e HUD leem o mesmo?), os cinco prédios de validação,
estado das fases B/C/E antigas, faces de telhado selecionáveis, offset em arco (0,96 m em vez de 2 m), itens da
`INTERFACE.md` (grupos com pressão longa, contador de avisos, tema claro, recentes), testes nunca feitos (caixa de
seleção em vértice/aresta, arrastar da biblioteca, 2560×1440), resíduo D15, chaves deixadas na 5792, README só do forma/2.

**E. Perguntas ao usuário nunca respondidas (13)**: cota com ou sem toldos; 1/2/3 depois de arrastar; F12; conjunto de
workspaces; estado da vista interior no projeto ou no workspace; edição de subelemento num volume limpo escrita no lugar ou
como nó; dividir lado e regras de fachada; volumes derivados antigos; atalho se o Chrome ficar com Ctrl+PageUp/PageDown;
galpão de 8 m; corte por GPU na vista interior; quatro vistas; regra de pavimentos de volume desenhado sozinho. Na etapa D
cada uma é respondida pela pesquisa quando for técnica, e só as de projeto vão para a parada de aprovação.

### 1.5 Roadcraft (só referência; nada é copiado sem decisão da pesquisa)

Lido por inteiro: `roadcraft-planeta-esfera/docs/{PROBLEMAS,VIAS,ZONEAMENTO,investigacao-populacao,relatorio-desempenho-mapas-enormes-2026-10-11}.md`
e `Roadcraft/docs/proposta-projeto-novo-2026-10-12.md`, mais `docs/pesquisa/fase-2-mundo-unico-celulas.md` e
`fase-3-workers.md`. O que vale aqui:
- **Regras que custaram caro**: cache local nunca chaveado por contador global (o derivado lê o diário por área); nunca
  criar material num rebuild (um material por combinação, feito uma vez); o que fica no chão espera o job de edição e é
  testado contra o retângulo de cada item; registro novo ≠ lote novo; conteúdo que só depende de assets e código é assado
  na build ou fica em cache derivado, nunca refeito em jogo.
- **Armadilhas medidas**: `instancingColor` entra na chave do programa; `DynamicDrawUsage` no ANGLE/D3D11 reenvia o buffer
  inteiro; `InstancedMesh` vazio ainda desenha; `rAF` para em painel oculto; `localStorage` 5 MiB; `fetch` absoluto +
  `catch` silencioso fez as pessoas pré-assadas nunca carregarem; layout forçado por `getBoundingClientRect`.
- **Já tentado e falho**: troca de faixa a cada 0,25 s; três tentativas de pedestres girando nas esquinas (resolvido por
  faixas do SUMO + tangente contínua); LOD de pessoas não resolve criação lenta; cidade gerada seguindo o relevo (AC8, três
  tentativas); árvores "com LOD" que nunca carregaram; assar pessoas no servidor de desenvolvimento travou o PC.
- **Números de referência** (i9-12900K, RTX 3060): passo da simulação 400/400 de 3,3 ms (6×6) a 9,7 ms (36×36); rua de
  100 m isolada num mapa de 4,3 km custava 6,8 s de topologia; desfazer copiava 12,7 MB; ~190 programas de shader; heap
  +600 MB/min parado; 519–542 draw calls e 12,2 M triângulos na rua.
- **Pesquisa já feita lá, reaproveitável como ponto de partida** (`docs/pesquisa/fase-0…8`): medição de GPU e quadro,
  "fazer menos", células e derivados incrementais (Build Systems à la Carte, Salsa), desfazer por diferenças (tldraw,
  Excalidraw, Figma), IndexedDB por célula, pool único de workers (Cesium, Piscina), simulação em worker com níveis
  micro/meso, CDLOD/RTC/HLOD, KTX2, sombra e resolução, COOP/COEP com `SharedArrayBuffer`.
- **Contradições a resolver pela pesquisa**: BatchedMesh foi banido no Roadcraft (3 s de compilação nas ruínas) e no FORMA
  derrubou as draw calls de 1.847 para 189; o LOD médio de carro aparece como feito e como ausente.

---

## 2. Backup e migração dos projetos do usuário

Objetivo: nenhuma perda, prova de que cada projeto reabre, e a 5792 servindo esta pasta na mesma origem **sem nunca
rodar código em andamento sobre os dados do usuário**.

1. **Cópia bruta, primeiro de tudo** (nada toca a 5792): copiar a pasta
   `%LOCALAPPDATA%/Google/Chrome/User Data/Default/Local Storage/leveldb/` para
   `C:/Codex-Shared/_backup/forma-5792-2026-10-12/chrome-default-leveldb/` **duas vezes**, com manifesto SHA-256; as duas
   cópias têm que bater (o Chrome está aberto e o LevelDB compacta sozinho: arquivos de 03:52–03:58 já existem depois dos
   de 23:31; o `LOCK` fica de fora). Conferir também se a origem tem IndexedDB ou File System no perfil (registrar).
2. **Exportação lógica offline (primária)**: um leitor de LevelDB escrito por nós (tabelas `.ldb` com blocos snappy +
   `.log`, entradas mais novas vencem, apagamentos respeitados; chaves `_http://127.0.0.1:5792\0\1<chave>` com o prefixo de
   codificação do valor) lê a cópia e grava cada chave da origem em
   `C:/Codex-Shared/_backup/forma-5792-2026-10-12/localStorage/<chave>` com SHA-256. Lista **todas** as chaves e tamanhos:
   `forma3_project`, `forma3_project_invalid`, preferências do f3 e as do forma/2 (`forma_project_v2`, `forma_project_v1`,
   `forma_project_v2_invalid`, `COACH_KEY`), que a 5792 também servia em `/`.
   **O leitor é provado antes de ler os dados do usuário**, sem tocar a 5792: num perfil próprio do Playwright (contexto
   persistente, numa origem de rascunho) gravo valores conhecidos em `localStorage` (texto grande, Unicode, chave
   regravada, chave apagada), fecho o navegador, copio a pasta LevelDB desse perfil e o leitor tem que devolver exatamente
   esses valores. Só então ele lê a cópia do usuário. Nenhum código roda na origem 5792 (abrir o editor poderia migrar e
   regravar o projeto). Se o leitor não puder ser provado, a alternativa — ler `localStorage` numa página em branco da
   5792 no Chrome do usuário, perfil Default conferido, só nomes/tamanhos/hashes — só acontece com o "sim" explícito do
   usuário naquele momento.
3. **Prova de que reabre** — feita no passo M7 (depende das origens 5181 e 5794 do M4/M5), nunca na 5792: num Playwright
   com perfil próprio, injetar cada cópia em `localStorage` antes de carregar `editor.html` com o mesmo `randomUUID` com
   semente nos dois lados; conferir que abre (o `forma3_project_invalid` é guardado como está: por definição já não abria),
   o número de prédios/volumes/itens, e o JSON depois de abrir e salvar igual entre o código congelado (5181) e o copiado
   (5794); os projetos do forma/2 e v1, se existirem no backup, abertos pelo "Open" (que migra forma/2 e v1) antes da troca
   da 5792; foto de cada projeto, examinada. Um `LEIA-ME.md` em português no backup diz como restaurar.
4. **Backup renovado antes de toda etapa que muda dado persistido** (1: preferências; 2: armazenamento; 6: forma/4; e as
   que acrescentam coleções — terreno, vias, lotes...): cópia offline do perfil (LevelDB e, depois da etapa 2, a pasta do
   OPFS da origem), com manifesto; a migração é provada na 5794 com as cópias do backup; o código **nunca apaga** a chave
   antiga — apagar só com o "sim" do usuário.
5. **A 5792 passa a servir esta pasta como build de entrega, não como servidor de desenvolvimento**: a configuração
   `forma-building` do `launch.json` do Roadcraft (hoje `npm run dev`, que recarregaria a aba do usuário a cada edição em
   andamento e deixaria o autosave gravar com código não verificado) passa a rodar `vite preview --strictPort` sobre
   `C:/Codex-Shared/forma-user/dist/` — uma build feita de `git archive` do **último commit de etapa pronta e enviada**,
   refeita só quando uma etapa fecha. Feito no passo M7b, depois da prova de igualdade (autorizado pelo usuário; única
   edição no Roadcraft) e antes da primeira mudança de esquema. Este repositório **não** tem configuração para a 5792 no
   seu `.claude/launch.json` (só 5794, 5796 e 5181), para nenhuma ferramenta minha ligar ou anexar nela.
6. Os servidores vivos agora na 5794, 5796 e 5182 servem `forma-work` e ocupam as portas deste repositório; são parados
   (autorizado; só o processo `node` daquela porta, conferido pelo PID e pela linha de comando) antes de subir os daqui.

---

## 3. Pesquisa

Como foi feita no modo plan: eu e agentes só de leitura (no máximo um pesquisador por tema) abrimos as fontes com WebFetch
ou lemos o código-fonte local; trecho de resultado de busca não contou. WebFetch devolve um resumo extraído da página por
um modelo pequeno, não o texto bruto: na etapa R cada fato que decide algo é reconferido na fonte e citado com o trecho.
O que não abriu (403, 404, PDF acima de 10 MB, proteção anti-robô) está listado como **não lido** — nunca citado como lido.

Ponto de partida conferido: o que o FORMA já pesquisou (`docs/RESEARCH.md`, `docs/research/workspaces-and-nodes.md`,
`forma-audit/pesquisa/*` — 13 temas e a síntese) e a pesquisa do Roadcraft (`docs/pesquisa/fase-0…8`). Mapa de cobertura
(do inventário integral desses arquivos): **sem cobertura nenhuma** — vias, paisagismo, trânsito, pessoas, transporte,
física, terreno; **parcial** — matriz de construções, assets, paths, lotes, demais simulações, documento, comandos,
arquitetura de app, avaliação incremental, desenho, persistência, interface, qualidade; **coberto para um prédio** —
kernel, materiais. Conflitos já registrados entre esses arquivos (a etapa R resolve cada um): conjunto de workspaces;
estado da vista interior; desfazer por cópia × diferenças; expor ou não o grafo de nós; sólido livre agora ou só com
evidência; cortador por ordem × alvo explícito; o que "combinar" significa; cache por volume antes ou depois de medir;
`fit` estica ou não as peças; nunca reatar por proximidade × âncora escolhida pela proximidade na criação; `simplify`
funde faces coplanares; regra da escada.

Cada tema vira `docs/research/<topic>.md` na etapa R com: perguntas, alternativas comparadas, fontes lidas (links),
decisão, critério de validação e o que ficou sem leitura. As listas completas de URLs abertos e falhos de cada tema
(devolvidas pelos agentes) vão para esses arquivos; aqui fica o resumo.

| # | tema | subseção | arquivo |
|---|---|---|---|
| 1 | Qualquer construção (matriz) | 3.1 | `capability-matrix.md` |
| 2 | Kernel e topologia (forma/4) | 3.2 | `kernel-topology.md` |
| 3 | Criador e editor de assets | 3.3 | `assets.md` |
| 4 | Paths | 3.4 | `paths.md` |
| 5 | Vias | 3.5 | `roads.md` |
| 6 | Lotes e crescimento | 3.6 | `lots-growth.md` |
| 7 | Paisagismo | 3.7 | `landscape.md` |
| 8 | Trânsito de veículos | 3.8 | `traffic.md` |
| 9 | Pessoas | 3.9 | `people.md` |
| 10 | Transporte público | 3.10 | `transit.md` |
| 11 | Física | 3.11 | `physics.md` |
| 12 | Demais simulações | 3.12 | `other-simulations.md` |
| 13 | Documento e dados | 3.13 | `document-data.md` |
| 14 | Comandos e desfazer | 3.14 | `commands-undo.md` |
| 15 | Arquitetura de aplicação (+ simulação, 3.16b) | 3.15 | `app-architecture.md` |
| 16 | Avaliação incremental | 3.16 | `incremental-eval.md` |
| 17 | Desenho e desempenho | 3.17 | `rendering.md` |
| 18 | Terreno e topografia | 3.18 | `terrain.md` |
| 19 | Materiais | 3.19 | `materials.md` |
| 20 | Persistência e troca | 3.20 | `persistence-exchange.md` |
| 21 | Interface da suíte | 3.21 | `interface.md` |
| 22 | Qualidade e regressão | 3.22 | `quality.md` |

(As subseções abaixo estão na ordem em que a leitura terminou; a tabela dá a ordem dos temas.)

### 3.1 "Qualquer construção": matriz de capacidades → `docs/research/capability-matrix.md`
- **Perguntas**: que tipos de construção cada software de referência faz nativamente? qual o conjunto fechado de
  ferramentas para fazer todos os tipos pedidos? como provar (conjunto de validação e critérios)?
- **Lido**: Revit (telhado por extrusão, edição de forma de laje/telhado, curtain system por face, escada por componentes,
  rampa, guarda-corpo por caminho, Toposolid, massa local, formas de família, componentes de padrão, paredes inclinadas e
  afuniladas, treliças), Archicad (Shell extrudada/revolvida/regrada, Morph, regras de escada com solucionador,
  guarda-corpo associativo, vigas e pilares por segmentos), Rhino 8 (SubD, recursos), Grasshopper, SketchUp (terreno,
  Stamp, Drape), FormIt (níveis, Dynamo, Cover/Sweep/Loft), Autodesk Forma (prédio básico, Building Design, barra de
  ferramentas), CityEngine CGA (`roofGable`, `roofRidge`, `envelope`, `taper`, `i`), Archipack (telhado, escada),
  Building Tools, Bonsai. Mais o que o FORMA já tinha lido (SketchUp, Blender, Rhino, Revit, Archicad, Fusion, Onshape).
- **Resultado**: matriz construção × ferramenta (só Revit e Archicad tratam circulação e estrutura como objetos; nenhum
  cobre as 20 linhas) e a **lista fechada de 74 ferramentas** em 11 grupos — criar (13: pegada, prédio em barra ao longo de
  caminho, extrusão com afunilamento e inclinação, revolução, varredura, loft, superfície regrada, casca fina, sólido SubD,
  primitivas cúpula/abóbada/arco/pirâmide, envelope de zoneamento, gerador por grafo, importação com modos de encaixe),
  modificar volumes (10), subelementos (5), telhados (7: por pegada com parâmetros por aresta e plantas não convexas, por
  extrusão — abóbada de berço e shed —, por face, cascas, águas-furtadas e cortadores, acabamentos, cobertura envidraçada),
  aberturas e fachadas (5: curtain system em qualquer face, superfície dividida + componentes de padrão, regras com WWR),
  estrutura (5: vigas e pilares por segmentos, gerador de pórtico, treliça por linha, space frame/grid shell, fundações que
  cortam o terreno), circulação vertical (5: escada por componentes, regras de escada com solucionador, rampa reta/com
  patamar/helicoidal, guarda-corpo associativo, núcleo de elevador), interior e níveis (4), terreno (7), organização (6),
  precisão (7). Cada item marcado "existe", "estender" ou "novo".
- **Conjunto de validação V1–V20** (todos em terreno inclinado real, só com ferramentas do FORMA, parâmetros editáveis
  depois): casa térrea com empena e varanda; sobrado em L com quatro águas e água-furtada; bloco de 8 pavimentos com
  varandas e núcleo; torre reta de 30 pavimentos com pele de vidro; torre de planta curva; torre torcida 1,5°/pavimento;
  torre escalonada a cada 10 pavimentos; fábrica com pórticos de 30 m e shed; loja com vitrine e marquise; escola em U com
  rampa; hospital com embasamento e torre; igreja com tambor e cúpula, nave em abóbada de berço e arcada; estádio com
  arquibancada, cobertura tensionada e space frame; garagem em meio-níveis com rampas; muro de arrimo e muro de jardim
  escalonado; escadas reta/L/U/helicoidal; rampas; passarela entre dois pontos do terreno; pórtico de 6 colunas com frontão;
  prédio irregular com pátio. Cada um com critério de aceite (ex.: escada com altura total igual ao piso ±1 mm; rampa
  ≤ 1:12 com patamares; união manifold; cúpula assentada no tambor).
- **Critérios**: tudo manifold; parâmetros editáveis depois de edição de subelemento (ou conversão explícita com aviso);
  valores digitados ±1 mm e ±0,1°; cada sessão de ferramenta desfaz num passo; glTF de cada um válido; volumes de corte e
  aterro relatados.
- **Não lido**: Wall/Floor/Roof by Face do Revit, restrições e estacionamento do Forma (403), Follow Me do SketchUp,
  parâmetros de `roofHip`/`roofShed` do CGA, núcleo de elevador (nenhuma fonte trata).

### 3.3 Criador e editor de assets → `docs/research/assets.md`
- **Perguntas**: como um asset expõe parâmetros; onde e como encaixa (face, aresta, path, telhado, chão); variantes e
  tabelas de tipos; tipo × instância e tornar único; modelagem livre dentro do asset sem perder na regeneração; versões e
  migração; biblioteca com busca, tags e miniaturas; importar/exportar; LOD por asset.
- **Lido**: Revit (catálogo de tipos, ferramentas do editor de famílias, parâmetros associados de famílias aninhadas,
  fórmulas), Archicad Library Part Maker e objetos paramétricos, SketchUp Dynamic Components (atributos, opções
  configuráveis), **Blender Asset Browser e catálogos** (UUID, tags, prévias, link/append/pack), ferramentas de nós do
  Blender, **Houdini Digital Assets** (criar, namespaces e versões, interface, instalar/gerenciar, editar, sistemas de
  versão), Construction Script do Unreal, glTF `MSFT_lod`, `KHR_materials_variants`, `EXT_mesh_gpu_instancing`.
- **Direção — modelo de asset**: `AssetDef` com id UUID, `ns::nome` e versão maior/menor (Houdini), catálogo por UUID e
  tags (Blender), metadados e miniatura, tipo do asset, **planos e linhas de referência** (Revit), parâmetros com escopo
  tipo/instância, unidade, faixa, grupo, controle, visibilidade/habilitação condicionais e alça ligada a referência,
  **tabela de tipos** (importa/exporta CSV, como o catálogo do Revit), fórmulas seguras, geometria = grafo (CSG do
  Manifold, varredura, array, divisão) **+ partes modeladas livremente "congeladas" e ancoradas a referências** (nunca
  apagadas pela regeneração — o FormIt perde edições dentro de grupos do Dynamo), **conectores** (onde encaixa: face de
  parede, face de telhado, qualquer face, aresta, path, borda de laje, topo de muro, borda de escada, chão, nível; alinhar à
  normal/vertical/inclinação; modos de encaixe do CGA; repetição; folga; vazio que corta o hospedeiro; associativo),
  aninhamento com ligação de parâmetros, slots de material e variantes (→ `KHR_materials_variants`), LODs (→ `MSFT_lod`),
  migrações entre versões (análogo ao `SyncNodeVersion`). Tornar único = bifurcar a definição com linhagem. Bibliotecas:
  embutida, do projeto e do usuário/equipe (biblioteca vence a embutida, com exceção por projeto).
- **Editor**: workspace de Assets com árvore de catálogo e grade, vista isolada com seletor de hospedeiro de teste (parede,
  telhado 0–60°, borda de laje, chão em declive), inspetor, tabela de tipos e o **"Flex"** (percorre cada tipo × mín/máx de
  cada parâmetro e relata saída não manifold ou falha); criar a partir da seleção, promover parâmetro de um nó, cotar para
  virar parâmetro, publicar menor (com migração) ou maior (tipo novo), testar no contexto.
- **Validação**: Flex 100%; cada tipo de conector encaixa em 5 hospedeiros de teste; migração 1.0 → 1.1 sem perder
  sobreposições; 2.0 convive com 1.x; ida e volta glTF mantém LODs, variantes e instâncias; busca por tag e por valor de
  parâmetro; partes congeladas sobrevivem a 100 edições de parâmetro.
- **Não lido**: "flex" e cotas travadas do Revit (só busca), favoritos do Archicad, regras de encaixe de assets além de
  guarda-corpos/CGA/folhagem — o esquema de conectores é **síntese**, não cópia, e será validado nos protótipos.

### 3.2 Kernel e topologia → `docs/research/kernel-topology.md` (núcleo forma/4)
- **Perguntas**: manter Manifold ou trocar (B-rep/OCCT, SDF)? como nomear de forma persistente o que o usuário referencia
  (face, aresta, vértice) através de booleanas e edições anteriores? modelagem direta, histórico paramétrico ou nós? qual a
  política quando uma referência some ou se divide? precisão em escala de cidade?
- **Já lido** (FORMA): Manifold (README, `manifold.h`, `common.h`, wiki, `csg_tree.cpp`, `.d.ts` instalado: `faceID`,
  `originalID`, `reserveIDs`, `asOriginal`, `ExecutionContext`), OCCT/replicad, CGAL (licença), three-bvh-csg, JSCAD,
  verb, Clipper2, earcut, Blender modificadores e Geometry Nodes, Fusion Timeline/Compute All, Onshape FeatureScript,
  FreeCAD 1.0, Houdini cooking e Cache If, Lipp et al. 2008 (localizadores ancorados). **Esta sessão**: realthunder
  *Topological Naming* (mapa de elementos com sufixo de operação, nomes re-resolvidos pelo mapa, versão do mapa que
  força recomputar), Onshape `library.html` (IDs hierárquicos espelhando o histórico; consulta que resolve várias
  entidades "pega a primeira"), AGI *Precisions, Precisions* (float32 ~1 cm até 131 km; RTC por célula).
- **Direção**: Manifold continua (OCCT só se B-rep/STEP forem pedidos; SDF fora do escopo inicial); núcleo forma/4 da seção
  4.5 com chaves semânticas por origem (gerador/lado/vértice/papel), `faceID` atravessando booleanas, **sem "pegar a
  primeira"** (Onshape) e sem reatar por proximidade; uma referência que se divide é tratada pelo tipo de consumidor
  (face inteira → todos os pedaços; um ponto → o pedaço que contém a coordenada paramétrica, senão aviso); versão do
  algoritmo de nomes gravada (realthunder) para forçar recomputar quando mudar; precisão por coordenadas relativas à
  célula.
- **A resolver na etapa R** (conflitos registrados): expor o grafo ao usuário ou só a pilha por volume; sólido livre já no
  forma/4 ou depois; cortador por ordem ou por alvo explícito; `simplify`/`asOriginal` e faces coplanares; medir H7/H8/H9
  (perfil da avaliação, fuzz do esqueleto reto) antes de decidir o cache por volume.
- **Não lido**: wiki do FreeCAD sobre TNP (anti-robô), página do algoritmo do realthunder sobre divisão/sumiço, resto da
  documentação de consultas do Onshape (`qCreatedBy`), núcleos SDF.

### 3.13 Documento e dados → `docs/research/document-data.md`
- **Perguntas**: esquema de cada módulo e versões; migração global ou por objeto; IDs e referências; relações e
  restrições guardadas como; unidades; georreferência; cidades grandes; partição em células para o custo depender do que
  muda e do que se vê.
- **Já lido**: Roadcraft `fase-2` (Unreal World Partition e HLOD, 3D Tiles, Build Systems à la Carte, Salsa, Nystrom,
  Figma, tldraw, Excalidraw, MDN IndexedDB e cotas); FORMA `parametrico-e-restricoes` (planegcs LGPL, libslvs GPL-3, kiwi
  BSD-3, Revit restrições, SolveSpace), `persistencia-historico-interop`, `workspaces-and-nodes` (esquema forma/4, IDs
  nunca reutilizados, estado de nó calculado e nunca gravado).
- **Direção**: registros normalizados por coleção (cada módulo tem as suas: terreno, vias, nós e cruzamentos, quarteirões,
  lotes, regras, prédios, assets e tipos, paths, vegetação, linhas, simulações), IDs nunca reutilizados, referências só
  por ID; relações num lugar só (`model/relations`), estendidas a terreno → via → lote → prédio; restrições lineares
  persistentes (kiwi) só se a pesquisa de assets pedir; unidade interna metro, ângulo em graus no documento; origem do
  projeto georreferenciada (lat/long + projeção) e tudo em metros locais; versão de esquema por coleção com migração
  testada por ida e volta; célula dona por âncora + índice por caixa.
- **A medir na etapa R**: tamanho da célula (256 m como ponto de partida do Unreal/Roadcraft; conferir contra o ruído de
  bordas e o custo de HLOD).
- **Não lido**: Nystrom *Spatial Partition* (citado pelo Roadcraft, não relido), tiling implícito do 3D Tiles, guias de
  restrições do planegcs/kiwi além dos READMEs, política de GUID do IFC (`IfcGloballyUniqueId`) para IDs estáveis.

### 3.14 Comandos e desfazer → `docs/research/commands-undo.md`
- **Perguntas**: comando com inverso como (patch por registro, delta, estrutura persistente)? o que é um passo de desfazer
  num gesto contínuo? desfazer enquanto workers avaliam? limite do histórico por bytes? autosave e recuperação depois de
  queda? custo por edição constante em projeto grande?
- **Não lido**: código do `reverseRecordsDiff` do tldraw e do `StoreDelta.inverse` do Excalidraw (só extração), artigo
  sobre compressão de patches citado pelo Immer, estruturas persistentes (bibliotecas) — decidir pela medição.
- **Já lido**: Nystrom *Command*; Figma multiplayer; tldraw `HistoryManager` (diffs de registros, marca por gesto, inverso
  aplicado numa chamada); Excalidraw `history.ts` (guarda o inverso, recalcula no desfazer); Yjs `UndoManager`; Blender
  undo; **esta sessão**: Immer patches (patch + patch inverso, não mínimo; aplicar sobre estado divergente).
- **Direção**: seção 4.2 item 1 — patches por registro, gesto = uma entrada, inverso recalculado no desfazer, histórico
  limitado por bytes (não por cópias), autosave dos registros sujos; teste-oráculo "desfazer N e refazer N devolve o
  documento" sobre sequências sorteadas (fast-check, modelo de comandos); custo por edição constante (teste de escala).
  Immer não entra como dependência se o patch por registro bastar (decidir na etapa R pela medição).

### 3.16 Avaliação incremental → `docs/research/incremental-eval.md`
- **Perguntas**: como o grafo de dependências atravessa domínios (terreno → vias → lotes → prédios → simulação); bit sujo
  ou rastros com hash e parada antecipada; prioridade pela vista; cancelamento de job em execução; tamanho do pool;
  orçamento da thread principal para aplicar resultados.
- **Não lido**: custo de memória e de partida de um worker no Chrome (nenhuma fonte achada), *Transferable Objects:
  Lightning Fast!*, importação dinâmica em worker de módulo empacotado pelo Vite 8, demonstrações do *Build Systems à la
  Carte*.
- **Já lido**: Build Systems à la Carte (mínimo, parada antecipada, rastros de verificação/construtivos), Salsa (revisão
  global, backdating, durabilidade), Nystrom *Dirty Flag*, Houdini cooking e Cache If (ID de dados), Cesium/Piscina/Unity
  jobs (pool, prioridade, cancelamento, contrapressão), Surma (custo do `postMessage`), MDN scheduler e
  `requestIdleCallback`, web.dev *Optimize long tasks* (Roadcraft `fase-2`/`fase-3`, FORMA `workspaces-and-nodes`).
- **Direção**: seção 4.2 item 6; oráculo "incremental = do zero" por camada; contadores de trabalho por camada nos testes de
  escala; o tamanho do pool sai de uma curva medida (jobs/s × CPU total para 2…10 workers) no i9-12900K, não de fórmula.

### 3.4 Paths → `docs/research/paths.md`
- **Perguntas**: geometria do caminho (própria ou referência a outra curva; comprimento de arco; edição depois);
  distribuição (contagem, espaçamento, justificar, sobra, quebras, peças de início/canto/fim, padrões de vários objetos);
  orientação; repetir rígido × deformar × esticar; comportamento vertical no terreno; variação com semente estável;
  desenho e invalidação.
- **Lido**: Revit (padrão de balaústres, postes, divisões de curtain wall), 3ds Max Spacing Tool (19 modos), Blender Array
  (4.2 e atual) e Curve, Houdini Resample, Copy to Points e atributos de instância, Rhino ArrayCrv (orientação livre,
  "roadlike", "stairlike"), Unreal PCG Spline Sampler, nós do PCG, `USplineMeshComponent`, splines da paisagem, DXF
  (LWPOLYLINE/VERTEX e o `bulge`), `Curve.js` do three.
- **Direção**: geometria própria (vértices com `bulge` na semântica do DXF + trechos suaves ou clotoides, aberto/fechado)
  **ou referência com deslocamento** a qualquer curva (borda de via, meio-fio, divisa de lote), reavaliada quando a fonte
  muda; comprimento de arco exato para retas e arcos, tabela adaptativa para splines (nunca as 200 divisões fixas do three);
  regra de colocação que contém Revit e 3ds Max (padrão de itens com distância e deslocamento; contagem fixa, distância
  fixa ou espaçamento máximo; justificar início/fim/centro/espalhar; deslocamentos de início e fim; excesso: nada,
  truncar ou item de preenchimento; quebra em cada vértice, acima de θ ou nunca; itens de início, canto e fim; orientação
  nenhuma/seguir/"roadlike"; modo rígido, deformado ou esticado); vertical: rígido assenta no terreno acabado e fica em pé,
  deformado segue o perfil 3D, painéis em degrau ou inclinados; **semente por path com aleatório chaveado por (path,
  trecho, índice)** — estável quando outro trecho muda (a semente por posição do PCG muda tudo; não usar); instâncias por
  célula; geometria deformada em worker; invalidação proporcional aos itens afetados.
- **Validação**: reproduzir exatamente os exemplos das fontes (Revit 1100/400 → 3 instâncias; curtain grid 46/5 → sobra de
  1 ft no início; 3ds Max "divide evenly, objects at ends"; PCG "fit to curve"; Houdini "even last segment"); cantos onde o
  ângulo passa de θ; continuidade sem costura no modo deformado; estabilidade da semente; base dos itens no chão.
- **Não lido**: lista completa de quebras do Revit, página atual do Array do Blender inteira, visão geral do Spline Mesh do
  Unreal (vazia), enums do PCG Spline Sampler, semântica completa dos modos do 3ds Max.

### 3.5 Vias → `docs/research/roads.md`
- **Perguntas**: modelo de alinhamento (reta/arco/clotoide, greides com curvas por K, superelevação); modelo da seção
  transversal e sua variação ao longo da via; cruzamentos, rotatórias e acessos com geometria exata e ligações de faixa
  editáveis; amostragem sem meio-fio serrilhado; encaixe no terreno (taludes, muros, pontes, túneis); biblioteca de tipos
  e checagem contra normas (Brasil × EUA); topologia de faixas para a simulação, refeita só onde mudou.
- **Lido**: OpenDRIVE (visão geral 1.9.0 da ASAM e o arquivo de exemplo oficial `Signalized_T_Intersection.xodr`),
  `odrSpiral` (VIRES), libOpenDRIVE, Civil 3D (corredores, regiões, frequência de montagens, subassemblies, códigos),
  FHWA-HRT-17-098 (resumo do Green Book), **TxDOT** (alinhamento horizontal, vertical, curvas verticais, seção
  transversal, raios mínimos de giro, interseções), **MUTCD** 3A/3B (marcações), CS2 (ferramentas de via, Traffic AI),
  NCHRP 1043 (resumo), Roadcraft `VIAS.md` (Streetmix, TMPE, MBST vol. IV, defeitos).
- **Fatos que decidem**: no OpenDRIVE cada movimento num cruzamento é uma "connecting road" e **só elas se sobrepõem**;
  e + f = V²/(127R); e_max 4% em urbano de alta velocidade, coroa normal em ruas ≤ 45 mph; raios mínimos a e = 0
  (15 mph 14,3 m … 45 mph 274 m); K de crista/vale por velocidade; inclinação transversal 2%; meio-fio 6 in (152 mm) ou
  montável ≤ 4 in; raios de esquina 4,6–7,6 m para automóveis e curvas de três centros para caminhões; gabarito vertical
  5,03 m; MUTCD: tracejado 10/30 ft, linha 4–6 in; MBST (via Roadcraft): LMS-1 0,10–0,15 m, tracejado 1:2 abaixo de 60
  km/h; Streetmix com passo de 0,1 m (o Roadcraft forçou 1 m).
- **Direção**: alinhamento horizontal em retas/arcos/clotoides (OpenDRIVE) manipulado por PIs e raios (Civil 3D),
  vertical por PVIs com parábolas por K, superelevação e(s) pelas regras de transição, coroa normal em urbano de baixa
  velocidade; **seção transversal** = lista ordenada de elementos (UX do Streetmix) com subassemblies estilo Civil 3D
  (larguras por polinômio, alturas, sentido, usos, material; códigos Top/Pave/Datum/Kerb/Daylight), seções de faixa onde
  a topologia muda, alvos (largura que segue uma curva), talude condicional ou muro, resolução de 0,1 m; estações em
  todos os pontos geométricos e por tolerância de flecha; meio-fios e bordas como offsets exatos (fim do "serrilhado");
  **cruzamento no modelo OpenDRIVE** (fronteira do cruzamento, pontas aparadas, connecting roads ajustadas às tangentes,
  esquinas como concordâncias com raio pelo veículo de projeto, ilhas como polígonos que as connecting roads não podem
  invadir — validação, não esperança — e ligações de faixa manuais persistentes); cada via e cada cruzamento é um job de
  worker chaveado pelas entradas; regras regionais de marcação (MBST padrão, MUTCD opcional) e normas como **avisos com
  números**, nunca travas silenciosas.
- **Validação**: continuidade de rumo nas juntas e de curvatura onde há clotoide; desvio de corda do meio-fio ≤ 5 mm e
  sem inversão de rumo; superfície estanque entre via e cruzamento; envelope de cada connecting road dentro da área
  dirigível menos as ilhas; toda faixa de entrada com saída e sem faixas-armadilha; números das normas; mover um nó refaz
  ≤ 2 cruzamentos e as vias daquele nó, com tempo que não cresce com a rede.
- **Não lido** (prioridade da etapa R): texto normativo do OpenDRIVE (certificado expirado no host; o HTML 1.6 passa de
  10 MB), **NACTO** (403), guia de rotatórias da FHWA e NCHRP 672/1043 (PDF), **DNIT IPR-706 e MBST** (PDF) — os números
  brasileiros de raio, superelevação e K **não estão verificados**; só os dos EUA (TxDOT) têm fonte; larguras de ciclovia.

### 3.6 Lotes e crescimento → `docs/research/lots-growth.md`
- **Perguntas**: como cortar quarteirões irregulares (relevo) em lotes; como os índices brasileiros viram um envelope 3D
  por lote; o que move o crescimento ao longo do tempo; o que acontece com o construído quando a regra muda; como o
  crescimento se adapta à encosta; como travar e editar convivem com a regeneração.
- **Lido**: Parish & Müller 2001 (PDF da ETH), CityEngine (parâmetros de quarteirão Recursive/Offset/Skeleton, `setback`
  do CGA, crescimento de ruas com declive), Vanegas et al. 2012 *Inverse Design*, wiki do CS1 (zoneamento, demanda) e do
  CS2 (zoneamento, níveis), dev diary 2 do CS1, Townscaper, **Lei 16.402/2016 de São Paulo** (arts. 41, 42, 56, 60, 62,
  66, 68, 69, 70, 71, 72, 81, 1 III), Gestão Urbana SP, UrbanSim (pro forma e modelo do incorporador). Do Roadcraft:
  `ZONEAMENTO.md`, `PROBLEMAS.md` (AC8 — três tentativas falhas de cidade no relevo, com números).
- **Fatos que decidem**: no relevo do AC8 os quarteirões ocupam só 50–78% da caixa orientada e só 64% da área virou lote
  (89% em grade); o método recursivo de caixa supõe quarteirão convexo e retangular; o "Skeleton" do CityEngine dá lotes
  alinhados à rua "que sempre têm acesso"; SP: lote mínimo 125 m² e testada 5 m, altura máxima 28 m em declive > 30%,
  dispensa de recuo lateral/fundo até 10 m de altura, permeabilidade 20%/15%, uma árvore por 50 m² permeáveis; o
  crescimento no CS2 sobe de nível quando a renda cobre a manutenção e decai até o abandono quando não cobre.
- **Direção**: quarteirões = laços fechados da rede de vias; método por quarteirão pela retangularidade (caixa recursiva
  acima do limiar, esqueleto/faixas com acesso forçado abaixo; limiar calibrado); lotes desenhados ficam como desenhados,
  gerados levam semente e `owner: generated`; **envelope puro em worker** (pegada = lote menos recuos por aresta de
  rua/lateral/fundo, TO, CA básico/máximo, gabarito medido do térreo, regra de encosta, TP), cada regra violada é
  **relatada, nunca corrigida em silêncio**; tipologias próprias para encosta (platôs, meio-nível, subsolo à luz do dia) e
  modo de alinhamento ao terreno por lote; nunca apagar o terreno esculpido; demanda calculada da própria cidade;
  subida de nível ao longo do tempo; mudança de regra replaneja lotes vazios e marca construídos como "não conformes"
  (mantidos e relatados); travado = fora de toda regeneração; prédio gerado editado vira do usuário (diferença sobre a
  semente). Conjuntos de regras por município como dados (SP como primeiro conjunto completo).
- **Validação**: no mesmo morro do AC8, ≥ 514 prédios (plano) e ≥ 234 (planeta) ou critério acordado; ≥ 52 lotes/km;
  ≥ 89% da área do quarteirão em lotes; 0 lote vazio em encosta; 100% dos gerados passam TO/CA/altura/recuo/TP; variedade
  e terraplenagem no nível já medido; mudança de regra em 200 prédios sem tarefa longa > 50 ms.
- **Não lido**: Vanegas 2012 *Parcels* (PDF > 10 MB), Quadro 3 da Lei 16.402 (.docx), lei de Curitiba, dev diary de
  crescimento do CS2, Forma Site Automation (login).

### 3.7 Paisagismo → `docs/research/landscape.md`
- **Perguntas**: como descrever espécies (porte adulto, curva de idade); regras de colocação (espaçamento, folgas,
  declive, altura, ao longo de paths); como a idade muda o tamanho; como milhares de árvores ficam baratas sem perder a
  aparência (sem repetir as árvores que nunca carregaram e as folhas acima do orçamento do Roadcraft); como gramados,
  canteiros, pisos e água entram na permeabilidade.
- **Lido**: Bridson 2007 (Poisson disk), Blender *Distribute Points on Faces*, Unreal Procedural Foliage, Foliage mode e
  PCG, Twinmotion, GPU Gems 3 cap. 16 (vegetação do Crysis), SpeedTree no Unity, floresta de impostores no three, Godot
  Octahedral Impostors, **Manual Técnico de Arborização Urbana de SP (2005)**, OpenBARD. Do Roadcraft: P10, P19, PL31, P81.
- **Fatos que decidem**: porte pequeno ≤ 5 m, médio 5–10 m, grande > 10 m; largura da calçada limita o porte (< 1,50 m:
  nenhuma árvore; > 3,00 m: > 12 m); distâncias mínimas (entre árvores 5/8/12 m, esquina 5 m, postes 3/4/5 m, fachada
  2,4/2,4/3 m, hidrante 1/2/3 m); faixa livre de 1,20 m; Poisson disk O(N); vento por dobra principal + detalhe com
  canais de cor de vértice (Crysis); trocar para impostor só quando o tamanho na tela não passa da resolução assada.
- **Direção**: registro de espécie (porte, altura e copa adultas, DAP, forma, caducidade, floração, curva de idade);
  Poisson disk com raio por espécie + folgas da tabela de SP contra vias, postes, esquinas, fachadas e portões; largura
  da calçada limita o porte; densidade 0–1 com filtros de declive e altura; ao longo de paths com afastamento do meio-fio;
  dentro do lote ≥ 1 árvore/50 m² permeáveis; gramados, canteiros, piso permeável e água como camadas de polígono que
  somam à TP; idade escala a instância com 2–3 malhas por estágio; desenho: malha perto (orçamento de triângulos do
  Roadcraft, detalhe de folha na textura), simplificada no meio, **impostor hemi-octaédrico 16×16 assado na build** longe;
  vento no vertex shader; assets por `import.meta.glob`, nunca regenerados ao abrir.
- **Validação**: 100% das espécies carregam; 0 violação de folga; TP por lote ≥ mínimo; triângulos por árvore no orçamento;
  um draw por espécie e nível numa cena de 10 mil árvores; sem "pipoca"; mesma silhueta perto e longe nas fotos.
- **Não lido**: SpeedTree (403), USDA Urban Tree Database (403 — curvas de idade ficam como suposição marcada até serem
  lidas), artigo do Ryan Brucks, manuais de paisagismo para gramados, pisos e piscinas, Lumion.

### 3.8 Trânsito de veículos → `docs/research/traffic.md`
- **Perguntas**: modelos de seguimento e troca de faixa, passo de tempo; cruzamentos, preferência, semáforos, rotatórias,
  inserção sem impasse; meso longe e transição micro↔meso; rotas que aguentam edição contínua; demanda; estacionamento,
  carga e serviço; números que provam realismo.
- **Lido** (esta sessão): IDM e MOBIL (traffic-simulation.de, código do movsim `models.js`/`control_gui.js`, arXiv
  cond-mat/0002177); SUMO (car-following, definição de veículos e parâmetros, sublane, interseções, semáforos, inserção,
  capacidade da via, meso, rotas, roteamento automático, rerouter, estacionamento, padrões por tipo, FAQ de desempenho,
  aleatoriedade); FHWA *Traffic Signal Timing Manual* cap. 3 (citando o HCM 2000); CS2 (página Traffic AI e dev diary #2);
  CCH (arXiv 1402.0402); MATSim (documentação). Do Roadcraft: `fase-1`, `fase-4` (Gaffer, CRP, Burghout, Mass).
- **Fatos que decidem**: IDM balístico é estável com passo < 0,5 s; parâmetros realistas a 0,8–2,5 m/s², b ≈ 2 m/s², δ 4;
  fluxo de saturação 1.800–1.900 veíc/h/faixa, perda inicial ≈ 2 s (FHWA/HCM); inserção a velocidade 0 limita o fluxo a
  ≈1.200 veíc/h (SUMO); meso "até 100× mais rápido" (SUMO); só reroteiam os veículos cuja rota toca o elemento mudado
  (SUMO rerouter, CS2); SUMO em C++ faz 80 mil atualizações/s numa grade complexa, um núcleo — **não há número para JS:
  medir**.
- **Direção**: IDM + MOBIL com viés estratégico; passo 0,1 s perto (interpolado no desenho), 0,25–0,5 s micro grosso,
  filas meso por evento longe, contagens agregadas mais longe; cruzamentos com a estrutura do SUMO (prioridade, distância
  de visibilidade, `keep-clear`) e detector de impasse no lugar do teletransporte; semáforos fixos (ciclo 90 s) e atuados
  (5–50 s); roteamento A* com limite ALT dentro da célula + sobreposição CRP/CCH sobre as células, recustomizada só nas
  tocadas; demanda por atividades em uma passada (CS2), OD para conexões externas; estacionamento destino → alternativa →
  troca de modo; tudo em worker; edições aplicadas como patch com remapeamento (seção 4.4).
- **Validação**: diagrama fundamental, descarga de fila 1,9–2,0 s/veíc, c = s·g/C, o mesmo cenário rodado no SUMO dentro do
  ruído entre sementes, meso × micro ±10% por link em 1 h, zero impasse em 100 s, atualizações/ms no worker.
- **Não lido**: HCM original, Geisberger 2008 (CH), artigo do HPA*, artigo completo do CCH, livro do MATSim, LC2013.

### 3.9 Pessoas → `docs/research/people.md`
- **Perguntas**: rede de caminhada em grafo (calçadas, travessias, áreas) ou navmesh; evitação local e só perto da câmera;
  negociação pedestre × veículo nas travessias; de onde vêm as rotinas; como desenhar milhares de pessoas animadas no three;
  como ter um só sistema de personagens preparado na build.
- **Lido**: Helbing & Molnár (resumo arXiv), ORCA e RVO2 (páginas e `RVO.h`), Recast/Detour (repositório,
  `DetourCrowd.h`, `DetourTileCache.h`), SUMO pedestres e pessoas, MUTCD 4E (velocidades de travessia), CS2 lifepath,
  GPU Gems 3 cap. 2, VAT do Houdini, City Sample do Unreal, código do three r186 (`Skeleton`, `InstancedMesh`,
  `skinning_pars_vertex`, `BatchedMesh`).
- **Fatos que decidem**: o DetourCrowd se limita a "20 a 30" agentes (não serve para cidade); listras do SUMO (0,65 m),
  regras de travessia (entrar só se ficar livre durante a travessia; veículo nunca entra em travessia ocupada; saída de
  impasse em 10 s na travessia); 1,39 m/s médio, 1,07 m/s de projeto (MUTCD); o three **não tem skinning instanciado
  embutido** (um `boneTexture` por draw); GPU Gems 3: 9.547 personagens a 34 fps em 2007 com textura de animação.
- **Direção**: rede de caminhada gerada do documento de vias (calçadas, travessias, áreas de caminhada); ORCA só perto e em
  áreas cheias, listras no meio, sem interação longe; navmesh em peças só para praças livres; rotinas por domicílio
  compartilhadas com a demanda de veículos (um sistema de demanda); **um único sistema de personagens assado na build**
  (corpos + roupas fundidos por LOD, animações numa textura de matrizes, `InstancedMesh` com shader estendido, VAT ou
  impostor no LOD mais longe), nada vestido nem animado na CPU durante o uso.
- **Não lido**: texto completo de Helbing & Molnár (parâmetros), artigo do ORCA, diagrama fundamental de pedestres
  (Weidmann), skinning instanciado no WebGPU/TSL.

### 3.10 Transporte público → `docs/research/transit.md`
- **Perguntas**: esquema interno de linhas, paradas, viagens e frequência; modelo de tempo de parada e embarque; o que
  diferencia baia, BRT, bonde, trem e metrô; como os passageiros escolhem entre transporte e carro; como o CS2 faz.
- **Lido**: referência GTFS (espelho no GitHub; gtfs.org deu 403), SUMO transporte público e padrões de veículos, CS2
  (transporte público e carga, Traffic AI).
- **Direção**: linha = rota + forma no grafo de faixas, paradas ordenadas (`location_type`), modo pelo `route_type`;
  operação por frequência (headway = volta ÷ veículos, como no CS2) com horário opcional; ônibus e bonde como veículos do
  trânsito, baia como área fora da faixa, BRT/metrô/trem em classes de faixa exclusivas; tempo de parada =
  máx(mínimo, embarques × t_e + desembarques × t_d + portas), parâmetros calibráveis; passageiros por contagem e indivíduos
  só perto da câmera; escolha por custo generalizado; ida e volta GTFS.
- **Não lido** (fica para a etapa R): TCQSM 3ª ed. (PDFs acima do limite — buscar capítulos em HTML), sinalização de bloco
  ferroviário, dev diaries de transporte do CS1.

### 3.15 Arquitetura de aplicação → `docs/research/app-architecture.md`
- **Perguntas**: máquinas de estado com biblioteca ou próprias, e com que semântica de entrega; store da sessão com
  biblioteca ou mínimo com log; barramento com lista fechada, ordem documentada, reentrada e ouvinte que lança; registro
  de comandos (registro, habilitação, desfazer, refazer com valores novos) e resolução de atalhos; workers de módulo no
  Vite e o custo do `SharedArrayBuffer` (COOP/COEP).
- **Lido**: XState v5 (`setup`, TypeScript, atores, paralelos, guardas, transições com atraso, inspeção), `@xstate/store`,
  **SCXML do W3C** (macropasso, fila interna, ordem saída → ações → entrada, prioridade), mitt e nanoevents (código),
  Zustand (código), guia de estilo do Redux e `createSlice`, **operadores do Blender** (`bl_options`, `UNDO`, painel de
  refazer, `poll`/`invoke`/`modal`, flags) e mapa de teclas, **resolução de atalhos do VS Code**, Vite (workers, opções de
  worker, cabeçalhos de servidor e preview), web.dev COOP/COEP, MDN `crossOriginIsolated` e `SharedArrayBuffer`, tamanhos no
  bundlephobia. Mais os já citados (Redux, Elm, statecharts, comandos e `when` do VS Code).
- **Fatos que decidem**: as páginas do XState não documentam execução até o fim nem injeção de relógio; o SCXML documenta
  exatamente a semântica que precisamos; o mitt copia a lista de ouvintes antes de cada emissão (o nanoevents chama um
  ouvinte removido no meio); Redux: ações como eventos, estado serializável, redutor sem efeito; Blender: só `FINISHED`
  empilha desfazer, propriedades guardadas para o "ajustar última operação"; VS Code: regras avaliadas de baixo para cima,
  a primeira que casa tecla e `when` vence, `-comando` remove, acordes, códigos físicos de tecla; `SharedArrayBuffer` exige
  COOP `same-origin` + COEP `require-corp`, e isolamento dá `performance.now()` com 5 µs (100 µs sem).
- **Direção**: **statechart próprio com semântica do SCXML** (envio síncrono, fila interna FIFO esvaziada antes do próximo
  evento externo, saída → ações → entrada, primeira transição declarada vence e filho vence pai, regiões paralelas em
  ordem fixa, guardas puras, temporizadores por relógio injetado), máquinas `tool`, `mode`, `simClock`, cada transição
  registrada na superfície de depuração (XState 5.33 fica como alternativa se precisarmos de estados de histórico);
  **store próprio com log de ações** (ações serializáveis como eventos, redutor puro por fatia, estado congelado, anel de
  ~2.000 entradas, ouvintes depois do commit em ordem fixa, despacho dentro de ouvinte vai para a fila);
  **barramento próprio** (união fechada de eventos; entrega síncrona por ordem de camada e de registro; lista copiada no
  início de cada emissão; emissão durante a entrega vai para a fila; exceção de ouvinte relatada e reprovando testes, sem
  parar os outros; o barramento nunca desenha — o desenho agenda um rAF); **registro de comandos = operador do Blender +
  resolução de teclas do VS Code** (`id`, rótulo, flags `undo`/`redoPanel`/`hidden`, `enabled(ctx)`, esquema de
  propriedades, `run` que devolve `done|cancelled` — só `done` empilha —, `interactive` para ferramentas modais; teclas por
  `KeyboardEvent.code`; "ajustar última operação" = desfazer o último comando e rodar de novo com as propriedades
  editadas); workers só na forma `new Worker(new URL(...), { type: 'module' })` com `worker.format: 'es'`; **isolamento
  entre origens desde o início** (COOP/COEP em `server.headers` e `preview.headers`), conferido no boot e no e2e, com
  tudo funcionando também só com transferíveis.
- **Validação**: testes de conformidade do statechart (fila, ordem, prioridade, temporizador cancelado com relógio falso,
  tabela estado × evento); redutores puros (mesmo log → mesmo estado, fast-check); estado serializável; união de eventos
  fechada (teste de tipo); ordem de entrega; reentrada na fila; ouvinte que lança não para os outros; todo atalho, menu e
  item da paleta resolve para um comando registrado e nenhum comando sobra; `crossOriginIsolated === true` no dev e no
  preview.
- **Não lido**: se o `send()` do XState é síncrono, resolução de conflitos do mapa de teclas do Blender, padrão do
  `preview.headers` do Vite.

### 3.20 Persistência e troca → `docs/research/persistence-exchange.md`
- **Perguntas**: onde vive o autosave (IndexedDB ou OPFS) sem nunca copiar o projeto inteiro; um escritor entre abas;
  pedir persistência; formato do arquivo (JSON único ou zip), versões e migrações; exportação glTF (extensões), OBJ, IFC,
  DXF; importação OSM/GeoJSON (tags, limites, licença); projeção e georreferência da origem.
- **Lido**: MDN OPFS e `createSyncAccessHandle`, web.dev OPFS e armazenamento persistente, MDN `persist()` e Web Locks,
  fflate, persistência e migrações do tldraw, registro de extensões glTF da Khronos (`EXT_mesh_gpu_instancing`,
  `KHR_mesh_quantization`, `KHR_texture_transform`, `KHR_texture_basisu`), `GLTFExporter` e `OBJExporter` do three (doc e
  código), formato OBJ (Bourke), **web-ifc** (API de escrita), IFC 4.3 (`IfcProject`, `IfcSite`, `IfcBuildingStorey`,
  `IfcMapConversion`, fontes no GitHub da buildingSMART), estrutura DXF (ezdxf), escritores DXF em JS, **OSM** (`highway`,
  `building`, `building:levels`, Overpass e seus limites, licença ODbL), proj4js, EPSG:3857, RFC 7946 (GeoJSON), plano
  tangente local. Do Roadcraft: MDN IndexedDB (durabilidade, cotas).
- **Fatos que decidem**: OPFS grava no lugar e tem acesso síncrono só em worker dedicado, com trava exclusiva; o Chrome
  concede ou nega `persist()` em silêncio; Web Locks garantem um escritor entre abas; o `GLTFExporter` exporta
  `EXT_mesh_gpu_instancing` a partir de `InstancedMesh` mas não Draco nem basisu; o `OBJExporter` não exporta materiais;
  web-ifc tem 24,8 MB (carregar sob demanda); DXF R12 só precisa da seção ENTITIES; EPSG:3857 "não é um sistema geodésico";
  a 10 km da origem o plano tangente se afasta 7,8 m do elipsoide (UTM é melhor); Overpass leve: < 10 mil consultas/dia,
  esperar 30 s após 429; OSM exige crédito e compartilhamento pela ODbL.
- **Direção**: **autosave = diário de comandos só-acrescenta no OPFS**, gravado por um worker de persistência (lote a cada
  ~250 ms ou N comandos, `flush`), compactação que regrava só os blocos sujos de um instantâneo em blocos (um arquivo por
  bloco de entidades), Web Lock por projeto (outras abas abrem só leitura), `persist()` pedido no primeiro salvamento e o
  resultado mostrado; IndexedDB só para o catálogo de projetos, se precisar. **Arquivo do projeto = zip (fflate)** com
  `manifest.json` (formato, `schemaVersion` inteiro, versão do app, georreferência, aviso ODbL quando houver OSM),
  `doc/<tipo>-<bloco>.json` e `assets/*`; saída byte a byte idêntica (mtime fixo, entradas ordenadas); migrações `up`
  puras numeradas a partir de 1, sem `down`, recusa clara de arquivo mais novo que o app. glTF pelo `GLTFExporter` numa cena
  de exportação (instâncias viram `EXT_mesh_gpu_instancing` obrigatório; opção "compatível" que achata); OBJ só geometria;
  **IFC pelo web-ifc em worker sob demanda** (`IfcProject` → `IfcSite` → `IfcBuilding` → `IfcBuildingStorey`, alturas por
  `Pset_BuildingStoreyCommon`, georreferência por `IfcMapConversion` + `IfcProjectedCRS`); **DXF R12 escrito por nós**
  (plantas 2D); **importação OSM** (Overpass com cache, ou arquivo `.osm`/GeoJSON local; altura por `height` ou
  `building:levels` × 3 m; classe da via por `highway`); **projeção = UTM da origem com origem falsa** (proj4), Z
  ortométrico, norte da quadrícula; GeoJSON de saída em lon/lat com 6 casas. JSON para o jogo (Roadcraft) mantido como hoje.
- **Validação**: matar o worker no meio de uma gravação e reabrir no último comando confirmado com o mesmo hash; segunda aba
  não corrompe; bytes de autosave por comando independentes do tamanho do projeto; suíte de migração com fixtures de cada
  versão; salvar → abrir → salvar idêntico byte a byte; glTF passa no validador da Khronos; IFC reabre no web-ifc com as
  contagens esperadas; DXF abre num leitor de referência; importação OSM com fixture fixa; ida e volta de projeção < 1 mm.
- **Não lido**: referência DXF da Autodesk (página vazia/PDF), páginas HTML da buildingSMART (403; lidas as fontes no
  GitHub), escritores IFC menores, glTF-Transform/meshopt/KTX2, números de desempenho do OPFS.

### 3.21 Interface para a suíte inteira → `docs/research/interface.md`
- **Perguntas**: como organizar muitos domínios sem sobrecarga (workspaces/modos × barra única); ferramentas junto da
  seleção; padrões de inspetor, estrutura/camadas, biblioteca e paleta; controles de tempo e sobreposições de dados com
  legenda; notificações e estados vazios; atalhos; painéis redimensionáveis; acessibilidade; layout que caiba em
  1920×1080 e 1864×918.
- **Lido**: Figma UI3 (barra lateral esquerda, minimizar), Blender (editor de Propriedades, áreas, busca F3), Revit
  (seleção, aba contextual, Options Bar, Tab entre candidatos, ribbon), Houdini (painéis, desktops, fixar × seguir
  seleção), CityEngine (interface), Autodesk Forma (barra de ferramentas e modos), Unreal (modos Shift+1…8, Modeling Mode
  com aceitar/cancelar, Landscape, Foliage), Cities: Skylines (info views, controles) e CS2 (dev diary 1, ferramentas de
  via), **Apple HIG** (painéis, barras laterais, barras de ferramentas — pelos endpoints JSON), Material (navigation rail,
  classes de tamanho de janela), **WCAG 2.2**, NN/g (estados vazios; indicadores, validações e notificações). Mais o que o
  FORMA já tinha lido (workspaces do Blender e do Fusion, Figma Dev Mode, redo panel, divulgação progressiva).
- **Fatos que decidem**: rail de navegação com 3–7 destinos; barras laterais com até dois níveis, escondíveis e
  configuráveis; inspetor que atualiza com a seleção e aplica ao vivo; erros nunca em toast (NN/g); WCAG 2.2: contraste
  4,5:1 (texto) e 3:1 (componentes, ícones, foco), tudo pelo teclado, atalho de uma tecla precisa poder ser desligado ou
  remapeado (2.1.4), foco visível e não coberto, todo arrasto com alternativa de um ponteiro (2.5.7), alvos ≥ 24×24.
- **Direção (a validar com protótipos na etapa D)**: **7 workspaces** sobre o mesmo modelo e seleção — **Sítio**
  (terreno, lotes, vias, paths, paisagismo), **Construção** (massa, níveis, telhados, fachadas, estrutura, circulação,
  interior), **Assets**, **Materiais**, **Simulação** (trânsito, pessoas, transporte, física), **Análise** (sol, métricas,
  sobreposições, comparar), **Apresentar** (vistas, prancha, exportação). Atalhos de troca **a verificar no Chrome na
  etapa R**: Ctrl+PgUp/PgDn (e provavelmente Ctrl+1…9) trocam de aba no navegador e podem nunca chegar à página — é a mesma
  pergunta antiga ainda aberta; alternativas a provar com o teclado real. Layout com medidas
  para as duas telas (barra superior 40/36 px com projeto, alternativas, campo de comando, relógio e notificações; rail de
  workspaces 56 px; painel esquerdo Estrutura/Camadas/Biblioteca 272/248 px redimensionável; inspetor 320/316 px; linha de
  status 24 px; **vista de 1264×1016 em 1920×1080 e 1236×858 no painel de 1864×918**; dock inferior para linha do tempo,
  gráficos da simulação e tabela de tipos; paleta de ferramentas sobre a vista; faixa de opções da ferramenta ativa; barra
  contextual flutuante junto da seleção; legenda das sobreposições); regras automáticas de recolher abaixo de 960 px de
  largura ou 600 px de altura; Ctrl+\ esconde os painéis, Ctrl+Space maximiza a vista; kit de componentes (grade de 4 px,
  controle 28, linha 24, ícones 16/20, texto 13/12, campo numérico com unidade e expressão, estado "Misto", selo
  tipo/instância, bloco de estado vazio, legenda com padrão além de cor, barra aceitar/cancelar); padrões de inspetor,
  estrutura, biblioteca, paleta Ctrl+K (com caminho de menu e atalho), simulação (Espaço, 1/2/3 só com foco na vista),
  sobreposições com legenda e tabela acessível, comparar 2–4 vistas, notificações (validação junto do campo, avisos
  passivos com contador, bloqueios em faixa ou modal), estados vazios com ação; esquema de atalhos com teclas únicas só com
  foco na vista, remapeáveis e com chave geral para desligar; regras de acessibilidade acima.
- **Conflito com o que já existe** (decisão do usuário na parada): o FORMA já tinha duas listas de workspaces (Model,
  Components, Materials, Interior, Present × Model, Materials, Interior, Light, Walk), e a hipótese da seção 4.6 tinha 8
  (Terreno e Rede e Lotes separados). Os protótipos mostram as alternativas lado a lado nas duas telas.
- **Não lido**: "Navigating UI3" do Figma (404), densidade do Material, controles de tempo do CS2, desenho de paletas de
  comando (nenhuma fonte primária). Todas as medidas em pixels são propostas, a confirmar nas fotos dos protótipos.

### 3.22 Qualidade e regressão → `docs/research/quality.md`
- **Perguntas**: como provar que o inverso de cada comando é exato e que desfazer/refazer/diário reaplicado dão o estado
  vivo; fuzz de geometria; simulação determinística; gestos reais e fotos estáveis de WebGL (RTX local e SwiftShader);
  como impor camadas, 800 linhas, `catch` silencioso e nada sem uso; gancho sem dependência; que estatística torna
  confiáveis os orçamentos e os testes de escala.
- **Lido**: fast-check (testes por modelo/comandos, parâmetros, arbitrários numéricos, integração com Vitest),
  Playwright (comparação de fotos, `toHaveScreenshot`, entrada de mouse e teclado, navegadores e lançamento, chaves padrão
  do Chromium), Chrome headless com GPU, SwiftShader no Chromium (o fallback automático está sendo removido), pixelmatch,
  **knip** (configuração, modo produção, plugin do Vite), **eslint-plugin-boundaries** v7 e **dependency-cruiser** 18,
  regras do ESLint (`max-lines`, `no-empty` — um `catch` só com comentário passa —, `no-useless-catch`, regras locais),
  supressões do ESLint, ganchos do git (`pre-push`, `core.hooksPath`, `--no-verify`), husky, simple-git-hooks,
  tachometer, benchmark do Vitest, resolução do `performance.now()`.
- **Direção**: **fast-check** com `fc.commands` sobre todos os comandos do documento contra um modelo ingênuo
  (inverso exato, refazer após desfazer, diário reaplicado = documento vivo, incremental = do zero), semente e caminho
  registrados em falha; fuzz de geometria com faixas válidas e propriedade separada para NaN/∞/−0; simulação só avança por
  `simClock.step(dt)`, RNG próprio no estado, hash a cada N passos; **Playwright** com dois projetos (Chrome real com GPU
  na RTX e SwiftShader explícito), fotos por projeto, gancho de teste no app (`?test`: desenho sob demanda, tempo fixo, DPR
  fixo, fontes carregadas), `GL_RENDERER` conferido antes da foto, gestos por `page.mouse` com passos (nunca
  `dispatchEvent`); **knip** (entradas explícitas, workers listados, `--production --strict` também); **camadas** por
  eslint-plugin-boundaries (padrão "proibir", cada camada só importa as de baixo) **e** dependency-cruiser (ciclos dentro da
  camada, módulos mortos); `max-lines` 800; `no-empty`, `no-useless-catch` e uma **regra local `no-silent-catch`**
  (um `catch`/`.catch` que nem relança nem chama o relator é erro — pega o comentário sozinho); proibir `let` de módulo e
  exports mutáveis; **ganchos sem dependência** (`.githooks/pre-push` → `node scripts/gate.mjs`, `core.hooksPath`
  configurado por `npm run setup`), ordem barata primeiro (tipos → eslint → knip → depcruise → vitest → fotos →
  desempenho); **portão de desempenho A/B intercalado** com intervalo de confiança (tachometer como referência; a
  especificação única, com número de rodadas e pré-condições de máquina, fica na etapa D), falha só quando o limite
  inferior passa do orçamento ou um orçamento absoluto quebra, A/A mede o ruído; **testes de escala por
  contadores determinísticos** (nós avaliados, bytes no diário, mensagens a workers, bytes enviados à GPU, alocações) iguais
  no projeto 1× e 100×, percorrendo o registro de comandos.
- **Validação do próprio portão**: inverso quebrado de propósito reprova e encolhe para ≤ 3 comandos; import para cima
  reprova o ESLint; export sem uso reprova o knip; `catch` só com comentário reprova; arquivo de 801 linhas reprova;
  20 rodadas seguidas de fotos sem oscilação; deslocamento de 1 pixel detectado; A/A passa ≥ 95%; lentidão de 20% injetada
  reprova em até 3 min.
- **Não lido**: se o knip resolve `new URL('./x.worker.ts', import.meta.url)` (por isso os workers entram como entradas),
  chaves de GPU do Chrome no Windows para o Playwright, `no-restricted-syntax`.

### 3.17 Desenho e desempenho no navegador → `docs/research/rendering.md`
- **Perguntas**: o que vira BatchedMesh, InstancedMesh, malha fundida por célula (HLOD) ou impostor; quantos itens por
  passe a máquina sustenta; como preparar lotes, LODs, HLOD e atlas fora da interação; culling e LOD para 10⁴–10⁵
  instâncias sem laço JS por instância; que dimensões criam um programa de shader e como compilar tudo na carga; sombra,
  noite com muitas luzes e pós com orçamento; WebGPU agora ou depois; precisão em coordenadas grandes; como medir GPU,
  CPU, memória, envios e compilações por quadro.
- **Lido**: código do three r170 e r186 (`BatchedMesh`, `InstancedMesh`, `WebGLRenderer`, `WebGLPrograms`,
  `WebGLTextures`, `WebGLAttributes`, `WebGLShadowMap`, `WebGLInfo`, chunks de projeção e profundidade log, `CSM`,
  `SunLight`, `ClusteredLighting`, `LightProbeGridWebGL`, `WebGLNodesHandler`, `GTAOPass`, `UnrealBloomPass`), notas da
  r186, manual do WebGPURenderer, ANGLE `Context11.cpp` e `Buffer11.cpp`, Unreal HLOD, Unity LOD Group, README do
  meshoptimizer, CLI do gltf-transform, impostores octaédricos (fórum do three, demo de 200 mil árvores), Hi-Z (rastergrid,
  OptiPixel), medições de fórum do three (r183: WebGL 4,5 ms × WebGPU 9,7 ms de CPU para 4.000 malhas; issue #30560), AGI
  "Precisions, Precisions", MDN `measureUserAgentSpecificMemory`, Chrome WebGPU. Do Roadcraft: `fase-0` (medição),
  `fase-6` (KTX2), `fase-7` (sombra, profundidade reversa); do FORMA: `materiais-uv-luz`, `render/batch.ts`.
- **Fatos que decidem**: no ANGLE/D3D11 um multi-draw ainda vira N draws D3D (o `info.render.calls` subconta); o
  BatchedMesh percorre todas as instâncias em cada passe se o culling/ordenação estiver ligado, copia índices um a um e
  regrava tudo ao crescer — o fracasso do Roadcraft foi de uso, não do recurso; a chave do programa inclui contagens de
  luzes, `batching`, `instancing`, `instancingColor` etc.; `compileAsync` **não compila os programas de profundidade da
  sombra** nem faz a introspecção do primeiro uso; a r186 tem faixas de atualização de textura, `SunLight` com 2 cascatas,
  profundidade reversa, grade de sondas de luz e removeu `PCFSoftShadowMap`; WebGPURenderer: "experimental", ~2× CPU por
  objeto e primeiro quadro 5–10× mais lento; float32 tem passo de ~1 mm a 8–16 km da origem.
- **Direção**: manter **WebGLRenderer** e subir de r170 para **r186** (etapa própria, com antes/depois); BatchedMesh para
  arquitetura parada (pré-dimensionado, cópia rápida, sem culling por instância, culling por célula nosso, sem
  remoção/crescimento); InstancedMesh por (LOD × material × célula) para veículos, pessoas e vegetação, com movimento na GPU
  onde der; HLOD por célula (malha fundida, simplificada com borda travada, material plano assado) refeito em worker no
  commit; impostores além de ~100 m; **catálogo fechado de shaders compilado na carga** (proxies de cada variante +
  um quadro fora da tela com sombra) e portão "0 programas criados depois de pronto"; topologia de luzes fixa (sol com
  sombra + ambiente; noite com janelas emissivas, cartões de luz, bloom e sondas assadas; nada de luzes pontuais);
  sombra com cascatas em cache (`autoUpdate = false`, atualiza só quando sol, geometria ou ajuste mudam); GTAO em meia
  resolução reaproveitando a profundidade (sem o segundo passe de geometria, hoje ~2.700 draws); coordenadas relativas à
  origem da célula; profundidade log proibida; profundidade reversa só depois de medir.
- **Orçamentos iniciais (calibrar na etapa R/D)**: quadro p95 ≤ 16,9 ms, p99 ≤ 33,8 ms, zero LoAF > 50 ms depois de
  pronto; GPU p95 ≤ 12 ms (sombra ≤ 2,5 ms quando atualiza, opaco ≤ 5,5, GTAO ≤ 1,5, bloom ≤ 0,5, AA+tom ≤ 1,
  transparentes ≤ 1); CPU de submissão ≤ 4 ms; ≤ 600 itens no passe principal e ≤ 300 por cascata; ≤ 120 programas, 0
  criados depois de pronto; 0 bytes enviados à GPU durante movimento de câmera (exceto agentes ≤ 1 MB/quadro); texturas
  ≤ 1,5 GB residentes; heap com inclinação ≤ 1 MB/min. Os orçamentos decidem a representação (LOD), nunca quantos
  objetos podem existir.
- **Portão**: ≥ 9 rodadas A/B intercaladas, cada uma num processo novo, razão com intervalo de confiança; ruído calibrado
  por A/A; rodada inválida se o clock da GPU cair abaixo de 90% do máximo; contador de envios à GPU em modo diagnóstico.
- **Não lido**: blog do Ryan Brucks (impostores), notas r171–r185, custo por sub-draw D3D11 nesta RTX, ajuste de cascata do
  `SunLightShadow` (linhas 160–319), tempo de transcodificação KTX2, se o cache de shader do Chrome ajuda no ANGLE.

### 3.18 Terreno e topografia → `docs/research/terrain.md`
- **Perguntas**: superfície canônica (grade, TIN, curvas), espaçamento e área; como chão natural, escultura e projeto
  paramétrico (platôs, rampas, terraços, vias, água) se combinam e continuam editáveis; o que significam alvo, projeção,
  daylight, cantos e muro quando falta espaço para o talude; como medir e atribuir corte e aterro; como lotes e prédios
  assentam (platô, escalonamento, fundação); água; importação (DEM/GeoTIFF, curvas, pontos); LOD com edição; o que cada
  edição invalida.
- **Lido**: Unreal Landscape (esculpir, achatar, rampa, camadas de edição, splines, guia técnico, pintura), Unreal Water
  (corpos e escavação), **Civil 3D grading** (objeto de grading, critérios, regiões, superfícies e volumes, cruzamento de
  feature lines, contornos → TIN, superfície de volume), SketchUp Sandbox (From Contours, Smoove, Stamp, Drape, DEM),
  Revit (building pad, subdivisão do Toposolid), InfraWorks (áreas de grading), CS2 (editor de mapas: heightmap 4096²
  16-bit, fontes de água), GDAL GTiff, geotiff.js, PDAL `writers.gdal`, Martini, Delaunator, Constrainautor, GPU Gems 2
  cap. 2 (geometry clipmaps). Do Roadcraft: `fase-5` (CDLOD, RTC, HLOD).
- **Fatos que decidem**: Civil 3D define volume = superfície de comparação − superfície base, e grading = pegada +
  critérios (alvo, projeção, cantos, regiões, travas) com linha de daylight; em cruzamento de feature lines "a última
  modificada vence" (não determinístico para um editor com desfazer); camadas de edição do Unreal (spline e patch são só
  procedurais; limite padrão 8); clipmaps não tratam edição; CDLOD só precisa refazer min/max dos nós tocados; Delaunator
  1M pontos em ~1 s; geotiff.js lê janelas em workers; Float32 a 1 m ≈ 4 MB por km².
- **Direção**: **grade de alturas Float32 em peças** como armazenamento canônico, com duas pilhas avaliadas por peça —
  **Natural** (importação + camadas de escultura esparsas) e **Acabado** (Natural + lista ordenada de modificadores
  paramétricos avaliados em workers); volumes = Acabado − Natural por peça, atribuídos ao modificador; TIN só para importar
  (curvas → Constrainautor → rasterizar) e exportar; **modificadores no modelo do Civil 3D** (pegada + critérios; tipos:
  platô, rampa, terraço, achatar na inclinação, escavação de água, corredor de via) com **muro de arrimo** quando o daylight
  sairia da área permitida; caixa conservadora (pegada + alcance máximo do daylight) = área de invalidação; **política de
  conflito explícita e determinística** (Natural < água < platôs de lote < platôs de prédio < corredores de via): a
  superfície de cima trava, o daylight de baixo é recortado e vira muro ou é relatado; desenho por **CDLOD** sobre textura de
  altura, atualizando só o retângulo sujo e o min/max dos nós; água como corpos planos autorais (lago/mar = polígono com
  nível; rio = spline com largura e profundidade), cada um também modificador de escavação, sem simulação na primeira
  versão; importação em workers (GeoTIFF com NoData e PixelIsPoint, curvas, nuvem de pontos por binning). As vias leem o
  **Natural** (sem ciclo); lotes leem bordas exatas das vias e o Acabado sem o próprio platô; prédios leem o platô do lote
  ou amostram o Acabado sob a pegada; paths assentam no Acabado. Muros verticais e meio-fios vivos são desenhados pelas
  feições vetoriais, não pela grade (inferência a provar).
- **Validação**: platô num plano inclinado contra o prisma/tronco analítico (< 1%); inclinação medida = critério (3:1, 2:1)
  dentro de uma célula; peças tocadas = peças da pegada; mesmo custo de pincel/platô/via em mapa pequeno e grande; sem
  rachaduras entre níveis de LOD; seleção do CDLOD comparada ao artigo (0,075–0,57 ms); teste de meio pixel com
  PixelIsPoint; NoData nunca vira zero; margem da água = curva de nível do Acabado.
- **Não lido**: criação/escavação do Toposolid do Revit, malha da água do Unreal, artigo original de clipmaps do Hoppe,
  RTIN no Observable (429), padrões do Civil 3D para tesselação.

### 3.19 Materiais → `docs/research/materials.md`
- **Perguntas**: quantos materiais e programas; formato e codificação das texturas; arrays de textura ou atlas; materiais
  procedurais em escala real; o que um editor em camadas assa e quando.
- **Lido**: código do three r186 sobre programas e texturas (`WebGLPrograms`, `WebGLTextures`, `DataArrayTexture`,
  `CompressedArrayTexture`, chunks de amostragem), `KTX2Loader` (via Roadcraft `fase-6`), gltf-transform (`etc1s`/
  `uastc`), Unreal *Layered Materials*, Blender *Baking*, KTX2/Basis (guias da Khronos e do Basis Universal, via
  `fase-6`), Iñigo Quílez (biplanar, repetição de textura), Khronos PBR Neutral, `MeshPhysicalMaterial`, Filament (estes
  pelo `materiais-uv-luz` do FORMA, que também leu os materiais procedurais e a iluminação do editor).
- **Direção**: um material por família de superfície, variação por instância; os 8 conjuntos fotográficos numa textura
  em array KTX2 com índice de camada por instância (8 famílias de lote viram 1; 134 MB em RGBA8 → 33,5 MB em BC7);
  UASTC para normal/ORM, ETC1S ou UASTC para cor, mips prontos na build; UVs métricas na geometria; biplanar só em
  superfícies curvas; técnica 3 do Quílez contra repetição; **editor em camadas que assa na GPU em espaço de UV no commit**
  (a cidade amostra um conjunto assado, nunca N camadas por pixel); tom Neutral mantido.
- **Não lido**: documentação de camadas do Substance; limite de camadas de array no WebGL2.

### 3.11 Física → `docs/research/physics.md`
- **Perguntas**: que física um editor de cidade realmente precisa (consultas de colisão para caminhar e selecionar,
  veículos, objetos caindo, demolição, tecido, partículas); quanto cada motor acrescenta de download; determinismo e
  instantâneos para desfazer e replay; threads no navegador.
- **Lido**: README e documentação do JoltPhysics.js e do Jolt, tamanhos publicados no unpkg/npm (Jolt 1.1.0, Rapier
  0.21.0), documentação do Rapier (determinismo, serialização), blog da Dimforge (2025, corpos moles 2026), ammo.js,
  PlayCanvas (alternativas ao ammo), MDN `SharedArrayBuffer`, ferramentas de fratura do Unreal.
- **Fatos que decidem**: Rapier WASM é "totalmente determinístico entre plataformas" com `takeSnapshot`/`restoreSnapshot`
  (≈3,1–3,3 MB de wasm); Jolt é mais rico (veículos, ragdolls, tecido) mas determinismo entre plataformas exige build
  própria (~8% mais lenta) e threads exigem isolamento entre origens (~2,0 MB + 0,96 MB); ammo.js parado no Bullet 2.82.
- **Direção**: por padrão **sem corpo rígido** (seleção, caminhar e veículos usam consultas e cinemática da simulação);
  modo de física carregado sob demanda num worker com **Rapier SIMD** (pacote não "compat", wasm não embutido em base64),
  atrás de uma interface fina que permite trocar por Jolt se veículos/ragdolls físicos forem pedidos; demolição com
  **fratura Voronoi pré-calculada na build** (células recortadas pelos volumes com o Manifold, hierarquia de níveis),
  corpos criados só quando a demolição começa, destroços dormem e somem; tecido (bandeiras, toldos) por onda no vertex
  shader; partículas (chuva, fontes, poeira) na GPU.
- **Validação**: ms por passo com 100/1.000/5.000 destroços na RTX; tempo de download e instanciação; mesmo snapshot ⇒
  mesmo hash; nenhuma tarefa longa > 50 ms na thread principal.
- **Não lido**: nenhum benchmark direto entre os motores no navegador (medir); páginas do Chaos Destruction vazias;
  versões do Rapier divergentes entre npm (0.21.0) e blog (0.24/0.36) — conferir qual pacote tem a build rápida.

### 3.12 Demais simulações → `docs/research/other-simulations.md`
- **Perguntas**: quais simulações a suíte precisa, com que modelo, custo e ligação ao resto (trânsito → ruído; prédios e
  árvores → sombra; demanda → crescimento; redes → cobertura de serviço)?
- **Lido**: NOAA (cálculo solar), SunCalc, blog do Autodesk Forma (horas de sol, ruído e vento rápidos), Lattice-Boltzmann
  de Schroeder, fonte de ruído viário CNOSSOS (documentação do CadnaA), FHWA (impacto do clima no trânsito), wiki do CS1
  (eletricidade, água e esgoto, economia), Vanegas 2012 (indicadores de sol).
- **Decisão por simulação**: **sol, sombra e horas de sol** (núcleo; Meeus/SunCalc ~0,08°; por fachada e no chão; alimenta
  luz do dia/noite e indicadores de crescimento); **dia e noite** (mesma posição do sol); **clima** (chuva, neblina, neve
  como cenário: desenho + multiplicadores de velocidade e capacidade do trânsito pelas faixas da FHWA — chuva forte −10 a
  −30% de capacidade); **ruído** (fonte CNOSSOS por aresta a partir do fluxo e velocidade do trânsito, propagação por
  divergência e anteparo dos prédios numa grade em worker); **redes de água, esgoto e energia** simplificadas por
  conectividade e capacidade (estilo CS, sem hidráulica); **economia e crescimento** (demanda e impostos alimentando os
  lotes); **vento e VSC** adiados e marcados como qualitativos quando vierem (LBM no navegador é 2D, Re de algumas
  centenas). Cadeia: terreno → vias → lotes → prédios e árvores → (sol/sombra, cobertura de redes) → trânsito → ruído →
  valor da terra → demanda → crescimento.
- **Validação**: azimute e altura do sol a ≤ 0,1° da NOAA em 4 datas × 3 latitudes; horas de sol num pátio de teste contra
  caso analítico; ruído sobe 10·lg quando o fluxo dobra; fatores do clima dentro das faixas da FHWA; população e trânsito
  derivados da densidade da cidade, nunca de um número fixo.
- **Não lido**: NREL SPA (DNS), ajuda do Forma (login), Diretiva 2015/996 e tabelas CNOSSOS 2021/1226 (vazias), ISO 9613-2
  (403), VSC do BRE, hidráulica tipo EPANET, economia do CS2.

### 3.16b Arquitetura da simulação (parte dos temas 15/16) — direção
Relógio com acumulador na thread principal; passos por nível; RNG com semente por subsistema (`Math.random` não aceita
semente; transcendentais variam entre navegadores — determinismo garantido no mesmo navegador); transporte por
`ArrayBuffer` transferível em vai-e-vem e, com isolamento entre origens, `SharedArrayBuffer` em buffer triplo; capacidade
dobra quando enche (sem teto fixo); edição ao vivo: patch das faixas tocadas com IDs estáveis, veículos remapeados pela
fração do comprimento, reroteamento em lotes, nada pausa.

---

## 4. Esqueletos (hipótese de trabalho; a etapa D só os fixa depois da pesquisa)

### 4.1 Camadas

```
core → model → kernel → eval → sim → render → editor → ui → app
```

| camada | contém | não pode |
|---|---|---|
| `core` | matemática, polígonos básicos, IDs, unidades, RNG com semente, tipos de eventos, barramento genérico, store tipado genérico, registro de comandos genérico, orçamento de quadro | DOM, three, WASM |
| `model` | esquema de cada módulo (projeto, terreno, vias, lotes, prédios forma/4, assets, paths, paisagismo, linhas de transporte, configurações de simulação), migrações, **relações**, **comandos puros** (documento → patches), índice de células, formato de arquivo (serialização em registros) | three, DOM, WASM |
| `kernel` | Manifold, `CrossSection`/Clipper2, esqueleto reto, earcut, curvas (arcos, clotoides, Bézier), operações de grade de alturas | three, DOM |
| `eval` | escalonador do grafo de dependências (puro), avaliadores (prédio forma/4, peças de terreno, corredores e cruzamentos de vias, grafo de faixas, subdivisão e crescimento de lotes, amostragem de paths, espalhamento de vegetação), protocolo e entradas dos workers | three, DOM |
| `sim` | relógio, trânsito, pessoas, transporte, física (motor WASM), demais simulações; puro, em workers; lê saídas de `eval` | three, DOM |
| `render` | **a única camada com three**: cena, lotes (BatchedMesh), instâncias, LOD/HLOD, terreno com LOD, catálogo de shaders compilado na carga, pós, buffers de seleção | DOM de painel |
| `editor` | controladores em execução (documento com histórico, store da sessão, máquinas de estado, barramento, registro), ferramentas e gestos | DOM de painel |
| `ui` | kit de componentes, workspaces, painéis, inspetor, biblioteca, controles da simulação | three |
| `app` | entrada, ligação, entradas dos workers (avaliação, simulação, persistência OPFS), injeção dos adaptadores | ser importada |

`npm run check` impõe isso por lint (`eslint-plugin-boundaries`, pesquisa 3.22), por `dependency-cruiser` (ciclos e
módulos mortos) e por `test/arch`. O código migrado começa nas pastas de hoje (`src/f3/...`, para a prova de igualdade
ser byte a byte); os controladores novos da etapa 1 já nascem nas camadas, e o código migrado é movido e dividido na
etapa 4, guardado pelos testes e pelas fotos.

### 4.2 Controladores globais (cada um é o único escritor dos seus dados)

1. **Documento** — registros normalizados por coleção e ID, cada registro com uma célula dona. Muda só por **comando**:
   `Command = { id, apply(doc, args) → Patch[] }`; `Patch = { coleção, id, antes, depois }` (o `RecordsDiff` do tldraw);
   relações rodam dentro da transação e acrescentam patches (o mesmo caminho para arrasto, painel, menu, desfazer e
   arquivo aberto). Histórico guarda patches (bytes proporcionais à mudança), um gesto funde patches até a marca, o
   inverso é recalculado no desfazer (princípio do Figma/Excalidraw). Autosave grava os registros sujos numa transação.
   Nunca copia o projeto inteiro.
2. **Store da sessão** (próprio, ~200 linhas) — ferramenta, modo, workspace, seleção, hover, vista, painéis,
   preferências, estado da UI da simulação; ações serializáveis nomeadas como eventos, redutor puro por fatia, estado
   congelado, log de ações num anel (~2.000) para a superfície de depuração; despacho dentro de um ouvinte entra na fila;
   preferências salvas à parte do documento.
3. **Máquinas de estado** (statechart próprio com a semântica do SCXML: envio síncrono, fila interna esvaziada antes do
   próximo evento, saída → ações → entrada, relógio injetado) — ferramenta (ocioso → hover → pressionado → arrastando →
   confirmar/cancelar, com subestados por ferramenta), modo/workspace, relógio da simulação (parado/rodando/pausado/passo,
   velocidade). Cada transição vai para o log de depuração.
4. **Barramento de eventos** (próprio) — união fechada e tipada; entrega síncrona por ordem de camada e de registro;
   lista de ouvintes copiada no início; evento disparado durante a entrega de outro entra na fila (execução até o fim);
   exceção de ouvinte é relatada e reprova os testes. Rascunho da lista: `doc.committed`, `doc.history`, `doc.loaded`,
   `graph.invalidated`, `eval.ready`, `sim.networkPatched`, `session.changed`, `selection.changed`, `tool.changed`,
   `workspace.changed`, `view.changed`, `persist.saved`, `persist.failed`, `notify`. O barramento nunca desenha (o desenho
   agenda um rAF) e o estado da simulação não passa por eventos (buffers lidos pelo desenho).
5. **Registro de comandos** (operador do Blender + resolução de teclas do VS Code) — `{ id, rótulo, ícone, flags (undo,
   painel de refazer, oculto), enabled(ctx), esquema de propriedades, run → done|cancelled, interactive? }`; atalhos por
   `KeyboardEvent.code` com `when`, regra de baixo para cima, acordes, remoção pelo usuário; menus, barra contextual, paleta,
   busca e atalhos só referenciam o `id`; "ajustar última operação" = desfazer e rodar de novo com as propriedades
   editadas; teste que percorre o registro (nenhum atalho/menu órfão, nenhum comando sem uso).
6. **Fluxo de dados** — documento → grafo de dependências (nós por entidade/célula e estágio) → avaliação incremental em
   workers (bit sujo por superaproximação + rastros de verificação por hash para parada antecipada, Salsa/Build Systems à
   la Carte) → simulação → desenho. Pool único de workers com prioridade recalculada pela vista, substituição e
   cancelamento por chave, contrapressão (Cesium/Piscina); a thread principal só aplica resultados numa caixa de entrada
   dentro do orçamento do quadro; a simulação tem worker próprio.

7. **Persistência** (worker próprio) — diário de comandos só-acrescenta no OPFS + instantâneo em blocos regravado só
   nos blocos sujos; Web Lock por projeto; `persist()` pedido e mostrado; arquivo do projeto em zip (manifesto com
   `schemaVersion`, blocos de documento, assets); migrações `up` numeradas.

Isolamento entre origens (COOP/COEP) ligado desde a etapa 1 no dev e no preview, conferido no boot; tudo funciona também
só com transferíveis. Superfície de depuração única e só de leitura: `globalThis.forma` com leitores (documento, sessão,
log de ações, transições e eventos, grafo, filas, contadores de trabalho e de quadro, `crossOriginIsolated`); nenhum
escritor.

### 4.3 Células

Grade quadrada no referencial do projeto: **UTM da origem com origem falsa** (proj4; Z ortométrico; norte da
quadrícula), em metros. Cada registro tem uma célula dona (pelo ponto de âncora) e entra no índice de todas as células
que a sua caixa toca (invalidação); derivados por célula (peça de terreno, superfícies de via, lotes de desenho,
instâncias de vegetação e agentes, HLOD); desenho relativo à origem da célula (precisão de float32: ~1 mm a 8–16 km);
a mesma célula serve aos dados, ao desenho, à simulação (níveis de detalhe) e ao roteamento (sobreposição CRP/CCH).
Tamanho da célula medido na etapa R (ponto de partida 256 m, do Unreal/Roadcraft).
Teste de escala: o mesmo comando custa o mesmo num projeto pequeno, com 200 prédios e numa cidade com N células.

### 4.4 Módulos e quem depende de quem

```
terreno (+ água) ──► vias ──► lotes ──► prédios (forma/4) ─┐
     │                 │        │                          ├──► simulações (trânsito, pessoas,
     └────────────────►┴────────┴──► paths, paisagismo ────┘     transporte, física, demais)
assets e criador ──► (prédios, paths, paisagismo, vias, veículos, pessoas)
materiais ──► todos          interior e níveis ──► prédios          persistência e exportação ──► todos
```

- O terreno dá alturas e inclinação; uma via ajusta o terreno (corte, aterro, taludes) e devolve a faixa ocupada; os
  quarteirões são as faces da rede de vias; os lotes nascem da subdivisão dos quarteirões; os prédios crescem nos lotes
  sobre o terreno (platôs, escalonamento); paths e paisagismo seguem terreno, vias e lotes; a simulação lê o grafo de
  faixas, as calçadas e travessias, as entradas dos prédios e as linhas de transporte.
- Uma edição invalida só o que depende dela, por célula: mexer numa via refaz o corredor dela, os cruzamentos das pontas,
  o terreno ajustado das células tocadas, os lotes daquele quarteirão e o trecho do grafo de faixas, com o trânsito
  remapeado e sem parar.

### 4.5 Núcleo forma/4 (proposta registrada em `workspaces-and-nodes.md`, a confirmar)

Cada prédio é um grafo de nós: **geradores** (volume paramétrico de hoje, sólido livre com IDs estáveis de
vértice/aresta/face, revolução, varredura, loft), **operações** (offset, chanfro, extrudar e inserir face, mover
subelemento, dividir, array, espelhar, corte por plano) e **grupos de combinação** (somar/subtrair/intersectar em ordem,
aninháveis, com descombinar). Referências persistentes: chaves do gerador + chaves criadas por operação + `faceID`/
`originalID` do Manifold atravessando as booleanas; referência que some vira **órfã e é relatada**, nunca reatada pela
posição mais próxima. Avaliação por nó com cache por hash de dados (Houdini), nos workers. Migração forma/3 → forma/4
sem perda, com teste de ida e volta nas amostras e nos projetos do usuário.

### 4.6 Interface (proposta da pesquisa 3.21; os protótipos da etapa D decidem com o usuário)

- **7 workspaces** sobre o mesmo modelo e a mesma seleção: Sítio, Construção, Assets, Materiais, Simulação, Análise,
  Apresentar (alternativas a mostrar lado a lado: as duas listas antigas do FORMA e a de 8 com Terreno/Rede/Lotes
  separados).
- Barra superior (projeto, alternativas de projeto, campo de comando Ctrl+K, relógio da simulação, notificações); rail de
  workspaces à esquerda; painel esquerdo Estrutura | Camadas | Biblioteca; inspetor à direita; paleta de ferramentas e
  faixa de opções sobre a vista; barra contextual junto da seleção; painel da última operação; dock inferior (linha do
  tempo, gráficos da simulação, tabela de tipos); legenda das sobreposições; linha de status. Vista mínima de 1236×858 nas
  duas telas com os painéis padrão. Acessibilidade WCAG 2.2 (contraste, teclado, foco, alvos, alternativa a arrasto,
  teclas únicas desligáveis).

---

## 5. Etapas

Regras de toda etapa (do `CLAUDE.md`): antes de editar, mensagem curta com o que foi lido (links), a causa e a abordagem;
antes de cada etapa de desenvolvimento, o que ela muda na cadeia escrito em `docs/ARCHITECTURE.md` e conferido no código;
fecha só com specs e e2e verdes, uso com gestos reais (várias entradas em sequência, perto e longe, projeto pequeno e
grande, terreno inclinado assim que existir), cada foto aberta e conferida uma a uma com o que se viu nela, portão verde
com números antes/depois lado a lado na mesma sessão (Chrome visível na RTX 3060, nome da GPU lido em cada rodada, carga
dos outros processos registrada), docs atualizados, commit em português e `git push origin main`. O que não puder ser
verificado é relatado como NÃO VERIFICADO. Uma tarefa pesada por vez; vitest com no máximo 6 workers; duas tentativas
falhas no mesmo problema → nova pesquisa e registro em `docs/PROBLEMS.md`.

### Etapa M — migração (seção 2 do pedido)

| passo | entrada | saída e prova | riscos |
|---|---|---|---|
| M0 backup (seção 2, passos 1–2) | as respostas do usuário (seção 6) | cópia bruta dupla do LevelDB com manifesto; leitor offline provado num perfil do Playwright e aplicado à cópia; lista de todas as chaves e tamanhos da origem; `LEIA-ME.md` | Chrome compactando durante a cópia → duas cópias iguais ou repete |
| M0b relatórios da pesquisa | M0 | os relatórios finais dos agentes desta sessão extraídos por script da pasta `tasks` do scratchpad para `C:/Codex-Shared/_backup/forma-plan-research-2026-10-12/` | — |
| M1 sessões e FONTE | M0 | `git status` limpo e hash `f4e9969c` reconferidos e registrados em `docs/MIGRATION.md`; se houver mudança sem commit, mostrada ao usuário e não copiada | outra sessão grava no meio → parar e perguntar |
| M2 cópia congelada da FONTE | M1 | `git archive f4e9969c labs/building/forma` → `C:/Codex-Shared/forma-baseline-f4e9969c/` (fora dos repositórios), `npm ci` do lockfile dela; vitest com `maxWorkers: 6` (no arquivo de configuração ou na linha de comando) em toda rodada; é a base das comparações e da 5181 | a pasta de trabalho tem 26 arquivos em CRLF (o commit tem LF) → só blobs do commit |
| M3 repositório | M2 | `git init -b main`, `origin` = `designathan1988/forma`, `.gitignore` (node_modules, dist, test-results, caches), `.gitattributes` com `* text=auto eol=lf` | — |
| M4 cópia por ferramenta | M3 | (a) grafo de importações das entradas + worker + importações dinâmicas (já calculado: 116 arquivos), **conferido pelos source maps** de uma build de produção da cópia congelada feita com uma configuração só do editor (`--config`, entrada `editor.html`, `--sourcemap`; a config da FONTE só constrói o forma/2 em arquivo único) — conjunto dos `sources` ⊆ grafo, a diferença só de arquivos só-de-tipo conferidos um a um, e os fontes do worker embutido (`?worker&inline`) presentes num mapa; (b) testes pelo fecho de importações (seção 1.2); (c) assets por referência estática **mais** o registro de rede (HAR) de um uso completo (e2e inteiro) na 5181; (d) scripts e configurações classificados um a um (seção 1.2); (e) a ferramenta de cópia (fora do repositório, com o hash dela no `docs/MIGRATION.md`) copia **dos blobs do commit** e confere cada arquivo com `git hash-object` contra `git ls-tree f4e9969c`; `npm ci` a partir do lockfile copiado e só depois `npm uninstall` do que ficou fora (versões iguais às da FONTE). **Primeiro commit cita o hash da FONTE** | um arquivo carregado só em tempo de execução escapar do grafo → o HAR pega |
| M5 origens | M4 | `.claude/launch.json` daqui só com 5794 (rascunho), 5796 (protótipos) e 5181 (cópia congelada); `playwright.config.ts` na 5795 sem reaproveitar servidor (`CI=1`); antes de cada rodada, conferir PID, linha de comando e pasta do processo que ouve a porta; `cacheDir` próprio por servidor; `perf-app.mjs` padrão na 5794 | portas ocupadas pelos servidores do `forma-work` (parados com autorização) |
| M6 build | M4 | `npm run build` gera o editor atual em `dist/` (`root: src/app`, entrada `editor.html`; sem `vite-plugin-singlefile`); `/` leva a `editor.html` por um `index.html` mínimo de redirecionamento; `vite preview` abre e as fotos batem com o dev | `?worker&inline` e `.wasm?url` na build |
| M7 prova de igualdade | M5, M6 | (a) **mesmo JSON**: cópias dos projetos do usuário (seção 2, passo 3), as 11 amostras, os projetos v1 e um projeto grande gerado **uma vez para um arquivo**, abertos e salvos na 5181 e na 5794 com o **mesmo `crypto.randomUUID` com semente** injetado nos dois (`addInitScript`) — sem isso os IDs novos diferem até antigo × antigo; (b) **mesmas fotos por pixel**: contexto novo e armazenamento idêntico nos dois, barra de status (mostra `lastEvalMs`) e avisos mascarados, espera até as filas de desenho do `view.ts` esvaziarem, GPU nomeada (Chrome visível na RTX), cenários × câmeras fixos; primeiro antigo × antigo para medir o ruído, e a tolerância nunca passa dele; (c) `perf:gate` e `perf-app.mjs` (S, T20, T40, L) **lado a lado** na mesma sessão; (d) unitários e e2e trazidos verdes, e o e2e também verde contra a 5181 | não determinismo de desenho e de chegada dos workers → espera das filas e medida antigo × antigo |
| M7b a 5792 serve esta pasta | M7 | seção 2, passo 5: `forma-building` do Roadcraft passa a `vite preview` de `C:/Codex-Shared/forma-user/dist/` (build de `git archive` do commit pronto) | ligar a configuração antiga depois de mudar o esquema → a troca vem antes da etapa 2 |
| M8 o que sobrou | M7b | lista do que ficou (pasta antiga, satélites, `stash@{0}` do Roadcraft, configs antigas do `launch.json`) escrita em `docs/MIGRATION.md` e levada à **parada única** para o usuário decidir; nada apagado | — |

### Etapa R — pesquisa (seção 3)

Os relatórios da pesquisa feita no modo plan, salvos no passo M0b, são a base dos `docs/research/*.md`.

Entrada: M pronta. Saída: os 22 arquivos `docs/research/<topic>.md`, cada um com perguntas, alternativas comparadas,
fontes lidas (links abertos), decisão e o que ficou sem leitura; números de sondas só quando a decisão depende deles
(pergunta escrita antes; em Node ou na origem de protótipos 5796, nunca no app do usuário). Prioridades de leitura que
faltaram: DNIT IPR-706 e MBST (números brasileiros de via), NACTO, texto normativo do OpenDRIVE, guia de rotatórias
(FHWA/NCHRP), TCQSM (tempos de embarque), USDA Urban Tree Database (curvas de idade), Vanegas 2012 *Parcels*, Quadro 3 da
Lei 16.402, tabelas CNOSSOS, XState (envio síncrono), knip com workers. Sondas já previstas: perfil da avaliação de
prédios (H7/H9), fuzz do esqueleto reto (H8), curva do pool de workers (2…10), atualizações de veículos por ms no
worker, custo por sub-draw D3D11 nesta RTX, tamanho da célula, ruído A/A do portão. Commit e push.

### Etapa D — definição e proteções

Saída: `docs/ARCHITECTURE.md`, `docs/INTERFACE.md` (+ protótipos navegáveis em `proto/`, servidos na 5796, fotografados
em 1920×1080 e 1864×918 e conferidos um a um), `docs/PLAN.md` (lista fechada e completa, critério de "funciona" de cada
item, construções e cenários de validação, orçamentos), `docs/PROBLEMS.md` (todas as pendências da seção 1.4), `CLAUDE.md`
ajustado às decisões. Proteções (pesquisa 3.22): `npm run check` = ESLint 10 (camadas por eslint-plugin-boundaries,
`max-lines` 800, `no-empty`, `no-useless-catch`, regra local `no-silent-catch`, proibição de estado mutável de módulo) +
dependency-cruiser (ciclos, módulos mortos) + `tsc` + `knip` (normal e `--production --strict`) + unitários (com
fast-check) + `test/arch` + `test/scale` (contadores determinísticos iguais no projeto 1× e 100×, para cada comando do
registro); `.githooks/pre-push` (via `core.hooksPath`, sem dependência) rodando `scripts/gate.mjs`: o mesmo `check` +
fotos de referência por pixel (Chrome com GPU na RTX e SwiftShader, projetos separados) + portão de desempenho. Uma
especificação só para o portão de desempenho: base = build de `git archive origin/main` feita e guardada por hash (sem
worktree); ≥ 9 rodadas A/B intercaladas, cada uma num processo novo do Chrome visível, cenário roteirizado fixo; razão com
intervalo de confiança por bootstrap; reprova quando o limite inferior passa do orçamento ou um orçamento absoluto quebra;
ruído A/A medido aqui na etapa D (não antes); pré-condição de máquina (GPU certa, clock, carga dos outros processos — o
usuário joga nesta máquina): sem ela o gancho para com "NÃO VERIFICADO: máquina ocupada" e o push espera, nunca é
pulado. O código migrado ainda não tem camadas nem passa nessas regras: as violações que ele já tem (arquivos acima de
800 linhas, `catch` só com comentário, imports entre pastas que virarão camadas, exports sem uso e ciclos) ficam em
**linhas de base que só podem diminuir** — o arquivo de supressões do ESLint (`eslint-suppressions.json`, recurso oficial
de "bulk suppressions"; o ESLint já falha com supressão sem uso) e listas de base equivalentes para o knip e o
dependency-cruiser, cujas contagens o `test/arch` reprova se crescerem — e zeram até a etapa de desenvolvimento 4. Isto vai
explícito para a aprovação, porque não é afrouxar regra existente mas também não é zero. Os scripts de uso único da
migração (cópia, oráculo) ficam fora do repositório, com o hash registrado no `docs/MIGRATION.md`.

**PARADA ÚNICA**: resumo curto em português das decisões, com links para os documentos e os protótipos, e as decisões de
projeto que a pesquisa deixar para o usuário. Espera a aprovação. Candidatas já vistas (a pesquisa da etapa R resolve as
técnicas; só as de projeto chegam ao usuário, cada uma com a recomendação e o porquê):
- conjunto de workspaces (7 da pesquisa × listas antigas × 8 com Terreno/Rede/Lotes separados), visto nos protótipos;
- estado da vista interior no projeto ou só no workspace;
- no forma/4: expor o grafo de nós ou só a pilha por volume; edição de subelemento num volume "limpo" gravada no próprio
  gerador ou como nó; sólido livre já ou depois;
- conjunto de regras urbanísticas inicial (São Paulo, Lei 16.402) e padrão de sinalização (MBST brasileiro, MUTCD
  opcional);
- física: desligada por padrão com modo de física sob demanda (Rapier); vento e VSC adiados como qualitativos;
- as perguntas antigas que são de projeto: cota com ou sem toldos; 1/2/3 depois de arrastar (números ou modos); galpão
  desenhado com 8 m; regra de pavimentos de volume desenhado sozinho;
- o arquivo de supressões do ESLint para a dívida migrada (só diminui, zera na etapa 4).

### Etapas de desenvolvimento (depois da aprovação, na ordem da cadeia; a pesquisa pode ajustar a ordem)

**Entrada de cada etapa**: a anterior **pronta** pelo critério do `CLAUDE.md` (commit e push; "fechada" só depois que o
usuário conferir, o que não trava a seguinte) e a seção do `docs/ARCHITECTURE.md` que diz o que a etapa muda na cadeia,
conferida contra o código; antes de etapa que muda dado persistido, o backup da seção 2, passo 4. Ao fim de cada etapa,
a build de entrega da 5792 é refeita do commit dela. Todas fecham pelo critério acima. Medições comuns a todas: quadro
p50/p95/p99/máx, CPU e GPU por quadro, draw calls, triângulos, heap, compilações de shader durante o uso, resposta de
ferramenta (entrada → segundo quadro), custo de edição na thread principal e nos workers. Os limites fixos do esquema
atual (`LIMITS3`: 200 prédios, 600 m de mundo, 64 volumes, 400 itens) não servem para uma cidade: saem na etapa 2/3 e o
limite passa a ser o orçamento medido; quantidades de veículos, pessoas e árvores nos cenários saem da curva medida
(maior N dentro do orçamento), nunca de um teto fixo.

Agentes na execução (regras do `PROMPT-AGENTES.md`): uma única sessão escreve código e docs; no máximo um agente
pesquisador só de leitura por vez. (No modo plan cheguei a ter quatro pesquisadores ao mesmo tempo, acima desse limite;
não se repete.)

| # | etapa | sai (critério de pronto) | medições e cenários | fotos | riscos |
|---|---|---|---|---|---|
| 1 | Controladores globais, eventos, registro de comandos | store da sessão, statecharts, barramento e registro no lugar; atalhos, menus, barra contextual, paleta e busca leem o registro; isolamento entre origens ligado; superfície de depuração; o editor faz o mesmo que antes (e2e `f3.spec` verde, fotos iguais) | clique, hover, seleção e arrasto não ficam mais caros | as mesmas do M7 | acoplamento do `editor.ts` → extração guiada por testes |
| 2 | Documento por comandos, células, persistência | desfazer/refazer por patches por registro; diário de comandos no OPFS + instantâneo em blocos, Web Lock, arquivo zip; **projetos do usuário migrados** (backup renovado antes, chave `localStorage` mantida até a nova cópia ser aberta e conferida); testes por modelo (fast-check) do inverso e do diário; teste de escala: o mesmo comando custa o mesmo com 1 e 200 prédios | bytes por passo de desfazer e por autosave, ms por commit, memória do histórico (o antigo era até 200 cópias inteiras); matar o worker no meio e reabrir igual | projeto do usuário reaberto | perda de dados → backups e ida e volta |
| 3 | Grafo de dependências e avaliação incremental | só o afetado é reavaliado; avaliação de edição nos workers; parada antecipada; oráculo "incremental = do zero" com sequências de operações sorteadas com semente | torre de 40 pavimentos editada (hoje congela 0,3–0,55 s), reabrir o grande, corte e explodido em 200 prédios | antes/depois das vistas | ordem de chegada dos resultados → aplicação determinística por chave |
| 4 | Divisão dos arquivos grandes e camadas | código nas camadas `core → … → app`; nenhum arquivo acima de 800 linhas; supressões zeradas; uma responsabilidade por arquivo | nenhum número piora | as do M7 | regressão escondida → e2e e fotos |
| 4b | three r170 → r186 (e demais versões que a pesquisa decidir) | catálogo fechado de shaders compilado na carga (0 programas depois de pronto); `PCFSoftShadowMap` (removido) substituído pela decisão da pesquisa; sombra em cache; GTAO sem o segundo passe de geometria | lado a lado r170 × r186 na mesma sessão: quadro, GPU por passe, programas, draw calls | as do M7, diferenças de sombra explicadas uma a uma | mudança visual da sombra → fotos antes/depois mostradas |
| 5 | Interface nova (estrutura de todos os módulos) | workspaces, layout, kit e padrões de painel do `INTERFACE.md`; todas as funções de hoje realocadas | nada cortado, sobreposto ou desalinhado em 1920×1080 e 1864×918; acessibilidade (teclado, contraste) | cada workspace e estado vazio | painel novo pesado → orçamento de redesenho |
| 6 | Núcleo forma/4 | grafo por prédio, sólido livre, referências persistentes, órfãs relatadas, combinar/descombinar, painel de histórico, cache por nó; migração forma/3 → forma/4 com ida e volta | avaliação por edição (meta da pesquisa; hoje torre 20 pav. 124 ms) | combinar → descombinar devolve os operandos | referência ambígua → relatar, nunca adivinhar |
| 7 | Materiais | biblioteca do projeto por ID, editor em camadas assado na GPU, PBR, procedurais em escala real, biplanar, os 8 conjuntos em array KTX2; critério: §3.19 | memória de textura (134 → ~34 MB nos 8 conjuntos), programas, compilação | esfera/cubo e aplicações em fachada | variantes de shader → catálogo fechado |
| 8 | Interior, níveis e circulação vertical | paredes, portas e janelas internas, lajes com recortes, escadas por componentes com regras e solucionador, rampas, guarda-corpo associativo, núcleo de elevador, mezanino, sótão, replicar pavimentos, caminhar | vista interior sem travar ("Show all" ~4,5 s e explodido ~1,2 s hoje → metas da etapa D) | cortes por pavimento, escadas | regras de escada conflitantes → alternativas do solucionador |
| 9 | Terreno, topografia, água, georreferência e sol geográfico | grade em peças com Natural/Acabado, modificadores (platô, rampa, terraço, escavação, muro de arrimo), escultura, água, importação (DEM/GeoTIFF, curvas, pontos), CDLOD, materiais do chão; origem UTM; sol por data/hora/local; prédios assentados; critério: §3.18 | terreno grande no portão; pincel contínuo sem travar; mesmo custo de edição em mapa pequeno e grande | perto/longe, encostas, prédio em declive | costura entre peças de LOD; muros e meio-fios exatos fora da grade |
| 10 | Criador e editor de assets, biblioteca | `AssetDef` (§3.3), editor com Flex, conectores, tabela de tipos, partes congeladas, versões e migração, biblioteca com busca e miniaturas assadas na build, glTF; critério: §3.3 | um asset novo criado e editado em uso real; Flex 100% | miniaturas, asset em cada hospedeiro | conectores são síntese → validar nos 5 hospedeiros |
| 11 | Paths | §3.4 (geometria própria ou referenciada, regra de colocação completa, modos rígido/deformado/esticado, semente estável, terreno); critério: os exemplos das fontes reproduzidos | muro, cerca, postes, árvores ao longo de curvas em declive | cantos e pontas | deformação com UVs ao longo da curva |
| 12 | Construção completa | as 74 ferramentas da lista fechada (§3.1, menos o envelope de zoneamento, que entra na 14), incluindo as pendentes da seção 1.4 B; o conjunto **V1–V20** do zero em terreno inclinado, cada um com o seu aceite | regeneração de um prédio de até 30 pavimentos < 1 s na RTX (meta a calibrar) | cada construção, perto e longe | escopo grande → lista fechada |
| 13 | Vias personalizáveis | §3.5 (alinhamento, seção, cruzamentos OpenDRIVE, rotatórias, marcações MBST, mobiliário por paths, pontes e túneis, biblioteca de tipos, topologia de faixas); critério: §3.5 Validação | mover um nó refaz ≤ 2 cruzamentos, com tempo que não cresce com a rede | cruzamentos de todos os tipos, perto | defeitos de geometria do Roadcraft (rasgos, meio-fio serrilhado) |
| 14 | Lotes com crescimento, envelope de zoneamento e demanda | quarteirões, subdivisão, envelope pelos índices (SP), crescimento ao longo do tempo com demanda e economia de base, mudança de regra, travar e editar; critério: §3.6 Validação (rendimento no morro do AC8) | regra mudada em 200 prédios sem tarefa longa > 50 ms | quadra antes/depois da regra | cidade no relevo (AC8 do Roadcraft) |
| 15 | Paisagismo | §3.7; critério: §3.7 Validação | cena de 10 mil árvores: um draw por espécie e nível, quadro no orçamento | perto/longe sem "pipoca" | impostores sem perder aparência |
| 16 | Trânsito de veículos | §3.8, em worker, **continua durante edições**; critério: §3.8 Validação; o SUMO (baixado do site oficial **com permissão do usuário naquela hora**) roda os cenários de referência | curva veículos × orçamento; diagrama fundamental, descarga de fila, impasse 0 | veículos perto/longe, filas | rede refeita do zero → patch incremental |
| 17 | Pessoas | §3.9; critério: §3.9 Validação | curva pessoas × orçamento | perto (bonitos) e longe | dois sistemas → um só |
| 18 | Transporte público | §3.10; critério: §3.10 Validação | headway e lotação contra o horário; ida e volta GTFS | estações e veículos | TCQSM ainda não lido → parâmetros calibráveis marcados |
| 19 | Física | §3.11 (modo de física sob demanda com Rapier, demolição pré-fraturada, tecido no shader, partículas na GPU); critério: §3.11 Validação | ms por passo com 100/1.000/5.000 destroços | antes/depois de uma demolição | WASM grande → carregar sob demanda |
| 20 | Demais simulações | §3.12 (sombra e horas de sol, clima, ruído, redes, economia completa; vento e VSC qualitativos); critério: §3.12 Validação | custo e precisão de cada uma | estudo de sombra por hora, mapa de ruído | coeficientes CNOSSOS ainda não lidos |
| 21 | Exportações e importações | §3.20 (glTF, OBJ, IFC, DXF, OSM/GeoJSON, JSON para jogo); critério: §3.20 Validação | tempo e tamanho | arquivo reaberto em outro programa | web-ifc grande → worker sob demanda |
| 22 | Desempenho de cidade grande | cidade de referência: terreno de 4 × 4 km a 1 m, rede viária completa, ≥ 1.500 prédios (a ordem da cidade gerada do Roadcraft, 1.530), lotes crescidos, paisagismo, veículos e pessoas no maior N que o orçamento sustenta | todos os cenários do portão | cidade de perto e de longe | o orçamento não fecha → muda a representação (LOD), nunca a quantidade |
| 23 | Validação final (tudo em terreno inclinado) | V1–V20 do zero, editados depois de prontos, salvos, reabertos e exportados; um asset novo; paths com objetos diferentes; vias de tipos do usuário; lotes que crescem e reagem à regra; paisagismo; trânsito, pessoas e transporte juntos ao longo do tempo; física e demais simulações | tudo medido, no portão completo | todas, uma a uma | interação entre módulos que nenhuma etapa viu sozinha → cenários combinados longos, observados ao longo do tempo |

Ordem ajustada pela cadeia em relação à sugerida no pedido: materiais antes de terreno, assets e paisagismo (todos usam a
biblioteca de materiais); interior, níveis e circulação antes da construção completa (o conjunto V1–V20 precisa de
escadas, rampas e meio-níveis); o envelope de zoneamento e a demanda vão com os lotes; o sol geográfico vai com a
georreferência do terreno.

---

## 6. Perguntas ao usuário

Já respondidas no modo plan (2026-10-12):
1. **Sessões**: o usuário garante que nenhuma conversa grava em `labs/building/forma`; a migração parte de `f4e9969c`.
   (No M1 confiro de novo `git status` e o hash antes de copiar; se mudou, paro e mostro.)
2. **Portas**: posso parar os servidores `node` das portas 5794, 5796 e 5182 (conferidos pelo PID).
3. **`launch.json` do Roadcraft**: sim, a configuração `forma-building` passa a servir esta pasta na 5792 no passo M7b,
   depois da prova de igualdade, como build de entrega (`vite preview` de um commit pronto), nunca como servidor de
   desenvolvimento (é a única edição no Roadcraft, autorizada pelo usuário).

Falta só:
4. **Na parada de aprovação**: as decisões de projeto que a pesquisa deixar para o usuário (lista na etapa D).

---

## Verificação (como saber que o plano foi cumprido)

- M: as duas cópias brutas do LevelDB batem; o leitor offline devolve exatamente os valores conhecidos do perfil de
  teste; todas as chaves da origem 5792 listadas com hash; cada projeto do usuário (e os do forma/2/v1, se houver) reabre
  igual na 5181 e na 5794; cada arquivo copiado bate com `git ls-tree f4e9969c`; JSON (IDs semeados), fotos (ruído
  medido) e números iguais lado a lado; testes e e2e verdes; primeiro commit cita `f4e9969c`; a configuração da 5792
  aponta para a build de entrega (conferido pela configuração e pelo processo, sem eu abrir a origem; o usuário confere
  os projetos dele lá).
- R e D: 22 arquivos de pesquisa com links abertos; `ARCHITECTURE.md`, `INTERFACE.md` com protótipos fotografados nas duas
  telas, `PLAN.md` com a lista fechada e os orçamentos; `npm run check` e o `pre-push` bloqueando uma regressão provocada
  de propósito (lint, camada, tamanho, imagem e desempenho), cada um uma vez.
- Desenvolvimento: cada etapa pelo critério de pronto, com e2e, fotos examinadas e números antes/depois; a validação final
  (etapa 23) inteira em terreno inclinado.
