# Roadcraft 2

Jogo de navegador de construir cidades (TypeScript, three.js r186, Vite; vai ser vendido na Steam).
Jogo: `npm run dev` (127.0.0.1:5300). Verificação: `npm run check`. Este é o ÚNICO arquivo de
instruções do projeto: não crie outro (nem `memory/`, nem `CLAUDE.md` em subpasta, nem hook).

## O que o jogador quer
- Desempenho e qualidade gráfica excelentes em computadores diferentes, rumo à cidade sem limite:
  primeiro o mapa inteiro de 10 km × 10 km, depois maior.
- **Corrigido é quando o código não tem mais o problema**: algoritmo e dados certos para a cidade
  de qualquer tamanho. Tempo que caiu numa cidade de teste não é correção; número não é meta.
- NÃO amortizar: fatiar em quadros, segurar uma camada, teto num cache que expulsa e refaz, espaçar
  refeituras. Isso esconde o custo, que volta com a cidade maior. Corrija a causa.
- Faça o trabalho; não pergunte o que o código e estas regras já respondem. Pergunte só: perda de
  qualidade gráfica, envio ao GitHub, apagar dados dele.
- Nenhuma perda de qualidade gráfica sem o sim dele: fotos antes e depois, nas mesmas vistas.
- Teste no fim de cada bloco de trabalho, uma vez. Nada de suíte a cada passo, nada de processo,
  papelada, plano ou nota no lugar de corrigir.
- Diga a verdade: o que não conferiu, diga que não conferiu. Nunca "já existe" ou "funciona" sem
  ter lido o código que USA a coisa (o chamador, até o quadro, a edição ou o ponteiro).

## Idioma
- Código em inglês: identificadores, comentários, testes, mensagens de erro. Comentário contra a
  volta de um erro: "DO NOT …".
- Português do Brasil: conversa, relatórios, `docs/`, `OTIMIZACAO.md`, mensagens de commit.

## Como trabalhar
- Ache a causa lendo o código inteiro da parte: arquivo por arquivo, o chamador seguido até o
  quadro, a edição ou o ponteiro, e os irmãos da mesma forma no projeto. Corrija a classe inteira.
- Antes de uma técnica que o código ainda não usa, leia a fonte oficial. three.js da versão do jogo,
  offline: `C:/Codex-Shared/referencia/` (docs, manual, exemplos, fonte; InstancedMesh2,
  3DTilesRendererJS, three-mesh-bvh, postprocessing; índice no `README.md` de lá).
- `node scripts/acusar.mjs` aponta usos do three contrários ao manual e padrões que já custaram caro.
- Cada correção com commit próprio (causa, técnica, fonte) e linha em `OTIMIZACAO.md`.

## Causas que já custaram caro
- Refazer tudo quando uma parte muda. Certo: o diário (`world/changes.ts`) diz o que mudou; um
  derivado lê `doc.changes.since`/`touches` dos tipos dele, nunca uma chave com revisão global.
- Varrer tudo para achar o que está perto. Certo: índice espacial (`buildings.near(caixa)`).
- Cache com teto que expulsa e refaz o mesmo trabalho.
- Trabalho pesado na thread principal. Certo: worker.
- Desenhar ou guardar o que não se vê: sem nível de distância; cópia na CPU do que já está na GPU.
- Esperar a GPU no meio do quadro (`getImageData`) ou compilar shader durante o jogo.

## Achados abertos (lidos no código em 2026-10-14 noite, não corrigidos)
- Os cinco blocos da auditoria (camada de prédios, refeituras por edição de via, cache de 128 MB,
  alocações do tráfego, texto JSON por prédio) foram corrigidos: `OTIMIZACAO.md`, "Motor central".
- Ainda O(mapa) por mudança: transporte (`renderer.ts`, `transitAreaOf` e `buildTransit` por
  revisão), névoa e ravinas por revisão do terreno, florestas e cobertura reescritas pela lista
  inteira quando o conjunto mantido muda (`natureTrees.ts` `update`, `buildGroundCover`).
- `terrain.ts` (19 leituras de revisão), `flatAtlas.ts` (9), `main.ts` (10): ainda por converter.
- O motor (`core/engine.ts`) tem só os produtos da fase `draw`; os outros derivados ainda se
  atualizam sozinhos. A trava do ESLint (proibir revisão global fora do motor) não existe ainda.
- Células de detalhe longe ficam na GPU (ordem do jogador): a memória de vídeo cresce com a área já
  visitada; falta o teto pelo orçamento da placa (residência), sem refazer o que volta.
- Pesquisa e propostas: `docs/research/especificacao-externa-cidade-infinita.md`,
  `docs/PESQUISA-CIDADE-10KM.md`, `docs/CIDADE-10KM.md`, `docs/PLANO-ESPINHA-2026-10-14.md`.

## Conferir no jogo
- `node scripts/look.mjs <roteiro.json>` (exemplo `scripts/look/views.json`): Chrome instalado sem
  janela, na placa de vídeo, 1920×1080. Câmera: meio arrasta, direito gira, roda aproxima; o
  esquerdo é da ferramenta. O Chromium do Playwright não abre nesta máquina: `channel: 'chrome'`.
