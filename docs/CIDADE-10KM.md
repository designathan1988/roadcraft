# Cidade no mapa inteiro (10 km): plano de engenharia

> **HISTÓRICO** (2026-10-15): registro do que se fez e mediu até 2026-10-14; não é o estado atual nem a lista de trabalho. O estado, os achados abertos e o índice dos documentos estão em `docs/ESTADO.md`. Fica no repositório porque o código cita os itens dele.

Pedido do jogador (2026-10-14): a cidade gerada cobrindo o mapa inteiro de 10,24 km,
bonita e rápida, em computadores diferentes; depois maior e maior, rumo à cidade sem limite.
"Feito" é o código sem o problema: o algoritmo escala com a cidade. **Os números deste
documento NÃO são meta** (ordem do jogador, 2026-10-14 noite): servem só para achar onde ler
o código. O plano em vigor é `docs/PLANO-ESPINHA-2026-10-14.md`.

## Onde estamos (medido 2026-10-14, Chrome, 1688×922)

| Cidade | Raio | Vias | Lotes/prédios | Pronta em | Heap vivo |
|---|---|---|---|---|---|
| padrão | 640 m | ~280 | 1.348 | ~15 s | 335 MB |
| 2× raio | 1.280 m | 1.128 | 5.400 | 47 s | 932 MB |
| mapa inteiro (extrapolado) | ~5.000 m | ~15.700 | ~80.000 | ~12 min | ~10 GB |

O heap cresce ~110-150 KB por prédio. Na cidade de 5.400 (amostragem do heap vivo):
baias de fachada em cache 150 MB, linhas e grafo dos postes 189 MB, registros e o
texto JSON de cada um 66 MB, massas guardadas em JS 33 MB, sólidos da câmera 29 MB.
Num registro gerado típico (9,5 KB), os elementos do lote são 7,1 KB.

## Como os outros resolvem (fontes lidas)

- **Detalhe em árvore** ([3D Tiles](https://github.com/CesiumGS/3d-tiles/blob/main/specification/README.adoc),
  [World Partition HLOD](https://dev.epicgames.com/documentation/en-us/unreal-engine/world-partition---hierarchical-level-of-detail-in-unreal-engine)):
  quadtree com erro geométrico em metros; filhos substituem o pai quando o erro na
  tela passa do limite; longe, só o proxy residente.
- **O que derrubou o Cities: Skylines II** ([Huhtala](https://paavo.me/cities-skylines-2-performance/)):
  peças sem LOD, só frustum culling, todo objeto projetando sombra (72 % das chamadas,
  ~40 ms de sombra num quadro de 88 ms). Regra: LOD em tudo, sombra só do que tem
  tamanho na tela.
- **Instâncias em massa** ([InstancedMesh2](https://github.com/agargaro/instanced-mesh),
  [200 mil árvores](https://discourse.threejs.org/t/a-forest-of-octahedral-impostors/85735)):
  BVH por instância, LOD por instância (cheia → meshoptimizer → impostor), LOD de sombra.
- **Cidade por semente** ([Greuter et al.](https://svn.sable.mcgill.ca/sable/courses/COMP763/oldpapers/greuter-03-real-time.pdf),
  [Danihelka & Zara](https://diglib.eg.org/items/1704c432-13e2-4008-9a58-f54590b382ba)):
  o prédio nasce de uma semente; guarda-se a semente e as alterações, não a geometria;
  gera-se o que a vista pede, com cache.
- **Tráfego em escala** ([Burghout, KTH](https://kth.se/polopoly_fs/1.742065.1600688570!/hybrid%20mesoscopic.pdf)):
  microscópico na área de interesse, mesoscópico por veículo no resto da rede.

## Referências para o mapa inteiro (onde olhar; não são meta nem critério de pronto)

| O quê | Referência |
|---|---|
| Heap JS vivo | ≤ 1,5 GB (≤ ~15 KB por prédio, tudo incluído) |
| Geração até a cidade de pé | ≤ 90 s, a página respondendo o tempo todo |
| Vista de rua e bairro | 60 fps |
| Vista do mapa inteiro | ≥ 50 fps |
| Explorar uma área nova | ≥ 50 fps, prédios no lugar (massa) até o detalhe chegar |
| Arquivo salvo | ≤ ~50 MB |

## Etapas

1. **O que a cidade guarda à toa, pela causa** — massas e cascas soltas da CPU depois de ir à
   GPU, o texto dos registros só quando preciso, baias de fachada e linhas dos postes derivadas
   pelo que mudou (`world/derived.ts`). NÃO teto de cache: um cache que expulsa e refaz esconde o
   custo, que volta com a cidade maior (CLAUDE.md).
2. **Registro compacto do prédio** — os elementos do lote gerados de novo a partir do
   plano versionado (semente), guardados só quando o jogador os muda; arquivo e heap
   proporcionais ao que é único em cada prédio.
3. **Geração em escala** — perfil da geração a 2× e 4× do raio; o que crescer mais que
   linear é corrigido; crescimento dos lotes em paralelo (workers) com o chão amostrado.
4. **Desenho em três níveis** — detalhe (células perto), massa (células médias) e
   quarteirão fundido e simplificado por ladrilho de ~1 km para a vista do mapa; sombra
   só do que tem tamanho na tela.
5. **Montagem dos prédios em workers** (#16 do `OTIMIZACAO.md`) — chão em blocos exatos
   e oráculo de calçada; a página só junta e envia à GPU.
6. **Vias em escala** — superfícies, elevação, faixas e postes medidos a 15 mil trechos.
7. **Simulação com nível de detalhe** — microscópica perto da vista, agregada longe.
8. **Opção "mapa inteiro"** no gerador da interface.
