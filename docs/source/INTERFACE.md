# Interface — auditoria e direção

Auditoria da interface v2 (`src/ui/v2/shell.ts`, `shell.css`) feita em
2026-10-09 usando o jogo de verdade: build de produção, Chrome, 1280×720 e
1920×1080, cidade gerada (`generateCity({ seed: 3, size: 'small' })`), cada
botão da barra de cima, cada ferramenta da barra de baixo com suas abas, os
painéis, o inspetor e o monitor F9. Fotos de cada estado, examinadas uma a uma.

## O que foi lido

- NN/g, 10 heurísticas de usabilidade
  (https://www.nngroup.com/articles/ten-usability-heuristics/): sobretudo
  "reconhecer em vez de lembrar" (as opções visíveis, não decoradas), estado
  do sistema visível, consistência.
- WCAG 2.2, 2.5.8 tamanho de alvo mínimo 24×24 px
  (https://www.w3.org/WAI/WCAG22/Understanding/target-size-minimum.html) e
  1.4.3 contraste 4,5:1 para texto normal, 3:1 para texto grande
  (https://www.w3.org/WAI/WCAG22/Understanding/contrast-minimum.html).
- Cities: Skylines II, visões de informação
  (https://cs2.paradoxwikis.com/Info_views): um botão abre um painel único de
  camadas; cada camada pinta o mapa e traz um resumo; a camada certa abre
  sozinha com o menu de construção correspondente.
- Cities: Skylines II, diário de tutoriais da Colossal Order
  (https://colossalorder.fi/?p=1924): dicas e painéis dão o detalhe de cada
  coisa, o tutorial aponta onde construir; atalhos editáveis em Opções.
  O diário da Iceflake (2026) anuncia justamente uma reforma da barra de
  ferramentas e ícones mais expressivos porque a interface "às vezes confunde".

## Problemas encontrados (por tela)

Prioridade: A = o jogador não consegue usar ou erra; B = atrapalha ou destoa;
C = acabamento.

### Geral
- **A** Quase tudo é só ícone, com o nome apenas na dica ao passar o mouse:
  barra de baixo (7 ferramentas), abas de cada ferramenta, cartões de
  zoneamento, lotes, relevo, solo, natureza, céu, rua, construção. O jogador
  precisa passar o mouse em cada ícone para saber o que é (fere "reconhecer em
  vez de lembrar").
- **B** Controles nativos do navegador destoam do tema: os `select` da
  Construção (categoria, encaixe, andar), o tipo de placa, a "Função" do
  inspetor do prédio; as teclas da Ajuda caem na fonte monoespaçada do
  navegador (regra `font` inválida).
- **B** Painéis sem título: Camadas, Simulação e Câmera abrem sem dizer o que
  são.

### Barra de baixo
- **A** Sete ícones sem nome. "Via" é um "A" estilizado, "Demolir" é um losango.

### Via
- **A** Abas Desenhar, Melhorar, Mover, Dividir, Controle só com ícone.
- **A** "Melhorar": cartões de via só com a miniatura, sem o nome da classe.

### Zoneamento
- **A** Residencial, comercial e industrial são três quadrados coloridos sem
  nome; os oito comandos de lote são glifos sem nome.
- **B** A densidade fica sozinha num painel largo no canto esquerdo.

### Construção
- **A** Modelos: dezenas de cartões iguais (casinha) até as miniaturas
  chegarem, e mesmo depois sem nome; impossível achar um prédio pelo nome sem
  digitar na busca.
- **B** Categoria, encaixe e andar em `select` nativo; opções espalhadas em
  três linhas desalinhadas.
- **B** Inspetor do prédio: "Função" cortada ("Torre resid…") num `select`.

### Paisagem
- **A** 21 amostras de solo/bioma só por cor (cascalho, concreto, pedras e
  granito são quatro cinzas iguais); natureza, céu e rua só glifos.

### Transporte
- **A** Sete abas só com ícone, duas idênticas (estação de trem e de metrô).
- **B** Sem linhas, o painel fica vazio sem dizer o que fazer (o texto existe,
  mas só para leitor de tela).

### Demolir
- **A** Três abas só com ícone (demolir, pistola, bomba).

## Direção escolhida

1. **Nome visível em tudo que se escolhe**: a barra de baixo com o nome curto
   sob o ícone; as abas com ícone e nome (se não couber, só a aba ativa mantém
   o nome); os cartões com o nome embaixo (o texto entre parênteses fica na
   dica). É o que a própria barra de vias já faz com o catálogo.
2. **Nada nativo**: listas viram fileiras de opções ou um menu próprio no tema.
3. **Estado visível**: título nos painéis, mensagem quando a lista está vazia
   ou quando a ferramenta precisa de uma seleção.
4. Compacto: alvos ≥ 24 px, texto ≥ 11 px, painéis que não cobrem a cidade
   sem necessidade.

## Feito

(Cada grupo entra aqui com o commit e as fotos conferidas.)

### Grupo 1 — nomes visíveis (feito, aguardando o jogador)
- Barra de baixo com o nome curto sob cada ícone (Vias, Zonas, Construir,
  Paisagem, Transporte, Demolir, Informação); nome completo e tecla na dica.
- Abas de todas as ferramentas com ícone e nome; quando não cabem (Construção
  com um prédio selecionado em 1280), só a aba ativa mantém o nome.
- Cartões com o nome embaixo, em até duas linhas (o trecho entre parênteses
  fica na dica): usos de zona, lotes, relevo, solo e biomas, natureza, céu,
  rua, melhorar via, modelos de prédio (miniatura maior e inteira), materiais.
- Teclas da Ajuda na fonte da interface (a regra `font` era inválida).
- Conferido em 1280×720 e 1920×1080: nada cortado nem sobreposto; "Apagar
  lotes e…" corta em duas linhas com reticências.