- Abra cada PNG com Read e procure: texto cortado, sobreposição, peça flutuando, buraco, pisca, luz
  errada, idioma trocado. Defeito visto é corrigido e fotografado de novo.
- O navegador embutido do app devolve fotos de 800×450: serve para ler texto, não para imagem.
- Comandos pesados por `node scripts/run-limited.mjs …` (job do Windows: 25% da CPU, 8 GB).

## Commits, ramos, agentes
- `git status` antes; commit só dos seus caminhos: `git commit --only <caminhos>`, depois de ler o
  `git diff` deles. Cada arquivo salvo na pasta principal recarrega o jogo na 5300.
- Agentes: no máximo 5; cada um numa parte, no SEU worktree criado do `main` local
  (`git worktree add -b fix/<parte> C:/Codex-Shared/rc2-wt/<parte> main`; `node_modules` e `cooked`
  por junção). Leia o diff inteiro e faça o merge no `main`. Para tirar um worktree, desfaça as
  junções com `rmdir`, nunca `rm -rf` (apagaria o `node_modules` da pasta principal).
- Nunca envie ao GitHub sem o sim do jogador. Portas e pastas dele, nunca mexer: 4180-4183, 5173,
  5175-5178, `C:/Codex-Shared/backup-mapa-jogador`.

## Armadilhas por área
**render** (só `src/render` importa `three`)
- Profundidade invertida em buffer float (`depthConvention.ts`): pisca à distância nunca se corrige
  empurrando o near nem aumentando offset; passe que lê profundidade usa `DEPTH_GLSL`.
- A sombra anda em texels inteiros do chão (`environment.ts` `GroundShadowGrid`); o sol em passos
  de 0,1° (`SUN_STEP`). `shadowMap.enabled` depende da qualidade: confira o nível primeiro.
- O `y` do mundo vira o `z` do three e inverte o sentido: meça a área com sinal, não assuma.
- `earcut` em faixa longa e fina faz triângulos enormes: corte antes (`splitToSpan`).
- Textura e material feitos uma vez; nunca criar material dentro de uma refeitura.
- Peça repetida é instanciada; material compartilhado precisa da mesma variante de programa.
- `vertexColors: true` no material, ou a cor por vértice não faz nada.
- `compileAsync` com o alvo do pós-processamento, senão o primeiro quadro trava.
- Pessoas: MakeHuman cozidas antes (`cooked/`, versão em `cook-plugin.ts` `CAST`); esqueletos na
  GPU (`people/crowdAnimation.ts`): `renderPalettes` depois do `update` e antes do desenho.
- Nada de duas superfícies de um prédio no mesmo plano (`tests/render/coplanar.spec.ts`).
- Shader do asfalto (`materials.ts` `ROAD_SPACE_FRAGMENT`): `uv.x * ASPHALT_TILE` é o través.
- Buffers de instância medidos por `FLEET_CEILING` e `PED_CEILING` (`sim/params.ts`).
- Efeito visual novo: em `postprocess.ts`, atrás de uma opção em `quality.ts`.

**world**
- Um corte por ponta de via (`approach.ts`) alimenta boca, zebra, linha de parada, faixa, meio-fio.
- `HEADING_CHORD` é de `sim/pose.ts`, `conflictPoints.ts` e `turnPaths.ts`: os três juntos.
- Altura do terreno: `heightAt` é o campo; `renderedHeightAt` é o que se desenha.
- Túnel é degrau no terreno mais portal; `TUNNEL_*` e `CUT_SHOULDER` andam juntos.
- Via no nível é linha projetada, não o chão (`solveGround`); o cruzamento pega a altura das pernas.
- Edição de prédio move `doc.buildings.revision`, nunca `doc.revision`.
- Célula do terreno: 6,4 m. Números de via com fonte em `roads/tuning.ts`; só o jogador muda.
- Mapa fixo hoje: 5 × 5 placas de 2.048 m (`world/bounds.ts`).

**sim**
- Um escritor por campo; ordem dos estágios em `pipeline.ts`. `clock.tick` só no fim do `step`.
- `archetype` é a máquina, `driver` é a pessoa. Troca de faixa ocupa duas faixas (`bodiesIn`).
- Estágio de sinal nunca junta movimentos que se cruzam (`signals/plan.ts`).
- `WALKER_SHAPE`: todo campo de um pedestre declarado de uma vez (classes ocultas).
- `SimWorld.doLess` tem de dar o mesmo que fazer tudo (`tests/sim/doLess.spec.ts`).

**editor**
- `commitDraft` adota a rede só depois de refeita. Toda edição de via paga em `roads/economy.ts`.
- Ferramenta nova: `Tool` em `toolMachine.ts`, `case` no `pointerdown` de `main.ts`, letra em
  `gameKeys.ts`, lugar em `ui/v2/shell.ts`, chaves `tool.`/`hint.` nos dois dicionários.
- O carregamento valida com os predicados do próprio documento (`persistence.ts`).
