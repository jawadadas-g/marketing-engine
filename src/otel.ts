import { SpanStatusCode, trace, type Span } from '@opentelemetry/api';
import { env } from './env.js';

const TRACER_NAME = 'marketing-engine';

type Sdk = { start: () => void; shutdown: () => Promise<void> };
let sdk: Sdk | undefined;

/**
 * Tracing, only when someone is listening. With no OTLP endpoint configured
 * the OpenTelemetry API's default no-op tracer is used, so every `span()` call
 * in the codebase costs nothing and needs no guard around it.
 *
 * Manual spans only: auto-instrumentation would pull in a dozen packages to
 * describe things we already know the shape of.
 */
export async function startTracing(): Promise<void> {
  const endpoint = env().OTEL_EXPORTER_OTLP_ENDPOINT;
  if (!endpoint || sdk) return;

  const [{ NodeSDK }, { OTLPTraceExporter }, resources] = await Promise.all([
    import('@opentelemetry/sdk-node'),
    import('@opentelemetry/exporter-trace-otlp-http'),
    import('@opentelemetry/resources'),
  ]);

  sdk = new NodeSDK({
    traceExporter: new OTLPTraceExporter({ url: `${endpoint.replace(/\/+$/, '')}/v1/traces` }),
    resource: resources.resourceFromAttributes({
      'service.name': env().OTEL_SERVICE_NAME ?? TRACER_NAME,
    }),
    instrumentations: [],
  }) as unknown as Sdk;

  sdk.start();
  console.log(JSON.stringify({ msg: 'tracing enabled', endpoint }));
}

export async function stopTracing(): Promise<void> {
  if (!sdk) return;
  const active = sdk;
  sdk = undefined;
  await active.shutdown().catch(() => {});
}

/**
 * Run `fn` inside a span. With no exporter configured this is the no-op
 * tracer and adds nothing but a function call.
 */
export async function span<T>(
  name: string,
  attributes: Record<string, string | number | boolean>,
  fn: (span: Span) => Promise<T>,
): Promise<T> {
  return trace.getTracer(TRACER_NAME).startActiveSpan(name, { attributes }, async (current) => {
    try {
      const result = await fn(current);
      current.setStatus({ code: SpanStatusCode.OK });
      return result;
    } catch (err) {
      current.setStatus({ code: SpanStatusCode.ERROR, message: (err as Error).message });
      current.recordException(err as Error);
      throw err;
    } finally {
      current.end();
    }
  });
}

/** The current trace id, for the request log line. Empty when not tracing. */
export function currentTraceId(): string {
  return trace.getActiveSpan()?.spanContext().traceId ?? '';
}
