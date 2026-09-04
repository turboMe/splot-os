---
name: cloud-run-deploy
category: devops
description: >-
  GCP Cloud Run deployment skill. Covers container build, push to Artifact
  Registry, deploy with traffic splitting, rollback, and environment variable
  management. Trigger: "deploy to Cloud Run", "GCP deploy", "deploy container",
  "push to production", "Cloud Run rollback".
keywords: [cloud run, gcp, docker, deploy, container, artifact registry, traffic splitting, rollback]
allowedTools: [shell_execute, fs_read_file, fs_write_file]
minComplexity: moderate
recommendedTier: pro
estimatedTokens: 1850
outputFormat: markdown
tags: [devops, cloud, gcp, deploy, docker]
version: 1
success_rate: null
total_uses: 0
last_used: null
handoffCapable: true
---
# Cloud Run Deploy

> Full GCP Cloud Run deployment flow: build → push → deploy → verify → rollback if needed.
> All commands assume `gcloud` CLI is authenticated and project is set.

## Prerequisites Checklist

Before first deploy:
- [ ] `gcloud auth login` — authenticated
- [ ] `gcloud config set project PROJECT_ID`
- [ ] `gcloud services enable run.googleapis.com artifactregistry.googleapis.com`
- [ ] Artifact Registry repo created: `gcloud artifacts repositories create REPO --repository-format=docker --location=REGION`
- [ ] Service account has roles: `roles/run.admin`, `roles/artifactregistry.writer`, `roles/secretmanager.secretAccessor`

---

## Step 1: Build Docker Image

```bash
# Standard build
docker build -t SERVICE_NAME:latest .

# Multi-platform build (Cloud Run requires linux/amd64)
docker buildx build \
  --platform linux/amd64 \
  -t REGION-docker.pkg.dev/PROJECT_ID/REPO/SERVICE_NAME:latest \
  .
```

**Minimal Node.js Dockerfile for this project:**
```dockerfile
FROM node:22-alpine AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci --include=dev
COPY . .
RUN npm run build

FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=builder /app/dist ./dist
EXPOSE 4111
CMD ["node", "dist/index.js"]
```

---

## Step 2: Push to Artifact Registry

```bash
# Authenticate Docker to Artifact Registry
gcloud auth configure-docker REGION-docker.pkg.dev

# Tag for Artifact Registry
docker tag SERVICE_NAME:latest \
  REGION-docker.pkg.dev/PROJECT_ID/REPO/SERVICE_NAME:latest

# Push
docker push REGION-docker.pkg.dev/PROJECT_ID/REPO/SERVICE_NAME:latest
```

---

## Step 3: Deploy to Cloud Run

### First deploy (new service)
```bash
gcloud run deploy SERVICE_NAME \
  --image REGION-docker.pkg.dev/PROJECT_ID/REPO/SERVICE_NAME:latest \
  --region REGION \
  --platform managed \
  --allow-unauthenticated \           # or --no-allow-unauthenticated for private
  --port 4111 \
  --memory 1Gi \
  --cpu 1 \
  --min-instances 0 \
  --max-instances 10 \
  --set-env-vars "NODE_ENV=production,LOG_LEVEL=info" \
  --set-secrets "MONGODB_URI=mongodb-uri:latest,TAVILY_API_KEY=tavily-key:latest" \
  --service-account SERVICE_ACCOUNT_EMAIL
```

### Update existing service
```bash
gcloud run deploy SERVICE_NAME \
  --image REGION-docker.pkg.dev/PROJECT_ID/REPO/SERVICE_NAME:latest \
  --region REGION \
  --no-traffic   # deploy without routing traffic yet
```

---

## Step 4: Traffic Splitting (Canary Deploy)

```bash
# Get current revision name
gcloud run revisions list --service SERVICE_NAME --region REGION

# Canary: route 10% to new revision
gcloud run services update-traffic SERVICE_NAME \
  --region REGION \
  --to-revisions NEW_REVISION=10,STABLE_REVISION=90

# Gradually increase
gcloud run services update-traffic SERVICE_NAME \
  --region REGION \
  --to-revisions NEW_REVISION=50,STABLE_REVISION=50

# Full cutover
gcloud run services update-traffic SERVICE_NAME \
  --region REGION \
  --to-latest
```

**Monitor during canary:**
```bash
# Error rate (last 30 min)
gcloud logging read \
  'resource.type="cloud_run_revision" severity>=ERROR' \
  --limit 50 --format="table(timestamp,textPayload)"

# Request count per revision
gcloud run revisions describe REVISION_NAME --region REGION
```

