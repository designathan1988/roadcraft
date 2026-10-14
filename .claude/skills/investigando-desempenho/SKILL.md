---
name: investigando-desempenho
description: Investiga e corrige lentidão, travadas, memória alta e custo de desenho do Roadcraft 2 pelo plano da cidade de 10 km. Mede com __roadcraft.budget, acha a causa no código pelos padrões que já custaram caro, pesquisa a técnica na documentação oficial, corrige sem mudar a imagem e prova com números, contador de escala e fotos. Use quando o jogo estiver lento, travando, com fps baixo ou memória alta, quando o jogador pedir otimização, ou antes de mexer por desempenho em renderer, prédios, vias, terreno, simulação ou geração.
---

# Investigando desempenho

Copie e marque:

```
- [ ] 1 Medir: a linha mais acima do orçamento
- [ ] 2 Achar quem custa: malha, etapa ou função
- [ ] 3 Ler o caminho no código até a causa
- [ ] 4 Nomear o padrão e conferir o plano
- [ ] 5 Pesquisar a técnica
- [ ] 6 Corrigir sem mudar a imagem
- [ ] 7 Provar: números, barreira, fotos
- [ ] 8 Registrar
```

**1 Medir.** Siga "Antes de rodar o jogo" abaixo. `node scripts/look.mjs scripts/look/views.json`
dá a tabela medido × orçamento nas vistas rua, bairro e mapa; a vista do jogador, em
[medir.md](medir.md). Guarde os números "antes". Ataque a linha com maior `vezes`. Linha grande
"sem orçamento no plano": diga ao jogador.

**2 Achar quem custa.** Memória: `__roadcraft.memory()` (`cpuByName`). Triângulos e chamadas por
nível, CPU por etapa: [medir.md](medir.md).

**3 Ler o código.** Comece por `node scripts/acusar.mjs --arquivo <arquivo suspeito>`: aponta,
com a fonte oficial, os usos do three.js e os padrões conhecidos naquele arquivo (pistas, não
provas). Use a ferramenta LSP (definição e referências pelo símbolo) para subir dos
custos até quem os dispara; se a sessão não tiver LSP, Grep pelo nome exato do símbolo e confira
cada resultado. Responda por escrito: o que dispara, com que frequência (quadro,
item, edição), sobre quantos itens, e o que de fato mudou.

**4 Padrão e plano.** Encaixe a causa em [padroes.md](padroes.md): forma no código, correção e
barreira contra a volta. Ache a etapa em `docs/CIDADE-10KM.md` e os tetos em
`docs/PESQUISA-CIDADE-10KM.md` §8.6. Recuse a correção que estoura outra linha (ex.: soltar a
CPU jogando a geometria na GPU acima do teto de memória de vídeo).

**5 Pesquisar.** Nesta ordem:
1. `docs/research/` e `docs/PESQUISA-CIDADE-10KM.md` (o que já foi pesquisado).
2. A referência local `C:/Codex-Shared/referencia/` (índice no `README.md` de lá): documentação
   inteira do three.js r186 em Markdown, manual, os 608 exemplos oficiais e o código-fonte; e o
   código de projetos maduros (3DTilesRendererJS, InstancedMesh2, three-mesh-bvh,
   postprocessing). Busque com Grep; leia o exemplo oficial que faz a técnica antes de escrever a
   sua.
3. context7 (`resolve-library-id`, depois `query-docs` com a versão do `package.json`) para
   outras bibliotecas.
4. WebFetch da página oficial (o hook do jogador exige um WebFetch antes de editar) e como
   motores maduros resolvem (Unreal, Cesium, Cities: Skylines).

Escreva ao jogador: o que achou, os links ou arquivos, a abordagem.

**6 Corrigir.** Mesmo resultado (digest, byte a byte ou foto). Se a técnica muda pixels, mesmo
pouco (sombra cortada abaixo de 1 texel, nível de longe mais cedo), é decisão do jogador: mostre
as fotos antes e depois lado a lado e espere o sim. Comentário "NÃO …" onde a
tentação de voltar existe. Commit só dos seus caminhos: `git commit --only <caminhos>`, depois
`git show --stat HEAD`.

**7 Provar.** O mesmo roteiro depois: tabela antes → depois. A barreira da linha de
[padroes.md](padroes.md) verde (`npm run check`; "novo:" é regressão). Fotos antes e depois com a
skill `conferindo-no-jogo`. Se qualquer linha piorou, desfaça e volte ao passo 3.

**8 Registrar.** `OTIMIZACAO.md` (problema, técnica, fonte, antes → depois), sua parte de
`memory/ESTADO.md` reescrita, uma linha em `memory/DIARIO.md`.

## Antes de rodar o jogo

- O jogo no ar: `curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:5300/` dá 200; senão
  `npm run dev` em segundo plano.
- Outra sessão rodando check ou teste pesado? No PowerShell:
  `Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object CommandLine -match 'check\.mjs|vitest'`.
  Havendo, espere.
- Avise: `ListAgents` mostra as sessões; `SendMessage` para a que trabalha no projeto ("vou rodar
  o jogo por ~2 min").

## Armadilhas já vistas

- Ler documentação não substitui medir: 21 páginas lidas não evitaram o `BatchedMesh` guardando
  1 GB na CPU. Só a medida pegou.
- `performance.memory` soma heap e arrays e, no Chrome normal, só muda a cada 20 min.
- Teste que imita o three à mão (`onUploadCallback` em tudo) não prova o jogo: o three só envia
  à GPU o que a câmera enquadra.
- Contador que passa rápido demais: imprima os números; um passou com o documento vazio
  (`put` em vez de `add`).
- Check completo da outra sessão rodando: não rode o jogo nem testes pesados.
