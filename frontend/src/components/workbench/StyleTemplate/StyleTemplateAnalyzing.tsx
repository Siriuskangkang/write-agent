'use client';

import { Card, Progress, Spin, Typography } from 'antd';
import { useEffect } from 'react';
import { useStyleTemplateSSE } from '@/hooks/useStyleTemplateSSE';
import type { StyleTemplateAnalysisResult } from './types';

const { Text } = Typography;

interface StyleTemplateAnalyzingProps {
  templateId: string;
  projectId: string;
  onAnalysisComplete: (result: StyleTemplateAnalysisResult) => void;
  onAnalysisError: (error: string) => void;
}

export function StyleTemplateAnalyzing({
  templateId,
  projectId,
  onAnalysisComplete,
  onAnalysisError
}: StyleTemplateAnalyzingProps) {
  const { progress, status, result, error, startAnalysis } = useStyleTemplateSSE();

  useEffect(() => {
    startAnalysis(templateId, projectId);
  }, [templateId, projectId, startAnalysis]);

  useEffect(() => {
    if (status === 'done' && result) {
      onAnalysisComplete(result);
    }
    if (status === 'error' && error) {
      console.error('[StyleTemplateAnalyzing] 分析失败:', error);
      onAnalysisError(error);
    }
  }, [status, result, error, onAnalysisComplete, onAnalysisError]);

  return (
    <Card>
      <div style={{ textAlign: 'center', padding: '40px 0' }}>
        <Spin size="large" />
        <div style={{ marginTop: 24 }}>
          <Text strong>
            {progress < 55 ? '第 1 步：识别体例结构...' : '第 2 步：提炼编写要求...'}
          </Text>
        </div>
        <Progress
          percent={progress}
          status="active"
          style={{ marginTop: 16, maxWidth: 400, margin: '16px auto 0' }}
        />
      </div>
    </Card>
  );
}
