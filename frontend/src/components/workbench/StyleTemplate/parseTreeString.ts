import type { DataNode } from 'antd/es/tree';

interface ParsedNode {
  title: string;
  level: number;
  children: ParsedNode[];
}

/**
 * 解析缩进树字符串为 Ant Design Tree 数据结构
 *
 * 支持纯缩进格式（每 2 个空格 = 1 级）：
 * 模块一
 *   项目一
 *     任务一
 *     任务二
 *   项目二
 *
 * 也兼容旧版 ASCII 字符格式（├─ └─ │），会自动剥离这些字符
 */
export function parseTreeString(text: string): DataNode[] {
  if (!text || typeof text !== 'string') return [];

  const lines = text.split('\n').filter((line) => line.trim());
  if (lines.length === 0) return [];

  const root: ParsedNode = { title: '', level: -1, children: [] };
  const stack: ParsedNode[] = [root];

  for (const line of lines) {
    // 计算行首空格数量（兼容 ASCII 字符：先剥离 ├─ └─ │ 计算缩进）
    const leadingSpaces = line.match(/^(\s*)/)?.[1] ?? '';
    let level = Math.floor(leadingSpaces.length / 2);

    // 剥离 ASCII 树形字符，提取实际内容
    const cleaned = line
      .replace(/^[\s│]*/, '')        // 去掉行首空格和竖线
      .replace(/^[├└]─\s*/, '')      // 去掉 ├─ 或 └─
      .trim();

    // 跳过空行、纯竖线行
    if (!cleaned || cleaned === '│') continue;

    // 对于旧格式（有 ASCII 字符的行），重新基于剥离后的缩进计算层级
    const asciiMatch = line.match(/^(\s*)(├─|└─)/);
    if (asciiMatch) {
      // ASCII 格式：缩进长度 / 4 大致对应层级（因为包含 │ 字符）
      level = Math.floor(asciiMatch[1].length / 2);
    }

    const node: ParsedNode = { title: cleaned, level, children: [] };

    // 找到父节点（栈中最后一个 level < 当前 level 的节点）
    while (stack.length > 1 && stack[stack.length - 1].level >= level) {
      stack.pop();
    }

    const parent = stack[stack.length - 1];
    parent.children.push(node);
    stack.push(node);
  }

  return convertToDataNodes(root.children);
}

function convertToDataNodes(nodes: ParsedNode[], parentKey = ''): DataNode[] {
  return nodes.map((node, index) => {
    const key = parentKey ? `${parentKey}-${index}` : `${index}`;
    return {
      title: node.title,
      key,
      children: node.children.length > 0 ? convertToDataNodes(node.children, key) : undefined,
    };
  });
}
