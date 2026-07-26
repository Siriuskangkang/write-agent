'use client';

import { useEffect, useState, useCallback, useRef, useMemo } from 'react';
import { Tree, Spin, Empty, Tag, Tooltip, Input, Popconfirm, message } from 'antd';
import type { TreeProps } from 'antd';
import {
  BookOutlined,
  FileTextOutlined,
  EditOutlined,
  DeleteOutlined,
} from '@ant-design/icons';
import type { TreeDataNode } from 'antd';
import { useEditorStore } from '@/stores/editorStore';
import { useProjectStore } from '@/stores/projectStore';
import { projectService } from '@/services/projectService';
import { contentService } from '@/services/contentService';
import type { DirectoryNode } from '@/types';
import { NodeType, MaterialSupport } from '@/types';

const supportColorMap: Record<MaterialSupport, string> = {
  [MaterialSupport.HIGH]: 'green',
  [MaterialSupport.MEDIUM]: 'orange',
  [MaterialSupport.LOW]: 'red',
};

const materialSupportTooltip: Record<MaterialSupport, string> = {
  [MaterialSupport.HIGH]: '素材支撑度充足：该小节在已上传素材中有较多参考内容',
  [MaterialSupport.MEDIUM]: '素材支撑度一般：该小节在已上传素材中有少量参考内容',
  [MaterialSupport.LOW]: '素材支撑度不足：该小节在已上传素材中几乎没有参考内容',
};

function NodeTitle({
  node,
  editingNodeId,
  editingTitle,
  setEditingNodeId,
  setEditingTitle,
  onSaveTitle,
  onDeleteNode,
}: {
  node: DirectoryNode;
  editingNodeId: string | null;
  editingTitle: string;
  setEditingNodeId: (id: string | null) => void;
  setEditingTitle: (title: string) => void;
  onSaveTitle: (nodeId: string) => void;
  onDeleteNode: (nodeId: string) => void;
}) {
  const color = node.material_support ? supportColorMap[node.material_support] : undefined;
  const tooltipText = node.material_support ? materialSupportTooltip[node.material_support] : undefined;
  const isEditing = editingNodeId === node.node_id;

  if (isEditing) {
    return (
      <Input
        size="small"
        value={editingTitle}
        onChange={(e) => setEditingTitle(e.target.value)}
        onFocus={(e) => e.stopPropagation()}
        onMouseDown={(e) => e.stopPropagation()}
        onPressEnter={() => onSaveTitle(node.node_id)}
        onBlur={() => onSaveTitle(node.node_id)}
        autoFocus
        style={{
          width: 140,
          background: 'rgba(255,255,255,0.96)',
          borderColor: '#93C5FD',
          color: '#0F172A',
          boxShadow: '0 0 0 2px rgba(255,255,255,0.18)',
        }}
        onClick={(e) => e.stopPropagation()}
      />
    );
  }

  return (
    <span className="node-title-row">
      {node.level_label && (
        <Tag color="blue" style={{ margin: '0 4px 0 0', fontSize: 10, lineHeight: '16px', padding: '0 4px' }}>
          {node.level_label}
        </Tag>
      )}
      <Tooltip title={node.title}>
        <span className="node-title-text">{node.title}</span>
      </Tooltip>
      {node.material_support && (
        <Tooltip title={tooltipText}>
          <Tag
            className="node-support-tag"
            color={color}
            style={{ margin: 0, fontSize: 10, lineHeight: '16px', padding: '0 4px', opacity: 0.85 }}
          >
            {node.material_support}
          </Tag>
        </Tooltip>
      )}
      <span
        className="node-actions"
        style={{
          display: 'inline-flex',
          width: 34,
          marginLeft: 2,
          gap: 4,
          alignItems: 'center',
          justifyContent: 'flex-end',
          flexShrink: 0,
          opacity: 0,
          visibility: 'hidden',
          pointerEvents: 'none',
        }}
      >
        <EditOutlined
          style={{ fontSize: 11, color: '#DBEAFE' }}
          onMouseDown={(e) => {
            e.preventDefault();
            e.stopPropagation();
          }}
          onClick={(e) => {
            e.stopPropagation();
            setEditingNodeId(node.node_id);
            setEditingTitle(node.title);
          }}
        />
        <Popconfirm
          title="确定删除此节点？"
          onConfirm={(e) => { e?.stopPropagation(); onDeleteNode(node.node_id); }}
          onCancel={(e) => e?.stopPropagation()}
          okText="删除"
          cancelText="取消"
        >
          <DeleteOutlined
            style={{ fontSize: 11, color: '#BFDBFE' }}
            onClick={(e) => e.stopPropagation()}
          />
        </Popconfirm>
      </span>
    </span>
  );
}

