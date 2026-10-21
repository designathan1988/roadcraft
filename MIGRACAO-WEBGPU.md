# Migração do renderizador para WebGPU

> **Parada na etapa 1 (decisão de 2026-10-21).** A migração não continua. A etapa 1 (a chave `?gpu=webgpu`, os gêmeos do
> céu e do terreno e a ferramenta de comparação) fica no código como está; as etapas 2 a 7 não serão feitas agora.
>
> Por quê:
> - O objetivo do momento é a cidade de ~200 mil prédios em PCs fracos e fortes (`ARQUITETURA.md`). O que impede isso é
>   memória e trabalho de mapa inteiro na página, não a API gráfica: o heap passa de 7 GB a 200 mil prédios com o
>   WebGL ou com o WebGPU.
> - O ganho que motivava a migração, esconder prédios atrás de prédios, é alcançado sem WebGPU: culling por oclusão na
>   CPU sobre o campo de alturas da cidade (`cameraSolids.ts`), testado no quadro atual.
> - Migrar 79 `onBeforeCompile`, 17 `ShaderMaterial` e 12 passes de pós para TSL, com comparação pixel a pixel de cada
>   um, é um projeto do tamanho do jogo; feito ao mesmo tempo que a mudança de arquitetura, as duas regressões se
>   misturariam e nenhuma das duas poderia ser provada.
> - Nada da arquitetura nova depende do WebGPU; o WebGL2 continua o único caminho do jogo.
>
> Quando a cidade grande estiver pronta e medida, a migração pode ser retomada da etapa 2 com o texto abaixo.

## Por que

Medido em 2026-10-21 (RTX 3060, 1920×1080, cidade grande, Electron):

- 60 fps estáveis com vsync em todas as vistas; sem limite, 72–90 fps. 120/144 Hz não é alcançado.
- A vista de perto gasta ~16 ms de GPU. A cena custa ~10,7 ms, e só cai para ~9,3 ms com um quarto dos pixels: o custo é geometria e chamadas de desenho, não pixels.
- O detalhe dos prédios já é escolhido por erro na tela (≤ 1 px; barras somem abaixo de 0,5 px). Engrossar o detalhe não paga: o governador de tempo desfez cada passo, por não render 10%.
- O mesmo quadro custa ~3 ms a menos de GPU no ANGLE/Vulkan do que no ANGLE/D3D11. Mas o Vulkan do ANGLE custa muito mais CPU, e o OpenGL engasga. Parte do custo é a tradução do WebGL, inalcançável pelo código do jogo.
- Esconder prédios atrás de prédios sem "pipocar" exige o culling em duas fases com Hi-Z: teste na GPU e desenho indireto. Isso não existe em WebGL2 (sem compute, sem desenho indireto); existe em WebGPU.

O WebGPU tira a camada de tradução do ANGLE e abre o culling por oclusão na GPU. Isso dá folga real para 120/144 Hz e para resoluções maiores.

## Tamanho

- 79 pontos de `onBeforeCompile` em 38 arquivos, com 209 referências a chunks GLSL (`#include <...>`). O `WebGPURenderer` do three não aceita nenhum deles: cada um vira material de nós (TSL).
- 17 `ShaderMaterial`/`RawShaderMaterial`.
- 12 passes de pós-processamento (GTAO, luz de cânion, nuvens, SMAA, bloom, nitidez, saída), que vão para o pós-processamento de nós.
- 9 arquivos que falam WebGL2 direto: `GpuBatchedMesh` (`GLBufferAttribute`), cópias de textura, consultas de tempo, os laboratórios.
- Código: ~200 mil linhas em `src/`.

## Regra da migração

A imagem nunca regride: cada material migrado é comparado lado a lado com o atual, na mesma vista e no mesmo instante (relógio e vento congelados), antes de substituir o antigo. Os dois renderizadores convivem até o fim. O WebGL fica como reserva para placas sem WebGPU.

## Etapas

