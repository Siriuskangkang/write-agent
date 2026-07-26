export interface StyleTreeNode {
  id?: string;
  title: string;
  children: StyleTreeNode[];
  requirement?: string;
}

export interface PanelAssignment {
  panel_a: StyleTreeNode[];
  panel_b: StyleTreeNode[];
  panel_c?: StyleTreeNode[];
}

export interface StyleFeatures {
  structure_tree: StyleTreeNode;
  panel_assignment?: PanelAssignment;
}
