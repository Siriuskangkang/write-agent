'use client';

import { Alert, Button, Space } from 'antd';
import type { WorkflowRuntime } from '../types';

interface WorkflowStatusPanelProps {
  runtime: WorkflowRuntime | undefined;
  onApprove: () => void;
  onCancel: () => void;
  onResume: () => void;
  onDismiss: () => void;
}

export function WorkflowStatusPanel({
  runtime,
  onApprove,
  onCancel,
  onResume,
  onDismiss,
}: WorkflowStatusPanelProps) {
  if (!runtime) return null;
  const pending = runtime.actionPending !== null;

  if (runtime.job.status === 'WAITING_APPROVAL') {
    return (
      <div style={{ padding: '8px 12px 0', background: '#FFFFFF' }}>
        <Alert
          type="info"
          showIcon
          message="内容提案等待批准"
          description={
            <>
              <div style={{ fontSize: 12, marginBottom: 8 }}>
                以下内容来自服务端密封提案；批准后才会创建并切换当前版本。
              </div>
              <ProposalPreview payload={runtime.proposal?.payload} />
            </>
          }
          action={
            <Space direction="vertical" size={4}>
              <Button
                type="primary"
                size="small"
                loading={runtime.actionPending === 'approve'}
                disabled={pending}
                onClick={onApprove}
              >
                批准并保存
              </Button>
              <Button
                danger
                size="small"
                loading={runtime.actionPending === 'cancel'}
                disabled={pending}
                onClick={onCancel}
              >
                取消
              </Button>
            </Space>
          }
        />
      </div>
    );
  }

  if (runtime.job.status === 'WAITING_MATERIAL') {
    return (
      <div style={{ padding: '8px 12px 0', background: '#FFFFFF' }}>
        <Alert
          type="warning"
          showIcon
          message="素材不足，任务已暂停"
          description={
            runtime.job.error?.message ??
            '请补充与当前章节相关的素材，解析完成后再继续。'
          }
          action={
            <Space direction="vertical" size={4}>
              <Button
                size="small"
                type="primary"
                loading={runtime.actionPending === 'resume'}
                disabled={pending}
                onClick={onResume}
              >
                使用最新素材重试
              </Button>
              <Button
                danger
                size="small"
                loading={runtime.actionPending === 'cancel'}
                disabled={pending}
                onClick={onCancel}
              >
                取消
              </Button>
            </Space>
          }
        />
      </div>
    );
  }

  if (runtime.job.status === 'FAILED') {
    return (
      <div style={{ padding: '8px 12px 0', background: '#FFFFFF' }}>
        <Alert
          type="error"
          showIcon
          closable
          onClose={onDismiss}
          message="生成失败"
          description={
            runtime.job.error?.message ?? '任务执行失败，请稍后重试'
          }
        />
      </div>
    );
  }

  if (runtime.job.status === 'STOPPED') {
    return (
      <div style={{ padding: '8px 12px 0', background: '#FFFFFF' }}>
        <Alert
          type="info"
          showIcon
          closable
          onClose={onDismiss}
          message="任务已停止"
        />
      </div>
    );
  }

  return null;
}

function ProposalPreview({ payload }: { payload: unknown }) {
  if (payload === undefined || payload === null) {
    return <span style={{ color: '#64748B' }}>正在加载提案预览…</span>;
  }
  const text =
    typeof payload === 'string' ? payload : JSON.stringify(payload, null, 2);
  return (
    <pre
      style={{
        maxHeight: 180,
        overflow: 'auto',
        margin: 0,
        padding: 8,
        borderRadius: 6,
        background: '#F8FAFC',
        color: '#334155',
        fontSize: 11,
        lineHeight: 1.55,
        whiteSpace: 'pre-wrap',
      }}
    >
      {text}
    </pre>
  );
}
