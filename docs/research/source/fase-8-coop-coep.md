# Fase 8 — COOP/COEP no Vite e no Electron, SharedArrayBuffer com buffer triplo e Atomics, credentialless

Pesquisa de 2026-10-11, ramo `agente/pesquisa` (a partir de `planeta-esfera` 27a7cb48). Só leitura de código; nada foi
rodado (nem jogo, nem testes, nem build, nem painel). Vite 8.3.4 e o three r186 foram lidos em
`C:/Codex-Shared/roadcraft-planeta-esfera/node_modules`, só para leitura.

Método e limite das fontes: as páginas da web vieram pela ferramenta de busca de páginas, que devolve um resumo extraído por
modelo; várias vezes o resumo avisou que parte do que dizia vinha de "conhecimento geral" e não da página, e essas partes **não**
são citadas aqui como lidas. Baixei para a pasta temporária da sessão e li eu mesmo: o código da biblioteca `triple_buffer`
(Rust) e as páginas da especificação HTML sobre workers e políticas de incorporação. Onde a ferramenta cortou uma página, está
na seção 5.

---

## 1. Perguntas que a fase precisa responder

1. Quais cabeçalhos tornam a página isolada entre origens, e o que no jogo (workers, recursos, janelas) quebra ou precisa
   de cabeçalho próprio?
2. Como pô-los no servidor de desenvolvimento (5173), no de pré-visualização (4180) e no Electron (`app://`)?
3. `require-corp` ou `credentialless`: qual serve a este jogo, e o que cada um custa?
4. Como é um buffer triplo com `SharedArrayBuffer` e `Atomics` para os instantâneos da simulação (fase 4), sem alocação e sem
   mensagens por tick, e como cresce sem teto fixo de população?
5. O que mais o isolamento libera (medida de memória, relógio mais fino, dados compartilhados entre workers) e o que ele não
   resolve?
6. Vale fazer, e em que ordem, dado que o relatório põe esta fase como "se a fase 4 mostrar custo de mensagens"?

---

## 2. Fontes lidas

Convenção: S = fonte. Citações curtas, no máximo uma por fonte.

**S1. web.dev, "Making your website cross-origin isolated using COOP and COEP"** — https://web.dev/articles/coop-coep
(lida em 2026-10-11, resumo). Cabeçalhos no documento principal: `Cross-Origin-Embedder-Policy: require-corp` e
`Cross-Origin-Opener-Policy: same-origin`; o teste é `self.crossOriginIsolated`. Com COEP, todo recurso que não seja da mesma
origem precisa de `Cross-Origin-Resource-Policy` ou de CORS; iframes e janelas abertas com COOP perdem `window.opener` e
`postMessage` entre elas. Roteiro: pôr COOP, tornar os recursos compatíveis, testar com
`Cross-Origin-Embedder-Policy-Report-Only` (aplicado a "todos os documentos: topo, iframes e scripts de worker") e só então
impor. Depuração: aba Network com o estado `(blocked:NotSameOriginAfterDefaultedToSameOriginByCoep)`, aba Application, API de
relatórios. Ganhos: `SharedArrayBuffer`, `performance.measureUserAgentSpecificMemory()` e relógio mais fino (resolução de pelo
menos 100 microssegundos normalmente e de pelo menos 5 microssegundos isolada). Suporte: `crossOriginIsolated` no Chrome 87;
`SharedArrayBuffer` no Chrome 88 (Android) e desligado por padrão no desktop a partir do 92 sem isolamento; `credentialless`
no Chrome 96 e Edge. A página diz que scripts de `WebWorker` "precisam ser da mesma origem" e por isso "não precisam de CORP ou
CORS", mas ao mesmo tempo manda aplicar o Report-Only aos scripts de worker: a regra exata sobre a política de incorporação do
script do worker vem da especificação (S8).

**S2. MDN, `Cross-Origin-Embedder-Policy`** — https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Cross-Origin-Embedder-Policy
(lida em 2026-10-11; só o que a própria página diz). Valores: `unsafe-none` (padrão), `require-corp` (carrega recurso
cross-origin em modo `no-cors` só se for da mesma origem ou trouxer `Cross-Origin-Resource-Policy` compatível; o modo `cors`
passa), `credentialless` (carrega sem exigir CORP mas **sem credenciais**: cookies não saem e são ignorados na resposta). Um só
valor; repetido ou múltiplo equivale a `unsafe-none`; parâmetro `report-to`. O resumo trouxe também trechos de "conhecimento
geral" sobre herança de workers e sobre o atributo `credentialless` de iframe: ignorados (a regra de workers foi lida na
especificação, S8).

