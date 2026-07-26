'use client';

import { BookOutlined, FileTextOutlined } from '@ant-design/icons';
import { NodeType, MaterialSupport } from '@/types';
import type { DirectoryNode } from '@/types';

const supportConfig: Record<MaterialSupport, { color: string; bg: string; border: string }> = {
  [MaterialSupport.HIGH]:   { color: '#059669', bg: '#ECFDF5', border: '#A7F3D0' },
  [MaterialSupport.MEDIUM]: { color: '#D97706', bg: '#FFFBEB', border: '#FDE68A' },
  [MaterialSupport.LOW]:    { color: '#DC2626', bg: '#FEF2F2', border: '#FECACA' },
};

interface DirectoryResultCardProps {
  nodes: DirectoryNode[];
}

export default function DirectoryResultCard({ nodes }: DirectoryResultCardProps) {
  const chapters = nodes
    .filter((n) => n.node_type === NodeType.CHAPTER)
    .sort((a, b) => a.order_index - b.order_index);

  if (chapters.length === 0) return null;

  return (
    <div style={{ fontSize: 13 }}>
      {/* 成功提示 */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 6,
        padding: '6px 10px', borderRadius: 6,
        background: '#ECFDF5',
        marginBottom: 12, fontSize: 12, fontWeight: 500, color: '#065F46',
      }}>
        <span>✓</span>
        <span>目录已生成，共 {chapters.length} 章</span>
      </div>

      {/* 章节列表 */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        {chapters.map((ch) => {
          const sections = nodes
            .filter((n) => n.parent_node_id === ch.node_id && n.node_type === NodeType.SECTION)
            .sort((a, b) => a.order_index - b.order_index);
          return (
            <div key={ch.node_id} style={{
              borderRadius: 6,
              overflow: 'hidden',
              background: '#F8FAFC',
            }}>
              {/* 章标题 */}
              <div style={{
                display: 'flex', alignItems: 'center', gap: 6,
                padding: '6px 10px',
              }}>
                <BookOutlined style={{ fontSize: 11, color: '#2563EB' }} />
                <span style={{ fontWeight: 600, fontSize: 12, color: '#192877' }}>{ch.title}</span>
              </div>

              {/* 小节列表 */}
              {sections.length > 0 && (
                <div style={{ padding: '4px 0' }}>
                  {sections.map((sec) => {
                    const sc = sec.material_support ? supportConfig[sec.material_support] : null;
                    return (
                      <div key={sec.node_id} style={{
                        display: 'flex', alignItems: 'center', gap: 6,
                        padding: '4px 10px 4px 24px',
                        background: '#FFFFFF',
                        marginBottom: 2,
                        borderRadius: 4,
                      }}>
                        <FileTextOutlined style={{ fontSize: 10, color: '#94A3B8' }} />
                        <span style={{ fontSize: 12, color: '#475569', flex: 1 }}>{sec.title}</span>
                        {sc && (
                          <span style={{
                            fontSize: 10, fontWeight: 500,
                            padding: '1px 5px', borderRadius: 3,
                            color: sc.color, background: sc.bg,
                          }}>
                            {sec.material_support}
                          </span>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
