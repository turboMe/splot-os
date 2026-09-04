---
name: infrastructure-as-code
category: devops
description: >-
  Infrastructure as Code (IaC) basics for GCP/AWS with Terraform and
  docker-compose. Covers when to use which tool, state management safety,
  common GCP patterns (Cloud Run, MongoDB Atlas, Secret Manager), and
  essential Terraform workflow. Trigger: "terraform", "IaC", "infrastructure",
  "provision resources", "cloud setup", "docker-compose production".
keywords: [terraform, IaC, infrastructure, GCP, AWS, docker-compose, cloud, provisioning, state]
allowedTools: [shell_execute, fs_read_file, fs_write_file]
minComplexity: moderate
recommendedTier: pro
estimatedTokens: 2150
outputFormat: markdown
tags: [devops, terraform, IaC, gcp, cloud]
version: 1
success_rate: null
total_uses: 0
last_used: null
handoffCapable: true
---
# Infrastructure as Code

> IaC = infrastructure managed as versioned code, not via console clicks.
> Changes are reviewed, tested, and audited just like application code.

## Tool Selection Guide

```
┌─────────────────────────────────────────────────────────────┐
│ When to use what?                                            │
├─────────────────────────────────────────────────────────────┤
│ docker-compose      │ Local dev + single-server staging      │
│                     │ ✅ Simple, no state, fast iteration    │
│                     │ ❌ Not for multi-region, no drift det. │
├─────────────────────────────────────────────────────────────┤
│ Terraform           │ Cloud resources (VMs, DBs, DNS, IAM)  │
│                     │ ✅ State tracking, plan/apply, modules │
│                     │ ❌ Steep learning, state can drift     │
├─────────────────────────────────────────────────────────────┤
│ Cloud-native CLI    │ One-off resource creation / exploration│
│ (gcloud/aws)        │ ✅ Fast, direct, great for debugging   │
│                     │ ❌ No audit trail, hard to reproduce   │
└─────────────────────────────────────────────────────────────┘
```

**Decision rule:**
- **Local / single-server:** docker-compose
- **Cloud resources that need version control:** Terraform
- **Quick one-off:** gcloud/aws CLI (then codify in Terraform later)
- **Never:** console clicks for production resources

---

## docker-compose: Production-Ready Patterns

### Current project stack (reference)
```yaml
# docker-compose.yml
version: '3.9'
services:
  mongodb:
    image: mongo:7
    restart: unless-stopped
    ports:
      - "27017:27017"
    environment:
      MONGO_INITDB_ROOT_USERNAME: ${MONGO_USER}
      MONGO_INITDB_ROOT_PASSWORD: ${MONGO_PASSWORD}
    volumes:
      - mongo_data:/data/db
    healthcheck:
      test: ["CMD", "mongosh", "--eval", "db.adminCommand('ping')"]
      interval: 30s
      timeout: 10s
      retries: 3

  n8n:
    image: n8nio/n8n:latest
    restart: unless-stopped
    ports:
      - "5678:5678"
    environment:
      N8N_ENCRYPTION_KEY: ${N8N_ENCRYPTION_KEY}
      DB_TYPE: mongodb
      DB_MONGODB_CONNECTION_URL: mongodb://mongodb:27017/n8n
    depends_on:
      mongodb:
        condition: service_healthy

volumes:
  mongo_data:
    driver: local
```

**docker-compose safety rules:**
- Never commit `.env` files — use `.env.example` with placeholders
- Pin image versions (not `latest` in production) for reproducibility
- Always add `healthcheck` and `restart: unless-stopped`
- Use named volumes (not bind mounts) for database data

---

## Terraform: Core Workflow

```bash
# 1. Initialize (download providers)
terraform init

# 2. Format code
terraform fmt

# 3. Validate syntax
terraform validate

# 4. Plan (dry run — shows what WILL change)
terraform plan -out=tfplan

# 5. Review the plan carefully (see State Management section)

# 6. Apply
terraform apply tfplan

# 7. Verify
terraform show
```

**CRITICAL:** Never run `terraform apply` without first running `terraform plan` and reviewing the output.

---

## Terraform: State Management Safety

Terraform state (`terraform.tfstate`) tracks real resources. Corrupted state = major incident.

### State backend setup (always use remote state)
```hcl
# backend.tf
terraform {
  backend "gcs" {
    bucket = "PROJECT_ID-terraform-state"
    prefix = "mastra-agentic"
  }
}
```

```bash
# Create the state bucket first (one-time manual step)
gsutil mb -l europe-central2 gs://PROJECT_ID-terraform-state
gsutil versioning set on gs://PROJECT_ID-terraform-state
```

### State safety rules

