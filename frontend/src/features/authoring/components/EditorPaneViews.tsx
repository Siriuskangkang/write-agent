'use client';

import { Card, Collapse, Space, Tag, Typography } from 'antd';
import {
  CheckOutlined,
  CloseOutlined,
  EditOutlined,
  FileSearchOutlined,
} from '@ant-design/icons';
import ReactMarkdown from 'react-markdown';
import rehypeHighlight from 'rehype-highlight';
import { useEditorStore } from '@/stores/editorStore';
import { formatCitationReference } from '@/utils/citation';
import { normalizeGeneratedContent } from '@/utils/content';

const { Text } = Typography;

export function PaneHeader({
  title,
  icon,
  wordCount,
  onEdit,
  editing,
  onSave,
  onCancel,
}: {
  title: string;
  icon: React.ReactNode;
  wordCount?: number | null;
  onEdit?: () => void;
  editing?: boolean;
  onSave?: () => void;
  onCancel?: () => void;
}) {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        padding: '10px 16px 8px',
        background: '#FFFFFF',
        flexShrink: 0,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <span style={{ color: '#2563EB', fontSize: 13 }}>{icon}</span>
        <span
          style={{
            fontSize: 12,
            fontWeight: 600,
            color: '#192877',
            letterSpacing: '0.01em',
          }}
        >
          {title}
        </span>
        {wordCount != null && (
          <span
            style={{
              fontSize: 11,
              color: '#94A3B8',
              background: '#F1F5F9',
              padding: '1px 6px',
              borderRadius: 3,
              fontVariantNumeric: 'tabular-nums',
            }}
          >
            {wordCount} 字
          </span>
        )}
      </div>
      {editing ? (
        <Space size={4}>
          <button onClick={onSave} style={actionButton('#10B981', '#ECFDF5')}>
            <CheckOutlined style={{ fontSize: 11 }} /> 保存
          </button>
          <button onClick={onCancel} style={actionButton('#64748B', '#F1F5F9')}>
            <CloseOutlined style={{ fontSize: 11 }} /> 取消
          </button>
        </Space>
      ) : onEdit ? (
        <button onClick={onEdit} style={actionButton('#2563EB', '#EFF6FF')}>
          <EditOutlined style={{ fontSize: 11 }} /> 编辑
        </button>
      ) : null}
    </div>
  );
}

interface ContentBlock {
  key: string;
  body: string;
  citations: Array<{ id: string; useType: string; description: string }>;
}

function parseContentBlocks(raw: string): ContentBlock[] {
  const blocks: ContentBlock[] = [];
  const parts = raw.split(/<!--\s*paragraph_key:\s*(p\d+)\s*-->/);
  for (let index = 1; index < parts.length; index += 2) {
    const key = parts[index];
    let body = parts[index + 1] ?? '';
    const citations: ContentBlock['citations'] = [];
    const citationMatch = body.match(
      /<!--\s*citations:\s*p\d+\s*-->([\s\S]*?)$/,
    );
    if (citationMatch) {
      body = body.slice(0, citationMatch.index).trimEnd();
      for (const line of citationMatch[1].split('\n').filter((item) => item.trim())) {
        const match = line.match(
          /\[([^\]]+)\]\(use_type:\s*([^)]+)\)\s*(.*)/,
        );
        if (match) {
          citations.push({
            id: match[1],
            useType: match[2].trim(),
            description: match[3].trim(),
          });
        }
      }
    }
    blocks.push({ key, body: body.trim(), citations });
  }
  if (blocks.length === 0 && raw.trim()) {
    blocks.push({
      key: 'p0',
      body: raw
        .replace(
          /<!--\s*citations:\s*p\d+\s*-->[\s\S]*?(?=<!--\s*paragraph_key|$)/g,
          '',
        )
        .trim(),
      citations: [],
    });
  }
  return blocks;
}

const useTypeLabels: Record<string, string> = {
  rewrite: '改写',
  summarize: '概括',
  synthesize: '综合',
};

