---
name: k8s-helper
category: devops
description: >-
  Generate Kubernetes manifests, debug pod issues, and manage cluster resources
  using kubectl. Covers Deployments, Services, ConfigMaps, Helm basics, and
  common troubleshooting patterns. Use when working with Kubernetes clusters,
  creating manifests, or diagnosing pod/service issues.
keywords: [kubernetes, k8s, kubectl, helm, manifest, pod, deployment, container-orchestration]
allowedTools: [shell_execute, fs_read_file, coding_write_file_tracked]
minComplexity: moderate
recommendedTier: pro
estimatedTokens: 1250
outputFormat: text
tags: [devops, kubernetes, k8s, orchestration]
version: 1
success_rate: null
total_uses: 0
last_used: null
handoffCapable: true
---
# Kubernetes Helper

## Trigger
Agent needs to create Kubernetes manifests, debug pod issues, manage
cluster resources, or scaffold Helm charts.

## Procedure

### Step 1: Assess the task

- **Create resources** → Go to Manifest Generation
- **Debug pod issues** → Go to Pod Troubleshooting
- **Inspect cluster** → Go to Cluster Diagnostics
- **Helm chart** → Go to Helm Basics

### Step 2: Manifest generation

**Deployment:**
```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: app
  labels:
    app: app
spec:
  replicas: 3
  selector:
    matchLabels:
      app: app
  template:
    metadata:
      labels:
        app: app
    spec:
      containers:
        - name: app
          image: app:1.0.0   # Always pin versions
          ports:
            - containerPort: 8080
          resources:
            requests:
              cpu: 100m
              memory: 128Mi
            limits:
              cpu: 500m
              memory: 256Mi
          livenessProbe:
            httpGet:
              path: /health
              port: 8080
            initialDelaySeconds: 15
            periodSeconds: 10
          readinessProbe:
            httpGet:
              path: /ready
              port: 8080
            initialDelaySeconds: 5
            periodSeconds: 5
          env:
            - name: NODE_ENV
              value: "production"
            - name: DB_URL
              valueFrom:
                secretKeyRef:
                  name: app-secrets
                  key: database-url
```

**Service:**
```yaml
apiVersion: v1
kind: Service
metadata:
  name: app
spec:
  selector:
    app: app
  ports:
    - port: 80
      targetPort: 8080
  type: ClusterIP  # ClusterIP | NodePort | LoadBalancer
```

**ConfigMap:**
```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: app-config
data:
  APP_ENV: "production"
  LOG_LEVEL: "info"
  config.yaml: |
    server:
      port: 8080
      timeout: 30s
```

**Secret:**
```bash
# Create secret from literal
kubectl create secret generic app-secrets \
  --from-literal=database-url='postgres://...' \
  --dry-run=client -o yaml > secret.yaml
```

### Step 3: Pod troubleshooting

**Common error states:**

| Status | Cause | Diagnostic |
|--------|-------|-----------|
| `CrashLoopBackOff` | App crashes on start | `kubectl logs <pod> --previous` |
| `ImagePullBackOff` | Wrong image or auth | `kubectl describe pod <pod>` → Events |
| `OOMKilled` | Memory limit exceeded | Increase `resources.limits.memory` |
| `Pending` | No node capacity | `kubectl describe pod <pod>` → Events |
| `ContainerCreating` | Volume mount issue | `kubectl describe pod <pod>` → Events |

**Diagnostic commands:**
```bash
# Pod status overview
kubectl get pods -o wide

# Detailed pod info (events, conditions)
kubectl describe pod <pod-name>

# Current and previous logs
kubectl logs <pod-name>
kubectl logs <pod-name> --previous

# Execute into container
kubectl exec -it <pod-name> -- sh

# Resource usage (requires metrics-server)
kubectl top pods
kubectl top nodes

# Get events sorted by time
kubectl get events --sort-by=.lastTimestamp
```

### Step 4: Cluster diagnostics

```bash
# Cluster info
kubectl cluster-info
kubectl get nodes -o wide

# All resources in namespace
kubectl get all -n <namespace>

# Resource quotas
kubectl describe resourcequota -n <namespace>

# Storage
kubectl get pv,pvc

# Networking
kubectl get svc,ingress
kubectl get endpoints <service-name>

# Check DNS resolution
kubectl run tmp --rm -i --restart=Never --image=busybox -- nslookup <service>
```

### Step 5: Helm basics

```bash
# Create chart scaffold
helm create my-chart

# Install/upgrade
helm install my-release ./my-chart --namespace prod
helm upgrade my-release ./my-chart --namespace prod

# Debug template rendering
helm template my-release ./my-chart --debug

# List releases
helm list -A

# Rollback
helm rollback my-release 1
```

**Chart structure:**
```
my-chart/
├── Chart.yaml          # Metadata
├── values.yaml         # Default values
├── templates/
│   ├── deployment.yaml
│   ├── service.yaml
│   ├── configmap.yaml
│   ├── _helpers.tpl    # Template helpers
│   └── NOTES.txt       # Post-install notes
```

### Step 6: Resource sizing guidelines

| Workload Type | CPU Request | CPU Limit | Memory Request | Memory Limit |
|--------------|-------------|-----------|----------------|--------------|
| API server | 100m-500m | 500m-1000m | 128Mi-256Mi | 512Mi |
| Worker | 250m-1000m | 1000m-2000m | 256Mi-512Mi | 1Gi |
| Database | 500m-2000m | 2000m-4000m | 512Mi-2Gi | 4Gi |
| Redis/cache | 100m-250m | 500m | 64Mi-256Mi | 512Mi |

**Rules:**
- Always set both requests and limits
- Request = guaranteed allocation; Limit = burst ceiling
- Start conservative, monitor with `kubectl top`, then adjust
- Memory limit too low → OOMKilled; too high → waste

## Success criteria
- Manifests are valid: `kubectl apply --dry-run=client -f manifest.yaml`
- Pods reach Running/Ready state
- Services resolve and route traffic correctly
- Resource limits set appropriately
- Health/readiness probes configured
