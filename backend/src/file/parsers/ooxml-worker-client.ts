import * as path from 'node:path';
import { Worker } from 'node:worker_threads';
import type { ParserBudget } from './document-ast.js';
import type { NamespaceElement } from './ooxml-xml.js';

export interface OoxmlPartRequest {
  entry_name: string;
  root_local_name: string;
  root_namespace_uris: readonly string[];
  required: boolean;
  enforce_output_budget: boolean;
}

export interface ParsedOoxmlArchive {
  entry_names: string[];
  parts: Record<string, NamespaceElement | null>;
}

interface WorkerSuccess {
  ok: true;
  result: ParsedOoxmlArchive;
}

interface WorkerFailure {
  ok: false;
  error: { message: string; stack?: string };
}

let activeWorkers = 0;

export async function parseOoxmlPartsInWorker(
  sourceBytes: Buffer,
  requests: readonly OoxmlPartRequest[],
  options: {
    budget: ParserBudget;
    timeout_ms: number;
    signal?: AbortSignal;
  },
): Promise<ParsedOoxmlArchive> {
  throwIfAborted(options.signal);
  if (!Number.isFinite(options.timeout_ms) || options.timeout_ms <= 0) {
    throw new Error('Parser budget exceeded: time');
  }

  const worker = new Worker(path.join(__dirname, 'ooxml-parser.worker.js'), {
    workerData: {
      source_bytes: sourceBytes,
      requests,
      budget: options.budget,
    },
  });
  activeWorkers += 1;

  return new Promise<ParsedOoxmlArchive>((resolve, reject) => {
    let settled = false;

    const cleanupListeners = (): void => {
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', abortListener);
    };

    const settle = (
      outcome: { result: ParsedOoxmlArchive } | { error: Error },
      terminate: boolean,
    ): void => {
      if (settled) return;
      settled = true;
      cleanupListeners();
      const termination = terminate
        ? worker.terminate().then(
            () => undefined,
            () => undefined,
          )
        : Promise.resolve();
      void termination.then(() => {
        activeWorkers -= 1;
        if ('error' in outcome) reject(outcome.error);
        else resolve(outcome.result);
      });
    };

    const abortListener = (): void => {
      settle(
        {
          error:
            options.signal?.reason instanceof Error
              ? options.signal.reason
              : new Error('Document parsing aborted'),
        },
        true,
      );
    };

    worker.once('message', (message: WorkerSuccess | WorkerFailure) => {
      if (!message || typeof message !== 'object' || !('ok' in message)) {
        settle(
          { error: new Error('OOXML parser worker returned invalid data') },
          true,
        );
        return;
      }
      if (!message.ok) {
        const error = new Error(message.error.message);
        if (message.error.stack) error.stack = message.error.stack;
        settle({ error }, true);
        return;
      }
      try {
        assertUniqueOoxmlEntryNames(message.result.entry_names);
      } catch (error) {
        settle(
          {
            error:
              error instanceof Error
                ? error
                : new Error('OOXML parser worker returned an invalid manifest'),
          },
          true,
        );
        return;
      }
      settle({ result: message.result }, true);
    });
    worker.once('error', (error) => settle({ error }, true));
    worker.once('exit', (code) => {
      if (!settled) {
        settle(
          {
            error: new Error(
              `OOXML parser worker exited before producing a result (${code})`,
            ),
          },
          false,
        );
      }
    });

    const timer = setTimeout(
      () => settle({ error: new Error('Parser budget exceeded: time') }, true),
      Math.max(1, Math.ceil(options.timeout_ms)),
    );
    options.signal?.addEventListener('abort', abortListener, { once: true });
    if (options.signal?.aborted) abortListener();
  });
}

export function getActiveOoxmlWorkerCountForTests(): number {
  return activeWorkers;
}

export function assertUniqueOoxmlEntryNames(
  entryNames: unknown,
): asserts entryNames is string[] {
  if (!Array.isArray(entryNames)) {
    throw new Error('OOXML parser worker returned an invalid manifest');
  }
  const normalizedNames = new Set<string>();
  for (const entryName of entryNames) {
    if (typeof entryName !== 'string' || entryName.length === 0) {
      throw new Error('OOXML parser worker returned an invalid manifest');
    }
    const normalizedName = entryName.normalize('NFC');
    if (normalizedNames.has(normalizedName)) {
      throw new Error(`duplicate OOXML archive entry: ${normalizedName}`);
    }
    normalizedNames.add(normalizedName);
  }
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return;
  throw signal.reason instanceof Error
    ? signal.reason
    : new Error('Document parsing aborted');
}
