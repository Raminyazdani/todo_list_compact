# Implementation dependency graph

Status: NOT RUN unless noted. This graph describes engineering dependencies; product task dependencies are separately persisted domain data.

```mermaid
flowchart TD
  A[Read contracts and audit actual resources] --> B[Approve shared domain DTO/auth/error/date contracts]
  A --> R[Reference calendar/workflow inventory]
  A --> M[Live read-only private source snapshot]
  B --> D[PostgreSQL migrations and domain transactions]
  B --> U[Design system and authenticated UI]
  B --> P[REST/OpenAPI and protected MCP adapters]
  B --> I[Google/storage/AI provider adapters]
  D --> V[Task and graph/checklist vertical slice]
  U --> V
  P --> V
  V --> F[Full project/task/graph views and files]
  V --> C[Calendar and work logs/XLSX]
  R --> C
  V --> AI[AI preview/approval/execute/readback]
  M --> MIG[Idempotent dry-run importer and reconciler]
  D --> MIG
  I --> MIG
  F --> Q[Independent integration/security/a11y/load and restore]
  C --> Q
  AI --> Q
  MIG --> Q
  P --> Q
  Q --> DEP[Approved durable production infrastructure and deploy]
  DEP --> LIVE[Production auth/UI/MCP/migration/redeploy verification]
  LIVE --> H[Evidence checklist and Persian handoff]
```

| Node       | Current state | Exit evidence                                                              |
| ---------- | ------------- | -------------------------------------------------------------------------- |
| A          | ACTIVE        | Actual audit, source/repo capabilities, full requirements                  |
| B          | NOT RUN       | Shared contract approved and discoverable                                  |
| R          | ACTIVE        | Reference inventory and reuse/license/security assessment                  |
| M          | NOT RUN       | Complete private source snapshot plus freshness/aggregate report           |
| D/U/P/I    | NOT RUN       | Implementations and focused tests against approved contracts               |
| V          | NOT RUN       | Browser/REST/MCP same DB; A/B/C/D + checklists + auth/retry/conflict/cycle |
| F/C/AI/MIG | NOT RUN       | Module and source preservation tests                                       |
| Q          | NOT RUN       | Actual result matrix, vulnerability review and staging restore             |
| DEP/LIVE   | NOT RUN       | Observed production resources/URL/SHA/auth/client/readback/redeploy        |
| H          | NOT RUN       | AC-01..28 grounded in verified evidence                                    |

An authorization issue in one provider does not block independent nodes. Source mutation, external communications, paid resources and unsupported client privileges cannot be bypassed.
