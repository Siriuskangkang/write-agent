'use client';

import { useState } from 'react';
import { Tabs, Empty, Button, Input, Typography, Tag, Space, Card, message } from 'antd';
import { EditOutlined, CheckOutlined, CloseOutlined } from '@ant-design/icons';
import ReactMarkdown from 'react-markdown';
import rehypeHighlight from 'rehype-highlight';
import { useEditorStore } from '@/stores/editorStore';
import { contentService } from '@/services/contentService';
import OutlineResultCard from './OutlineResultCard';
import type { OutlineContent } from '@/types';

const { Text } = Typography;

interface ColumnSection {
  column: string;
  content: string;
}

function parseContentByColumns(text: string): ColumnSection[] {
  const sections: ColumnSection[] = [];
  const parts = text.split(/<!-- column:(.*?) -->/);
  for (let i = 1; i < parts.length; i += 2) {
    sections.push({
      column: parts[i].trim(),
      content: parts[i + 1]?.trim() || '',
    });
  }
  return sections;
}

interface ContentPreviewPanelProps {
  projectId: string;
}

export default function ContentPreviewPanel({ projectId }: ContentPreviewPanelProps) {
  const {
    currentOutline,
    currentResult,
    selectedChapterNodeId,
    selectedSectionNodeId,
    directoryNodes,
    setCurrentOutline,
    setCurrentResult,
  } = useEditorStore();

  const [editingOutline, setEditingOutline] = useState(false);
  const [editingContent, setEditingContent] = useState(false);
  const [outlineEditText, setOutlineEditText] = useState('');
  const [contentEditText, setContentEditText] = useState('');

  const selectedChapter = directoryNodes.find((n) => n.node_id === selectedChapterNodeId);
  const selectedSection = directoryNodes.find((n) => n.node_id === selectedSectionNodeId);

  const handleSaveOutline = async () => {
    if (!currentOutline) return;
    try {
      // 尝试解析为 JSON，否则作为字符串保存
      let content: OutlineContent;
      try {
        content = JSON.parse(outlineEditText) as OutlineContent;
      } catch {
        message.error('大纲格式不正确，请保持 JSON 格式');
        return;
      }
      const res = await contentService.updateOutline(projectId, currentOutline.id, content);
      if (res.success) {
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

  const handleSaveContent = async () => {
    if (!currentResult) return;
    try {
      const res = await contentService.updateWritingResult(projectId, currentResult.id, contentEditText);
      if (res.success) {
        setCurrentResult(res.data);
        message.success('正文已更新');
        setEditingContent(false);
      } else {
        message.error('更新正文失败');
      }
    } catch {
      message.error('更新正文失败');
    }
  };

  const hasContent = currentOutline || currentResult;

  if (!selectedChapterNodeId && !hasContent) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%' }}>
        <Empty
          image={Empty.PRESENTED_IMAGE_SIMPLE}
          description={
            <Text type="secondary" style={{ fontSize: 13 }}>
              在左侧目录树中选择章节或小节，查看大纲和正文
            </Text>
          }
        />
      </div>
    );
  }

  const tabItems = [];

  // 大纲 Tab
  if (currentOutline) {
    tabItems.push({
      key: 'outline',
      label: (
        <span>
          大纲
          {selectedChapter && (
            <Tag color="blue" style={{ marginLeft: 6, fontSize: 11 }}>
              {selectedChapter.title}
            </Tag>
          )}
        </span>
      ),
      children: (
        <div style={{ padding: '0 4px' }}>
          {editingOutline ? (
            <div>
              <Space style={{ marginBottom: 8 }}>
                <Button
                  size="small"
                  type="primary"
                  icon={<CheckOutlined />}
                  onClick={handleSaveOutline}
                >
                  保存
                </Button>
                <Button
                  size="small"
                  icon={<CloseOutlined />}
                  onClick={() => setEditingOutline(false)}
                >
                  取消
                </Button>
              </Space>
              <Input.TextArea
                value={outlineEditText}
                onChange={(e) => setOutlineEditText(e.target.value)}
                autoSize={{ minRows: 10, maxRows: 30 }}
                style={{ fontSize: 12, fontFamily: 'monospace' }}
              />
            </div>
          ) : (
            <div>
              <div style={{ textAlign: 'right', marginBottom: 8 }}>
                <Button
                  size="small"
                  icon={<EditOutlined />}
                  onClick={() => {
                    setOutlineEditText(JSON.stringify(currentOutline.content, null, 2));
                    setEditingOutline(true);
                  }}
                >
                  编辑
                </Button>
              </div>
              <OutlineResultCard
                content={currentOutline.content}
                chapterTitle={currentOutline.chapter_title}
              />
            </div>
          )}
        </div>
      ),
    });
  }

  // 正文 Tab
  if (currentResult) {
    tabItems.push({
      key: 'content',
      label: (
        <span>
          正文
          {selectedSection && (
            <Tag color="green" style={{ marginLeft: 6, fontSize: 11 }}>
              {selectedSection.title}
            </Tag>
          )}
        </span>
      ),
      children: (
        <div style={{ padding: '0 4px' }}>
          {editingContent ? (
            <div>
              <Space style={{ marginBottom: 8 }}>
                <Button
                  size="small"
                  type="primary"
                  icon={<CheckOutlined />}
                  onClick={handleSaveContent}
                >
                  保存
                </Button>
                <Button
                  size="small"
                  icon={<CloseOutlined />}
                  onClick={() => setEditingContent(false)}
                >
                  取消
                </Button>
              </Space>
              <Input.TextArea
                value={contentEditText}
                onChange={(e) => setContentEditText(e.target.value)}
                autoSize={{ minRows: 10, maxRows: 30 }}
                style={{ fontSize: 13 }}
              />
            </div>
          ) : (
            <div>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                {currentResult.word_count != null && (
                  <Text type="secondary" style={{ fontSize: 12 }}>
                    约 {currentResult.word_count} 字
                  </Text>
                )}
                <Button
                  size="small"
                  icon={<EditOutlined />}
                  onClick={() => {
                    setContentEditText(currentResult.content_text ?? '');
                    setEditingContent(true);
                  }}
                >
                  编辑
                </Button>
              </div>
              <div className="preview-markdown">
                {(() => {
                  const text = currentResult.content_text ?? '';
                  const columnSections = parseContentByColumns(text);
                  if (columnSections.length > 0) {
                    return (
                      <Space direction="vertical" style={{ width: '100%' }}>
                        {columnSections.map((sec, idx) => (
                          <Card
                            key={idx}
                            size="small"
                            title={<Tag color="blue">{sec.column}</Tag>}
                            style={{ marginBottom: 8 }}
                          >
                            <ReactMarkdown rehypePlugins={[rehypeHighlight]}>
                              {sec.content}
                            </ReactMarkdown>
                          </Card>
                        ))}
                      </Space>
                    );
                  }
                  return (
                    <ReactMarkdown rehypePlugins={[rehypeHighlight]}>
                      {text}
                    </ReactMarkdown>
                  );
                })()}
              </div>
            </div>
          )}
        </div>
      ),
    });
  }

  // 无内容但有选中节点
  if (tabItems.length === 0) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%' }}>
        <Empty
          image={Empty.PRESENTED_IMAGE_SIMPLE}
          description={
            <Text type="secondary" style={{ fontSize: 13 }}>
              {selectedSection
                ? `已选中「${selectedSection.title}」，点击右侧"生成大纲"或"生成正文"开始创作`
                : selectedChapter
                  ? `已选中「${selectedChapter.title}」，点击右侧"生成大纲"开始创作`
                  : '在左侧目录树中选择章节或小节'}
            </Text>
          }
        />
      </div>
    );
  }

  return (
    <div style={{ height: '100%', overflow: 'auto', padding: '12px 16px' }}>
      <Tabs
        items={tabItems}
        defaultActiveKey={currentResult ? 'content' : 'outline'}
        size="small"
      />
      <style jsx global>{`
        .preview-markdown p { margin: 0 0 12px; line-height: 1.8; }
        .preview-markdown p:last-child { margin-bottom: 0; }
        .preview-markdown h1, .preview-markdown h2, .preview-markdown h3 {
          margin: 16px 0 8px; font-weight: 600;
        }
        .preview-markdown pre { background: #f6f8fa; padding: 12px; border-radius: 6px; overflow-x: auto; }
        .preview-markdown code { font-size: 13px; }
        .preview-markdown ul, .preview-markdown ol { padding-left: 24px; margin: 8px 0; }
        .preview-markdown li { margin-bottom: 4px; line-height: 1.7; }
        .preview-markdown blockquote {
          border-left: 3px solid #1677ff; padding-left: 12px;
          margin: 8px 0; color: #666;
        }
      `}</style>
    </div>
  );
}
