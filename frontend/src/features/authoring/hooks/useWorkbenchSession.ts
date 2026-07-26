'use client';

import { useCallback, useEffect, useState } from 'react';
import { message as antdMessage } from 'antd';
import { useChatStore } from '@/stores/chatStore';
import { useEditorStore } from '@/stores/editorStore';
import { sessionService } from '@/services/sessionService';
import { contentService } from '@/services/contentService';
import { citationWorkspaceService } from '@/features/citations/services/citationWorkspaceService';
import { MessageRole, MessageType } from '@/types';
import type {
  Message,
  MessageType as MessageTypeValue,
  Session,
} from '@/types';

export interface PersistWorkbenchMessageInput {
  role: MessageRole;
  content: string;
  message_type: MessageTypeValue;
  metadata?: Record<string, unknown>;
}

export function useWorkbenchSession(projectId: string) {
  const {
    currentSessionId,
    setCurrentSessionId,
    setMessages,
    setSessions,
    addMessage,
  } = useChatStore();
  const {
    setCitations,
    setCurrentOutline,
    setCurrentResult,
  } = useEditorStore();
  const [sessionReady, setSessionReady] = useState(false);

  const ensureSession = useCallback(async (): Promise<Session> => {
    const response = await sessionService.listSessions(projectId);
    if (response.success) {
      setSessions(response.data);
      const activeSessionId = useChatStore.getState().currentSessionId;
      const current = response.data.find((item) => item.id === activeSessionId);
      if (current) return current;
      if (response.data[0]) {
        setCurrentSessionId(response.data[0].id);
        return response.data[0];
      }
    }
    const created = await sessionService.createSession(projectId, {
      title: '工作台会话',
    });
    if (!created.success) throw new Error(created.message ?? '创建会话失败');
    setSessions([created.data]);
    setCurrentSessionId(created.data.id);
    return created.data;
  }, [projectId, setCurrentSessionId, setSessions]);

  const persistMessage = useCallback(
    async (input: PersistWorkbenchMessageInput): Promise<Message | null> => {
      const session = await ensureSession();
      const response = await sessionService.createMessage(
        projectId,
        session.id,
        input,
      );
      if (!response.success) return null;
      addMessage(response.data);
      return response.data;
    },
    [addMessage, ensureSession, projectId],
  );

  const restoreWorkspace = useCallback(
    async (items: Message[]) => {
      setCurrentOutline(null);
      setCurrentResult(null);
      setCitations([]);
      const assistants = [...items]
        .filter((item) => item.role === MessageRole.ASSISTANT)
        .reverse();
      const latestOutline = assistants.find(
        (item) =>
          item.message_type === MessageType.OUTLINE &&
          typeof item.metadata?.outline_id === 'string',
      );
      if (typeof latestOutline?.metadata?.outline_id === 'string') {
        const response = await contentService
          .getOutline(projectId, latestOutline.metadata.outline_id)
          .catch(() => null);
        if (response?.success) setCurrentOutline(response.data);
      }
      const latestResult = assistants.find(
        (item) =>
          item.message_type === MessageType.CONTENT &&
          typeof item.metadata?.result_id === 'string',
      );
      if (typeof latestResult?.metadata?.result_id === 'string') {
        const resultId = latestResult.metadata.result_id;
        const [response, citations] = await Promise.all([
          contentService.getResult(projectId, resultId).catch(() => null),
          citationWorkspaceService.loadForResult(projectId, resultId),
        ]);
        if (response?.success) setCurrentResult(response.data);
        setCitations(citations);
      }
    },
    [projectId, setCitations, setCurrentOutline, setCurrentResult],
  );

  useEffect(() => {
    let cancelled = false;
    const bootstrap = async () => {
      try {
        setSessionReady(false);
        const session = await ensureSession();
        if (cancelled) return;
        const response = await sessionService.listMessages(
          projectId,
          session.id,
          { page: 1, page_size: 100 },
        );
        if (cancelled) return;
        const items = response.success ? response.data.items : [];
        setMessages(items);
        await restoreWorkspace(items);
      } catch {
        if (!cancelled) antdMessage.error('初始化工作台会话失败');
      } finally {
        if (!cancelled) setSessionReady(true);
      }
    };
    void bootstrap();
    return () => {
      cancelled = true;
      setSessions([]);
      setCurrentSessionId(null);
      setMessages([]);
      setCurrentOutline(null);
      setCurrentResult(null);
      setCitations([]);
    };
  }, [
    ensureSession,
    projectId,
    restoreWorkspace,
    setCitations,
    setCurrentOutline,
    setCurrentResult,
    setCurrentSessionId,
    setMessages,
    setSessions,
  ]);

  return {
    currentSessionId,
    sessionReady,
    persistMessage,
  };
}
