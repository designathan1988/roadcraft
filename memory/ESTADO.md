# Estado do trabalho — reescrever a cada mudança (não acumular)

Atualizado: 2026-10-14 ~15h30.

## Quem está trabalhando
- **"Auditoria de desempenho three.js"**: otimização, correções no código (prédios, renderer,
  world, editor, sim), regras estáticas em `scripts/check-code.mjs`.
- **"Hook de busca na internet"**: ferramentas de medida (`__roadcraft.memory()`,
  `__roadcraft.budget('rua'|'bairro'|'mapa')`, `src/core/perfBudget.ts`), fotos e gestos
  (`scripts/look.mjs`), o acusador (`scripts/acusar.mjs`), as skills `.claude/skills/`, o
  `CLAUDE.md` da raiz, contadores de trabalho por evento (testes de escala). Pendente dela, para
  quem continuar (2026-10-14 ~16h40, o jogador vai trocar de conta):
  - contadores por evento: o do diário está feito (`a17e808`, `building+1:ground` e `ground:idle`
    x3,82 na base; o conserto D8 os leva a 0 e tira da base). Jardins (C2), `cameraSolids` (A8/C5)
    e pads (C8) esperam a auditoria extrair a parte incremental do renderer num módulo puro
    (combinado 2026-10-14); então este lado escreve o contador contra ele;
  - a regra "como adicionar um produto derivado" no CLAUDE.md: **só com o sim do jogador**
    (perguntado de novo em 2026-10-14, nova conta);
  - LSP (`workspaceSymbol`) e context7 conferidos e funcionando (2026-10-14);
  - referência offline: `C:/Codex-Shared/referencia/` (three.js r186 inteiro e 4 projetos;
    índice no `README.md` de lá).
- Combinado: uma não edita arquivo que a outra está mexendo; commit só dos próprios arquivos
  (caminhos explícitos). Cada arquivo salvo recarrega o jogo na 5300.

## Repositório
- No GitHub (`origin/main`): até `a4725ff` (jardins).
- Local, não enviado:
  - `247e770` memória (contadores da cena) — o jogador autorizou enviar.
  - `49d12f3` orçamento + CLAUDE.md curto — **envio NÃO autorizado ainda**; não fazer push até a
    outra sessão confirmar. Atenção: esse commit levou junto as linhas de `src/main.ts` que chamam
    `scene.holdUtilities` (trabalho da sessão de auditoria); a outra metade (`renderer.ts`) ainda não
    foi commitada, então o HEAD local não compila sozinho até ela entrar.
  - `02a690b` contador "um prédio a mais" (`tests/scale/buildingEdit.spec.ts`, linha de base
    `building+1:layer` 3,82) — **envio NÃO autorizado ainda** (perguntado ao jogador às ~13h40).
  - `6940134`, `267b9f5` memória e auditoria (sessão de auditoria) — documentação.
  - `6b487bb` (outra sessão) teste de escala sem limite de tempo próprio.
  - `96d1d64` postes segurados durante o traçado (`holdUtilities`) — o HEAD volta a compilar.
  - `6f22b1c` regras `whole-map-nested` / `whole-map-per-item` no check-code.
  - `f01799a` índice de prédios por lugar (`BuildingStore.near`) no crescimento e na validação.
  - `1ee7f37` (Hook) `scripts/look.mjs` e as skills `investigando-desempenho` e
    `conferindo-no-jogo` — **envio NÃO autorizado ainda**.
  - `cd4dc32` (Hook) `scripts/acusar.mjs` e `tests/arch/acusar.spec.ts` — **envio NÃO autorizado ainda**.
  - `6914c7d` (auditoria) lotes abertos.
  - `a17e808` (Hook) contador do leitor do chão pelo diário — **envio NÃO autorizado ainda**.
- Não commitado (sessão de auditoria):
  - Em `git stash` ("portador das cascas (em espera)"): `buildingMesh.ts` + `kit.ts`, "portador de envio" das cascas (malha invisível
    que força o envio da geometria à GPU para soltar os arrays). **Em espera**: os 1,8 GB de cascas
    presas na CPU não se reproduziram; pode jogar até 583 MB na placa (teto do plano 300). Decidir com
    medição na sequência exata da outra sessão (cidade salva, recarregar, vista salva zoom 11,44,
    medir entre 70 e 92 s), com e sem o portador, olhando `budget('rua')`.
  - (nada além do stash do portador)
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

## Medidas de referência
- Cidade de 2.560 m (21.120 lotes): lotes aos 70 s; antes das correções de hoje prédios aos 188 s e
  queda para 4 prédios/s depois de 14 mil (jardins). Vista geral nessa cidade: 1 fps (durante o
  crescimento). Heap vivo depois de coletar: 727 MB.
- Triângulos por quadro (outra sessão, cidade de 5.400): rua 42 M (teto 10 M; sombras ~19 M, sombra
  das peças 8,2 M); bairro 32 M; mapa 15 M (teto 4 M; vias 6,3 M em 700 chamadas, postes e fios 4 M).
- Ordem combinada para o desenho: 1) sombra por tamanho na tela (peças e cascas); 2) vias com nível
  de longe; 3) fios e postes por distância, sem sombra longe; 4) L2/L3 dos prédios.

## Mecanismos contra a volta dos padrões (em construção)
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

## Auditoria por padrão
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

## Próximos passos (em ordem)
1. Resto do quadrático da geração que a regra `whole-map-per-item` ainda lista: `growOnLot` (lotes
   abertos, `lastGrown`, `findIndex`), `cornerOf`/`onStreet` (ribbons), `footwayRise.flushIndex`.
2. Diário de mudanças: anel único de 2.048 (D8/C1) — conserto central, beneficia todos os leitores.
3. `layer.update` incremental pelo diário (A1, o maior estrutural; contador `building+1:layer` 3,82).
4. Correções de uma linha da auditoria (A2, A7, C3) e os achados `whole-map-nested` da linha de base.
5. Etapa 1 do desenho: sombra por tamanho na tela (peças e cascas).
6. Marcar `@perItem` nos outros pontos de entrada por item (movimento do ponteiro, edição de um item).

Detalhe do que já foi feito: `memory/FEITO.md`. Histórico: `memory/DIARIO.md`.