export function ContentRenderer({ text }: { text: string }) {
  const citations = useEditorStore((state) => state.citations);
  const normalizedText = normalizeGeneratedContent(text);
  const columnParts = normalizedText.split(/<!-- column:(.*?) -->/);
  if (columnParts.length > 1) {
    const sections: Array<{ column: string; content: string }> = [];
    for (let index = 1; index < columnParts.length; index += 2) {
      sections.push({
        column: columnParts[index].trim(),
        content: columnParts[index + 1]?.trim() || '',
      });
    }
    return (
      <Space direction="vertical" style={{ width: '100%' }} size={12}>
        {sections.map((section) => (
          <Card
            key={section.column}
            size="small"
            title={<Tag color="blue" style={{ margin: 0 }}>{section.column}</Tag>}
          >
            <div className="preview-markdown">
              <ReactMarkdown rehypePlugins={[rehypeHighlight]}>
                {section.content}
              </ReactMarkdown>
            </div>
          </Card>
        ))}
      </Space>
    );
  }

  const blocks = parseContentBlocks(normalizedText);
  if (
    blocks.length === 1 &&
    blocks[0].key === 'p0' &&
    blocks[0].citations.length === 0
  ) {
    return (
      <div className="preview-markdown">
        <ReactMarkdown rehypePlugins={[rehypeHighlight]}>
          {normalizedText}
        </ReactMarkdown>
      </div>
    );
  }

  return (
    <div className="preview-markdown">
      {blocks.map((block) => (
        <div key={block.key} style={{ marginBottom: 4 }}>
          <ReactMarkdown rehypePlugins={[rehypeHighlight]}>
            {block.body}
          </ReactMarkdown>
          {block.citations.length > 0 && (
            <Collapse
              size="small"
              ghost
              items={[
                {
                  key: block.key,
                  label: (
                    <span
                      style={{
                        fontSize: 11,
                        color: '#64748B',
                        display: 'inline-flex',
                        alignItems: 'center',
                        gap: 4,
                      }}
                    >
                      <FileSearchOutlined
                        style={{ fontSize: 11, color: '#2563EB' }}
                      />
                      {block.citations.length} 条引用来源
                    </span>
                  ),
                  children: (
                    <div
                      style={{
                        display: 'flex',
                        flexDirection: 'column',
                        gap: 6,
                      }}
                    >
                      {block.citations.map((citation, index) => {
                        const matched =
                          citations.find(
                            (item) =>
                              item.paragraph_key === block.key &&
                              item.chunk_id === citation.id,
                          ) ??
                          citations.find(
                            (item) =>
                              item.paragraph_key === block.key &&
                              item.reference_text,
                          );
                        return (
                          <div
                            key={`${citation.id}-${index}`}
                            style={{
                              fontSize: 11,
                              lineHeight: 1.6,
                              color: '#475569',
                              padding: '6px 10px',
                              background: '#F8FAFC',
                              borderRadius: 6,
                              borderLeft: '3px solid #2563EB',
                            }}
                          >
                            <span
                              style={{
                                display: 'inline-block',
                                fontSize: 10,
                                fontWeight: 600,
                                color: '#2563EB',
                                background: '#EFF6FF',
                                padding: '1px 5px',
                                borderRadius: 3,
                                marginRight: 6,
                              }}
                            >
                              {useTypeLabels[citation.useType] ??
                                citation.useType}
                            </span>
                            {citation.description && (
                              <span style={{ color: '#64748B' }}>
                                {citation.description}
                              </span>
                            )}
                            <div
                              style={{
                                marginTop: 4,
                                fontSize: 10,
                                fontStyle: 'italic',
                                color: '#475569',
                              }}
                            >
                              [{index + 1}]{' '}
                              {matched
                                ? formatCitationReference(matched)
                                : citation.id.replace(/[_-]/g, ' ')}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  ),
                },
              ]}
              style={{ marginTop: -4, marginBottom: 4 }}
            />
          )}
        </div>
      ))}
    </div>
  );
}

export function EmptyPane({
  icon,
  title,
  desc,
}: {
  icon: React.ReactNode;
  title: string;
  desc: string;
}) {
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'stretch',
        justifyContent: 'stretch',
        flex: 1,
        width: '100%',
        minWidth: '100%',
        height: '100%',
        minHeight: '100%',
        alignSelf: 'stretch',
      }}
    >
      <div
        style={{
          flex: 1,
          width: '100%',
          minWidth: '100%',
          height: '100%',
          boxSizing: 'border-box',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 10,
          padding: '24px 20px',
          borderRadius: 16,
          background: 'linear-gradient(180deg, #FAFCFF 0%, #F8FAFC 100%)',
        }}
      >
        <div
          style={{
            width: 44,
            height: 44,
            borderRadius: 10,
            background: '#EFF6FF',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          {icon}
        </div>
        <div style={{ textAlign: 'center' }}>
          <div
            style={{
              fontSize: 13,
              fontWeight: 600,
              color: '#192877',
              marginBottom: 3,
            }}
          >
            {title}
          </div>
          <Text type="secondary" style={{ fontSize: 12 }}>
            {desc}
          </Text>
        </div>
      </div>
    </div>
  );
}

function actionButton(color: string, background: string): React.CSSProperties {
  return {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 4,
    height: 24,
    padding: '0 8px',
    border: 'none',
    background,
    color,
    borderRadius: 4,
    fontSize: 11,
    fontWeight: 500,
    cursor: 'pointer',
  };
}
