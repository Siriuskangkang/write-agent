'use client';

import { useState, useCallback } from 'react';
import { Card, Button, Space, Input, Modal, Form, Tooltip, Tree, message, Typography } from 'antd';
import {
  SaveOutlined,
  CloseOutlined,
  PlusOutlined,
  DeleteOutlined,
  EditOutlined,
  InfoCircleOutlined,
} from '@ant-design/icons';
import type { StyleFeatures, StyleTreeNode } from './types';
import type { DataNode } from 'antd/es/tree';
import styles from './StyleTemplateEdit.module.css';

const { TextArea } = Input;
const { Text } = Typography;

interface StyleTemplateEditProps {
  initialFeatures: StyleFeatures;
  onSave: (features: StyleFeatures) => void;
  onCancel: () => void;
}

// 生成唯一 key
function generateKey() {
  return `node_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
}

// 生成持久化节点 ID（12位随机字符串，与后端 nanoid(12) 格式一致）
function generateNodeId() {
  return Math.random().toString(36).slice(2, 8) + Math.random().toString(36).slice(2, 8);
}

interface TreeNodeWithKey extends StyleTreeNode {
  _key: string;
  children: TreeNodeWithKey[];
}

// 给每个节点附加唯一 _key
function attachKeys(node: StyleTreeNode): TreeNodeWithKey {
  return {
    ...node,
    _key: generateKey(),
    children: (node.children ?? []).map(attachKeys),
  };
}

// 移除 _key，还原为 StyleTreeNode
function stripKeys(node: TreeNodeWithKey): StyleTreeNode {
  const { _key, ...rest } = node;
  return {
    ...rest,
    children: node.children.map(stripKeys),
  };
}

// 在树中按 _key 找到节点
function findNode(node: TreeNodeWithKey, key: string): TreeNodeWithKey | null {
  if (node._key === key) return node;
  for (const child of node.children) {
    const found = findNode(child, key);
    if (found) return found;
  }
  return null;
}

// 更新树中指定节点
function updateNode(
  node: TreeNodeWithKey,
  key: string,
  updater: (n: TreeNodeWithKey) => TreeNodeWithKey,
): TreeNodeWithKey {
  if (node._key === key) return updater(node);
  return {
    ...node,
    children: node.children.map((c) => updateNode(c, key, updater)),
  };
}

// 删除树中指定节点（不能删根节点）
function deleteNode(node: TreeNodeWithKey, key: string): TreeNodeWithKey {
  return {
    ...node,
    children: node.children
      .filter((c) => c._key !== key)
      .map((c) => deleteNode(c, key)),
  };
}

// 将内部树节点转换为 Ant Design DataNode
function buildAntTreeData(
  node: TreeNodeWithKey,
  onRenameClick: (key: string, title: string) => void,
  onAddChild: (key: string) => void,
  onEditReq: (key: string, req: string) => void,
  onDelete: (key: string) => void,
  isRoot: boolean,
): DataNode {
  const isLeaf = node.children.length === 0;

  const title = (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
      <span>{node.title}</span>
      {isLeaf && node.requirement && (
        <Tooltip title={node.requirement} placement="right">
          <Text type="secondary" style={{ fontSize: 12, cursor: 'help' }}>
            <InfoCircleOutlined style={{ marginRight: 3 }} />
            编写要求
          </Text>
        </Tooltip>
      )}
      <span style={{ marginLeft: 4, display: 'inline-flex', gap: 4 }}>
        <Button
          type="text"
          size="small"
          icon={<EditOutlined />}
          onClick={(e) => { e.stopPropagation(); onRenameClick(node._key, node.title); }}
          title="重命名"
        />
        {isLeaf && (
          <Button
            type="text"
            size="small"
            icon={<InfoCircleOutlined />}
            onClick={(e) => { e.stopPropagation(); onEditReq(node._key, node.requirement ?? ''); }}
            title="编辑编写要求"
          />
        )}
        <Button
          type="text"
          size="small"
          icon={<PlusOutlined />}
          onClick={(e) => { e.stopPropagation(); onAddChild(node._key); }}
          title="添加子节点"
        />
        {!isRoot && (
          <Button
            type="text"
            size="small"
            danger
            icon={<DeleteOutlined />}
            onClick={(e) => { e.stopPropagation(); onDelete(node._key); }}
            title="删除节点"
          />
        )}
      </span>
    </span>
  );

  return {
    key: node._key,
    title,
    children: node.children.map((child) =>
      buildAntTreeData(child, onRenameClick, onAddChild, onEditReq, onDelete, false)
    ),
    isLeaf,
  };
}

export function StyleTemplateEdit({ initialFeatures, onSave, onCancel }: StyleTemplateEditProps) {
  const [tree, setTree] = useState<TreeNodeWithKey>(() =>
    attachKeys(initialFeatures.structure_tree)
  );

  // 重命名弹窗
  const [renameModal, setRenameModal] = useState<{ open: boolean; key: string; title: string }>({
    open: false,
    key: '',
    title: '',
  });

  // 编写要求弹窗
  const [reqModal, setReqModal] = useState<{ open: boolean; key: string; requirement: string }>({
    open: false,
    key: '',
    requirement: '',
  });

  const handleRenameClick = useCallback((key: string, title: string) => {
    setRenameModal({ open: true, key, title });
  }, []);

  const handleRenameOk = () => {
    const newTitle = renameModal.title.trim();
    if (!newTitle) {
      message.warning('节点名称不能为空');
      return;
    }
    setTree((prev) => updateNode(prev, renameModal.key, (n) => ({ ...n, title: newTitle })));
    setRenameModal({ open: false, key: '', title: '' });
  };

  const handleAddChild = useCallback((key: string) => {
    const newNode: TreeNodeWithKey = {
      _key: generateKey(),
      id: generateNodeId(),
      title: '新节点',
      children: [],
      requirement: '',
    };
    setTree((prev) => updateNode(prev, key, (n) => ({ ...n, children: [...n.children, newNode] })));
  }, []);

  const handleEditReq = useCallback((key: string, requirement: string) => {
    setReqModal({ open: true, key, requirement });
  }, []);

  const handleReqOk = () => {
    setTree((prev) =>
      updateNode(prev, reqModal.key, (n) => ({ ...n, requirement: reqModal.requirement }))
    );
    setReqModal({ open: false, key: '', requirement: '' });
  };

  const handleDelete = useCallback((key: string) => {
    Modal.confirm({
      title: '确认删除',
      content: '删除后，该节点及其所有子节点将被移除，无法恢复。',
      okText: '删除',
      okType: 'danger',
      cancelText: '取消',
      onOk: () => {
        setTree((prev) => deleteNode(prev, key));
      },
    });
  }, []);

  const handleSave = () => {
    onSave({
      ...initialFeatures,
      structure_tree: stripKeys(tree),
    });
  };

  const treeData = [
    buildAntTreeData(tree, handleRenameClick, handleAddChild, handleEditReq, handleDelete, true),
  ];

  return (
    <>
      <Card
        title="编辑体例结构"
        extra={
          <Space>
            <Button icon={<CloseOutlined />} onClick={onCancel}>取消</Button>
            <Button type="primary" icon={<SaveOutlined />} onClick={handleSave}>保存</Button>
          </Space>
        }
      >
        <div className={styles.editTree} style={{ minHeight: 200, maxHeight: 600, overflowY: 'auto' }}>
          <Tree
            showLine={{ showLeafIcon: false }}
            defaultExpandAll
            treeData={treeData}
          />
        </div>
      </Card>

      {/* 重命名弹窗 */}
      <Modal
        title="重命名节点"
        open={renameModal.open}
        onOk={handleRenameOk}
        onCancel={() => setRenameModal({ open: false, key: '', title: '' })}
        okText="确认"
        cancelText="取消"
      >
        <Input
          value={renameModal.title}
          onChange={(e) => setRenameModal((prev) => ({ ...prev, title: e.target.value }))}
          onPressEnter={handleRenameOk}
          placeholder="请输入节点名称"
          autoFocus
        />
      </Modal>

      {/* 编写要求弹窗 */}
      <Modal
        title="编辑编写要求"
        open={reqModal.open}
        onOk={handleReqOk}
        onCancel={() => setReqModal({ open: false, key: '', requirement: '' })}
        okText="确认"
        cancelText="取消"
        width={480}
      >
        <TextArea
          value={reqModal.requirement}
          onChange={(e) => setReqModal((prev) => ({ ...prev, requirement: e.target.value }))}
          rows={5}
          placeholder="描述该栏目的编写要求，如：字数建议、内容类型、格式要求等"
        />
      </Modal>
    </>
  );
}
