# Medir

Antes: o jogo no ar (`curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:5300/` dá 200; senão
`npm run dev`), e a outra sessão avisada (ver SKILL.md, "Antes de rodar o jogo").

## Tabela do plano

`node scripts/look.mjs <roteiro.json>` com passos `{ "budget": "rua" | "bairro" | "mapa" }`.
Espere ~6 s parado depois de mover a câmera: a GPU p95 usa os últimos 120 quadros.

## A vista do jogador

O roteiro de exemplo mede um ponto só. Para a vista em que o jogador viu o problema, peça a ele
os números do F9 e a posição da câmera (`__roadcraft.camera` no console: `x`, `y`, `zoom`) e use
`{ "lookAt": [x, y, zoom] }`. O Chrome sem janela não tem a interface do jogador aberta nem as
mesmas outras abas: compare as tendências (antes × depois no mesmo roteiro), não o número exato
com o F9 dele.

## Memória por malha

Passo `{ "eval": "JSON.stringify(window.__roadcraft.memory())" }`: geometria total, presa na CPU,
texturas e `cpuByName` (os 10 maiores donos na CPU).

## Triângulos e chamadas por nível, cor e sombra

Passo `{ "evalFile": "scripts/look/por-nivel.js" }`. Média por quadro de 1,5 s. A sombra só é
redesenhada quando algo se mexe: ponha um passo `drag` curto (botão do meio, 10 px) logo antes,
senão a média dela fica baixa demais.

## CPU da página

- F9 no jogo: fps, GPU, chamadas e avisos "hitch" das etapas acima de `STEP_BUDGETS`.
- `performance.getEntriesByType('measure')` com nomes `hitch:<etapa>`.
- O servidor manda `Document-Policy: js-profiling`: `new Profiler({ sampleInterval: 10, maxBufferSize: 10000 })`
  amostra o JavaScript da própria página.

## Trabalho por evento (sem jogo)

`npm run test:scale`: `tests/scale/edit.spec.ts` (uma via) e `tests/scale/buildingEdit.spec.ts`
(um prédio). Razão N → 4N perto de 1 é o certo; as que crescem estão em `tests/scale/baseline.json`.