**S3. Chrome for Developers, "Using COEP: credentialless to enable cross-origin isolation"** — https://developer.chrome.com/blog/coep-credentialless-origin-trial
(lida em 2026-10-11). `Cross-Origin-Embedder-Policy: credentialless` mais `Cross-Origin-Opener-Policy: same-origin` isola a
página mesmo carregando recursos cross-origin sem CORP, porque as requisições `no-cors` cross-origin saem sem credenciais.
Quem precisa de credenciais passa para modo CORS (`crossorigin="use-credentials"`, `fetch` com `mode = 'cors'`). Iframes
cross-origin continuam precisando de COEP compatível e de `Cross-Origin-Resource-Policy: cross-origin` no próprio documento.
Suporte à época do texto: Chrome 96 enviado; Firefox com pendência aberta; WebKit sem sinal. (O quadro de suporte pode ter
mudado desde então; não reabri o MDN para a tabela atual.)

**S4. MDN, `SharedArrayBuffer`** — https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/SharedArrayBuffer
(lida em 2026-10-11). Exige contexto seguro e isolamento entre origens; sem isso o construtor global fica escondido e
`postMessage` de um `SharedArrayBuffer` lança. Na troca por `postMessage`, o receptor ganha um objeto novo que aponta para o
**mesmo bloco de dados**; não é transferível e não destaca o original. Uma escrita numa thread "eventualmente" aparece nas
outras; para sincronizar é preciso usar `Atomics`. Existe `SharedArrayBuffer` crescível (`maxByteLength`, `grow()`); nunca
encolhe. `WebAssembly.Memory` compartilhada tem as mesmas exigências para o compartilhamento. A página não trata de `wait`/
`notify` nem de ordenação de memória.

**S5. MDN, `Atomics` e `Atomics.waitAsync`** — https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Atomics
e `.../Atomics/waitAsync` (lidas em 2026-10-11). Métodos: `add`, `and`, `compareExchange`, `exchange`, `isLockFree`, `load`,
`notify`, `or`, `pause`, `store`, `sub`, `wait`, `waitAsync`, `xor`; `wait`/`notify` modelados nos futex do Linux; "A maioria dos
navegadores não permite `wait()` na thread principal". `waitAsync` aceita só `Int32Array` ou `BigInt64Array` sobre
`SharedArrayBuffer`, devolve `{ async, value }` e pode ser usado na thread principal; a página marca como "Baseline 2025, novo"
(disponível em todos os navegadores atuais desde novembro de 2025), sem a tabela de versões. A página de `Atomics` não traz o
modelo de memória nem a exigência de tipos para `wait`.

**S6. TC39, "Shared Memory — a brief tutorial"** — https://github.com/tc39/proposal-ecmascript-sharedmem/blob/main/TUTORIAL.md
(lida em 2026-10-11). Escritas não atômicas podem ser reordenadas pelo compilador e pela CPU e um leitor pode ver uma escrita
posterior antes de uma anterior; "uma operação atômica cria um ponto de ordenação: escritas feitas antes de uma escrita atômica
são observáveis no mais tardar quando essa é observada". Operações atômicas valem para inteiros de 8, 16 e 32 bits. Regra de
uso: um elemento é ou atômico (sincronização, canais simples) ou não atômico (dados em massa), não os dois. Um
`SharedArrayBuffer` no Firefox é múltiplo de 4 KiB, com mínimo de 8 KiB: poucos buffers grandes com visões particionadas. O texto
usa o nome antigo `wake` onde hoje existe `notify`; não cobre alinhamento nem o modelo formal de memória.

**S7. Chrome for Developers, "SharedArrayBuffer updates in Android Chrome 88 and Desktop Chrome 92"** — https://developer.chrome.com/blog/enabling-shared-array-buffer
(lida em 2026-10-11). Histórico: Chrome 60 (2017), desligado em janeiro de 2018 por Spectre porque um laço em worker vira
cronômetro de alta resolução; volta no desktop com Site Isolation no Chrome 68; Firefox 79 foi o primeiro com a regra de COOP/COEP;
Chrome 88 (Android) e 92 (desktop) exigem isolamento. Cabeçalhos exigidos: `COEP: require-corp` e `COOP: same-origin`. Avisa
de que `same-origin` pode quebrar fluxos entre janelas (pagamento, login) e de que um relaxamento
(`same-origin-allow-popups`) estava em estudo. Não cobre Electron nem como verificar em execução.

