'use client';

import React, { useState, useCallback } from 'react';
import { Card, Button, Tag, Typography, message, Tabs } from 'antd';
import { PlusOutlined, DeleteOutlined, ArrowLeftOutlined, ArrowRightOutlined } from '@ant-design/icons';
import type { StyleTreeNode, PanelAssignment } from './types';

interface StyleTemplatePanelSplitProps {
  tree: StyleTreeNode;
  initialAssignment?: PanelAssignment;
  onSave: (data: { tree: StyleTreeNode; panel_assignment: PanelAssignment }) => Promise<void>;
  onSkip: () => void;
}

function generateNodeId() {
  return Math.random().toString(36).slice(2, 8) + Math.random().toString(36).slice(2, 8);
}

function deepClone<T>(obj: T): T {
  return JSON.parse(JSON.stringify(obj));
}

function updateNodeInTree(
  node: StyleTreeNode,
  nodeId: string,
  updater: (n: StyleTreeNode) => StyleTreeNode,
): StyleTreeNode {
  if (node.id === nodeId) return updater(node);
  return {
    ...node,
    children: node.children.map((child) => updateNodeInTree(child, nodeId, updater)),
  };
}

function removeNodeFromTree(node: StyleTreeNode, nodeId: string): StyleTreeNode {
  return {
    ...node,
    children: node.children
      .filter((child) => child.id !== nodeId)
      .map((child) => removeNodeFromTree(child, nodeId)),
  };
}

type MoveDirection = 'up' | 'down';

/**
 * 升级(up): 将 nodeId 从父节点的 children 中移除，插入到父节点之后（变成父节点的兄弟）
 * 降级(down): 将 nodeId 从父节点的 children 中移除，追加到前一个兄弟节点的 children 末尾
 */
function changeNodeLevel(root: StyleTreeNode, nodeId: string, direction: MoveDirection): StyleTreeNode {
  if (direction === 'up') {
    // 升级：在根节点的直接子节点中，将某个子节点的子节点提升
    // 或递归查找
    return promoteNode(root, nodeId);
  } else {
    // 降级：将节点变成前一个兄弟的子节点
    return demoteNode(root, nodeId);
  }
}

function promoteNode(root: StyleTreeNode, nodeId: string): StyleTreeNode {
  // root 的 children 中查找 nodeId → 将其提升为 root.children 的直接成员
  const idx = root.children.findIndex((c) => c.id === nodeId);
  if (idx !== -1) {
    // 不能升级根节点的直接子节点（已经在最顶层了）
    return root;
  }

  // 递归：在 root.children[i].children 中查找 nodeId
  for (let i = 0; i < root.children.length; i++) {
    const parent = root.children[i];
    const childIdx = parent.children.findIndex((c) => c.id === nodeId);
    if (childIdx !== -1) {
      // 找到了！将 nodeId 从 parent.children 移除，插入到 root.children 中 parent 之后
      const targetNode = parent.children[childIdx];
      const newParentChildren = parent.children.filter((_, ci) => ci !== childIdx);
      const newRootChildren = [...root.children];
      newRootChildren[i] = { ...parent, children: newParentChildren };
      newRootChildren.splice(i + 1, 0, targetNode); // 插入到 parent 之后
      return { ...root, children: newRootChildren };
    }
    // 继续递归
    const updated = promoteNode(parent, nodeId);
    if (updated !== parent) {
      const newRootChildren = [...root.children];
      newRootChildren[i] = updated;
      return { ...root, children: newRootChildren };
    }
  }
  return root;
}

function demoteNode(root: StyleTreeNode, nodeId: string): StyleTreeNode {
  const idx = root.children.findIndex((c) => c.id === nodeId);
  if (idx !== -1) {
    // 在 root.children 中找到了 nodeId
    if (idx === 0) return root; // 没有前一个兄弟，无法降级
    const prevSibling = root.children[idx - 1];
    const targetNode = root.children[idx];
    const newChildren = root.children.filter((_, ci) => ci !== idx);
    // 将 targetNode 追加到 prevSibling 的 children 末尾
    newChildren[idx - 1] = {
      ...prevSibling,
      children: [...prevSibling.children, targetNode],
    };
    return { ...root, children: newChildren };
  }

  // 递归
  for (let i = 0; i < root.children.length; i++) {
    const updated = demoteNode(root.children[i], nodeId);
    if (updated !== root.children[i]) {
      const newRootChildren = [...root.children];
      newRootChildren[i] = updated;
      return { ...root, children: newRootChildren };
    }
  }
  return root;
}