| Rule | Why |
|------|-----|
| Remote backend always | Local state gets lost, not shared |
| Enable bucket versioning | Roll back corrupt state |
| Lock state during apply | Prevent concurrent modifications |
| Never edit state manually | Use `terraform state` commands only |
| Backup before destructive ops | `terraform state pull > backup.tfstate` |

### Importing existing resources
```bash
# If resource was created manually, import it into state
terraform import google_cloud_run_service.app projects/PROJECT/locations/REGION/services/SERVICE
```

### Moving resources without recreating
```bash
# Rename a resource in state (after refactoring)
terraform state mv old_resource_name new_resource_name
```

---

## GCP Terraform Patterns

### Cloud Run service
```hcl
resource "google_cloud_run_service" "app" {
  name     = "mastra-agentic"
  location = var.region

  template {
    spec {
      containers {
        image = "${var.region}-docker.pkg.dev/${var.project_id}/${var.repo}/app:latest"
        ports { container_port = 4111 }
        
        resources {
          limits = { memory = "1Gi", cpu = "1" }
        }

        env {
          name = "NODE_ENV"
          value = "production"
        }

        env {
          name = "MONGODB_URI"
          value_from {
            secret_key_ref {
              name = google_secret_manager_secret.mongodb_uri.secret_id
              key  = "latest"
            }
          }
        }
      }
      service_account_name = google_service_account.app.email
    }

    metadata {
      annotations = {
        "autoscaling.knative.dev/minScale" = "1"
        "autoscaling.knative.dev/maxScale" = "10"
      }
    }
  }

  traffic {
    percent         = 100
    latest_revision = true
  }
}

# Allow public access
resource "google_cloud_run_service_iam_member" "public" {
  service  = google_cloud_run_service.app.name
  location = google_cloud_run_service.app.location
  role     = "roles/run.invoker"
  member   = "allUsers"
}
```

### Secret Manager
```hcl
resource "google_secret_manager_secret" "mongodb_uri" {
  secret_id = "mongodb-uri"
  replication { automatic {} }
}

resource "google_secret_manager_secret_version" "mongodb_uri" {
  secret      = google_secret_manager_secret.mongodb_uri.id
  secret_data = var.mongodb_uri  # passed via -var or .tfvars
}

resource "google_secret_manager_secret_iam_member" "app_access" {
  secret_id = google_secret_manager_secret.mongodb_uri.id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.app.email}"
}
```

### Artifact Registry
```hcl
resource "google_artifact_registry_repository" "docker" {
  location      = var.region
  repository_id = "mastra-images"
  format        = "DOCKER"
}
```

### Service account with minimal permissions
```hcl
resource "google_service_account" "app" {
  account_id   = "mastra-app-sa"
  display_name = "Mastra Agentic App"
}

resource "google_project_iam_member" "app_roles" {
  for_each = toset([
    "roles/run.invoker",
    "roles/secretmanager.secretAccessor",
    "roles/artifactregistry.reader",
  ])
  project = var.project_id
  role    = each.value
  member  = "serviceAccount:${google_service_account.app.email}"
}
```

---

## Variables & Secrets Pattern

```hcl
# variables.tf
variable "project_id" { type = string }
variable "region"     { type = string; default = "europe-central2" }
variable "mongodb_uri" {
  type      = string
  sensitive = true  # never logged in plan output
}
```

```bash
# terraform.tfvars (NEVER commit to git — add to .gitignore)
project_id  = "my-project-123"
region      = "europe-central2"
mongodb_uri = "mongodb+srv://..."

# Or use environment variables
export TF_VAR_mongodb_uri="mongodb+srv://..."
```

---

## Destructive Operations — Extra Caution Required

These Terraform operations destroy data. Always:
1. Run `terraform plan` and carefully read the `destroy` sections
2. Backup state: `terraform state pull > backup-$(date +%Y%m%d).tfstate`
3. Verify this is intentional (not accidental rename/refactor)

```bash
# See what will be destroyed
terraform plan -destroy

# Target a single resource for destruction (safer than full apply -destroy)
terraform destroy -target=google_cloud_run_service.app
```

**Signs your plan will destroy something accidentally:**
- Resource is shown as `(destroyed)` + `(new)` → it will be recreated (breaking)
- `forces replacement` next to a field change
- Database resources being destroyed → DATA LOSS

When in doubt: **ask the user before applying**.

---

## Project Structure

```
infrastructure/
├── main.tf           # Core resources
├── variables.tf      # Input variables
├── outputs.tf        # Output values (URLs, IDs)
├── backend.tf        # Remote state config
├── providers.tf      # Provider configuration
├── terraform.tfvars  # Values (gitignored!)
├── .terraform.lock.hcl  # Provider version lock (commit this)
└── modules/
    ├── cloud-run/    # Reusable Cloud Run module
    └── mongodb/      # MongoDB Atlas module
```