**S8. WHATWG HTML Standard, workers e políticas de incorporação** — https://html.spec.whatwg.org/multipage/workers.html e
`.../multipage/browsers.html` (baixados e lidos por mim em 2026-10-11, só os trechos citados). No algoritmo de executar um
worker: depois de inicializar o contêiner de políticas do escopo do worker, "se o resultado de verificar a política de
incorporação do objeto global com o escopo do worker, as configurações externas e a resposta for falso, a resposta vira erro de
rede". "Verificar a política de incorporação do objeto global": se o escopo não é de worker **dedicado**, devolve verdadeiro; senão,
compara a política do **worker** (a da resposta do script) com a do **dono**: se a política do dono é compatível com o
isolamento (`require-corp` ou `credentialless`) e a do worker não é, o carregamento falha (e gera relatório `coep`). Além
disso, o escopo do worker (não compartilhado) ganha a capacidade `crossOriginIsolated` se o grupo de agentes estiver no modo
"concreto", perde-a se o dono não a tem e **perde-a sempre se o script veio de uma URL `data:`** (o texto chama isso de padrão
conservador por enquanto). O trecho que define a política de um worker carregado de `blob:` ou `data:` não foi encontrado nas
páginas baixadas.

**S9. Vite, documentação e código do pacote 8.3.4** — https://vite.dev/config/server-options e https://vite.dev/config/preview-options
(lidas em 2026-10-11): `server.headers` ("especifica cabeçalhos de resposta", tipo `OutgoingHttpHeaders`) e
`preview.headers` (idem); as páginas não dizem se valem para scripts de worker nem se um herda do outro. Código
(`node_modules/vite/dist/node/chunks/node.js`): `resolvePreviewOptions` (linha 35624–35634) define
`headers: preview?.headers ?? server.headers`, ou seja, **sem `preview.headers`, o `vite preview` usa os de `server.headers`**;
o servidor de preview aplica `setHeaders` a cada arquivo estático (linhas 35704–35711) e `send(..., { headers })` ao HTML
(linha 18338). O comando do servidor 4180 é `vite preview --outDir C:/Codex-Shared/road-play-dist --host 127.0.0.1 --port 4180`
(`.claude/launch.json:5–18`).

**S10. Electron, `protocol`** — https://www.electronjs.org/docs/latest/api/protocol (lida em 2026-10-11) e o aviso de segurança
GHSA-4p4r-m79c-wq3v (CVE-2026-34767, 02/04/2026). `protocol.handle(scheme, handler)`: o manipulador recebe um `Request` e
devolve `Response` (ou promessa); os cabeçalhos entram no construtor da `Response` (`new Response(body, { headers })`); a página
não fala de mutabilidade de cabeçalhos da resposta de `net.fetch`. `registerSchemesAsPrivileged` só antes de `ready` e uma vez;
`standard` (URL relativa e armazenamento), `secure`, `supportFetchAPI`, `corsEnabled`, `stream`, `bypassCSP`, e o `protocol.registerSource`
experimental para servir arquivos do aplicativo sem JavaScript. O aviso trata de **injeção de cabeçalho** (CRLF em nome ou valor
refletido de entrada não confiável) em `protocol.handle`, `registerSchemesAsPrivileged` e `webRequest.onHeadersReceived`, corrigida em
38.8.6, 39.8.3, 40.8.3 e 41.0.3; a página não cita a linha 44 (que o `package.json:51` usa, `^44.6.0`). Valores constantes de
COOP/COEP não têm entrada de usuário. A documentação do Electron lida (protocol, session, mudanças incompatíveis, 100 000 dos
primeiros caracteres) não menciona isolamento entre origens.

