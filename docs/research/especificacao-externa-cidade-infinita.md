# Especificação externa "motor de cidade infinita" (referência, não regra)

Origem: documento colado pelo jogador em 2026-10-14 ("Master Technical Design Document" de
um simulador de cidade infinita em three.js e Vanilla JS, 12 módulos, com um bloco pronto para
virar `CLAUDE.md`). Analisado contra o Roadcraft 2 no mesmo dia.

**Status: só referência.** Não vira `CLAUDE.md` nem `ARCHITECTURE.md`. Ele foi escrito para um
projeto novo em Vanilla JS e várias regras "obrigatórias" dele contrariam as ordens do jogador
(`memory/ORDENS.md`), o código e o three r186 do jogo. Quem manda é o plano em vigor
(`docs/PLANO-ESPINHA-2026-10-14.md`) e a pesquisa do projeto (`docs/PESQUISA-CIDADE-10KM.md`),
que já cobre quase tudo o que ele propõe, com fontes.

## Fontes lidas
- MDN, *SharedArrayBuffer*, seção "Security requirements" —
  https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/SharedArrayBuffer
  Memória compartilhada exige contexto seguro e página com isolamento entre origens
  (`crossOriginIsolated`); sem isso o `postMessage()` lança erro para o `SharedArrayBuffer`; a
  sincronização é por `Atomics`.
- MDN, *Window.crossOriginIsolated* —
  https://developer.mozilla.org/en-US/docs/Web/API/Window/crossOriginIsolated
  Os cabeçalhos são `Cross-Origin-Opener-Policy: same-origin` e
  `Cross-Origin-Embedder-Policy: require-corp` (ou `credentialless`).
- Vite, *Server Options* — https://vite.dev/config/server-options
  `server.headers`: "Specify server response headers". Hoje `vite.config.ts:43` só envia
  `Document-Policy`.
- three.js, *Migration Guide* — https://github.com/mrdoob/three.js/wiki/Migration-Guide
  r181→r182: "`PCFSoftShadowMap` with `WebGLRenderer` is now deprecated. Use `PCFShadowMap`
  which is now soft as well." r185→r186: removido também no `WebGPURenderer`. No fonte r186,
  `WebGLShadowMap.js:101` avisa "has been removed" e usa `PCFShadowMap`.
- three.js, *BatchedMesh* — https://threejs.org/docs/pages/BatchedMesh.html — e o fonte r186
  `src/objects/BatchedMesh.js:393`: `_initializeGeometry` aloca na CPU arrays com toda a
  capacidade (`maxVertexCount * itemSize`).
- three.js, manual r186, *How to update things* (cópia oficial local:
  `C:/Codex-Shared/referencia/threejs/repo-r186/manual/pages/how-to-update-things.html:64-71`; o
  site deu 404): buffers não mudam de tamanho; reserva-se antes e desenha-se com `setDrawRange`;
  "no way to create a BufferGeometry that can efficiently be extended indefinitely".
- three.js, *BufferAttribute* — https://threejs.org/docs/pages/BufferAttribute.html —
  `addUpdateRange` ("a range of data in the data array to be updated on the GPU"), `onUpload`
  (limpar o lado da CPU depois de subir).
- InstancedMesh2 (projeto maduro, `C:/Codex-Shared/referencia/instanced-mesh`):
  `src/core/feature/Capacity.ts:94-100` cresce 1,5× + 512 e copia; `SquareDataTexture.resize`
  faz `dispose()` só do buffer velho.
- No fonte r186, `src/textures/Texture.js:442`: `Texture.addUpdateRange`; e
  `WebGLTextures.js:886`: o próprio three faz `texSubImage2D` só das faixas pedidas.

## Onde ele conflita (conferido no código, 2026-10-14)

