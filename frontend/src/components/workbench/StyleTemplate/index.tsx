'use client';

import React, { useState, useEffect } from 'react';
import { useParams } from 'next/navigation';
import { Layout, Card, Button, message, Spin, Space } from 'antd';
import { EditOutlined, FormOutlined, AppstoreOutlined } from '@ant-design/icons';
import { StyleTemplateUpload } from './StyleTemplateUpload';
import { StyleTemplateAnalyzing } from './StyleTemplateAnalyzing';
import { StyleTemplatePreview } from './StyleTemplatePreview';
import { StyleTemplateEdit } from './StyleTemplateEdit';
import { StyleTemplatePanelSplit } from './StyleTemplatePanelSplit';
import { getProjectStyleTemplate } from '@/services/styleTemplateApi';
import type { StyleTemplate, StyleFeatures, StyleTemplateAnalysisResult, PanelAssignment } from './types';

const { Content } = Layout;

type ViewMode = 'upload' | 'analyzing' | 'preview' | 'edit' | 'panelSplit' | 'detail';

function treeHasIds(node: any): boolean {
  if (!node?.id) return false;
  return true;
}

export default function StyleTemplateContainer() {
  const params = useParams();
  const projectId = params.id as string;
  const [viewMode, setViewMode] = useState<ViewMode>('upload');
  const [loading, setLoading] = useState(true);
  const [currentTemplate, setCurrentTemplate] = useState<StyleTemplate | null>(null);
  const [uploadingTemplateId, setUploadingTemplateId] = useState<string | null>(null);
  const [editingFeatures, setEditingFeatures] = useState<StyleFeatures | null>(null);

  useEffect(() => {
    if (projectId) {
      loadCurrentTemplate();
    }
  }, [projectId]);

  const loadCurrentTemplate = async () => {
    try {
      setLoading(true);
      const template = await getProjectStyleTemplate(projectId);
      setCurrentTemplate(template);

      if (!template) {
        setViewMode('upload');
      } else if (template.status === 'completed' && template.features) {
        const hasIds = treeHasIds(template.features.structure_tree);
        const hasPanelAssignment = !!template.features.panel_assignment;
        if (hasIds && !hasPanelAssignment) {
          setViewMode('panelSplit');
        } else {
          setViewMode('detail');
        }
      } else if (template.status === 'analyzing') {
        setUploadingTemplateId(template.id);
        setViewMode('analyzing');
      } else {
        setViewMode('upload');
      }
    } catch (error) {
      message.error('加载体例失败');
    } finally {
      setLoading(false);
    }
  };

  const handleUploadSuccess = (templateId: string) => {
    setUploadingTemplateId(templateId);
    setViewMode('analyzing');
  };

  const handleAnalysisComplete = async (_result: StyleTemplateAnalysisResult) => {
    try {
      const template = await getProjectStyleTemplate(projectId);
      if (template) {
        setCurrentTemplate(template);
        setViewMode('preview');
      } else {
        message.error('获取分析结果失败');
        setViewMode('upload');
      }
    } catch (error) {
      console.error('[StyleTemplate] Failed to fetch template after analysis:', error);
      message.error('获取分析结果失败');
      setViewMode('upload');
    }
  };

  const handleConfirm = () => {
    if (currentTemplate?.features && treeHasIds(currentTemplate.features.structure_tree)) {
      setViewMode('panelSplit');
    } else {
      setViewMode('detail');
      message.success('体例已应用到项目');
    }
  };

  const handlePanelSave = async (data: { tree: import('./types').StyleTreeNode; panel_assignment: PanelAssignment }) => {
    if (!currentTemplate) return;
    try {
      const { updateStyleTemplate } = await import('@/services/styleTemplateApi');
      const updatedFeatures = {
        ...currentTemplate.features!,
        structure_tree: data.tree,
        panel_assignment: data.panel_assignment,
      };
      await updateStyleTemplate(currentTemplate.id, projectId, { features: updatedFeatures });
      setCurrentTemplate({
        ...currentTemplate,
        features: updatedFeatures,
      });
      setViewMode('detail');
      message.success('分层设置已保存');
    } catch (error) {
      message.error('保存分层设置失败');
      throw error;
    }
  };

  const handlePanelSkip = () => {
    setViewMode('detail');
    message.info('已跳过分层设置');
  };

  const handleReupload = async () => {
    if (currentTemplate) {
      try {
        const { deleteStyleTemplate } = await import('@/services/styleTemplateApi');
        await deleteStyleTemplate(currentTemplate.id, projectId);
        message.success('已删除旧体例');
      } catch (error) {
        console.error('删除旧体例失败:', error);
      }
    }
    setCurrentTemplate(null);
    setViewMode('upload');
  };

  const handleEdit = () => {
    if (currentTemplate?.features) {
      setEditingFeatures(currentTemplate.features);
      setViewMode('edit');
    }
  };

  const handleSaveEdit = async (features: StyleFeatures) => {
    if (!currentTemplate) return;
    try {
      const { updateStyleTemplate } = await import('@/services/styleTemplateApi');
      await updateStyleTemplate(currentTemplate.id, projectId, { features });
      setCurrentTemplate({ ...currentTemplate, features });
      setViewMode('detail');
      message.success('体例已更新');
    } catch (error) {
      message.error('保存失败');
    }
  };

  const handleCancelEdit = () => {
    setEditingFeatures(null);
    setViewMode('detail');
  };

  if (loading) {
    return (
      <Content style={{ padding: '24px', textAlign: 'center' }}>
        <Spin size="large" />
      </Content>
    );
  }

  return (
    <Content style={{ padding: '24px' }}>
      {viewMode === 'upload' && (
        <Card title="输入体例内容">
          <StyleTemplateUpload
            projectId={projectId}
            onUploadSuccess={handleUploadSuccess}
            onUploadError={(error) => message.error(error)}
          />
        </Card>
      )}

      {viewMode === 'analyzing' && uploadingTemplateId && (
        <StyleTemplateAnalyzing
          templateId={uploadingTemplateId}
          projectId={projectId}
          onAnalysisComplete={handleAnalysisComplete}
          onAnalysisError={(error) => {
            message.error(error);
            setViewMode('upload');
          }}
        />
      )}

      {viewMode === 'preview' && currentTemplate && currentTemplate.features && (
        <StyleTemplatePreview
          result={{ features: currentTemplate.features }}
          onConfirm={handleConfirm}
          onEdit={handleEdit}
        />
      )}

      {viewMode === 'edit' && editingFeatures && (
        <StyleTemplateEdit
          initialFeatures={editingFeatures}
          onSave={handleSaveEdit}
          onCancel={handleCancelEdit}
        />
      )}

      {viewMode === 'panelSplit' && currentTemplate?.features?.structure_tree && (
        <Card>
          <StyleTemplatePanelSplit
            tree={currentTemplate.features.structure_tree}
            initialAssignment={currentTemplate.features.panel_assignment}
            onSave={handlePanelSave}
            onSkip={handlePanelSkip}
          />
        </Card>
      )}

      {viewMode === 'detail' && currentTemplate && currentTemplate.features && (
        <div style={{ padding: '24px' }}>
          <div style={{ marginBottom: 16, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <h2 style={{ margin: 0 }}>当前体例</h2>
            <Space>
              {treeHasIds(currentTemplate.features.structure_tree) && (
                <Button icon={<AppstoreOutlined />} onClick={() => setViewMode('panelSplit')}>
                  分层设置
                </Button>
              )}
              <Button icon={<EditOutlined />} onClick={handleEdit}>编辑</Button>
              <Button icon={<FormOutlined />} onClick={handleReupload}>重新输入</Button>
            </Space>
          </div>
          <StyleTemplatePreview
            result={{ features: currentTemplate.features }}
            onConfirm={() => {}}
            onEdit={() => {}}
            showActions={false}
          />
        </div>
      )}
    </Content>
  );
}
