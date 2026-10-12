# Fase 7 — Resolução dinâmica, governador sem troca de nível, LOD de sombra, Z invertido e compilação no primeiro uso

Pesquisa de 2026-10-11, ramo `agente/pesquisa` (a partir de `planeta-esfera` 27a7cb48). Só leitura de código; nada foi
rodado (nem jogo, nem testes, nem build, nem painel). O three.js lido localmente é o r186 (0.186.1) em
`C:/Codex-Shared/roadcraft-planeta-esfera/node_modules/three`, só para leitura.

Método e limite das fontes: as páginas da web vieram pela ferramenta de busca de páginas, que devolve um resumo extraído por
modelo; o PDF da Intel foi baixado para a pasta temporária da sessão e lido por mim inteiro com `pdftotext` (378 linhas).
Onde a ferramenta cortou uma página ou o resumo avisou que faltava algo, está na seção 5.

---

## 1. Perguntas que a fase precisa responder

1. Como se faz resolução dinâmica em WebGL com three.js r186 neste desenho de pós-processamento (alvo multiamostrado, cadeia
   `EffectComposer`, passes próprios que leem profundidade), e qual é o custo real de cada jeito de mudar a resolução?
2. Que controlador (entrada, histerese, passo, "pânico") as engines usam, e como é um governador que nunca troca de nível
   (`low/medium/high/ultra`) e nunca desliga sombra nem grama?
3. O que o jogo já faz de LOD de sombra, o que as engines fazem a mais (cascatas, cache estático/dinâmico, refresco por
   frequência), e o que custa trazer cada coisa para este código?
4. Z invertido no `WebGLRenderer` r186: o que está pronto, o que falta, o que o jogo teria de mudar e o que ele de fato ganha
   em precisão aqui?
5. O que acontece no primeiro uso de um shader (primeiro traço do pincel de zona) mesmo com `compileAsync`, e como evitar de
   forma geral e não por lista de aquecimento?

---

## 2. Fontes lidas

Convenção: S = fonte. Citações curtas, no máximo uma por fonte.

**S1. Doug Binks (Intel), "Dynamic Resolution Rendering"** — https://www.intel.com/content/dam/develop/external/us/en/documents/dynamicresolutionrendering-183334.pdf
(PDF baixado e lido inteiro em 2026-10-11; GDC 2011; medidas num Intel HD Graphics 3000 de 2011, então os milissegundos são
de época e valem só como ordem de grandeza). A técnica: reduzir a resolução do 3D com um `viewport` dentro de um alvo de
render maior e depois escalar para o buffer final; a interface é desenhada na resolução cheia. Ao ler do alvo é preciso
escalar as coordenadas e prender (clamp) as UV na borda direita e inferior da parte usada (exemplo com
`min(unclampedUV, razaoDoAlvoEmUso)`), e recalcular a razão a partir do viewport inteiro de fato (arredondado), não da razão
desejada. Filtros de escala medidos (0,71x para 1280x720): ponto ~0,4 ms, bilinear ~0,4 ms, bicúbico ~3,5 ms (7x mais lento),
ruído ~0,5 ms, ruído com deslocamento ~0,7 ms, antialiasing temporal ~1,1 ms. Limpar só a parte usada do alvo pode ser mais
barato, mas o buffer de profundidade deve ser limpo inteiro (por causa da profundidade hierárquica). Controlador: proporcional
à diferença adimensional entre o tempo de quadro desejado e o atual; o tempo atual é a média do tempo interno de GPU (consulta
de tempo, sem a apresentação) com o intervalo entre quadros, porque com sincronização vertical o intervalo é travado pelo
monitor e esconde a folga; picos em que o intervalo é muito maior que o da GPU são ignorados (são da CPU). Menciona como
melhoria futura aplicar o mesmo método às sombras. O movimento da câmera esconde a perda de resolução (desfoque de movimento).

**S2. Unreal Engine, "Dynamic Resolution in Unreal Engine"** — https://dev.epicgames.com/documentation/en-us/unreal-engine/dynamic-resolution-in-unreal-engine
(lida em 2026-10-11, doc atual da época). A heurística olha a carga de GPU dos quadros anteriores e ajusta a porcentagem de
tela dentro de uma faixa. Padrões documentados: mínimo 50%, máximo 100% (o máximo também dimensiona os alvos de render),
orçamento de quadro 33,3 ms. Variáveis de ajuste: folga de GPU alvo, limiar de mudança, período mínimo entre mudanças, tamanho
do histórico, porcentagem quando limitado pela CPU, e um "botão de pânico" (`MaxConsecutiveOverbudgetGPUFrameCount`): depois
de N quadros seguidos estourando, a resolução cai de uma vez e o histórico zera. A página não dá os valores padrão dessas
variáveis nem a fórmula. Com amplificação temporal o percentual secundário não pode ser dinâmico porque o histórico do TAA não
pode mudar de tamanho. Desfoque de profundidade Gaussiano e oclusão por campo de distância tinham problemas com mudança de
resolução. Plataformas suportadas: consoles, Switch e PC (DX12 e Vulkan).

