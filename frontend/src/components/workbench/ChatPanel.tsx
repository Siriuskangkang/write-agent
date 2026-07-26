'use client';

import React from 'react';
import { Input, Alert } from 'antd';
import { SendOutlined, StopOutlined, FileSearchOutlined, LoadingOutlined } from '@ant-design/icons';
import ReactMarkdown from 'react-markdown';
import rehypeHighlight from 'rehype-highlight';
import { useChatStore } from '@/stores/chatStore';
import { useEditorStore } from '@/stores/editorStore';
import type { Message } from '@/types';
import QuickActions from './QuickActions';
import MessageItem from './MessageItem';
import { useChatOperations } from './useChatOperations';
import { WorkflowStatusPanel } from '@/features/workflows/components/WorkflowStatusPanel';

interface ChatPanelProps {
  projectId: string;
  onShowCitations: () => void;
}

export default function ChatPanel({ projectId, onShowCitations }: ChatPanelProps) {
  const { messages } = useChatStore();
  const { directoryNodes } = useEditorStore();

  const {
    inputValue, setInputValue, currentTaskType, sessionReady, hasParsing,
    streamContent, isStreaming, citations, messagesEndRef,
    handleQuickAction, handleStop, doSend, workflowUi,
  } = useChatOperations(projectId, onShowCitations);
  const workflowBusy =
    workflowUi.runtime !== undefined &&
    workflowUi.runtime.job.status !== 'FAILED' &&
    workflowUi.runtime.job.status !== 'STOPPED';

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void doSend(inputValue.trim()).then(() => setInputValue(''));
    }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', background: '#FFFFFF' }}>
      {/* 顶部标题栏 */}
      <div style={{ padding: '0 16px', height: 44, display: 'flex', alignItems: 'center', flexShrink: 0, gap: 8 }}>
        <div style={{ width: 6, height: 6, borderRadius: '50%', background: sessionReady ? '#10B981' : '#94A3B8' }} />
        <span style={{ fontSize: 12, fontWeight: 600, color: '#192877' }}>AI 助手</span>
        {!sessionReady && <span style={{ fontSize: 11, color: '#94A3B8' }}>初始化中...</span>}
      </div>

      {/* 消息区 */}
      <div style={{ flex: 1, overflow: 'auto', padding: '12px 14px', background: '#F8FAFC' }}>
        {messages.length === 0 && !isStreaming ? (
          <div style={{ display: 'flex', flexDirection: 'column', justifyContent: 'center', alignItems: 'center', height: '100%', gap: 8 }}>
            <div style={{ width: 40, height: 40, borderRadius: 10, background: '#EFF6FF', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              <span style={{ fontSize: 18 }}>✦</span>
            </div>
            <span style={{ fontSize: 12, color: '#94A3B8', textAlign: 'center' }}>
              {sessionReady ? '开始对话，让 AI 帮你编写教材' : '正在初始化工作台...'}
            </span>
          </div>
        ) : (
          <>
            {messages.map((msg: Message) => (
              <MessageItem key={msg.id} msg={msg} directoryNodes={directoryNodes} />
            ))}

            {isStreaming && streamContent && (
              <div style={{ display: 'flex', justifyContent: 'flex-start', marginBottom: 10 }}>
                <div style={{ maxWidth: '88%', padding: '9px 13px', borderRadius: '10px 10px 10px 3px', background: '#FFFFFF', fontSize: 13 }}>
                  {currentTaskType === 'directory' || currentTaskType === 'outline' ? (
                    <div style={{ color: '#64748B', fontSize: 12, display: 'flex', alignItems: 'center', gap: 8 }}>
                      <LoadingOutlined style={{ color: '#2563EB' }} />
                      {currentTaskType === 'directory' ? '正在生成目录结构...' : '正在生成大纲...'}
                    </div>
                  ) : (
                    <div className="chat-markdown" style={{ lineHeight: 1.6 }}>
                      <ReactMarkdown rehypePlugins={[rehypeHighlight]}>{streamContent}</ReactMarkdown>
                      <span className="typing-cursor" />
                    </div>
                  )}
                </div>
              </div>
            )}

            {isStreaming && !streamContent && (
              <div style={{ display: 'flex', justifyContent: 'flex-start', marginBottom: 10 }}>
                <div style={{ padding: '9px 13px', borderRadius: '10px 10px 10px 3px', background: '#FFFFFF', display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, color: '#94A3B8' }}>
                  <LoadingOutlined style={{ color: '#2563EB', fontSize: 12 }} />
                  正在思考...
                </div>
              </div>
            )}
          </>
        )}
        <div ref={messagesEndRef} />
      </div>

      <WorkflowStatusPanel
        runtime={workflowUi.runtime}
        onApprove={() => void workflowUi.approve()}
        onCancel={() => void workflowUi.cancel()}
        onResume={() => void workflowUi.resume()}
        onDismiss={workflowUi.dismiss}
      />

      {/* 引用提示 */}
      {citations.length > 0 && (
        <div onClick={onShowCitations} style={{ padding: '6px 14px', background: '#ECFDF5', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 6, transition: 'background 0.15s' }}
          onMouseEnter={(e) => (e.currentTarget.style.background = '#D1FAE5')}
          onMouseLeave={(e) => (e.currentTarget.style.background = '#ECFDF5')}>
          <FileSearchOutlined style={{ color: '#059669', fontSize: 12 }} />
          <span style={{ fontSize: 12, color: '#065F46', fontWeight: 500 }}>{citations.length} 条引用来源</span>
        </div>
      )}

      {/* 输入区 */}
      <div style={{ padding: '10px 12px 12px', background: '#FFFFFF' }}>
        {hasParsing && (
          <Alert type="warning" message="部分素材仍在解析中，建议等待解析完成后再生成" showIcon style={{ marginBottom: 8, fontSize: 12 }} />
        )}
        <QuickActions onAction={handleQuickAction} disabled={workflowBusy || !sessionReady} />
        <div style={{ display: 'flex', gap: 6, alignItems: 'flex-end' }}>
          <Input.TextArea
            value={inputValue}
            onChange={(e) => setInputValue(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="输入消息，Enter 发送，Shift+Enter 换行"
            autoSize={{ minRows: 1, maxRows: 4 }}
            style={{ borderRadius: 6, fontSize: 13, resize: 'none' }}
            disabled={workflowBusy || !sessionReady}
          />
          {isStreaming ? (
            <button onClick={handleStop} style={{ display: 'flex', alignItems: 'center', gap: 4, height: 30, padding: '0 10px', border: 'none', background: '#FEF2F2', color: '#EF4444', borderRadius: 6, fontSize: 12, fontWeight: 500, cursor: 'pointer', flexShrink: 0, transition: 'background 0.15s' }}
              onMouseEnter={(e) => (e.currentTarget.style.background = '#FEE2E2')}
              onMouseLeave={(e) => (e.currentTarget.style.background = '#FEF2F2')}>
              <StopOutlined style={{ fontSize: 11 }} />停止
            </button>
          ) : (
            <button onClick={() => void doSend(inputValue.trim()).then(() => setInputValue(''))} disabled={!inputValue.trim() || !sessionReady || workflowBusy}
              style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: 30, height: 30, border: 'none', background: !inputValue.trim() || !sessionReady || workflowBusy ? '#E2E8F0' : '#2563EB', color: !inputValue.trim() || !sessionReady || workflowBusy ? '#94A3B8' : '#FFFFFF', borderRadius: 6, cursor: !inputValue.trim() || !sessionReady || workflowBusy ? 'not-allowed' : 'pointer', flexShrink: 0, transition: 'background 0.15s' }}
              onMouseEnter={(e) => { if (inputValue.trim() && sessionReady && !workflowBusy) e.currentTarget.style.background = '#1D4ED8'; }}
              onMouseLeave={(e) => { if (inputValue.trim() && sessionReady && !workflowBusy) e.currentTarget.style.background = '#2563EB'; }}>
              <SendOutlined style={{ fontSize: 13 }} />
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