type PanelType = 'a' | 'b' | 'c';

const PANEL_META: Record<PanelType, { label: string; color: string; desc: string }> = {
  a: { label: '面板 A', color: 'blue', desc: '目录体例（目录结构模板）' },
  b: { label: '面板 B', color: 'green', desc: '大纲体例（大纲栏目模板）' },
  c: { label: '面板 C', color: 'orange', desc: '正文体例（正文栏目模板）' },
};

export function StyleTemplatePanelSplit({
  tree: initialTree,
  initialAssignment,
  onSave,
  onSkip,
}: StyleTemplatePanelSplitProps) {
  const [tree, setTree] = useState<StyleTreeNode>(() => initialTree);
  const [panelA, setPanelA] = useState<StyleTreeNode[]>(initialAssignment?.panel_a ?? []);
  const [panelB, setPanelB] = useState<StyleTreeNode[]>(initialAssignment?.panel_b ?? []);
  const [panelC, setPanelC] = useState<StyleTreeNode[]>(initialAssignment?.panel_c ?? []);
  const [saving, setSaving] = useState(false);

  const getPanel = useCallback((panel: PanelType): StyleTreeNode[] => {
    return panel === 'a' ? panelA : panel === 'b' ? panelB : panelC;
  }, [panelA, panelB, panelC]);

  const setPanel = useCallback((panel: PanelType, updater: (prev: StyleTreeNode[]) => StyleTreeNode[]) => {
    if (panel === 'a') setPanelA(updater);
    else if (panel === 'b') setPanelB(updater);
    else setPanelC(updater);
  }, []);

  // ── 源树编辑 ──

  const handleAddChild = useCallback((parentId: string) => {
    const newNode: StyleTreeNode = {
      id: generateNodeId(),
      title: '新节点',
      children: [],
      requirement: '',
    };
    setTree((prev) =>
      updateNodeInTree(prev, parentId, (n) => ({
        ...n,
        children: [...n.children, newNode],
      })),
    );
  }, []);

  const handleDelete = useCallback((nodeId: string) => {
    setTree((prev) => removeNodeFromTree(prev, nodeId));
  }, []);

  const handleRename = useCallback((nodeId: string, newTitle: string) => {
    if (!newTitle.trim()) return;
    setTree((prev) => updateNodeInTree(prev, nodeId, (n) => ({ ...n, title: newTitle.trim() })));
  }, []);

  const handleMove = useCallback((nodeId: string, direction: MoveDirection) => {
    setTree((prev) => changeNodeLevel(prev, nodeId, direction));
  }, []);

  // ── 面板分配（深拷贝节点到面板） ──

  const assignToPanel = useCallback((nodeId: string, panel: PanelType) => {
    const sourceNode = findNodeById(tree, nodeId);
    if (!sourceNode) return;

    let clone: StyleTreeNode;
    if (panel === 'c') {
      // 面板 C：深拷贝整个子树
      clone = deepClone({ ...sourceNode });
      clone.id = generateNodeId();
      assignUniqueIds(clone);
    } else {
      // 面板 A/B：只复制当前节点 + 一级子节点（子节点的 children 清空为叶子）
      clone = {
        id: generateNodeId(),
        title: sourceNode.title,
        requirement: sourceNode.requirement,
        children: (sourceNode.children ?? []).map((child) => ({
          id: generateNodeId(),
          title: child.title,
          requirement: child.requirement,
          children: [],
        })),
      };
    }
    setPanel(panel, (prev) => [...prev, clone]);
  }, [tree, setPanel]);

  const removeFromPanel = useCallback((panel: PanelType, index: number) => {
    setPanel(panel, (prev) => prev.filter((_, i) => i !== index));
  }, [setPanel]);

  // ── 面板内编辑 ──

  const panelAddChild = useCallback((panel: PanelType, rootIndex: number, parentId: string) => {
    const newNode: StyleTreeNode = {
      id: generateNodeId(),
      title: '新节点',
      children: [],
      requirement: '',
    };
    setPanel(panel, (prev) =>
      prev.map((root, i) =>
        i === rootIndex ? updateNodeInTree(root, parentId, (n) => ({ ...n, children: [...n.children, newNode] })) : root,
      ),
    );
  }, [setPanel]);

  const panelDeleteNode = useCallback((panel: PanelType, rootIndex: number, nodeId: string) => {
    setPanel(panel, (prev) =>
      prev.map((root, i) =>
        i === rootIndex ? removeNodeFromTree(root, nodeId) : root,
      ),
    );
  }, [setPanel]);

  const panelRename = useCallback((panel: PanelType, rootIndex: number, nodeId: string, newTitle: string) => {
    if (!newTitle.trim()) return;
    setPanel(panel, (prev) =>
      prev.map((root, i) =>
        i === rootIndex ? updateNodeInTree(root, nodeId, (n) => ({ ...n, title: newTitle.trim() })) : root,
      ),
    );
  }, [setPanel]);

  const panelMoveNode = useCallback((panel: PanelType, rootIndex: number, nodeId: string, direction: MoveDirection) => {
    setPanel(panel, (prev) =>
      prev.map((root, i) =>
        i === rootIndex ? changeNodeLevel(root, nodeId, direction) : root,
      ),
    );
  }, [setPanel]);

  // ── 保存 ──

  const handleSave = async () => {
    if (panelA.length === 0 && panelB.length === 0 && panelC.length === 0) {
      message.warning('请至少将节点分配到一个面板');
      return;
    }
    setSaving(true);
    try {
      await onSave({
        tree,
        panel_assignment: { panel_a: panelA, panel_b: panelB, panel_c: panelC },
      });
    } finally {
      setSaving(false);
    }
  };

  // ── 渲染：可编辑的节点行 ──

  const renderEditableNode = (
    node: StyleTreeNode,
    opts: {
      depth: number;
      onDelete: (nodeId: string) => void;
      onAddChild: (parentId: string) => void;
      onRename: (nodeId: string, title: string) => void;
      onMove?: (nodeId: string, direction: MoveDirection) => void;
      isRoot?: boolean;
      onAssignToPanel?: (nodeId: string, panel: PanelType) => void;
    },
  ): React.ReactNode => {
    if (!node.id) return null;
    return (
      <div key={node.id}>
        <div
          style={{
            padding: '3px 8px',
            marginLeft: opts.depth * 16,
            marginBottom: 2,
            borderRadius: 4,
            border: '1px solid #f0f0f0',
            display: 'flex',
            alignItems: 'center',
            gap: 4,
            background: '#fff',
          }}
        >
          <Typography.Text
            editable={{
              onChange: (val) => opts.onRename(node.id!, val),
              icon: <span style={{ fontSize: 11, color: '#999' }}>✎</span>,
            }}
            style={{ flex: 1, fontSize: 13, margin: 0 }}
          >
            {node.title}
          </Typography.Text>
          {!opts.isRoot && opts.onMove && (
            <>
              <Button
                size="small"
                type="text"
                icon={<ArrowLeftOutlined />}
                title="升级（减少层级）"
                style={{ fontSize: 10, padding: '0 4px', height: 22, minWidth: 22 }}
                onClick={() => opts.onMove!(node.id!, 'up')}
              />
              <Button
                size="small"
                type="text"
                icon={<ArrowRightOutlined />}
                title="降级（增加层级）"
                style={{ fontSize: 10, padding: '0 4px', height: 22, minWidth: 22 }}
                onClick={() => opts.onMove!(node.id!, 'down')}
              />
            </>
          )}
          {!opts.isRoot && (
            <Button
              size="small"
              type="text"
              danger
              icon={<DeleteOutlined />}
              style={{ fontSize: 11, padding: '0 4px', height: 22, minWidth: 22 }}
              onClick={() => opts.onDelete(node.id!)}
            />
          )}
          <Button
            size="small"
            type="text"
            icon={<PlusOutlined />}
            style={{ fontSize: 11, padding: '0 4px', height: 22, minWidth: 22 }}
            onClick={() => opts.onAddChild(node.id!)}
          />
          {opts.onAssignToPanel && (['a', 'b', 'c'] as PanelType[]).map((p) => (
            <Button
              key={p}
              size="small"
              style={{
                fontSize: 11,
                padding: '0 6px',
                height: 22,
                minWidth: 24,
                fontWeight: 600,
                color: PANEL_META[p].color === 'blue' ? '#1677ff'
                  : PANEL_META[p].color === 'green' ? '#52c41a'
                  : '#fa8c16',
              }}
              onClick={() => opts.onAssignToPanel!(node.id!, p)}
            >
              {p.toUpperCase()}
            </Button>
          ))}
        </div>
        {(node.children ?? []).map((child) =>
          renderEditableNode(child, { ...opts, depth: opts.depth + 1, isRoot: false }),
        )}
      </div>
    );
  };

  // ── 渲染：面板内容 ──

  const renderPanelContent = (panel: PanelType) => {
    const nodes = getPanel(panel);

    if (nodes.length === 0) {
      return (
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          点击源树节点旁的 A/B/C 按钮，将节点副本添加到此面板
        </Typography.Text>
      );
    }

    return nodes.map((rootNode, rootIndex) => (
      <div
        key={rootNode.id ?? rootIndex}
        style={{
          marginBottom: 8,
          padding: 8,
          border: '1px solid #f0f0f0',
          borderRadius: 4,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 4 }}>
          <Tag color={PANEL_META[panel].color} style={{ margin: 0 }}>
            {rootNode.title}
          </Tag>
          <Button
            size="small"
            type="text"
            danger
            style={{ padding: 0, lineHeight: 1, height: 'auto', fontSize: 13 }}
            onClick={() => removeFromPanel(panel, rootIndex)}
          >
            ×
          </Button>
        </div>
        {/* 面板内可编辑的子树 */}
        {(rootNode.children ?? []).map((child) =>
          renderEditableNode(child, {
            depth: 1,
            isRoot: false,
            onDelete: (nodeId) => panelDeleteNode(panel, rootIndex, nodeId),
            onAddChild: (parentId) => panelAddChild(panel, rootIndex, parentId),
            onRename: (nodeId, title) => panelRename(panel, rootIndex, nodeId, title),
            onMove: (nodeId, dir) => panelMoveNode(panel, rootIndex, nodeId, dir),
          }),
        )}
      </div>
    ));
  };

  return (
    <div>
      <div style={{ marginBottom: 16 }}>
        <Typography.Title level={4} style={{ margin: 0 }}>
          体例分层设置
        </Typography.Title>
        <Typography.Text type="secondary">
          将源树节点分配到面板（深拷贝），每个面板独立可编辑。A=目录体例，B=大纲体例，C=正文体例。
        </Typography.Text>
      </div>

      <div style={{ display: 'flex', gap: 16 }}>
        {/* 左侧：可编辑的原始树 */}
        <Card
          title="体例结构（源）"
          size="small"
          style={{ flex: 1, minWidth: 280 }}
          styles={{ body: { maxHeight: 500, overflowY: 'auto' } }}
        >
          {renderEditableNode(tree, {
            depth: 0,
            isRoot: true,
            onDelete: handleDelete,
            onAddChild: handleAddChild,
            onRename: handleRename,
            onMove: handleMove,
            onAssignToPanel: assignToPanel,
          })}
        </Card>

        {/* 右侧：Tabs 分页面板 */}
        <Card
          size="small"
          style={{ flex: 1 }}
          styles={{ body: { padding: 0 } }}
        >
          <Tabs
            defaultActiveKey="a"
            items={(['a', 'b', 'c'] as PanelType[]).map((panel) => {
              const meta = PANEL_META[panel];
              return {
                key: panel,
                label: (
                  <span>
                    <Tag color={meta.color} style={{ marginRight: 4 }}>
                      {meta.label}
                    </Tag>
                    {meta.desc}
                  </span>
                ),
                children: (
                  <div style={{ minHeight: 300, maxHeight: 450, overflowY: 'auto', padding: '0 12px 12px' }}>
                    {renderPanelContent(panel)}
                  </div>
                ),
              };
            })}
          />
        </Card>
      </div>

      <div style={{ marginTop: 16, display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
        <Button onClick={onSkip}>跳过</Button>
        <Button type="primary" loading={saving} onClick={handleSave}>
          保存分层设置
        </Button>
      </div>
    </div>
  );
}

// ── 辅助函数 ──

function findNodeById(node: StyleTreeNode, id: string): StyleTreeNode | null {
  if (node.id === id) return node;
  for (const child of node.children) {
    const found = findNodeById(child, id);
    if (found) return found;
  }
  return null;
}

function assignUniqueIds(node: StyleTreeNode) {
  if (!node.id) node.id = generateNodeId();
  for (const child of node.children) {
    assignUniqueIds(child);
  }
}
