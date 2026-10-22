# Arquitetura do Roadcraft para cidades grandes

Meta: criar, abrir e jogar uma cidade de ~200 mil prédios com a aparência aprovada, em PCs fracos e fortes.
Base da decisão: `reports/Arquitetura para cidades grandes.md` (7 frentes de pesquisa, ~170 fontes) e
`reports/Verificação rápida sem suítes.md` (como provar que nada quebrou em segundos).

## O modelo

1. **Um documento inteiro, sempre carregado.** O streaming do documento por tiles foi tentado, rejeitado e
   removido de vez (FarLevels, FarRoads, NearTiles, produtos por tile, tileStore, caixas estatísticas:
   −13,5 mil linhas). Nenhuma distância desenha caixa ou substituto: de longe, cada prédio é a massa fundida
   da sua forma real; cada via é o nível distante da sua própria superfície.
2. **O documento em colunas.** A tabela binária de prédios (`world/buildings/recordTable.ts`) é a fonte da
   verdade; um prédio vira objeto JS só quando é lido ou editado (`tableRows.ts`, LRU de 2 048). O desfazer
   guarda só os membros que mudaram; abrir um mapa troca o documento inteiro sem diff registro a registro;
   o simulador recebe o buffer da tabela.
3. **Saves binários.** Autosave, save manual, desktop e exportação gravam seções binárias por região (1 km),
   comprimidas no worker de save, sem nunca montar o texto do mapa inteiro. Saves JSON antigos continuam
   abrindo e são regravados no formato novo.
4. **Derivados limitados pela vista.** `world/viewCells.ts`: grade fixa de 256 m, estágios por célula
   (documento → derivado na CPU → residente na GPU), agendador por distância/frustum/movimento, dois
   orçamentos LRU separados (CPU e GPU), invalidação pelo diário de mudanças. Já limitados: entradas das
   superfícies de vias e cobertura dos prédios.
5. **Abertura sem trabalho de mapa inteiro.** Alturas das vias resolvidas só na região da abertura (com
   margem provada) e completadas em fatias depois da cortina; resultado idêntico à solução inteira, bit a bit.
   Cidades prontas são lidas, não regeradas (impressão digital do gerador sobre os tokens do código).
6. **Simulação com custo por tick limitado.** Carros novos vão até a borda da janela micro (não até uma
   saída sorteada no mapa); buscas com teto de expansões; 16 buscas por tick; passo do meso espalhado pelos
   ticks em arrays densos; publicação só dos links que mudaram; carros estacionados só perto da câmera.
7. **Desenho.** Oclusão na CPU no próprio quadro (paredes que certamente existem, buffer de 256 colunas,
   pirâmide de máximos; nunca esconde o que aparece, nunca tira sombra). Sombras de peças pequenas cortadas
   nas cascatas distantes pelo tamanho projetado.
8. **Qualidade adaptativa.** Nível inicial pelo hardware; governador pelo p90 do tempo de GPU com histerese
   (desce após 2 janelas de 1,5 s acima do orçamento, sobe após 4 abaixo de 60 %, espera crescente para um
   nível que a máquina não segurou). Os níveis mudam também o orçamento de triângulos e a memória do detalhe
   dos prédios. Ultra: MSAA 4× resolvido antes do pós, GTAO em resolução cheia, sombra próxima 3 072.
9. **Mapa de 14 tiles** (~14,3 km de lado) e cidade grande com raio escolhido, mesma densidade
   (~1 100 prédios/km²): ~2,8 km para 25 mil, ~4,7 km para 70 mil, ~7,9 km para 200 mil prédios.
10. **Campo.** Registro local de falhas no app desktop (Crashpad sem envio, log rotativo de problemas, resumo
    da sessão com GPU, níveis e tempos de quadro); um ponto único para ligar um serviço remoto depois.

## Como se prova que funciona

`npm run verify` (~25–40 s, sem abrir o jogo): tipos com o compilador nativo (`tsgo`, ~2 s), lint dos
arquivos alterados, testes ligados à mudança, goldens bit a bit (cidade gerada, direção, pedestres), o censo
do mundo derivado e o censo da cena: o renderizador real do jogo rodando no Node sobre uma GPU nula, abrindo a
cidade pequena e contando tudo o que as vistas de bairro e de rua desenhariam. O navegador só com `--game`.

## Números (antes → depois)

