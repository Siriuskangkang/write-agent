import { contentService } from '@/services/contentService';
import { projectService } from '@/services/projectService';
import {
  MessageType,
  type Citation,
  type DirectoryVersion,
  type MessageType as MessageTypeValue,
  type OutlineVersion,
  type WritingResult,
} from '@/types';
import type { WorkflowRuntime } from '@/features/workflows/types';
import { citationWorkspaceService } from '@/features/citations/services/citationWorkspaceService';

export interface AuthoritativeAuthoringArtifact {
  messageType: MessageTypeValue;
  content: string;
  metadata: Record<string, unknown>;
  directory: DirectoryVersion | null;
  outline: OutlineVersion | null;
  result: WritingResult | null;
  citations: Citation[];
}

export async function loadAuthoritativeAuthoringArtifact(
  runtime: WorkflowRuntime,
): Promise<AuthoritativeAuthoringArtifact> {
  const resourceId = runtime.resourceId;
  if (!resourceId) throw new Error('工作流完成事件缺少权威资源 ID');

  const metadata: Record<string, unknown> = {
    task_type: runtime.job.workflow_type,
    workflow_job_id: runtime.job.id,
    version_id: runtime.versionId,
  };

  if (runtime.job.workflow_type === 'directory') {
    const response = await projectService.getDirectoryVersion(
      runtime.projectId,
      resourceId,
    );
    if (!response.success) throw new Error(response.message ?? '加载目录版本失败');
    metadata.directory_version_id = response.data.id;
    return {
      messageType: MessageType.DIRECTORY,
      content: JSON.stringify({ nodes: response.data.content }),
      metadata,
      directory: response.data,
      outline: null,
      result: null,
      citations: [],
    };
  }

  if (runtime.job.workflow_type === 'outline') {
    const response = await contentService.getOutline(runtime.projectId, resourceId);
    if (!response.success) throw new Error(response.message ?? '加载大纲版本失败');
    metadata.outline_id = response.data.id;
    metadata.chapter_node_id = response.data.chapter_node_id;
    return {
      messageType: MessageType.OUTLINE,
      content: JSON.stringify(response.data.content),
      metadata,
      directory: null,
      outline: response.data,
      result: null,
      citations: [],
    };
  }

  const response = await contentService.getResult(runtime.projectId, resourceId);
  if (!response.success) throw new Error(response.message ?? '加载正文版本失败');
  const citations = await citationWorkspaceService.loadForResult(
    runtime.projectId,
    resourceId,
  );
  metadata.result_id = response.data.id;
  metadata.chapter_node_id = response.data.chapter_node_id;
  metadata.section_node_id = response.data.section_node_id;
  return {
    messageType: MessageType.CONTENT,
    content: response.data.content_text,
    metadata,
    directory: null,
    outline: null,
    result: response.data,
    citations,
  };
}
