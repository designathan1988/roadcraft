# Roadcraft 2

Jogo de navegador de construir cidades (TypeScript, three.js, Vite). Meta: cidade no mapa inteiro
de 10 km, bonita e rápida. Jogo: `npm run dev` (127.0.0.1:5300). Verificação: `npm run check`.

## Idioma
- O código é em inglês: identificadores, comentários, mensagens de teste e de erro no código.
  Comentário contra a volta de um erro: "DO NOT …".
- Em português do Brasil: a conversa, os relatórios, os docs (`docs/`, `memory/`, `OTIMIZACAO.md`)
  e as mensagens de commit.

## Memória do trabalho (leia primeiro)
Pasta `memory/`: ordens do jogador e estado atual entram sozinhos em toda sessão nova e depois de
toda compactação; o feito (`memory/FEITO.md`) e o diário (`memory/DIARIO.md`) leia quando precisar.
Quem muda o estado do trabalho atualiza `memory/ESTADO.md` e acrescenta uma linha no diário.
@memory/ORDENS.md
@memory/ESTADO.md

## Desempenho: corrigir a causa no código (ordem do jogador, 2026-10-14)
O jogo vai ser vendido e rodar em computadores diferentes: tem de estar escrito corretamente, de
ponta a ponta, com desempenho e qualidade gráfica excelentes, na cidade de 10 km e maiores.
- **Corrigido é quando o código não tem mais o problema**: o algoritmo e os dados estão certos para
  a cidade de qualquer tamanho. Tempo que caiu numa cidade de teste não é correção. Número,
  contador e linha de base não são meta: servem só para achar onde está a causa.
- NÃO amortizar: fatiar em quadros, segurar uma camada, pôr teto num cache que refaz ou espaçar as
  refeituras esconde o custo, que volta com a cidade maior. Corrija a causa, em todas as partes.
- Método na skill `investigando-desempenho`: perfilar a cidade grande (`scripts/look.mjs`,
  `profile`/`city`), ler o código até o algoritmo ou a estrutura de dados culpada, pesquisar a
  técnica correta na fonte oficial e em motores maduros, reescrever, provar a mesma saída.
- Plano e tetos: `docs/CIDADE-10KM.md` (o que a cidade inteira precisa ser).

## Causas que já custaram caro
- Refazer tudo quando uma parte muda. Certo: o diário (`world/changes.ts`) diz o que mudou.
- Varrer tudo para achar o que está perto (O(n²), O(n·contorno)). Certo: índice espacial.
- Cache com teto que expulsa e refaz o mesmo trabalho: a causa continua lá, só escondida.
- Trabalho pesado na thread principal. Certo: worker.
- Desenhar ou guardar o que não se vê: detalhe e sombra sem nível de distância, cópia na CPU do
  que já foi à GPU que nunca é solta.
- Esperar a GPU no meio do quadro (`getImageData`) ou compilar shader durante o jogo.

## Como adicionar um produto derivado
(Tudo que se calcula a partir do documento: malha, cache, índice, camada.)
- Leia o que mudou no diário (`doc.changes.since`/`touches` com os tipos que ele lê), nunca uma
  chave com revisão global (`${...revision}`).
- Ache itens por lugar com índice espacial (`buildings.near(caixa)`), não com `all()`.
- O que vai à GPU não fica copiado na CPU; o que é pesado roda em worker.

## Limites do jogador
- Nenhuma perda de qualidade gráfica sem o sim dele: fotos antes e depois, nas mesmas vistas.
- Nada de processo longo como barreira, e nada de teste atrás de teste no lugar de corrigir.
- Agentes livres: use quantos forem úteis, em paralelo, e revise o que fizeram.

## Antes de dizer que funciona
- Use o jogo como o jogador, na cidade grande; diga foto por foto o que conferiu.
- Fotos e gestos: `node scripts/look.mjs <roteiro.json>` (exemplo: `scripts/look/views.json`;
  passos e motivos no topo do script). Chrome instalado sem janela, na placa de vídeo, 1920×1080,
  perfil limpo: não toma a janela de ninguém. Arrastar, roda, clique e teclas em pixels exatos
  (câmera: botão do meio arrasta, direito gira, roda aproxima; o esquerdo é da ferramenta).
  Para se cair no renderizador de software. Fotos PNG e `relatorio.json` (erros do console,
  tabela de orçamento) numa pasta temporária.
- Não use o navegador embutido do app para conferir imagem: a foto volta no tamanho do painel
  (800×450). Ele serve para ler texto e a página (`get_page_text`, `read_page`).
- Ler a foto: abra cada PNG com Read (o Claude vê até 2.576 px sem reduzir). Detalhe pequeno
  (texto, junta, borda de sombra): roteiro com `"dpr": 2` e passo `shot` com `clip`. Procure, foto
  por foto: texto cortado ou coberto, sobreposição, peça flutuando ou atravessando, buraco, faixa
  ou pisca, cor ou luz errada, idioma trocado. Defeito visto é corrigido e fotografado de novo.
- Antes e depois de uma mudança visual: o mesmo roteiro (mesma semente, mesmas vistas) nos dois
  lados; compare as fotos lado a lado.
- O Chromium que o Playwright baixa não abre nesta máquina ("configuração lado a lado incorreta");
  por isso o roteiro usa `channel: 'chrome'`, o Chrome instalado (playwright.dev/docs/browsers).
- Com a janela do Claude minimizada, o navegador embutido não desenha. O roteiro não depende disso.
- Cada conversa tem a sua fatia da máquina e roda na hora, sem esperar a outra (ordem do jogador,
  2026-10-14): `scripts/sessionJob.mjs` põe o `run-limited`, o vitest e o `look.mjs` (com o Chrome)
  num job do Windows com teto rígido de 25% da CPU e 8 GB por conversa. Jogo que não roda na fatia
  está lento: corrija o jogo, não levante o teto. Um jogo sem janela por conversa.

## Várias sessões
- Outras sessões podem estar editando. Rode `git status` antes; não mexa em arquivo de outra
  sessão; faça commit só dos seus. Cada arquivo salvo recarrega o jogo na 5300.

## Como fazer (antes de inventar)
- Skills do projeto: `investigando-desempenho` (lento, memória, otimização) e `conferindo-no-jogo`
  (fotos e gestos antes de dizer que funciona).
- three.js inteiro da versão do jogo, offline: `C:/Codex-Shared/referencia/` (documentação em
  Markdown, manual, 608 exemplos oficiais, código-fonte) e o código de projetos maduros
  (3DTilesRendererJS, InstancedMesh2, three-mesh-bvh, postprocessing). Índice no `README.md` de lá.
  Leia o exemplo oficial que faz a técnica antes de escrever a sua.
- Outras bibliotecas: context7. Navegar no código: a ferramenta LSP (definição e referências).
- `node scripts/acusar.mjs` (5 s, só aponta, não barra nada): arquivo e linha de cada uso do
  three.js contrário ao manual oficial, de cada API obsoleta e dos padrões que já custaram caro,
  com a frase da fonte; `--regra <id>`, `--arquivo <trecho>`. Leia cada acusação antes de mexer;
  a que estiver certa ganha `// acusar-ok <regra>: motivo` na linha.

## Onde está o resto
- Armadilhas por área: CLAUDE.md em `src/render`, `src/sim`, `src/world`, `src/editor`.
- Pesquisa já feita: `docs/research/`, `docs/reference/`, `docs/PESQUISA-CIDADE-10KM.md`.
