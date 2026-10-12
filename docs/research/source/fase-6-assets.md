# Fase 6 — Assets: KTX2/Basis, atributos quantizados, LRU por bytes

Pesquisa de 2026-10-11, ramo `agente/pesquisa` (a partir de `planeta-esfera` 27a7cb48). Só leitura de código;
nada foi rodado (nem jogo, nem testes, nem build, nem painel). three.js lido localmente é o r186
(`C:/Codex-Shared/roadcraft-planeta-esfera/node_modules/three`, versão 0.186.1), Vite 8.3.4 e meshoptimizer 1.2.0 do mesmo
`node_modules`, só para leitura.

Método e limite das fontes: as páginas da web vieram pela ferramenta de busca de páginas, que devolve um resumo extraído
por modelo (não o texto bruto). Quando a fonte era um arquivo de código ou texto pequeno, baixei o arquivo para a pasta
temporária da sessão e li eu mesmo (LRUCache.js, MemoryUtils.js, gltfpack.cpp e encodebasis.cpp, os dois últimos só nos
trechos citados). Onde a ferramenta avisou que cortou a página, está escrito na seção 5.

---

## 1. Perguntas que a fase precisa responder

1. O que o KTX2/Basis resolve neste jogo (memória de vídeo, custo de decodificar e subir textura) e o que ele piora
   (tamanho em disco, qualidade, acoplamentos do código atual)?
2. Qual formato de GPU o `KTX2Loader` do three r186 escolhe na máquina do jogador (RTX 3060, Windows, Chrome/Electron) e
   isso é o que queremos?
3. Qual perfil de codificação (ETC1S, UASTC, flags de `toktx`/`ktx create`/`basisu`) para cada tipo de textura do jogo
   (pele, roupa, cabelo com alfa, olhos, cartões de rosto)?
4. Como carregar o transcodificador (JS + WASM) com Vite 8 em dev, em build e dentro do Electron (`app://`), e como ele
   convive com o pool único de workers da fase 3?
5. Que atributos de vértice podem ser quantizados (KHR_mesh_quantization, atributos normalizados do three), com que erro,
   e o que isso economiza nas malhas deste jogo? Qual o cuidado para não abrir frestas entre peças vizinhas?
6. Como se faz um LRU por bytes (3DTilesRendererJS, Unity, Unreal) e onde ele entra aqui (hoje as texturas são contadas por
   referência e destruídas na hora)?
7. Como contar bytes de verdade, já que `renderer.info.memory` do r186 só tem contagens?

---

## 2. Fontes lidas

Convenção: S = fonte. "Lido" diz o que foi realmente aberto.

**S1. KTX Artist Guide (Khronos 3D-Formats-Guidelines)** — https://github.com/KhronosGroup/3D-Formats-Guidelines/blob/main/KTXArtistGuide.md
(ramo main, lido em 2026-10-11; a página não traz data). Cor base: ETC1S por padrão; exceção UASTC para texturas de muita
variação. Normais e ORM (oclusão/rugosidade/metal empacotados): UASTC, e o guia diz que ORM pode ter 1/4 da resolução da cor.
Comandos de exemplo com `toktx`: ETC1S `--t2 --encode etc1s --clevel 4 --qlevel 255`; UASTC `--t2 --encode uastc
--uastc_quality 4 --uastc_rdo_l .5 --uastc_rdo_d 65536 --zcmp 22`; para dados não-cor `--assign_oetf linear
--assign_primaries none`; mipmaps com `--genmipmap`. Números do exemplo (lâmpada de vitral): original 13 MB em arquivo e 96 MB
na GPU; em KTX de alta qualidade 10 MB em arquivo e 21 MB na GPU, "quase imperceptível"; só ETC1S deu blocos visíveis.
O pato (PNG 512x512, 118 KB e 1,5 MB na GPU) vira 116 KB e 277 KB com ETC1S. Dimensões: múltiplo de 4 (potência de 2
recomendada), nada acima de ~2048; origens em 8 bits por canal em PNG, evitar JPEG de origem porque o KTX amplifica os
artefatos. Não cobre: BasisLZ como opção separada, bits por pixel, alvos de transcodificação, arrays/cubos.

**S2. Subpágina `toktx` do Artist Guide** — https://github.com/KhronosGroup/3D-Formats-Guidelines/blob/main/subpages/KTXArtistGuide_toktx.md
(lida 2026-10-11). `--clevel` 0–5 (padrão 1), `--qlevel` 1–255 (padrão 128), `--uastc_quality` 0–4 (padrão 2; 3 é o limite
prático, 4 "impraticavelmente lento"), `--uastc_rdo_l` 0,001–10 (padrão 1,0; 0,25–0,75 para normais), `--uastc_rdo_d` 256–65536
(padrão 32768), `--zcmp` 1–22 (padrão 3; acima de 20 usa mais memória). A página oficial de manual do `toktx` retornou 404.

**S3. `ktx create` (KTX-Software, manual de referência)** — https://github.khronos.org/KTX-Software/ktxtools/ktx_create.html
(lida 2026-10-11; versão não exibida, a página cita a família 4.4+). `--format` é obrigatório; `--encode basis-lz|uastc`
(`uastc` é apelido antigo de `uastc-ldr-4x4`); ETC1S: `--clevel` 0–6 (padrão 1), `--qlevel` 1–255 (padrão 128), RDO
ligável/desligável; UASTC: `--uastc-quality` 0–4 (padrão 2), `--uastc-rdo` com `-l` (padrão 1,0), `-d` (padrão 4096), e a
página "recomenda fortemente" `--zstd` com UASTC (`--zstd` 1–22, não vale para ETC1S, que já é supercomprimido). Espaço de
cor: a opção hoje chama-se `--assign-tf` (não mais `--assign_oetf` do `toktx`); `--normal-mode` só para texturas lineares com
2+ componentes; mipmaps por `--generate-mipmap` (filtro padrão `lanczos4`, extremidade `clamp`); `--compare-ssim` e
`--compare-psnr` imprimem métricas de qualidade. Detalhe de cuidado: o resumo tem uma inconsistência interna sobre RDO no
basis-lz (diz desligado na seção comum, mas lista limiares padrão 1,25); conferir com `ktx create --help` da versão instalada
antes de roteirizar.

