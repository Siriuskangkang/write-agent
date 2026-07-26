'use client';

import { useState, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import { Dropdown } from 'antd';
import {
  BookOutlined,
  ClockCircleOutlined,
  CodeOutlined,
  DatabaseOutlined,
  DeleteOutlined,
  EditOutlined,
  FileTextOutlined,
  MoreOutlined,
  ReadOutlined,
} from '@ant-design/icons';
import type { Project } from '@/types';
import { ProjectStatus } from '@/types';

const C = {
  card: '#FFFFFF',
  border: '#DDE9F8',
  borderStrong: '#C7DCF6',
  canvas: '#F6FAFF',
  textPrimary: '#11233F',
  textSecondary: '#5F7392',
  textTertiary: '#8EA1BB',
  shadow: '0 14px 34px rgba(50, 93, 168, 0.10)',
  shadowHover: '0 22px 44px rgba(41, 89, 170, 0.16)',
} as const;

type VisualConfig = {
  code: string;
  icon: ReactNode;
  banner: string;
  badgeBg: string;
  iconBg: string;
  iconColor: string;
};

const visualPresets: VisualConfig[] = [
  {
    code: '教材',
    icon: <BookOutlined />,
    banner: 'linear-gradient(135deg, #1D4ED8 0%, #2F72FF 100%)',
    badgeBg: 'rgba(255,255,255,0.18)',
    iconBg: 'rgba(255,255,255,0.20)',
    iconColor: '#FFFFFF',
  },
  {
    code: '文献',
    icon: <ReadOutlined />,
    banner: 'linear-gradient(135deg, #1B56D8 0%, #318BFF 100%)',
    badgeBg: 'rgba(255,255,255,0.18)',
    iconBg: 'rgba(255,255,255,0.18)',
    iconColor: '#FFFFFF',
  },
  {
    code: 'Py',
    icon: <CodeOutlined />,
    banner: 'linear-gradient(135deg, #1694FF 0%, #47C3FF 100%)',
    badgeBg: 'rgba(255,255,255,0.16)',
    iconBg: 'rgba(255,255,255,0.16)',
    iconColor: '#FFFFFF',
  },
  {
    code: '大数',
    icon: <DatabaseOutlined />,
    banner: 'linear-gradient(135deg, #FACC15 0%, #F59E0B 100%)',
    badgeBg: 'rgba(255,255,255,0.24)',
    iconBg: 'rgba(255,255,255,0.28)',
    iconColor: '#854D0E',
  },
  {
    code: '项目',
    icon: <FileTextOutlined />,
    banner: 'linear-gradient(135deg, #2563EB 0%, #2DD4BF 100%)',
    badgeBg: 'rgba(255,255,255,0.18)',
    iconBg: 'rgba(255,255,255,0.18)',
    iconColor: '#FFFFFF',
  },
];

const statusConfig: Record<ProjectStatus, { label: string; dot: string; color: string; background: string }> = {
  [ProjectStatus.DRAFT]: {
    label: '草稿',
    dot: '#4F8EF7',
    color: '#3171D8',
    background: '#EAF3FF',
  },
  [ProjectStatus.IN_PROGRESS]: {
    label: '编写中',
    dot: '#10B981',
    color: '#0F8A63',
    background: '#E9FBF4',
  },
  [ProjectStatus.COMPLETED]: {
    label: '已完成',
    dot: '#7C3AED',
    color: '#6D34D3',
    background: '#F2EBFF',
  },
};

function getTextSeed(project: Project) {
  return `${project.name} ${project.type ?? ''} ${project.description ?? ''}`.toLowerCase();
}

function getInitialCode(project: Project) {
  const seed = getTextSeed(project);

  if (seed.includes('python') || seed.includes('py')) return 'Py';
  if (seed.includes('文献') || seed.includes('阅读')) return '文献';
  if (seed.includes('数据') || seed.includes('统计') || seed.includes('大数')) return '大数';

  const compactName = project.name.replace(/\s+/g, '');
  const chineseMatch = compactName.match(/[\u4e00-\u9fa5]+/g)?.join('') ?? '';

  if (chineseMatch.length >= 2) return chineseMatch.slice(0, 2);
  if (compactName.length >= 2) return compactName.slice(0, 2).toUpperCase();

  return '教材';
}

function getVisual(project: Project): VisualConfig {
  const seed = getTextSeed(project);

  if (seed.includes('数据') || seed.includes('统计') || seed.includes('大数')) {
    return { ...visualPresets[3], code: getInitialCode(project) };
  }

  if (seed.includes('文献') || seed.includes('阅读')) {
    return { ...visualPresets[1], code: getInitialCode(project) };
  }

  if (seed.includes('python') || seed.includes('py')) {
    return { ...visualPresets[2], code: getInitialCode(project) };
  }

  let hash = 0;
  for (let i = 0; i < project.name.length; i += 1) {
    hash = project.name.charCodeAt(i) + ((hash << 5) - hash);
  }

  const preset = visualPresets[Math.abs(hash) % visualPresets.length];
  return { ...preset, code: getInitialCode(project) };
}

function formatRelativeTime(dateStr: string) {
  const diff = Date.now() - new Date(dateStr).getTime();
  const minutes = Math.floor(diff / 60000);

  if (minutes < 1) return '刚刚';
  if (minutes < 60) return `${minutes} 分钟前`;

  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;

  const days = Math.floor(hours / 24);
  if (days < 30) return `${days} 天前`;

  const months = Math.floor(days / 30);
  if (months < 12) return `${months} 个月前`;

  return `${Math.floor(months / 12)} 年前`;
}

interface ProjectCardProps {
  project: Project;
  onDelete: (id: string) => void;
  index?: number;
  listMode?: boolean;
}

export default function ProjectCard({ project, onDelete, index = 0, listMode = false }: ProjectCardProps) {
  const router = useRouter();
  const [hovered, setHovered] = useState(false);
  const status = statusConfig[project.status] ?? statusConfig[ProjectStatus.DRAFT];
  const visual = getVisual(project);
  const secondaryMeta = project.type || project.style || project.target_audience || '教材编写项目';

  const menuItems = [
    {
      key: 'edit',
      icon: <EditOutlined />,
      label: '编辑设置',
      onClick: () => router.push(`/projects/${project.id}/settings`),
    },
    { type: 'divider' as const },
    {
      key: 'delete',
      icon: <DeleteOutlined />,
      label: '删除教材',
      danger: true,
      onClick: () => onDelete(project.id),
    },
  ];

  if (listMode) {
    return (
      <div
        className="project-card-animate"
        style={{
          display: 'grid',
          gridTemplateColumns: 'minmax(240px, 1fr) 100px 120px 52px',
          gap: 12,
          alignItems: 'center',
          padding: '14px 18px',
          background: hovered ? '#F4F9FF' : '#FFFFFF',
          borderBottom: `1px solid ${C.border}`,
          cursor: 'pointer',
          transition: 'background 0.18s ease',
          ['--card-index' as string]: index,
        }}
        onClick={() => router.push(`/projects/${project.id}`)}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, minWidth: 0 }}>
          <div
            style={{
              width: 52,
              height: 52,
              borderRadius: 16,
              background: visual.banner,
              color: '#FFFFFF',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              flexDirection: 'column',
              boxShadow: '0 10px 24px rgba(37,99,235,0.16)',
              flexShrink: 0,
            }}
          >
            <span style={{ fontSize: 16, fontWeight: 800, lineHeight: 1 }}>{visual.code}</span>
          </div>

          <div style={{ minWidth: 0 }}>
            <div
              style={{
                fontSize: 14,
                fontWeight: 700,
                color: C.textPrimary,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}
            >
              {project.name}
            </div>
            <div
              style={{
                marginTop: 3,
                fontSize: 12,
                color: C.textSecondary,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}
            >
              {secondaryMeta}
            </div>
          </div>
        </div>

        <span
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 6,
            width: 'fit-content',
            padding: '5px 10px',
            borderRadius: 999,
            fontSize: 12,
            fontWeight: 600,
            color: status.color,
            background: status.background,
          }}
        >
          <span
            className={project.status === ProjectStatus.IN_PROGRESS ? 'status-dot-active' : undefined}
            style={{
              width: 6,
              height: 6,
              borderRadius: '50%',
              background: status.dot,
              flexShrink: 0,
            }}
          />
          {status.label}
        </span>

        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, color: C.textSecondary, fontSize: 12 }}>
          <ClockCircleOutlined style={{ fontSize: 12 }} />
          {formatRelativeTime(project.updated_at)}
        </span>

        <div onClick={(e) => e.stopPropagation()}>
          <Dropdown menu={{ items: menuItems }} trigger={['click']} placement="bottomRight">
            <button
              type="button"
              style={{
                width: 34,
                height: 34,
                borderRadius: 10,
                border: 'none',
                background: hovered ? '#EAF2FF' : 'transparent',
                color: '#5A78A6',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                cursor: 'pointer',
              }}
            >
              <MoreOutlined />
            </button>
          </Dropdown>
        </div>
      </div>
    );
  }

  return (
    <div
      onClick={() => router.push(`/projects/${project.id}`)}
      className="project-card project-card-animate"
      style={{
        background: C.card,
        border: `1px solid ${hovered ? C.borderStrong : C.border}`,
        borderRadius: 22,
        overflow: 'hidden',
        cursor: 'pointer',
        display: 'flex',
        flexDirection: 'column',
        boxShadow: hovered ? C.shadowHover : C.shadow,
        transition: 'transform 0.22s ease, box-shadow 0.22s ease, border-color 0.22s ease',
        transform: hovered ? 'translateY(-5px)' : 'translateY(0)',
        ['--card-index' as string]: index,
      }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      <div
        style={{
          height: 120,
          position: 'relative',
          overflow: 'hidden',
          background: visual.banner,
        }}
      >
        <div
          style={{
            position: 'absolute',
            inset: 0,
            background: 'linear-gradient(180deg, rgba(255,255,255,0.06) 0%, rgba(255,255,255,0) 60%)',
          }}
        />

        <div
          style={{
            position: 'absolute',
            right: -18,
            top: -24,
            width: 120,
            height: 120,
            borderRadius: '50%',
            background: 'rgba(255,255,255,0.14)',
          }}
        />
        <div
          style={{
            position: 'absolute',
            right: 18,
            bottom: -24,
            width: 64,
            height: 64,
            borderRadius: '50%',
            background: 'rgba(255,255,255,0.10)',
          }}
        />

        <div onClick={(e) => e.stopPropagation()} style={{ position: 'absolute', left: 12, top: 12, zIndex: 1 }}>
          <Dropdown menu={{ items: menuItems }} trigger={['click']} placement="bottomRight">
            <button
              type="button"
              style={{
                width: 28,
                height: 28,
                borderRadius: 10,
                border: 'none',
                background: visual.badgeBg,
                backdropFilter: 'blur(10px)',
                color: '#FFFFFF',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                cursor: 'pointer',
              }}
            >
              <MoreOutlined />
            </button>
          </Dropdown>
        </div>

        <div
          style={{
            position: 'absolute',
            left: 16,
            bottom: 16,
            color: visual.code === '大数' ? '#713F12' : '#FFFFFF',
            display: 'flex',
            flexDirection: 'column',
            gap: 4,
          }}
        >
          <span style={{ fontSize: 38, fontWeight: 800, lineHeight: 1, letterSpacing: '-0.04em' }}>{visual.code}</span>
          <span style={{ fontSize: 12, opacity: 0.88 }}>Project</span>
        </div>

        <div
          className="project-avatar"
          style={{
            position: 'absolute',
            right: 16,
            top: '50%',
            transform: `translateY(-50%) ${hovered ? 'scale(1.06)' : 'scale(1)'}`,
            width: 70,
            height: 70,
            borderRadius: 22,
            background: visual.iconBg,
            border: '1px solid rgba(255,255,255,0.22)',
            color: visual.iconColor,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontSize: 30,
            boxShadow: '0 14px 28px rgba(15, 23, 42, 0.10)',
            transition: 'transform 0.22s ease',
          }}
        >
          {visual.icon}
        </div>
      </div>

      <div
        style={{
          padding: '16px 16px 15px',
          background: C.card,
          display: 'flex',
          flexDirection: 'column',
          gap: 10,
          minHeight: 164,
        }}
      >
        <div style={{ minHeight: 48 }}>
          <div
            style={{
              fontSize: 14,
              fontWeight: 700,
              color: C.textPrimary,
              lineHeight: 1.4,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {project.name}
          </div>

          <div
            style={{
              marginTop: 4,
              fontSize: 12,
              color: C.textSecondary,
              lineHeight: 1.5,
              overflow: 'hidden',
              display: '-webkit-box',
              WebkitLineClamp: 2,
              WebkitBoxOrient: 'vertical',
            }}
          >
            {project.description || secondaryMeta}
          </div>
        </div>

        <div style={{ fontSize: 11, color: C.textTertiary, lineHeight: 1.4 }}>{secondaryMeta}</div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <div style={{ height: 5, borderRadius: 999, background: '#ECF3FE', width: '100%' }} />
          <div style={{ height: 5, borderRadius: 999, background: '#ECF3FE', width: '72%' }} />
        </div>

        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            marginTop: 'auto',
            paddingTop: 10,
            borderTop: '1px solid #E8F0FA',
          }}
        >
          <span
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 6,
              padding: '5px 10px',
              borderRadius: 999,
              fontSize: 11,
              fontWeight: 700,
              color: status.color,
              background: status.background,
            }}
          >
            <span
              className={project.status === ProjectStatus.IN_PROGRESS ? 'status-dot-active' : undefined}
              style={{
                width: 6,
                height: 6,
                borderRadius: '50%',
                background: status.dot,
                flexShrink: 0,
              }}
            />
            {status.label}
          </span>

          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, color: C.textTertiary, fontSize: 11 }}>
            <ClockCircleOutlined style={{ fontSize: 11 }} />
            {formatRelativeTime(project.updated_at)}
          </span>
        </div>
      </div>
    </div>
  );
}