**S11. Evidência da comunidade sobre Electron** (secundária, lida em 2026-10-11): electron/electron #31789 (Electron 15.3.0,
`loadFile`: `SharedArrayBuffer is not defined`; fechada na hora como pergunta, sem orientação) e o PR #33 do projeto mixi
(https://github.com/fabriziosalmi/mixi/pull/33), cujo autor relata que numa janela `file://` do Electron `crossOriginIsolated` é
`false` e **mesmo assim** `SharedArrayBuffer` existe e funciona, que um servidor estático sem os cabeçalhos deixa
`SharedArrayBuffer` indefinido, e que servir a interface por um esquema `app://` com COOP/COEP a isola, mas ele não adotou
(sem versão do Electron nem como os cabeçalhos foram postos). Não há fonte primária do Electron sobre isto aqui.

**S12. Crate `triple_buffer` (Rust)** — https://github.com/HadrienG2/triple-buffer, `src/lib.rs` (baixado e lido por mim em
2026-10-11, 47 106 bytes; linhas 1–140, 306–350, 520–633). Buffer triplo = canal sem bloqueio de um produtor e um consumidor que
se comporta como uma variável compartilhada: o produtor publica atualizações, o consumidor lê "o último valor disponível"
quando quiser. Três blocos de memória (entrada do produtor, saída do consumidor, e um terceiro "de trás" compartilhado) e **uma
única palavra atômica** `back_info` (índice do bloco de trás nos 2 bits baixos e um bit "sujo" `0b100`); `publish()` faz
`back_info.swap(input_idx | SUJO, AcqRel)` e o índice antigo do bloco de trás vira o novo bloco de entrada; `update()` do consumidor,
se o bit está ligado, faz `swap(output_idx, AcqRel)` e adota o índice recebido; `publish` informa se sobrescreveu um valor
que o consumidor não leu. Cada bloco e a palavra atômica ficam em linhas de cache separadas (`CachePadded`). A ordenação
`AcqRel` é necessária para que os acessos ao bloco não passem para o outro lado do `swap` (comentário do código).

**S13. web.dev, "Monitor your web page's total memory usage with `measureUserAgentSpecificMemory()`"** — https://web.dev/articles/monitor-total-page-memory-usage
(lida em 2026-10-11). Exige isolamento entre origens e contexto seguro, só Chromium (89+); soma a memória de JavaScript e DOM de
todas as janelas, iframes e workers do processo; a medição espera uma coleta de lixo (até 20 s por padrão; zero com
`--enable-blink-features=ForceEagerMeasureMemory`), e a recomendação é amostrar em intervalos aleatórios de média cinco minutos.
**A página não menciona memória de WebGL**, então não mede VRAM.