**S3. Unity, "Dynamic Resolution" e "Control scaling with Dynamic Resolution"** — http://docs.unity3d.com/Manual/DynamicResolution-landing.html
e https://docs.unity3d.com/6000.1/Documentation/Manual/DynamicResolution-control.html (lidas em 2026-10-11). A API aplica uma
escala de largura e altura a todos os alvos marcados como escaláveis; o exemplo do manual limita a escala entre 0,5 e 1,0 em
passos de 0,1 e aplica na hora; o manual aponta a leitura de tempos de CPU e GPU do `FrameTimingManager`, mas o exemplo não
calcula nenhum alvo (muda por entrada do usuário). Não dizem plataformas, limiares nem suavização.

**S4. AMD, FidelityFX Super Resolution 1** — https://gpuopen.com/fidelityfx-superresolution/ (lida em 2026-10-11). Ampliador
espacial em dois passes (EASU para bordas, RCAS para nitidez), sem histórico nem vetores de movimento; deve receber o quadro
já com antisserrilhado, depois do mapeamento de tons; efeitos que somam ruído vão depois. Escalas por eixo: 1,3x, 1,5x, 1,7x,
2,0x; aceita escala arbitrária entre 1x e 4x de área, "tipicamente usada para resolução dinâmica". Custo declarado como teto:
0,30 ms a 1440p e 0,60 ms a 4K numa classe de RTX 3060 Ti. A página do SDK 3.1.4 (https://gpuopen.com/manuals/fidelityfx_sdk/techniques/super-resolution-upscaler/)
foi lida só até 100 000 de 171 587 caracteres; a parte sobre viés de mip e resolução dinâmica não chegou.

**S5. MDN, "WebGL best practices"** — https://developer.mozilla.org/en-US/docs/Web/API/WebGL_API/WebGL_best_practices
(lida em 2026-10-11). Compilar todos os shaders, ligar todos os programas e só depois checar o resultado; checar só
`LINK_STATUS`, e as mensagens de erro só em caso de falha; com `KHR_parallel_shader_compile`, perguntar o status de
completude num quadro posterior e usar o programa quando estiver pronto; `getShaderParameter`, `getProgramParameter` e as
mensagens de erro "causam descarga e ida-e-volta" ao processo de GPU, mais compilação se esta ainda não acabou. Para ir mais
rápido: reduzir `canvas.width/height` com o tamanho CSS fixo ("render small and upscale"). Reaproveitar framebuffers (a maioria
das trocas de anexo invalida a completude), orçar VRAM por pixel e invalidar anexos que não serão lidos. Não trata do custo de
mudar `canvas.width`, de multiamostragem, nem de viewport parcial.

**S6. Microsoft Learn, "Cascaded Shadow Maps"** — https://learn.microsoft.com/en-us/windows/win32/dxtecharts/cascaded-shadow-maps
(lida inteira em 2026-10-11). Cascatas dividem o frustum de vista em sub-frustums, cada um com seu mapa, escolhidos por
intervalo de profundidade ou por limites do mapa; recalcular os intervalos a cada quadro faz as bordas das sombras tremerem, a
prática é um conjunto estático de intervalos por cenário; "ajustar à cena" (frusta fixas em tamanho) evita o artefato de a
projeção ortográfica crescer e encolher com a câmera, e o artigo manda mover a luz em incrementos do tamanho de um texel
(já feito aqui); faixa de mistura entre cascatas evita a emenda visível; margem de metade do núcleo PCF em cada cascata;
poucas cascatas bastam quando a geometria tem pouca variação de profundidade (vista de cima).

**S7. Unreal Engine, "Virtual Shadow Maps"** — https://dev.epicgames.com/documentation/en-us/unreal-engine/virtual-shadow-maps-in-unreal-engine
(lida em 2026-10-11). Mapa virtual de 16k x 16k dividido em páginas de 128x128, alocadas e renderizadas só onde há pixel na
tela; luz direcional usa clipmaps em níveis que dobram o raio. Cache ligado por padrão: páginas ficam entre quadros e são
invalidadas por movimento da luz ou da geometria que as toca; há uma camada estática separada da dinâmica, e o número de
invalidações estáticas deve ficar perto de zero. Custo se divide em profundidades de sombra (páginas e geometria desenhada) e
projeção (amostras por pixel); geometria longe da luz pode ser cortada ou cair em sombras de campo de distância. A página não
dá frequência de atualização de páginas distantes nem valores de escalabilidade.

**S8. Especificação KHR_parallel_shader_compile (WebGL)** — https://registry.khronos.org/webgl/extensions/KHR_parallel_shader_compile/
(revisão 6, 24/11/2020, lida em 2026-10-11). Adiciona `COMPLETION_STATUS_KHR` (0x91B1) em `getProgramParameter`: verdadeiro
quando o trabalho de compilar e ligar acabou; perder o contexto devolve verdadeiro sempre; a especificação dá só implicitamente
o bloqueio de consultar o status ou usar o programa antes; recomendação do próprio texto: compilar tudo, ligar tudo e depois
consultar com `requestAnimationFrame`, e só olhar `LINK_STATUS` quando completo.

**S9. Especificação EXT_clip_control (WebGL)** — https://registry.khronos.org/webgl/extensions/EXT_clip_control/ (revisão 2,
06/11/2023, estado "aprovada pela comunidade", lida em 2026-10-11). Expõe `clipControlEXT(origin, depth)` com
`NEGATIVE_ONE_TO_ONE_EXT` (padrão) e `ZERO_TO_ONE_EXT`; "nenhuma mudança de comportamento específica do WebGL", o resto remete
à especificação do OpenGL ES. web3dsurvey.com/webgl2/extensions/EXT_clip_control (sem data): 91,95% no Windows, 88,07% no geral.

