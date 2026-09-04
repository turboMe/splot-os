---
name: diagram-creator
category: coding
description: "Create professional diagrams using Mermaid and PlantUML text-based tools. Covers flowcharts, sequence diagrams, architecture diagrams, ER diagrams, class diagrams, state machines, Gantt charts, mind maps, and git graphs. Use when documentation or communication requires visual representation of systems, processes, or data models."
keywords: [mermaid, plantuml, diagram, flowchart, sequence, architecture, er-diagram, uml, gantt, mindmap]
source: claude-office-skills
recommendedTier: pro
handoffCapable: true
---

# Diagram Creator

## Overview
Create professional diagrams using text-based tools — **Mermaid** (for web/markdown/GitHub) and **PlantUML** (for complex UML).

## 1. Flowchart / Process Diagram
**Use for**: Business processes, decision trees, workflows
```mermaid
flowchart TD
    A[Start] --> B{Decision?}
    B -->|Yes| C[Action 1]
    B -->|No| D[Action 2]
    C --> E[End]
    D --> E
```

## 2. Sequence Diagram
**Use for**: API calls, user interactions, system communication
```mermaid
sequenceDiagram
    participant U as User
    participant A as App
    participant S as Server
    participant D as Database

    U->>A: Click Login
    A->>S: POST /auth/login
    S->>D: Query user
    D-->>S: User data
    S-->>A: JWT token
    A-->>U: Redirect to dashboard
```

## 3. Architecture Diagram
**Use for**: System design, infrastructure
```mermaid
flowchart TB
    subgraph Client
        A[Web App]
        B[Mobile App]
    end
    subgraph Backend
        C[API Gateway]
        D[Auth Service]
        E[User Service]
        F[Order Service]
    end
    subgraph Data
        G[(PostgreSQL)]
        H[(Redis)]
        I[(S3)]
    end
    A & B --> C
    C --> D & E & F
    D --> H
    E --> G
    F --> G & I
```

## 4. Entity-Relationship Diagram
**Use for**: Database design, data models
```mermaid
erDiagram
    CUSTOMER ||--o{ ORDER : places
    ORDER ||--|{ LINE_ITEM : contains
    PRODUCT ||--o{ LINE_ITEM : "ordered in"
    CUSTOMER { int id PK; string name; string email }
    ORDER { int id PK; date created_at; int customer_id FK }
    PRODUCT { int id PK; string name; decimal price }
```

## 5. Class Diagram
**Use for**: OOP design, code structure
```mermaid
classDiagram
    class Animal {
        +String name
        +int age
        +makeSound()
    }
    class Dog { +String breed; +bark() }
    class Cat { +boolean indoor; +meow() }
    Animal <|-- Dog
    Animal <|-- Cat
```

## 6. State Diagram
**Use for**: State machines, status workflows
```mermaid
stateDiagram-v2
    [*] --> Draft
    Draft --> Submitted: Submit
    Submitted --> InReview: Assign reviewer
    InReview --> Approved: Approve
    InReview --> Rejected: Reject
    Rejected --> Draft: Revise
    Approved --> [*]
```

## 7. Gantt Chart
**Use for**: Project timelines, schedules
```mermaid
gantt
    title Project Timeline
    dateFormat  YYYY-MM-DD
    section Planning
    Requirements    :a1, 2024-01-01, 14d
    Design          :a2, after a1, 21d
    section Development
    Backend         :b1, after a2, 30d
    Frontend        :b2, after a2, 30d
    section Testing
    QA Testing      :c1, after b1, 14d
```

## 8. Mind Map
**Use for**: Brainstorming, concept organization
```mermaid
mindmap
    root((Project))
        Features
            Feature A
            Feature B
        Team
            Frontend
            Backend
        Timeline
            Q1
            Q2
```

## 9. Git Graph
**Use for**: Branch visualization, git workflows
```mermaid
gitGraph
    commit
    commit
    branch feature
    checkout feature
    commit
    commit
    checkout main
    merge feature
    commit
```

## Customization

### Themes
```
%%{init: {'theme':'forest'}}%%
```
Available: `default`, `forest`, `dark`, `neutral`

### Direction
- `TB` (top to bottom), `BT` (bottom to top)
- `LR` (left to right), `RL` (right to left)

## PlantUML Alternative
```plantuml
@startuml
actor User
participant "Web App" as App
participant "API Server" as API
database "Database" as DB

User -> App: Login request
App -> API: POST /auth/login
API -> DB: SELECT user
DB --> API: User record
API --> App: JWT token
App --> User: Redirect to dashboard
@enduml
```

## Rendering Tools
| Tool | URL | Best For |
|------|-----|----------|
| Mermaid Live | mermaid.live | Quick editing |
| PlantUML Server | plantuml.com | PlantUML |
| GitHub | paste in .md | Native rendering |
| VS Code | Mermaid extension | Local preview |

## Tips
1. **Keep it simple** — don't overcrowd
2. **Use consistent naming** — clear, descriptive labels
3. **Group related items** — use subgraphs/packages
4. **Choose appropriate type** — match diagram to concept
5. **Add legends** — when using symbols/colors
