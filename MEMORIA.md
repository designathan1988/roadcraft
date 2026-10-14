# MEMÓRIA DO TRABALHO — leia inteiro ao começar uma sessão ou depois de uma compactação

Arquivo vivo, importado pelo `CLAUDE.md` da raiz (`@MEMORIA.md`): entra sozinho em toda sessão nova e
depois de toda compactação (docs oficiais: o CLAUDE.md da raiz é relido do disco depois do `/compact`, e
os `@imports` carregam com ele). **Toda sessão que mudar o estado do trabalho atualiza este arquivo**:
o que fez (commit), o que deixou pela metade, o que decidiu e por quê. Escreva datas absolutas.
Detalhe longo vai em outro arquivo e aqui fica o ponteiro.

## 1. O que o jogador quer (ordens, com data)
- Meta: cidade no mapa inteiro de 10 km, bonita e rápida. "Faça engenharia de verdade" (2026-10-14).
- Otimizar sem perder gráfico nem função; cada correção com commit próprio (problema + técnica +
  medida), comentário "NÃO …" onde a tentação de voltar existe, `OTIMIZACAO.md` como lista viva.
- Ir ao código, entender e corrigir por padrão; não empilhar testes (2026-10-14).
- Criar mecanismos que impeçam os padrões de voltar e que as próximas implementações não os repitam
  (2026-10-14). Pesquisar a fundo antes.
- Tudo em português do Brasil. Pesquisar (WebSearch + ler a fonte) antes de mudar arquivo.
- Testar no jogo como o jogador; toda foto tirada é examinada e o defeito visto é corrigido.
- Agentes liberados para trabalho útil, com instrução fechada e revisão do que fizeram.
- Não ficar parado esperando agente: trabalhar em paralelo.

## 2. Quem está trabalhando (sessões em paralelo no mesmo `main`)
- **"Auditoria de desempenho three.js"**: otimização, correções no código (prédios, renderer,
  world, editor, sim), regras estáticas em `scripts/check-code.mjs`.
- **"Hook de busca na internet"**: ferramentas de medida (`__roadcraft.memory()`,
  `__roadcraft.budget('rua'|'bairro'|'mapa')`, `src/core/perfBudget.ts`), o `CLAUDE.md` da raiz,
  contadores de trabalho por evento (testes de escala) e a regra "como adicionar um produto derivado".
- Combinado: uma não edita arquivo que a outra está mexendo; commit só dos próprios arquivos
  (caminhos explícitos). Cada arquivo salvo recarrega o jogo na 5300.

## 3. Estado do repositório (atualizar a cada commit) — 2026-10-14 ~13h
- No GitHub (`origin/main`): até `a4725ff` (jardins).
- Local, não enviado:
  - `247e770` memória (contadores da cena) — o jogador autorizou enviar.
  - `49d12f3` orçamento + CLAUDE.md curto — **envio NÃO autorizado ainda**; não fazer push até a
    outra sessão confirmar. Atenção: esse commit levou junto as linhas de `src/main.ts` que chamam
    `scene.holdUtilities` (trabalho da sessão de auditoria); a outra metade (`renderer.ts`) ainda não
    foi commitada, então o HEAD local não compila sozinho até ela entrar.
- Não commitado (sessão de auditoria):
  - `src/render/renderer.ts` + (já no HEAD) `src/main.ts`: segurar a camada de postes enquanto a cidade
    é traçada (`holdUtilities`). Testado no jogo: 1 montagem (169 ms) contra 66; postes vistos na foto.
    Falta: check completo e commit.
  - `src/render/buildings/buildingMesh.ts` + `kit.ts`: "portador de envio" das cascas (malha invisível
    que força o envio da geometria à GPU para soltar os arrays). **Em espera**: os 1,8 GB de cascas
    presas na CPU não se reproduziram; pode jogar até 583 MB na placa (teto do plano 300). Decidir com
    medição na sequência exata da outra sessão (cidade salva, recarregar, vista salva zoom 11,44,
    medir entre 70 e 92 s), com e sem o portador, olhando `budget('rua')`.
  - `scripts/check-code.mjs`: começo das regras novas (ver §6). Registro feito, regras ainda não.
  - `OTIMIZACAO.md`: itens 26-30.
- Não mexer (de outros): `docs/RELATORIO-DESEMPENHO-2026-10-14.md`, `tests/scale/buildingEdit.spec.ts`,
  os apagados `.claude/*`, `.githooks/pre-push` (o jogador apagou; nunca commitar a deleção nem restaurar).
- Stashes: `stash@{0}` emitTileMass (L2/L3 de massa, WIP); `stash@{1}` emissão de prédios em worker
  (WIP); os demais antigos de agentes.
- Cópia congelada para sondas longas: worktree em
  `%TEMP%/claude/C--Codex-Shared-roadcraft-2/19e8abda-.../scratchpad/probe-tree` (servida na 5301,
  junções para `node_modules` e `cooked`). Atualizar com `git -C <dir> checkout --detach <commit>`.
- Servidores: 5300 = árvore principal (`npm run dev`), 5301 = cópia congelada.
- **Portas do jogador, nunca sondar nem apagar dados**: 4180, 4181-4183, 5173, 5175-5178, e a pasta
  `C:/Codex-Shared/backup-mapa-jogador`.

