---
name: docker-helper
category: devops
description: >-
  Analyze, debug, and manage Docker containers and images. Use when agent
  needs to work with Dockerfiles, docker-compose, inspect running containers,
  debug networking issues, or optimize image builds.
keywords: [docker, container, dockerfile, compose, image, devops, debugging]
allowedTools: [shell_execute, fs_read_file, fs_write_file]
minComplexity: simple
recommendedTier: fast
estimatedTokens: 1100
outputFormat: text
tags: [devops, docker, containers]
version: 1
success_rate: null
total_uses: 0
last_used: null
handoffCapable: true
---
# Docker Helper

## Trigger
Agent encounters tasks involving Docker containers, images, Compose files,
or needs to diagnose container runtime issues.

## Procedure

### Step 1: Assess the situation
Determine what kind of Docker task is needed:
- **Build issue** → Go to Dockerfile Analysis
- **Runtime issue** → Go to Container Diagnostics
- **Compose issue** → Go to Compose Debugging
- **Network issue** → Go to Network Troubleshooting
- **Cleanup needed** → Go to Image Management

### Step 2: Dockerfile Analysis

**Common anti-patterns to detect:**
- Missing `.dockerignore` (large build context)
- `RUN apt-get install` without `apt-get update` on same layer
- `COPY . .` before dependency installation (cache busting)
- Missing multi-stage builds for compiled languages
- Running as root without explicit `USER` directive
- Using `latest` tag instead of pinned versions

**Optimization checklist:**
1. Order layers from least to most frequently changing
2. Combine related `RUN` commands with `&&` to reduce layers
3. Use multi-stage builds to separate build and runtime
4. Pin base image versions: `FROM node:20.11-alpine` not `FROM node:latest`
5. Add health checks: `HEALTHCHECK CMD curl -f http://localhost/ || exit 1`

### Step 3: Compose Debugging

**Common issues and diagnostics:**
```bash
# Check service status and health
docker compose ps
docker compose ps --format json | jq '.[] | {Name, State, Health}'

# View logs for a specific service
docker compose logs --tail 100 <service>

# Check port conflicts
docker compose port <service> <port>
ss -tlnp | grep <port>

# Validate compose file
docker compose config --quiet && echo "Valid" || echo "Invalid"

# Check volume mounts
docker compose config --volumes
```

**Port conflicts:** Check if host ports are already bound before `up`.
**Volume mounts:** Ensure host paths exist and have correct permissions.
**depends_on:** Use `condition: service_healthy` with health checks, not just `depends_on`.
**Environment:** Validate `.env` file loading with `docker compose config`.

### Step 4: Container Diagnostics

```bash
# Inspect a running container
docker inspect <container> | jq '.[0] | {State, NetworkSettings, Mounts}'

# View real-time logs
docker logs --tail 200 --timestamps <container>

# Check resource usage
docker stats --no-stream --format "table {{.Name}}\t{{.CPUPerc}}\t{{.MemUsage}}\t{{.NetIO}}"

# Execute command inside container
docker exec -it <container> sh -c 'command'

# Check container filesystem diff
docker diff <container>

# Inspect container health
docker inspect --format='{{json .State.Health}}' <container> | jq .
```

**Common runtime issues:**
- `OOMKilled` → Increase memory limit or optimize app memory usage
- `Exited(1)` → Check logs for application startup errors
- `Restarting` → Check restart policy and fix underlying crash

### Step 5: Network Troubleshooting

```bash
# List networks
docker network ls

# Inspect network details
docker network inspect <network> | jq '.[0] | {Containers, IPAM}'

# Test connectivity between containers
docker exec <container1> ping -c 3 <container2>

# Check DNS resolution inside container
docker exec <container> nslookup <service_name>

# Debug port mapping
docker port <container>
iptables -t nat -L -n | grep <port>  # Host-level NAT rules
```

**Key networking facts:**
- Containers on same Compose network resolve each other by service name
- `host` network mode shares the host network stack (no isolation)
- `bridge` (default) requires explicit port mapping with `-p`
- Inter-container communication uses service names, not `localhost`

### Step 6: Image Management

```bash
# List images with sizes
docker images --format "table {{.Repository}}\t{{.Tag}}\t{{.Size}}\t{{.CreatedSince}}"

# Find dangling images
docker images -f "dangling=true"

# Cleanup unused resources
docker system prune -f              # Remove stopped containers, dangling images, unused networks
docker image prune -a -f            # Remove ALL unused images (not just dangling)
docker volume prune -f              # Remove unused volumes (CAUTION: data loss)

# Analyze image layers
docker history --no-trunc <image>

# Check disk usage
docker system df -v
```

## Success criteria
- Container/service is running and healthy
- No type errors or build failures
- Dockerfile follows best practices (multi-stage, pinned versions, non-root)
- Network connectivity verified between dependent services
- Resource usage is within expected bounds
