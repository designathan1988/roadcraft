# Ordens e regras do jogador (com data)

- Meta: cidade no mapa inteiro de 10 km e maiores, bonita e rápida, em computadores diferentes
  (o jogo vai ser vendido). "Faça engenharia de verdade" (2026-10-14).
- **Corrigido é quando o código não tem mais o problema na base** (2026-10-14): a causa reescrita
  no algoritmo e nos dados, não um tempo que caiu. "Não estou nem aí para métrica." Nada de
  amortizar (fatiar, segurar, teto de cache, espaçar) nem remendo: corrigir tudo o que causa o
  problema, no código, alinhado com as fontes oficiais.
- Otimizar sem perder gráfico nem função; cada correção com commit próprio (causa + técnica +
  fonte), comentário "DO NOT …" onde a tentação de voltar existe, `OTIMIZACAO.md` como lista viva.
- O código é em inglês (identificadores, comentários, testes); conversa, relatórios, docs e
  mensagens de commit em português do Brasil (2026-10-14).
- Ir ao código, entender e corrigir; não empilhar testes nem ferramentas no lugar de corrigir.
- Conversa em português do Brasil (o código em inglês, acima). Pesquisar (WebSearch + ler a
  fonte) antes de mudar arquivo.
- Testar no jogo como o jogador; toda foto tirada é examinada e o defeito visto é corrigido.
- Agentes livres (2026-10-14): quantos forem úteis, em paralelo; revisar o que fizeram.

## Regras entre as sessões (2026-10-14)
- As duas sessões dividem o MESMO índice do git: `git add` de uma entra no `git commit` da outra.
  Commit sempre com `git commit --only <meus caminhos>` (registra só esses arquivos e ignora o resto
  do índice; git-scm.com/docs/git-commit, `--only`), depois de ler `git diff` dos próprios arquivos.
  Duas vezes no mesmo dia um commit levou o trabalho da outra sessão (49d12f3, 777b12a).
- Cada conversa usa a sua fatia da máquina (i9-12900K, 32 GB, RTX 3060) e roda na hora, sem esperar a
  outra (2026-10-14): "não tem cabimento usar 100% da cpu em um processo". `scripts/sessionJob.mjs`
  (job do Windows: 25% da CPU e 8 GB por conversa, os agentes dentro). Se o jogo não roda na fatia, o
  jogo está lento e é isso que se corrige.

Como usar a pasta `memory/`: `ESTADO.md` e `ORDENS.md` entram sozinhos em toda sessão (importados
pelo `CLAUDE.md` da raiz; doc oficial, code.claude.com/docs/en/memory, seção "Instructions seem lost
after /compact": o CLAUDE.md da raiz é relido do disco depois do `/compact`) e ficam CURTOS; `FEITO.md` e `DIARIO.md`
são lidos quando precisar. Quem muda o estado do trabalho atualiza: `ESTADO.md` reescrito (não
acumula), uma linha no `DIARIO.md` (só acrescenta), o feito e medido no `FEITO.md`. Datas absolutas.
