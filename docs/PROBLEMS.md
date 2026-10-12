# Problemas — Roadcraft 2

Registro vivo dos problemas abertos. Uma linha só fecha com a medida "depois",
tirada do mesmo jeito que a "antes" (portão ou registro do próprio jogo), e com
o jogo visto. O histórico completo da FONTE está em `docs/source/PROBLEMAS.md`
(só leitura; os números citados pelo código antigo apontam para lá).

## Aguardando o jogador

Decisões que só o jogador pode tomar (tirar recurso, baixar qualidade visual,
afrouxar orçamento ou teste). Cada uma com a recomendação e o porquê.

| # | Decisão | Recomendação | Por quê |
|---|---|---|---|
| — | (nenhuma até agora) | | |

## Abertos

Trazidos da FONTE (`docs/source/PROBLEMAS.md`, linhas abertas ou aguardando) e
achados aqui. A etapa que trata cada um está na coluna "Etapa".

| # | Problema | Antes (medida) | Causa (arquivo:linha) | Etapa | Estado |
|---|---|---|---|---|---|
| (preenchida ao fechar a E1, com os números da linha de base) | | | | | |

## Já tentado e que não resolveu

Trazido da FONTE, para não repetir.

- **Lista vazia compartilhada em `shadowsAhead` (`leaderIndex.ts`, P70), 2026-10-09.**
  Desfeito sem medir; ganho esperado pequeno. Medir antes de refazer.
- **Troca de faixa por vontade a cada 0,25 s (P70), 2026-10-09.** Revertida: mudou o
  tráfego das avenidas e expôs uma entrada no vermelho ligada ao amarelo fixo; o
  amarelo pelo ITE entrou depois (P90). Refeita sobre o P90, só falhou a mediana
  das conversões livres à direita (16,99 contra 17 km/h, amostra de 7). Não
  adotada para não mexer no limite do teste.
- **Pedestres girando nas esquinas (P16), 2026-10-08.** Três tentativas revertidas
  (segurar o rumo parado; manter a listra; pure pursuit); resolvido em 2026-10-09
  (P52) pelas regras do SUMO e pela tangente contínua, com rastro tick a tick.
- **LOD das pessoas.** Reduz o custo por quadro, mas não resolve a criação lenta
  (o custo está no cozimento, no encaixe e no rosto: P4–P6 da FONTE).
- **"Otimização" das vias anunciada sem medir.** A causa real era P1 e P2 da FONTE.
- **Árvores do Nature Kit "com LOD".** Não carregavam (P10 da FONTE).
- **Cozinhar pessoas automaticamente no servidor de desenvolvimento.** Abria um
  Chrome invisível a cada reinício e travou o computador (2026-10-06). Cozinhar à
  mão, uma vez, depois de mexer em código de pessoas.
- **Não são causa:** o coletor de lixo na vila; `forestPlants` no topo das
  amostras; "7 MB por quadro" de buffers de veículos (erro de contagem).
- **Cidade gerada seguindo o relevo (AC8), 2026-10-11.** Três tentativas (parar a
  rua acima de 12%; rua que sobe vira rampa; quarteirão irregular em faixas): 446
  prédios no plano e 163 no planeta contra 514 e 234 da grade. Antes da quarta,
  medir onde os lotes somem e comparar no mesmo terreno.

## Regras que já custaram caro

- Nada em `render/` usa um contador global como chave de cache de coisa local. O
  que depende do chão ou do mundo lê o diário (`world/changes.ts`) pela área.
- Nunca criar material dentro de uma reconstrução: um material por combinação de
  parâmetros, feito uma vez (cada material novo relinka um shader).
- O que fica sobre o chão espera o job da edição terminar, e é testado contra o
  retângulo de cada item, não contra a união da camada.
- Um registro novo de prédio não é um lote novo: nivelamento e vagas comparam o
  texto do registro sem idade, nome e versão do plano do lote.
- Conteúdo que depende só dos assets e do código é cozido (`npm run cook:people`)
  ou guardado no cache derivado (`render/derivedCache.ts`), não refeito em jogo.
- Um `fetch` com caminho absoluto e um `catch` mudo fizeram as pessoas cozidas
  nunca carregarem na build de modos (PL53): nenhum erro é engolido.
- Editar com script de substituição de texto é proibido (regra do pedido de
  2026-10-12): só o Edit, para cada mudança ser lida antes.
