# PROMPT — auditoria de desempenho e de imagem, e as correções

Instrumento de trabalho. Cola este texto inteiro numa sessão nova do repositório
`C:/Codex-Shared/roadcraft-2`. Ele diz O QUE fazer e COMO medir; as regras de
conduta valem por inteiro de `CLAUDE.md` (pesquisa antes de cada mudança, uma
sessão escrevendo, `npm run check` verde, verificação no navegador, commit e
push). Este arquivo não substitui o `CLAUDE.md`: onde os dois divergirem, vale o
`CLAUDE.md`.

Foi escrito depois da rodada de 2026-10-13 (commit `f9ec89d`), com o que
funcionou e com o que deu falso positivo. A seção 8 é a lista de falsos
positivos já pagos: leia antes de investigar.

---

## 1. Objetivo e critério de pronto

Deixar o jogo **rápido** (quadro folgado na cidade grande) e **bonito** (sem
serrilhado nem embaçamento no zoom próximo), sem tirar recurso, sem baixar
qualidade e sem afrouxar teste.

Pronto quando:

1. Cada correção tem **antes e depois medidos com o mesmo instrumento**, no jogo,
   e está escrita em `docs/PROBLEMS.md` (fechando uma linha) ou em
   `docs/STATUS.md` (o que foi feito).
2. Cada correção visual tem **foto 1:1 antes e depois**, abertas e olhadas uma a
   uma, e o defeito que motivou a mudança (serrilhado, borrão, peça flutuando)
   não aparece mais. Sem foto, é NÃO VERIFICADO.
3. `npm run check` verde, commit com código e docs juntos, `git push origin main`.
4. Nada piorou: nenhuma métrica acima da linha de base, nenhum spec novo na
   lista lenta, nenhuma lista de baseline crescida sem o "sim" do jogador.

**Não é pronto** porque "os testes passaram" ou "o código parece melhor". Código
e log verde não provam que funciona.

## 2. Ordem de trabalho (não pule)

```
0. Reconhecimento: o estado, o plano, o backlog aberto
1. Linha de base medida no jogo (números por passe e por sistema)
2. Auditoria larga, somente leitura, em frentes paralelas
3. TRIAGEM: cada achado da auditoria é confirmado ou derrubado MEDINDO
4. Correção, do maior custo para o menor, um bloco por vez
5. Verificação: fotos 1:1 + contadores, no mesmo cenário
6. Documento, commit, push
```

A etapa 3 é a que separa esta auditoria das que já falharam aqui: **achado de
auditoria é hipótese, não fato.** Nesta rodada, quatro dos achados "graves" eram
falsos (seção 8) e uma correção correta expôs um custo escondido que precisou da
decisão do jogador (R26). Nada entra no código sem a medição da etapa 3.

## 3. Etapa 0 — reconhecimento (30 min, leitura)

- `docs/STATUS.md` (o que já foi feito), `docs/PLAN.md` (a etapa ATUAL),
  `docs/PROBLEMS.md` (**a lista R1–R30 é o backlog**: as fases F5 a F12 do plano
  são exatamente esta auditoria).
- `docs/ARCHITECTURE.md` para a cadeia e os controladores.
- `CLAUDE.md` inteiro e os `CLAUDE.md` de `src/render`, `src/world`, `src/sim`,
  `src/editor` — eles listam os acoplamentos e as armadilhas que já custaram
  caro.
- `git log --oneline -20`: o que a última sessão mexeu.
- `git status`: **se houver arquivo modificado que não é seu, não mexa e não
  commite junto sem dizer.** Trabalho de outra sessão se soma ou espera; nunca
  se apaga.

Registre em três listas: o que já foi medido (e vale como linha de base), o que
está aberto, e o que o `CLAUDE.md` proíbe.

## 4. Etapa 1 — a linha de base, medida no jogo

Sem isto, toda correção é chute. O servidor de rascunho é o 5300; **nunca rode
sonda no mapa do jogador** (portas 4180/5173/5175-5178 nem o mapa em
`C:/Codex-Shared/backup-mapa-jogador`).

