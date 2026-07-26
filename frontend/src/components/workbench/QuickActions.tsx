'use client';

import React from 'react';
import {
  UnorderedListOutlined,
  ProfileOutlined,
  FileTextOutlined,
  EditOutlined,
  ExpandOutlined,
  CompressOutlined,
} from '@ant-design/icons';

const quickActions = [
  { key: 'directory', label: '生成目录', icon: <UnorderedListOutlined /> },
  { key: 'outline', label: '生成大纲', icon: <ProfileOutlined /> },
  { key: 'content', label: '生成正文', icon: <FileTextOutlined /> },
  { key: 'rewrite', label: '改写', icon: <EditOutlined /> },
  { key: 'expand', label: '扩写', icon: <ExpandOutlined /> },
  { key: 'compress', label: '精简', icon: <CompressOutlined /> },
];

interface QuickActionsProps {
  onAction: (key: string) => void;
  disabled?: boolean;
}

export default function QuickActions({ onAction, disabled }: QuickActionsProps) {
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginBottom: 8 }}>
      {quickActions.map((action) => (
        <button
          key={action.key}
          disabled={disabled}
          onClick={() => void onAction(action.key)}
          style={{
            display: 'inline-flex', alignItems: 'center', gap: 4,
            height: 24, padding: '0 8px',
            background: disabled ? '#F8FAFC' : '#FFFFFF',
            color: disabled ? '#CBD5E1' : '#475569',
            borderRadius: 4, fontSize: 11, fontWeight: 500,
            cursor: disabled ? 'not-allowed' : 'pointer',
            transition: 'color 0.15s, background 0.15s',
            border: 'none',
          }}
          onMouseEnter={(e) => {
            if (!disabled) {
              e.currentTarget.style.color = '#2563EB';
              e.currentTarget.style.background = '#EFF6FF';
            }
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.color = disabled ? '#CBD5E1' : '#475569';
            e.currentTarget.style.background = disabled ? '#F8FAFC' : '#FFFFFF';
          }}
        >
          {action.icon}
          {action.label}
        </button>
      ))}
    </div>
  );
}