**S4. Especificação KTX 2.0** — https://github.khronos.org/KTX-Specification/ktxspec.v2.html (lida 2026-10-11, só os primeiros
100 000 de 291 791 caracteres). Estrutura: cabeçalho, índice, índice de níveis, DFD, pares chave/valor, dados globais de
supercompressão, níveis. `supercompressionScheme` 0 nenhum, 1 BasisLZ, 2 Zstandard, 3 ZLIB; BasisLZ exige
`vkFormat = VK_FORMAT_UNDEFINED`. Cada nível é supercomprimido separado; os dados dos níveis ficam no arquivo do menor para o
maior ("streaming": mostra-se um nível baixo antes de o resto chegar), enquanto o índice de níveis começa pelo maior. Níveis
de formatos em blocos precisam ser número inteiro de blocos; D3D11 e anteriores exigem largura e altura do nível 0 múltiplos
de 4. ETC1S e UASTC são "universais": precisam ser transcodificados para um formato de GPU antes de amostrar.

**S5. KHR_texture_basisu** — https://github.com/KhronosGroup/glTF/blob/main/extensions/2.0/Khronos/KHR_texture_basisu/README.md
(lida 2026-10-11). Largura e altura DEVEM ser múltiplos de 4; pirâmide de mips completa é recomendada; cor: primárias BT.709
e função de transferência sRGB; não-cor (normais): linear e primárias não especificadas; texturas de 1 ou 2 canais NÃO podem
ser sRGB. Orientação do arquivo `rd` ou omitida. Guia de escolha: cor em ETC1S, não-cor em UASTC; se ASTC e BC7 não existem,
UASTC não-cor deve ser decodificado para RGBA não comprimido, "para evitar artefatos".

**S6. KTX Developer Guide** — https://github.com/KhronosGroup/3D-Formats-Guidelines/blob/main/KTXDeveloperGuide.md (lida
2026-10-11). Tabelas de alvo por formato de entrada. ETC1S RGB: ETC1, depois BC7 ("desktop sem ETC"), depois BC1, depois
PVRTC1, depois RGBA8. ETC1S RGBA: ETC2, BC7, BC3. UASTC: ASTC 4x4 se houver, senão BC7 ("quase sem perda"), senão RGBA8; com
só S3TC, BC1 (opaco) ou BC3 (alfa). Bytes por bloco de 4x4: BC1 8, BC3 16, BC4 8, BC5 16, BC7 16, ETC1 8, ETC2 RGBA 16, ASTC 4x4
16; ou seja 0,5 ou 1 byte por pixel contra 4 do RGBA8. Transcodificar ETC1S para ETC1 não perde nada; ETC1S/UASTC para BC1/BC3
decodifica e recodifica; ASTC e BC7 são os alvos "rápidos e previsíveis" do UASTC. Dimensão base 1, 2 ou múltiplo de 4; cada
mip é a metade com truncamento. Vale também: o guia diz para usar a enumeração sRGB nas texturas de cor. O guia NÃO cobre
ordem de envio de mips nem tempos de transcodificação.

**S7. README do Basis Universal (v2.5)** — https://github.com/BinomialLLC/basis_universal (lida 2026-10-11 pelo resumo).
ETC1S: qualidade baixa a média, 0,3–3 bits por pixel, transcodifica para todos os formatos LDR. UASTC LDR 4x4: 8 bits por
pixel, subconjunto de 19 modos do ASTC LDR 4x4, com transcodificação particularmente rápida para ASTC e BC7; RDO opcional
deixa o dado mais compressível por LZ. `-linear` é para normais e conteúdo não fotográfico (ETC1S usa métrica sRGB por
padrão; UASTC sempre linear). Sem números de velocidade ("muito rápido").

**S8. Wiki do Basis: formatos de transcodificador** — https://github.com/BinomialLLC/basis_universal/wiki/Transcoder-Texture-Format-Support-for-ETC1S-and-UASTC-LDR-4x4
(lida 2026-10-11). Qualquer fatia ETC1S/UASTC LDR 4x4 pode virar qualquer formato de GPU listado. ETC1S para BC1 perde
~0,3–0,5 dB de PSNR em Y; BC4 e BC5 quase sem perda e muito rápidos (BC5 para normais); BC7 modo 6 quase sem perda mas com
tabelas enormes, modo 5 muito rápido; "recomenda-se desligar o BC7 inteiro" em plataformas onde o tamanho do transcodificador
pesa. A página só dá bpp para PVRTC1 (4).

**S9. gltfpack (meshoptimizer), código-fonte** — https://github.com/zeux/meshoptimizer/blob/master/gltf/gltfpack.cpp e
`gltf/encodebasis.cpp` (baixados 2026-10-11; li o texto de ajuda das linhas 1660–1740 e as linhas 20–135 do segundo).
Padrões de quantização: posições 14 bits (`-vp`), coordenadas de textura 12 bits (`-vt`), normais 8 bits (`-vn`), cores 8 bits
(`-vc`), posições como inteiros por padrão (`-vpi`); `-noq` desliga a quantização ("arquivos muito maiores"). Classes de
textura `color`, `normal`, `attrib` com modo e qualidade por classe; `-tc` ETC1S, `-tu` UASTC. Tabela de qualidade (`-tq`
1–10, padrão 8): ETC1S nível 1 com qualidade 192 e UASTC nível 1 com RDO 0,4 no padrão; `-tq 9` UASTC nível 2 RDO 0,2.
No codificador: mipmaps gerados no próprio codificador com `m_mip_srgb` para sRGB, métrica perceptual só para sRGB, ETC1S
sem RDO de seletor/endpoint quando a textura é mapa de normais, UASTC supercomprimido com Zstandard nível 9.

