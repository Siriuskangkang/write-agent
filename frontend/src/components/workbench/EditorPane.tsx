'use client';

import { useEffect, useState, useCallback, useRef } from 'react';
import { Spin, message, Segmented } from 'antd';
import {
  FileTextOutlined,
  ProfileOutlined,
  FormOutlined,
  CodeOutlined,
} from '@ant-design/icons';
import dynamic from 'next/dynamic';
import { useEditorStore } from '@/stores/editorStore';
import { contentService } from '@/services/contentService';
import { citationService } from '@/services/citationService';
import OutlineResultCard from './OutlineResultCard';
import type { EditorTab } from '@/stores/editorStore';
import type { OutlineContent, OutlineVersion, WritingResult } from '@/types';
import { NodeType } from '@/types';
import {
  ContentRenderer as AuthoringContentRenderer,
  EmptyPane as AuthoringEmptyPane,
  PaneHeader as AuthoringPaneHeader,
} from '@/features/authoring/components/EditorPaneViews';

// 动态导入 Monaco Editor，禁用 SSR
const MonacoEditor = dynamic(() => import('@/components/editor/MonacoEditor'), {
  ssr: false,
  loading: () => <div style={{ padding: 32, textAlign: 'center' }}><Spin /></div>,
});

// 动态导入表单编辑器
const OutlineFormEditor = dynamic(() => import('./OutlineFormEditor'), {
  ssr: false,
  loading: () => <div style={{ padding: 32, textAlign: 'center' }}><Spin /></div>,
});

interface EditorPaneProps {
  projectId: string;
  tab: EditorTab;
  isActive: boolean;
}

const OUTLINE_WIDTH_STORAGE_KEY = 'write-agent:outline-pane-width';

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

