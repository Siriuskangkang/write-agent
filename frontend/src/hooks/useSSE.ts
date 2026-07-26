"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { Citation, SSEEvent } from "@/types";

interface UseSSEOptions {
  onMeta?: (resultId: string, taskType: string) => void;
  onToken?: (content: string, paragraphKey: string) => void;
  onCitation?: (paragraphKey: string, citations: Citation[]) => void;
  onDone?: (
    resultId: string,
    citations: Citation[],
    finalContent: string,
    outlineId?: string,
    directoryId?: string,
    serverSaved?: boolean,
    workflowJobId?: string,
  ) => void;
  onError?: (message: string, errorCode: string) => void;
  onNetworkReconnectFailed?: () => void;
}

interface UseSSEReturn {
  content: string;
  isStreaming: boolean;
  resultId: string | null;
  citations: Citation[];
  start: (url: string, body: Record<string, unknown>) => void;
  workflowJobId: string | null;
  stop: () => Promise<boolean>;
}

interface StreamRun {
  generation: number;
  url: string;
  body: Record<string, unknown>;
  requestId: string;
  controller: AbortController | null;
  workflowJobId: string | null;
  lastEventId: string | null;
  reconnectAttempts: number;
  heartbeatTimer: ReturnType<typeof setTimeout> | null;
  reconnectTimer: ReturnType<typeof setTimeout> | null;
  handshakeStopTimer: ReturnType<typeof setTimeout> | null;
  content: string;
  stopped: boolean;
  done: boolean;
  superseded: boolean;
  disposed: boolean;
  pendingStop: boolean;
  cancellation: Promise<boolean> | null;
  stopResult: Promise<boolean> | null;
  resolveStopResult: ((confirmed: boolean) => void) | null;
}

const HEARTBEAT_TIMEOUT_MS = 60_000;
const STOP_HANDSHAKE_TIMEOUT_MS = 5_000;
const MAX_RECONNECT_ATTEMPTS = 3;
const RECONNECT_DELAY_MS = 2000;

