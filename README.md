# Rio Mobility Assistant API

Backend em Node.js e TypeScript para um assistente de viagens urbanas na cidade do Rio de Janeiro, com foco em transporte público multimodal e controle de gastos com deslocamentos.  
Projeto desenvolvido para a disciplina **5PDM (Programação em Dispositivos Móveis)**.

## Visão geral

Este projeto tem dois objetivos principais:

- **Assistente de viagens urbanas**  
  - Sugere rotas combinando ônibus, BRT, metrô, VLT e trem.  
  - Usa dados GTFS da API Mobilidade.Rio e dados espaciais (SIURB) da cidade do Rio de Janeiro.  
  - Entrega para o app mobile rotas já “mastigadas” para serem exibidas em mapa e lista de passos.

- **Gestão de finanças pessoais focada em transporte**  
  - Estima o custo de cada viagem sugerida.  
  - Registra o histórico de deslocamentos do usuário.  
  - Permite acompanhar quanto foi gasto com transporte em um período (dia, semana, mês).  
  - Suporta cenários como orçamento mensal de transporte e alertas quando o usuário se aproxima do limite definido.

Dessa forma, o app combina **mobilidade urbana** e **educação financeira**, integrando as propostas dos dois membros da dupla.

## Arquitetura

- **Backend**: Node.js + TypeScript + Express
- **Banco de dados**: PostgreSQL (Supabase) com PostGIS habilitado
- **Hospedagem do backend**: Web Service no Render (plano gratuito)
- **App mobile (frontend)**: Expo/React Native (projeto separado)

O backend expõe uma API REST que:

- carrega e sincroniza dados GTFS (ônibus/BRT) e dados espaciais do SIURB (metrô, VLT, trem);
- calcula rotas multimodais entre origem e destino;
- integra estimativas de custo de viagem, alimentando o módulo de finanças pessoais.

## Modelo de dados (resumo)

### GTFS (ônibus/BRT)

- `gtfs_agency`
- `gtfs_routes`
- `gtfs_stops`
- `gtfs_trips`
- `gtfs_stop_times`
- `gtfs_shapes`
- `gtfs_calendar`
- `gtfs_calendar_dates`
- `gtfs_frequencies`

### SIURB (metrô, VLT, trem)

- `metro_stations`
- `metro_lines`
- `vlt_stops`
- `vlt_lines`
- `train_lines`
- `train_stations`

### Futuro módulo financeiro

(planejado, ainda não implementado)

- `user_trips` — histórico de viagens realizadas/sugeridas
- `transport_expenses` — registro de gastos estimados ou informados pelo usuário
- possíveis tabelas auxiliares para orçamentos e categorias

## Endpoints planejados

### Saúde e testes

- `GET /health`  
  Verifica se o serviço está no ar e consegue falar com o banco.

### Administração / ETL

- `POST /admin/load-gtfs-core`  
  Carrega `agency`, `routes` e `stops` a partir da API Mobilidade.Rio.

- `POST /admin/load-gtfs-trips`  
  Carrega `trips`, `stop_times` e `shapes`.

- `POST /admin/load-metro-vlt-train`  
  Carrega dados SIURB de metrô, VLT e trem.

### Assistente de viagens

- `POST /journeys`  
  Recebe origem, destino e preferências de modal; retorna uma proposta de rota multimodal (em desenvolvimento).

### Finanças de transporte (futuro)

- `GET /expenses/summary`  
  Resumo de gastos com transporte em um período.

- `POST /expenses/manual`  
  Registro manual de despesa com transporte (ex.: corridas complementares, táxi, etc.).

## Como rodar localmente (rascunho)

1. Instale as dependências:

   ```bash
   npm install
   ```

2. Configure as variáveis de ambiente (`.env`):

   - `DATABASE_URL` — string de conexão do Supabase
   - `MOBILIDADE_API_BASE_URL` — URL base da API Mobilidade.Rio
   - `MOBILIDADE_API_KEY` (se necessário)

3. Rode o servidor em modo desenvolvimento:

   ```bash
   npm run dev
   ```

4. Teste o endpoint de saúde:

   ```bash
   curl http://localhost:3000/health
   ```

## Licença

Projeto acadêmico, uso apenas para fins educacionais na disciplina 5PDM.