export default function EditorPane({ projectId, tab, isActive }: EditorPaneProps) {
  const { setCurrentOutline, setCurrentResult, setCitations, currentOutline, currentResult } = useEditorStore();
  const paneRef = useRef<HTMLDivElement | null>(null);
  const outlinePaneWidthRef = useRef(42);
  const isActiveRef = useRef(isActive);
  const [containerWidth, setContainerWidth] = useState(0);

  const [outline, setOutline] = useState<OutlineVersion | null>(null);
  const [result, setResult] = useState<WritingResult | null>(null);
  const [loadingOutline, setLoadingOutline] = useState(false);
  const [loadingResult, setLoadingResult] = useState(false);

  // 当全局 currentOutline 更新（生成完成后），如果属于本 tab 的 chapter，同步到本地 state
  // 或者从 API 重新加载（处理 chapter_node_id 不匹配等边界情况）
  useEffect(() => {
    if (!currentOutline) return;
    const chapterId = currentOutline.chapter_node_id;
    if (chapterId && chapterId === tab.chapterNodeId) {
      setOutline(currentOutline as unknown as OutlineVersion);
    } else if (!chapterId && tab.nodeType === NodeType.CHAPTER && tab.chapterNodeId) {
      // 降级：chapter_node_id 不存在时，主动从 API 重新拉取
      contentService.getLatestOutlineByChapter(projectId, tab.chapterNodeId)
        .then((res) => { if (res.success && res.data) setOutline(res.data); })
        .catch(() => undefined);
    }
  }, [currentOutline, tab.chapterNodeId, tab.nodeType, projectId]);

  // 当全局 currentResult 更新（正文生成完成后），如果属于本 tab 的小节，同步到本地 state
  useEffect(() => {
    if (!currentResult) return;
    if (currentResult.section_node_id && currentResult.section_node_id === tab.sectionNodeId) {
      setResult(currentResult);
    }
  }, [currentResult, tab.sectionNodeId]);

  const [editingOutline, setEditingOutline] = useState(false);
  const [editingContent, setEditingContent] = useState(false);
  const [outlineEditText, setOutlineEditText] = useState('');
  const [outlineEditMode, setOutlineEditMode] = useState<'form' | 'json'>('form');
  const [outlineFormData, setOutlineFormData] = useState<OutlineContent | null>(null);
  const [contentEditText, setContentEditText] = useState('');
  const [outlinePaneWidth, setOutlinePaneWidth] = useState(42);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const saved = window.localStorage.getItem(OUTLINE_WIDTH_STORAGE_KEY);
    if (!saved) return;
    const parsed = Number(saved);
    if (!Number.isNaN(parsed)) {
      setOutlinePaneWidth(clamp(parsed, 30, 70));
    }
  }, []);

  useEffect(() => {
    outlinePaneWidthRef.current = outlinePaneWidth;
  }, [outlinePaneWidth]);

  useEffect(() => {
    isActiveRef.current = isActive;
  }, [isActive]);

  useEffect(() => {
    if (!paneRef.current || typeof ResizeObserver === 'undefined') return;

    const element = paneRef.current;
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) return;
      setContainerWidth(entry.contentRect.width);
    });

    observer.observe(element);
    setContainerWidth(element.getBoundingClientRect().width);

    return () => observer.disconnect();
  }, []);

  const loadOutline = useCallback(async () => {
    if (!tab.chapterNodeId || tab.nodeType !== NodeType.CHAPTER) {
      setOutline(null);
      if (isActiveRef.current) {
        setCurrentOutline(null);
      }
      return;
    }

    setOutline(null);
    if (isActiveRef.current) {
      setCurrentOutline(null);
    }
    setLoadingOutline(true);
    try {
      const res = await contentService.getLatestOutlineByChapter(
        projectId,
        tab.chapterNodeId,
      );
      const data = res.success ? res.data : null;
      setOutline(data);
      if (isActiveRef.current) {
        setCurrentOutline(data);
      }
    } catch {
      setOutline(null);
      if (isActiveRef.current) {
        setCurrentOutline(null);
      }
    } finally {
      setLoadingOutline(false);
    }
  }, [projectId, setCurrentOutline, tab.chapterNodeId, tab.nodeType]);

  const loadResult = useCallback(async () => {
    if (!tab.sectionNodeId) {
      setResult(null);
      if (isActiveRef.current) {
        setCurrentResult(null);
        setCitations([]);
      }
      return;
    }

    setResult(null);
    if (isActiveRef.current) {
      setCurrentResult(null);
      setCitations([]);
    }
    setLoadingResult(true);
    try {
      const res = await contentService.getLatestResultBySection(projectId, tab.sectionNodeId);
      const data = res.success ? res.data : null;
      setResult(data);
      if (isActiveRef.current) {
        setCurrentResult(data);
      }
      if (data) {
        const citRes = await citationService.getCitations(projectId, data.id).catch(() => null);
        if (citRes?.success && isActiveRef.current) setCitations(citRes.data);
      }
    } catch {
      setResult(null);
      if (isActiveRef.current) {
        setCurrentResult(null);
        setCitations([]);
      }
    } finally {
      setLoadingResult(false);
    }
  }, [projectId, tab.sectionNodeId, setCurrentResult, setCitations]);

  useEffect(() => {
    if (!isActive) return;
    loadOutline();
    loadResult();
  }, [isActive, loadOutline, loadResult]);

  const handleSaveOutline = async () => {
    if (!outline) return;
    try {
      let content: OutlineContent;
      if (outlineEditMode === 'form') {
        // 表单模式：直接使用表单数据
        if (!outlineFormData) {
          message.error('大纲数据为空');
          return;
        }
        content = outlineFormData;
      } else {
        // JSON 模式：解析 JSON
        try {
          content = JSON.parse(outlineEditText) as OutlineContent;
        } catch {
          message.error('大纲格式不正确，请保持 JSON 格式');
          return;
        }
      }
      const res = await contentService.updateOutline(projectId, outline.id, content);
      if (res.success) {
        setOutline(res.data);
        setCurrentOutline(res.data);
        message.success('大纲已更新');
        setEditingOutline(false);
      } else {
        message.error('更新大纲失败');
      }
    } catch {
      message.error('更新大纲失败');
    }
  };

  const handleEditOutline = () => {
    if (!outline) return;
    setOutlineEditText(JSON.stringify(outline.content, null, 2));
    setOutlineFormData(outline.content);
    setOutlineEditMode('form');
    setEditingOutline(true);
  };

  const handleOutlineModeChange = (mode: 'form' | 'json') => {
    if (mode === 'json' && outlineFormData) {
      // 表单 → JSON：序列化表单数据
      setOutlineEditText(JSON.stringify(outlineFormData, null, 2));
    } else if (mode === 'form' && outlineEditText) {
      // JSON → 表单：解析 JSON
      try {
        const parsed = JSON.parse(outlineEditText);
        setOutlineFormData(parsed);
      } catch (err) {
        message.error('JSON 格式错误，无法切换到表单模式');
        return;
      }
    }
    setOutlineEditMode(mode);
  };

  const handleOutlineFormChange = (value: OutlineContent) => {
    setOutlineFormData(value);
  };

  const handleSaveContent = async () => {
    if (!result) return;
    try {
      const res = await contentService.updateWritingResult(projectId, result.id, contentEditText);
      if (res.success) {
        setResult(res.data); setCurrentResult(res.data);
        message.success('正文已更新'); setEditingContent(false);
      } else { message.error('更新正文失败'); }
    } catch { message.error('更新正文失败'); }
  };

  const handleResizeStart = (event: React.MouseEvent<HTMLDivElement>) => {
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = outlinePaneWidth;

    const handleMouseMove = (moveEvent: MouseEvent) => {
      if (!paneRef.current) return;
      const rect = paneRef.current.getBoundingClientRect();
      const deltaX = moveEvent.clientX - startX;
      const deltaPercent = (deltaX / rect.width) * 100;
      setOutlinePaneWidth(clamp(startWidth + deltaPercent, 30, 70));
    };

    const handleMouseUp = () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
      if (typeof window !== 'undefined') {
        window.localStorage.setItem(OUTLINE_WIDTH_STORAGE_KEY, String(outlinePaneWidthRef.current));
      }
      document.body.style.userSelect = '';
      document.body.style.cursor = '';
    };

    document.body.style.userSelect = 'none';
    document.body.style.cursor = 'col-resize';
    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);
  };

  const dividerWidth = 12;
  const contentPreferredMinWidth = containerWidth >= 1300 ? 760 : containerWidth >= 1100 ? 680 : 560;
  const outlineMinWidthPx = 300;
  const outlineMaxWidthPx = containerWidth > 0
    ? Math.max(outlineMinWidthPx, containerWidth - contentPreferredMinWidth - dividerWidth)
    : Number.POSITIVE_INFINITY;
  const outlinePreferredWidthPx = containerWidth > 0 ? (containerWidth * outlinePaneWidth) / 100 : 0;
  const outlinePaneWidthPx = containerWidth > 0
    ? clamp(outlinePreferredWidthPx, outlineMinWidthPx, outlineMaxWidthPx)
    : undefined;
  const outlineBodyPadding = loadingOutline || editingOutline || outline ? '12px 16px' : '0';
  const contentBodyPadding = loadingResult || editingContent || result ? '12px 16px' : '0';
  const outlineBodyStyle: React.CSSProperties = {
    flex: 1,
    width: '100%',
    minWidth: 0,
    overflow: 'auto',
    padding: outlineBodyPadding,
    display: loadingOutline || editingOutline || outline ? 'block' : 'flex',
    minHeight: 0,
  };
  const contentBodyStyle: React.CSSProperties = {
    flex: 1,
    width: '100%',
    minWidth: 0,
    overflow: 'auto',
    padding: contentBodyPadding,
    display: loadingResult || editingContent || result ? 'block' : 'flex',
    minHeight: 0,
  };
  const showOutlinePane = tab.nodeType === NodeType.CHAPTER;
  const showContentPane = tab.nodeType === NodeType.SECTION;
  return (
    <div
      ref={paneRef}
      style={{
        display: 'flex',
        flex: 1,
        width: '100%',
        minWidth: 0,
        height: '100%',
        overflow: 'hidden',
        background: '#F8FAFC',
      }}
    >
      {showOutlinePane && (
        <div style={{
          width: showContentPane ? outlinePaneWidthPx : '100%',
          minWidth: showContentPane ? outlineMinWidthPx : 0,
          display: 'flex', flexDirection: 'column',
          overflow: 'hidden',
          background: '#FFFFFF',
          flex: 1,
        }}>
          <AuthoringPaneHeader
            title="大纲"
            icon={<ProfileOutlined />}
            editing={editingOutline}
            onEdit={outline ? handleEditOutline : undefined}
            onSave={handleSaveOutline}
            onCancel={() => setEditingOutline(false)}
          />
          <div style={outlineBodyStyle}>
            {loadingOutline ? (
              <div style={{ display: 'flex', justifyContent: 'center', padding: 32 }}><Spin size="small" /></div>
            ) : editingOutline ? (
              <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
                <div style={{ padding: '8px 0', borderBottom: '1px solid #f0f0f0', marginBottom: 12 }}>
                  <Segmented
                    value={outlineEditMode}
                    onChange={handleOutlineModeChange}
                    options={[
                      { label: '表单模式', value: 'form', icon: <FormOutlined /> },
                      { label: 'JSON 模式', value: 'json', icon: <CodeOutlined /> },
                    ]}
                  />
                </div>
                {outlineEditMode === 'form' ? (
                  outlineFormData && (
                    <OutlineFormEditor
                      value={outlineFormData}
                      onChange={handleOutlineFormChange}
                    />
                  )
                ) : (
                  <MonacoEditor
                    value={outlineEditText}
                    onChange={setOutlineEditText}
                    language="json"
                    height="calc(100vh - 250px)"
                    jsonSchema={{
                      type: 'object',
                      properties: {
                        node_title: { type: 'string' },
                        level: { type: 'string' },
                        sections: {
                          type: 'array',
                          items: {
                            type: 'object',
                            required: ['column', 'required', 'writing_guide', 'length_suggestion', 'content_points'],
                            properties: {
                              column: { type: 'string' },
                              required: { type: 'boolean' },
                              writing_guide: { type: 'string' },
                              length_suggestion: { type: 'string' },
                              content_points: { type: 'array', items: { type: 'string' } },
                            },
                          },
                        },
                        key_points: { type: 'array', items: { type: 'string' } },
                        difficulties: { type: 'array', items: { type: 'string' } },
                        source_refs: {
                          type: 'array',
                          items: {
                            type: 'object',
                            required: ['file', 'relevance'],
                            properties: {
                              file: { type: 'string' },
                              pages: { type: 'string' },
                              relevance: { type: 'string' },
                            },
                          },
                        },
                      },
                    }}
                  />
                )}
              </div>
            ) : outline ? (
              <OutlineResultCard
                content={outline.content}
                chapterTitle={outline.chapter_title}
              />
            ) : (
              <AuthoringEmptyPane
                icon={<ProfileOutlined style={{ fontSize: 20, color: '#2563EB' }} />}
                title="暂无大纲"
                desc="在右侧 AI 助手中点击「生成大纲」"
              />
            )}
          </div>
        </div>
      )}

      {showOutlinePane && showContentPane && (
        <div
          onMouseDown={handleResizeStart}
          style={{
            width: 12,
            flexShrink: 0,
            cursor: 'col-resize',
            position: 'relative',
            background: '#F8FAFC',
          }}
        >
          <div
            style={{
              position: 'absolute',
              left: '50%',
              top: 20,
              bottom: 20,
              width: 4,
              transform: 'translateX(-50%)',
              borderRadius: 999,
              background: 'linear-gradient(180deg, #D6E4F7 0%, #E7EFFB 100%)',
            }}
          />
        </div>
      )}

      {showContentPane && (
        <div style={{
          flex: 1, display: 'flex', flexDirection: 'column',
          overflow: 'hidden', background: '#FFFFFF', minWidth: 0,
        }}>
          <AuthoringPaneHeader
            title="正文"
            icon={<FileTextOutlined />}
            wordCount={result?.word_count}
            editing={editingContent}
            onEdit={result ? () => { setContentEditText(result.content_text ?? ''); setEditingContent(true); } : undefined}
            onSave={handleSaveContent}
            onCancel={() => setEditingContent(false)}
          />
          <div style={contentBodyStyle}>
            {loadingResult ? (
              <div style={{ display: 'flex', justifyContent: 'center', padding: 32 }}><Spin size="small" /></div>
            ) : editingContent ? (
              <MonacoEditor
                value={contentEditText}
                onChange={setContentEditText}
                language="markdown"
                height="calc(100vh - 200px)"
              />
            ) : result ? (
              <AuthoringContentRenderer text={result.content_text ?? ''} />
            ) : (
              <AuthoringEmptyPane
                icon={<FileTextOutlined style={{ fontSize: 20, color: '#2563EB' }} />}
                title="暂无正文"
                desc="在右侧 AI 助手中点击「生成正文」"
              />
            )}
          </div>
        </div>
      )}
    </div>
  );
}