| O documento manda | O projeto |
|---|---|
| Simulação em fatias de 1/16 dos lotes por tick (Mód. 9.1) | Amortização, proibida pelo jogador (`CLAUDE.md`, "NÃO amortizar") |
| `BatchedMesh` obrigatório, um por chunk | Retirado de propósito: capacidade inteira guardada na CPU, 1,1 GB de heap (`render/buildings/buildingMesh.ts:3629-3632`) |
| Z-fighting resolvido mexendo em `camera.near` conforme a altura | Profundidade invertida em buffer float (`render/renderer.ts:477`, `render/depthConvention.ts`); `render/CLAUDE.md`: pisca à distância nunca se corrige empurrando o near |
| `PCFSoftShadowMap` | Removido no r186; o jogo usa `PCFShadowMap` (`render/renderer.ts:504-508`) |
| `texSubImage2D` à mão, lendo `renderer.properties` | `Texture.addUpdateRange` do r186, já usado (`render/people/crowdBodies.ts:80`) |
| Proibido `SkinnedMesh`; pedestres só por VAT | Corpos MakeHuman com esqueleto desenhado na GPU (`render/people/crowdAnimation.ts`); trocar por VAT pode perder qualidade, o que só se faz com o sim do jogador |
| Buffers de tamanho fixo (16.384 vértices por chunk, 65.536 prédios) | Os números são tetos e contrariam a cidade sem limite. O PRINCÍPIO por trás deles vale: não destruir com `dispose()` nem recriar a geometria a cada edição ou passo da câmera. Ele entra sem teto nos itens 3 e 6 abaixo |
| Nunca `dispose()` depois do `init` | No three é impossível ao pé da letra: um buffer não muda de tamanho (manual r186, "How to update things"; `WebGLAttributes.js:214` lança erro), então crescer custa um `dispose()` do buffer velho. O certo é esse `dispose()` acontecer poucas vezes (crescimento geométrico), não em cada edição |
| Meta de menos de 150 draw calls | O jogador proíbe meta de número; a pesquisa (§8.6) é só referência |
| Código em Vanilla JS | TypeScript |

## O que já aparece no código
Vi a linha, mas não segui o chamador até o quadro. Pela regra do projeto, isso ainda não prova
que funciona.
- IDM e o índice do carro da frente: `sim/vehicles/idm.ts`, `sim/vehicles/leaderIndex.ts`
  (`sim/drive/operational.ts:9` diz que o modelo atual já foi além do IDM puro).
- Interior mapping nas janelas: `render/buildings/glassRoom.ts:108`, `roomBehind.ts`,
  `massingMaterial.ts`.
- Esmaecimento por pontilhado de Bayer 4×4: `render/wind.ts:118-130`.
- Sombra presa aos texels do chão: `GroundShadowGrid` em `render/environment.ts`.
- Terreno com níveis aninhados de clipmap: `render/terrainRelief.ts:44`; camadas em
  `DataArrayTexture`: `render/terrain.ts:849`.
- Salvamento no IndexedDB em partes: `editor/chunkedSave.ts`, `editor/persistence.ts`.
- Nenhum `intersectObjects`: o `Raycaster` só monta o raio da câmera
  (`render/isoViewport.ts:447`), como o documento pede.

## O que se aproveita, e em que etapa
1. **Mundo sem borda** (depois do mapa de 10 km). Hoje o mapa é fixo: 5 × 5 placas de 2.048 m
   (`world/bounds.ts:23-27`). Do documento servem a grade de slots reciclados com índice por
   módulo positivo, `((c % N) + N) % N`, e a base gerada pela semente com só as alterações do
   jogador guardadas (combina com a etapa 2 do `docs/CIDADE-10KM.md`). A chave fica no Morton
   numérico de `world/cells.ts`, sem `BigInt`.
2. **Simulação em worker** com `SharedArrayBuffer` e buffer duplo interpolado na página
   (Mód. 6.3). Hoje não há nenhum `SharedArrayBuffer`, e o passo da simulação está na thread
   principal (28,4% do perfil do plano). Bate com a §8.5 da pesquisa. Exige os cabeçalhos COOP e
   COEP no Vite (`server.headers` e o preview) e no Electron, e conferir que nenhum recurso de
   outra origem quebra com `require-corp`. Ponto de partida guardado: ramo `af5ce5d` (tickInput,
   lockstep), em `memory/ESTADO.md`.
