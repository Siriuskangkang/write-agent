'use client';

import { CheckCircleOutlined, FileTextOutlined, BulbOutlined, BookOutlined, AimOutlined, ReadOutlined } from '@ant-design/icons';
import type { OutlineContent, OutlineSectionItem } from '@/types';

interface OutlineResultCardProps {
  content: OutlineContent;
  chapterTitle?: string;
}

function Section({ icon, title, color, bg, border, children }: {
  icon: React.ReactNode;
  title: string;
  color: string;
  bg: string;
  border: string;
  children: React.ReactNode;
}) {
  return (
    <div style={{
      borderRadius: 6,
      overflow: 'hidden',
      marginBottom: 8,
      background: '#FFFFFF',
    }}>
      <div style={{
        display: 'flex', alignItems: 'center', gap: 6,
        padding: '5px 10px',
        background: bg,
      }}>
        <span style={{ color, fontSize: 12 }}>{icon}</span>
        <span style={{ fontSize: 11, fontWeight: 600, color, letterSpacing: '0.02em' }}>{title}</span>
      </div>
      <div style={{ padding: '8px 10px' }}>
        {children}
      </div>
    </div>
  );
}

function BulletList({ items, color = '#334155' }: { items: string[]; color?: string }) {
  return (
    <ul style={{ margin: 0, paddingLeft: 18, display: 'flex', flexDirection: 'column', gap: 6 }}>
      {items.map((item, idx) => (
        <li key={idx} style={{ fontSize: 12, color, lineHeight: 1.7 }}>{item}</li>
      ))}
    </ul>
  );
}

export default function OutlineResultCard({ content, chapterTitle }: OutlineResultCardProps) {
  // 新格式：有 sections 字段时按栏目卡片展示
  if (content.sections && content.sections.length > 0) {
    return (
      <div style={{ fontSize: 13, display: 'flex', flexDirection: 'column', gap: 12 }}>
        <div style={{
          padding: '14px 16px',
          borderRadius: 14,
          background: 'linear-gradient(135deg, #EFF6FF 0%, #F8FBFF 100%)',
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, fontWeight: 700, color: '#1B74F0', textTransform: 'uppercase', letterSpacing: '0.08em' }}>
            <ReadOutlined />
            Outline Ready
          </div>
          <div style={{ marginTop: 8, fontSize: 18, fontWeight: 800, color: '#192877', lineHeight: 1.35 }}>
            {content.node_title || chapterTitle || '章节大纲'}
          </div>
          {content.level && (
            <div style={{ marginTop: 6, fontSize: 12, color: '#6480A8' }}>
              层级：{content.level}
            </div>
          )}
        </div>

        {content.sections.map((sec: OutlineSectionItem, idx: number) => (
          <div key={idx} style={{
            borderRadius: 6,
            overflow: 'hidden',
            marginBottom: 4,
            background: '#FFFFFF',
          }}>
            <div style={{
              display: 'flex', alignItems: 'center', gap: 6,
              padding: '5px 10px',
              background: '#EFF6FF',
            }}>
              <span style={{ fontSize: 12, fontWeight: 600, color: '#2563EB' }}>{sec.column}</span>
              {!sec.required && (
                <span style={{
                  fontSize: 10, padding: '1px 5px', borderRadius: 4,
                  background: '#FEF3C7', color: '#92400E',
                }}>
                  可选
                </span>
              )}
            </div>
            <div style={{ padding: '8px 10px' }}>
              <div style={{ fontSize: 11, color: '#888', marginBottom: 6, lineHeight: 1.6 }}>
                {sec.writing_guide}
              </div>
              {sec.content_points && sec.content_points.length > 0 && (
                <BulletList items={sec.content_points} color="#334155" />
              )}
              {sec.length_suggestion && (
                <div style={{ fontSize: 11, color: '#aaa', marginTop: 6 }}>
                  篇幅建议：{sec.length_suggestion}
                </div>
              )}
            </div>
          </div>
        ))}

        {content.key_points && content.key_points.length > 0 && (
          <Section icon={<BulbOutlined />} title="重点" color="#D97706" bg="#FFFBEB" border="#FDE68A">
            <BulletList items={content.key_points} color="#334155" />
          </Section>
        )}

        {content.difficulties && content.difficulties.length > 0 && (
          <Section icon={<AimOutlined />} title="难点" color="#DC2626" bg="#FEF2F2" border="#FECACA">
            <BulletList items={content.difficulties} color="#334155" />
          </Section>
        )}

        {content.source_refs && content.source_refs.length > 0 && (
          <Section icon={<BookOutlined />} title="参考资料" color="#475569" bg="#F8FAFC" border="#E2E8F0">
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              {content.source_refs.map((ref, idx) => (
                <div key={idx} style={{ fontSize: 12, color: '#64748B', lineHeight: 1.7 }}>
                  {ref.file}{ref.relevance ? ` · 相关性${ref.relevance}` : ''}
                </div>
              ))}
            </div>
          </Section>
        )}
      </div>
    );
  }

  return null;
}