**S10. KHR_mesh_quantization** — https://github.com/KhronosGroup/glTF/blob/main/extensions/2.0/Khronos/KHR_mesh_quantization/README.md
(lida 2026-10-11). Tipos permitidos: POSITION em byte/short (normalizado ou não, com ou sem sinal); NORMAL e TANGENT em
byte/short normalizado; TEXCOORD em byte/short/ubyte/ushort com ou sem normalização. Decodificação por transformação do nó
(ou `inverseBindMatrices` em malhas com pele; uma escala uniforme preserva as normais) e `KHR_texture_transform` para UV.
Cada atributo precisa alinhar a 4 bytes: normal em byte tem passo 4, não 3. O exemplo do documento: PBR estático com posição,
UV, normal e tangente cai de 48 para 20 bytes por vértice, "efeito geralmente desprezível" na qualidade. Cuidados escritos
lá: normais quantizadas deixam de ter comprimento 1 e precisam ser renormalizadas; `accessor.min/max` ficam em unidades
quantizadas; faixa por malha dá erro menor mas pode causar frestas visíveis e impedir o compartilhamento de materiais, ao passo
que uma transformação única de cena evita as frestas e aumenta o erro; em WebGL 1 / GLES2 os normalizados com sinal podem
decodificar diferente.

**S11. README do meshoptimizer** — https://github.com/zeux/meshoptimizer (lido 2026-10-11, 100 000 de 107 228 caracteres).
O codificador de vértices é sem perda e espera dados já quantizados e ordenados por busca de vértices; razão típica 2–4x sobre
dados quantizados bem empacotados; decodifica a 3–6 GB/s em CPU de mesa. Índices: 1–1,2 byte por triângulo em malhas reais.
Filtros de decodificação com perda: octaédrico para normais/tangentes (2–16 bits), quaternion, exponencial, cor (YCoCg).
Recomenda quantizar com bits que não são múltiplos de 8 (por exemplo UV 12 bits dividido por 4095) e meia precisão
("frequentemente bom"). O pacote instalado aqui (1.2.0, `package.json:54`) exporta `./encoder`, `./decoder`, `./simplifier`
(`node_modules/meshoptimizer/package.json`, exports): o jogo usa só o simplificador (`src/render/mesh/simplify.ts:3`,
`src/render/people/crowdLod.ts:3`, `lodWorker.ts:1`, `personRig.ts:1`).

**S12. LRUCache do 3DTilesRendererJS (código inteiro, 505 linhas)** — https://github.com/NASA-AMMOS/3DTilesRendererJS/blob/master/src/core/renderer/utilities/LRUCache.js
(baixado e lido por mim em 2026-10-11). Limites por contagem (`minSize` 6000, `maxSize` 8000) e por bytes (`minBytesSize`
0,3 GiB, `maxBytesSize` 0,4 GiB, só vale com three r166+). `unloadPercent` 5%: cada passada tira só essa fração do excesso,
repartindo a descarga em vários quadros (reagenda por `requestAnimationFrame`, execução em microtarefa). Itens "usados" na
passada não saem; itens ainda não carregados (`setLoaded(false)`) podem sair mesmo usados. `add()` devolve `false`, sem erro,
se o cache está cheio ou o item já existe. Se tudo está em uso o cache fica acima do limite e `isFull()` continua verdadeiro.
A ordenação de candidatos é `itemList.sort(...)` a cada passada (O(n log n)). Cuidado de leitura: o comparador padrão
(`defaultPriorityCallback = item => itemSet.get(item)`) recebe um item só, e a ordenação faz `-unloadPriorityCallback(a, b)`:
com esse padrão o comparador ignora `b`. A biblioteca sobrescreve o comparador em uso normal; não copiar o padrão.

**S13. MemoryUtils do 3DTilesRendererJS (115 linhas)** — https://github.com/NASA-AMMOS/3DTilesRendererJS/blob/master/src/three/renderer/utils/MemoryUtils.js
(baixado e lido por mim em 2026-10-11). Como a biblioteca conta bytes: textura comprimida = soma de `mipmaps[i].data.byteLength`;
textura não comprimida = `TextureUtils.getByteLength(w, h, formato, tipo)` e multiplica por 4/3 se `generateMipmaps`;
geometria = `estimateBytesUsed` do `BufferGeometryUtils`; conjunto de deduplicação para não contar duas vezes; textura de fora
do three declara o tamanho em `userData.byteLength`. `lruCache.setMemoryUsage(item, bytes)` guarda o número inteiro por item
(o comentário explica: inteiros mantêm a soma incremental igual à soma dos tamanhos).

**S14. Unity, "Configure mipmap streaming"** — https://docs.unity3d.com/Manual/TextureStreaming-configure.html (lida
2026-10-11). `Memory Budget` limita a memória de GPU para texturas, somando as com streaming e as sem (exemplo do manual: 100 MB
de orçamento e 90 MB de texturas sem streaming deixam 10 MB). Estourado o orçamento, a Unity carrega mips menores
e remove mips não usados. `Max Level Reduction` é o piso: mips acima desse nível ficam sempre residentes, "mesmo que exceda o
orçamento", e é também o nível carregado na partida. Viés de mip por câmera. Os valores padrão não estão na página.

**S15. Unreal, "Texture Streaming Configuration" (UE 5.8)** — https://dev.epicgames.com/documentation/en-us/unreal-engine/texture-streaming-configuration-in-unreal-engine
(lida 2026-10-11). `r.Streaming.PoolSize` é a verba em MB para texturas de interface, `NeverStream`, cubemaps e streaming
(0 = ilimitado); `r.Streaming.MipBias` global corta os maiores mips para caber; `r.Streaming.UsePerTextureBias` aplica a cada
textura um viés entre 0 e `MipBias` conforme o orçamento; `MaxEffectiveScreenSize` limita a resolução desejada; quando
desligado o streaming, todos os mips carregam. A página não diz como o uso do pool é medido, nem valores padrão (só um). A
página "Texture Streaming in Unreal Engine" é um esqueleto sem conteúdo.

