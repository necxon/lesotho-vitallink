# Lesotho Vital-Link

A Docker Compose sandbox that simulates Lesotho's national health-system integration
stack - the full data flow from a community health worker's Android app through to
national logistics and reporting systems, all over FHIR.

A field worker records a dispense, stock order, or receipt in the OpenSRP / FHIR-Core
Android app. The event flows through OpenHIM to the Vital-Link mediator, which fans it
out to the connected systems and keeps stock and reporting in sync.

## What it integrates

- OpenSRP 2 / FHIR Core - Android field app for community health workers
- HAPI FHIR - FHIR R4 clinical data store
- OpenHIM - integration middleware (channel routing, audit log, transaction replay)
- Vital-Link Mediator - orchestrates the fan-out and the stock lifecycle logic
- OpenLMIS (eLMIS) - logistics and stock management
- DHIS2 - aggregate health data and national reporting
- Keycloak - single sign-on, identity and access management
- bkm-web - admin portal (service status, FHIR browser, stock, user management)
- Grafana / Prometheus / Loki - monitoring, metrics and logs

## Architecture

```mermaid
flowchart TD
    App["Android Field App<br/>OpenSRP 2 / FHIR-Core"]
    Portal["bkm-web<br/>Admin Portal"]
    OpenHIM["OpenHIM<br/>routing · audit · replay · :5001"]
    Med["Vital-Link Mediator<br/>fan-out + order buffer · :3000"]
    OpenSRP["OpenSRP<br/>care register · :9900"]
    FHIR["HAPI FHIR<br/>FHIR R4 store · :8079"]
    LMIS["OpenLMIS / eLMIS<br/>stock management · :8082"]
    DHIS2["DHIS2<br/>national reporting · :8081"]
    KC["Keycloak<br/>identity / SSO · :8083"]

    App -->|"FHIR R4: dispense / order / receipt"| OpenHIM
    OpenHIM -->|"HTTP :3000"| Med
    Med -->|"FHIR events"| OpenSRP
    Med -->|"app config · patients"| FHIR
    Med -->|"stock events: DEBIT / CREDIT"| LMIS
    Med -->|"aggregate data values"| DHIS2
    LMIS -.->|"dhis2-integration reads stockCardSummaries"| DHIS2
    Portal -->|"REST"| Med
    App -.->|"OAuth"| KC
    Portal -.->|"OAuth"| KC
    Med -.->|"service tokens"| KC

    subgraph infra ["Shared infrastructure"]
        direction LR
        PG["PostgreSQL :5432"]
        MQ["RabbitMQ :5672"]
        Mail["MailHog :8025"]
        Mon["Grafana · Prometheus · Loki"]
    end

    classDef app  fill:#34a853,color:#fff,stroke:#2c8c46
    classDef him  fill:#4285f4,color:#fff,stroke:#3367d6
    classDef med  fill:#ea4335,color:#fff,stroke:#c5221f
    classDef srp  fill:#fbbc04,color:#000,stroke:#e0a800
    classDef fhir fill:#ff8a65,color:#000,stroke:#f4511e
    classDef lmis fill:#7cc7ed,color:#000,stroke:#4a9fd4
    classDef dhis fill:#1aa085,color:#fff,stroke:#147a66
    classDef kc   fill:#9c27b0,color:#fff,stroke:#7b1fa2
    classDef inf  fill:#90a4ae,color:#fff,stroke:#607d8b

    class App app
    class OpenHIM him
    class Med med
    class OpenSRP srp
    class FHIR fhir
    class LMIS lmis
    class DHIS2 dhis
    class KC kc
    class Portal,PG,MQ,Mail,Mon inf
```

## Quick start

```bash
make start   # brings up the OpenLMIS + main stacks and seeds them
```

See [docs/](docs/) for architecture and setup, and [docs/architecture.md](docs/architecture.md)
for the full data flow. Contributions: see [CONTRIBUTING.md](CONTRIBUTING.md). Licensed under
Apache 2.0 (see [LICENSE](LICENSE)).
