# Feito e medido (o mais novo em cima)

Lista completa com arquivo:linha e fonte: `OTIMIZACAO.md`.

## 2026-10-14
- Barreira estática contra laço do mapa dentro de laço e varredura por item (`6f22b1c`, OTIMIZACAO 32).
- Índice de prédios por lugar: crescimento de 5.400 prédios 12,0 → 7,8 s, digest idêntico (`f01799a`, 33).
- Postes segurados durante o traçado: 66 montagens → 1 (`96d1d64`, 31).
- Salvamento em partes comprimidas (`editor/chunkedSave.ts`): cidade de 5.400 prédios 35,8 → 2,87 MB.
- Lotes (`world/pavingIndex.ts`, grade em `fitFree`): 59,5 → 7,9 s na cidade de 2.560 m; digest idêntico.
- Postes: direção do meio-fio guardada (`KerbCache`) + reconstrução no ritmo do custo: 66 → 1 montagem.
- Calçadas (`stretch`, poda MINDIST): 1.948 → 581 ms (1.280 m); digest idêntico.
- Jardins incrementais (`render/gardens.ts`): eram 36 de 64 s no crescimento de 10 mil prédios.
- Pesquisa da cidade de 10 km: `docs/PESQUISA-CIDADE-10KM.md` (plano em 10 etapas, orçamentos §8.6).
