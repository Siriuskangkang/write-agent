'use client';

import { useState } from 'react';
import { Segmented } from 'antd';
import { EditOutlined, EyeOutlined, AppstoreOutlined } from '@ant-design/icons';
import dynamic from 'next/dynamic';
import ReactMarkdown from 'react-markdown';
import rehypeHighlight from 'rehype-highlight';
import 'highlight.js/styles/github.css';

const MonacoEditor = dynamic(() => import('./MonacoEditor'), {
  ssr: false,
  loading: () => <div style={{ padding: 32, textAlign: 'center' }}>加载编辑器...</div>,
});

type ViewMode = 'edit' | 'preview' | 'split';

interface MarkdownEditorWithPreviewProps {
  value: string;
  onChange: (value: string) => void;
  height?: string;
}

export default function MarkdownEditorWithPreview({
  value,
  onChange,
  height = 'calc(100vh - 200px)',
}: MarkdownEditorWithPreviewProps) {
  const [viewMode, setViewMode] = useState<ViewMode>('split');

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <div style={{ padding: '8px 0', borderBottom: '1px solid #f0f0f0', marginBottom: 12 }}>
        <Segmented
          value={viewMode}
          onChange={(value) => setViewMode(value as ViewMode)}
          options={[
            { label: '编辑', value: 'edit', icon: <EditOutlined /> },
            { label: '预览', value: 'preview', icon: <EyeOutlined /> },
            { label: '分屏', value: 'split', icon: <AppstoreOutlined /> },
          ]}
        />
      </div>

      <div style={{ flex: 1, display: 'flex', overflow: 'hidden', gap: 12 }}>
        {(viewMode === 'edit' || viewMode === 'split') && (
          <div style={{ flex: viewMode === 'split' ? 1 : undefined, width: viewMode === 'edit' ? '100%' : undefined, overflow: 'hidden' }}>
            <MonacoEditor
              value={value}
              onChange={onChange}
              language="markdown"
              height={height}
            />
          </div>
        )}

        {(viewMode === 'preview' || viewMode === 'split') && (
          <div
            style={{
              flex: viewMode === 'split' ? 1 : undefined,
              width: viewMode === 'preview' ? '100%' : undefined,
              overflow: 'auto',
              padding: '16px 24px',
              background: '#FFFFFF',
              border: '1px solid #e8e8e8',
              borderRadius: 4,
            }}
          >
            <div className="markdown-body">
              <ReactMarkdown rehypePlugins={[rehypeHighlight]}>
                {value || '*暂无内容*'}
              </ReactMarkdown>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