**S10. Nathan Reed, "Depth Precision Visualized"** — https://www.reedbeta.com/blog/depth-precision-visualized/ (lida em
2026-10-11). Profundidade fixa de 24 bits e Z padrão concentram precisão perto da câmera; com Z invertido (perto = 1, longe = 0)
e profundidade de ponto flutuante de 32 bits a precisão fica quase uniforme; a recomendação é flutuante com Z invertido; Z
invertido com inteiro de 24 bits não ganha o mesmo (no teste de arredondamento, 76% de valores indistinguíveis contra 0% no
flutuante). O intervalo padrão de [-1, 1] do OpenGL destrói a precisão do flutuante antes de gravar; só `glClipControl`/
`ARB_clip_control` conserta, e GL ES não tinha conserto (daí a extensão do WebGL, S9). Z invertido não resolve alcances extremos
de mundo aberto.

**S11. three.js, issue #31998 "WebGLRenderer: Additional changes for reversed depth buffer"** — https://github.com/mrdoob/three.js/issues/31998
(lida em 2026-10-11). Aberta em 01/10/2025 contra r180; fechada em 21/01/2026, marco r183, com a frase de Mugen87 de que
"a maioria das coisas parece funcionar" (tradução de "most things seems to work now") e o pedido de retorno dos usuários do r183 antes de portar ao `WebGPURenderer`. Problemas
originais: viés de sombra, SSAO (sombras dentro das bordas), desfoque de profundidade ("TBD"). A lista de PRs (#31410, #31495,
#31496, #31500, #31481, #31464 que corrige a ordem dos planos do frustum, entre outros) está no código r186 (ver S13). O
corretor de câmera de sombra (`_reversedDepth`) foi o último achado (17/01/2026). Nenhum PR específico de SSAO aparece na lista;
a issue não diz que o desfoque de profundidade foi tratado.

**S12. Fóruns do three.js** — https://discourse.threejs.org/t/does-three-js-webgpu-support-reverse-z-buffer/87687 (24/10/2025, a
fonte do "sombras e SSAO incompletos" do relatório; é um comentário de outubro de 2025 contra r180, sobre `WebGPURenderer`) e
https://discourse.threejs.org/t/reverse-z-infinite-projection/88394 (dezembro de 2025): `reversedDepthBuffer` só se escolhe na
construção do `WebGLRenderer` (não por câmera; `camera.reversedDepth` é só leitura), pós-processamento, iluminação por clusters e
CSM supõem profundidade não invertida ou plano distante finito, e shaders próprios que reconstroem posição pela profundidade
precisam de mudança. Lidas em 2026-10-11, resumos.

**S13. three.js r186, código** (lido em 2026-10-11, versão 0.186.1):
- `src/renderers/WebGLRenderer.js:83,453–457` (opção do construtor; `state.buffers.depth.setReversed(true)` só em `initGLContext`),
  `:2597–2602` (câmera recebe `_reversedDepth` e refaz a projeção), `:1687` (frustum de culling com `camera.reversedDepth`),
  `:3701` ("requires the EXT_clip_control extension").
- `src/renderers/webgl/WebGLCapabilities.js:96–101` (sem a extensão, volta ao padrão com aviso),
  `WebGLState.js:78–94` (`clipControlEXT(LOWER_LEFT, ZERO_TO_ONE)`, limpa a profundidade com o valor invertido),
  `:871–875` (no polygon offset só o fator troca de sinal, as unidades não), `setFunc` troca as comparações.
- `src/math/Matrix4.js:1140–1160` (projeção invertida: `c = near/(far-near)`, `d = far*near/(far-near)`), `src/math/Frustum.js:95–109`.
- `src/renderers/shaders/ShaderChunk/packing.glsl.js:86,106`, `shadowmap_pars_fragment.glsl.js:192,259,367,439`,
  `ShaderLib/depth.glsl.js:85`; `WebGLShadowMap.js:200–201,263` (câmera de sombra e `compareFunction`);
  `examples/jsm/shaders/GTAOShader.js:95,162`, `SAOShader.js`, `SSAOShader.js`, `PoissonDenoiseShader.js` tratam o caso.
- `src/renderers/WebGLRenderer.js:1396–1580` (`compile`, `compileAsync`), `webgl/WebGLProgram.js:860–1010` (`linkProgram` na
  construção, `onFirstUse`, `isReady`), `webgl/WebGLUniforms.js:1107–1119`, `webgl/WebGLPrograms.js:402–620` (chave do
  programa), `WebGLRenderer.js:484` (`info.programs`).
- `src/renderers/WebGLRenderer.js:640–735` (`setPixelRatio`, `setSize` mexem em `canvas.width/height`), `src/core/RenderTarget.js:112–135`
  (`viewport`, `scissor`), `examples/jsm/csm/CSM.js:202,364–396,427–443`.

**S14. Registros do próprio projeto** (evidência, não fonte externa): `docs/PROBLEMAS.md` linhas P75 e P81, `docs/ZONEAMENTO.md:132`,
`PROMPT-PENDENCIAS.md:133–136`, commits `29ae2c5b` (2026-10-02, título "Stutter while moving...", e o corpo trata da retirada do governador) e `1ea68d41`
(2026-10-09, "Primeira pincelada de zona sem travar: plantas de quintal e vidros dos prédios compilados antes").

