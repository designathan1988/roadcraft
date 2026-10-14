---
name: conferindo-no-jogo
description: Confere no Roadcraft 2, como o jogador vê, se uma mudança visual ou de comportamento está certa. Monta um roteiro de câmera e gestos, roda o Chrome sem janela na placa de vídeo com scripts/look.mjs, lê cada foto em resolução total procurando defeitos, corrige o que vê e compara antes e depois. Use antes de dizer que algo funciona, depois de qualquer mudança visível (prédios, vias, terreno, sombras, luz, pessoas, veículos, interface), para fotos antes e depois de uma otimização, ou quando o jogador pedir para ver ou testar no navegador.
---

# Conferindo no jogo

Copie e marque:

```
- [ ] 1 Roteiro com as vistas onde a mudança aparece
- [ ] 2 Rodar (antes da mudança, se for comparar)
- [ ] 3 Ler cada foto com a lista abaixo
- [ ] 4 Corrigir o que viu e rodar de novo
- [ ] 5 Rodar depois e comparar com o antes
- [ ] 6 Relatar foto por foto
```

**1 Roteiro.** Copie `scripts/look/views.json` para o scratchpad e ajuste. Mesma semente nos
dois lados (`"city": { "seed": 1 }`). Passos no topo de `scripts/look.mjs`. Câmera: botão do meio
arrasta, direito gira, roda aproxima; o esquerdo é da ferramenta. Detalhe pequeno (texto, junta,
borda de sombra): `"dpr": 2` e `{ "shot": "nome", "clip": [x, y, w, h] }`.

**2 Rodar.** Siga "Antes de rodar o jogo" da skill `investigando-desempenho` (jogo no ar, nenhum
check pesado de outra sessão rodando, aviso por `SendMessage`).
`node scripts/look.mjs <roteiro.json>`. A primeira linha tem de ser a placa de vídeo (RTX); o
script para se cair em renderizador de software. Leia os erros do console em `relatorio.json`.

**3 Ler cada foto.** Abra cada PNG com Read (até 2.576 px chegam sem redução). Em cada uma:

- texto cortado, coberto, sobreposto ou em outro idioma; barra ou botão sumido havendo espaço;
- peça flutuando, atravessando, enterrada; buraco ou falta no chão, na via ou na fachada;
- faixa, serrilhado, pisca (duas faces no mesmo plano), sombra cortada ou em degrau;
- cor, luz ou sombra errada; detalhe faltando de perto ou sobrando de longe;
- o que a mudança devia mostrar: está lá, no lugar certo?

**4 Corrigir.** Cada defeito visto é corrigido e fotografado de novo. Se a correção depende de
decisão do jogador, mostre a foto a ele.

**5 Comparar.** Rode o mesmo roteiro antes e depois da mudança e abra as fotos de mesmo nome lado
a lado. Numa otimização a imagem tem de ficar igual; diferença é defeito até prova em contrário.
`node scripts/look-compare.mjs <pasta antes> <pasta depois>` conta os pixels mudados de cada par
e grava a foto da diferença (vermelho sobre o "antes" esmaecido): abra cada uma. Folhas ao vento,
carros, pessoas e o relógio do HUD mudam entre rodadas; qualquer outra mancha vermelha é defeito.
Computador mais fraco: `"cpu": 4` no roteiro deixa a CPU 4 vezes mais lenta (a GPU não).

**6 Relatar.** Ao jogador, foto por foto: o que mostra e o que foi conferido. Nunca "sem defeito"
sem dizer o que foi olhado.

## Armadilhas já vistas

- O navegador embutido do app devolve a foto no tamanho do painel (800×450): não use para imagem.
- Janela do Claude minimizada: o navegador embutido não desenha. O roteiro não depende dela.
- Arrastar com o botão esquerdo não move a câmera.
- O Chromium baixado pelo Playwright não abre nesta máquina; o script usa o Chrome instalado.
- Perfil limpo a cada rodada: não há mapa salvo; gere a cidade (`"city"`) ou carregue um mapa
  com `{ "eval": "window.__roadcraft.loadDoc(...)" }`.
- Cada arquivo salvo recarrega o jogo na 5300: rode quando ninguém estiver salvando.
