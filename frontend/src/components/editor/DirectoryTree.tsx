'use client';

import { Tree, Tag } from 'antd';
import type { DataNode } from 'antd/es/tree';
import { useEditorStore } from '@/stores/editorStore';
import { NodeType, MaterialSupport, type DirectoryNode } from '@/types';

export default function DirectoryTree() {
  const { directoryNodes, selectedChapterNodeId, selectedSectionNodeId, setSelectedChapterNodeId, setSelectedSectionNodeId } = useEditorStore();

  const getMaterialSupportColor = (support?: MaterialSupport) => {
    switch (support) {
      case MaterialSupport.HIGH:
        return 'green';
      case MaterialSupport.MEDIUM:
        return 'orange';
      case MaterialSupport.LOW:
        return 'red';
      default:
        return 'default';
    }
  };

  const buildTreeData = (nodes: DirectoryNode[]): DataNode[] => {
    const chapters = nodes.filter((n) => n.node_type === NodeType.CHAPTER).sort((a, b) => a.order_index - b.order_index);

    return chapters.map((chapter) => {
      const sections = nodes
        .filter((n) => n.node_type === NodeType.SECTION && n.parent_node_id === chapter.node_id)
        .sort((a, b) => a.order_index - b.order_index);

      return {
        key: chapter.node_id,
        title: (
          <span>
            {chapter.title}
            {chapter.material_support && (
              <Tag color={getMaterialSupportColor(chapter.material_support)} style={{ marginLeft: 8 }}>
                {chapter.material_support}
              </Tag>
            )}
          </span>
        ),
        children: sections.map((section) => ({
          key: section.node_id,
          title: (
            <span>
              {section.title}
              {section.material_support && (
                <Tag color={getMaterialSupportColor(section.material_support)} style={{ marginLeft: 8 }}>
                  {section.material_support}
                </Tag>
              )}
            </span>
          ),
        })),
      };
    });
  };

  const handleSelect = (selectedKeys: React.Key[]) => {
    if (selectedKeys.length === 0) return;

    const nodeId = selectedKeys[0] as string;
    const node = directoryNodes.find((n) => n.node_id === nodeId);

    if (!node) return;

    if (node.node_type === NodeType.CHAPTER) {
      setSelectedChapterNodeId(nodeId);
      setSelectedSectionNodeId(null);
    } else if (node.node_type === NodeType.SECTION) {
      setSelectedSectionNodeId(nodeId);
      setSelectedChapterNodeId(node.parent_node_id);
    }
  };

  const selectedKeys = selectedSectionNodeId ? [selectedSectionNodeId] : selectedChapterNodeId ? [selectedChapterNodeId] : [];

  return (
    <Tree
      treeData={buildTreeData(directoryNodes)}
      selectedKeys={selectedKeys}
      onSelect={handleSelect}
      defaultExpandAll
      showLine
      style={{ background: 'transparent' }}
    />
  );
}
