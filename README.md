# Conty — rastreamento de produtos enviados a criadores

API de rastreamento para cadastro de códigos, consulta de um agregador HTTP fictício, normalização de eventos e alertas de atraso.

## Requisitos e execução

Requer Node.js 24.15 ou superior e npm. O projeto usa `node:sqlite`; o módulo está marcado como release candidate nas versões utilizadas e emite um aviso de estabilidade quando iniciado diretamente.

```sh
npm ci
npm run typecheck
npm test
npm run build
```

Inicie o agregador em um terminal e a API em outro:

```sh
npm run dev:aggregator
npm run dev
```

A API fica em `http://localhost:3000`; o agregador, em `http://localhost:4001`.
Para iniciar os processos já compilados, execute `npm run build`, depois `npm start` e `npm run start:aggregator`.

## Configuração

| Variável | Padrão | Uso |
|---|---|---|
| `PORT` | `3000` | Porta da API |
| `DATABASE_PATH` | `./data/tracking.sqlite` | Arquivo SQLite; `:memory:` abre em memória |
| `DELAY_THRESHOLD_HOURS` | `72` | Limite aplicado a cadastros sem limite próprio |
| `AGGREGATOR_URL` | `http://localhost:4001` | URL base do agregador |
| `AGGREGATOR_PORT` | `4001` | Porta do mock HTTP |

Um envio conserva o limite definido no cadastro. Repetir o cadastro sem limite explícito mantém a configuração existente; informar limite diferente retorna `409`.

## Demonstração

O mock inicia com códigos de exemplo. Cadastre um deles na API e sincronize:

```sh
curl.exe -X POST http://localhost:3000/shipments `
  -H "Content-Type: application/json" `
  -d '{"trackingCode":"DEMO-OUT-OF-ORDER","carrier":"mock_express"}'

curl.exe -X POST http://localhost:3000/shipments/{ID}/sync
curl.exe http://localhost:3000/shipments/{ID}
curl.exe http://localhost:3000/shipments/{ID}/events
```

Substitua `{ID}` pelo valor retornado no cadastro. Use `DEMO-DELIVERED` para entrega concluída, `DEMO-DELAYED` para atraso, `DEMO-UNKNOWN` para status desconhecido ou `DEMO-POSTAL` para os códigos da segunda transportadora. A rota de saúde é `GET /health`.

## API

| Método e caminho | Operação |
|---|---|
| `POST /shipments` | Cadastra `trackingCode`, `carrier` e, opcionalmente, `delayThresholdHours` |
| `POST /shipments/:id/sync` | Consulta o agregador e incorpora eventos idempotentemente |
| `GET /shipments/:id` | Consulta status, marco inicial, limite e atraso atual |
| `GET /shipments/:id/events` | Consulta histórico normalizado e códigos brutos |
| `POST /shipments/:id/check-delay` | Verifica e registra alerta com os dados disponíveis |
| `GET /shipments/:id/alerts` | Consulta detecção e resolução de alertas |

Exemplo de cadastro:

```json
{
  "trackingCode": "BR123456789",
  "carrier": "mock_express",
  "delayThresholdHours": 72
}
```

A criação retorna `201`; cadastro repetido, `200`. Erros usam `{ "error": { "code": "...", "message": "..." } }`: `400` para entrada inválida, `404` para envio ou código remoto inexistente, `409` para conflito de configuração, `502` para erro ou payload remoto inválido e `504` para timeout.

## Contrato do agregador fictício

`POST /trackings` recebe `{"tracking_number":"...","carrier":"..."}` e registra o código idempotentemente. `GET /trackings?carrier=...&tracking_number=...` retorna `{ "tracking_number": "...", "carrier": "...", "events": [...] }`. O mock conserva os dados em memória e oferece exemplos iniciais fixos para repetição determinística.

Para adicionar eventos de exemplo durante a demonstração, o mock aceita `POST /__mock/trackings/:carrier/:trackingNumber/events` com `{"events":[{"id":"evt-1","code":"AWAITING_DRONE_PICKUP","timestamp":"2025-08-05T12:00:00Z"}]}`. Essa rota só existe no servidor fictício de desenvolvimento.

Payload externo:

```json
{
  "tracking_number": "BR123456789",
  "carrier": "mock_express",
  "events": [
    { "id": "evt_100", "code": "POD_OK", "description": "Entregue", "timestamp": "2025-08-04T08:00:00Z" }
  ]
}
```

Status desconhecido no histórico:

```json
{
  "eventKey": "external:evt-unknown",
  "rawStatus": "AWAITING_DRONE_PICKUP",
  "normalizedStatus": null,
  "occurredAt": "2025-08-05T12:00:00.000Z"
}
```

O adaptador normaliza `mock_express` (`OBJ_POSTED`, `MOVING`, `ON_ROUTE`, `POD_OK`, `ADDRESS_PROBLEM`) e `mock_postal` (`POSTAGEM_CONFIRMADA`, `EM_TRANSFERENCIA`, `SAIU_PARA_ENTREGA`, `ENTREGA_REALIZADA`, `ENDERECO_INCORRETO`). Outros códigos mantêm `normalizedStatus: null`; nunca implicam entrega.

## Regras e limitações

O início do trânsito é o evento mais antigo entre postagem e primeiro trânsito. Atraso exige que o tempo ultrapasse estritamente o limite e que não haja entrega conhecida. Sem esses eventos iniciais, não é possível calcular o atraso. Um evento fora de ordem permanece no histórico; a projeção é reconstruída por ocorrência, com desempate estável. Exceções podem ser resolvidas por evento posterior da mesma etapa ou de etapa superior. Entrega é terminal.

Eventos com ID externo usam esse ID para deduplicação. Sem ID, a chave deriva da transportadora, código, status bruto e data normalizados; ocorrências distintas com os mesmos dados serão indistinguíveis. O cliente HTTP tem timeout de cinco segundos. A detecção de atraso ocorre na sincronização ou na verificação explícita; não há tarefa periódica, e-mail ou webhook. O aviso fica disponível na API e pode ser consultado pelo endpoint de alertas.

## Uso de IA e revisão

**Uso de IA:** ChatGPT/Codex auxiliou na implementação do domínio, adaptador HTTP, persistência SQLite, API, mock, testes e documentação.

**O que foi revisado:** o diff foi conferido pelo Codex contra o enunciado e os critérios de avaliação. `npm ci` concluiu com zero vulnerabilidades; `npm run typecheck`, `npm test` (17 testes), `npm run build` e `npm audit` passaram. Um smoke test com os dois processos ativos confirmou desordem, deduplicação e entrega sem falso atraso. O candidato ainda precisa fazer sua própria revisão antes da submissão.