---

## 3. O que se aplica a este código

### 3.1 O que existe hoje

- Níveis em `src/render/quality.ts:15–180`: `pixelRatio` 1, 1,25, 1,5, 2; sombra (mapa 1024, 1024, 2048, 4096); pós-processamento
  e oclusão só de `high` para cima. O renderer usa `Math.min(devicePixelRatio, quality.pixelRatio)`
  (`renderer.ts:2106,2120`): numa tela com `devicePixelRatio = 1` os níveis `high` e `ultra` desenham a 1,0 (não há
  supersampling, conta minha a partir do código). Qualquer resolução dinâmica nessa tela só pode descer, não subir.
- O `QualityGovernor` (`quality.ts:195–260`) existe e tem teste (`tests/render/qualityGovernor.spec.ts`), mas **nada o chama**:
  `governor.sample` só aparece no teste. O commit `29ae2c5b` (02/10/2026) tirou a chamada; a mensagem dele, em inglês, diz que o governador
  automático saiu porque os gráficos são o que o jogador escolhe (High por padrão) e o jogo nunca os rebaixa.
  `renderer.ts:540,2746,2874,3796–3798` só usam `governor.current` e `governor.set`. Quer dizer: hoje não existe controle
  automático nenhum, e a decisão registrada é a inversa da que a fase 7 propõe. O `PROMPT-PENDENCIAS.md:133–136` já lista
  "resolução dinâmica e governador sem troca de nível (nunca desligar sombra nem grama)" como entrega, então a coordenadora
  sabe; mas é uma reversão do que o commit registra, e vale o "sim" explícito do jogador antes de ligar por padrão (não sei
  se foi o jogador quem pediu aquela retirada: a mensagem não diz).
- Mudar de nível é pesado: `applyQuality` (`renderer.ts:2104–2117`) refaz o `PostChain` inteiro (`post.dispose()` e
  `createPostChain`, que compila programas de GTAO) e força `networkRevision = -1`, isto é, reconstrução do mundo. O comentário
  de `quality.ts:197–198` já dizia, em inglês, que a própria troca de nível custa um quadro. Isso é exatamente o que o governador sem troca de nível
  evita.
- A cena vai para um alvo `HalfFloatType` com `DepthTexture` e `samples = min(4, maxSamples)` (`postprocess.ts:234–242`), na
  cadeia `EffectComposer`. `post.setSize` (`postprocess.ts:655–662`) redimensiona composer, bloom, os alvos de corpos de nuvem e
  a máscara de nitidez, e zera `historyValid` (histórico do desfoque de movimento).
- Sombra: um único mapa direcional, frustum ortográfico ajustado à vista (`environment.ts:449–560`), texel tomado em passos
  (`GroundShadowGrid`, `environment.ts:210+`), `renderer.shadowMap.autoUpdate = false` e `needsUpdate = true` **todo quadro**
  (`renderer.ts:503,3650`). Já existe um LOD de sombra: `buildings.setShadowFar(zoom < FACADE_SHADOW_ZOOM)` desliga a sombra das
  fachadas finas longe (`renderer.ts:3323`, `buildings/layer.ts:174–186,500`).

### 3.2 Resolução dinâmica em WebGL com three r186

Três jeitos, do mais barato de escrever ao mais completo:

**A. Mudar `setPixelRatio` (e redimensionar a cadeia).** É o que o MDN chama "render small and upscale" (S5). No r186
`setPixelRatio` chama `setSize`, que escreve `canvas.width/height` (`WebGLRenderer.js:640–735`), e `post.setSize` realoca todos os
alvos. O custo de realocar um alvo `HalfFloat` multiamostrado com profundidade não foi medido; o MDN diz que não cobre o custo
de mexer em `canvas.width`. Com passos discretos (por exemplo 1,0, 0,9, 0,8, 0,7, 0,6 de lado, como o exemplo da Unity, S3, com
passo de 0,1) e período mínimo entre mudanças (Unreal, S2), a realocação raramente acontece. Zera o histórico de movimento a
cada passo (`postprocess.ts:661`). Menor mudança no código: só `post.setSize` e `renderer.setPixelRatio`, sem `createPostChain`.

**B. Viewport parcial, o método original (S1).** Renderizar a cena num retângulo do alvo cheio:
`target.viewport.set(0, 0, w*s, h*s)` e `scissor` (`RenderTarget.js:112–135`; três honra os dois em `setRenderTarget`,
`WebGLRenderer.js:3041–3043`). Nenhuma realocação. O custo vai para o resto da cadeia: cada passe que lê o alvo precisa escalar a
UV e prender na borda (S1, `min(uv, razao)`), e a razão tem de ser a do viewport arredondado. No jogo leem profundidade ou cor do
alvo da cena: o desfoque de movimento (`postprocess.ts:143`), a nuvem/névoa (`:924,1045,1346–1359`), a máscara de nitidez
(`:1495–1502`), o GTAO do three (`gtao.setGBuffer`, `:335`), SMAA, e o `Bloom`. Cada um teria de aprender a razão: trabalho grande
e fácil de errar (vazamento de cor da borda do viewport, a figura 4 de S1). Hoje a cadeia assume alvo cheio.

