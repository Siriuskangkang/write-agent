'use client';

import { useEffect, useRef, useState } from 'react';
import { Modal, Form, Radio, Checkbox, Progress, message } from 'antd';
import { useEditorStore } from '@/stores/editorStore';
import { ExportFormat, ExportScope, NodeType } from '@/types';
import api from '@/services/api';
import type { ApiResponse, ExportJob } from '@/types';

interface ExportModalProps {
  projectId: string;
  open: boolean;
  onClose: () => void;
}

export default function ExportModal({ projectId, open, onClose }: ExportModalProps) {
  const { directoryNodes } = useEditorStore();
  const [form] = Form.useForm();
  const [exporting, setExporting] = useState(false);
  const [progress, setProgress] = useState(0);
  const pollTimerRef = useRef<number | null>(null);

  const chapters = directoryNodes
    .filter((n) => n.node_type === NodeType.CHAPTER)
    .sort((a, b) => a.order_index - b.order_index);

  const handleExport = async () => {
    try {
      const values = await form.validateFields();
      setExporting(true);
      setProgress(10);

      const res = await api
        .post(`projects/${projectId}/export`, {
          json: {
            format: values.format,
            scope: values.scope,
            chapter_ids: values.scope === ExportScope.CHAPTERS ? values.chapterIds : undefined,
            include_citations: values.includeCitations,
          },
        })
        .json<ApiResponse<ExportJob>>();

      if (!res.success) {
        message.error(res.message ?? '导出失败');
        setExporting(false);
        return;
      }

      const jobId = res.data.id;
      let attempts = 0;

      const poll = async () => {
        attempts++;
        const statusRes = await api
          .get(`projects/${projectId}/export/${jobId}`)
          .json<ApiResponse<ExportJob>>();

        if (!statusRes.success) {
          message.error(statusRes.message ?? '查询导出状态失败');
          setExporting(false);
          return;
        }

        if (statusRes.data.status === 'completed' && statusRes.data.download_url) {
          setProgress(100);
          const link = document.createElement('a');
          link.href = statusRes.data.download_url;
          link.download = '';
          document.body.appendChild(link);
          link.click();
          document.body.removeChild(link);
          message.success('导出完成，已开始下载');
          setExporting(false);
          onClose();
        } else if (statusRes.data.status === 'failed') {
          message.error(statusRes.data.error_message ?? '导出失败，请重试');
          setExporting(false);
        } else if (attempts > 60) {
          message.error('导出超时，请稍后重试');
          setExporting(false);
        } else {
          setProgress(Math.min(90, 10 + attempts * 3));
          pollTimerRef.current = window.setTimeout(() => {
            void poll();
          }, 2000);
        }
      };

      pollTimerRef.current = window.setTimeout(() => {
        void poll();
      }, 1000);
    } catch {
      setExporting(false);
    }
  };

  useEffect(() => {
    return () => {
      if (pollTimerRef.current != null) {
        window.clearTimeout(pollTimerRef.current);
      }
    };
  }, []);

  const handleCancel = () => {
    if (pollTimerRef.current != null) {
      window.clearTimeout(pollTimerRef.current);
      pollTimerRef.current = null;
    }
    setExporting(false);
    setProgress(0);
    onClose();
  };

  return (
    <Modal
      title="导出教材"
      open={open}
      onOk={handleExport}
      onCancel={handleCancel}
      confirmLoading={exporting}
      okText="开始导出"
      cancelText="取消"
      destroyOnClose
    >
      <Form
        form={form}
        layout="vertical"
        initialValues={{
          format: ExportFormat.DOCX,
          scope: ExportScope.FULL,
          includeCitations: true,
        }}
      >
        <Form.Item label="导出格式" name="format">
          <Radio.Group>
            <Radio value={ExportFormat.DOCX}>Word (.docx)</Radio>
            <Radio value={ExportFormat.MARKDOWN}>Markdown (.md)</Radio>
          </Radio.Group>
        </Form.Item>

        <Form.Item label="导出范围" name="scope">
          <Radio.Group>
            <Radio value={ExportScope.FULL}>全书</Radio>
            <Radio value={ExportScope.CHAPTERS}>指定章节</Radio>
          </Radio.Group>
        </Form.Item>

        <Form.Item noStyle shouldUpdate={(prev, cur) => prev.scope !== cur.scope}>
          {({ getFieldValue }) =>
            getFieldValue('scope') === ExportScope.CHAPTERS ? (
              <Form.Item
                name="chapterIds"
                label="选择章节"
                rules={[{ required: true, message: '请至少选择一个章节' }]}
              >
                <Checkbox.Group
                  options={chapters.map((ch) => ({
                    label: ch.title,
                    value: ch.node_id,
                  }))}
                  style={{ display: 'flex', flexDirection: 'column', gap: 8 }}
                />
              </Form.Item>
            ) : null
          }
        </Form.Item>

        <Form.Item name="includeCitations" valuePropName="checked">
          <Checkbox>包含引用清单</Checkbox>
        </Form.Item>
      </Form>

      {exporting && <Progress percent={progress} status="active" style={{ marginTop: 8 }} />}
    </Modal>
  );
}