---

## Step 5: Verify Deployment

```bash
# Get service URL
SERVICE_URL=$(gcloud run services describe SERVICE_NAME \
  --region REGION --format="value(status.url)")

# Health check
curl -s "${SERVICE_URL}/health" | jq .

# Check revision is serving
gcloud run revisions list --service SERVICE_NAME --region REGION
```

Expected health response:
```json
{ "status": "ok", "version": "x.y.z", "uptime": 12.3 }
```

---

## Step 6: Rollback

### Immediate rollback (route traffic back to previous revision)
```bash
# List revisions with traffic
gcloud run services describe SERVICE_NAME \
  --region REGION \
  --format="value(status.traffic)"

# Rollback: 100% to previous stable revision
gcloud run services update-traffic SERVICE_NAME \
  --region REGION \
  --to-revisions PREVIOUS_REVISION=100
```

### Full rollback procedure
```bash
# 1. Immediately cut traffic to stable revision
gcloud run services update-traffic SERVICE_NAME \
  --region REGION --to-revisions STABLE_REVISION=100

# 2. Verify health
curl -s "${SERVICE_URL}/health"

# 3. Investigate failed revision logs
gcloud logging read \
  'resource.type="cloud_run_revision" resource.labels.revision_name="FAILED_REVISION"' \
  --limit 100

# 4. Delete failed revision (optional, after investigation)
gcloud run revisions delete FAILED_REVISION --region REGION
```

---

## Environment Variables & Secrets

### Via Secret Manager (recommended for credentials)
```bash
# Create secret
echo -n "mongodb://..." | gcloud secrets create mongodb-uri --data-file=-

# Grant service account access
gcloud secrets add-iam-policy-binding mongodb-uri \
  --member="serviceAccount:SA_EMAIL" \
  --role="roles/secretmanager.secretAccessor"

# Reference in deploy command
--set-secrets "MONGODB_URI=mongodb-uri:latest"
```

### Via environment variables (non-sensitive config)
```bash
--set-env-vars "NODE_ENV=production,LOG_LEVEL=info,PORT=4111"
```

---

## CI/CD Integration (GitHub Actions)

```yaml
# .github/workflows/deploy.yml
name: Deploy to Cloud Run
on:
  push:
    branches: [main]

jobs:
  deploy:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      id-token: write  # for Workload Identity Federation

    steps:
      - uses: actions/checkout@v4

      - uses: google-github-actions/auth@v2
        with:
          workload_identity_provider: ${{ secrets.WIF_PROVIDER }}
          service_account: ${{ secrets.SERVICE_ACCOUNT }}

      - uses: google-github-actions/setup-gcloud@v2

      - name: Build and push
        run: |
          docker buildx build --platform linux/amd64 \
            -t ${{ env.IMAGE_URL }}:${{ github.sha }} \
            --push .

      - name: Deploy
        run: |
          gcloud run deploy ${{ env.SERVICE }} \
            --image ${{ env.IMAGE_URL }}:${{ github.sha }} \
            --region ${{ env.REGION }} \
            --no-traffic

      - name: Canary (10%)
        run: |
          gcloud run services update-traffic ${{ env.SERVICE }} \
            --region ${{ env.REGION }} \
            --to-latest --to-revisions STABLE=90
```

---

## Cost & Performance Tuning

| Setting | Dev/Staging | Production |
|---------|------------|-----------|
| `--min-instances` | 0 (cold start OK) | 1 (warm) |
| `--max-instances` | 3 | 10-50 |
| `--memory` | 512Mi | 1-2Gi |
| `--cpu` | 0.5 | 1-2 |
| `--concurrency` | 80 (default) | 80-200 |
| `--timeout` | 60s | 300s |

**Cold start optimization:**
- Keep `--min-instances 1` for production
- Use `--cpu-boost` flag for faster cold starts
- Avoid heavy module initialization at import time

---

## Common Issues

| Problem | Diagnosis | Fix |
|---------|-----------|-----|
| Container fails to start | Check logs: `gcloud logging read` | Missing env var? Port mismatch? |
| 503 errors | Revision unhealthy | Check `/health` endpoint; min-instances = 0? |
| Memory OOM | `OOM` in logs | Increase `--memory` |
| Slow cold starts | First request timeout | Set `--min-instances 1` |
| Secret not found | `Permission denied` | Grant `secretAccessor` role to SA |
