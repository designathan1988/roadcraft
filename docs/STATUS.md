# Estado — Roadcraft 2

Atualizado ao fim de cada etapa. Plano: `docs/PLAN.md`. Problemas: `docs/PROBLEMS.md`.

## Feito

### E0 — Preparação (fechada)
- FONTE: `planeta-esfera` `4cc2926e`; 21 arquivos não commitados e os ramos `agente/*`
  listados em `docs/PLAN.md` 1.1, nada copiado deles.
- Mapas do jogador: backup duplo com manifestos SHA-256 iguais em
  `C:/Codex-Shared/_backup/roadcraft-mapas-2026-10-12` (Chrome Default, Edge, app
  desktop, `backup-mapa-jogador`); conteúdo lido de uma cópia do perfil, nunca das
  origens. Os 9 mapas reabertos no jogo antigo (4299) com fotos.
- Jogo antigo de referência: build de `git archive` da FONTE servida na 4299.

### E1 — Portão (feito; linha de base parcial no planeta)
- `scripts/gate/`: Chrome visível na RTX 3060, cenários nos dois modos pelos controles
  reais, A/B intercalado, ruído A/A, fotos por pixel, envios à GPU por tipo, LoAF,
  heap pelo DevTools, registro de rede. `gate/baseline/` com o ruído A/A e as fotos.
- Primeiros números do jogo antigo (mediana A/A, `gate/baseline/report-aa.json`): abrir
  o mapa grande do jogador no plano com quadro de ~1,4 s; via nova pronta em ~0,5 s
  (com picos de 3 s); gerar cidade com quadro de ~0,7 s; bomba com quadros de 0,2–0,6 s.
- Pendente: ruído A/A das fotos e dos números da cidade no planeta (as execuções
  perderam os passos finais pela quebra do Jolt, R1), refazer com o portão corrigido.

### E2 — Cópia e igualdade (fechada)
- Commits `7ff7726` (cópia fiel, 2.930 arquivos dos blobs, conferidos por
  `git hash-object`), `1993740` e `075ef9a` (retirada do SAI guiada por ferramenta e
  dados de teste), `7513dc0` (provas). Detalhes em `docs/MIGRATION.md`.
- Igualdade: build igual à da FONTE em 4.401 de 4.445 arquivos (as diferenças são o que
  saiu de propósito, o selo e as impressões digitais do cozimento); portão antigo × novo
  dentro da dispersão; os 9 mapas do jogador reabrem com as mesmas contagens e fotos
  dentro do ruído (0,4–2,1%).

### Teste de jogo (build nova, planeta, painel do app)
Visto e fotografado: desenhar vias (rua, avenida elevada a 5–6 m), cruzamento com
faixas, trânsito e pedestres, desfazer e refazer, zonear e casas crescendo, bomba
derrubando uma casa. Defeitos achados e registrados: R10 (poste atravessa a avenida
elevada), R11 (placa verde em pé no lote), R12 (roda do mouse leva a câmera a 14 km),
R13 (relógio pula), R14 (via provisória com seção errada por 1–2 s), R1 (bomba trava a
página).

### R1 — a bomba travava a página (corrigido na causa medida)
Build de depuração do Jolt: 5.394 asserts de eixos de junta inválidos em 12 bombas →
0 depois de `render/ragdollAxes.ts`; ver `docs/research/ragdoll-joints.md`.

## Em andamento
- E3: `eslint-rules/` (`catch` mudo, estado solto em módulo), `max-lines` 800,
  `eslint-suppressions.json` (dívida trazida: 131 `catch` mudos, 42 arquivos > 800
  linhas, 343 estados soltos), `tests/arch/imports.spec.ts` (camadas com imports
  relativos; 7 ciclos na linha de base), `knip` com linha de base (481),
  `.githooks/pre-push` + `scripts/prepush.mjs`, `npm run check` sem cobertura (os specs
  de tempo não valem com o código instrumentado).

## Próxima etapa
- Fechar a E3 (check verde, gancho ligado, A/A do portão no jogo novo), depois F1.

## NÃO VERIFICADO
- **O painel do navegador do app ficou oculto às ~08:20** e só o jogador o reabre
  (Ctrl+Shift+B). Desde então o que é visual foi verificado em janelas do Chrome
  abertas pelo Playwright (visíveis, na RTX 3060), não no painel.
- R1: a quebra da build normal é intermitente; a sonda não a reproduziu nem no jogo
  antigo. Fecha quando o portão (bomba e pistola em toda execução) passar limpo.
