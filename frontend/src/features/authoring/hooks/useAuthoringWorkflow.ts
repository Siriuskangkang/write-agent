'use client';

import { useCallback, useEffect, useMemo, useRef } from 'react';
import { message as antdMessage } from 'antd';
import { useChatStore } from '@/stores/chatStore';
import { useEditorStore } from '@/stores/editorStore';
import { MessageRole } from '@/types';
import {
  isWorkflowRunning,
  type WorkflowType,
} from '@/features/workflows/types';
import {
  useWorkflowStore,
  workflowStore,
} from '@/features/workflows/stores/workflowStore';
import { loadAuthoritativeAuthoringArtifact } from '../services/authoritativeAuthoringService';
import type { PersistWorkbenchMessageInput } from './useWorkbenchSession';

interface UseAuthoringWorkflowInput {
  projectId: string;
  sessionReady: boolean;
  persistMessage: (
    input: PersistWorkbenchMessageInput,
  ) => Promise<unknown>;
  onShowCitations: () => void;
}

export function useAuthoringWorkflow({
  projectId,
  sessionReady,
  persistMessage,
  onShowCitations,
}: UseAuthoringWorkflowInput) {
  const runtime = useWorkflowStore((state) => state.jobsByProject[projectId]);
  const {
    citations,
    setCitations,
    setCurrentDirectoryVersionId,
    setCurrentDirectoryVersionNumber,
    setCurrentOutline,
    setCurrentResult,
    setDirectoryNodes,
  } = useEditorStore();
  const finalizedJobs = useRef(new Set<string>());
  const recoveredProject = useRef<string | null>(null);

  useEffect(() => {
    if (recoveredProject.current === projectId) return;
    recoveredProject.current = projectId;
    void workflowStore
      .getState()
      .recoverProject(projectId)
      .catch(() => antdMessage.warning('恢复上次生成任务失败，请重新发起'));
  }, [projectId]);

  useEffect(() => {
    if (!runtime) return;
    const needsPolling =
      isWorkflowRunning(runtime.job.status) ||
      runtime.job.status === 'WAITING_APPROVAL' ||
      (runtime.job.status === 'SUCCEEDED' && !runtime.resourceId);
    if (!needsPolling) return;
    let cancelled = false;
    const refresh = () => {
      void workflowStore
        .getState()
        .refreshProject(projectId)
        .catch(() => {
          if (!cancelled) {
            antdMessage.warning('任务状态暂时无法刷新，将继续重试');
          }
        });
    };
    const timer = window.setInterval(refresh, 1_500);
    refresh();
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [projectId, runtime?.job.status, runtime?.resourceId]);

  useEffect(() => {
    if (
      !runtime ||
      runtime.job.status !== 'SUCCEEDED' ||
      !runtime.resourceId ||
      !sessionReady ||
      finalizedJobs.current.has(runtime.job.id)
    ) {
      return;
    }
    finalizedJobs.current.add(runtime.job.id);
    void (async () => {
      try {
        const artifact = await loadAuthoritativeAuthoringArtifact(runtime);
        if (artifact.directory) {
          setDirectoryNodes(artifact.directory.content);
          setCurrentDirectoryVersionId(artifact.directory.id);
          setCurrentDirectoryVersionNumber(artifact.directory.version_number);
        }
        if (artifact.outline) setCurrentOutline(artifact.outline);
        if (artifact.result) setCurrentResult(artifact.result);
        setCitations(artifact.citations);
        if (artifact.citations.length > 0) onShowCitations();

        const alreadyPersisted = useChatStore
          .getState()
          .messages.some(
            (item) => item.metadata?.workflow_job_id === runtime.job.id,
          );
        if (!alreadyPersisted) {
          await persistMessage({
            role: MessageRole.ASSISTANT,
            content: artifact.content,
            message_type: artifact.messageType,
            metadata: artifact.metadata,
          });
        }
        antdMessage.success('服务端版本已批准并载入');
        workflowStore.getState().dismissProject(projectId);
      } catch (error) {
        finalizedJobs.current.delete(runtime.job.id);
        antdMessage.error(
          error instanceof Error ? error.message : '载入服务端版本失败',
        );
      }
    })();
  }, [
    onShowCitations,
    persistMessage,
    projectId,
    runtime,
    sessionReady,
    setCitations,
    setCurrentDirectoryVersionId,
    setCurrentDirectoryVersionNumber,
    setCurrentOutline,
    setCurrentResult,
    setDirectoryNodes,
  ]);

  const startWorkflow = useCallback(
    async (workflowType: WorkflowType, input?: Record<string, unknown>) => {
      await workflowStore
        .getState()
        .createWorkflow(projectId, workflowType, input);
    },
    [projectId],
  );

  const cancelWorkflow = useCallback(async () => {
    try {
      await workflowStore.getState().cancelProject(projectId);
      antdMessage.info('已停止当前生成');
    } catch (error) {
      antdMessage.error(
        error instanceof Error ? error.message : '取消任务失败',
      );
    }
  }, [projectId]);

  const approveWorkflow = useCallback(async () => {
    try {
      await workflowStore.getState().approveProject(projectId);
      antdMessage.success('已批准，服务器正在保存版本');
    } catch (error) {
      antdMessage.error(
        error instanceof Error ? error.message : '批准提案失败',
      );
    }
  }, [projectId]);

  const resumeWorkflow = useCallback(async () => {
    try {
      await workflowStore.getState().resumeProject(projectId);
      antdMessage.info('已重新提交，服务器将使用最新素材');
    } catch (error) {
      antdMessage.error(
        error instanceof Error ? error.message : '恢复任务失败',
      );
    }
  }, [projectId]);

  const dismissWorkflow = useCallback(() => {
    workflowStore.getState().dismissProject(projectId);
  }, [projectId]);

  const isStreaming = runtime ? isWorkflowRunning(runtime.job.status) : false;
  const currentTaskType = runtime?.job.workflow_type ?? null;
  const workflowUi = useMemo(
    () => ({
      runtime,
      approve: approveWorkflow,
      cancel: cancelWorkflow,
      resume: resumeWorkflow,
      dismiss: dismissWorkflow,
    }),
    [
      approveWorkflow,
      cancelWorkflow,
      dismissWorkflow,
      resumeWorkflow,
      runtime,
    ],
  );

  return {
    currentTaskType,
    streamContent: runtime?.streamContent ?? '',
    isStreaming,
    citations,
    startWorkflow,
    cancelWorkflow,
    workflowUi,
  };
}