export function useSSE(options: UseSSEOptions = {}): UseSSEReturn {
  const [content, setContent] = useState("");
  const [isStreaming, setIsStreaming] = useState(false);
  const [resultId, setResultId] = useState<string | null>(null);
  const [citations, setCitations] = useState<Citation[]>([]);
  const [workflowJobId, setWorkflowJobId] = useState<string | null>(null);
  const optionsRef = useRef(options);
  const activeRunRef = useRef<StreamRun | null>(null);
  const nextGenerationRef = useRef(0);

  useEffect(() => {
    optionsRef.current = options;
  }, [options]);

  const ownsActiveRun = useCallback(
    (run: StreamRun) =>
      activeRunRef.current === run &&
      activeRunRef.current.generation === run.generation &&
      !run.disposed,
    [],
  );

  const clearRunTimers = useCallback((run: StreamRun) => {
    if (run.heartbeatTimer) {
      clearTimeout(run.heartbeatTimer);
      run.heartbeatTimer = null;
    }
    if (run.reconnectTimer) {
      clearTimeout(run.reconnectTimer);
      run.reconnectTimer = null;
    }
    if (run.handshakeStopTimer) {
      clearTimeout(run.handshakeStopTimer);
      run.handshakeStopTimer = null;
    }
  }, []);

  const abortRunTransport = useCallback((run: StreamRun) => {
    run.controller?.abort();
    run.controller = null;
  }, []);

  const getStopResult = useCallback((run: StreamRun): Promise<boolean> => {
    if (!run.stopResult) {
      run.stopResult = new Promise<boolean>((resolve) => {
        run.resolveStopResult = resolve;
      });
    }
    return run.stopResult;
  }, []);

  const resolveStopResult = useCallback(
    (run: StreamRun, confirmed: boolean) => {
      const resolve = run.resolveStopResult;
      run.resolveStopResult = null;
      resolve?.(confirmed);
    },
    [],
  );

  const sendDurableCancellation = useCallback(
    (run: StreamRun, jobId: string): Promise<boolean> => {
      if (run.cancellation) return run.cancellation;
      const projectId = extractProjectId(run.url);
      if (!projectId) return Promise.resolve(false);
      const apiBaseUrl = process.env.NEXT_PUBLIC_API_URL?.replace(/\/$/, "");
      const cancelPath = `/api/projects/${projectId}/workflows/${jobId}/cancel`;
      run.cancellation = fetch(
        apiBaseUrl ? `${apiBaseUrl}${cancelPath}` : cancelPath,
        {
          method: "POST",
          credentials: "include",
          headers: { Accept: "application/json" },
        },
      )
        .then((response) => response.ok)
        .catch(() => false);
      return run.cancellation;
    },
    [],
  );

  const finishDurableStop = useCallback(
    async (run: StreamRun, jobId: string): Promise<boolean> => {
      const confirmed = await sendDurableCancellation(run, jobId);
      if (confirmed) {
        if (run.handshakeStopTimer) {
          clearTimeout(run.handshakeStopTimer);
          run.handshakeStopTimer = null;
        }
        abortRunTransport(run);
      }
      resolveStopResult(run, confirmed);
      return confirmed;
    },
    [abortRunTransport, resolveStopResult, sendDurableCancellation],
  );

  const registerWorkflowJob = useCallback(
    (run: StreamRun, candidate: string | null | undefined): void => {
      const jobId = candidate?.trim();
      if (!jobId) return;
      if (!run.workflowJobId) {
        run.workflowJobId = jobId;
      }
      if (run.workflowJobId !== jobId) return;
      if (run.pendingStop || run.superseded) {
        void finishDurableStop(run, jobId);
      }
      if (!ownsActiveRun(run) || run.stopped || run.superseded) return;
      setWorkflowJobId(jobId);
    },
    [finishDurableStop, ownsActiveRun],
  );

  const requestRunStop = useCallback(
    (run: StreamRun, durable: boolean): Promise<boolean> => {
      run.stopped = true;
      clearRunTimers(run);
      if (!durable || run.done) {
        abortRunTransport(run);
        return Promise.resolve(false);
      }
      run.pendingStop = true;
      const result = getStopResult(run);
      run.handshakeStopTimer = setTimeout(() => {
        run.handshakeStopTimer = null;
        abortRunTransport(run);
        resolveStopResult(run, false);
      }, STOP_HANDSHAKE_TIMEOUT_MS);
      if (run.workflowJobId) {
        void finishDurableStop(run, run.workflowJobId);
      }
      return result;
    },
    [
      abortRunTransport,
      clearRunTimers,
      finishDurableStop,
      getStopResult,
      resolveStopResult,
    ],
  );

  const stop = useCallback(async (): Promise<boolean> => {
    const run = activeRunRef.current;
    if (!run) return false;
    const cancellation = requestRunStop(run, true);
    if (ownsActiveRun(run)) setIsStreaming(false);
    return cancellation;
  }, [ownsActiveRun, requestRunStop]);

  const startStream = useCallback(
    (run: StreamRun, isReconnect: boolean) => {
      if (!ownsActiveRun(run) || run.stopped || run.done) return;
      if (isReconnect && run.done) {
        setIsStreaming(false);
        return;
      }

      const controller = new AbortController();
      run.controller = controller;
      setIsStreaming(true);

      const apiBaseUrl = process.env.NEXT_PUBLIC_API_URL?.replace(/\/$/, "");
      const fullUrl = run.url.startsWith("http")
        ? run.url
        : apiBaseUrl
          ? `${apiBaseUrl}/api${run.url}`
          : `/api${run.url}`;

      const resetHeartbeatTimer = () => {
        if (!ownsActiveRun(run) || run.stopped || run.done) return;
        if (run.heartbeatTimer) clearTimeout(run.heartbeatTimer);
        run.heartbeatTimer = setTimeout(() => {
          if (!ownsActiveRun(run) || run.stopped || run.done) return;
          console.warn("SSE heartbeat 超时，中断连接");
          controller.abort();
        }, HEARTBEAT_TIMEOUT_MS);
      };

      const attemptReconnect = () => {
        if (!ownsActiveRun(run) || run.stopped || run.done) return;
        if (run.reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
          optionsRef.current.onNetworkReconnectFailed?.();
          optionsRef.current.onError?.(
            "网络连接中断，重连失败",
            "RECONNECT_FAILED",
          );
          setIsStreaming(false);
          return;
        }
        run.reconnectAttempts += 1;
        const delay = RECONNECT_DELAY_MS * run.reconnectAttempts;
        console.warn(
          `SSE 网络断开，${delay}ms 后第 ${run.reconnectAttempts} 次重连`,
        );
        run.reconnectTimer = setTimeout(() => {
          run.reconnectTimer = null;
          if (!ownsActiveRun(run) || run.stopped || run.done) return;
          startStream(run, true);
        }, delay);
      };

      resetHeartbeatTimer();
      const headers: Record<string, string> = {
        Accept: "text/event-stream",
        "Content-Type": "application/json",
        "X-Request-Id": run.requestId,
      };
      if (isReconnect && run.lastEventId) {
        headers["Last-Event-ID"] = run.lastEventId;
      }

      fetch(fullUrl, {
        method: "POST",
        headers,
        credentials: "include",
        body: JSON.stringify(run.body),
        signal: controller.signal,
      })
        .then(async (response) => {
          registerWorkflowJob(run, response.headers.get("X-Workflow-Job-Id"));
          if (!ownsActiveRun(run) || run.stopped || run.superseded) {
            if (run.stopResult) {
              const confirmed = await run.stopResult;
              if (confirmed) {
                await response.body?.cancel().catch(() => undefined);
              }
            }
            return;
          }
          if (!response.ok) {
            const text = await response.text();
            if (!ownsActiveRun(run) || run.stopped || run.done) return;
            optionsRef.current.onError?.(text, String(response.status));
            clearRunTimers(run);
            setIsStreaming(false);
            return;
          }

          const reader = response.body?.getReader();
          if (!reader) {
            if (ownsActiveRun(run)) {
              clearRunTimers(run);
              setIsStreaming(false);
            }
            return;
          }

          run.reconnectAttempts = 0;
          const decoder = new TextDecoder();
          let buffer = "";
          let currentEventId = "";

          while (ownsActiveRun(run) && !run.stopped && !run.done) {
            const { done, value } = await reader.read();
            if (!ownsActiveRun(run) || run.stopped || run.superseded) {
              await reader.cancel().catch(() => undefined);
              return;
            }
            if (done) break;
            resetHeartbeatTimer();
            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split("\n");
            buffer = lines.pop() ?? "";

            let currentEventType = "";
            for (const line of lines) {
              if (!ownsActiveRun(run) || run.stopped || run.done) return;
              if (line.startsWith("event: ")) {
                currentEventType = line.slice(7).trim();
                continue;
              }
              if (line.startsWith("id: ")) {
                currentEventId = line.slice(4).trim();
                continue;
              }
              if (line === "") {
                currentEventType = "";
                currentEventId = "";
                continue;
              }
              if (!line.startsWith("data: ")) continue;
              const jsonStr = line.slice(6).trim();
              if (!jsonStr || jsonStr === "[DONE]") continue;

              try {
                const raw = JSON.parse(jsonStr) as Record<string, unknown>;
                if (!raw.type && currentEventType) {
                  raw.type = currentEventType;
                }
                const event = raw as unknown as SSEEvent;
                if (!ownsActiveRun(run) || run.stopped || run.done) return;

                switch (event.type) {
                  case "meta":
                    registerWorkflowJob(
                      run,
                      event.workflow_job_id ?? event.result_id,
                    );
                    if (!ownsActiveRun(run) || run.stopped) return;
                    setResultId(event.result_id);
                    optionsRef.current.onMeta?.(
                      event.result_id,
                      event.task_type,
                    );
                    break;
                  case "reset":
                    run.content = "";
                    setContent("");
                    setCitations([]);
                    break;
                  case "token":
                    run.content += event.content;
                    setContent(run.content);
                    optionsRef.current.onToken?.(
                      event.content,
                      event.paragraph_key,
                    );
                    break;
                  case "citation":
                    if (event.citations && Array.isArray(event.citations)) {
                      setCitations((previous) =>
                        ownsActiveRun(run)
                          ? [...previous, ...event.citations]
                          : previous,
                      );
                      optionsRef.current.onCitation?.(
                        event.paragraph_key,
                        event.citations,
                      );
                    }
                    break;
                  case "done":
                    run.done = true;
                    setResultId(event.result_id);
                    registerWorkflowJob(run, event.workflow_job_id);
                    if (event.citations && Array.isArray(event.citations)) {
                      setCitations((previous) => {
                        if (!ownsActiveRun(run)) return previous;
                        const ids = new Set(
                          previous.map((citation) => citation.id),
                        );
                        const additions = event.citations.filter(
                          (citation) => !ids.has(citation.id),
                        );
                        return [...previous, ...additions];
                      });
                    }
                    optionsRef.current.onDone?.(
                      event.result_id,
                      event.citations || [],
                      run.content,
                      event.outline_id,
                      event.directory_id,
                      event.server_saved,
                      event.workflow_job_id,
                    );
                    clearRunTimers(run);
                    setIsStreaming(false);
                    return;
                  case "error":
                    run.done = true;
                    optionsRef.current.onError?.(
                      event.message,
                      event.error_code,
                    );
                    clearRunTimers(run);
                    setIsStreaming(false);
                    return;
                  case "heartbeat":
                    break;
                }
                if (currentEventId && ownsActiveRun(run)) {
                  run.lastEventId = currentEventId;
                }
              } catch (error) {
                if (ownsActiveRun(run)) {
                  console.error("SSE JSON 解析失败", jsonStr, error);
                }
              }
            }
          }

          if (!ownsActiveRun(run)) return;
          if (run.heartbeatTimer) {
            clearTimeout(run.heartbeatTimer);
            run.heartbeatTimer = null;
          }
          if (!run.done && !run.stopped) {
            attemptReconnect();
          } else {
            setIsStreaming(false);
          }
        })
        .catch((error: unknown) => {
          if (!ownsActiveRun(run)) return;
          if (run.heartbeatTimer) {
            clearTimeout(run.heartbeatTimer);
            run.heartbeatTimer = null;
          }
          if (
            error instanceof Error &&
            error.name === "AbortError" &&
            (run.stopped || run.done)
          ) {
            setIsStreaming(false);
            return;
          }
          if (!run.stopped && !run.done) {
            attemptReconnect();
            return;
          }
          if (!(error instanceof Error && error.name === "AbortError")) {
            optionsRef.current.onError?.(
              error instanceof Error ? error.message : String(error),
              "NETWORK_ERROR",
            );
          }
          setIsStreaming(false);
        });
    },
    [clearRunTimers, ownsActiveRun, registerWorkflowJob],
  );

  const start = useCallback(
    (url: string, body: Record<string, unknown>) => {
      const previous = activeRunRef.current;
      if (previous) {
        previous.superseded = true;
        void requestRunStop(previous, !previous.done);
      }

      const run: StreamRun = {
        generation: nextGenerationRef.current + 1,
        url,
        body,
        requestId: crypto.randomUUID(),
        controller: null,
        workflowJobId: null,
        lastEventId: null,
        reconnectAttempts: 0,
        heartbeatTimer: null,
        reconnectTimer: null,
        handshakeStopTimer: null,
        content: "",
        stopped: false,
        done: false,
        superseded: false,
        disposed: false,
        pendingStop: false,
        cancellation: null,
        stopResult: null,
        resolveStopResult: null,
      };
      nextGenerationRef.current = run.generation;
      activeRunRef.current = run;
      setContent("");
      setCitations([]);
      setResultId(null);
      setWorkflowJobId(null);
      startStream(run, false);
    },
    [requestRunStop, startStream],
  );

  useEffect(() => {
    return () => {
      const run = activeRunRef.current;
      if (!run) return;
      run.disposed = true;
      clearRunTimers(run);
      abortRunTransport(run);
      resolveStopResult(run, false);
      if (activeRunRef.current === run) activeRunRef.current = null;
    };
  }, [abortRunTransport, clearRunTimers, resolveStopResult]);

  return {
    content,
    isStreaming,
    resultId,
    citations,
    workflowJobId,
    start,
    stop,
  };
}

function extractProjectId(url: string): string | null {
  const match = url.match(/\/projects\/([^/]+)\//);
  return match ? decodeURIComponent(match[1]) : null;
}