## 4. Feito hoje (2026-10-14), com medida — detalhes em `OTIMIZACAO.md` itens 17-30
- Salvamento em partes comprimidas (`editor/chunkedSave.ts`): cidade de 5.400 prédios 35,8 → 2,87 MB.
- Lotes (`world/pavingIndex.ts`, grade em `fitFree`): 59,5 → 7,9 s na cidade de 2.560 m; digest idêntico.
- Postes: direção do meio-fio guardada (`KerbCache`) + reconstrução no ritmo do custo: 66 → 1 montagem.
- Calçadas (`stretch`, poda MINDIST): 1.948 → 581 ms (1.280 m); digest idêntico.
- Jardins incrementais (`render/gardens.ts`): eram 36 de 64 s no crescimento de 10 mil prédios.
- Pesquisa da cidade de 10 km: `docs/PESQUISA-CIDADE-10KM.md` (plano em 10 etapas, orçamentos §8.6).

## 5. Medidas de referência
- Cidade de 2.560 m (21.120 lotes): lotes aos 70 s; antes das correções de hoje prédios aos 188 s e
  queda para 4 prédios/s depois de 14 mil (jardins). Vista geral nessa cidade: 1 fps (durante o
  crescimento). Heap vivo depois de coletar: 727 MB.
- Triângulos por quadro (outra sessão, cidade de 5.400): rua 42 M (teto 10 M; sombras ~19 M, sombra
  das peças 8,2 M); bairro 32 M; mapa 15 M (teto 4 M; vias 6,3 M em 700 chamadas, postes e fios 4 M).
- Ordem combinada para o desenho: 1) sombra por tamanho na tela (peças e cascas); 2) vias com nível
  de longe; 3) fios e postes por distância, sem sombra longe; 4) L2/L3 dos prédios.

## 6. Mecanismos contra a volta dos padrões (em construção)
Pesquisa: `docs/research/` + memória do assistente (regression-barrier-research*.md). Fontes novas
lidas em 2026-10-14: CLARITY (Olivo, Dillig, Lin, PLDI 2015, travessia redundante), Salsa
(vermelho-verde, backdating), Jane Street Incremental, Nystrom "Dirty Flag" e "Spatial Partition",
Google Benchmark BigO, Epic "Min Screen Radius for Cascaded Shadow Maps", ESLint (só por função).
1. Regras estáticas em `scripts/check-code.mjs` (linha de base que só encolhe):
   - `whole-map-nested`: laço sobre coleção do tamanho do mapa cujo corpo (ou o que ele chama) percorre
     outra coleção do mapa. Função marcada `@rebuild` declara-se amortizada e não conta.
   - `whole-map-per-item`: varredura do mapa alcançável de função marcada `@perItem` (por prédio
     crescido, por linha de postes, por movimento do ponteiro, por edição de um item).
2. Caminho fácil certo: índice espacial dentro do `BuildingStore` (único escritor), `buildings.near(caixa)`
   na ordem de inserção; derivados por item lidos do diário (`doc.changes.since`).
3. Contadores de trabalho por evento (outra sessão): um prédio a mais em cidade de N e de 4N → o mesmo
   trabalho em cada produto derivado.

## 7. Auditoria por padrão (2026-10-14)
Relatórios completos em `docs/AUDITORIA-2026-10-14.md`. Maiores, por área:
- Prédios: `layer.update` percorre a cidade ~12× a cada mudança de prédio (layer.ts:495-657);
  `replaceWith` clona a cidade por edição de rua; vazamento de GPU ao cancelar streaming; desgaste
  refaz massas que não dependem dele; validação e clique varrem todos os prédios.
- Editor/sim/ui: geração quadrática (`growOnLot` com `neighbourStoreys`/`nearSignatures` dentro de 18
  tentativas, `doc.lots.filter` por prédio, `addPlaced`, `cornerOf`); sim refaz carros parados, lugares,
  pátios a cada prédio; overlay de lotes em JSON por quadro; snap varre tudo por movimento. Decisão do
  jogador pendente: um cruzamento trocando de controle reinicia os semáforos do mapa (achado 15).
- Render: dependentes do chão "sujos para sempre" depois de 2.048 entradas do diário sem mudança de
  chão (refeitos a cada quadro); placas de rua × todas as faixas; superfícies unem a calçada do mapa
  por edição; cânion, plataformas, atlas do chão, mobília, semáforos refeitos inteiros.
- World/core: `landOn` das calçadas varre todos os caminhos por ponta de travessia (~4×10⁹ na meta);
  `onPaving` testa todos os furos; calçadas e `crosswalkDistanceAt` refeitos por edição; LRU dos postes
  (64) mistura células e regiões (origem provável de 17 s + 35 s); **o anel único de 2.048 do diário
  faz leitores de um tipo verem `null` depois de enxurrada de outro e refazerem o mapa** (conserto
  central: `serialOf(kinds) <= since → []`).

## 8. Próximos passos (em ordem)
1. Commitar `holdUtilities` (renderer.ts) depois do check completo — conserta o HEAD local.
2. Terminar as regras do check-code (§6.1), semear a linha de base, commit.
3. Índice espacial de prédios no store + corrigir a geração quadrática (zoning, validate, addPlaced)
   com digest de cidade idêntica.
4. Correções de uma linha da auditoria (prédios 2 e 7; render 1, 2, 3).
5. `layer.update` incremental pelo diário (o maior estrutural).
6. Etapa 1 do desenho: sombra por tamanho na tela.

## 9. Diário (anexar no fim, uma linha por evento, com hora)
- 2026-10-14 ~13h30: os quatro relatórios de auditoria gravados em `docs/AUDITORIA-2026-10-14.md`
  (A prédios, B editor/sim/ui, C render, D world/core; ~90 achados). A outra sessão fez o 1º contador
  por evento (`02a690b`, local): camada de prédios lê o doc 85× (16 prédios) × 325× (64) = ×3,82 por
  prédio acrescentado; linha de base `building+1:layer` em `tests/scale/baseline.json`.
- 2026-10-14 ~13h: criada esta memória a pedido do jogador; três de quatro relatórios de auditoria
  recebidos; divisão de trabalho combinada com a sessão "Hook de busca na internet".
