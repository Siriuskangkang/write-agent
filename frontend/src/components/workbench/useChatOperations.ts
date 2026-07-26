'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { message as antdMessage, Modal } from 'antd';
import { useRouter } from 'next/navigation';
import { useEditorStore } from '@/stores/editorStore';
import { getProjectStyleTemplate } from '@/services/styleTemplateApi';
import { MessageRole, MessageType } from '@/types';
import { useMaterialParsingStatus } from '@/features/materials/hooks/useMaterialParsingStatus';
import { useWorkbenchSession } from '@/features/authoring/hooks/useWorkbenchSession';
import { useAuthoringWorkflow } from '@/features/authoring/hooks/useAuthoringWorkflow';
import type { WorkflowType } from '@/features/workflows/types';

export type TaskKey = WorkflowType;

const quickActionMessages: Record<TaskKey, string> = {
  directory: '请根据项目信息和已上传素材，生成教材目录结构',
  outline: '请为当前选中的章节生成详细大纲',
  content: '请为当前选中的章节/节生成正文内容',
  rewrite: '请改写当前内容，优化表达和结构',
  expand: '请扩写当前内容，补充更多细节和案例',
  compress: '请精简当前内容，保留核心要点',
};

export function useChatOperations(
  projectId: string,
  onShowCitations: () => void,
) {
  const router = useRouter();
  const [inputValue, setInputValue] = useState('');
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const {
    selectedChapterNodeId,
    selectedSectionNodeId,
    currentResult,
    directoryNodes,
  } = useEditorStore();
  const { currentSessionId, sessionReady, persistMessage } =
    useWorkbenchSession(projectId);
  const hasParsing = useMaterialParsingStatus(projectId);
  const {
    currentTaskType,
    streamContent,
    isStreaming,
    citations,
    startWorkflow,
    cancelWorkflow,
    workflowUi,
  } = useAuthoringWorkflow({
    projectId,
    sessionReady,
    persistMessage,
    onShowCitations,
  });

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [streamContent, workflowUi.runtime?.job.status]);

  const handleQuickAction = useCallback(
    async (key: string) => {
      const taskKey = key as TaskKey;
      const runtimeStatus = workflowUi.runtime?.job.status;
      const workflowLocked =
        runtimeStatus !== undefined &&
        runtimeStatus !== 'FAILED' &&
        runtimeStatus !== 'STOPPED';
      if (workflowLocked || !sessionReady) return;

      if (
        taskKey === 'directory' ||
        taskKey === 'outline' ||
        taskKey === 'content'
      ) {
        try {
          const template = await getProjectStyleTemplate(projectId);
          if (
            !template ||
            template.status !== 'completed' ||
            !template.features
          ) {
            Modal.confirm({
              title: '未设置体例',
              content: '生成前需要先上传体例文件进行分析，是否前往上传？',
              okText: '前往上传',
              cancelText: '取消',
              onOk: () => router.push(`/projects/${projectId}/style-templates`),
            });
            return;
          }
        } catch {
          antdMessage.error('检查体例失败');
          return;
        }
      }

      const label = quickActionMessages[taskKey];
      const selectedNodeId =
        selectedSectionNodeId ?? selectedChapterNodeId;
      const selectedNode = directoryNodes.find(
        (node) => node.node_id === selectedNodeId,
      );
      const isRootNode = (nodeId: string) =>
        directoryNodes.find((node) => node.node_id === nodeId)
          ?.parent_node_id === null;
      const isLeafNode = (nodeId: string) =>
        !directoryNodes.some((node) => node.parent_node_id === nodeId);

      let input: Record<string, unknown> = {};
      if (taskKey === 'outline') {
        if (!selectedNodeId || !selectedNode) {
          antdMessage.warning('请先在左侧目录树中选择一个章节');
          return;
        }
        if (!isRootNode(selectedNodeId)) {
          antdMessage.warning('请选择最顶层的章节来生成大纲');
          return;
        }
        input = {
          chapter_node_id: selectedNode.node_id,
          chapter_title: selectedNode.title ?? '',
        };
      } else if (taskKey === 'content') {
        if (!selectedNodeId || !selectedNode) {
          antdMessage.warning('请先在左侧目录树中选择一个小节');
          return;
        }
        if (!isLeafNode(selectedNodeId)) {
          antdMessage.warning('请选择最底层的小节来生成正文');
          return;
        }
        const chapterNodeId =
          selectedNode.parent_node_id ?? selectedNode.node_id;
        const chapterNode = directoryNodes.find(
          (node) => node.node_id === chapterNodeId,
        );
        input = {
          session_id: currentSessionId ?? undefined,
          chapter_node_id: chapterNodeId,
          section_node_id: selectedNode.node_id,
          chapter_title: chapterNode?.title ?? '',
          section_title: selectedNode.title ?? '',
          word_count: 2000,
          style: '教材',
          strict_citation: true,
        };
      } else if (
        taskKey === 'rewrite' ||
        taskKey === 'expand' ||
        taskKey === 'compress'
      ) {
        if (!currentResult?.id) {
          antdMessage.warning('请先生成正文内容');
          return;
        }
        input = {
          result_id: currentResult.id,
          ...(taskKey === 'rewrite'
            ? { instruction: '优化表达和结构' }
            : {
                target_word_count: taskKey === 'expand' ? 3000 : 1000,
              }),
        };
      }

      try {
        await persistMessage({
          role: MessageRole.USER,
          content: label,
          message_type: MessageType.CHAT,
          metadata: {
            task_type: taskKey,
            ...(typeof input.chapter_node_id === 'string'
              ? { chapter_node_id: input.chapter_node_id }
              : {}),
            ...(typeof input.section_node_id === 'string'
              ? { section_node_id: input.section_node_id }
              : {}),
            ...(typeof input.result_id === 'string'
              ? { result_id: input.result_id }
              : {}),
          },
        });
        await startWorkflow(taskKey, input);
      } catch (error) {
        antdMessage.error(
          error instanceof Error ? error.message : '创建生成任务失败',
        );
      }
    },
    [
      currentResult?.id,
      currentSessionId,
      directoryNodes,
      persistMessage,
      projectId,
      router,
      selectedChapterNodeId,
      selectedSectionNodeId,
      sessionReady,
      startWorkflow,
      workflowUi.runtime?.job.status,
    ],
  );

  const doSend = useCallback(
    async (text: string) => {
      if (!text.trim() || isStreaming || !sessionReady) return;
      await persistMessage({
        role: MessageRole.USER,
        content: text,
        message_type: MessageType.CHAT,
        metadata: {},
      });
      await persistMessage({
        role: MessageRole.ASSISTANT,
        content: '自由对话功能暂未开放，请使用上方快捷操作按钮生成内容。',
        message_type: MessageType.CHAT,
        metadata: {},
      });
    },
    [isStreaming, persistMessage, sessionReady],
  );

  return {
    inputValue,
    setInputValue,
    currentTaskType,
    sessionReady,
    hasParsing,
    streamContent,
    isStreaming,
    citations,
    messagesEndRef,
    handleQuickAction,
    handleStop: cancelWorkflow,
    doSend,
    workflowUi,
  };
}
