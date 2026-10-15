# Abertura rápida e desempenho em cidades imensas no Roadcraft

**Data da análise:** 15/10/2026  
**Projeto:** `C:/Codex-Shared/roadcraft-2`  
**Natureza:** diagnóstico e recomendação de arquitetura, sem implementação.

## Recomendação principal

Para o jogo abrir cidades imensas em segundos, a abertura precisa deixar de reconstruir a cidade inteira. A recomendação é completar uma arquitetura por células, do arquivo salvo até a GPU, reaproveitando o que já existe.

As correções locais continuam úteis, mas, isoladamente, não entregam esse objetivo.

## Limitações atuais da abertura

O código e as tentativas documentadas mostram o seguinte caminho:

| Na abertura atual | O que precisa acontecer |
|---|---|
| O save está dividido em partes, mas [o carregador lê todas e recompõe o documento](C:/Codex-Shared/roadcraft-2/src/editor/chunkedSave.ts:165). | Ler primeiro o manifesto, o estado necessário à simulação e as células da vista inicial. |
| [A restauração reconstrói a rede inteira](C:/Codex-Shared/roadcraft-2/src/editor/history.ts:151). | Restaurar produtos preparados e compatíveis com o save; recalcular somente o que estiver ausente ou desatualizado. |
| Há leitura de todos os derivados de determinado prefixo com `getAll`, em [derivedCache.ts:76](C:/Codex-Shared/roadcraft-2/src/render/derivedCache.ts:76). | Buscar os produtos específicos exigidos pela abertura, usando um índice. |
| [A abertura espera vários sistemas ficarem prontos](C:/Codex-Shared/roadcraft-2/src/render/renderer.ts:3369). | Liberar o jogo quando a vista inicial estiver completa e a simulação consistente. |
| Alguns detalhes descartados precisam ser emitidos novamente ao retornar. | Recarregar resultados prontos, sem repetir a geração geométrica. |

Dividir o armazenamento e usar workers ajudou, mas o caminho completo ainda exige trabalho proporcional à cidade. Mover esse mesmo trabalho para outra thread melhora a resposta da interface; o tempo total necessário continua existindo.

## 1. Transformar o save em uma cidade pronta para ser retomada

Além dos registros editáveis, guardar produtos reutilizáveis: terreno preparado, geometria das células, representações distantes e dados derivados da rede que sejam adequados à persistência.

Cada produto precisa identificar suas entradas e sua versão. Uma alteração de prédio invalida os produtos daquele prédio e das regiões dependentes. Uma mudança de código só invalida produtos cujo formato ou cálculo realmente mudou.

O save precisa ter um manifesto consistente, com índices espaciais e referências aos produtos. Trocar JSON por binário, sozinho, não resolve: abrir um arquivo menor e reconstruir tudo ainda é reconstruir tudo.

## 2. Fazer a abertura depender da vista inicial

Ao carregar:

1. Ler o manifesto e restaurar o estado necessário.
2. Carregar a representação distante do mundo.
3. Carregar o terreno, vias e prédios necessários à câmera inicial.
4. Preparar os shaders e uploads usados nessa vista.
5. Liberar a interação com essa região completa.

A distância continua representada. Ao aproximar, entram os detalhes correspondentes, preparados antecipadamente.

