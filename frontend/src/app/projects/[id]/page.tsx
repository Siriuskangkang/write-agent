'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useParams } from 'next/navigation';
import { Spin, Tooltip, message } from 'antd';
import {
  ExportOutlined,
  MenuFoldOutlined,
  MenuUnfoldOutlined,
  MessageOutlined,
  ProfileOutlined,
} from '@ant-design/icons';
import DirectorySidebar from '@/components/workbench/DirectorySidebar';
import ChatPanel from '@/components/workbench/ChatPanel';
import CitationPanel from '@/components/workbench/CitationPanel';
import EditorTabs from '@/components/workbench/EditorTabs';
import ExportModal from '@/components/common/ExportModal';
import { projectService } from '@/services/projectService';
import { useProjectStore } from '@/stores/projectStore';
import { useEditorStore } from '@/stores/editorStore';

export default function WorkbenchPage() {
  const params = useParams();
  const projectId = params.id as string;
  const { currentProject, projectState, setProjectState } = useProjectStore();
  const {
    ensureProjectScope,
    currentDirectoryVersionId,
    selectedChapterNodeId,
    selectedSectionNodeId,
    leftSidebarCollapsed,
    chatCollapsed,
    citationCollapsed,
    setCurrentDirectoryVersionId,
    setSelectedChapterNodeId,
    setSelectedSectionNodeId,
    setLeftSidebarCollapsed,
    setChatCollapsed,
    setCitationCollapsed,
  } = useEditorStore();

  const [loading, setLoading] = useState(true);
  const [exportOpen, setExportOpen] = useState(false);
  const syncTimerRef = useRef<number | null>(null);

  useEffect(() => {
    ensureProjectScope(projectId);
  }, [ensureProjectScope, projectId]);

  const loadProjectState = useCallback(async () => {
    try {
      setLoading(true);
      const res = await projectService.getProjectState(projectId).catch(() => null);

      if (res?.success) {
        setProjectState(res.data);

        // 用 getState() 读取，避免将这些字段加入 deps 导致每次选节点都重新触发加载
        const s = useEditorStore.getState();
        const hasLocalWorkspaceState =
          s.tabs.length > 0 ||
          s.currentDirectoryVersionId != null ||
          s.selectedChapterNodeId != null ||
          s.selectedSectionNodeId != null;

        if (!hasLocalWorkspaceState) {
          setCurrentDirectoryVersionId(res.data.current_directory_version_id);
          setSelectedChapterNodeId(res.data.in_progress_chapter);
          setSelectedSectionNodeId(res.data.in_progress_section);
        }
      } else {
        setProjectState(null);
      }
    } catch {
      message.error('加载工作台状态失败');
    } finally {
      setLoading(false);
    }
  }, [
    projectId,
    setCurrentDirectoryVersionId,
    setProjectState,
    setSelectedChapterNodeId,
    setSelectedSectionNodeId,
  ]);

  useEffect(() => {
    loadProjectState();
  }, [loadProjectState]);

  useEffect(() => {
    if (loading || !projectState) {
      return;
    }

    const nextDirectoryVersionId = currentDirectoryVersionId ?? null;
    const nextChapterId = selectedChapterNodeId ?? null;
    const nextSectionId = selectedSectionNodeId ?? null;

    const stateUnchanged =
      (projectState.current_directory_version_id ?? null) === nextDirectoryVersionId &&
      (projectState.in_progress_chapter ?? null) === nextChapterId &&
      (projectState.in_progress_section ?? null) === nextSectionId;

    if (stateUnchanged) {
      return;
    }

    if (syncTimerRef.current != null) {
      window.clearTimeout(syncTimerRef.current);
    }

    syncTimerRef.current = window.setTimeout(async () => {
      const res = await projectService.updateProjectState(projectId, {
        current_directory_version_id: nextDirectoryVersionId,
        in_progress_chapter: nextChapterId,
        in_progress_section: nextSectionId,
        completed_chapters: projectState.completed_chapters,
        pending_items: projectState.pending_items,
        material_gaps: projectState.material_gaps,
        user_notes: projectState.user_notes,
      });

      if (res.success) {
        setProjectState(res.data);
      }
    }, 400);

    return () => {
      if (syncTimerRef.current != null) {
        window.clearTimeout(syncTimerRef.current);
        syncTimerRef.current = null;
      }
    };
  }, [
    currentDirectoryVersionId,
    loading,
    projectId,
    projectState,
    selectedChapterNodeId,
    selectedSectionNodeId,
    setProjectState,
  ]);

  if (loading && !projectState && !currentProject) {
    return (
      <div className="project-page-card" style={{ height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 10 }}>
          <Spin size="large" />
          <span style={{ fontSize: 13, color: '#7F95B2' }}>正在准备工作台...</span>
        </div>
      </div>
    );
  }

  return (
    <>
      <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
        <div className="project-page-hero" style={{ marginBottom: 16 }}>
          <div>
            <h1>工作台</h1>
            <p>围绕目录、大纲、正文与 AI 会话持续推进当前教材项目。</p>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
            <WorkbenchToggle
              active={!leftSidebarCollapsed}
              icon={leftSidebarCollapsed ? <MenuUnfoldOutlined /> : <MenuFoldOutlined />}
              label={leftSidebarCollapsed ? '展开目录' : '收起目录'}
              onClick={() => setLeftSidebarCollapsed(!leftSidebarCollapsed)}
            />
            <WorkbenchToggle
              active={!chatCollapsed}
              icon={<MessageOutlined />}
              label={chatCollapsed ? '展开助手' : '收起助手'}
              onClick={() => setChatCollapsed(!chatCollapsed)}
            />
            <WorkbenchToggle
              active={!citationCollapsed}
              icon={<ProfileOutlined />}
              label={citationCollapsed ? '显示引用' : '隐藏引用'}
              onClick={() => setCitationCollapsed(!citationCollapsed)}
            />

            <button
              type="button"
              className="projects-create-btn btn-shimmer"
              onClick={() => setExportOpen(true)}
              style={{ height: 38 }}
            >
              <ExportOutlined />
              导出内容
            </button>
          </div>
        </div>

        <div className="project-page-card" style={{ flex: 1, minHeight: 0, overflow: 'hidden', padding: 12, position: 'relative' }}>
          <div style={{ display: 'flex', gap: 12, height: '100%', minHeight: 0 }}>
            <section style={{ flex: 1, minWidth: 0, minHeight: 0, overflow: 'hidden', borderRadius: 22, background: '#FFFFFF' }}>
              <EditorTabs projectId={projectId} />
            </section>

            {!chatCollapsed && (
              <aside style={{ width: 360, flexShrink: 0, minHeight: 0, overflow: 'hidden', borderRadius: 22, background: '#FFFFFF' }}>
                <ChatPanel projectId={projectId} onShowCitations={() => setCitationCollapsed(false)} />
              </aside>
            )}

            {!citationCollapsed && (
              <aside style={{ width: 300, flexShrink: 0, minHeight: 0, overflow: 'auto', borderRadius: 22, background: '#FFFFFF' }}>
                <CitationPanel onClose={() => setCitationCollapsed(true)} />
              </aside>
            )}
          </div>

          {!loading && (
            <div
              style={{
                position: 'absolute',
                inset: 12,
                zIndex: 4,
                pointerEvents: 'none',
              }}
            >
              <div
                onClick={() => setLeftSidebarCollapsed(true)}
                style={{
                  position: 'absolute',
                  inset: 0,
                  borderRadius: 22,
                  background: leftSidebarCollapsed ? 'rgba(255,255,255,0)' : 'rgba(19, 39, 80, 0.12)',
                  backdropFilter: leftSidebarCollapsed ? 'none' : 'blur(2px)',
                  opacity: leftSidebarCollapsed ? 0 : 1,
                  transition: 'opacity 0.22s ease, background 0.22s ease',
                  pointerEvents: leftSidebarCollapsed ? 'none' : 'auto',
                }}
              />

              <aside
                style={{
                  position: 'absolute',
                  left: 0,
                  top: 0,
                  bottom: 0,
                  width: 'fit-content',
                  minWidth: 280,
                  maxWidth: 'min(460px, calc(100vw - 72px))',
                  transform: leftSidebarCollapsed ? 'translateX(calc(-100% - 24px))' : 'translateX(0)',
                  opacity: leftSidebarCollapsed ? 0 : 1,
                  transition: 'transform 0.28s ease, opacity 0.22s ease',
                  filter: leftSidebarCollapsed ? 'drop-shadow(0 0 0 rgba(0,0,0,0))' : 'drop-shadow(0 18px 32px rgba(16,103,222,0.18))',
                  pointerEvents: 'auto',
                }}
              >
                <DirectorySidebar projectId={projectId} />
              </aside>
            </div>
          )}
        </div>
      </div>

      <ExportModal projectId={projectId} open={exportOpen} onClose={() => setExportOpen(false)} />
    </>
  );
}

function WorkbenchToggle({
  active,
  icon,
  label,
  onClick,
}: {
  active: boolean;
  icon: React.ReactNode;
  label: string;
  onClick: () => void;
}) {
  return (
    <Tooltip title={label}>
      <button
        type="button"
        onClick={onClick}
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          width: 38,
          height: 38,
          borderRadius: 14,
          border: 'none',
          background: active ? '#EDF5FF' : '#F8FAFC',
          color: active ? '#1B74F0' : '#6883A7',
          cursor: 'pointer',
          transition: 'background 0.18s ease, color 0.18s ease',
        }}
      >
        {icon}
      </button>
    </Tooltip>
  );
}
