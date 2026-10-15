# Relatório Técnico Integral de Auditoria de Desempenho e Otimização
**Projeto:** Roadcraft 2 (`c:\Codex-Shared\roadcraft-2`)  
**Data:** 15 de Outubro de 2026  
**Escopo da Análise:** Inspeção integral e estrita (sem alteração de arquivos) da base de código TypeScript, three.js r186, Vite, simulação física e pipeline gráfico.  
**Regra Fundamental:** Preservação estrita da fidelidade visual (sem corte de distância, resolução, sombras ou qualidade) e eliminação definitiva das causas de degradação algorítmica, sem amortizações superficiais.

---

## 1. Sumário Executivo e Diagnóstico de Estado

A auditoria completa de `src/` (511 arquivos TypeScript, ~170.000 linhas) e das ferramentas diagnósticas (`scripts/acusar.mjs`, `scripts/look.mjs`, `OTIMIZACAO.md`, `CLAUDE.md` e medições em GPU integrada e dedicada) revelou que o motor central de dados (`core/engine.ts`, diário de mudanças `world/changes.ts`) já resolveu com sucesso os piores gargalos de reatividade global identificados no passado.

Contudo, a meta do projeto — suportar **cidades de qualquer tamanho em hardware variado, rumo ao mapa sem limite (10 km × 10 km e além)** — encontra hoje barreiras bem definidas em quatro grandes pilares:

```
┌────────────────────────────────────────────────────────────────────────┐
│                   GARGALOS CRÍTICOS IDENTIFICADOS                      │
├─────────────────────┬───────────────────┬──────────────┬───────────────┤
│    GPU & VRAM       │  CPU & Simulação  │ Heap JS &    │   Streaming   │
│   (Render Targets,  │  (Thread Princ.,  │ Geometria    │   & Terreno   │
│    MSAA 8x, Cascas) │   Passo de 13ms)  │ Presa (188MB)│   (Re-envios) │
└─────────────────────┴───────────────────┴──────────────┴───────────────┘
```

1. **Memória de Vídeo Oculta (~640 MB invisíveis no contador):** Alvos de pós-processamento multisampled (MSAA 8x em HalfFloat + Depth32F) e Shadow Maps de 4096² RGBA8 não são rastreados pelo contador de memória da cena, estourando silenciosamente os orçamentos de placas intermediárias.
2. **Explosão de Geometria em Prédios L0 (794,6 MB na rua contra 300 MB de orçamento):** A residência do nível de detalhe (L0) na GPU é regida por distância física estática (2× o alcance da câmera) e não por orçamento de bytes (`byte budget`). Ao mesmo tempo, quando uma célula é descarregada, seus arrays são completamente descartados (`slim`), tornando o seu retorno custoso (~7 ms por prédio).
3. **Simulação Monolítica na Thread Principal (13,7 ms de CPU / quadro):** A integração da física e dos agentes de trânsito compete diretamente com a renderização WebGL. Passado o teto de 8 ms (`SIM_FRAME_BUDGET_MS`), a simulação desacelera ou o governador de população descarta cidadãos e veículos (amortização de custo).
4. **Geometria Presa na CPU (188 MB no Heap) e Formato de Vértice Ineficiente:** Os ladrilhos das vias (`roadSurfaces.ts`) retêm cópias brutas de 56 bytes por vértice no Heap para permitir recomposições futuras.
5. **Re-envio Integral de Buffers de Terreno (`needsUpdate` sem faixa):** A escultura e modificação do relevo não utilizam `addUpdateRange`, forçando uploads de até 5,35 MB por placa a cada clique.

---

## 2. Mapa Completo de Problemas Identificados

### 2.1 Pipeline Gráfico, GPU e Shaders

