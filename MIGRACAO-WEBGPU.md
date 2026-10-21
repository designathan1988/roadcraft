# Migração do renderizador para WebGPU

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
