'use client';

import React from 'react';
import ReactMarkdown from 'react-markdown';
import rehypeHighlight from 'rehype-highlight';
import DirectoryResultCard from './DirectoryResultCard';
import OutlineResultCard from './OutlineResultCard';
import { MessageRole, MessageType, NodeType } from '@/types';
import type { Message, DirectoryNode } from '@/types';
import { parseJsonSafely } from './useJsonFix';
import { parseOutlineContent } from '@/utils/outline';
import { normalizeGeneratedContent } from '@/utils/content';

const messageTypeLabels: Record<string, { label: string; color: string }> = {
  [MessageType.DIRECTORY]: { label: '目录', color: 'purple' },
  [MessageType.OUTLINE]: { label: '大纲', color: 'blue' },
  [MessageType.CONTENT]: { label: '正文', color: 'green' },
  [MessageType.CHAT]: { label: '对话', color: 'default' },
};

interface MessageItemProps {
  msg: Message;
  directoryNodes: DirectoryNode[];
}

function formatAssistantContent(
  content: string,
  messageType: string,
  directoryNodes: DirectoryNode[],
): React.ReactNode {
  if (messageType === MessageType.DIRECTORY) {
    if (directoryNodes.length > 0) {
      return <DirectoryResultCard nodes={directoryNodes} />;
    }
    try {
      const parsed = parseJsonSafely<{ chapters?: Array<{ key: string; title: string; material_support?: string; sections?: Array<{ key: string; title: string; material_support?: string }> }> }>(content);
      const fallbackNodes: DirectoryNode[] = [];
      parsed.chapters?.forEach((ch, ci) => {
        fallbackNodes.push({ node_id: ch.key, parent_node_id: null, node_type: NodeType.CHAPTER, order_index: ci, title: ch.title });
        ch.sections?.forEach((sec, si) => {
          fallbackNodes.push({ node_id: sec.key, parent_node_id: ch.key, node_type: NodeType.SECTION, order_index: si, title: sec.title });
        });
      });
      if (fallbackNodes.length > 0) return <DirectoryResultCard nodes={fallbackNodes} />;
    } catch { /* ignore */ }
    return <span style={{ color: '#52c41a' }}>目录已生成，请查看左侧目录树</span>;
  }

  if (messageType === MessageType.OUTLINE) {
    try {
      const outlineContent = parseOutlineContent(content);
      return <OutlineResultCard content={outlineContent} />;
    } catch { /* ignore */ }
    return <span style={{ color: '#52c41a' }}>大纲已生成，请查看上方预览区</span>;
  }

  if (messageType === MessageType.CONTENT) {
    const cleaned = normalizeGeneratedContent(
      content
        .replace(/<!--\s*paragraph_key:\s*p\d+\s*-->/g, '')
        .replace(/<!--\s*citations:\s*p\d+\s*-->[\s\S]*?(?=<!--\s*paragraph_key|$)/g, '')
        .trim(),
    );
    return (
      <div className="chat-markdown" style={{ lineHeight: 1.6 }}>
        <ReactMarkdown rehypePlugins={[rehypeHighlight]}>{cleaned}</ReactMarkdown>
      </div>
    );
  }

  return (
    <div className="chat-markdown" style={{ lineHeight: 1.6 }}>
      <ReactMarkdown rehypePlugins={[rehypeHighlight]}>{content}</ReactMarkdown>
    </div>
  );
}

export default function MessageItem({ msg, directoryNodes }: MessageItemProps) {
  const isUser = msg.role === MessageRole.USER;
  const typeInfo = messageTypeLabels[msg.message_type] ?? messageTypeLabels[MessageType.CHAT];

  return (
    <div
      style={{
        display: 'flex',
        justifyContent: isUser ? 'flex-end' : 'flex-start',
        marginBottom: 10,
      }}
    >
      <div
        style={{
          maxWidth: '88%',
          padding: '9px 13px',
          borderRadius: isUser ? '10px 10px 3px 10px' : '10px 10px 10px 3px',
          background: isUser ? '#2563EB' : '#FFFFFF',
          color: isUser ? '#FFFFFF' : '#192877',
          fontSize: 13,
          lineHeight: 1.6,
        }}
      >
        {!isUser && msg.message_type !== MessageType.CHAT && (
          <div
            style={{
              display: 'inline-flex', alignItems: 'center',
              fontSize: 10, fontWeight: 600, letterSpacing: '0.04em',
              color: typeInfo.color === 'purple' ? '#7C3AED'
                : typeInfo.color === 'blue' ? '#2563EB'
                : typeInfo.color === 'green' ? '#059669' : '#64748B',
              background: typeInfo.color === 'purple' ? '#F5F3FF'
                : typeInfo.color === 'blue' ? '#EFF6FF'
                : typeInfo.color === 'green' ? '#ECFDF5' : '#F1F5F9',
              padding: '2px 6px', borderRadius: 3,
              marginBottom: 7,
            }}
          >
            {typeInfo.label}
          </div>
        )}
        {isUser ? (
          <div style={{ whiteSpace: 'pre-wrap' }}>{msg.content}</div>
        ) : (
          formatAssistantContent(msg.content, msg.message_type, directoryNodes)
        )}
      </div>
    </div>
  );
}