**C. Híbrido: só a passada da cena em resolução reduzida e um ampliador para o alvo cheio.** A passada da cena (a mais cara:
multiamostrada, sombras, 1 900 objetos) vai para um alvo menor; um passe de uma tela só amplia para o alvo cheio, e o resto da
cadeia fica como está. Os passes que leem a profundidade da cena por UV (todos os acima) funcionam com uma textura de outro
tamanho porque amostram por UV; os que usam `textureSize(tDepth)`/`gl_FragCoord` para indexar (`postprocess.ts:1346–1349`,
`ivec2 full = textureSize(tDepth, 0)`) precisam de revisão. Hipótese a verificar, não afirmação.

Ampliador: bilinear custa o mesmo que ponto (S1, ~0,4 ms em 2011); o FSR 1 (S4) é a opção de qualidade com teto de 0,30 ms a
1440p numa placa da classe da RTX 3060 Ti; exige entrada já com antisserrilhado, e o jogo já tem SMAA, nitidez 0,35 em `high`
(`quality.ts:sharpen`), mapeamento de tons no fim; a porta para WebGL não foi lida (só a doc do FSR 1), então o custo real em
fragment shader de navegador é desconhecido. Antes de qualquer ampliador sofisticado, medir se a bilinear basta: o
desfoque de movimento e o movimento da câmera mascaram a perda (S1, figuras 9–10).

O que decide se vale a pena: **a passada da cena escalar com a resolução**. S1 (figura 11) mostra o FPS crescendo com a razão
nos testes dela; aqui isso precisa ser medido: fixar uma vista, rodar a GPU (fase 0) a pixelRatio 1,0, 0,8 e 0,6 e ver o
tempo de GPU da passada da cena e das sombras. Se a GPU for dominada por geometria ou por sombra (não por pixels), baixar
resolução não ajuda e o ganho está no LOD de sombra e de agentes, não aqui.

### 3.3 Governador sem troca de nível

Regras que saem das fontes e da lista de pendências:

- Entrada: tempo de GPU. S1 usa o tempo interno de GPU (consulta de tempo) com o intervalo entre quadros; S2 também usa carga
  de GPU dos quadros anteriores. Aqui a entrada é o cronômetro de GPU da fase 0, em janelas curtas, p95 (não a mediana de
  34 fps do governador antigo: sob sincronização vertical o quadro nunca mede menos que o monitor, como o comentário de
  `quality.ts` já diz). Sem o cronômetro de GPU o governador não deve existir.
- Só ajusta a escala, entre um piso e 1,0 (S2: 50%–100%; S3: 0,5–1,0). O nível e as chaves (sombra, grama, pós) ficam como o
  jogador escolheu. Invariante testável: nenhuma chamada a `setQuality`/`applyQuality` partindo do governador.
- Histerese, copiada das variáveis da Unreal (S2): histórico de N quadros; limiar mínimo de mudança; período mínimo entre
  mudanças; mudança descendo rápido (pânico) e subindo devagar. Passos discretos de 0,1 (S3) quando for o método A; contínuo só
  no método B ou C.
- Ignorar quadros em que a CPU, não a GPU, estourou (S1: intervalo muito maior que o tempo de GPU é pico de CPU) e os quadros de
  rebuild de mundo (o governador antigo já descartava `deltaSeconds > 0.4`, `quality.ts:246`).
- O laço de quadros é por demanda (rAF só quando há o que desenhar): contar só os quadros que desenharam e não deixar uma longa
  parada ociosa virar "folga" para subir a resolução.
- Metas de aceite da tabela do relatório: GPU p95 no alvo e nenhuma troca de nível em 10 minutos. O teste existente
  (`tests/render/qualityGovernor.spec.ts`) cobre a lógica antiga; o novo precisa de teste com sequências de tempos sintéticas
  (carga que oscila, carga que dispara, parada longa) e do invariante acima.

### 3.4 LOD de sombra

O que já está feito: ajuste do frustum à vista com piso e texel em passos; sombra das fachadas finas desligada longe;
`customDepthMaterial` por variante de programa (`renderer.ts:3656` `assignShadowDepth` a cada 30 quadros).

O que as fontes oferecem a mais, na ordem do custo de trazer para cá:

1. **Cortar quem não se vê.** Na vista aberta, um mapa de 2048 sobre um `span` de centenas de metros dá texel de metros
   (`texel = 2*span/mapSize`, `environment.ts:468,559`); sombra de carro, pessoa, árvore pequena e vaso fica abaixo de um texel.
   O jogo já corta fachadas por `zoom`; não há corte parecido para multidão, veículos e vegetação (verifique `castShadow`
   em `agents.ts:627–638`, `natureTrees.ts:177`, `groundCover.ts:303`, `scenery`). Barato, local, em linha com a regra do
   projeto de otimizar sem perder visual (o que some é sub-texel). Medir a GPU da passada de sombra antes e depois.
