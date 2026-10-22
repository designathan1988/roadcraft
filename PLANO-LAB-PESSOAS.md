# Plano do lab "Criar Pessoa"

Plano montado com a pesquisa profunda de 22/10/2026 (103 agentes, 25 afirmações verificadas por 3 votos cada). Executar na ordem abaixo. Cada etapa termina com fotos reais de vários ângulos de **um** item por vez, e com commit e push no remoto `roadcraft` (main).

## Estado em 22/10/2026 (commit 2c374880)

- **Corpo, rosto e estilo:** os controles mostram a forma nova no quadro seguinte (`src/peopleLab/live.ts`, cerca de 25 ms). A reconstrução completa (cerca de 1,1 s) só acontece quando o controle para.
- **Cabelo:** catálogo em Cabelo > Montar (Solto / Com franja / Preso), com Comprimento, Volume e Ondas (`src/peopleLab/hairShape.ts`) e o escultor de peças (`sculpt.ts`).
- **Roupa:** Roupas > Ajustar, com Comprimento (só encurtar, 60–100%, como o corte do Mutable) e Folga.
- **Catálogo:** os 528 itens vestíveis da comunidade MakeHuman importados (`scripts/import-makehuman-pack.py`).
- **Testes:** há 8 testes falhando que vêm de antes deste trabalho.
  - `tests/arch/*` (7 testes): reclamam do lab como um todo, porque ele importa three.js fora de `render/`, tem ciclos de import, usa blur no CSS e testes lentos. Decidir se o lab entra como exceção nas regras de arquitetura ou se é reestruturado.
  - `tests/render/cityMemory.spec.ts`: o orçamento de memória foi estourado por cerca de 57 KB.

## 1. Tempo real de verdade (lentidão)

- **Técnica:** cada modifier do MakeHuman vira um morph target da mesma SkinnedMesh (`morphTargetInfluences`). O three.js aplica o morph antes do skinning, como no exemplo [webgl_animation_skinning_morph](https://threejs.org/examples/#webgl_animation_skinning_morph).
  - Os modifiers combinados (gênero × idade × músculo × peso) viram pesos de targets calculados na CPU.
  - Quando altura ou proporções mudam, as juntas são recalculadas a partir dos grupos de vértices e o esqueleto é refeito com `skeleton.calculateInverses()`. Não há reconstrução da geometria.
- **Roupa e cabelo:** recebem os morphs do corpo com o mesmo nome. O delta de cada vértice do proxy é a combinação baricêntrica dos deltas dos seus 3 vértices do corpo (técnica do Shape Osoroi, só que exata com os proxies do MakeHuman).
- **Pontos de partida no código:** `Morpher` (`src/people/body/morph.ts`), `PersonRig.morph` (`src/render/people/personRig.ts`) e `live.ts`.
- **Pronto quando:** nenhum controle de corpo ou rosto chama `rebuild`; a troca de peça só reconstrói a peça.

## 2. Manipulação direta no modelo

- **Fluxo:** um raycast na malha devolve o vértice; uma tabela pré-calculada liga vértice → região → par de morphs; o arraste na tela muda a influência do morph, visível no quadro seguinte (depende da etapa 1).
- **Base existente:** `direct.ts` (`HandShaper`, `REGIONS`, o brilho da região) e `addDragMorphs`.
- **Precisão:** valor numérico ao lado do cursor, Shift para movimento fino e duplo clique para zerar.

## 3. Interface

- **Referência:** o layout do CharacterStudio ([M3-org/CharacterStudio](https://github.com/M3-org/CharacterStudio), MIT): categorias em abas, grade de presets e inspetor compacto.
- **Regras:**
  - Nenhuma subaba precisa de rolagem para mostrar os controles principais.
  - Os controles secundários ficam em "Mais".
  - A grade de miniaturas tem paginação ou altura fixa.
- **Arquivos:** `panels.ts`, `widgets.ts` e `peopleLab.css`.

## 4. Rig, poses e expressões

- **Membros:** IK com o `CCDIKSolver` oficial ([documentação](https://threejs.org/docs/pages/CCDIKSolver.html)) e alvo arrastado com `TransformControls`. Ele não tem pole target, então braços e pernas precisam de um IK analítico de dois ossos com controle de cotovelo e joelho.
- **Rosto:** vocabulário de 52 blendshapes ARKit/FACS para o hm08, transferidos das expressões e poseunits do MakeHuman. Captura opcional pela webcam com o MediaPipe FaceLandmarker (`outputFaceBlendshapes`).
- **Base existente:** `posing.ts` (`PoseEditor`, cadeias CCD), `posePanel.ts` e `faceExpression`.

## 5. Cabelo editável

Não existe biblioteca web pronta para editar cabelo; isto é desenvolvimento próprio, guiado pela pesquisa.

- **Estrutura:** curvas-guia por mecha, no estilo VRoid, que geram hair cards presos ao couro cabeludo pelo vínculo baricêntrico (como um proxy).
- **Ferramentas:**
  - comprimento: corta a spline;
  - pentear: arrasta os pontos de controle com falloff;
  - prender: restringe os pontos a um alvo (rabo, coque);
  - franja: um grupo de mechas sobre a frente.
- **Critério:** comparar com o catálogo em fotos de vários ângulos, sem buraco e sem atravessar o corpo.

## 6. Roupa nova

- **Moldes:** [FreeSewing](https://codeberg.org/freesewing/freesewing) (JS, gera moldes a partir de medidas) ou [GarmentCode](https://github.com/maria-korosteleva/GarmentCode) (MIT, Python). As medidas vêm do hm08 (circunferências dos loops de vértices).
- **Drapeado:** posicionar os painéis em volta do corpo e simular com tecido em WebGPU de baixa resolução (exemplo `webgpu_compute_cloth`), colidindo com cápsulas presas aos ossos. O resultado é gravado como proxy e não fica simulando continuamente.
- **Base existente:** `cloth.ts` e `atelier.ts`.
