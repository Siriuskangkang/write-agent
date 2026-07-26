'use client';

import { CloseOutlined, FileTextOutlined, BookOutlined } from '@ant-design/icons';
import { Typography } from 'antd';
import { useEditorStore } from '@/stores/editorStore';
import { NodeType } from '@/types';
import EditorPane from './EditorPane';

const { Text } = Typography;

interface EditorTabsProps {
  projectId: string;
}

export default function EditorTabs({ projectId }: EditorTabsProps) {
  const { tabs, activeTabId, removeTab, setActiveTab } = useEditorStore();

  if (tabs.length === 0) {
    return (
      <div style={{
        display: 'flex', flexDirection: 'column',
        alignItems: 'center', justifyContent: 'center',
        height: '100%', background: '#F8FAFC', gap: 12,
      }}>
        <div style={{
          width: 48, height: 48, borderRadius: 10,
          background: '#EFF6FF',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
        }}>
          <BookOutlined style={{ fontSize: 20, color: '#2563EB' }} />
        </div>
        <div style={{ textAlign: 'center' }}>
          <div style={{ fontSize: 14, fontWeight: 600, color: '#192877', marginBottom: 4 }}>
            选择章节开始编辑
          </div>
          <Text type="secondary" style={{ fontSize: 12 }}>
            在左侧目录树中点击章节或小节
          </Text>
        </div>
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', background: '#F8FAFC' }}>
      {/* Tab 标签栏 */}
      <div className="editor-tabbar">
        {tabs.map((tab) => {
          const isActive = activeTabId === tab.id;
          const Icon = tab.nodeType === NodeType.CHAPTER ? BookOutlined : FileTextOutlined;
          return (
            <div
              key={tab.id}
              className={`editor-tab${isActive ? ' active' : ''}`}
              onClick={() => setActiveTab(tab.id)}
            >
              <Icon style={{ fontSize: 11, opacity: 0.7 }} />
              <span>{tab.title}</span>
              <span
                className="tab-close"
                onClick={(e) => { e.stopPropagation(); removeTab(tab.id); }}
              >
                <CloseOutlined />
              </span>
            </div>
          );
        })}
      </div>

      {/* Tab 内容区 */}
      <div style={{ flex: 1, overflow: 'hidden', position: 'relative' }}>
        {tabs.map((tab) => (
          <div
            key={tab.id}
            style={{
              position: 'absolute', inset: 0,
              display: activeTabId === tab.id ? 'flex' : 'none',
            }}
          >
            <EditorPane projectId={projectId} tab={tab} isActive={activeTabId === tab.id} />
          </div>
        ))}
      </div>
    </div>
  );
}
