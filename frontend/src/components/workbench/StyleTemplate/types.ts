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

export interface StyleRule {
  category: string;
  description: string;
  example?: string;
}

export interface StyleTemplate {
  id: string;
  name: string;
  projectId: string;
  referenceFileIds: string[];
  features: StyleFeatures | null;
  status: 'pending' | 'analyzing' | 'completed' | 'failed';
  errorMessage: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface StyleTemplateAnalysisResult {
  features: StyleFeatures;
}

export interface UploadResponse {
  fileId: string;
}

export interface StyleTemplateData {
  name: string;
  rules: StyleRule[];
}