2. **Refresco condicional.** `needsUpdate = true` todo quadro (`renderer.ts:3650`). Com o sol parado, a câmera parada e nada se
   movendo, o mapa não precisa ser refeito; mas num jogo com tráfego e gente a cidade quase nunca está parada, então um bit
   global "sujo" quase sempre estaria ligado. A ideia da Unreal (S7) é separar estático de dinâmico: o mapa estático (terreno,
   prédios, vias) só refaz quando o frustum, o sol ou a geometria estática mudam (o `GroundShadowGrid` já dá a granularidade de
   texel para isso), e os dinâmicos (veículos, gente) entram à parte. O three r186 não tem camadas de mapa; seriam dois mapas
   somados no sombreador (mudança em `onBeforeCompile`) ou um mapa estático congelado que vira textura. Médio/grande.
3. **Cascatas.** S6: poucas cascatas bastam em vista de cima. O `CSM` do three (`CSM.js`) cria uma `DirectionalLight` por
   cascata (`:202`), cada uma com seu mapa e sua passada, e reescreve `onBeforeCompile` dos materiais (`setupMaterial`,
   `:427–443`): isso conflita com as cadeias de `onBeforeCompile` que o jogo usa em vários materiais (por exemplo
   `skinAppearance.ts`, `planet/bend.ts:228`), e multiplica o custo da passada de sombra por N. Só valeria numa vista de perto
   com perspectiva (rua, 3a pessoa), onde a câmera ortográfica não existe.
4. **Resolução do próprio mapa.** O jogo já adapta a densidade pelo `span`; mudar `mapSize` realoca o mapa
   (`environment.ts:682–689`). S1 propõe viewport parcial também para sombras; o `LightShadow` do three só usa `viewport` por face
   de luz pontual, então não vem pronto.

Medida necessária antes de escolher: tempo de GPU da passada de sombra separado da passada da cena e da pós (cronômetro da
fase 0, uma consulta de cada vez), e triângulos na passada de sombra.

### 3.5 Z invertido no r186: o que está pronto e o que o jogo precisa mudar

O r186 está bem mais completo do que o relatório assume. O relatório cita [F32], um comentário de 24/10/2025 contra r180 sobre
WebGPU; a issue #31998 (S11) foi fechada em 21/01/2026 com os PRs que estão no código r186 (S13): comparação de profundidade
trocada (`WebGLState.js setFunc`), valor de limpeza, `shadowMatrix`, viés de sombra com sinal trocado
(`shadowmap_pars_fragment.glsl.js:192,259,367,439`), câmera de sombra com `_reversedDepth`, `gl_FragCoord.z` de alta precisão
(`depth.glsl.js:85`), ordem de planos do frustum, `perspectiveDepthToViewZ` (`packing.glsl.js:86,106`) e os shaders SAO/SSAO/GTAO
de exemplo. Falta confirmação específica para desfoque de profundidade e para sombra de luz pontual/VSM (ainda em tratamento em
janeiro de 2026 segundo a issue). O jogo usa PCF direcional e GTAO, que estão cobertos no código.

O que muda no jogo (inventário da leitura; cada item precisa de verificação visual):

1. **Profundidade em ponto flutuante.** A profundidade da cena é `new DepthTexture(w, h)` (`postprocess.ts:236`), cujo padrão é
   `UnsignedIntType` (`DepthTexture.js:28`), isto é, `DEPTH_COMPONENT24`. S10: Z invertido com inteiro de 24 bits não dá o ganho;
   é preciso `type: FloatType` (o r186 mapeia para `DEPTH_COMPONENT32F`, `WebGLTextures.js:254–284`), e a multiamostragem
   (`samples: 4`, com `resolveDepthBuffer`) usa o mesmo formato. No nível `low`, sem pós, a cena vai direto ao buffer padrão do
   canvas, cuja profundidade o navegador escolhe: Z invertido não ajuda ali.
2. **Opção só na construção.** `reversedDepthBuffer` é parâmetro do `new WebGLRenderer(...)` (`renderer.ts:463`) e
   `setReversed(true)` roda em `initGLContext` (`WebGLRenderer.js:453–457`); não dá para trocar por nível ou em execução sem
   recriar o contexto. Seria uma chave de build/boot como `__PLANET__`.
3. **Extensão.** Sem `EXT_clip_control` o r186 volta ao padrão com aviso (`WebGLCapabilities.js:96–101`); 91,95% no Windows (S9).
   O código do jogo precisa funcionar nos dois casos (consultar `renderer.capabilities.reversedDepthBuffer`).
