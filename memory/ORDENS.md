# Ordens e regras do jogador (com data)

- Meta: cidade no mapa inteiro de 10 km, bonita e rápida. "Faça engenharia de verdade" (2026-10-14).
- Otimizar sem perder gráfico nem função; cada correção com commit próprio (problema + técnica +
  medida), comentário "NÃO …" onde a tentação de voltar existe, `OTIMIZACAO.md` como lista viva.
- Ir ao código, entender e corrigir por padrão; não empilhar testes (2026-10-14).
- Criar mecanismos que impeçam os padrões de voltar e que as próximas implementações não os repitam
  (2026-10-14). Pesquisar a fundo antes.
- Tudo em português do Brasil. Pesquisar (WebSearch + ler a fonte) antes de mudar arquivo.
- Testar no jogo como o jogador; toda foto tirada é examinada e o defeito visto é corrigido.
- Agentes liberados para trabalho útil, com instrução fechada e revisão do que fizeram.
- Não ficar parado esperando agente: trabalhar em paralelo.

## Regras entre as sessões (2026-10-14)
- As duas sessões dividem o MESMO índice do git: `git add` de uma entra no `git commit` da outra.
  Commit sempre com `git commit --only <meus caminhos>` (registra só esses arquivos e ignora o resto
  do índice; git-scm.com/docs/git-commit, `--only`), depois de ler `git diff` dos próprios arquivos.
  Duas vezes no mesmo dia um commit levou o trabalho da outra sessão (49d12f3, 777b12a).
- Antes de rodada pesada (check completo, sonda no Chrome), avisar a outra sessão: rodar junto dá
  falso tempo esgotado nos testes (citySpin a 10 s).

Como usar a pasta `memory/`: `ESTADO.md` e `ORDENS.md` entram sozinhos em toda sessão (importados
pelo `CLAUDE.md` da raiz; doc oficial, code.claude.com/docs/en/memory, seção "Instructions seem lost
after /compact": o CLAUDE.md da raiz é relido do disco depois do `/compact`) e ficam CURTOS; `FEITO.md` e `DIARIO.md`
são lidos quando precisar. Quem muda o estado do trabalho atualiza: `ESTADO.md` reescrito (não
acumula), uma linha no `DIARIO.md` (só acrescenta), o feito e medido no `FEITO.md`. Datas absolutas.
