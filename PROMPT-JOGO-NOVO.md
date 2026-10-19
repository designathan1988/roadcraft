# Prompt: jogo de construir cidades, novo, feito para cidades grandes

> Cole tudo abaixo numa sessão nova, numa pasta vazia. Ajuste os números da seção "Metas" se quiser outra coisa.

---

Você vai criar do zero um jogo de construir cidades no navegador: TypeScript, Vite, three.js (WebGL2). O jogo
tem que aguentar uma cidade grande inteira construída sem perder quadros nem qualidade visual. Desempenho não é
uma etapa do fim: é a regra de toda decisão, desde o primeiro commit.

## Metas (contrato do projeto)

- Mapa de 8 x 8 km. A cidade cheia ocupa o mapa inteiro: ~200 mil prédios, ~30 mil km de faixas de rua somadas,
  ~1 milhão de habitantes simulados.
- 60 quadros por segundo em 1920x1080 numa GTX 1660 / RTX 3060, com a cidade cheia, em qualquer vista: de
  perto da rua até o mapa inteiro.
- Orçamento por quadro, medido por contagem (não por cronômetro):
  - até 400 chamadas de desenho no total (todos os passes, sombra incluída);
  - até 3 milhões de triângulos;
  - até 4 ms de JavaScript na thread principal;
  - nada de geometria, textura ou material criado durante o quadro;
  - zero alocação de memória por quadro no caminho quente (sem `new`, sem arrays temporários, sem closures).
- Memória total da aba abaixo de 2 GB com a cidade cheia.
- Abrir um save da cidade cheia em menos de 10 s.

Se uma funcionalidade não cabe no orçamento, ela muda ou sai. Ninguém aumenta o orçamento para caber.

## Arquitetura obrigatória

1. **Dados de origem pequenos, todo o resto derivado.** O estado do jogo é só: grafo de ruas (nós e arestas),
   zonas por lote, prédios (tipo, nível, semente), serviços, orçamento. Tudo que se desenha é gerado desse estado
   de forma determinística. O save guarda só a origem, em binário compacto.
2. **Dados orientados a arrays.** Entidades numerosas (prédios, lotes, carros, viagens) ficam em `TypedArray`
   (estrutura de arrays), com índices inteiros. Nada de um objeto JavaScript por prédio ou por pessoa.
3. **Mundo em blocos (chunks) de 256 m.** Cada bloco tem a sua geometria já juntada por material. Uma edição
   marca só os blocos que tocou como sujos. Blocos sujos são refeitos num worker e voltam como buffers
   transferíveis. Nunca refaça o mapa inteiro por causa de uma edição.
4. **Três níveis de detalhe por bloco, com troca sem salto visível:**
   - perto (até ~600 m): prédios com volume, telhado, marquise; ruas com meio-fio e faixas;
   - médio (até ~2,5 km): caixas simplificadas com o mesmo atlas; ruas como faixa plana;
   - longe: cada bloco vira uma única malha baixa (alturas dos prédios num relevo simples) com textura gerada.
5. **Detalhe no shader, não na geometria.** Janelas, andares, luzes acesas à noite, sujeira e variação de cor
   vêm do shader a partir da semente do prédio e de um atlas único (`DataArrayTexture`). No máximo 8 materiais
   no jogo inteiro.
6. **Instâncias para o que se repete:** árvores, postes, carros, peças de prédio. Uma chamada de desenho por tipo,
   não por objeto. Culling por bloco na CPU antes de mandar instâncias.
7. **Simulação separada da renderização.** A simulação roda num worker, em passo fixo, e manda para a thread
   principal só o que mudou. A thread principal nunca espera a simulação.
8. **Simulação agregada.** Demanda, empregos, serviços e tráfego são calculados por lote e por aresta do grafo
   (fluxo e ocupação), não por indivíduo. Carros e pessoas visíveis são cosméticos: só perto da câmera, gerados
   a partir do fluxo da aresta, no máximo 5 mil carros e 3 mil pessoas desenhados ao mesmo tempo.
9. **Uma luz direcional com sombra em 2 cascatas no máximo**, só para o nível "perto". Longe disso, oclusão
   ambiente assada na textura do bloco.
10. **Poucos workers, com papéis fixos:** um da simulação, um pool pequeno (núcleos - 2) para gerar geometria de
    blocos. Nada de um worker novo para cada sistema.

## Fora do escopo (não fazer, nem "rapidinho")

Animação de caminhada por pessoa, destruição e desastres, ecologia, fumaça e partículas, clima dinâmico,
interiores, iluminação de cânion, sombras por prédio distante, qualquer sistema que ajuste o detalhe sozinho
conforme o tempo de GPU (ele muda a cena no meio da medição e engana). Só entram depois da versão 1.0, e só se
couberem no orçamento.

## Como medir (desde o primeiro marco)

- Desde o marco 1 existe uma **cidade de estresse**: um gerador que enche o mapa inteiro de ruas e prédios no
  nível máximo. Todo marco é testado nela, não numa cidade pequena.
- Um script `npm run budget` abre o jogo no Chrome headless pelo Playwright
  (`chromium.launch({ channel: 'chrome', headless: true })`), carrega a cidade de estresse, para o relógio,
  posiciona a câmera em 5 vistas fixas (rua, bairro, distrito, mapa inteiro, rasante) e conta: chamadas de
  desenho, triângulos, geometrias e texturas vivas, alocações por quadro, tempo de JS na thread principal.
- O script falha se qualquer número passar do orçamento. Ele roda antes de todo commit.
- Antes de medir, verifique que nada mais usa a GPU (outras abas com o jogo, Chromes que sobraram, outro
  servidor). Não use o navegador embutido do app para ver o jogo.
- Contagens valem mais que tempos: tempo de GPU varia com a máquina e já levou a conclusões falsas.

## Marcos (cada um termina jogável e dentro do orçamento na cidade de estresse)

1. Terreno de 8 km, câmera (pan, zoom, giro), blocos, gerador da cidade de estresse com caixas, `npm run budget`.
2. Ferramenta de rua: desenhar, curvar, cruzar, apagar; geometria por bloco num worker; grafo de ruas.
3. Zonas e lotes ao longo das ruas; prédios procedurais com atlas e shader; três níveis de detalhe.
4. Simulação agregada no worker: crescimento, demanda, empregos, dinheiro; prédios sobem de nível.
5. Tráfego por fluxo nas arestas; carros cosméticos perto da câmera; mapa de congestionamento.
6. Serviços (água, energia, saúde, escola, polícia, bombeiros) por área de cobertura.
7. Save e load binário; desfazer e refazer.
8. Interface: barra de ferramentas, painéis, informações do lote, mapas de dados.
9. Dia e noite (luzes no shader), árvores e enfeites por instância, polimento visual.

## Regras de trabalho

- Um marco por vez. Não comece o seguinte antes de o atual passar no `npm run budget` e no typecheck.
- Antes de cada sistema novo, escreva em 3 linhas: quanto ele custa em chamadas de desenho, triângulos,
  memória e ms de CPU, e onde isso cabe no orçamento.
- Código pequeno: se um arquivo passar de 600 linhas ou um sistema precisar de mais de um worker próprio, pare e
  simplifique.
- Testes só onde pagam: geração determinística, grafo de ruas, save/load, simulação. Não escreva teste para
  cada detalhe visual.
- Commits pequenos, mensagem em português dizendo o que mudou e o número do orçamento antes e depois quando
  mexer em desempenho.
- Em dúvida entre bonito e rápido, escolha rápido e me pergunte se vale gastar orçamento no bonito.