function buildTreeData(
  nodes: DirectoryNode[],
  editingNodeId: string | null,
  editingTitle: string,
  setEditingNodeId: (id: string | null) => void,
  setEditingTitle: (title: string) => void,
  onSaveTitle: (nodeId: string) => void,
  onDeleteNode: (nodeId: string) => void,
): TreeDataNode[] {
  function buildChildren(parentId: string | null): TreeDataNode[] {
    const children = nodes
      .filter((n) => n.parent_node_id === parentId)
      .sort((a, b) => a.order_index - b.order_index);

    return children.map((node) => {
      const subChildren = buildChildren(node.node_id);
      const isLeaf = subChildren.length === 0;
      return {
        key: node.node_id,
        title: (
          <NodeTitle
            node={node}
            editingNodeId={editingNodeId}
            editingTitle={editingTitle}
            setEditingNodeId={setEditingNodeId}
            setEditingTitle={setEditingTitle}
            onSaveTitle={onSaveTitle}
            onDeleteNode={onDeleteNode}
          />
        ),
        icon: isLeaf ? <FileTextOutlined /> : <BookOutlined />,
        isLeaf,
        children: isLeaf ? undefined : subChildren,
      };
    });
  }

  return buildChildren(null);
}

interface DirectorySidebarProps {
  projectId: string;
}

type DirectoryTreeDropInfo = Parameters<NonNullable<TreeProps['onDrop']>>[0];

