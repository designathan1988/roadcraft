# Roadcraft 2

Jogo de navegador de construir cidades (TypeScript, three.js, Vite). Meta: cidade no mapa inteiro
de 10 km, bonita e rápida. Jogo: `npm run dev` (127.0.0.1:5300). Verificação: `npm run check`.

## Memória do trabalho (leia primeiro)
Pasta `memory/`: ordens do jogador e estado atual entram sozinhos em toda sessão nova e depois de
toda compactação; o feito (`memory/FEITO.md`) e o diário (`memory/DIARIO.md`) leia quando precisar.
Quem muda o estado do trabalho atualiza `memory/ESTADO.md` e acrescenta uma linha no diário.
@memory/ORDENS.md
@memory/ESTADO.md

## Desempenho: o plano manda
- Plano e orçamentos: `docs/CIDADE-10KM.md` e `docs/PESQUISA-CIDADE-10KM.md` §8. Os números estão
  em `src/core/perfBudget.ts` (`VIEW_BUDGETS`, `MEMORY_BUDGETS_MB`). Leia antes de propor.
- Todo trabalho de desempenho começa por `__roadcraft.budget('rua' | 'bairro' | 'mapa')` no
  console, com a câmera na vista nomeada: a tabela medido × orçamento, o mais acima primeiro.
  Ataque essa linha. Diga quanto passa e em que etapa do plano a correção entra.
- Correção que melhora uma linha e piora outra está errada, mesmo que resolva o sintoma.
- `__roadcraft.memory()`: geometria, quanto está preso na CPU e quem segura, pelo nome da malha.
  `performance.memory` soma o heap e os arrays e, no Chrome normal, só muda a cada 20 min: não
  serve para antes e depois.
- Se o plano estiver errado ou um orçamento for impossível, pare e diga ao jogador, com números.

## Padrões que já custaram caro (`OTIMIZACAO.md`)
- Refazer tudo quando uma parte muda: jardins, postes e cor dos lotes refeitos a cada prédio.
  Refaça só o que o diário (`world/changes.ts`) diz que mudou.
- Comparar cada item com todos (O(n²)) sem índice espacial: lotes, calçadas, esquinas, mobília.
- Fazer tudo num quadro ou na thread principal: fatie por tempo ou mande para um worker.
- Desenhar ou guardar o que não se vê: detalhe e sombra sem nível de distância, cópias na CPU
  que nunca são soltas, caches sem teto.
- Esperar a GPU no meio do quadro (`getImageData`) ou compilar shader durante o jogo.

## Limites do jogador
- Nenhuma perda de qualidade gráfica sem o sim dele: fotos antes e depois, nas mesmas vistas.
- Nada mais lento: números antes e depois no relatório.
- Nada de processo longo como barreira.

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
- Rodar o jogo no roteiro pesa na máquina: avise a outra sessão antes, e não rode durante o check
  completo dela.

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

## Onde está o resto
- Armadilhas por área: CLAUDE.md em `src/render`, `src/sim`, `src/world`, `src/editor`.
- Pesquisa já feita: `docs/research/`, `docs/reference/`, `docs/PESQUISA-CIDADE-10KM.md`.
