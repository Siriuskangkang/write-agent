import { Processor, Process } from '@nestjs/bull';
import type { Job } from 'bull';
import { Logger } from '@nestjs/common';
import { StyleTemplateService } from '../style-template.service.js';
import { StyleAnalyzer } from '../analyzers/style-analyzer.js';
import type { StyleFeatures } from '../entities/style-template.entity.js';

@Processor('style-analyze')
export class AnalyzeWorker {
  private readonly logger = new Logger(AnalyzeWorker.name);

  constructor(
    private readonly styleTemplateService: StyleTemplateService,
    private readonly styleAnalyzer: StyleAnalyzer,
  ) {}

  @Process('analyze')
  async handleAnalyze(job: Job<{ templateId: string }>): Promise<void> {
    const { templateId } = job.data;

    this.logger.log(`Starting analysis for template ${templateId}`);

    try {
      const template = await this.styleTemplateService.findOne(templateId);

      const features = await new Promise<StyleFeatures>((resolve, reject) => {
        let result: StyleFeatures | null = null;

        this.styleAnalyzer
          .analyzeStream(templateId, template.filePath)
          .subscribe({
            next: (event) => {
              if (event.type === 'done') {
                const features = event.data.features;
                if (typeof features === 'object' && features !== null) {
                  result = features as StyleFeatures;
                }
              }
            },
            complete: () => {
              if (result) {
                resolve(result);
              } else {
                reject(new Error('No features extracted'));
              }
            },
            error: (error: unknown) =>
              reject(error instanceof Error ? error : new Error(String(error))),
          });
      });

      await this.styleTemplateService.updateAnalysisResult(
        templateId,
        features,
        'completed',
      );

      this.logger.log(`Analysis completed for template ${templateId}`);
    } catch (error) {
      const failure = error instanceof Error ? error : new Error(String(error));
      this.logger.error(
        `Analysis failed for template ${templateId}: ${failure.message}`,
        failure.stack,
      );

      await this.styleTemplateService.updateAnalysisResult(
        templateId,
        null,
        'failed',
        failure.message,
      );

      throw failure;
    }
  }
}