**S16. web3dsurvey.com** — extensões WebGL2 `WEBGL_compressed_texture_etc`, `WEBGL_compressed_texture_astc`,
`EXT_texture_compression_bptc`, `WEBGL_compressed_texture_s3tc` (quatro páginas lidas em 2026-10-11, sem data publicada).
Suporte no Windows: BPTC 99,72%, S3TC 99,96%, ETC 2,61%, ASTC 2,6%. No geral: BPTC 83,24%, S3TC 85,42%, ETC 49,93%, ASTC 49,35%.
Os números por plataforma são amostra de navegadores, não de GPUs; servem de ordem de grandeza.

**S17. Especificações de extensão do WebGL** — `WEBGL_compressed_texture_etc` (revisão 7, 30/09/2016), `EXT_texture_compression_bptc`
(revisão 6, 07/07/2020), `WEBGL_compressed_texture_s3tc` (lidas 2026-10-11; https://registry.khronos.org/webgl/extensions/).
ETC: o navegador não deve anunciar a extensão quando a implementação só a suporta descompactando. BPTC: 16 bytes por bloco 4x4;
`width << level` e `height << level` múltiplos de 4 em cada nível (na prática: a base é múltiplo de 4); formato sRGB
`COMPRESSED_SRGB_ALPHA_BPTC_UNORM_EXT`. S3TC: `compressedTexSubImage2D` aceita largura/altura igual à do nível ou múltiplo de 4;
`compressedTexImage2D` exige múltiplo de 4 (sem exceção para níveis pequenos) — é por isso que o três usa
`texStorage2D` + `compressedTexSubImage2D` (S21).

**S18. Vite 8.3.4, código do próprio pacote** — `node_modules/vite/dist/node/chunks/node.js` (lido 2026-10-11). O plugin
`vite:asset-import-meta-url` (linhas 27296–27390) reescreve `new URL('x', import.meta.url)` com regex que casa o formato usado no
KTX2Loader; ele é registrado na lista de plugins principal (linha 34075). O otimizador de dependências do Vite 8
(`prepareRolldownOptimizerRun`, linhas 28677–28703) monta o bundle com `pluginsFromConfig` (de `optimizeDeps.rolldownOptions.plugins`)
mais `rolldownDepPlugin`; não inclui esse plugin. Documentação: https://vite.dev/guide/assets.html diz que em dev
`new URL(..., import.meta.url)` "funciona nativamente nos navegadores" e na build é transformado; não diz nada sobre
dependências nem sobre `.wasm`.

**S19. three r186, KTX2Loader.js** — `node_modules/three/examples/jsm/loaders/KTX2Loader.js` (1276 linhas; lido 2026-10-11 nos
trechos 100–365, 395–520, 690–960 e 1230–1276). Ver seção 3.3 e 3.4.

**S20. three r186, atributos** — `src/core/BufferAttribute.js` (normalized: 94–100, `getX`: 389; `Float16BufferAttribute`: 862),
`src/renderers/webgl/WebGLAttributes.js` (tipos aceitos, inclui `Float16Array` nativo e `Uint16Array` marcado como meia
precisão), `WebGLBindingStates.js` (normalized passa a `vertexAttribPointer`; inteiros não normalizados com `gpuType = IntType`
vão por `vertexAttribIPointer`, linhas 301–357), `WebGLMorphtargets.js` (24–100), `examples/jsm/utils/BufferGeometryUtils.js:617`
(`estimateBytesUsed`), `src/renderers/webgl/WebGLInfo.js:5` (`memory` só tem `geometries` e `textures`).

**S21. three r186, textura comprimida** — `src/renderers/webgl/WebGLTextures.js:1032–1120` (para `CompressedTexture` usa
`texStorage2D` com todos os níveis e `compressedTexSubImage2D` por nível), `src/renderers/webgl/WebGLUtils.js:161–171` (formato BPTC
com transferência sRGB vira `COMPRESSED_SRGB_ALPHA_BPTC_UNORM_EXT`), `src/textures/CompressedTexture.js:67,80` (`flipY = false`,
`generateMipmaps = false`).

---

## 3. O que se aplica a este código

### 3.1 O que há em disco e quanto custaria na GPU (conta minha, a partir dos arquivos)

Texturas de `public/models/people` (medi cabeçalhos WebP e somei tamanhos em disco):

| conjunto | quantidade | lado | WebP médio | WebP total |
|---|---|---|---|---|
| peles (`skins`) | 39 | 1024 | 72,6 KB | 2,9 MB |
| roupas, cabelos, cartões (`proxies`, sem `-thumb`) | 203 | 256 | 11,6 KB | 2,4 MB |
| idem | 282 | 512 | 39,7 KB | 11,5 MB |
| miniaturas `-thumb.webp` (interface do criador, 160 px) | 499 | 160 | — | não vão à GPU como textura de malha (`src/ui/creator/creator.ts:409` usa `<img>`) |

Correção de leitura: o "984 arquivos de roupa" visto antes inclui as 499 miniaturas; as texturas de roupa/cabelo/cartão de
verdade são 485.

Se todas estivessem residentes ao mesmo tempo (limite superior, não é o caso real), com mips (x 4/3):

| formato | peles | 256 px | 512 px | total |
|---|---|---|---|---|
| RGBA8 (hoje) | 218 MB | 71 MB | 394 MB | 683 MB |
| BC7 / ASTC 4x4 (1 byte/pixel) | 55 MB | 18 MB | 99 MB | 171 MB |
| BC1 (0,5 byte/pixel, só opaco) | 27 MB | 9 MB | 49 MB | 85 MB |

O que fica residente de verdade depende de quem está perto: uma pessoa usa 1 pele e até `MAX_TEXTURED = 5` roupas
(`src/render/people/garmentSlots.ts:5`, `.slice(0, MAX_TEXTURED)` na linha 18); no pior caso por pessoa são 5,6 + 5 x 1,4 = 12,6 MB
em RGBA8 contra 3,1 MB em BC7. O número que importa (quantas texturas distintas ficam residentes com 400 pessoas) ainda não foi
medido; ver seção 4.

Disco: o KTX2 não diminui o disco aqui. O WebP com perda de 512 px custa em média 39,7 KB; UASTC é 8 bits por pixel antes de
Zstandard (S7), ou seja ~350 KB por textura de 512 px com mips, e mesmo com RDO + `--zstd` não conheço a razão sem codificar
amostras. ETC1S (0,3–3 bpp, S7) ficaria perto do WebP, com a perda de qualidade que o guia mostra (S1). A economia do KTX2 é
memória de GPU, custo de decodificação (some o `createImageBitmap` + `generateMipmap`) e custo de envio (4x menos bytes por
`compressedTexSubImage2D`); isso precisa ser medido, não presumido.

### 3.2 Acoplamentos do código atual que o KTX2 quebra ou exige tratar

Estes quatro são o que mais pesa na decisão, e nenhuma fonte externa os revela; vêm da leitura do código:

1. **Leitura de pixels na CPU.** `src/people/body/proxy.ts:166–203` (`SAMPLE_SIZE = 256`) decodifica cada textura de roupa em
   `ImageBitmap`, reduz e lê os pixels (`getImageData`) para as cores de vértice da multidão; `generator/stage.ts:660–672`
   (`averageLightness`) lê esses pixels. Textura comprimida na GPU não se lê na CPU. Solução possível (hipótese): calcular a
   cor média/amostra na importação e guardá-la no JSON do item (`scripts/import-makehuman-proxies.mjs`), eliminando também
   uma decodificação de WebP por roupa carregada (a roupa hoje é decodificada duas vezes: aqui e no worker de preenchimento).
2. **Preenchimento (padding) das ilhas de UV.** `skinAppearance.ts:525–620` (`GARMENT_PAD = 12`, `paddedGarment`) preenche as
   ilhas em worker e sobe um `DataTexture` com `generateMipmaps = true`. O resultado só depende da textura e das UVs do item,
   que são estáticas: dá para fazer na importação, antes de codificar (a ordem tem que ser preencher, depois gerar mips e
   codificar). Risco visual novo: a codificação trabalha em blocos de 4x4 com extremos compartilhados, então a costura
   "marrom" que o comentário descreve (`skinAppearance.ts:575`) pode voltar nos mips menores, onde 12 px de margem viram 6, 3, 1,5 px
   (conta minha); precisa de olhar.
3. **Cartões de rosto num array.** `skinAppearance.ts:14–61` junta sobrancelha/cílios (256 px, 24 camadas) num `DataArrayTexture`
   copiando `texture.image` por `drawImage`; um `CompressedTexture` não tem `image` desenhável. Duas saídas: manter WebP nos
   cartões, ou gerar o array pronto em KTX2 (o `KTX2Loader` devolve `CompressedArrayTexture` quando `layerCount > 1`,
   `KTX2Loader.js:447–448`).
4. **Inversão vertical.** Peles são carregadas com `flipY = true` por `createImageBitmap` (`skinAppearance.ts:123–135`);
   `CompressedTexture` tem `flipY = false` (`CompressedTexture.js:67`) e o envio de textura comprimida não vira a imagem. A
   inversão tem que ser feita na codificação (`ktx create` tem `--convert-texcoord-origin`, S3; o gltfpack tem `-tfy`, S9). Não
   consegui confirmar no texto do WebGL 2.0 que `UNPACK_FLIP_Y_WEBGL` não vale para `compressedTexImage` (S4/seção 5); a conclusão
   segura é codificar já na orientação certa.

Além disso: cabelo e cartões têm alfa (`item.transparent`, `skinAppearance.ts:170`). ETC1S guarda alfa em fatia separada (S4) e o
guia reserva ETC1S para cor sem variação; para cabelo com alfa, UASTC e olhar as bordas.

### 3.3 Que formato o three r186 escolhe nesta máquina

`KTX2Loader.detectSupport` (`KTX2Loader.js:230–280`) monta a configuração com as extensões do contexto; a tabela
`FORMAT_OPTIONS` (`:793–883`) e `getTranscoderFormat` (`:899–921`) escolhem por prioridade:

- UASTC: ASTC (1) > BC7 (2) > ETC2 (3) > ETC1 (4) > BC1/BC3 (5) > PVRTC (6).
- ETC1S: ETC2 (1) > ETC1 (2) > BC7 (3) > BC1/BC3 (4) > PVRTC (5).

No Windows com Chrome/Electron (S16): BPTC 99,7%, S3TC 99,96%, ETC e ASTC ~2,6%. Para a RTX 3060 isso quer dizer, quase certamente:
**UASTC e ETC1S saem em BC7 (modo 5), 1 byte por pixel**, não em BC1 (0,5 byte). Consequência: a economia de memória em
relação ao RGBA8 é 4x para os dois, e ETC1S não oferece vantagem de VRAM sobre UASTC, só de arquivo. Se quisermos BC1 nas
peles opacas (metade da memória, perda de ~0,3–0,5 dB, S8), o loader não deixa escolher por textura: seria preciso uma segunda
instância com `workerConfig.bptcSupported = false` (o aviso "Multiple active KTX2 loaders" de `KTX2Loader.js:345–358` aparece) ou
uma subclasse com tabela própria. Decisão de qualidade, a medir olhando.

Armadilha do three para conferir: a tabela favorece ETC2 antes de BC7 para ETC1S. Na Linux/Mesa o three desliga ETC/ASTC
(`:260–270`, comentário sobre emulação por software no driver). No Windows/ANGLE os números de S16 e a regra de S17 (não
anunciar o que é emulado) sugerem que não há ETC2, mas só `gl.getSupportedExtensions()` na máquina do jogador confirma. (Nesta
sessão não pude consultar: a captura sem tela usa a GPU Intel, não a RTX; ver nota da memória do projeto.)

Dimensões: `KTX2Loader.js:726` avisa se a base não for múltipla de 4; todas as texturas do jogo (256, 512, 1024) são.

### 3.4 Como o transcodificador chega ao navegador (Vite 8, Electron, pool de workers)

- `KTX2Loader.js:106–107` define as URLs padrão com `new URL('../libs/basis/basis_transcoder.wasm', import.meta.url)`. Em
  build o plugin do Vite reescreve (S18, a regex está na linha 27307 e casa o formato). Em dev, se o `three/addons/loaders/KTX2Loader.js` for
  pré-empacotado (o jogo já importa vários `three/addons/...`, por exemplo `GLTFLoader` em `referenceModel.ts:2`, e
  `vite.config.ts:37` faz `optimizeDeps.entries = ['*.html']`), o otimizador do Vite 8 usa só `rolldownDepPlugin` + plugins do
  usuário (S18, linhas 28677–28703) e o `import.meta.url` do arquivo pré-empacotado fica em `node_modules/.vite/deps/`. Isto é
  leitura do código do Vite, não observação: não rodei. A defesa é não depender do padrão: `loader.setTranscoderPath(pasta)` com
  uma pasta que o projeto serve com nomes fixos.
- O projeto não serve `public` (`vite.config.ts:31`, `publicDir: false`); os modelos vão por `model-urls-plugin.ts` (dev: caminho
  direto do arquivo, linha 51; build: `emitFile` com nome hash, linhas 54–55). Os dois arquivos do transcodificador
  (`basis_transcoder.js` 57 KB e `.wasm` 527 KB em `three/examples/jsm/libs/basis/`) precisam de nome fixo porque o loader
  concatena `transcoderPath + 'basis_transcoder.js'` (`KTX2Loader.js:303–307`); o `emitFile` do Rollup/Rolldown aceita `fileName`
  para isso (não li a doc do Rolldown; a opção existe na API do Rollup, ponto a verificar).
- Electron: `desktop/main.cjs:26` registra `app://` como esquema privilegiado com `fetch` e o comentário do arquivo diz que "fetch
  e wasm funcionam"; `protocol.handle` na linha 59 serve o `dist/`. Não há CSP em `index.html` (busca sem resultado), então o
  `Worker` criado de `Blob` (`KTX2Loader.js:334`) não é bloqueado. O WASM é compilado dentro desse worker.
- Pool: o loader cria o próprio `WorkerPool` (`:157`, padrão 4 workers, fila FIFO sem prioridade nem cancelamento,
  `examples/jsm/utils/WorkerPool.js`), `setWorkerLimit` em `:196`. Tem de entrar no orçamento de threads da fase 3 (máquina de
  jogo: nada de saturar a CPU): `setWorkerLimit(1)` ou 2, uma única instância, `dispose()` ao sair. Encaixar na fila única com
  prioridade da fase 3 exigiria trocar `loader.workerPool` por um adaptador com `postMessage(msg, transfer)`, `setWorkerCreator`,
  `setWorkerLimit` e `dispose`; é o que o loader chama (`:497`), mas é campo interno: frágil entre versões.
- Cache interno: `_taskCache` (`:109`, `WeakMap` por buffer) devolve a mesma promessa se o mesmo buffer for passado duas vezes; o
  buffer é transferido ao worker (`:497`), então não reaproveitá-lo.
- Os mips chegam transcodificados como `Uint8Array` por nível (`:712–772`) e ficam no `Texture.mipmaps` depois do envio: há
  uma cópia na memória do JS por textura enquanto o objeto viver. Liberar depois do `initTexture` é possível, mas não
  testei se o jogo precisa dela (perda de contexto); medir o heap com `scripts/probe-memory.mjs:21–40`.

### 3.5 Atributos quantizados

O que o three r186 aceita sem código novo: `BufferAttribute(array, itemSize, normalized)` com `Int8/Uint8/Int16/Uint16Array`; o
`vertexAttribPointer` recebe `normalized` (`WebGLBindingStates.js:301–309`); o shader lê `float`. `Float16BufferAttribute` existe
(`BufferAttribute.js:862`, guarda `Uint16Array`), e `WebGLAttributes` trata `Float16Array` nativo; qual Chromium o Electron 44 traz
não verifiquei. Normalizados não valem para `IntType`/`gpuType` inteiro (`:357`).

Onde está o volume no jogo (bytes por vértice hoje, leitura de código; candidato ao lado):

| malha | hoje | arquivo:linha | candidato |
|---|---|---|---|
| superfície de via | 44 B (pos f32x3, normal f32x3, uv f32x2, cor f32x3) | `render/mesh/surfaceMesh.ts:391–397` | 20 B: pos Int16x3 (passo 8), normal Int8 normalizado (4), uv Int16 (4), cor Uint8 normalizado (4) |
| terreno | 48 B (idem + `aBelow` f32) | `render/terrain.ts:2388–2392` | ~24 B |
| casca de prédio | 48 B (pos, normal, cor, uv, `aDecay`) | `render/buildings/buildingMesh.ts:3201–3205` | ~24 B |
| LOD da multidão | pos+normal f32, `skinIndex` u16x4, `skinWeight` f32x4, `aRefs`/`aRefW`, `aFar` f32x4 | `render/people/crowdLod.ts:253,274,283` | peso Uint8 normalizado, `aFar` em Uint8 |
| corpo cozido | tipos já gravados no arquivo (`f32`, `u32`, `u16`, `u8` + `normalized`) | `render/people/cookedPerson.ts:20–33,167` | o formato já suporta; é só mudar os tipos no cozimento |

O formato cozido de pessoas já tem `normalized` por atributo (`cookedPerson.ts:22`) e o carregador lê `u32` para índices (`:168`);
falta só escolher tipos menores no cozimento (`:112–115`). As fontes de rosto já são `int16 * escala` em disco (`faceunits.json`:
"delta = int16 * scale"), isto é, o jogo já usa o mesmo princípio.

Contas e cuidados:
- Passo de grade. Int16 normalizado sobre uma célula de 250 m dá 250/65535 = 3,8 mm; meia precisão tem passo de 2^(e-10): entre 64 e
  128 m do centro da célula, 6,25 cm; entre 128 e 256, 12,5 cm (conta minha). Para geometria local de célula, inteiro uniforme
  ganha de meia precisão. Meia precisão serve para o corpo de uma pessoa (±2 m, ~1–2 mm).
- Frestas (S10, "faixa por malha pode causar frestas"). O jogo tem invariantes de continuidade (altura da via contínua, placas de
  cruzamento planas, `CLAUDE.md` raiz). Proposta (minha): grade de quantização absoluta, passo potência de 2 (por exemplo
  2^-8 m = 3,9 mm), origem de cada célula múltipla do passo; assim o mesmo vértice de borda cai no mesmo valor nas duas células.
  Teste que impede a volta do defeito: o desvio para a posição em float é ≤ passo/2 e vértices de borda coincidem bit a bit.
- Decodificação: no three, a matriz do objeto absorve escala e deslocamento (nos instanciados, a `instanceMatrix`); em
  `SkinnedMesh` a `bindMatrix` (S10 diz `inverseBindMatrices`; no three o análogo é a combinação `bindMatrix`/`boneInverses`:
  hipótese a testar). O dobramento do planeta (`render/planet/bend.ts`) lê a posição no sombreador depois da matriz do modelo
  (fase 5), então a quantização por célula combina com a peça por objeto.
- UV de textura que repete (marcações, asfalto) ultrapassa [0,1]: guardar Int16 não normalizado e escalar no material. Os
  materiais padrão do three aplicam `Texture.repeat/offset` no sombreador (`uv_vertex.glsl.js:9`); materiais próprios do jogo
  precisam do mesmo uniforme.
- Morph targets: `WebGLMorphtargets.js:24–100` empacota todos os alvos numa `DataArrayTexture` `FloatType` RGBA, 16 bytes por
  vértice por alvo, só posição (o `fromBufferAttribute` respeita `normalized`, então os alvos podem ficar quantizados em
  disco e na memória do JS, mas na GPU viram float de qualquer jeito). A multidão tem 13 canais (11 em `faceExpression.ts:22–34`
  mais 2 de olhar, `facialMorphs.ts:8`) sobre uma malha base de 19 158 vértices: 19 158 x 16 x 13 = 4,0 MB por geometria
  única (conta minha); `estimateBytesUsed` (S20) NÃO conta isso nem o `morphAttributes`.
- O que a economia vale: ~55% nos vértices, que só importa em mapas enormes (é geometria derivada por célula, fase 5). Para
  pessoas, a memória de vértice é MB, e a de textura é centenas de MB. A ordem de valor é textura, depois geometria por célula.
- Compressão em disco do meshoptimizer (S11): requer quantização prévia; ganho típico 2–4x sobre dado quantizado. O decodificador
  do pacote instalado é um arquivo único de 29 KB (`node_modules/meshoptimizer/meshopt_decoder.mjs`, sem `.wasm` ao lado: não
  tem o problema de caminho do Basis) e tem `useWorkers`. Só vale se o disco/entrada do arquivo virar gargalo; hoje o
  cozimento já grava buffers brutos alinhados (`cookedPerson.ts`).

### 3.6 LRU por bytes

Estado atual: `skinAppearance.ts:526–563` (`acquireTexture`) conta referências e **destrói a textura quando a última referência
sai** (`held.texture.dispose()`, linha 559); `PADDED`, `SKINS`, `CARDS` são `Map<string, TextureEntry>`. Quem veste uma roupa
pela primeira vez paga de novo a busca, a decodificação, o preenchimento no worker e o envio (`uploads.ts:34–40`, uma textura por
quadro, `renderer.ts:3782`). Não há orçamento de bytes em lugar nenhum; o `terrainAtlas`/`flatAtlas` usam contagens
(fase 5). `info.memory` do three só conta objetos (`WebGLInfo.js:5`); o único contador de bytes do repositório é o
`scripts/probe-memory.mjs:21–40` (`geoMB`, `morphMB`, `sceneTexMB`), que conta `largura x altura x 4` sem mips e ignora textura
comprimida.

O que as fontes ensinam (S12–S15):
- Contabilidade por item, em inteiros, com conjunto de deduplicação (S13); textura comprimida = soma dos `mipmaps[i].data`.
- Dois níveis (mínimo e máximo) com descarga em fatias de 5% por passada, para não parar um quadro com `dispose` de centenas de
  objetos (S12).
- Não despejar o que está em uso; permitir ficar acima do orçamento quando tudo está em uso (S12 é explícito, e a Unity chama de
  `Max Level Reduction`: um piso sempre residente, S14).
- Em vez de expulsar a textura inteira, baixar a resolução das de menor prioridade (viés de mip por textura, S15). Em three com
  textura comprimida isso é `mipmaps.slice(k)` (ou carregar só os níveis menores: o KTX2 guarda os níveis do menor para o maior,
  S4, o que permite buscar a cauda do arquivo primeiro).
- A busca de candidatos do 3DTilesRendererJS ordena a lista inteira a cada passada. Com algumas centenas de texturas basta um
  `Map` do JavaScript usado como LRU (inserção refeita ao usar; a ordem de iteração do `Map` é a de inserção, propriedade da
  especificação do ECMAScript que não reabri nesta sessão) com a lista de "ociosas" separada da de "em uso".

Onde entraria aqui, em ordem de valor: (1) pele/roupa/cartão: `acquireTexture` passa a mover a entrada para uma lista ociosa
quando as referências chegam a zero e só destrói quando os bytes ociosos passam do orçamento; (2) geometria derivada por célula
(fase 5), com a contagem de bytes de `estimateBytesUsed` mais os morphs; (3) camadas de atlas de terreno, trocando a contagem
atual por bytes. O orçamento de bytes por nível de qualidade ficaria em `render/quality.ts` (hoje o `QualitySettings`,
`quality.ts:15–75`, não tem campo de memória), como a `Memory Budget` da Unity (S14) e o `PoolSize` da Unreal (S15). Não há API do
WebGL para perguntar a memória de vídeo livre; o orçamento é constante por nível.

### 3.7 Ordem proposta e critérios (nada disto foi feito)

1. **Medir antes.** Estender `probe-memory.mjs` para contar texturas com mips e `CompressedTexture`, geometria com `morphAttributes` e
   `InstancedBufferAttribute`, e registrar `nvidia-smi --query-gpu=memory.used` (ver fase 0) com 400 pessoas. Critério: saber
   quantos MB de textura de pele/roupa estão residentes de fato; sem isso, nenhuma das mudanças seguintes tem alvo.
2. **Piloto com as 39 peles.** São opacas, sem preenchimento, sem leitura de pixel na CPU, 218 MB para 55 MB em BC7. Codificar
   com UASTC (nível 2, `--zstd`) e depois ETC1S; comparar com `--compare-ssim`/`--compare-psnr` (S3) e a olho com a câmera
   baixa e perto. Medir: bytes na GPU, ms de `initTexture`, ms de decodificação fora da tela, tamanho em disco.
3. **Contabilidade e LRU** sobre `acquireTexture`, ainda sem KTX2 (vale com WebP também).
4. **Roupas** (preenchimento e amostra de cor na importação, alfa, cartões).
5. **Quantização** só nas malhas por célula, depois da fase 5.

---

## 4. Riscos e o que medir

| risco | por que | o que medir |
|---|---|---|
| BC7 em vez de BC1 / ETC2 inesperado | tabela do KTX2Loader (S19) x suporte real do ANGLE nesta máquina | `gl.getSupportedExtensions()` na RTX 3060 (não na iGPU Intel da captura sem tela) e `texture.format` devolvido |
| Qualidade (blocos 4x4, costuras nos mips menores) | ETC1S visivelmente pior (S1); borda de ilha de UV (3.2) | fotos lado a lado, câmera baixa e perto, e `--compare-ssim` |
| Disco e entrada maiores que o WebP | UASTC 8 bpp antes de Zstandard (S7) | tamanho de 5 amostras reais por classe |
| Pico de CPU na decodificação de KTX2 | WASM em worker (S19); 4 workers por padrão | ms por textura no worker, `setWorkerLimit` 1–2 |
| Transcodificador não carrega em dev ou no Electron | URL padrão cai em `.vite/deps` (3.4) | requisição de rede de `basis_transcoder.wasm` em 5173, 4180 e `app://` |
| Cópia dos mips no heap do JS | `Texture.mipmaps` fica após o envio (3.4) | `heapMB` do probe antes/depois |
| Frestas por quantização | grades diferentes na mesma borda (S10) | teste: vértices de borda iguais bit a bit, desvio ≤ passo/2 |
| LRU que expulsa o que está na tela | item "em uso" mal marcado (S12) | contagem de reenvios de textura por quadro; nenhum `dispose` de textura visível |
| LRU acima do orçamento sem aviso | "tudo em uso" deixa estourar (S12) | alarme do F9 (`core/health.ts`) quando os bytes passam do teto por N quadros |
| Alvo não-cor (normais) em BC7 | o KTX2Loader não usa BC5 (a tabela só tem formatos RGBA) | olhar a iluminação; custo é o mesmo 1 byte/pixel |

Cuidado de método: a compressão com perda é troca visual por velocidade (decisão do jogador, `CLAUDE.md`: "small visual trade-offs
for speed are yours to decide"), mas retirar uma característica ou mudar jogabilidade pede o sim dele. Manter o WebP como
reserva (se o `.ktx2` faltar, carrega o `.webp`) mantém o jogo funcionando durante a migração.

---

## 5. O que NÃO foi possível ler

- **Especificação KTX 2.0:** só 100 000 de 291 791 caracteres (parte final, com o apêndice de dados globais do BasisLZ e detalhes
  do DFD, não lida).
- **README do meshoptimizer:** 100 000 de 107 228 caracteres; **documento da extensão EXT_meshopt_compression:** não aberto.
- **Especificação WebGL 2.0:** a ferramenta só mostrou os primeiros 100 000 de 199 119 caracteres e a parte sobre
  `compressedTexImage`/`UNPACK_FLIP_Y_WEBGL` não apareceu. Por isso a regra "inverter na codificação" (3.2) é prudência, não
  citação.
- **Manual `toktx` oficial:** 404; só a subpágina do Artist Guide e `ktx create` (S2, S3). Os nomes de opção diferem entre os dois
  (`--assign_oetf` x `--assign-tf`; sublinhado x hífen).
- **Wiki do Basis:** só o índice e a página de formatos de transcodificador (S8). As páginas "opções da linha de comando do
  basisu", "níveis de esforço do ETC1S" e "especificação do UASTC LDR 4x4" não foram abertas; tempos de transcodificação do WASM
  não encontrei em nenhuma fonte lida.
- **Unity:** só a página "Configure mipmap streaming"; a página raiz é um índice e as de "Introdução" e "Analisar" não foram
  abertas (valores padrão de orçamento não confirmados). **Unreal:** a página de configuração; a de "Texture Streaming in Unreal
  Engine" é um esqueleto e a de métricas não foi aberta (como o pool mede uso não está na página).
- **Vite:** a documentação não trata de dependências; o comportamento em dev do `new URL(..., import.meta.url)` dentro de
  `node_modules/.vite/deps` vem da leitura do código do Vite 8.3.4 e não foi observado. Não li a documentação do Rolldown
  (opção `fileName` de `emitFile`).
- **Extensões do WebGL no Windows:** os percentuais do web3dsurvey são sem data e por navegador, não por GPU. Não há consulta
  direta à RTX 3060 (a captura sem tela usa a GPU Intel).
- **Ferramentas:** `ktx`, `toktx`, `basisu`, `gltfpack` e `gltf-transform` não estão instalados nesta máquina (`where` sem
  resultado); não li sobre empacotadores em JavaScript puro para o cozimento.
- **Electron 44:** qual versão de Chromium (para `Float16Array`) não verifiquei.
- **Crowd:** a lista exata de atributos de um corpo cozido em `cooked/people/*.bin` não está no ramo (é gerada); os bytes por
  vértice da multidão são só os de `crowdLod.ts:253,274,283`.