#### Problema 1: Alvos de Renderização com MSAA 8x e Sombra Ocultos da Telemetria
- **Arquivo / Linha:** [`src/render/postprocess.ts:163-179`](file:///C:/Codex-Shared/roadcraft-2/src/render/postprocess.ts#L163-L179), [`src/render/quality.ts:131`](file:///C:/Codex-Shared/roadcraft-2/src/render/quality.ts#L131), [`src/core/perfBudget.ts:196`](file:///C:/Codex-Shared/roadcraft-2/src/core/perfBudget.ts#L196).
- **Causa Raiz:** O contador de memória (`memoryCounters.ts:32`) percorre a hierarquia da cena (`root.traverse`). Alvos de renderização (`WebGLRenderTarget`) do pós-processamento e mapas de sombra do `WebGLShadowMap` não residem na árvore da cena. Em resolução de 1920×1080 com pixel ratio 1.5 (2880×1620):
  - `sceneTarget` (HalfFloatType RGBA16F com 8 samples): $2880 \times 1620 \times 8 \times 8\text{ B} \approx 298{,}6\text{ MB}$.
  - Textura de profundidade float 32F com 8 samples: $2880 \times 1620 \times 4 \times 8\text{ B} \approx 149{,}3\text{ MB}$.
  - Texturas resolvidas adicionais: $\approx 56\text{ MB}$.
  - Mapa de sombra 4096² (alocado incondicionalmente pelo three.js com cor RGBA8 inútil + profundidade): $\approx 134{,}2\text{ MB}$.
  - **Impacto Total:** $\approx 638\text{ MB}$ de VRAM invisível. A linha correspondente em `perfBudget.ts` reporta "não medido".

#### Problema 2: Falta de Residência por Orçamento de Bytes nos Prédios (L0)
- **Arquivo / Linha:** [`src/render/buildings/layer.ts:656-667`](file:///C:/Codex-Shared/roadcraft-2/src/render/buildings/layer.ts#L656-L667), [`src/render/buildings/massCells.ts:130-170`](file:///C:/Codex-Shared/roadcraft-2/src/render/buildings/massCells.ts#L130-L170).
- **Causa Raiz:** O descarte de células de detalhe ocorre apenas por distância euclidiana (`Math.hypot(cx - eyeX, cy - eyeY) > keep`, onde `keep = reach * 2`). Conforme a câmera passeia pela cidade, a VRAM de cascas atinge 794,6 MB (orçamento máximo: 300 MB). Além disso, a função `dropCell` descarta geometrias e malhas sem preservar os buffers pré-montados, exigindo que o worker ou a thread principal re-emita o prédio do zero (~7 ms de CPU).

#### Problema 3: Índices Uint32 Incondicionais e Atributos Mortos em Vértices
- **Arquivo / Linha:** [`src/render/buildings/cellArrays.ts:128, 182`](file:///C:/Codex-Shared/roadcraft-2/src/render/buildings/cellArrays.ts#L128-L182), [`src/render/mesh/surfaceMesh.ts:400-407`](file:///C:/Codex-Shared/roadcraft-2/src/render/mesh/surfaceMesh.ts#L400-L407).
- **Causa Raiz:**
  - Em `cellArrays.ts`, `new Uint32Array(indices)` é instanciado mesmo quando o total de vértices é $< 65.535$. Em células de 240 m, Uint16 caberia com folga, desperdiçando 50% da largura de banda e memória de índices (redução de 24 B/vert para 12 B/vert em índices).
  - Em `surfaceMesh.ts`, os atributos `color` (12 bytes) e `roadSection` (12 bytes) são adicionados incondicionalmente a todas as malhas de superfície viária, inclusive para faixas de terra/grama lateral (*verge*), cujo shader (`terrain.ts:1000-1014`) sequer lê essas propriedades nem declara `vertexColors: true`.

#### Problema 4: Geometria Não-Indexada em Estruturas e Veículos
- **Arquivo / Linha:** [`src/render/structures.ts:413-420`](file:///C:/Codex-Shared/roadcraft-2/src/render/structures.ts#L413-L420), [`src/render/vehicleModels.ts:298`](file:///C:/Codex-Shared/roadcraft-2/src/render/vehicleModels.ts#L298).
- **Causa Raiz:**
  - Em `structures.ts`, parapeitos, muros de contenção e portais empurram 6 vértices por quad via `this.positions.push(...)` sem índice (duplicação de vértices). Um trecho de corte viário de 200 m gera ~12.000 vértices redundantes.
  - Em `vehicleModels.ts`, o método `merge` converte malhas indexadas para triângulos soltos via `g.toNonIndexed()`, triplicando a contagem de vértices dos carros na CPU e GPU.

#### Problema 5: Edifícios de Assinatura (Landmarks) Sem HLOD / Nível de Longe
- **Arquivo / Linha:** [`src/render/buildings/massing.ts:157`](file:///C:/Codex-Shared/roadcraft-2/src/render/buildings/massing.ts#L157), [`src/render/buildings/townIndex.ts:80-107`](file:///C:/Codex-Shared/roadcraft-2/src/render/buildings/townIndex.ts#L80-L107).
- **Causa Raiz:** Prédios com flag `signature` têm sua emissão de massa simplificada ignorada (`if (floor !== undefined && !signature)`). Eles são instanciados como corpos únicos de alta contagem poligonal (~30.000 triângulos cada) e permanecem desenhados integralmente mesmo na vista geral do mapa de 10 km (~900.000 triângulos desenhados sem benefício perceptivo).

#### Problema 6: Overdraw do Céu e Desperdício de Fragmentos
- **Arquivo / Linha:** [`src/render/environment.ts:350-359`](file:///C:/Codex-Shared/roadcraft-2/src/render/environment.ts#L350-L359).
- **Causa Raiz:** A cúpula do céu é configurada com `renderOrder: -1000` e `depthTest: false`. Isso força o rasterizador a colorir a tela inteira com o céu no início do frame, para depois ter quase 100% dos pixels sobrepostos por terreno, vias e prédios opacos. Configurar o céu para desenhar após os objetos opacos com `depthTest: true` aproveitaria o teste de profundidade antecipado (Early-Z) da GPU, descartando milhões de operações de fragmentos.

#### Problema 7: Desperdício de Passes no GTAOPass
- **Arquivo / Linha:** [`src/render/postprocess.ts:262, 287`](file:///C:/Codex-Shared/roadcraft-2/src/render/postprocess.ts#L262-L287).
- **Causa Raiz:** O `GTAOPass` do three.js aloca um buffer de normais redundante (`normalRenderTarget`) que é posteriormente desligado via `setGBuffer(depth)`. Além disso, a etapa final de aplicação da oclusão ambiental custa 2 passes de resolução total na tela, quando poderia ser aplicada multiplicativamente no passe de grade/canyon.

---

### 2.2 CPU, Simulação e Laço Principal

#### Problema 8: Simulação Física e de Agentes na Thread Principal
- **Arquivo / Linha:** [`src/sim/pipeline.ts:58`](file:///C:/Codex-Shared/roadcraft-2/src/sim/pipeline.ts#L58), [`src/main.ts:2791`](file:///C:/Codex-Shared/roadcraft-2/src/main.ts#L2791), [`src/sim/clock.ts:60-86`](file:///C:/Codex-Shared/roadcraft-2/src/sim/clock.ts#L60-L86), [`src/sim/populationGovernor.ts:36`](file:///C:/Codex-Shared/roadcraft-2/src/sim/populationGovernor.ts#L36).
- **Causa Raiz:** A simulação roda síncrona na thread principal dentro de um orçamento rígido de 8 ms (`SIM_FRAME_BUDGET_MS`). Numa cidade com tráfego denso, os passos custam 9-13 ms. Quando o tempo estoura, `clock.advance` aborta o passo subsequente (desacelerando a taxa de simulação) e o `populationGovernor` começa a eliminar pedestres e veículos da cidade. Essa é uma clássica amortização de sintomas: o custo real é transferir a integração de corpos para um Web Worker isolado com comunicação via `SharedArrayBuffer` / Transferable Arrays.

#### Problema 9: Alocações Contínuas por Quadro nos Agentes e Ragdolls
- **Arquivo / Linha:** [`src/sim/pose.ts:261-267`](file:///C:/Codex-Shared/roadcraft-2/src/sim/pose.ts#L261-L267), [`src/render/ragdoll.ts:2011-2034`](file:///C:/Codex-Shared/roadcraft-2/src/render/ragdoll.ts#L2011-L2034), [`src/render/playEffects.ts:307-313`](file:///C:/Codex-Shared/roadcraft-2/src/render/playEffects.ts#L307-L313).
- **Causa Raiz:**
  - `pedPose` aloca `{ x, y }`, `{ x, y }` e o objeto de retorno `{ p, angle }` para até 1.000 pedestres todo quadro (~3.000 a 4.000 objetos temporários gerando pressão de GC). O sistema de veículos já eliminou esse problema usando `vehiclePoseInto`.
  - Em `ragdoll.ts`, para cada corpo em física ativa são alocadas matrizes `new Matrix4().compose(...)`, `new Quaternion()` e arrays `new Float32Array(bones * 16)` dentro do laço de animação esqueletal na CPU.
  - Em `playEffects.ts:307-313`, a função `wallsNear` realiza `[...(ragdollSim?.vehicles.values() ?? [])].map(...)` varrendo **toda a frota de veículos da cidade** (700-1200 veículos) para cada corpo que cai, calculando poses e caixas envolventes em vez de consultar a grade espacial (`SpatialGrid` / `solidsOf`).

---

### 2.3 Terreno, Geometria em Memória e Dados

#### Problema 10: Retenção Integral da Geometria Viária na CPU (188 MB no Heap)
- **Arquivo / Linha:** [`src/render/roadSurfaces.ts:146, 161`](file:///C:/Codex-Shared/roadcraft-2/src/render/roadSurfaces.ts#L146-L161).
- **Causa Raiz:** O objeto `SurfaceReuse` mantém em mapas JavaScript (`tiles` e `chunks`) todos os vértices e triângulos de todas as vias já montadas com precisão Float32 total (56 bytes/vert). Como o Three.js envia os dados para a GPU, manter os dados expandidos na CPU dobra o consumo de RAM. A solução é adotar quantização de vértices (`vertex codec` / meshoptimizer): Int16 relativo à caixa do bloco, normal octaédrica e cor compactada (reduzindo de 56 B para ~14 B por vértice).

#### Problema 11: Re-envio Integral de Atributos do Terreno sem `addUpdateRange`
- **Arquivo / Linha:** [`src/render/terrain.ts:2386, 2444, 2492-2493, 3096`](file:///C:/Codex-Shared/roadcraft-2/src/render/terrain.ts#L2386-L2493).
- **Causa Raiz:** Ao editar o terreno com pincel ou adaptar às vias (`shapeToRoads`), as posições, normais e atributo steep são marcados com `attribute.needsUpdate = true` sem definir `addUpdateRange(offset, count)`. Uma placa de 321×321 vértices possui 1,24 MB de posições, 1,24 MB de normais, 0,41 MB de steep e 2,46 MB de índices ($5{,}35\text{ MB}$ por placa). Um dab de pincel que toca 50 vértices força o upload de mais de 5 MB de dados pela barreira PCIe.

#### Problema 12: Cache de Placas do Terreno com Teto Fixo que Expulsa e Reconstrói
- **Arquivo / Linha:** [`src/render/flatAtlas.ts:40, 311-314`](file:///C:/Codex-Shared/roadcraft-2/src/render/flatAtlas.ts#L40-L314).
- **Causa Raiz:** `const CACHE = 6` limita o número de placas retidas. Quando o jogador viaja pelo mapa, as placas mais antigas sofrem `letGo()`, que descarta a malha E zera os dados de alturas `p.heights = null`. Quando a câmera retorna, o jogo é obrigado a reenviar requisições pesadas aos workers, reconstruindo normais, relevo e ecologia (~35 ms de travamento por placa).

#### Problema 13: Comparações Ineficientes por `JSON.stringify` no Documento
- **Arquivo / Linha:** [`src/world/doc.ts:2021-2086`](file:///C:/Codex-Shared/roadcraft-2/src/world/doc.ts#L2021-L2086).
- **Causa Raiz:** A sincronização `replaceContents` realiza dezenas de chamadas como `JSON.stringify(this.people) !== JSON.stringify(source.people)`. Serializar coleções inteiras com centenas de itens a cada edição gera strings gigantescas no V8, ativando coletas de lixo dispendiosas.

#### Problema 14: Texturas PNG 2048² Não Comprimidas para GPU
- **Arquivo / Linha:** `public/textures/*.png` e [`src/render/elements.ts`](file:///C:/Codex-Shared/roadcraft-2/src/render/elements.ts).
- **Causa Raiz:** Texturas como `Leaves.png` e `Rocks_Diffuse.png` são entregues como PNGs brutos de 2048×2048. Ao serem decodificadas na GPU pelo WebGL, ocupam ~21 MB de VRAM cada em RGBA8 descompactado. A conversão para KTX2 (Basis Universal / BC7 / ASTC) reduz o consumo de vídeo em ~60% a 70% com fidelidade idêntica.

---

## 3. Arquitetura da Solução Completa

Abaixo apresenta-se o plano detalhado de correção de cada componente afetado.

```
┌────────────────────────────────────────────────────────────────────────────┐
│                    ARQUITETURA DE SOLUÇÃO INTEGRAL                        │
├────────────────────────────────────────────────────────────────────────────┤
│                                                                            │
│  [ WebGL / Render Pipeline ]                                               │
│    ├── PostProcess: Amostras MSAA dinâmicas (4x High, 8x Ultra)            │
│    ├── ShadowMap: 2048x2048 com depth puro (elimina 100MB VRAM)            │
│    ├── Telemetria: Monitorar RenderTargets em memoryCounters.ts            │
│    ├── Céu: RenderOrder 999 + DepthTest True (Early-Z culling)             │
│    └── GTAO: Alvo ocioso removido + passe único fundido                    │
│                                                                            │
│  [ Geometria & Streaming ]                                                 │
│    ├── Prédios L0: Residência por Bytes (limite estrito de 300MB)          │
│    ├── Worker de Célula: Retorna Célula Montada com transfer de arrays     │
│    ├── Landmarks: Adicionar LOD de massa para assinaturas                  │
│    ├── Índices: Uint16Array dinâmico quando vértices <= 65535              │
│    └── Vértice Enxuto: Quantização Int16 das vias na CPU (56B -> 14B)      │
│                                                                            │
│  [ CPU & Simulação Física ]                                                │
│    ├── SimWorld Worker: Desacoplamento da thread de renderização           │
│    │     └── Poses compartilhadas via SharedArrayBuffer                    │
│    ├── Pedestres: pedPoseInto(p, alpha, out) zero-allocation               │
│    ├── Ragdolls: Buffers estáticos SoA (elimina alocações Matrix4)         │
│    └── Colisão de Efeitos: Consulta espacial em solidsOf.near              │
│                                                                            │
│  [ Terreno & Dados ]                                                       │
│    ├── Terrain Buffers: addUpdateRange em todas as pinceladas              │
│    ├── Plate Cache: Manter PlateMesh na CPU ao descarregar VRAM            │
│    └── Documento: Comparação por versão/revisão em vez de JSON.stringify   │
│                                                                            │
└────────────────────────────────────────────────────────────────────────────┘
```

---

### 3.1 Correção do Pipeline de Renderização e VRAM

#### A. Telemetria e Dimensionamento de RenderTargets
1. **Medir Alvos Invisíveis:** Expandir `memoryCounters.ts` para receber a referência do `EffectComposer` e da `DirectionalLight`, calculando a VRAM exata dos alvos:
   $$\text{Bytes} = \text{largura} \times \text{altura} \times \text{bytesPorPixel} \times \text{amostras}$$
2. **Configuração de Qualidade de MSAA e Sombras:**
   - No perfil `high`, fixar MSAA em 4 amostras (redução de 224 MB em `sceneTarget`).
   - Reduzir `shadowMapSize` de 4096 para 2048 no perfil `high` (economia de ~100 MB). Manter 4096 restrito ao perfil `ultra`.
3. **Inversão da Ordem do Céu (Early-Z):**
   - Alterar `sky.renderOrder = 999` e `skyMaterial.depthTest = true`, `skyMaterial.depthWrite = false`.
   - O hardware gráfico executará o Z-Cull antecipado, descartando a renderização de pixels do céu que já contenham geometria de solo ou edifícios.

#### B. Otimização do GTAOPass
- Instanciar `GTAOPass` fornecendo `depthTexture` diretamente nos parâmetros de construção.
- Eliminar a alocação do `normalRenderTarget` desnecessário e direcionar o resultado do denoise diretamente como máscara multiplicativa no passe de color grading (`EffectPass`).

---

### 3.2 Correção da Geometria e Streaming de Prédios

#### A. Residência de Detalhes (L0) por Orçamento de Bytes
- Substituir a política geométrica de raio estático em `layer.ts` por um acumulador de bytes:
  - Ordenar as células visíveis por prioridade (distância à câmera e erro de tela).
  - Admitir células no buffer de detalhe da GPU apenas enquanto $\sum \text{bytes} \le \text{ORÇAMENTO\_CASCA\_VRAM}$ (300 MB).
  - Células excedentes exibem o nível de massa (`massCells`), que já é extremamente leve e esteticamente harmonizado.

#### B. Retorno Eficiente via Worker de Célula Completa
- Em vez de enviar chunks isolados por prédio (o que sobrecarrega a desserialização IPC), o worker de células deve receber o lote da célula, combinar as cascas e peças no worker (`combineGeometry`) e devolver os `ArrayBuffer` montados via transferência de posse (`Transferable Objects`, custo zero de cópia na thread principal).
- A thread principal apenas instancia `BufferAttribute` diretamente sobre o buffer transferido e realiza o upload para a GPU.

#### C. Índices Uint16 e Supressão de Atributos Mortos
- Em `cellArrays.ts`, adotar a lógica já validada em `surfaceTiles.ts`:
  ```ts
  const index = vertices > 0xffff ? new Uint32Array(indices) : new Uint16Array(indices);
  ```
- Em `surfaceMesh.ts`, condicionar a inclusão dos atributos `color` e `roadSection`:
  - Se o material associado não requisita cor por vértice nem seção (caso da faixa de *verge* do terreno), não criar os atributos de 24 B/vert.

#### D. Indexação de Estruturas e Veículos
- Em `structures.ts`, refatorar o método `push` para emitir 4 vértices e 6 índices por quad:
  ```ts
  // pa, pb, pc, pd (4 vértices) + [0, 1, 2, 0, 2, 3] (6 índices Uint16)
  ```
- Em `vehicleModels.ts`, remover `toNonIndexed()` e aplicar `mergeVertices(merged, 1e-4)` preservando a indexação e unificando vértices coincidentes.

---

### 3.3 Simulação Física Desacoplada e Otimizações de CPU

#### A. Transição da Simulação para Web Worker (SharedArrayBuffer)
1. **Configuração de Ambiente:** Configurar no Vite (`vite.config.ts`) e no Electron (`desktop/main.cjs`):
   ```
   Cross-Origin-Opener-Policy: same-origin
   Cross-Origin-Embedder-Policy: require-corp
   ```
2. **Arquitetura de Dados Compartilhados:**
   - Criar um `SharedArrayBuffer` contendo blocos contíguos para poses de veículos (`x, y, z, angle, speed`) e pedestres (`x, y, z, angle, animFrame`).
   - O worker de simulação atualiza as poses a 60 Hz fixos utilizando atomics/double-buffering.
   - A thread principal consome os buffers em modo somente leitura durante o método `render()`, interpolando via $\alpha$ entre os estados anterior e atual.
   - Isso libera imediatamente ~14 ms de CPU na thread principal.

#### B. Eliminação de Alocações por Quadro (Zero-Allocation Loop)
- **Pedestres:** Implementar `pedPoseInto(p: PedView, alpha: number, out: PoseOut): void` em `src/sim/pose.ts` espelhando a implementação de `vehiclePoseInto`.
- **Ragdolls:** Pré-alocar pools estáticos de matrizes `Matrix4` e texturas de palheta por corpo em `ragdoll.ts`. Atualizar os valores no array existente em vez de instanciar novos objetos a cada subpasso.
- **Efeitos de Colisão:** Em `playEffects.ts`, substituir a iteração linear sobre toda a frota por uma consulta espacial restrita ao raio de alcance:
  ```ts
  const nearbyVehicles = ragdollSim.spatialGrid.queryRadius(x, y, reach);
  ```

---

### 3.4 Terreno, Texturas e Dados

#### A. Uso Obrigatório de `addUpdateRange` no Terreno
- Em `terrain.ts`, após calcular as coordenadas alteradas no array `changed`:
  ```ts
  const minIdx = changed[0];
  const maxIdx = changed[changed.length - 1];
  position.addUpdateRange(minIdx * 3, (maxIdx - minIdx + 1) * 3);
  position.needsUpdate = true;
  ```
  Isso instrui o driver WebGL a transferir apenas a faixa de memória afetada (`gl.bufferSubData`), reduzindo o tráfego PCIe de 5,35 MB para poucos kilobytes.

#### B. Preservação do `PlateMesh` no Cache de Terreno
- Em `flatAtlas.ts`, ao liberar uma placa distante (`letGo`), descartar apenas os objetos WebGL associados (`s.meshes`), mas preservar a estrutura analítica `p.heights` e `p.mesh` na memória RAM. Ao retornar à vista, a criação da malha é instantânea, sem necessidade de recalcular normais ou consultar workers.

#### C. Compressão de Texturas para KTX2
- Converter os 6 arquivos PNG de elementos de cenário (folhagens, rochas) para o formato `.ktx2` utilizando o encoder Basis Universal (modo UASTC para preservação de corte fino).
- Carregar via `KTX2Loader` com transcodificação automática via Web Worker para o formato nativo da placa de vídeo (BC7 no Windows/DirectX, ASTC no mobile).

---

## 4. Ordem Estratégica de Ataque (Roadmap de Execução)

A implementação deve seguir estritamente o critério de **Impacto vs. Risco e Dependência Arquitetural**:

| Fase | Ação Principal | Impacto Estimado | Complexidade | Riscos / Pré-requisitos |
| :---: | :--- | :--- | :---: | :--- |
| **1** | **Medir RenderTargets e Ajustar Qualidade de MSAA/Sombra** | Redução de ~320 MB VRAM imediata | Baixa | Nenhum. Foto A/B para aprovação do jogador. |
| **2** | **Céu com Early-Z e GTAOPass Otimizado** | Economia de ~9 Mpx de fragmentos/frame | Baixa | Nenhum. Verificação de bordas no horizonte. |
| **3** | **`addUpdateRange` no Terreno e Cache Preservado na CPU** | Elimina picos de 5,3 MB PCIe por clique | Média | Preserva saída bit-a-bit do relevo. |
| **4** | **Índices Uint16 e Supressão de Atributos Mortos** | -50% memória de índices; -24 B/vert no verge | Média | Teste automatizado de rendering de vias. |
| **5** | **Zero-Allocation em `pedPoseInto`, Ragdolls e `wallsNear`** | Elimina ~4.000 alocações/quadro e picos de GC | Média | Sem alterações visuais. |
| **6** | **Residência de Cascas L0 por Orçamento de Bytes (300 MB)** | Elimina estouro de 794 MB para 300 MB na rua | Alta | Integrar com worker de célula pronta. |
| **7** | **Worker de Célula de Prédios Pronta (Cesium Pattern)** | Reduz latência de streaming ao mover câmera | Alta | Exige transferência de buffers montados. |
| **8** | **Desacoplamento do `SimWorld` em Web Worker com SharedArrayBuffer** | Devolve 13,7 ms de CPU à thread de render | Alta | Exige headers COOP/COEP no Vite e Electron. |
| **9** | **Compressão KTX2 dos PNGs de Cenário** | Redução de ~36 MB VRAM e load mais rápido | Baixa | Transcoder WASM configurado. |

---

## 5. Garantia e Diretrizes de Entrega

1. **Compromisso de Fidelidade Visual:** Nenhuma otimização deve achatar a geometria perceptível ou embaçar texturas. Todas as alterações em materiais ou shaders requerem comparação de fotos antes/depois no script `look.mjs` com as mesmas vistas de câmera.
2. **Integridade de Testes:** Manter a conformidade total dos testes unitários e de integração (`npm run test:raw`), assegurando que as estruturas de dados espaciais continuem retornando resultados bit-a-bit idênticos.
3. **Isolamento de Alterações:** Cada solução listada deve ser implementada em branch/worktree dedicado, com commit único contendo causa, técnica aplicada e medição comprovada.