**Abra com o `playwright-cli` e o Chrome VISÍVEL** (o painel do app desenha 0 fps
oculto, e a medida de GPU é da coordenadora, na RTX, sem agente rodando
navegador ao mesmo tempo):

```bash
playwright-cli open --browser=chrome "http://localhost:5300/"
playwright-cli resize 1920 1080
```

**Fixe o cenário e nunca compare entre cenários.** O mesmo mapa, a mesma câmera,
a mesma hora do dia. Cidade determinística e vistas fixas:

```js
window.__roadcraft.generateCity({})        // sempre a mesma cidade
window.__roadcraft.lookAt(0, 0, 1.6)       // mapa inteiro
window.__roadcraft.lookAt(250, -250, 7)    // bairro
window.__roadcraft.lookAt(233, -324, 35)   // rua
// luz fixa de dia: clique o botão "☀ Dia" na barra (ele congela a hora do céu)
[...document.querySelectorAll('.v2-seg-b')].find(b => /Dia/.test(b.textContent) && !/noite/i.test(b.textContent)).click()
```

**Os instrumentos do próprio jogo** (superfície de depuração; nada a instalar):

```js
window.__gpu(true)        // zera as amostras do timer de GPU
// … espere 6 s (o timer lê por consulta assíncrona) …
window.__gpu()            // {p50, p95, p99, max, n, label}  <- a GPU, em ms
window.__frames(0)        // {total:{p50,p95,max}, systems:{desenho, simulação, prédios, postes, …}}
window.__gl.info.render   // {calls, triangles, frame}
window.__gl.info.memory   // {geometries, textures}
window.__gl.info.programs.length
window.__composer.passes.map(p => p.constructor.name)   // a lista ordenada de passes
window.__roadcraft.view() // {zoom, centre, eye, azimuth, elevation}
```

**Custo POR PASSE** — desligue UM passe e meça, ligue, meça o próximo. É o que
acha onde a GPU vai:

```js
const g = window.__gpu; window.__gpu(true);
window.__composer.passes[1].enabled = false;   // índice da lista acima
// 6 s
window.__gpu();                                 // compare com a base
window.__composer.passes[1].enabled = true;
window.__gl.shadowMap.enabled = false;          // as sombras, à parte
```

**Custo POR SISTEMA (CPU)** — `window.__frames(0).systems`, e LoAF quando um
quadro longo aparecer; a autoria do quadro longo está em `window.__health()`.

**Contagem de envios à GPU** (a regra manda nada grande subir durante o jogo).
Instrumente o contexto antes de carregar o mapa e conte por quadro:

```js
// numa página nova, antes do jogo desenhar:
const gl = WebGL2RenderingContext.prototype;
for (const name of ['bufferData','bufferSubData','texImage2D','texSubImage2D','compressedTexImage2D','compressedTexSubImage2D']) {
  const real = gl[name]; if (!real) continue;
  gl[name] = function (...a) { const bytes = byteSizeOf(name, a); window.__uploads[name] = (window.__uploads[name] ?? 0) + bytes; return real.apply(this, a); };
}
```
Some por tipo, zere a cada quadro, e olhe o maior. Um envio de centenas de KB por
quadro é o defeito; o alvo é o slot escrito, não o buffer inteiro.

**Guarde a linha de base num arquivo** (fora do git, ou em `docs/` se for pouca
coisa): GPU p50/p95 por vista e por passe, CPU p50 por sistema, chamadas,
triângulos, programas, envios por quadro. Sem ela a etapa 5 não tem com o que
comparar.

### Fotos de referência

A 1:1 (não deixe o screenshot encolher, senão o serrilhado some na média):

```bash
playwright-cli resize 1920 1080        # o buffer do canvas = o tamanho CSS
playwright-cli screenshot --filename=antes-vista.png
# recorte uma região com diagonais (é onde o serrilhado aparece):
playwright-cli run-code "async page => { await page.screenshot({ path: 'antes-recorte.png', clip: { x: 560, y: 300, width: 800, height: 500 } }); }"
```

Antes de julgar nitidez, **confirme a resolução real** — o defeito mais comum é
não haver supersampling nenhum:

```js
const c = document.querySelector('canvas');
JSON.stringify({ css: [c.clientWidth, c.clientHeight], buffer: [c.width, c.height],
                 pr: window.__gl.getPixelRatio(), dpr: devicePixelRatio,
                 msaa: window.__composer.renderTarget1.samples });
```

## 5. Etapa 2 — auditoria larga, somente leitura, em frentes paralelas

O caminho crítico (`renderer.ts`, `main.ts`, `world/doc.ts`) não paraleliza:
esses ficam com você. O que paraleliza são **investigações de leitura**, uma por
área, cada agente proibido de escrever, de rodar navegador e de abrir outros
agentes. Sete frentes cobriram o repositório inteiro sem conflito:

| frente | arquivos | a pergunta |
|---|---|---|
| render/GPU | `src/render/**` | o que a GPU desenha, quantas vezes, com que material, e o que sobe à placa |
| simulação | `src/sim/**` | o custo do `step`, alocação por tick, O(n²), O(mapa) |
| documento/edição | `src/world/**`, `src/editor/**` | o que uma edição reconstrói, quem invalida o quê |
| thread principal/UI | `main.ts`, `src/ui/**`, `src/view/**` | alocação por quadro, layout forçado, ouvintes, temporizadores |
| pessoas | `src/people/**`, `render/citizen*`, `render/people/**` | o que é cozido uma vez e o que é refeito em jogo |
| edição de via (o relato do jogador) | o caminho inteiro de um comando até o desenho | o que é O(edição) e o que ainda é O(mapa) |
| qualidade de imagem | `postprocess.ts`, `materials.ts`, filtros, tone mapping | o que causa serrilhado, borrão e falta de nitidez |

**Brief de cada agente** (copie; sem isto o relatório volta raso):
> Repositório `C:/Codex-Shared/roadcraft-2`. Investigação SOMENTE LEITURA: não
> escreva, não edite, não rode navegador, não abra outros agentes, não rode o
> jogo. Sua área: `<arquivos>`. O contrato que o projeto exige está em
> `CLAUDE.md` e nos `CLAUDE.md` das pastas; violação dele é achado. Para CADA
> achado: (1) arquivo:linha, (2) o trabalho exato, (3) com que frequência roda
> — por quadro, por passo, por edição, uma vez — e **como você determinou isso**
> seguindo o grafo de chamadas, (4) por que é desperdício sob aquele contrato,
> (5) a classe de custo: CPU na thread principal, desenho na GPU, preenchimento,
> memória/GC, envio à placa, complexidade, (6) a correção mínima concreta.
> Ordene por impacto no tempo de quadro. Diga o tamanho das coleções que cada
> laço percorre, pelos próprios números do código. Termine com uma lista curta
> do que você conferiu e está CERTO, para não ser reaberto. Não invente: sem a
> linha que prova, não é achado. Máximo 1000 palavras.

Peça também, explicitamente, a caça a: alocação em laço quente (objetos,
arrays, closures, strings, `.map/.filter/.slice/spread`, `new Vector2/3/4`,
`JSON`), trabalho O(mapa) alcançável do quadro, material ou textura criado fora
da carga, geometria enviada durante o jogo, `needsUpdate = true` **sem faixa**
(que reenvia o buffer INTEIRO), transparência e sobreposição de desenho,
limiares de LOD que nunca disparam, e o que é desenhado sem ser visto.

## 6. Etapa 3 — a triagem: medir antes de acreditar

Para cada achado, antes de tocar no código:

1. **Reproduza o custo no jogo**, com o instrumento da seção 4. Se não aparecer
   na medição, o achado cai — e vai para a seção 8 com a nota de como foi
   derrubado.
2. **Leia a fonte primária** (`node_modules/three/src/...`, `examples/jsm/...`,
   Khronos, MDN, o standard) da API que vai mudar. Nesta rodada, ler o
   `SMAAShader.js` e o `WebGLAttributes.js` foi o que separou a correção certa da
   suposição.
3. **Escreva a mensagem curta** exigida pelo `CLAUDE.md`: o que foi achado (com o
   link), a causa confirmada, a abordagem. Só então edite.
