# Roadcraft

Jogo de construir cidades no navegador (TypeScript, three.js r186, Vite). Jogo: `npm run dev` (127.0.0.1:5300).
Typecheck: `npm run typecheck`. Testes: `npx vitest run <arquivos>`.

## Ver o jogo e medir: Chrome headless pelo Playwright

Para abrir o jogo, tirar print ou medir, use o Chrome headless pelo Playwright (`chromium.launch({ channel:
'chrome', headless: true, args: [...] })`, como `scripts/lib/measureCity.mjs` e `scripts/look.mjs` fazem).
**Não use o navegador embutido do app** (painel do navegador, ferramentas `mcp__Claude_Browser__*`). Ele divide a
GPU com a interface do app, tem 800x450 e, se ficar com o jogo aberto, continua renderizando e estraga toda
medição seguinte. Se ele estiver aberto com o jogo, feche a aba.

## A sonda: o que é pesado se acha contando, não cronometrando

`node scripts/sonda.mjs` (com `npm run dev` rodando) traz **tudo** o que o jogo faz, por elemento e por linha de
código: polígonos, vértices, malhas, instâncias e bytes de cada elemento da cena; desenhos por quadro e por passe;
o que atualiza (matrizes, buffers, texturas, materiais, visibilidade) e com que frequência; o que cria e recria;
quantas vezes cada função é chamada; quem aloca memória; chamadas WebGL; mensagens dos workers; timers, eventos,
rede, IndexedDB, localStorage e DOM. Faz isso nos cenários parado, jogando e câmera andando, em três vistas. O
relatório fica em `test-results/sonda/relatorio.txt`.
- Ela não julga: não tem limite nem corte. Toda lista sai inteira e ordenada.
- Ela conta, não cronometra, e contagens são iguais em qualquer máquina. Tempo de GPU depende da placa, do clock
  e de outros processos, e já levou a causas falsas.
- No cenário parado (relógio parado, câmera parada), o que ainda atualiza ou cria é o primeiro suspeito de
  trabalho sem necessidade.

## Medições: a máquina tem que estar livre

Uma medição de GPU, CPU ou memória só vale se nada além dela estiver usando a máquina. Em 2026-10-18 o jogo
ficou aberto no painel do navegador do app (claude.exe) e ocupou 99 % do motor 3D da GPU. Com a mesma cena,
triângulo por triângulo, o tempo de GPU do bairro deu 17, 22 ou 37 ms, conforme a carga desse processo. Tirei
conclusões falsas disso. Por exemplo, "o desgaste caiu de 8,5 para 2,9 ms" estava errado.

**Antes de toda medição:**

1. Veja quem está usando a GPU, a CPU e a memória:
   - GPU, por processo:
     ```powershell
     (Get-Counter '\GPU Engine(*engtype_3D)\Utilization Percentage').CounterSamples | Where-Object { $_.CookedValue -gt 1 } | ForEach-Object { $p = [regex]::Match($_.InstanceName,'pid_(\d+)').Groups[1].Value; "{0,6:N1}%  pid {1}  {2}" -f $_.CookedValue, $p, (Get-Process -Id $p).ProcessName }
     ```
   - GPU, geral: `nvidia-smi --query-gpu=clocks.gr,pstate,utilization.gpu,power.draw --format=csv`. Parada, ela fica perto de 0 % e em P5/P8.
   - CPU: `Get-Process | Sort-Object CPU -Descending | Select-Object -First 15 Name,Id,CPU,WS`. Para ver o uso de agora, use `Get-Counter '\Process(*)\% Processor Time'`.
   - Memória: `Get-CimInstance Win32_OperatingSystem | Select FreePhysicalMemory,TotalVisibleMemorySize`, e os processos com mais `WS`.
2. Feche o que for seu e não fizer parte da medição:
   - o jogo aberto no painel do navegador do app (`tabs_close`);
   - Chromes headless que sobraram de scripts anteriores;
   - um segundo servidor de desenvolvimento, testes ou builds rodando em segundo plano;
   - qualquer outra aba ou janela com o jogo.
3. Programas do usuário (navegador dele, jogos, editores) não se fecham por conta própria. Diga ao usuário qual
   processo está usando quanto e peça para ele fechar, ou meça e informe junto com o resultado que a máquina
   estava ocupada.
4. Não edite `src/` com uma medição rodando. O Vite recarrega a página e a medição perde o sentido.

**Os scripts de medição** (`scripts/shellMaps.mjs`, `material.mjs`, `materialEach.mjs`, `buildingParts.mjs`,
`layers.mjs`, `gpuSteady.mjs`) abrem a cidade por `scripts/lib/measureCity.mjs`. Essa biblioteca:
- se recusa a medir quando outro processo usa a GPU (`gpuNeighbours`). `--shared-gpu` força a medição;
- liga o modo de medição do jogo (`__roadcraft.measure(true)`): o relógio da simulação fica parado (sol, sombras,
  população e veículos não mudam) e sai um quadro a cada atualização da tela;
- espera a cena assentar: nada pendente para chegar e os triângulos, o detalhe, os veículos e as pessoas parados
  por 4 s;
- registra a cena em cada janela de medida. Se ela mudar, imprime "CENA MUDOU – MEDIÇÃO INVÁLIDA", e esse número
  não serve.

Um script novo de medição usa essa biblioteca. Comparações A/B alternam as variantes na mesma página, em várias
voltas, e reportam a mediana. Uma diferença menor que o espalhamento das voltas não é resultado.

O governador de tempo de GPU que mudava o detalhe dos prédios foi removido (ordem do usuário, 2026-10-18). Não
volte com ele: ele mudava a cena no meio de toda medição.