1. **Fundação.** `WebGPURenderer` atrás de uma chave (`?gpu=webgpu` e configuração do desktop). Carregar a cena só com o que já funciona sem patch (céu, terreno simples). Ferramenta de comparação: as duas imagens da mesma vista e a diferença por pixel.
2. **Os materiais da cidade, um por um**, do que mais pesa ao que menos pesa, cada um em TSL com a comparação passando:
   - cascas dos prédios (`finishes.ts`, `shellParts.ts`, `kit.ts`, `facadeLevel`), com os acabamentos, a sujeira, as janelas acesas e o nível de longe;
   - peças dos prédios (`partCells`, `thinParts`, `glassRoom`);
   - vias (asfalto, calçadas, marcações) e o nível de longe;
   - terreno, água, vegetação (`wind.ts` vira nós), impostores;
   - pessoas (paletas de osso na GPU) e veículos;
   - sinais, postes e fios, mobiliário.
3. **Sombras.** As cascatas com depósito estático (`sunCascades.ts`): o depósito, a cópia e o desenho dos que se movem por cima, com os mesmos critérios de hoje.
4. **Pós-processamento** em nós: GTAO, luz de cânion, nuvens, SMAA, bloom, saída. Cada passe comparado.
5. **Lotes na GPU.** `GpuBatchedMesh` refeito sobre os buffers do WebGPU, com o desenho indireto (`drawIndirect`).
6. **Culling por oclusão em duas fases:**
   - desenhar o que foi visível no quadro anterior;
   - montar a pirâmide de profundidade (Hi-Z) num compute;
   - testar todas as instâncias e células no compute e desenhar as que apareceram, no mesmo quadro, sem pipocar.
7. **Medir e trocar o padrão.** Mesmas vistas, mesmas cidades (sementes 7 e 11), 60 e 144 Hz. O WebGPU vira o padrão onde existir.

## Riscos

- O `WebGPURenderer` do three ainda muda entre versões: fixar a versão e ler as notas de cada atualização.
- Electron: WebGPU no Chromium do Electron atual é estável no Windows (Dawn sobre D3D12), mas é preciso testar placas AMD e Intel.
- O tempo de compilação dos pipelines é diferente do WebGL: o catálogo de programas (`shaderCatalogue.ts`) precisa do equivalente para não travar a abertura.

## Etapa 1 — relatório (2026-10-21)

### O que foi feito

- **A chave.** `?gpu=webgpu` na URL, ou `"gpu": "webgpu"` em `desktop-settings.json` (o desktop põe a chave no endereço; `desktop:set` aceita `gpu`, vale na próxima abertura; numa execução do look, `"gpu": "webgpu"` no plano). Sem a chave, nada do WebGPU é baixado: `three.webgpu`/`three.tsl` ficam num pedaço próprio (`three-webgpu`, 686 kB) que só a chave ou uma comparação carregam. Sem WebGPU no navegador, ou se o dispositivo falhar, o jogo volta sozinho ao WebGL.
- **Como convivem.** Com a chave, o `WebGPURenderer` (three r186, `three/webgpu`) desenha no canvas da página; o `WebGLRenderer` continua fazendo tudo o mais (programas, envios, bakes, depósitos de sombra) num canvas próprio que ninguém vê. O código está em `src/render/gpu/`:
  - `backendChoice.ts` — a chave;
  - `compatibility.ts` — o que o WebGPU não desenha como está: material com `onBeforeCompile`, tipo sem equivalente de nós (`ShaderMaterial`), geometria com `GLBufferAttribute`, textura desenhada pelo WebGL, gancho `onBeforeRender`. Isso fica fora do quadro do WebGPU e vai para uma lista única em `console.warn`;
  - `twins.ts` — os gêmeos em TSL: o céu (fiel, linha por linha do GLSL) e o terreno (simples: as manchas posicionadas, lidas da textura de alturas e com morph exatamente como no WebGL; o acabamento é um verde só);
  - `webgpuView.ts` — o quadro WebGPU e a comparação.