4. **Se a correção deixar o check vermelho por causa de um limite de teste ou de
   linha de base, PARE.** Não afrouxe: "afrouxar tolerância, orçamento ou limite
   de teste precisa da linha `aprovado pelo jogador em <data>`". Reverta a
   mudança, escreva o defeito em `docs/PROBLEMS.md` com a medida do custo da
   correção, e ponha a decisão na tabela "Aguardando o jogador". Foi o que
   aconteceu com o R26.
5. Duas tentativas falhas no mesmo item: pesquisa de novo antes da terceira;
   terceira falha: registra em `PROBLEMS.md` como aberto, com o que foi tentado.

## 7. Etapa 4 — corrigir, e como escolher a ordem

Ordene por **custo × frequência × risco**, não por quanto o achado é bonito:

1. **GPU por quadro** (o mais caro; a vista pesada é a que olha o mapa inteiro).
   Antes de otimizar o preenchimento, meça se o gargalo é preenchimento: mude o
   tamanho do alvo e veja se o custo anda. Nesta rodada o mapa de sombra não
   andou com o tamanho (1024→4096: 0,5 ms) — o caro era *desenhar os projetores*.
2. **CPU por quadro e por passo** — alocação e laços quentes.
3. **Trabalho por edição** — o que é O(mapa) numa edição é o que o jogador sente
   como "atualiza tudo".
4. **Envio à placa e memória** — o orçamento por quadro e a regra de nada
   alocado no laço quente.
5. **Imagem** — por último e de propósito: quase toda melhoria de nitidez custa
   pixels, e pixels se pagam com o que as etapas 1-4 liberaram.

**A regra do orçamento:** você só gasta o que liberou. Meça o custo da melhoria
(para supersampling, é quadrático: 1,25× = 1,56× de pixels; 1,5× = 2,25×; 2× =
4×) e só adote se o tempo de quadro continuar dentro da meta depois. Se não
couber, **diga que não coube, com o número** — não entregue uma melhoria bonita
que derruba o quadro.

### Onde a imagem realmente se perde (confira nesta ordem)

- **Resolução de desenho.** `renderer.setPixelRatio(Math.min(devicePixelRatio,
  quality.pixelRatio))`: num monitor dpr 1 o teto nunca passa de 1 e não há
  supersampling nenhum; num dpr 2 com teto 1,5 desenha ABAIXO do nativo (borrão).
  Meça, veja os dois lados, e decida com o número na mão.
- **Antialias.** O alvo multi-amostrado (quantas amostras?), o preset do SMAA (o
  do three é o *1x Medium*: 8 passos), e **sobre que imagem ele roda** — o three
  manda o SMAA antes do `OutputPass`, em luz linear, onde o limiar 0,1 do artigo
  original não é um décimo da faixa de exibição e as arestas escuras passam
  batido.
- **Texturas.** Filtro e anisotropia em toda superfície grande (fachadas, chão,
  asfalto, pele, cabelo, placas); viés de mip positivo no zoom próximo é borrão
  de propósito — confirme que ainda é o que se quer.
- **Passe final.** Ganho (S-curve, vibrance), vinheta, nitidez CAS: roda em cor
  linear? em que lugar da cadeia? com que máscara?
- **Sombras.** Bias e `normalBias` proporcionais ao texel; o frustum dimensionado
  pela vista; o mapa redesenhado só quando pode ter mudado.
- **O que não é defeito.** Nem todo padrão é serrilhado: um piso de bloquetes a
  60 px/m tem os bloquetes de verdade. Confirme a escala antes de "consertar" a
  textura.

### Como fechar o ciclo de uma correção

```
medir antes  →  editar  →  medir depois (mesmo cenário)  →  foto antes/depois
→  npm run check  →  docs/STATUS.md  →  commit  →  push
```

Cada bloco de correção vira um commit. Não junte cinco correções não medidas num
commit só: quando uma regredir, ninguém sabe qual foi.

## 8. Falsos positivos já pagos — não gaste tempo de novo

