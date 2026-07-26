import 'reflect-metadata';
import { CitationModule } from './citation.module.js';
import {
  ATOMIC_GROUNDING_METRIC_SINK,
  AtomicGroundingMetricsRecorder,
  AtomicGroundingPrometheusExporter,
} from './atomic-grounding/atomic-grounding.metrics.js';

describe('CitationModule atomic-grounding metrics', () => {
  it('binds the production Prometheus exporter to the recorder sink token', () => {
    const providers = Reflect.getMetadata(
      'providers',
      CitationModule,
    ) as Array<{
      provide?: unknown;
      useExisting?: unknown;
    }>;

    expect(providers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          provide: ATOMIC_GROUNDING_METRIC_SINK,
          useExisting: AtomicGroundingPrometheusExporter,
        }),
      ]),
    );
    expect(providers).toContain(AtomicGroundingPrometheusExporter);
    expect(providers).toContain(AtomicGroundingMetricsRecorder);
  });

  it('keeps the exporter available to the dedicated worker metrics listener', () => {
    const exporter = new AtomicGroundingPrometheusExporter();

    expect(exporter.exposition()).toContain(
      '# TYPE grounding_proposal_total counter',
    );
  });
});
