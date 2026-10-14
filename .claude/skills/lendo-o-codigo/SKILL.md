---
name: lendo-o-codigo
description: Acha os erros do Roadcraft 2 lendo o código inteiro, arquivo por arquivo, e conferindo cada achado na linha, em vez de procurar a causa por teste, perfil ou contador. Lista o escopo com wc -l, lê cada arquivo da primeira à última linha, anota cada trabalho (quando roda, o que o refaz, alcance, custo), segue o chamador até o quadro, o ponteiro ou a edição, procura os irmãos da mesma forma no projeto e corrige pela classe da causa. Use antes de corrigir qualquer coisa, quando algo estiver lento, errado ou "já feito" sem estar, ao conferir relato de agente ou de outra sessão, e antes de dizer que algo existe, funciona ou está conforme.
---

# Lendo o código

**O erro está no código.** Teste, perfil e contador não acham a causa e não corrigem: teste prova
que a correção funciona, perfil e medida mostram onde começar a ler e quanto caiu. A causa se acha
lendo. Lendo o código inteiro e conferindo cada achado na linha, achou-se em horas o que semanas de
testes e perfis não acharam (plano de 2026-10-14).

Copie e marque:

```
- [ ] 1 Escopo: arquivos com wc -l
- [ ] 2 Ler cada arquivo inteiro, três blocos por arquivo
- [ ] 3 Seguir o chamador de cada custo
- [ ] 4 Conferir cada achado na linha (✔/✘)
- [ ] 5 Irmãos: a mesma forma no projeto inteiro
- [ ] 6 Corrigir pela classe; teste no fim do bloco, uma vez
```

**1 Escopo.** A lista dos arquivos com `wc -l`. Cada arquivo é lido da primeira à última linha e
anotado "lido 1-N", com N igual ao `wc -l`. Arquivo pela metade não conta como lido.

**2 Por arquivo, três blocos.**
- A) Pistas de máquina: `code-rules.baseline.json`, supressões do eslint, knip, refs e
  `scripts/acusar.mjs --arquivo <arquivo>`. Cada pista vira CONFIRMA ou DERRUBA, com a linha.
  Entrada de linha de base é defeito a corrigir, nunca aceite.
- B) Cada trabalho do arquivo: onde | o quê | quando roda (FRAME, TICK, POINTER, EDIT, TIMER,
  LOAD) | o que o refaz (sempre, revisão global, diário, célula, tempo, teto) | alcance (mapa
  inteiro ou local) | custo O() | marcas (amortização, GPU, memória, thread principal, qualidade,
  OK).
- C) Inconsistências: comentário × código; duplicação; diário mal lido (entrada sem ids, diário
  esquecido, documento trocado); invalidação errada; determinismo (`Math.random`, câmera, relógio
  de parede); ciclo de vida (dispose, ouvintes, workers, caches que só crescem); regra do projeto
  violada; código morto; erro engolido; defeito de comportamento.

**3 Seguir o chamador.** Todo custo diz QUEM chama e QUANDO: Grep do nome (ou LSP, referências)
até o quadro, o passo da simulação, o ponteiro, a edição ou o timer. Foi o que pegou os jardins: o
teste chamava a API, e o `renderer.ts` chama `gardens.setMap` em todo quadro, zerando o recorte.

**4 Conferir.** Cada achado com arquivo:linha aberto por você e marcado ✔ (confere) ou ✘ (cai).
Relato de agente, de outra sessão ou do resumo da compactação só vira fato depois disso. Na
conferência de 2026-10-14 caíram 12 relatos de agentes e sessões e 3 afirmações próprias.

**5 Irmãos.** Grep da mesma forma (mesma chave, mesma varredura, mesma revisão global lida, mesmo
idioma) no projeto inteiro. A correção cobre todos; "corrigi a classe" com um irmão restando é
falso.

**6 Corrigir pela classe.** O mecanismo único da classe de causa (tabela do plano: C1 regeneração
por revisão global, C2 varredura do mapa, C3 edição que copia o documento, C4 trabalho pesado na
página, C5 GPU, C6 ciclo de vida, C7 comportamento, C8 amortização, C9 duplicação e morto, C10
ambiente), aplicado em todos os lugares. O teste vem depois, para provar a correção. "Feito" só
quando a forma errada saiu do código em todos os lugares e a barreira da classe acusa a volta.

## Nada existe por nome

"Já existe", "já usa", "já tem", "funciona" ou "está conforme" só depois de ler o código que USA a
coisa: o chamador e o caminho em que ela roda. Nunca por ter achado o nome numa busca.
- O `BatchedMesh` "existia" nos prédios só num comentário que explica a retirada dele
  (`buildingMesh.ts`, "NOT a BatchedMesh").
- Os impostores octaédricos "existiam" e estão certos no shader, mas o uso desenha 102.400
  instâncias por quadro sem recorte (`farForest.ts`, `frustumCulled = false`).
- "A multidão tem dois níveis" era falso: quem anda é a multidão procedural; os corpos cozidos
  ficam para jogador, ocupantes, quem está dentro e arremessados (`agents.ts`).

## Números

Contagem, porcentagem, tamanho ou tempo só com o comando que mediu e o resultado à vista. Número
herdado de relato ou de resumo é falso até ser medido de novo.

## Agentes

No máximo 5 ao mesmo tempo, cada um numa parte do código: lê a parte INTEIRA neste protocolo,
identifica os problemas e CORRIGE, no SEU worktree criado do `main` local (`git worktree add -b
fix/<parte> C:/Codex-Shared/rc2-wt/<parte> main`, `node_modules` e `cooked` por junção), um commit
por problema no ramo. Teste só no fim do bloco, uma vez. Entrega: o ramo, "lido 1-N" por arquivo,
o corrigido e o que ficou. Eu leio o diff inteiro, rodo o analisador no worktree e faço o merge.
Pedido ao agente: "relatório em português, código em inglês".