**S14. Documentos desta pesquisa e do relatório** (contexto): o relatório do projeto, seção 4.10, já tem o esboço de
`vite.config.ts` e `desktop/main.cjs` e diz "buffer triplo ... trocado por um índice atômico"; `fase-3-workers.md` (Surma:
`postMessage` até 10 KiB cabe no orçamento de 16 ms; transferência de `ArrayBuffer` é "extremamente rápida e independente do
tamanho", sem números) e `fase-4-simulacao-worker-meso.md` (1 000 veículos x 12 campos = 48 KB por tick).

---

## 3. O que se aplica a este código

### 3.1 O que há hoje

- Nenhum COOP/COEP: `vite.config.ts:59` só envia `Document-Policy: js-profiling` (para o perfilador). Nenhum uso de
  `SharedArrayBuffer`, `Atomics` ou `crossOriginIsolated` em `src`, `scripts`, `desktop` (busca sem resultado).
- Nove lugares criam worker de módulo do mesmo servidor, sempre `new Worker(new URL('./x.worker.ts', import.meta.url), { type: 'module' })`:
  `render/bakePool.ts:48`, `destruction.ts:107` (o `fracture.worker`), `ecologyPool.ts:37`, `flatGroundPool.ts:51`,
  `people/garmentPaddingPool.ts:69`, `people/lodPool.ts:18`, `surfaceBakeClient.ts:23`, `terrain.ts:3508` e
  `terrainLightPool.ts:44`. Mais os workers de `Blob` do `KTX2Loader` e do decodificador do meshopt (fase 6), se vierem.
- O jogo não carrega nada de outra origem: `index.html` só tem um ícone `data:` e um `<script type="module" src="/src/main.ts">`;
  sem `<iframe>`, sem `window.open`, sem `target="_blank"`, sem CSS ou fonte externos, sem `fetch` para `http(s)://` em `src`
  (buscas na árvore). Os modelos vêm por `model-urls-plugin.ts` (mesma origem). Isso torna `require-corp` de baixo risco, como o
  relatório diz.
- Electron: `desktop/main.cjs:26–28` registra `app` como `{ standard, secure, supportFetchAPI, stream, corsEnabled }` e
  `protocol.handle('app', …)` (linhas 59–66) devolve `net.fetch(pathToFileURL(file))`; o `electron` do projeto é `^44.6.0`
  (`package.json:51`). `secure` é o que faz o esquema ser contexto seguro (S4 exige).
- O servidor 4180 é `vite preview` (S9), e `preview.headers` herda de `server.headers`.

### 3.2 Cabeçalhos no Vite (dev e preview)

Mudança mínima, e por que cobre os dois:

```ts
// vite.config.ts, dentro de server.headers (preview herda, S9: resolvePreviewOptions)
headers: {
  'Document-Policy': 'js-profiling',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
},
```

Ao contrário do esboço do relatório (`preview: { headers: isolation }`), **não definir `preview.headers`**: com ele definido, o
preview deixaria de herdar `Document-Policy` (`preview?.headers ?? server.headers` escolhe um objeto inteiro, não faz mistura).
Se um dia precisar de valores diferentes, repetir os três.

O que a leitura da especificação (S8) e do código do Vite (S9) acrescenta:
- **O cabeçalho tem de estar em todas as respostas, não só no HTML.** O script de um worker dedicado é validado contra a política
  do dono: se a página é `require-corp` e a resposta do script do worker não traz um valor compatível, o worker **falha ao
  carregar** (erro de rede). Os nove workers acima são servidos pelo próprio Vite; `server.headers` e o `setHeaders` do preview
  valem para todos os arquivos servidos (S9: o `setHeaders` do preview é aplicado a cada arquivo estático; para o servidor de
  desenvolvimento a página não diz e eu não li o código do servidor de dev, então confirmar na prática que o script do worker em
  `/src/...?worker_file` traz os cabeçalhos).
- **Workers criados de `Blob`/`data:`** (o `KTX2Loader` cria `new Worker(blobUrl)`, `KTX2Loader.js:334`): a especificação diz
  que o dono é comparado com a política do escopo do worker, e não encontrei nas páginas baixadas como esse escopo herda a
  política quando o script não veio de uma resposta de rede; para URLs `data:` o texto é explícito: o worker **nunca** é isolado
  (S8), então não usar `data:` para workers que precisem de `SharedArrayBuffer`. Testar com a isolação ligada (um arquivo `.ktx2` e o decodificador
  do meshopt com `useWorkers`) antes de contar com eles.
- **Contexto seguro.** `SharedArrayBuffer` exige contexto seguro (S4); `http://127.0.0.1:5173` e `:4180` devem contar (o servidor está
  em `127.0.0.1`, `vite.config.ts:52`), mas abrir o servidor pela rede (`http://192.168...`) não é contexto seguro e a página
  ficará sem `SharedArrayBuffer`. Não li a regra de "origem confiável" no MDN; é o que o código e a regra de S4 sugerem, a
  confirmar.
- **Servidor de HMR.** O WebSocket do Vite não é um recurso `no-cors` carregado pela página; não encontrei fonte que diga que
  COEP o afeta, então: conferir com a isolação ligada que o recarregamento a quente continua.
- **Procedimento de adoção** (S1): primeiro `Cross-Origin-Embedder-Policy-Report-Only` com a mesma política, olhar o Network e
  `(blocked:...)`, depois impor. Como todos os recursos são da mesma origem, a fase de relatório deve sair vazia; se não sair,
  o resultado diz o que está de fora.

Verificação: `self.crossOriginIsolated === true` na página e `WorkerGlobalScope.crossOriginIsolated` dentro de um worker
(S8: um worker dedicado só carrega se o script for compatível com a política do dono, e uma URL `data:` nunca o isola).

### 3.3 Cabeçalhos no Electron (`protocol.handle`)

O esboço do relatório (4.10) vai na direção certa (S10: cabeçalhos entram em `new Response(body, { headers })`):

```js
// desktop/main.cjs, no protocol.handle('app', ...) (linha 59)
const response = await net.fetch(pathToFileURL(file).toString());
const headers = new Headers(response.headers);
headers.set('Cross-Origin-Opener-Policy', 'same-origin');
headers.set('Cross-Origin-Embedder-Policy', 'require-corp');
return new Response(response.body, { status: response.status, headers });
```

Pontos tirados das fontes:
- Os cabeçalhos têm de sair em **toda** resposta do esquema, não só em `index.html` (mesmo motivo dos workers, S8): o `handle`
  atual já trata todas as requisições `app://`, então a mudança é a mesma para todas.
- Copiar os cabeçalhos em vez de mutar a resposta de `net.fetch`: a documentação do Electron não diz se os cabeçalhos dessa
  `Response` são mutáveis (S10). Cuidado com `content-length` copiado junto com um corpo recriado; hoje o corpo é o mesmo fluxo.
- Valores constantes: o aviso GHSA-4p4r-m79c-wq3v (S10) trata de CRLF vindo de entrada não confiável em cabeçalhos; aqui não há
  entrada.
- **Não há fonte primária do Electron** dizendo que uma navegação a um esquema customizado com COOP/COEP vira
  `crossOriginIsolated`. A evidência é secundária (S11: o PR do mixi diz que `app://` com COOP/COEP isola e que o `file://`
  expõe `SharedArrayBuffer` sem `crossOriginIsolated`). O teste é de poucos minutos, com o F12 que o jogo já abre
  (`desktop/main.cjs:49–53`): `crossOriginIsolated` e `typeof SharedArrayBuffer` com e sem os cabeçalhos.
- O próprio `desktop/main.cjs` usa `loadURL('app://roadcraft/index.html')` (linha 55): é uma navegação normal, não `file://`.
- `protocol.registerSource` (S10) é experimental e serve do disco sem JavaScript; não permite acrescentar cabeçalhos pelo que a
  página diz, então ficaria fora enquanto precisarmos deles.

### 3.4 `require-corp` ou `credentialless`

Para este jogo, `require-corp`. Tudo que a página carrega é da mesma origem (3.1); `credentialless` só importa se um dia entrar
recurso de terceiros sem CORP (mapa, fonte, imagem de outro domínio). E `credentialless` (S1, S3) estava só no Chromium (96,
Edge) nas páginas lidas; o mesmo vale para a exigência de `crossorigin="use-credentials"` quando um recurso de terceiro
precisar de cookie. Se o jogo for hospedado em outro lugar sem controle de cabeçalhos (hospedagem estática), nenhum dos dois
vale: sem cabeçalho não há `SharedArrayBuffer` (S4, S7). Por isso o caminho com memória compartilhada tem de ser **opcional**:
`if (crossOriginIsolated && typeof SharedArrayBuffer === 'function')` e, senão, `ArrayBuffer` transferível (como o relatório
já prevê).

### 3.5 `SharedArrayBuffer` com buffer triplo (fase 4)

**Quando vale.** A fase 4 tem, por tick, ~48 KB para 1 000 veículos (12 campos `float32`; conta da fase 4) mais pedestres. Isso
cabe numa transferência de `ArrayBuffer` por tick sem cópia (S14), então o `SharedArrayBuffer` **não é necessário** para
transportar o instantâneo. O que ele compra: (1) nenhum `onmessage` na thread principal por tick (nem o evento nem a
desserialização), (2) o worker publica no ritmo dele e a thread principal lê no do quadro, sem fila de mensagens que cresce,
(3) o consumidor sempre vê "o último", sem acumular quadros velhos. É a razão que o relatório dá: só se a medida de
`postMessage` no perfil da fase 4 mostrar custo. Medir primeiro: ms de despacho e aplicação de mensagens por quadro com o
protocolo transferível.

**O algoritmo, traduzido de S12.** Uma `SharedArrayBuffer` com uma palavra de controle e três blocos de instantâneo, cada um
alinhado a 64 bytes (a crate usa `CachePadded` por bloco e na palavra atômica; em JS só podemos espaçar os deslocamentos):

```
controle: Int32Array(sab, 0, 1)          // bits 0-1: índice do bloco de trás; bit 2 (valor 4): "sujo"
bloco[k]: Float32Array(sab, base + k*passo, campos)  // k = 0,1,2 (o produtor e o consumidor têm cada um o seu índice local)

produtor (worker):  escreve em bloco[entrada]; depois
                    antigo = Atomics.exchange(controle, 0, entrada | 4); entrada = antigo & 3;
                    // (antigo & 4) != 0 => o consumidor não leu o anterior: contar "sobrescrito"
consumidor (principal), uma vez por quadro:
                    if (Atomics.load(controle, 0) & 4) { antigo = Atomics.exchange(controle, 0, saida); saida = antigo & 3; }
                    ler bloco[saida]
```

Por que está certo e o que garante: cada `exchange` troca a posse exclusiva de um bloco; nunca há dois lados no mesmo bloco, então
**não há leitura rasgada** sem usar `Atomics` nos dados em si (S6: um elemento é atômico ou não atômico; os blocos são não
atômicos, a palavra de controle é atômica). A ordenação que a crate exige (`AcqRel`, S12) é coberta pelo ponto de ordenação das
operações atômicas do JavaScript (S6: escritas anteriores a uma escrita atômica são observáveis quando ela é observada); a
afirmação de que são sequencialmente consistentes está no padrão ECMAScript e não nas páginas MDN/TC39 que li. Nenhum lado
espera o outro (sem `wait`), logo nada bloqueia a thread principal (S5: `wait` é proibido nela). O contador de sobrescritos é
uma métrica grátis para o F9 (consumidor lento ou produtor rápido).

**Interpolação.** O buffer triplo entrega só o último valor. A Gaffer (fase 4) interpola entre os dois últimos instantâneos: o
consumidor guarda uma cópia do anterior (memcpy de ~48 KB por tick, conta minha) ao adotar um novo bloco. Não precisa de mais
blocos.

**Sem teto fixo de população.** Os blocos têm capacidade fixa; o jogador pediu população sem teto (limite = o que a máquina
sustenta). Solução: o worker aloca um novo conjunto (controle + 3 blocos) com o dobro da capacidade quando enche e manda **uma
mensagem rara** com o novo `SharedArrayBuffer` (S4: o receptor recebe um objeto que aponta para os mesmos dados); o
consumidor troca de conjunto no próximo quadro e o antigo é solto. `SharedArrayBuffer` crescível (`maxByteLength`, `grow`)
existe (S4), mas só cresce, e uma visão sobre ele precisa acompanhar o comprimento; alocar conjuntos novos é mais simples.
Mensagens para eventos e estrutura (nascimento, morte, portas) continuam por `postMessage`; só o que muda todo tick vai no
bloco (a divisão "estático x dinâmico" da fase 4).

**Contadores de controle.** Pedido de passos (a thread principal é dona do `SimClock`, fase 4) pode ser um `Atomics.add` num
contador com `Atomics.notify`, e o worker esperar com `Atomics.wait` (permitido em worker, S5); a thread principal nunca
espera. Só `Int32Array` (ou `BigInt64Array`) valem para `wait`/`notify`/`waitAsync` (S5). `waitAsync` na thread principal só se
algum dia ela precisar ser acordada; o consumo por quadro dispensa.

**Teste.** O algoritmo roda no Node (workers com `SharedArrayBuffer` não exigem isolamento no Node; não verifiquei nesta pesquisa
a configuração do Vitest do projeto) como teste de propriedade: um produtor a taxa alta escreve blocos com soma de verificação
e número de sequência, o consumidor lê muito mais devagar e confere (a) nenhuma leitura rasgada, (b) números de sequência
crescentes, (c) contagem de sobrescritos coerente.

### 3.6 Outros usos do isolamento, além dos instantâneos

1. **Dados somente-leitura compartilhados entre workers.** Hoje cada pool recebe cópias (por exemplo, a grade de luz do
   terreno por `postMessage({ grid })`, fase 3). Uma grade de alturas, o grafo de faixas em forma compacta ou o índice de células
   (fases 2 e 5) num `SharedArrayBuffer` seria lido pela thread principal e por todos os workers sem cópia. É a economia de
   memória mais provável (um exemplar em vez de N, p. ex. as alturas do planeta inteiro, ~23 MB na fase 5), mas dado que muda
   exige disciplina: gerações imutáveis (novo buffer por revisão, como os portões de revisão do jogo) em vez de escrita no
   lugar; um contador de época atômico se for escrever no lugar (S6: um elemento é atômico ou não).
2. **`performance.measureUserAgentSpecificMemory()`** (S13), útil para a contabilidade de memória da fase 0 e 6: soma JS e DOM
   de página e workers, no Chromium, com atraso de coleta de lixo e amostragem aleatória; **não mede VRAM**, que continua
   sendo a contagem própria de bytes de textura e geometria da fase 6.
3. **Relógio mais fino** (S1): resolução de 5 microssegundos em vez de 100, o que ajuda na medida por estágio da fase 0.
4. **Memória compartilhada de WebAssembly** (S4): só se um núcleo numérico em WASM com threads aparecer; o relatório já o deixa
   para depois.

### 3.7 Ordem proposta

1. Em `server.headers`, `Cross-Origin-Embedder-Policy-Report-Only` + `COOP: same-origin`; abrir o jogo por 5173 e conferir o
   relatório e a aba Network. 2. Trocar para `require-corp` e conferir `crossOriginIsolated` na página e num worker; conferir
   HMR. 3. 4180 (preview herda). 4. `desktop/main.cjs` e o teste do F12. 5. Só então código de `SharedArrayBuffer`, sempre atrás
   de detecção, com o caminho transferível como padrão. 6. Microbenchmark do buffer triplo contra a transferência com
   ping-pong de buffers.

---

## 4. Riscos e o que medir

| risco | por que | o que medir |
|---|---|---|
| Worker não carrega com COEP | o script do worker dedicado é validado contra a política do dono (S8) | `WorkerGlobalScope.crossOriginIsolated` e erro de rede dos nove workers, em 5173, 4180 e `app://` |
| Worker de `Blob` (KTX2, meshopt) falha com COEP | regra de herança não lida em S8 | carregar um `.ktx2` e o decodificador do meshopt com isolamento ligado |
| Ficar sem `SharedArrayBuffer` fora de `127.0.0.1` | exige contexto seguro (S4) | abrir por IP de rede e por `localhost` |
| HMR quebra com COEP | não achei fonte | recarga a quente com isolamento ligado |
| Electron não isola | sem fonte primária (S10, S11) | `crossOriginIsolated` e `typeof SharedArrayBuffer` no F12 com e sem os cabeçalhos no `protocol.handle` |
| Recurso de terceiro futuro bloqueado | `require-corp` (S1) | relatório `coep`; usar `credentialless` só se Chromium bastar (S3) |
| Corrida na troca de conjunto ao crescer | consumidor ainda lendo o conjunto antigo | teste de propriedade com crescimento no meio; contador de geração |
| Ganho nenhum sobre a transferência | 48 KB por tick é pouco (S14) | ms de despacho de mensagens por quadro (protocolo transferível) contra o buffer triplo, na RTX, 400/400 |
| Leitura rasgada dentro de um bloco | quebra da regra de posse | teste de soma de verificação; nenhuma escrita nos blocos fora do dono |
| `Atomics.wait` na thread principal | proibido (S5) | revisão de código: só `exchange`/`load`/`store` na principal |

---

## 5. O que NÃO foi possível ler

- **Electron:** não há página da documentação do Electron que trate de isolamento entre origens; as de `protocol`, `session` e
  `breaking-changes` foram lidas só nos primeiros 100 000 caracteres (as duas últimas) e nada têm sobre COOP/COEP. A afirmação
  de que um `Response` com COOP/COEP de `protocol.handle` isola a página vem de um PR de terceiro (S11) e não foi verificada;
  a mutabilidade dos cabeçalhos da `Response` de `net.fetch` também não consta na doc.
- **Especificação HTML:** li o algoritmo de executar o worker e o de verificar a política de incorporação; não achei o
  trecho que define a política de um worker carregado de `blob:`/`data:` (e o "contêiner de políticas" inicial), então a
  regra para os workers de `Blob` do `KTX2Loader` é ponto de teste.
- **MDN:** o resumo de `Cross-Origin-Embedder-Policy` trouxe partes de "conhecimento geral" que descartei; a tabela atual de
  compatibilidade (Firefox/Safari para `credentialless` e para isolamento) não foi lida; só tenho o Firefox 79 da S7 e o
  Chrome 96 de S1/S3. A página de `Atomics` não tem o modelo de memória; o fato de as operações atômicas do JavaScript serem
  sequencialmente consistentes está no padrão ECMAScript, que não abri nesta pesquisa.
- **Vite:** não li o código do servidor de desenvolvimento para confirmar que `server.headers` vai em todas as respostas (JS
  transformado, scripts de worker); só o do preview (`setHeaders`, `send`) e a resolução de `preview.headers`. A documentação não
  responde. WebSocket do HMR sob COEP: sem fonte.
- **Medidas:** nenhum custo de `postMessage` do jogo, nenhum tempo do buffer triplo e nenhum teste no navegador ou no Electron
  foi feito; tudo em 3.5 e 3.6 é desenho a partir das fontes. A crate do buffer triplo foi lida em partes (documentação, `publish`,
  `update`, estado compartilhado), não os testes nem o resto do arquivo.
- **Vitest:** não li a configuração de testes do projeto para dizer se há ambiente Node com `worker_threads` já usado.
