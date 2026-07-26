'use client';

import { Input, Button, message } from 'antd';
import { useState } from 'react';
import { analyzeTextStyleTemplate } from '@/services/styleTemplateApi';

interface StyleTemplateInputProps {
  projectId: string;
  onUploadSuccess: (templateId: string) => void;
  onUploadError: (error: string) => void;
}

export function StyleTemplateUpload({ projectId, onUploadSuccess, onUploadError }: StyleTemplateInputProps) {
  const [textContent, setTextContent] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const handleAnalyze = async () => {
    if (!textContent.trim()) return;
    setSubmitting(true);
    try {
      const template = await analyzeTextStyleTemplate(projectId, textContent.trim());
      message.success('已开始分析体例');
      onUploadSuccess(template.id);
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : '提交失败';
      message.error(errorMsg);
      onUploadError(errorMsg);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <Input.TextArea
        value={textContent}
        onChange={(e) => setTextContent(e.target.value)}
        placeholder="将体例内容粘贴到此处，AI 将自动分析目录体例、大纲体例和正文体例…"
        rows={12}
        style={{ resize: 'vertical' }}
        disabled={submitting}
      />
      <Button
        type="primary"
        onClick={handleAnalyze}
        loading={submitting}
        disabled={!textContent.trim()}
      >
        开始分析
      </Button>
    </div>
  );
}
