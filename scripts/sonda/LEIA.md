# Sonda, Etapa 0 (piloto sem tocar no jogo)

Plano: `C:\Users\Jonathan\Documents\roadcraft\PLANO-SONDA.md` (§3 [B] e [C], §4, §5, §6 Etapa 0).

```
npm run dev
node scripts/sonda/rodar.mjs
```

Saída em `test-results/sonda/<data>/`: `relatorio.md`, `achados.json`, `contadores.json`, `codigo-morto.md`, `imagens/` e `bruto/`.

Opções:
- `--fase=contagem` ou `--fase=limpa` roda só um dos passes.
- `--sem-snapshot` pula os instantâneos do heap, que levam minutos com o heap de 800 MB.
- `--maquina-ocupada` roda mesmo com outro processo na GPU ou na CPU. O relatório diz que os tempos têm ruído.
- `--so-analisar=<pasta>` refaz só a análise de uma rodada já gravada.
- `--base=http://127.0.0.1:<porta>/` mede outro servidor.

## Arquivos

| Arquivo | O que faz |
|---|---|
| `rodar.mjs` | O piloto. Abre o Chrome instalado pelo Playwright, roda o roteiro duas vezes e chama o analisador. O passe de **contagem** grava cobertura, alocações, instantâneos e mensagens, sem cronometrar. O passe **limpo** grava perfil de CPU, trace, LoAF e imagens. |
| `roteiro.mjs` | As cenas 1 a 9 do §5. Cada cena separa a preparação (mudar a vista, assentar) da janela medida, com `ctx.since()`. |
| `pagina.mjs` | O que roda dentro da página e dos workers. São o observador de LoAF, a contagem de quadros, as mensagens dos workers no passe de contagem e as leituras do `__roadcraft`. |
| `coleta.mjs` | Os coletores do protocolo do DevTools: cobertura, perfil, alocações, heap, instantâneo e as fontes com os mapas do Vite. |
| `fontes.mjs` | Converte a linha servida pelo Vite na linha do código-fonte, pelos mapas embutidos. |
| `analisar.mjs` | As regras da Etapa 0: trava, vazamento, codigo-morto (cruzado com o knip), clone-grande e parado-rodando. Deduplica pela linha da causa e ordena pelo custo medido. |
| `config.json` | Os limiares, cada um com o porquê. |
| `PROXIMOS-PASSOS.md` | Os 6 defeitos de medição e a lista para src/, anexada ao fim do relatório. |

## O que foi aproveitado das ferramentas que já existiam

- **`scripts/lib/measureCity.mjs`:** as flags do Chrome (`CHROME_ARGS`, ANGLE D3D11, sem estrangular aba escondida) e a recusa de máquina ocupada (`gpuNeighbours`, `cpuNeighbours`). Também a ideia de "cena assentada", em que a assinatura fica igual por alguns segundos.
- **`scripts/look.mjs`:** a forma de pedir perfil de CPU, amostragem de alocações com os objetos já coletados, instantâneo do heap em pedaços, LoAF por `PerformanceObserver` e a espera pela marca `opening:shown`. Os resumos dele (`summarise`, `allocationStats`) serviram de modelo para o analisador.
- **`scripts/sonda.mjs` (o gravador por segundo):** a leitura dos mapas embutidos do Vite com `source-map-js`, a conversão de deslocamento de cobertura para linha, e o embrulho de `Worker.postMessage` e `MessagePort` com o tamanho estimado. Ele continua existindo, porque grava por segundo e por elemento da cena, coisa que a Etapa 0 não faz.
- **`scripts/frames.mjs`, `layers.mjs`, `material.mjs`, `gpuSteady.mjs`:** a sonda não os usa. São medidas de A/B de tempo de GPU por camada e por material, que ficam para a Etapa 2. O `frames.mjs` foi reescrito sobre o `openCity` (AST-15).
- **API `window.__roadcraft` (src/main.ts, só em DEV):** a sonda lê `memory()`, `budget()`, `scene().shadowStats()`, `scene().buildingLevels()`, `ledger()`, `__frames`, `__gpu`, `__state`, e usa `smallCity`, `setView`, `setTraffic`, `redraw`, `view().toScreen`. As cenas 7 e 9 usam gestos do jogador: teclas e o mouse no canvas. A cena 8 usa `scene().setQuality`, `doc.setWeather` e `scene().setSkyMode`.
