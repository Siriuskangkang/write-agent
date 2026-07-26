import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useSSE } from "./useSSE";

function eventStream(frames: string): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(frames));
      controller.close();
    },
  });
  return new Response(body, {
    status: 200,
    headers: { "Content-Type": "text/event-stream" },
  });
}

function frame(id: string, type: string, data: Record<string, unknown>) {
  return `id: ${id}\nevent: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function flushPromises(rounds = 12) {
  for (let index = 0; index < rounds; index += 1) {
    await Promise.resolve();
  }
}

describe("useSSE durable workflow recovery", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("reconnects after the last parsed event and resets superseded model output", async () => {
    const jobId = "33333333-3333-4333-8333-333333333333";
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        eventStream(
          frame("event-1", "meta", {
            type: "meta",
            result_id: jobId,
            workflow_job_id: jobId,
            task_type: "content",
            started_at: new Date().toISOString(),
          }) +
            frame("event-2", "token", {
              type: "token",
              content: "old-partial",
              paragraph_key: "",
            }),
        ),
      )
      .mockResolvedValueOnce(
        eventStream(
          frame("event-3", "reset", {
            type: "reset",
            superseded_attempt: 1,
            generation_attempt: 2,
          }) +
            frame("event-4", "token", {
              type: "token",
              content: "fresh",
              paragraph_key: "",
            }) +
            frame("event-5", "done", {
              type: "done",
              result_id: "result-1",
              workflow_job_id: jobId,
              status: "succeeded",
              citations: [],
            }),
        ),
      );
    vi.stubGlobal("fetch", fetchMock);
    const { result } = renderHook(() => useSSE());

    act(() => {
      result.current.start("/projects/project-1/content/generate", {});
    });

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2), {
      timeout: 4_000,
    });
    await waitFor(() => expect(result.current.content).toBe("fresh"));
    const reconnectHeaders = fetchMock.mock.calls[1][1]?.headers as Record<
      string,
      string
    >;
    expect(reconnectHeaders["Last-Event-ID"]).toBe("event-2");
  }, 6_000);

  it("posts durable cancellation for directory generation before closing the stream", async () => {
    const jobId = "33333333-3333-4333-8333-333333333333";
    const hanging = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          new TextEncoder().encode(
            frame("event-1", "meta", {
              type: "meta",
              result_id: jobId,
              workflow_job_id: jobId,
              task_type: "directory",
              started_at: new Date().toISOString(),
            }),
          ),
        );
      },
    });
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(hanging, {
          status: 200,
          headers: { "Content-Type": "text/event-stream" },
        }),
      )
      .mockResolvedValueOnce(new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const { result } = renderHook(() => useSSE());

    act(() => {
      result.current.start("/projects/project-1/directory/generate", {});
    });
    await waitFor(() => expect(result.current.resultId).toBe(jobId));
    await act(async () => {
      await result.current.stop();
    });

    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining(
        `/api/projects/project-1/workflows/${jobId}/cancel`,
      ),
      expect.objectContaining({
        method: "POST",
        credentials: "include",
      }),
    );
  });

  it("keeps an abort-sensitive handshake alive until Stop durably cancels the late job", async () => {
    const jobId = "44444444-4444-4444-8444-444444444444";
    const response = deferred<Response>();
    const onToken = vi.fn();
    const onDone = vi.fn();
    let generationSignal: AbortSignal | undefined;
    const fetchMock = vi
      .fn()
      .mockImplementationOnce(
        (_url: string | URL | Request, init?: RequestInit) => {
          generationSignal = init?.signal ?? undefined;
          return new Promise<Response>((resolve, reject) => {
            generationSignal?.addEventListener(
              "abort",
              () =>
                reject(
                  new DOMException("The operation was aborted", "AbortError"),
                ),
              { once: true },
            );
            void response.promise.then(resolve, reject);
          });
        },
      )
      .mockResolvedValueOnce(new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const { result } = renderHook(() => useSSE({ onToken, onDone }));

    act(() => {
      result.current.start("/projects/project-1/directory/generate", {});
    });
    await act(async () => {
      void result.current.stop();
      await flushPromises();
    });
    expect(generationSignal?.aborted).toBe(false);
    expect(result.current.isStreaming).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    response.resolve(
      new Response(
        eventStream(
          frame("event-1", "meta", {
            type: "meta",
            result_id: jobId,
            workflow_job_id: jobId,
            task_type: "directory",
          }) +
            frame("event-2", "token", {
              type: "token",
              content: "must-not-render",
              paragraph_key: "",
            }) +
            frame("event-3", "done", {
              type: "done",
              result_id: "directory-1",
              workflow_job_id: jobId,
              status: "succeeded",
              citations: [],
            }),
        ).body,
        {
          status: 200,
          headers: {
            "Content-Type": "text/event-stream",
            "X-Workflow-Job-Id": jobId,
          },
        },
      ),
    );
    await act(async () => {
      await flushPromises();
    });

    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining(
        `/api/projects/project-1/workflows/${jobId}/cancel`,
      ),
      expect.objectContaining({ method: "POST" }),
    );
    expect(generationSignal?.aborted).toBe(true);
    expect(result.current.content).toBe("");
    expect(onToken).not.toHaveBeenCalled();
    expect(onDone).not.toHaveBeenCalled();
  });

  it("bounds a stopped handshake and aborts it when no workflow identity ever arrives", async () => {
    vi.useFakeTimers();
    let generationSignal: AbortSignal | undefined;
    const fetchMock = vi.fn(
      (_url: string | URL | Request, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          generationSignal = init?.signal ?? undefined;
          generationSignal?.addEventListener(
            "abort",
            () =>
              reject(
                new DOMException("The operation was aborted", "AbortError"),
              ),
            { once: true },
          );
        }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const { result } = renderHook(() => useSSE());

    act(() => {
      result.current.start("/projects/project-1/directory/generate", {});
    });
    let stopResult!: Promise<boolean>;
    act(() => {
      stopResult = result.current.stop();
    });
    expect(result.current.isStreaming).toBe(false);
    expect(generationSignal?.aborted).toBe(false);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(4_999);
    });
    expect(generationSignal?.aborted).toBe(false);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });

    await expect(stopResult).resolves.toBe(false);
    expect(generationSignal?.aborted).toBe(true);
  });

  it("isolates rapid starts so late run A cannot reconnect, replace, or cancel run B", async () => {
    vi.useFakeTimers();
    const jobA = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const jobB = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    const responseA = deferred<Response>();
    let generationCount = 0;
    const hangingB = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          new TextEncoder().encode(
            frame("b-event-1", "meta", {
              type: "meta",
              result_id: jobB,
              workflow_job_id: jobB,
              task_type: "directory",
            }) +
              frame("b-event-2", "token", {
                type: "token",
                content: "B",
                paragraph_key: "",
              }),
          ),
        );
      },
    });
    const fetchMock = vi.fn(
      (url: string | URL | Request): Promise<Response> => {
        const target = String(url);
        if (target.includes("/cancel")) {
          return Promise.resolve(new Response("{}", { status: 200 }));
        }
        generationCount += 1;
        if (generationCount === 1) return responseA.promise;
        if (generationCount === 2) {
          return Promise.resolve(
            new Response(hangingB, {
              status: 200,
              headers: {
                "Content-Type": "text/event-stream",
                "X-Workflow-Job-Id": jobB,
              },
            }),
          );
        }
        return new Promise<Response>(() => undefined);
      },
    );
    vi.stubGlobal("fetch", fetchMock);
    const { result } = renderHook(() => useSSE());

    act(() => {
      result.current.start("/projects/project-a/directory/generate", {});
      result.current.start("/projects/project-b/directory/generate", {});
    });
    await act(async () => {
      await flushPromises();
    });
    expect(result.current.workflowJobId).toBe(jobB);
    expect(result.current.content).toBe("B");

    responseA.resolve(
      new Response(
        eventStream(
          frame("a-event-1", "meta", {
            type: "meta",
            result_id: jobA,
            workflow_job_id: jobA,
            task_type: "directory",
          }) +
            frame("a-event-2", "token", {
              type: "token",
              content: "A",
              paragraph_key: "",
            }),
        ).body,
        {
          status: 200,
          headers: {
            "Content-Type": "text/event-stream",
            "X-Workflow-Job-Id": jobA,
          },
        },
      ),
    );
    await act(async () => {
      await flushPromises();
      await vi.advanceTimersByTimeAsync(10_000);
      await flushPromises();
    });

    const targetsBeforeStop = fetchMock.mock.calls.map(([url]) => String(url));
    expect(
      targetsBeforeStop.filter((url) =>
        url.includes("/projects/project-a/directory/generate"),
      ),
    ).toHaveLength(1);
    expect(targetsBeforeStop).toContainEqual(
      expect.stringContaining(
        `/api/projects/project-a/workflows/${jobA}/cancel`,
      ),
    );
    expect(result.current.workflowJobId).toBe(jobB);
    expect(result.current.content).toBe("B");

    await act(async () => {
      await result.current.stop();
    });
    expect(fetchMock.mock.calls.map(([url]) => String(url))).toContainEqual(
      expect.stringContaining(
        `/api/projects/project-b/workflows/${jobB}/cancel`,
      ),
    );
  });

  it("does not reconnect or update state after StrictMode-style unmount cleanup", async () => {
    vi.useFakeTimers();
    const response = deferred<Response>();
    const onToken = vi.fn();
    const fetchMock = vi.fn().mockImplementation(() => response.promise);
    vi.stubGlobal("fetch", fetchMock);
    const { result, unmount } = renderHook(() => useSSE({ onToken }), {
      reactStrictMode: true,
    });

    act(() => {
      result.current.start("/projects/project-1/directory/generate", {});
    });
    unmount();
    response.resolve(
      eventStream(
        frame("late-event", "token", {
          type: "token",
          content: "late",
          paragraph_key: "",
        }),
      ),
    );
    await act(async () => {
      await flushPromises();
      await vi.advanceTimersByTimeAsync(10_000);
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(onToken).not.toHaveBeenCalled();
  });
});
