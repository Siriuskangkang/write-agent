'use client';

import { Button, Typography, Empty, List, Tag, Alert } from 'antd';
import { CloseOutlined, FileTextOutlined, WarningOutlined } from '@ant-design/icons';
import { useEditorStore } from '@/stores/editorStore';
import type { Citation, CitationUseType } from '@/types';
import { formatCitationReference } from '@/utils/citation';

const { Text, Paragraph } = Typography;

const useTypeLabels: Record<string, { label: string; color: string }> = {
  rewrite: { label: '改写', color: 'blue' },
  summarize: { label: '摘要', color: 'green' },
  synthesize: { label: '综合', color: 'purple' },
  transition: { label: '过渡', color: 'orange' },
  unsupported: { label: '未支持', color: 'red' },
};

function ConfidenceBar({ score }: { score: number }) {
  const percent = Math.round(score * 100);
  const color = percent >= 80 ? '#52c41a' : percent >= 50 ? '#faad14' : '#ff4d4f';
  return (
    <div style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
      <div style={{ width: 48, height: 4, background: '#f0f0f0', borderRadius: 2, overflow: 'hidden' }}>
        <div style={{ width: `${percent}%`, height: '100%', background: color, borderRadius: 2 }} />
      </div>
      <Text type="secondary" style={{ fontSize: 11 }}>{percent}%</Text>
    </div>
  );
}

interface CitationPanelProps {
  onClose: () => void;
}

export default function CitationPanel({ onClose }: CitationPanelProps) {
  const { citations } = useEditorStore();

  const hasLowConfidence = citations.some((c) => c.confidence_score < 0.5);
  const unsupportedCount = citations.filter((c) => c.use_type === 'unsupported').length;
  const showWarning = hasLowConfidence || unsupportedCount > 0;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          padding: '16px',
          borderBottom: '1px solid #F1F5F9',
        }}
      >
        <Text strong style={{ fontSize: 15 }}>引用来源</Text>
        <Button type="text" icon={<CloseOutlined />} size="small" onClick={onClose} />
      </div>

      {showWarning && (
        <Alert
          type="warning"
          icon={<WarningOutlined />}
          showIcon
          banner
          message={
            <span style={{ fontSize: 12 }}>
              {hasLowConfidence && '部分引用置信度较低，建议补充素材'}
              {hasLowConfidence && unsupportedCount > 0 && '；'}
              {unsupportedCount > 0 && `${unsupportedCount} 处内容缺少素材支撑`}
            </span>
          }
        />
      )}

      <div style={{ flex: 1, overflow: 'auto', padding: '8px 0' }}>
        {citations.length === 0 ? (
          <Empty
            image={Empty.PRESENTED_IMAGE_SIMPLE}
            description="暂无引用"
            style={{ padding: '40px 0' }}
          />
        ) : (
          <List
            dataSource={citations}
            renderItem={(item: Citation, index) => {
              const typeInfo = useTypeLabels[item.use_type as CitationUseType] ?? useTypeLabels.unsupported;
              return (
                <List.Item style={{ padding: '12px 16px' }}>
                  <div style={{ width: '100%' }}>
                    <div style={{
                      fontSize: 12, color: '#1e3a5f', fontStyle: 'italic',
                      background: '#EFF6FF', borderRadius: 4,
                      padding: '4px 8px', marginBottom: 8,
                      borderLeft: '3px solid #2563EB',
                    }}>
                      [{index + 1}] {formatCitationReference(item)}
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6, flexWrap: 'wrap' }}>
                      <FileTextOutlined style={{ color: '#1677ff' }} />
                      <Text strong style={{ fontSize: 13 }}>{item.file_name}</Text>
                      {item.page_number != null && (
                        <Text type="secondary" style={{ fontSize: 12 }}>
                          p.{item.page_number}
                        </Text>
                      )}
                      <Tag color={typeInfo.color} style={{ margin: 0, fontSize: 11 }}>
                        {typeInfo.label}
                      </Tag>
                      <ConfidenceBar score={item.confidence_score} />
                    </div>
                    {item.section_title && (
                      <Text type="secondary" style={{ fontSize: 12, display: 'block', marginBottom: 4 }}>
                        {item.section_title}
                      </Text>
                    )}
                    {item.evidence_text && (
                      <Paragraph
                        ellipsis={{ rows: 3, expandable: true, symbol: '展开' }}
                        style={{
                          margin: 0,
                          fontSize: 12,
                          lineHeight: 1.6,
                          background: '#fafafa',
                          padding: '6px 10px',
                          borderRadius: 4,
                          borderLeft: '3px solid #1677ff',
                          color: '#666',
                        }}
                      >
                        {item.evidence_text}
                      </Paragraph>
                    )}
                  </div>
                </List.Item>
              );
            }}
          />
        )}
      </div>
    </div>
  );
}
