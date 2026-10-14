# Padrões que já custaram caro

Exemplos reais: `OTIMIZACAO.md` (itens) e `docs/AUDITORIA-2026-10-14.md` (~90 achados).

| Padrão | Forma no código | Correção | Barreira contra a volta |
|---|---|---|---|
| Refazer tudo quando uma parte muda | reconstrução disparada por revisão global (`doc.revision`, `buildings.revision`) ou por qualquer entrada do diário; `all()` dentro de `update` | ler `doc.changes` desde o serial do leitor; guardar por item; refazer só os itens mudados | `tests/scale` ("um item a mais custa igual em N e 4N"; linha de base que só cai) |
| Cada item contra todos (O(n²)) | laço sobre coleção do mapa dentro de outro; chamada por item que varre o mapa | índice espacial: `BuildingStore.near(caixa)`, grades de 32/64 m, poda MINDIST | check-code `whole-map-nested` e `whole-map-per-item` (marque a função com `@perItem`) |
| Tudo num quadro ou na thread principal | laço síncrono longo na geração, abertura ou edição | gerador fatiado com orçamento em ms; worker para trabalho puro | `STEP_BUDGETS` (aviso "hitch" no F9); pior quadro medido |
| Desenhar ou guardar o que não se vê | detalhe e sombra sem nível de distância; arrays guardados após o envio à GPU; cache sem teto | nível por erro de tela (plano §8.3); sombra por tamanho na tela; soltar arrays; LRU com teto em bytes | tabela `budget` (memória por nível, triângulos por vista); `memory().cpuByName` |
| Esperar a GPU ou compilar no jogo | `getImageData`/`readPixels` em canvas acelerado; material novo em reconstrução; variante não pré-compilada | `willReadFrequently`; material do catálogo; `compileAsync` na carga | check-code `material-in-frame`, `compile-in-frame` |
| Invalidação ampla | chave de cache com revisão global; leitor do diário que vê `null` (anel de 2.048 entradas) e refaz o mapa | chave pelo que a saída lê; `serialOf(tipos)` do próprio tipo | contador por evento em `tests/scale` |
| Comparar por JSON | `JSON.stringify(a) === JSON.stringify(b)` em caminho quente | comparar o que o diário diz que mudou | check-code `heavy-call-per-frame` |
| Dado duplicado em duas formas | o mesmo registro ou geometria na CPU e na GPU; cópia inteira por edição | uma fonte; a outra derivada sob demanda | `memory()` antes e depois |

Função que monta um cache de uma vez (amortizada): marque `@rebuild` para o check-code não acusá-la.
