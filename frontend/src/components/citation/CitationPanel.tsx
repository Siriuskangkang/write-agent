'use client';

import { useState } from 'react';
import { Alert, Collapse, Empty, Space, Tag, Typography } from 'antd';
import { FileTextOutlined, WarningOutlined } from '@ant-design/icons';
import { useEditorStore } from '@/stores/editorStore';
import { CitationUseType, type Citation } from '@/types';
import { formatCitationReference } from '@/utils/citation';

const { Text, Paragraph } = Typography;

const useTypeLabels: Record<CitationUseType, { label: string; color: string }> = {
  [CitationUseType.REWRITE]: { label: '改写', color: 'blue' },
  [CitationUseType.SUMMARIZE]: { label: '摘要', color: 'green' },
  [CitationUseType.SYNTHESIZE]: { label: '综合', color: 'purple' },
  [CitationUseType.TRANSITION]: { label: '过渡', color: 'orange' },
  [CitationUseType.UNSUPPORTED]: { label: '无支撑', color: 'red' },
};

function ConfidenceBar({ score }: { score: number }) {
  const percent = Math.round(score * 100);
  const color = percent >= 80 ? '#52c41a' : percent >= 50 ? '#faad14' : '#ff4d4f';
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
      <div style={{ width: 60, height: 6, background: '#f0f0f0', borderRadius: 3, overflow: 'hidden' }}>
        <div style={{ width: `${percent}%`, height: '100%', background: color, borderRadius: 3 }} />
      </div>
      <Text type="secondary" style={{ fontSize: 12 }}>{percent}%</Text>
    </div>
  );
}

export default function CitationPanel() {
  const { citations } = useEditorStore();
  const [expandedKeys, setExpandedKeys] = useState<string[]>([]);

  const hasLowConfidence = citations.some((c) => c.confidence_score < 0.5);
  const unsupportedCount = citations.filter((c) => c.use_type === CitationUseType.UNSUPPORTED).length;
  const showWarning = hasLowConfidence || unsupportedCount > 0;

  if (citations.length === 0) {
    return (
      <div style={{ padding: 24, textAlign: 'center' }}>
        <Empty description="暂无引用信息" image={Empty.PRESENTED_IMAGE_SIMPLE} />
      </div>
    );
  }

  const items = citations.map((citation) => {
    const typeInfo = useTypeLabels[citation.use_type] ?? { label: citation.use_type, color: 'default' };
    return {
      key: citation.id,
      label: (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <FileTextOutlined style={{ color: '#1677ff' }} />
          <Text strong style={{ fontSize: 13 }}>{citation.file_name}</Text>
          {citation.page_number != null && (
            <Text type="secondary" style={{ fontSize: 12 }}>p.{citation.page_number}</Text>
          )}
          <Tag color={typeInfo.color}>{typeInfo.label}</Tag>
          <ConfidenceBar score={citation.confidence_score} />
        </div>
      ),
      children: (
        <div>
          <Paragraph strong style={{ fontSize: 12, marginBottom: 8 }}>
            {formatCitationReference(citation)}
          </Paragraph>
          {citation.section_title && (
            <Paragraph type="secondary" style={{ fontSize: 12, marginBottom: 4 }}>
              章节：{citation.section_title}
            </Paragraph>
          )}
          {citation.evidence_text ? (
            <Paragraph
              style={{
                fontSize: 13,
                background: '#fafafa',
                padding: '8px 12px',
                borderRadius: 6,
                borderLeft: '3px solid #1677ff',
                margin: 0,
              }}
            >
              {citation.evidence_text}
            </Paragraph>
          ) : (
            <Text type="secondary" style={{ fontSize: 12 }}>暂无原文片段</Text>
          )}
        </div>
      ),
    };
  });

  return (
    <div style={{ height: '100%', overflow: 'auto', padding: '12px 0' }}>
      {showWarning && (
        <Alert
          type="warning"
          icon={<WarningOutlined />}
          message={
            <Space direction="vertical" size={0}>
              {hasLowConfidence && <Text style={{ fontSize: 12 }}>部分引用置信度较低，建议补充素材</Text>}
              {unsupportedCount > 0 && (
                <Text style={{ fontSize: 12 }}>{unsupportedCount} 处内容缺少素材支撑</Text>
              )}
            </Space>
          }
          showIcon
          banner
          style={{ marginBottom: 8 }}
        />
      )}
      <Collapse
        items={items}
        activeKey={expandedKeys}
        onChange={(keys) => setExpandedKeys(keys as string[])}
        ghost
        size="small"
      />
    </div>
  );
}
