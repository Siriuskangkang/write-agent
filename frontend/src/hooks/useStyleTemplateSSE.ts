import { useState, useCallback, useRef, useEffect } from 'react';
import { message } from 'antd';
import type { StyleTemplateAnalysisResult } from '@/components/workbench/StyleTemplate/types';

interface SSEState {
  progress: number;
  status: 'idle' | 'connecting' | 'analyzing' | 'done' | 'error';
  result: StyleTemplateAnalysisResult | null;
  error: string | null;
}

export function useStyleTemplateSSE() {
  const [state, setState] = useState<SSEState>({
    progress: 0,
    status: 'idle',
    result: null,
    error: null
  });

  const eventSourceRef = useRef<EventSource | null>(null);
  const reconnectCountRef = useRef(0);
  const maxReconnects = 3;

  const cleanup = useCallback(() => {
    if (eventSourceRef.current) {
      eventSourceRef.current.close();
      eventSourceRef.current = null;
    }
  }, []);

  const startAnalysis = useCallback((templateId: string, projectId: string) => {
    cleanup();

    setState({
      progress: 0,
      status: 'connecting',
      result: null,
      error: null
    });

    const url = `/api/style-templates/${templateId}/analyze?projectId=${encodeURIComponent(projectId)}`;
    const eventSource = new EventSource(url, { withCredentials: true });
    eventSourceRef.current = eventSource;

    eventSource.addEventListener('meta', (event) => {
      JSON.parse(event.data);
      setState((prev) => ({
        ...prev,
        status: 'analyzing',
        progress: 5,
      }));
    });

    eventSource.addEventListener('token', (event) => {
      const data = JSON.parse(event.data);
      if (data.step === 1) {
        setState((prev) => ({ ...prev, progress: 10 }));
      } else if (data.step === 2) {
        setState((prev) => ({ ...prev, progress: 55 }));
      }
    });

    eventSource.addEventListener('done', (event) => {
      const result = JSON.parse(event.data);
      setState({
        progress: 100,
        status: 'done',
        result,
        error: null
      });
      cleanup();
      reconnectCountRef.current = 0;
    });

    eventSource.addEventListener('error', (event: MessageEvent) => {
      const errorData = event.data ? JSON.parse(event.data) : null;
      const errorMsg = errorData?.message || '分析失败';
      console.error('[useStyleTemplateSSE] SSE error 事件:', errorMsg);

      setState({
        progress: 0,
        status: 'error',
        result: null,
        error: errorMsg
      });

      message.error(errorMsg);
      cleanup();
    });

    eventSource.onerror = () => {
      if (reconnectCountRef.current < maxReconnects) {
        reconnectCountRef.current++;
        message.warning(`连接断开，正在重连 (${reconnectCountRef.current}/${maxReconnects})`);
        setTimeout(() => startAnalysis(templateId, projectId), 2000);
      } else {
        console.error('[useStyleTemplateSSE] 达到最大重连次数，放弃');
        setState((prev) => ({
          ...prev,
          status: 'error',
          error: '连接失败，请重试'
        }));
        cleanup();
      }
    };
  }, [cleanup]);

  const cancel = useCallback(() => {
    cleanup();
    setState({
      progress: 0,
      status: 'idle',
      result: null,
      error: null
    });
  }, [cleanup]);

  useEffect(() => cleanup, [cleanup]);

  return {
    ...state,
    startAnalysis,
    cancel
  };
}