4. **Shaders do jogo com profundidade à mão** (não são do three, não ganham o `#ifdef USE_REVERSED_DEPTH_BUFFER` de graça — o
   r186 só injeta a definição, `WebGLProgram.js:597,768`):
   - `environment.ts:138`: o céu faz `gl_Position.z = gl_Position.w` (fundo do alcance). Com Z invertido o fundo é `z = 0`.
   - `planet/space.ts:75`: `gl_Position.z = gl_Position.w * (1.0 - 4.0e-6)`, idem.
   - `postprocess.ts:143,924,1495`: reconstroem posição com `depth * 2.0 - 1.0` (convenção [-1, 1]); com
     `ZERO_TO_ONE` é `depth` direto. Os testes de céu `depth >= 0.9999` (`:1046,1350,1360,1368`) e `depth < 1.0` (`:1502`), o `min` sobre quatro
     profundidades (`:1349`, "o mais perto" vira `max`) e o valor `0.99999` de `worldAt` (`:1048,1352`) mudam de sentido.
   - `buildings/referenceModel.ts:67` (`gl_FragCoord.z` empacotado em cor, ferramenta de referência).
   - `renderer.ts:3398–3399`: `crowdFrustum.setFromProjectionMatrix(crowdProjection)` sem o argumento `reversedDepth`; o r186
     corrigiu a ordem dos planos (#31464), o culling próprio do jogo precisa passar `camera.reversedDepth`
     (`Frustum.js:95–109`).
5. **`polygonOffset`.** O jogo usa em 17 lugares (`lotOverlay.ts:49–54` com fator -4 e unidades -16, marcações, decalques). O r186
   troca o sinal só do **fator** com Z invertido (`WebGLState.js:871–875`) e deixa as **unidades** como estão; pelo código, as
   unidades negativas empurrariam para longe da câmera em Z invertido. Isto é leitura de código, não teste; precisa de um teste
   visual (marcação sobre asfalto, sobreposição de lotes) antes de qualquer decisão. É o item de maior risco de regressão
   silenciosa.
6. **Plano `near`/`far` da câmera** (`isoViewport.ts:218–219,234–235,292,300–301,384`) fica como está: o Z invertido torna o
   `far` finito inofensivo (S10).

Quanto de precisão está em jogo (conta minha, perspectiva, `near = max(0,08 m, 0,02 x distância)`,
`far = 4 x distância + 2 400 m + 2,6 R` com R = 3 819,7 m nos mundos de planeta, `isoViewport.ts:300–301`; passo de profundidade
em metros na distância z da câmera; fixa 24 bits padrão: `z^2 (far-near)/(far near) 2^-24`, flutuante invertida ~ `z 2^-23`):

| distância da câmera ao alvo | near / far | z = 300 m | z = 1 000 m | z = 3 000 m | z = 5 000 m |
|---|---|---|---|---|---|
| 100 m | 2 m / 12 731 m | 24 bits 2,7 mm; invertida 0,04 mm | 3,0 cm; 0,12 mm | 27 cm; 0,36 mm | 74 cm; 0,6 mm |
| 400 m | 8 m / 13 931 m | 0,7 mm; 0,04 mm | 7,4 mm; 0,12 mm | 6,7 cm; 0,36 mm | 19 cm; 0,6 mm |

Isto só vale para as vistas em perspectiva (voo e globo); a vista isométrica padrão é ortográfica (`ortho`, `isoViewport.ts:174`):
profundidade linear de 24 bits sobre 5 600 m dá 0,33 mm, e o Z invertido não muda nada ali. `docs/ESCALA.md:171–175` registrou o
risco de z-fighting do globo ("medir z-fighting de faixas/calçadas com a câmera baixa e longe"). Sem esse defeito medido, o
custo (itens 1 a 5 acima) não se paga; com ele, é a correção de classe em vez de mais `polygonOffset`.

### 3.6 Compilação no primeiro uso (primeiro traço do pincel de zona)

O que o código faz: `compileAhead(grupo)` enfileira, `drainCompiles` (`renderer.ts:3783`) chama `renderer.compileAsync` com o alvo
da cena e o `post.target` (para a cor e o mapeamento de tons coincidirem com a chave do programa), `warmPreviewShaders`
(`renderer.ts:2063–2101`) aquece prédio fantasma e real, plantas, trilhos e a sobreposição dos lotes (`lotOverlay.warm()`,
`lotOverlay.ts:237`). `P81`/`1ea68d41` (09/10/2026) mediu o quadro máximo do primeiro traço de 663 para 42,7 ms, sem quadro
longo. Portanto o "~360 ms" que `PROMPT-PENDENCIAS.md:136` e `docs/ZONEAMENTO.md:132` repetem é de antes do P81 (a medida do
P75 foi de 113e749d, do mesmo dia); o estado a registrar é "42,7 ms medidos, ainda acima do limite de 33,8 ms da fase 0".

O que resta, pelo código do r186 (leitura, não medição):
- `compileAsync` resolve quando `isReady()` (a consulta `COMPLETION_STATUS_KHR`, S8) de cada material dá verdadeiro, conferindo
  a cada 10 ms (`WebGLRenderer.js:1515–1560`). Programa pronto não é programa introspectado: no primeiro desenho o `getUniforms()`
  roda `onFirstUse` (`WebGLProgram.js:862–975`) → `new WebGLUniforms` (`WebGLUniforms.js:1114–1119`: um `getActiveUniform` e um
  `getUniformLocation` por uniform) e `fetchAttributeLocations` (`WebGLProgram.js:178–198`), chamadas síncronas que S5 diz serem
  ida-e-volta ao processo de GPU. É um custo por programa novo, no quadro do primeiro uso, e `compileAsync` não o antecipa.
- A chave do programa (`WebGLPrograms.js:402–620`) inclui neblina, `shadowMapEnabled`, luz, pele, alvos de morph, `vertexAlphas`,
  `alphaToCoverage`, `reversedDepthBuffer`, recortes e o espaço de cor do alvo: qualquer combinação não prevista na lista de
  aquecimento (outro tipo de prédio com outro material, outra espécie de planta, material de vidro com outra luz) vira um
  programa compilado no quadro. A lista de P81 foi levantada a partir do que travou na vez; novas peças repetem o defeito.
- `renderer.debug.checkShaderErrors` desligado em produção (`renderer.ts:477`, só DEV) evita `getProgramInfoLog` (S5), mas não
  evita a introspecção acima.

Proposta de correção de classe (regra do projeto: defeito visual é classe, corrigir onde nasce e deixar guarda): contar
programas criados depois do aquecimento. `renderer.info.programs` é o array de programas (`WebGLRenderer.js:484`); no monitor F9
(`src/core/health.ts`) registrar o tamanho e, quando cresce depois de `onAssetsReady` mais N quadros, anotar a chave
(`program.cacheKey`) e o nome do material com um aviso "programa novo no quadro". Com isso o primeiro traço, e qualquer
primeiro uso futuro, se mostra como contagem em vez de ficar escondido num p99; o aquecimento passa a ser guiado pela lista de
chaves vistas. Medir: Long Animation Frames (fase 0) durante o primeiro traço, a ordem de grandeza da introspecção (uma marca
`performance.measure` em torno do primeiro desenho de um programa já pronto).

---

## 4. Riscos e o que medir

| risco | por que | o que medir |
|---|---|---|
| Resolução dinâmica não ajuda | GPU dominada por geometria/sombra, não por pixels | GPU da passada da cena e das sombras a pixelRatio 1,0/0,8/0,6 numa vista fixa (cronômetro da fase 0) |
| Realocar alvos a cada passo trava um quadro | método A realoca `HalfFloat` multiamostrado e zera `historyValid` | ms do quadro que muda de escala; passos discretos e período mínimo |
| Vazamento de cor na borda do viewport | método B lê fora da parte usada (S1, figura 4) | foto lado a lado com listras de alto contraste; clamp de UV |
| Governador oscila ou sobe com a máquina parada | laço por demanda e sincronização vertical | sequências sintéticas de tempos; "nenhuma troca de nível em 10 min" |
| Reverte o que o commit `29ae2c5b` (02/10) registra | o automático saiu para o jogo nunca rebaixar os gráficos | pedir o "sim" do jogador antes de ligar por padrão |
| Z invertido: regressão silenciosa de `polygonOffset` | r186 só inverte o fator (`WebGLState.js:871–875`) | marcações e lotes sobre asfalto com a chave ligada, câmera baixa e longe |
| Z invertido: céu/espaço/nuvem erram | profundidade escrita à mão (`environment.ts:138`, `space.ts:75`, `postprocess.ts`) | foto de céu, nuvens, ar do planeta, sombra de nuvem |
| Z invertido sem ganho | profundidade de 24 bits no canvas e no alvo | tipo da textura de profundidade; nível `low` |
| LOD de sombra some algo visível | corte por tamanho em texel cortando sombra legível | foto antes/depois em várias alturas de câmera; contagem de triângulos da passada de sombra |
| Programa novo ainda trava no primeiro uso | introspecção em `onFirstUse` | contagem de programas depois do aquecimento no F9; LoAF no primeiro traço |

---

## 5. O que NÃO foi possível ler

- **Unity:** só a página-índice de resolução dinâmica e a de controle de escala (S3); as páginas "Introdução" e "Controlar
  quando acontece" e a API `ScalableBufferManager` não foram abertas, então o comportamento exato por plataforma (WebGL
  incluído) não está confirmado.
