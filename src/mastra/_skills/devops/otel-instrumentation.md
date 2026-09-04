---
name: otel-instrumentation
category: devops
description: >-
  Set up OpenTelemetry instrumentation for applications including SDK
  initialization, auto-instrumentation, custom spans/metrics, and Collector
  configuration. Use when adding observability to Node.js, Python, Go, or
  Java applications, or configuring telemetry pipelines.
keywords: [opentelemetry, otel, tracing, metrics, observability, instrumentation, grafana, jaeger]
allowedTools: [fs_read_file, coding_write_file_tracked, shell_execute]
minComplexity: moderate
recommendedTier: pro
estimatedTokens: 1850
outputFormat: patch
tags: [devops, observability, tracing, metrics]
version: 1
success_rate: null
total_uses: 0
last_used: null
handoffCapable: true
---
# OpenTelemetry Instrumentation

> Sources: [dash0hq/agent-skills](https://github.com/dash0hq/agent-skills) (Apache-2.0),
> [wshobson/agents](https://github.com/wshobson/agents) (MIT).

## Trigger
Agent needs to add observability instrumentation to an application, configure
an OpenTelemetry Collector, or set up tracing/metrics pipelines.

## Procedure

### Step 1: Determine instrumentation scope

- **Auto-instrumentation** — automatic tracing for HTTP, DB, messaging (fastest)
- **Manual spans** — custom business logic tracing
- **Metrics** — counters, histograms, gauges for application KPIs
- **Collector setup** — receive, process, and export telemetry data

### Step 2: Node.js instrumentation

**Install dependencies:**
```bash
npm install @opentelemetry/sdk-node \
  @opentelemetry/auto-instrumentations-node \
  @opentelemetry/exporter-trace-otlp-http \
  @opentelemetry/exporter-metrics-otlp-http
```

**Auto-instrumentation setup (`tracing.ts`):**
```typescript
import { NodeSDK } from '@opentelemetry/sdk-node';
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-http';
import { PeriodicExportingMetricReader } from '@opentelemetry/sdk-metrics';
import { Resource } from '@opentelemetry/resources';
import { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } from '@opentelemetry/semantic-conventions';

const sdk = new NodeSDK({
  resource: new Resource({
    [ATTR_SERVICE_NAME]: 'my-service',
    [ATTR_SERVICE_VERSION]: '1.0.0',
  }),
  traceExporter: new OTLPTraceExporter({
    url: process.env.OTEL_EXPORTER_OTLP_ENDPOINT || 'http://localhost:4318/v1/traces',
  }),
  metricReader: new PeriodicExportingMetricReader({
    exporter: new OTLPMetricExporter({
      url: process.env.OTEL_EXPORTER_OTLP_ENDPOINT || 'http://localhost:4318/v1/metrics',
    }),
    exportIntervalMillis: 30000,
  }),
  instrumentations: [getNodeAutoInstrumentations({
    '@opentelemetry/instrumentation-fs': { enabled: false },  // noisy
  })],
});

sdk.start();

process.on('SIGTERM', () => {
  sdk.shutdown().then(() => process.exit(0));
});
```

**Load before app:** Add to `package.json`:
```json
{ "scripts": { "start": "node --require ./tracing.js app.js" } }
```

**Custom spans:**
```typescript
import { trace } from '@opentelemetry/api';

const tracer = trace.getTracer('my-service');

async function processOrder(orderId: string) {
  return tracer.startActiveSpan('processOrder', async (span) => {
    try {
      span.setAttribute('order.id', orderId);
      const result = await doWork(orderId);
      span.setAttribute('order.status', result.status);
      return result;
    } catch (error) {
      span.recordException(error as Error);
      span.setStatus({ code: 2, message: (error as Error).message });
      throw error;
    } finally {
      span.end();
    }
  });
}
```

### Step 3: Python instrumentation

**Install:**
```bash
pip install opentelemetry-api opentelemetry-sdk \
  opentelemetry-exporter-otlp \
  opentelemetry-instrumentation-flask \
  opentelemetry-instrumentation-requests
```

**Auto-instrumentation (one-liner):**
```bash
opentelemetry-instrument \
  --service_name my-service \
  --exporter_otlp_endpoint http://localhost:4318 \
  python app.py
```

**Programmatic setup:**
```python
from opentelemetry import trace
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import BatchSpanProcessor
from opentelemetry.exporter.otlp.proto.http.trace_exporter import OTLPSpanExporter
from opentelemetry.sdk.resources import Resource

resource = Resource.create({"service.name": "my-service"})
provider = TracerProvider(resource=resource)
provider.add_span_processor(
    BatchSpanProcessor(OTLPSpanExporter(endpoint="http://localhost:4318/v1/traces"))
)
trace.set_tracer_provider(provider)

tracer = trace.get_tracer("my-service")

with tracer.start_as_current_span("process_order") as span:
    span.set_attribute("order.id", order_id)
    result = do_work(order_id)
```

### Step 4: Collector configuration

**`otel-collector-config.yaml`:**
```yaml
receivers:
  otlp:
    protocols:
      grpc:
        endpoint: 0.0.0.0:4317
      http:
        endpoint: 0.0.0.0:4318

processors:
  batch:
    timeout: 5s
    send_batch_size: 1024
  memory_limiter:
    check_interval: 1s
    limit_mib: 512
    spike_limit_mib: 128

exporters:
  # Console (debug)
  debug:
    verbosity: detailed

  # Jaeger
  otlp/jaeger:
    endpoint: jaeger:4317
    tls:
      insecure: true

  # Prometheus
  prometheus:
    endpoint: 0.0.0.0:8889

service:
  pipelines:
    traces:
      receivers: [otlp]
      processors: [memory_limiter, batch]
      exporters: [otlp/jaeger, debug]
    metrics:
      receivers: [otlp]
      processors: [memory_limiter, batch]
      exporters: [prometheus]
```

**Docker Compose for full stack:**
```yaml
services:
  otel-collector:
    image: otel/opentelemetry-collector-contrib:latest
    ports:
      - "4317:4317"   # gRPC
      - "4318:4318"   # HTTP
      - "8889:8889"   # Prometheus metrics
    volumes:
      - ./otel-collector-config.yaml:/etc/otelcol-contrib/config.yaml

  jaeger:
    image: jaegertracing/all-in-one:latest
    ports:
      - "16686:16686"  # Jaeger UI
      - "4317"         # OTLP gRPC (internal)

  grafana:
    image: grafana/grafana:latest
    ports:
      - "3001:3000"
    environment:
      - GF_SECURITY_ADMIN_PASSWORD=admin
```

### Step 5: Custom metrics

```typescript
import { metrics } from '@opentelemetry/api';

const meter = metrics.getMeter('my-service');

// Counter (monotonically increasing)
const requestCounter = meter.createCounter('http.requests.total', {
  description: 'Total HTTP requests',
});
requestCounter.add(1, { method: 'GET', route: '/api/users' });

// Histogram (distribution of values)
const latencyHistogram = meter.createHistogram('http.request.duration', {
  description: 'Request duration in milliseconds',
  unit: 'ms',
});
latencyHistogram.record(42, { method: 'POST', route: '/api/orders' });

// UpDownCounter (can decrease)
const activeConnections = meter.createUpDownCounter('connections.active', {
  description: 'Number of active connections',
});
activeConnections.add(1);   // connection opened
activeConnections.add(-1);  // connection closed
```

### Step 6: Verification

```bash
# Check if OTLP endpoint is reachable
curl -s http://localhost:4318/v1/traces -X POST \
  -H "Content-Type: application/json" \
  -d '{}' -w "\nHTTP %{http_code}\n"

# Send test span
curl -X POST http://localhost:4318/v1/traces \
  -H "Content-Type: application/json" \
  -d '{"resourceSpans":[{"resource":{"attributes":[{"key":"service.name","value":{"stringValue":"test"}}]},"scopeSpans":[{"spans":[{"traceId":"00000000000000000000000000000001","spanId":"0000000000000001","name":"test-span","startTimeUnixNano":"1000000000","endTimeUnixNano":"2000000000"}]}]}]}'

# Check Jaeger UI
echo "Jaeger UI: http://localhost:16686"

# Check Collector metrics
curl -s http://localhost:8888/metrics | grep otelcol_receiver
```

## Success criteria
- Application produces traces visible in Jaeger/Grafana
- Auto-instrumentation covers HTTP, database, and messaging
- Custom spans include business-relevant attributes
- Collector processes and exports data without errors
- Metrics endpoint is accessible for Prometheus scraping
