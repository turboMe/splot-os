---
name: cicd-pipeline
category: devops
description: >-
  Generate and optimize CI/CD pipeline configurations for GitHub Actions,
  GitLab CI, and similar platforms. Includes multi-stage workflows, caching,
  matrix testing, and deployment strategies. Use when setting up, debugging,
  or optimizing continuous integration and deployment pipelines.
keywords: [cicd, github-actions, gitlab-ci, pipeline, deployment, workflow, automation]
allowedTools: [fs_read_file, coding_write_file_tracked, shell_execute]
minComplexity: moderate
recommendedTier: pro
estimatedTokens: 1400
outputFormat: patch
tags: [devops, cicd, automation, deployment]
version: 1
success_rate: null
total_uses: 0
last_used: null
handoffCapable: true
---
# CI/CD Pipeline

## Trigger
Agent needs to create, debug, or optimize CI/CD pipeline configurations
for GitHub Actions, GitLab CI, or similar platforms.

## Procedure

### Step 1: Assess requirements

Determine:
- **Platform:** GitHub Actions, GitLab CI, or other
- **Language/Runtime:** Node.js, Python, Go, Rust, etc.
- **Stages needed:** lint, test, build, deploy
- **Deployment targets:** Vercel, Cloud Run, Docker registry, SSH
- **Branch strategy:** main only, staging+production, feature branches

### Step 2: GitHub Actions workflow template

```yaml
name: CI/CD Pipeline
on:
  push:
    branches: [main, staging]
  pull_request:
    branches: [main]

# Cancel in-progress runs for same ref
concurrency:
  group: ${{ github.workflow }}-${{ github.ref }}
  cancel-in-progress: ${{ github.ref != 'refs/heads/main' }}

permissions:
  contents: read

jobs:
  lint:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: 'npm'
      - run: npm ci
      - run: npm run lint

  test:
    runs-on: ubuntu-latest
    needs: lint
    strategy:
      matrix:
        node-version: [18, 20, 22]
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: ${{ matrix.node-version }}
          cache: 'npm'
      - run: npm ci
      - run: npm test -- --coverage
      - uses: actions/upload-artifact@v4
        if: matrix.node-version == 20
        with:
          name: coverage
          path: coverage/

  build:
    runs-on: ubuntu-latest
    needs: test
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: 'npm'
      - run: npm ci
      - run: npm run build
      - uses: actions/upload-artifact@v4
        with:
          name: build-output
          path: dist/

  deploy-staging:
    if: github.ref == 'refs/heads/staging'
    runs-on: ubuntu-latest
    needs: build
    environment: staging
    steps:
      - uses: actions/download-artifact@v4
        with:
          name: build-output
          path: dist/
      - run: echo "Deploy to staging..."

  deploy-production:
    if: github.ref == 'refs/heads/main'
    runs-on: ubuntu-latest
    needs: build
    environment: production
    steps:
      - uses: actions/download-artifact@v4
        with:
          name: build-output
          path: dist/
      - run: echo "Deploy to production..."
```

### Step 3: Cache optimization

**Node.js:**
```yaml
- uses: actions/setup-node@v4
  with:
    node-version: 20
    cache: 'npm'  # Built-in npm/yarn/pnpm cache
```

**Python:**
```yaml
- uses: actions/setup-python@v5
  with:
    python-version: '3.12'
    cache: 'pip'
```

**Docker layer caching:**
```yaml
- uses: docker/build-push-action@v5
  with:
    context: .
    cache-from: type=gha
    cache-to: type=gha,mode=max
```

**Custom cache:**
```yaml
- uses: actions/cache@v4
  with:
    path: ~/.cache/custom
    key: custom-${{ runner.os }}-${{ hashFiles('**/lockfile') }}
    restore-keys: custom-${{ runner.os }}-
```

### Step 4: Security best practices

1. **Pin action versions** to full SHA, not tags:
   ```yaml
   uses: actions/checkout@b4ffde65f46336ab88eb53be808477a3936bae11 # v4.1.1
   ```
2. **Minimal permissions:**
   ```yaml
   permissions:
     contents: read
     pull-requests: write  # only if needed
   ```
3. **Secrets management:**
   - Never echo secrets: `echo "${{ secrets.TOKEN }}"` leaks to logs
   - Use environment-scoped secrets for deployment
   - Rotate secrets regularly
4. **Dependency review:**
   ```yaml
   - uses: actions/dependency-review-action@v4
     if: github.event_name == 'pull_request'
   ```

### Step 5: Debugging pipelines

```bash
# Re-run with debug logging (GitHub Actions)
# Set secret: ACTIONS_STEP_DEBUG=true

# Check workflow syntax locally
actionlint .github/workflows/*.yml

# Test workflow locally with act
act push -j test

# View recent workflow runs
gh run list --limit 10
gh run view <run-id> --log-failed
```

**Common failure patterns:**
| Error | Cause | Fix |
|-------|-------|-----|
| `npm ci` fails | lockfile mismatch | Commit updated `package-lock.json` |
| Cache miss every run | Key doesn't match | Check `hashFiles()` glob pattern |
| Permission denied | Missing `permissions:` | Add required permission explicitly |
| Timeout | Long-running step | Add `timeout-minutes:` to step |
| Matrix failures | Env-specific issue | Check matrix value in error output |

### Step 6: GitLab CI template

```yaml
stages:
  - lint
  - test
  - build
  - deploy

variables:
  NODE_VERSION: "20"

.node-cache:
  cache:
    key: ${CI_COMMIT_REF_SLUG}
    paths:
      - node_modules/

lint:
  stage: lint
  extends: .node-cache
  script:
    - npm ci
    - npm run lint

test:
  stage: test
  extends: .node-cache
  script:
    - npm ci
    - npm test -- --coverage
  coverage: '/All files[^|]*\|[^|]*\s+([\d\.]+)/'
  artifacts:
    reports:
      coverage_report:
        coverage_format: cobertura
        path: coverage/cobertura-coverage.xml

deploy:
  stage: deploy
  script:
    - echo "Deploying..."
  only:
    - main
  environment:
    name: production
```

## Success criteria
- Pipeline runs successfully on target platform
- All stages execute in correct order with proper dependencies
- Cache is utilized (no full reinstall on every run)
- Secrets are not exposed in logs
- Action versions are pinned
- Concurrency control prevents duplicate runs
