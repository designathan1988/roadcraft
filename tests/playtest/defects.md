# Lista de defeitos

Teste do jogador a partir do mapa em branco (worktree `../roadcraft-wt`, servidor 5301, Chrome headless com GPU,
fotos em 2560x1440). Estado: aberto, corrigido (commit), motor (enviado à sessão do motor), não é defeito.
As fotos ficam em `test-results/pt/<roteiro>/` (fora do git).
A cidade gerada de 10 km está fora deste teste por ordem do jogador (está sendo refeita em outra sessão).

| # | Onde | Defeito | Causa | Estado |
|---|------|---------|-------|--------|
| 1 | Câmera | Arrastar com o botão do meio leva a câmera para fora do mapa, a 28 km, sobre um vazio azul (02 `18-pan-to-edge`) | `isoViewport.ts` prendia o centro ao alcance das chaves de tile, não à borda do mapa | corrigido 743c92cc |
| 2 | Vias | Via desenhada abaixo do chão (túnel, -8 m) ganha linha de postes: postes no furo, topo e fios sobre a grama (03 `77-tunnel-built`) | `powerLine.ts` estendia a linha de boca a boca sem olhar a altura | corrigido efc1a6b6 |
| 3 | Vias | Melhorar uma rua (avenida) deixa os postes dentro da pista; mover um nó deixa a linha no traçado antigo (04, `poles-on-road.js`) | as edições de via não tocavam na linha de postes nem no mobiliário | corrigido 77fd100f |
| 4 | Vias | Rotatória só existia com `?roads=free` na URL; raio de 100 m recusava terreno livre; prévia sempre branca | `freeRoadsEnabled` no clique e no painel | corrigido 8cf23a16 |
| 5 | Terreno | O rio cavado deixa dezenas de árvores em pé dentro da água (river `10-river`) | o pincel de rio não abria clareira | corrigido 2c28a199 |
| 6 | Demolir | Clique no meio da pista tira um banco ou poste em vez da via; via demolida deixa postes, fios e mobiliário na grama (08) | poste e peça testados antes da via, com alcance de 7 m; removeSegment não levava o kit da rua | corrigido cec0dfc8 |
| 7 | Interface | Esc não fecha os menus da barra de cima (11 `30-q-high`) | o menu só fechava com clique fora | corrigido f58f7e79 |
| 8 | Salvar | Recarregar a página volta a hora da cidade para 06:30 (10 `30-reloaded`) | a hora não era salva | corrigido bc9ece11 |
| 9 | Simulação | Semáforo automático acende os 4 braços verdes juntos (08 `31-inspect-junction`, 09 `signals.js`) | fora da janela micro o índice de conflitos não tem os pares, e o plano juntava tudo numa fase | corrigido 551f8ff2 |
| 10 | Camadas | Mapa de congestionamento ligado não mostra nada (09 `50-congestion`) | nada desenhava a camada | corrigido 54f0a2cb |
| 11 | Mundo | Fora da borda do mapa é um vazio azul-marinho; de longe a placa de 10 km flutua nele (02b `22-turned`) | nada desenhado além do mapa | motor |
| 12 | Mundo | Árvores mudam de lugar nos primeiros segundos (00 `01` x `03`) | `natureSweep` (lista do CLAUDE.md) | motor |
| 13 | Mundo | Árvores ficam em pé sobre vias novas e sobre o anel da rotatória (03 `11`, 04 `64`) | a mata não abre clareira para as vias | motor |
| 14 | Vias | Túnel sem boca visível; via a -8 m some por completo; console 'roads missing from the picture' (03) | portal / desenho do túnel | motor |
| 15 | Vias | Ponte a +8 m termina no ar, sem rampa nem pilar visível de cima (03 `51-bridge-built`) | desenho da ponte | motor |
| 16 | Desempenho | Abrir o mapa em branco: quadros longos de até 1,6 s no painel de saúde (01 `09-menu-sim`) | a medir | motor |
| 17 | Ajuda | A ajuda diz que Q/E giram 15°; Q/E giram enquanto seguros | texto não bate com `cameraMotion.ts` | aberto (redesenho) |
| 18 | Ajuda | Sem ferramenta na mão, "Esta ferramenta" lista as teclas de seleção de vias | ajuda trata Inspecionar como Vias | aberto (redesenho) |
| 19 | Construção | Catálogo com o mesmo ícone de casa para todos os modelos; 98 cartões numa fila que passa da tela (01 `38-tool-build`) | sem miniaturas; fila sem quebra | aberto (redesenho) |
| 20 | Interface | O painel de saúde do jogo (ferramenta de desenvolvedor) fica na barra do jogador | botão F9 na barra | aberto (redesenho) |
| 21 | Interface | Sem tela inicial: o jogo abre direto num mapa em branco; nova cidade, abrir e continuar ficam no menu ☰ | sem tela de título | aberto (redesenho) |
| 22 | Ajuda | Atalhos das ferramentas listados como "1 Z H T O B I", ilegível | lista de teclas | aberto (redesenho) |
| 23 | Vias | Via inteira abaixo do chão não aparece de jeito nenhum: não dá para ver nem selecionar | sem vista subterrânea | aberto |
| 24 | Pessoas | A ferramenta Pessoas (`person` em `toolMachine.ts`) não está em nenhum botão | ferramenta sem lugar na interface | aberto (redesenho) |
