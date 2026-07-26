'use client';

import { Table, Button, Space, Tag, Popconfirm } from 'antd';
import { CheckCircleOutlined, EditOutlined, DeleteOutlined } from '@ant-design/icons';
import type { ColumnsType } from 'antd/es/table';
import type { StyleTemplate } from './types';

interface StyleTemplateListProps {
  templates: StyleTemplate[];
  activeTemplateId?: string;
  onActivate: (id: string) => void;
  onDelete: (id: string) => void;
  onEdit: (id: string) => void;
}

export function StyleTemplateList({
  templates,
  activeTemplateId,
  onActivate,
  onDelete,
  onEdit
}: StyleTemplateListProps) {
  const columns: ColumnsType<StyleTemplate> = [
    {
      title: '体例名称',
      dataIndex: 'name',
      key: 'name',
      render: (name, record: any) => (
        <Space>
          {name}
          {record.isActive && <Tag color="green">已激活</Tag>}
        </Space>
      )
    },
    {
      title: '规则数量',
      dataIndex: 'features',
      key: 'rulesCount',
      width: 120,
      render: (features) => features ? Object.keys(features).length : 0
    },
    {
      title: '创建时间',
      dataIndex: 'createdAt',
      key: 'createdAt',
      width: 180,
      render: (date) => new Date(date).toLocaleString('zh-CN')
    },
    {
      title: '操作',
      key: 'actions',
      width: 200,
      render: (_: any, record: any) => (
        <Space>
          {!record.isActive && (
            <Button
              type="link"
              size="small"
              icon={<CheckCircleOutlined />}
              onClick={() => onActivate(record.id)}
            >
              激活
            </Button>
          )}
          <Button
            type="link"
            size="small"
            icon={<EditOutlined />}
            onClick={() => onEdit(record.id)}
          >
            编辑
          </Button>
          <Popconfirm
            title="确认删除此体例？"
            onConfirm={() => onDelete(record.id)}
            okText="确认"
            cancelText="取消"
          >
            <Button type="link" size="small" danger icon={<DeleteOutlined />}>
              删除
            </Button>
          </Popconfirm>
        </Space>
      )
    }
  ];

  return <Table columns={columns} dataSource={templates} rowKey="id" />;
}