- **A comparação.** `{"compare": "nome"}` no `scripts/look.mjs`, com `threshold` (8), `timingFrames` (20) e `faithfulOnly`. Ela segura o relógio da simulação e desenha a mesma vista nos dois renderizadores na mesma tarefa da página, sem um quadro do jogo no meio (o vento só anda dentro de um quadro). Cada renderizador desenha num alvo linear de meio-float, sem pós nem sombras, e as duas imagens passam pela mesma curva ACES e pelo mesmo sRGB (`imageCompare.ts`). A saída é `-webgl.png`, `-webgpu.png`, `-diff.png` mais: média, % de pixels acima do limiar, máximo, tempo de GPU de cada um (mediana) e o que foi desenhado como está, por gêmeo ou deixado de fora.

### Medido (RTX 3060, Electron, cidade grande semente 7, 1920×993)

| Vista | O que se compara | Média | % > 8 | GPU WebGL | GPU WebGPU |
| --- | --- | --- | --- | --- | --- |
| rua | tudo (terreno simples vs. terreno completo) | 23,4 | 99,9 | 1,4–16,9 ms | 0,72 ms |
| rua | só o que os dois desenham igual (`faithfulOnly`: 3 desenháveis) | 0,54 | 1,26 | 0,36–3,7 ms | 0,39–3,5 ms |
| distrito | tudo | 20,9 | 99,9 | 9,7–12,3 ms | 0,46 ms |

- **Já desenha igual:** os materiais do three sem patch (sombras de pessoas, placas, partes dos carros, rodas), em média 0,54 de 255. Os 1,26% de pixels acima do limiar ficam nas bordas finas dos postes e fios (sem MSAA nas duas imagens: o serrilhado cai em pixels diferentes) e nos carros, que andam. O céu fiel tem a mesma fórmula do GLSL e serve também de fonte da luz ambiente do WebGPU.
- **Tempo de GPU:** nessa vista simples, com o mesmo conteúdo, os dois ficam entre 0,4 e 3,7 ms de uma rodada para outra. A GPU estava dividida com outros processos da máquina (Playwright de outro projeto, servidores vite), então esse número **não decide nada**. Repetir com a máquina livre, conforme a regra de medição. As linhas "tudo" não comparam renderizadores: o WebGL desenha o terreno completo e o WebGPU o simples.
- **Sem a chave não muda nada:** com o mesmo plano e a mesma vista de rua, o build novo e o anterior (`a73dab5a`) deram 245 programas nos dois, 408/413 desenhos e 9,90/9,90 M triângulos. A diferença de imagem é ruído espalhado (média 0,95), mais os carros, que estavam em outros lugares (7 contra 10 veículos no HUD: a simulação andou diferente). O chunk `three` padrão cresceu 5,6 kB (exportações para o pedaço WebGPU).

### O que falta (lista que o próprio jogo imprime com a chave, cidade grande)

- `onBeforeCompile` em ~830 desenháveis: prédios (casca, lote, laje, parapeito…), vias, vegetação, floresta e mundo de longe, água, sinais. É a etapa 2.
- `onBeforeRender` em ~230: os lotes das cascas (`shellBatch`) e as árvores com níveis. Os ganchos chamam o WebGL direto, e nos lotes isso vem junto com o `GpuBatchedMesh` (etapa 5).
- `ShaderMaterial` (fumaça do escapamento), `MeshPhysicalMaterial` com patch (vidros).
- Terreno: o acabamento (splat, pintura, água, lotes), para o gêmeo simples virar fiel.
- Sombras (etapa 3) e pós-processamento (etapa 4): o quadro WebGPU sai sem nenhum dos dois.
- Limitações do three r186 já contornadas: (1) uma `InstancedMesh` que ganha buffers maiores (`agents.ts` growPart) precisa receber `dispose` no lado WebGPU, senão o three desenha além do fim do buffer antigo; (2) `readRenderTargetPixelsAsync` devolve linhas alinhadas a 256 bytes. Aviso ainda em aberto: `CopyExternalImageToTexture` falha em 2 imagens que o jogo já liberou depois de enviá-las ao WebGL (textura vazia no WebGPU).