- **Unreal:** a página de resolução dinâmica não dá os padrões das variáveis de ajuste nem a fórmula (S2); a página de métricas de
  streaming não foi relevante aqui. O código `DynamicResolution.cpp` (que a doc cita) não foi lido.
- **Intel:** li o PDF da Intel de 2011 inteiro, mas o código de exemplo e o vídeo da GDC (GDC Vault) não foram abertos; a fórmula
  do controlador aparece como figura no PDF e o texto extraído não a reproduz (só a descrição).
- **FSR:** a página do FSR 1 foi lida (S4); a do SDK 3.1.4 foi cortada em 100 000 de 171 587 caracteres, então a fórmula de viés
  de mip e o trato da resolução dinâmica no FSR 3 não foram lidos. Nenhuma implementação em WebGL do FSR foi aberta.
- **Z invertido:** a issue #31998 foi lida pelo resumo (lista de PRs e datas); não abri os PRs. O código do r186 foi lido por
  `grep` nos pontos citados, não linha a linha em todos os arquivos (SSAO/SAO/GTAO só pelas ocorrências de
  `USE_REVERSED_DEPTH_BUFFER`). Não verifiquei se há teste ou exemplo do r186 combinando Z invertido com `DepthTexture` flutuante
  multiamostrada; o três não exige `FloatType`, mas S10 diz que é o que dá o ganho.
- **Nada disto foi medido:** o custo de realocar alvos, o de desenhar a passada de sombra, o de introspecção do primeiro uso e o
  efeito de pixelRatio na GPU são hipóteses a medir; a captura sem tela usa a GPU Intel (UHD 770), não a RTX 3060, então os
  tempos de GPU de lá não valem para o jogador.
- **Compilação:** não li documentação do ANGLE sobre compilação em paralelo no D3D11; "ida-e-volta ao processo de GPU" vem do
  MDN (S5), não de medida deste jogo.
- **Sombras de luz pontual e VSM com Z invertido:** a issue ainda os lista em janeiro de 2026; o jogo não os usa, mas não conferi
  se algum material próprio usa `VSMShadowMap` (o renderer usa `PCFShadowMap`, `renderer.ts:497`).