Da rodada de 2026-10-13, todos derrubados MEDINDO:

- **"O `performance.measure` por quadro é o maior custo da thread principal."**
  Falso: 1,15 µs por chamada, sete por quadro = 7 µs, 0,04% do quadro. E é o que
  o monitor F9 lê para explicar um quadro longo — tirar seria remover recurso.
- **"A máscara de grama amostra 147 mil alturas de terreno a cada 300 ms."**
  Falso: `keepGrassInputs` só é chamado atrás de `const show = false` — a grama de
  lâminas saiu por decisão do jogador (2026-10-06). É código morto, não custo.
- **"As passagens de nuvem e de luz do cânion custam por quadro."** Falso:
  desligando-as a GPU não se move (ruído). Nuvem, luz do cânion e bloom (de dia)
  são ~0.
- **"A anisotropia está baixa e é isso que borra o piso."** Falso: 8 → 16 em 66
  texturas não mudou o padrão; o padrão é a textura real.
- **"Reduzir o mapa de sombra economiza."** Falso por outro caminho: 1024 → 4096
  custa 0,5 ms; o custo é a geometria projetada, não o preenchimento.
- **Uma correção certa pode expor um custo escondido.** Consertar o cache velho
  do `trapLanes` (R26) fez o trabalho `routing` do teste de escala passar a
  crescer (x15,26) — o custo SEMPRE existiu, estava só escondido pela resposta
  errada. Achado assim não se esconde nem se "resolve" afrouxando: vai para o
  jogador (seção 6.4).

## 9. O que NUNCA se faz

- Afrouxar tolerância, orçamento, `testTimeout`, linha de base ou lista de specs
  lentos sem a linha `aprovado pelo jogador em <data>`.
- Silenciar erro (`catch` vazio), enfraquecer ou pular teste, mexer no lint.
- Tirar recurso ou mudar a aparência de propósito (ACES, vinheta, grama,
  luzes da noite) sem o "sim" do jogador — vai para "Aguardando o jogador" com a
  recomendação.
- Corrigir sintoma (limitar, capar, esconder) no lugar da causa.
- Confiar em "os testes passaram" ou num log verde como prova de que funciona.
- Rodar sonda ou edição no mapa do jogador, ou limpar o armazenamento dele.
- Duas sessões escrevendo ao mesmo tempo; agente abrindo agente; CPU saturada
  (uma tarefa pesada por vez, `scripts/run-limited.mjs`).

## 10. Divisão em agentes (quando a auditoria for grande demais para uma sessão)

- **Coordenadora** (a sessão que executa este prompt): o caminho crítico
  (`main.ts`, `render/renderer.ts`, `render/terrain.ts`, `world/doc.ts`,
  `sim/world.ts`, `editor/commit.ts`, `editor/persistence.ts`), as medidas de GPU
  na RTX com o painel visível, a integração e o push.
- **Até 3 agentes escrevendo**, cada um com área de arquivos DISJUNTA da
  coordenadora e dos outros, e um brief completo (seção 5) com o critério de
  pronto item por item. Entrega = commit verificado no ramo do agente, com spec
  que reprova o código antigo e passa no novo, foto olhada e linha no
  `PROBLEMS.md`.
- **Investigadores somente leitura** (quantos couberem sem saturar a máquina):
  não escrevem nada, não rodam navegador, não abrem agentes.
- Agente não cria agente. Coordenadora não abre outro enquanto estes viverem.
- Agente bloqueado escreve o bloqueio no relatório e passa ao próximo item —
  nunca fica parado esperando.

## 11. Relatório final (o que o jogador lê)

Em português, curto, com o número na frente:

- o que foi **medido** (a linha de base) e o que ela mostrou;
- o que foi **corrigido**, item por item, com **antes → depois** e a foto;
- o que foi **achado e não corrigido**, e por quê (bloqueio, risco, ou decisão do
  jogador), com a recomendação;
- o que está **NÃO VERIFICADO** e o motivo (não abriu, não usou, não mediu);
- o que **precisa do jogador** decidir.

"Feito" é medido e visto; "fechado" só quando o jogador conferir.