Esse princípio é usado pelo [World Partition da Unreal](https://dev.epicgames.com/documentation/en-us/unreal-engine/world-partition-in-unreal-engine) e pela hierarquia de detalhes do [3D Tiles](https://github.com/CesiumGS/3d-tiles/blob/main/specification/README.adoc). Serve como referência de arquitetura para aproveitar no Roadcraft.

## 3. Separar tamanho da cidade de memória ocupada

A cidade pode estar no armazenamento sem todos os seus objetos e detalhes permanecerem na RAM e na VRAM.

São três responsabilidades:

- **Documento:** o que o jogador construiu.
- **Produtos preparados:** resultados reutilizáveis da geração.
- **Residência:** o que está carregado para desenhar e interagir agora.

Ao sair de uma região, o jogo pode liberar sua residência gráfica e conservar o resultado preparado. Ao voltar, lê e envia esse resultado.

Isso resolve os dois extremos encontrados nas tentativas: manter tudo até esgotar a memória ou descartar resultados e pagar novamente pela geração. A fidelidade das representações distantes precisa ser validada nas mesmas vistas, preservando silhuetas e detalhes perceptíveis.

## 4. Concluir a atualização local em toda a cadeia

As células precisam governar também alturas, vias, lotes, vegetação, elementos e dependências da simulação.

A análise encontrou operações que identificam uma mudança local e depois copiam caches, percorrem rotas ou recompõem coleções inteiras. Enquanto isso persistir, editar uma rua numa cidade enorme continuará caro.

O critério de correção deve ser: a mesma edição visita apenas os dados realmente afetados, mesmo quando aumenta a cidade ao redor. Os contadores precisam incluir essas visitas e cópias, não apenas a parte principal do cálculo.

Os casos concretos e suas soluções estão no [relatório de auditoria de desempenho](C:/Codex-Shared/roadcraft-2/docs/RELATORIO-AUDITORIA-DESEMPENHO-2026-10-15.md).

## 5. Dar à simulação uma arquitetura própria de escala

Executar a simulação em worker é uma etapa útil: ela passa a ter um dono, recebe comandos e entrega estados para o desenho interpolar. Evitaria manter duas simulações completas competindo entre si.

Para cidades muito maiores, também será necessário decidir quanto detalhe comportamental manter em toda a rede. Modelos mesoscópicos são uma possibilidade documentada no [SUMO](https://sumo.dlr.de/docs/Simulation/Meso.html), mas mudam a representação da simulação. Precisam de validação de fluxo, viagens, filas e transições; não podem ser apresentados como uma troca automaticamente equivalente.

Mover milhões de atualizações individuais para um worker não elimina seu custo.

## 6. Implementar primeiro uma cadeia completa e mensurável

O ponto de partida recomendado é a reabertura de uma cidade salva, com este percurso completo:

> Salvar produtos consistentes → fechar → reabrir → restaurar produtos → apresentar a vista inicial completa → navegar → revisitar sem regerar.

Usar cidades pequenas, médias e grandes, registrando separadamente leitura, descompressão, restauração, reconstrução, shaders e uploads. Distinguir abertura com produtos preparados de abertura com produtos ausentes ou incompatíveis.

Essa entrega demonstraria a arquitetura antes de expandi-la aos demais sistemas. Já há propostas semelhantes no [PLANO-ESPINHA](C:/Codex-Shared/roadcraft-2/docs/PLANO-ESPINHA-2026-10-14.md:301); o trabalho necessário é fazê-las funcionar de ponta a ponta.

## Abertura em segundos e geração inicial

Reabrir uma cidade preparada e começar a jogar é o objetivo adequado para essa arquitetura.

Gerar pela primeira vez todos os prédios, vias e derivados de uma cidade enorme exige trabalho proporcional ao conteúdo criado. Para começar rapidamente nesse caso, a geração também precisa ser determinística e regional, com produtos distantes disponíveis e detalhes preparados conforme a necessidade.

## Decisão recomendada e limites da análise

Manter a base atual e priorizar a mudança de abertura e persistência. Os arquivos mostram que existem peças aproveitáveis. Ainda não há evidência que justifique trocar engine ou linguagem.

Não há medição desta sessão que permita prometer um número de segundos: essa promessa precisa ser demonstrada no carregamento real, incluindo a primeira abertura, a navegação e o retorno às regiões.

Nenhum código foi alterado nesta análise. Não foram executados novos testes ou medições de abertura para esta recomendação. **NÃO VERIFICADO:** tempo de abertura após as mudanças propostas, FPS, consumo de memória e equivalência visual/comportamental da arquitetura proposta.

Este arquivo materializa a recomendação apresentada no chat. Os relatórios e documentos anteriores foram preservados. As referências de linha correspondem ao código examinado em 15/10/2026 e podem se deslocar em alterações posteriores.
