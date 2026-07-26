'use client';

import { Card, Button, Space, Tree, Tag, Tooltip } from 'antd';
import { CheckOutlined, EditOutlined, InfoCircleOutlined } from '@ant-design/icons';
import type { StyleTemplateAnalysisResult, StyleTreeNode } from './types';
import type { DataNode } from 'antd/es/tree';
import styles from './StyleTemplatePreview.module.css';

interface StyleTemplatePreviewProps {
  result: StyleTemplateAnalysisResult;
  onConfirm: () => void;
  onEdit: () => void;
  showActions?: boolean;
}

function buildTreeData(node: StyleTreeNode, keyPrefix = '0'): DataNode {
  const isLeaf = !node.children || node.children.length === 0;

  const title = isLeaf && node.requirement ? (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
      <span>{node.title}</span>
      <Tooltip title={node.requirement} placement="right">
        <Tag color="blue" style={{ cursor: 'help', fontSize: 11, margin: 0 }}>
          <InfoCircleOutlined style={{ marginRight: 2 }} />
          编写要求
        </Tag>
      </Tooltip>
    </span>
  ) : (
    <span>{node.title}</span>
  );

  return {
    key: keyPrefix,
    title,
    children: node.children?.map((child, i) =>
      buildTreeData(child, `${keyPrefix}-${i}`)
    ),
    isLeaf,
  };
}

export function StyleTemplatePreview({ result, onConfirm, onEdit, showActions = true }: StyleTemplatePreviewProps) {
  if (!result?.features?.structure_tree) {
    return <Card title="体例分析结果">暂无数据</Card>;
  }

  const treeData = [buildTreeData(result.features.structure_tree)];

  return (
    <div>
      {showActions && (
        <div style={{ marginBottom: 16, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <h2 style={{ margin: 0 }}>体例分析结果</h2>
          <Space>
            <Button icon={<EditOutlined />} onClick={onEdit}>编辑</Button>
            <Button type="primary" icon={<CheckOutlined />} onClick={onConfirm}>确认保存</Button>
          </Space>
        </div>
      )}

      <Card
        size="small"
        styles={{ body: { maxHeight: 600, overflowY: 'auto', padding: '16px' } }}
      >
        <div className={styles.previewTree}>
          <Tree
            showLine={{ showLeafIcon: false }}
            defaultExpandAll
            treeData={treeData}
          />
        </div>
      </Card>
    </div>
  );
}