| Medida | Antes | Depois | Como foi medido |
|---|---|---|---|
| Documento inteiro, cidade grande (8 102 prédios) | 67,0 MB | 20,7 MB | Node, heap após GC |
| Registros de prédio no heap | ~5,4 KB/prédio | ~0 (tabela: 1,29 KB/prédio fora do heap) | Node |
| Entradas das superfícies de vias | 88,4 MB | 17,9 MB | Node, uma câmera |
| Cobertura dos prédios | 41,2 MB | 7,8 MB | Node, uma câmera |
| Derivados limitados, pequena vs grande | — | 11,2 vs 12,9 MB | Node (não cresce com o mapa) |
| Pico do preenchimento das vias | 80,5 MB | 34,9 MB | Node |
| Altura das vias antes do 1º quadro (16 708 vias) | 482–688 ms | 44 ms | Node |
| Passo do meso, 200 mil links | 61,6 ms num tick | ≤ 0,86 ms por tick | Node |
| Destino + busca de um carro novo (25 924 faixas) | 7,4 ms | 0,05 ms | Node |
| Save completo da cidade grande | texto de 60 M caracteres | 0,7 s, 4,9 MB, sem texto do mapa | Node |
| Save de uma edição de 1 prédio | save inteiro | 15 ms, 55 KB | Node |
| Oclusão na altura da rua | — | −8 a −17 % triângulos, −10 a −15 % draws | jogo, RTX 3060 |
| Pico de memória para gerar a cidade (160 mil prédios) | 5,6 GB | cabe em heap limitado a 2 GB (~200 mil e 249 mil prédios) | Node, `--max-old-space-size=2048` |
| Pico vivo da geração, 70 mil prédios | 2,49 GB | ~0,96 GB | Node, GC nos pontos de controle |
| Abertura da cidade de 70 mil (aplicada → mostrada) | ~40–46 s | ~16 s | jogo, marcas da página, máquina carregada (±30 %) |
| Textura no mapa, 70 mil | 602–606 MB | 367 MB | jogo, `memory()` |
| Draws do mapa, 70 mil (8 s depois) | 858 | 418 | jogo |
| Superfícies cozidas na GPU | 124 MB (RGBA8) | ~31 MB (UASTC → BC7) | calculado dos níveis KTX2 (BC7: 1 byte por texel, ¼ do RGBA8) |
| Heap da página por prédio | ~36 KB | ~6–8 KB | jogo, 25 mil e 70 mil |

## O que ficou de fora (e por quê)

- **Crescimento dos prédios dividido entre workers:** provado exato (mesmo hash da geração serial), mas 3×
  mais lento — o crescimento é uma cadeia em que cada lote depende do prédio anterior. Pela regra do hash
  igual, a geração continua serial; o caminho de ganho é acelerar a própria cadeia serial.
- **WebGPU:** parado na etapa 1 (`MIGRACAO-WEBGPU.md`); nada desta arquitetura depende dele.
- **Oclusão por prédio:** hoje a menor peça escondível é a célula de 256 m; o ganho só aparece na altura da
  rua. Esconder prédio a prédio exige lotes por prédio no desenho.
- **Ultra com sombra 3072, MSAA 4× e AO em resolução cheia, e a pré-compilação dos passes de pós:** revertidos
  (56c1ff5c). Cada um sozinho lavava a imagem (18 % dos pixels do bairro mudavam contra o visual aprovado).
- **Placas de nomes de rua:** 41,6 MB na cidade de 70 mil contra 21,5 MB na de 8 mil; cobrem todo o mapa.
  Torná-las limitadas pela vista é uma mudança maior no `signLayer`.
- **Draws de sombra do mapa logo na abertura:** 480 vêm das 160 massas de célula desenhadas nas 3 cascatas.
- **Tráfego só começa depois da cortina** (efeito da abertura mais rápida).

## Armadilha conhecida: o carimbo da cidade cozida

`cooked/cities/manifest.json` só vale se o hash bater com o código do gerador, e esse código inclui arquivos
de pessoas (`public/models/people/proxies/community.json`, `src/people/wardrobe*.json`). Com o carimbo velho,
o jogo descarta a cidade cozida e gera a cidade na hora. Rode `npm run cook:cities` depois de mudar qualquer
um deles. Antes, a cidade gerada na hora abria sem as árvores da paisagem (`nature` nulo); corrigido em
f925948c, e a semente do ecossistema agora é a da própria cidade.

(As medições finais no build desktop — fps com vsync nas vistas map/district/street, heap, abertura e tick
da simulação nas cidades de 8 mil e 200 mil — entram na seção seguinte quando feitas com a máquina livre.)