export default function DirectorySidebar({ projectId }: DirectorySidebarProps) {
  const {
    scopedProjectId,
    directoryNodes,
    currentDirectoryVersionNumber,
    setDirectoryNodes,
    setCurrentDirectoryVersionId,
    setCurrentDirectoryVersionNumber,
    activeTabId,
    setCurrentOutline,
    setCurrentResult,
    setCitations,
    addTab,
  } = useEditorStore();
  const [loading, setLoading] = useState(false);
  const [editingNodeId, setEditingNodeId] = useState<string | null>(null);
  const [editingTitle, setEditingTitle] = useState('');

  // 会话恢复：捕获组件挂载时的初始选中节点，目录加载完成后执行一次性恢复
  // 用 getState() 读取一次，不订阅这两个值的后续变化
  const sessionRestoreNodeId = useRef<string | null>(
    (() => {
      const s = useEditorStore.getState();
      return s.selectedSectionNodeId ?? s.selectedChapterNodeId;
    })(),
  );
  const sessionRestored = useRef(false);

  const handleSaveTitle = useCallback(
    async (nodeId: string) => {
      if (!editingTitle.trim()) {
        setEditingNodeId(null);
        return;
      }
      try {
        const res = await contentService.updateDirectoryNode(projectId, nodeId, editingTitle.trim());
        if (res.success) {
          setDirectoryNodes(
            directoryNodes.map((n) => (n.node_id === nodeId ? { ...n, title: editingTitle.trim() } : n)),
          );
          message.success('节点标题已更新');
        } else {
          message.error('更新失败');
        }
      } catch {
        message.error('更新节点标题失败');
      } finally {
        setEditingNodeId(null);
      }
    },
    [directoryNodes, editingTitle, projectId, setDirectoryNodes],
  );

  const handleDeleteNode = useCallback(
    async (nodeId: string) => {
      try {
        const res = await contentService.deleteDirectoryNode(projectId, nodeId);
        if (res.success) {
          setDirectoryNodes(directoryNodes.filter((n) => n.node_id !== nodeId && n.parent_node_id !== nodeId));
          message.success('节点已删除');
        } else {
          message.error('删除失败');
        }
      } catch {
        message.error('删除节点失败');
      }
    },
    [directoryNodes, projectId, setDirectoryNodes],
  );

  const loadDirectory = useCallback(async () => {
    try {
      setLoading(true);
      // 用 getState() 读取当前版本 ID，避免将其加入 deps 导致自我循环重建
      const { currentDirectoryVersionId: versionId } = useEditorStore.getState();
      const preferredVersionId = scopedProjectId === projectId ? versionId : null;
      const { projectState: ps } = useProjectStore.getState();
      const targetVersionId =
        preferredVersionId ?? ps?.current_directory_version_id ?? null;
      const res = targetVersionId
        ? await projectService
            .getDirectoryVersion(projectId, targetVersionId)
            .catch(() => projectService.getDirectory(projectId))
        : await projectService.getDirectory(projectId);
      if (res.success && res.data) {
        const versionChanged = versionId != null && res.data.id !== versionId;
        setDirectoryNodes(res.data.content);
        setCurrentDirectoryVersionId(res.data.id);
        setCurrentDirectoryVersionNumber(res.data.version_number);
        if (versionChanged) {
          setCurrentOutline(null);
          setCurrentResult(null);
          setCitations([]);
        }
      }
    } catch {
      // silently fail - directory may not exist yet
    } finally {
      setLoading(false);
    }
  }, [
    projectId,
    scopedProjectId,
    setDirectoryNodes,
    setCurrentDirectoryVersionId,
    setCurrentDirectoryVersionNumber,
    setCurrentOutline,
    setCurrentResult,
    setCitations,
  ]);

  useEffect(() => {
    loadDirectory();
  }, [loadDirectory]);

  const handleDrop: TreeProps['onDrop'] = useCallback(
    async (info: DirectoryTreeDropInfo) => {
      const dragKey = String(info.dragNode.key);
      const dropKey = String(info.node.key);
      const dropPos = info.node.pos.split('-');
      const dropPosition = info.dropPosition - Number(dropPos[dropPos.length - 1]);

      const dragNode = directoryNodes.find((n) => n.node_id === dragKey);
      const dropNode = directoryNodes.find((n) => n.node_id === dropKey);
      if (!dragNode || !dropNode) return;

      // 不允许跨层级拖拽
      if (dragNode.node_type !== dropNode.node_type) {
        message.warning('不支持跨层级拖拽');
        return;
      }

      const siblings = directoryNodes
        .filter((n) => n.parent_node_id === dragNode.parent_node_id && n.node_type === dragNode.node_type)
        .sort((a, b) => a.order_index - b.order_index);

      const withoutDrag = siblings.filter((n) => n.node_id !== dragKey);
      const dropIdx = withoutDrag.findIndex((n) => n.node_id === dropKey);
      const insertIdx = dropPosition === -1 ? dropIdx : dropIdx + 1;
      withoutDrag.splice(insertIdx, 0, dragNode);

      const updated = directoryNodes.map((n) => {
        const newIdx = withoutDrag.findIndex((s) => s.node_id === n.node_id);
        return newIdx >= 0 ? { ...n, order_index: newIdx } : n;
      });

      setDirectoryNodes(updated);
      try {
        // 拖拽前查最新版本号，避免用 store 缓存导致 409
        const latestRes = await projectService.getDirectory(projectId);
        const latestVersionNumber = latestRes.success && latestRes.data
          ? latestRes.data.version_number
          : (currentDirectoryVersionNumber ?? 1);

        const res = await projectService.saveDirectory(projectId, {
          base_version_number: latestVersionNumber,
          nodes: updated,
        });
        if (res.success) {
          setDirectoryNodes(res.data.content);
          setCurrentDirectoryVersionId(res.data.id);
          setCurrentDirectoryVersionNumber(res.data.version_number);
        }
      } catch {
        message.error('排序保存失败');
        loadDirectory();
      }
    },
    [
      directoryNodes,
      projectId,
      currentDirectoryVersionNumber,
      setDirectoryNodes,
      setCurrentDirectoryVersionId,
      setCurrentDirectoryVersionNumber,
      loadDirectory,
    ],
  );

  const treeData = useMemo(
    () =>
      buildTreeData(
        directoryNodes,
        editingNodeId,
        editingTitle,
        setEditingNodeId,
        setEditingTitle,
        handleSaveTitle,
        handleDeleteNode,
      ),
    [directoryNodes, editingNodeId, editingTitle, handleSaveTitle, handleDeleteNode],
  );

  const openNodeTab = useCallback(
    (node: DirectoryNode) => {
      if (activeTabId === node.node_id) return;
      addTab({
        id: node.node_id,
        nodeId: node.node_id,
        nodeType: node.node_type,
        title: node.title,
        chapterNodeId: node.node_type === NodeType.CHAPTER ? node.node_id : (node.parent_node_id ?? null),
        sectionNodeId: node.node_type === NodeType.SECTION ? node.node_id : null,
      });
    },
    [activeTabId, addTab],
  );

  // 一次性会话恢复：仅在目录首次加载完成时执行，不响应后续 selectedChapterNodeId 变化
  useEffect(() => {
    if (sessionRestored.current || directoryNodes.length === 0) return;
    sessionRestored.current = true;

    const nodeId = sessionRestoreNodeId.current;
    if (!nodeId) return;

    const node = directoryNodes.find((n) => n.node_id === nodeId);
    if (!node) return;

    openNodeTab(node);
  }, [directoryNodes, openNodeTab]);

  const handleSelect = (selectedKeys: React.Key[]) => {
    if (selectedKeys.length === 0) return;
    const key = String(selectedKeys[0]);
    const node = directoryNodes.find((n) => n.node_id === key);
    if (!node) return;

    openNodeTab(node);
  };

  return (
    <div
      className="sidebar-dark"
      style={{
        display: 'flex',
        flexDirection: 'column',
        height: '100%',
        background:
          'radial-gradient(circle at top left, rgba(255,255,255,0.16), transparent 0 34%), linear-gradient(180deg, #0B69E3 0%, #1284F8 52%, #18A1FF 100%)',
        borderRadius: 20,
        overflow: 'hidden',
        boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.16)',
      }}
    >
      <div style={{ padding: '18px 18px 10px' }}>
        <span style={{ display: 'inline-block', fontSize: 11, fontWeight: 700, color: 'rgba(255,255,255,0.72)', letterSpacing: '0.12em', textTransform: 'uppercase', marginBottom: 8 }}>
          目录结构
        </span>
        <div style={{ fontSize: 18, fontWeight: 700, color: '#F8FBFF', letterSpacing: '-0.03em' }}>
          Chapter Tree
        </div>
        <div style={{ marginTop: 4, fontSize: 12, color: 'rgba(234,243,255,0.78)', lineHeight: 1.5 }}>
          选择章节或小节，继续生成大纲与正文。
        </div>
      </div>


      {/* 目录树 */}
      <div style={{ flex: 1, overflow: 'auto', padding: '4px 8px 12px' }}>
        {loading ? (
          <div style={{ textAlign: 'center', padding: 24 }}>
            <Spin size="small" />
          </div>
        ) : treeData.length === 0 ? (
          <Empty
            image={Empty.PRESENTED_IMAGE_SIMPLE}
            description={<span style={{ color: '#475569', fontSize: 12 }}>暂无目录</span>}
            style={{ padding: '24px 0' }}
          />
        ) : (
          <Tree
            showIcon
            defaultExpandAll
            virtual={false}
            focusable={false}
            draggable={{ icon: false }}
            onDrop={handleDrop}
            selectedKeys={activeTabId ? [activeTabId] : []}
            treeData={treeData}
            onSelect={handleSelect}
            style={{ background: 'transparent' }}
          />
        )}
      </div>
    </div>
  );
}