3. **Tabelas em arrays tipados por campo (SoA), paginadas e sem teto** para prédios e agentes
   (Mód. 1.1). Bate com a §8.4 da pesquisa; hoje o heap gasta 110 a 150 KB por prédio
   (`docs/CIDADE-10KM.md`). Forma (pedido do jogador, 2026-10-14):
   - cada campo é uma lista de páginas de tamanho fixo (por exemplo 4.096 índices); o item `id`
     mora em `page = id >>> 12`, `offset = id & 4095`;
   - a cidade cresce acrescentando páginas quando precisa; as páginas antigas nunca são
     realocadas nem copiadas, então não há teto nem cópia ao crescer;
   - ids apagados voltam por uma lista de livres, para as páginas não ficarem furadas;
   - cada página é um `ArrayBuffer` que vai inteiro, em binário, para o salvamento do item 4.
4. **Salvamento binário** no lugar do texto JSON (Mód. 11.3). Os registros em texto somam 66 MB
   na cidade de 5.400 prédios (`docs/CIDADE-10KM.md:19`). Bate com a §8.7 da pesquisa.
5. Menores, a conferir contra o que existe antes de mexer: mapa de calor por uma textura de dados
   no material (Mód. 9.3), interface atualizada fora do `requestAnimationFrame` (Mód. 11.2),
   vetores temporários do módulo reaproveitados no caminho quente (Mód. 1.2, só no quadro e no
   ponteiro, não como proibição geral de `map`/`filter`).
6. **Buffers elásticos e células recicladas, sem `dispose()` a cada edição e sem teto**
   (`src/render`; pedido do jogador, 2026-10-14):
   - cada buffer de célula tem uma capacidade e um número de itens em uso. Enquanto a mudança
     couber (prédio construído ou demolido, via editada), escreve-se no lugar e sobe só o trecho
     mudado: `geometry.setDrawRange(0, emUso)` e `attribute.addUpdateRange(início, quantos)`
     (documentação do `BufferAttribute`; `BufferAttribute.js:181`). Para textura, a chamada é
     `Texture.addUpdateRange`, a que `render/people/crowdBodies.ts:80` usa;
   - quando não couber, a capacidade cresce geometricamente, sem limite superior: buffer novo
     maior, conteúdo copiado e um `dispose()` do velho. É o que o InstancedMesh2 faz
     (`referencia/instanced-mesh/src/core/feature/Capacity.ts:94-100`: 1,5× + 512;
     `SquareDataTexture.resize`). O número de crescimentos é logarítmico no tamanho;
   - célula que sai do alcance não sofre `dispose()`: o `Mesh` e a `BufferGeometry` vão para um
     pool e são reaproveitados no lugar pela próxima célula que entra, se a capacidade servir. O
     pool é do tamanho do conjunto visível, não um cache que expulsa e refaz (`CLAUDE.md`);
   - apagar no meio usa troca com o último (swap-and-pop), e a faixa de desenho encurta;
   - **custo a decidir antes de implementar:** o three sobe o trecho a partir de
     `attribute.array` (`WebGLAttributes.js:212` exige o array do mesmo tamanho), então o buffer
     elástico mantém na CPU uma cópia inteira do que está na GPU. Isso contraria a regra "o que
     vai à GPU não fica copiado na CPU": hoje as cascas soltam os arrays no `onUpload`
     (`render/buildings/buildingMesh.ts`), justamente pelo heap. As saídas são: (a) manter o
     espelho só nas células que o jogador edita, deixando as outras sem cópia; ou (b) escrever o
     trecho direto com `gl.bufferSubData` sobre o buffer do three, fora da API pública (frágil a
     cada versão). Ainda não há escolha.
