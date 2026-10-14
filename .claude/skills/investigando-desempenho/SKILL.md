---
name: investigando-desempenho
description: Acha e corrige NA RAIZ, no código, o que deixa o Roadcraft 2 lento, travando, com memória alta ou desenho caro, para a cidade de 10 km ou maior em qualquer computador. Perfila o jogo na cidade grande, lê o código até o algoritmo ou a estrutura de dados que causa o custo, pesquisa a técnica correta na fonte oficial e em motores maduros, reescreve a causa e prova que a saída é a mesma. Use quando o jogo estiver lento, travando ou com memória alta, quando o jogador pedir otimização, ou antes de mexer por desempenho em qualquer parte.
---

# Investigando desempenho

O jogo vai ser vendido e rodar em computadores diferentes: o código tem de estar escrito
corretamente, de ponta a ponta. **Corrigido é quando o código não tem mais o problema**: o
algoritmo e os dados estão certos para a cidade de qualquer tamanho. Tempo que caiu numa cidade
de teste não é correção; quando a cidade cresce, ele volta.

Copie e marque:

```
- [ ] 1 Perfilar o jogo na cidade grande
- [ ] 2 Ler o código até a causa
- [ ] 3 Pesquisar a técnica correta
- [ ] 4 Reescrever a causa
- [ ] 5 Provar a mesma saída e conferir no jogo
- [ ] 6 Registrar
```

**1 Perfilar.** A sonda do `scripts/look.mjs` na cidade de raio 2.560 m (ou maior): passos
`profile`/`profileEnd` em volta de `city` (a geração) e da exploração. Ela dá os quadros longos com
a função que os segurou e o perfil de CPU (`.cpuprofile`, abre no DevTools). O perfil serve para
achar ONDE está a causa, não é a meta.

**2 Ler o código até a causa.** Com o perfil na mão, a ferramenta LSP (definição e referências) e o
`scripts/acusar.mjs --arquivo <arquivo>` como pistas. Responda por escrito, com arquivo e linha:
- que algoritmo é, e como cresce com a cidade (O(n), O(n²), O(n·contorno)...);
- que trabalho é refeito sem ter mudado (refazer tudo quando uma parte muda, cache que expulsa e
  refaz, cópia na CPU que nunca é solta);
- que estrutura de dados falta (índice espacial, diário de mudanças, worker, nível de detalhe).

**3 Pesquisar.** A técnica que resolve a causa: a referência local `C:/Codex-Shared/referencia/`
(three.js r186 inteiro, exemplos oficiais, 3DTilesRendererJS, InstancedMesh2, three-mesh-bvh),
context7 para outras bibliotecas, a documentação oficial (WebFetch) e como motores maduros fazem.
Escreva ao jogador o que achou, os links e a abordagem.

**4 Reescrever a causa.** A forma certa no código, não um remendo:
- NÃO amortizar: fatiar o trabalho em quadros, segurar uma camada, pôr teto num cache que refaz ou
  esperar mais entre refeituras só esconde o custo, que volta com a cidade maior;
- índice espacial em vez de varredura; o que mudou (diário) em vez de refazer tudo; trabalho pesado
  em worker; nível de detalhe e liberação da cópia na CPU para o que vai à GPU;
- corrija todas as partes da mesma causa, não só a que apareceu primeiro.
O código é em inglês (identificadores e comentários); comentário "DO NOT …" onde a
tentação de voltar existe.

**5 Provar.** A mesma saída: os testes existentes e, onde a forma mudou, um teste de equivalência
(o novo contra o antigo ou contra o mapa inteiro). No perfil da cidade grande, a função sumiu do
topo. No jogo, com a skill `conferindo-no-jogo`: a imagem igual. Qualidade gráfica não cai sem o
sim do jogador.

**6 Registrar.** `OTIMIZACAO.md` (causa, técnica, fonte), `memory/ESTADO.md`, uma linha em
`memory/DIARIO.md`. Commit só dos seus caminhos: `git commit --only <caminhos>`.

## Antes de rodar o jogo

- Cada conversa roda na própria fatia da máquina (`scripts/sessionJob.mjs`: 25% da CPU, 8 GB),
  na hora, sem esperar a outra. Se o jogo não aguenta a fatia, essa é a causa a corrigir.
- Tempo medido com a máquina dividida vale para comparar antes e depois no mesmo momento
  (alternando), não como número absoluto.

## Armadilhas já vistas

- 37 de 39 itens do `OTIMIZACAO.md` estavam "feitos" e a cidade de 2.560 m rodava a 9-11 fps com
  9 GB de heap (2026-10-14): cada um tinha melhorado um número local e ninguém tinha corrigido a
  causa. Os postes foram "feitos" segurando a camada e fatiando a chamada; o roteamento, que é a
  causa, nunca foi aberto.
- Contador e linha de base mostram a forma de um produto, não que o custo grande caiu, e não
  substituem o conserto.
- `performance.memory` soma heap e arrays e, no Chrome normal, só muda a cada 20 min.
