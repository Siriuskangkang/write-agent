'use client';

import { useCallback, useEffect, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { Form, Input, InputNumber, Select, Spin, message } from 'antd';
import {
  SaveOutlined,
  BookOutlined,
  EditOutlined,
} from '@ant-design/icons';
import { useProjectStore } from '@/stores/projectStore';
import { projectService } from '@/services/projectService';
import type { UpdateProjectData } from '@/services/projectService';

const textbookTypes = [
  { label: '高职教材', value: '高职教材' },
  { label: '本科教材', value: '本科教材' },
  { label: '培训教材', value: '培训教材' },
  { label: '校本教材', value: '校本教材' },
];

const writingStyles = [
  { label: '教材', value: '教材' },
  { label: '培训讲义', value: '培训讲义' },
  { label: '校本教材', value: '校本教材' },
];

function Label({ children, hint }: { children: React.ReactNode; hint?: string }) {
  return (
    <span style={{ fontSize: 13, fontWeight: 500, color: 'var(--text-primary)' }}>
      {children}
      {hint && <span style={{ fontSize: 11, color: 'var(--text-tertiary)', fontWeight: 400, marginLeft: 6 }}>{hint}</span>}
    </span>
  );
}

function SectionCard({ icon, title, children }: { icon: React.ReactNode; title: string; children: React.ReactNode }) {
  return (
    <div
      style={{
        background: '#FFFFFF',
        border: '1px solid #DCE8F8',
        borderRadius: 22,
        overflow: 'hidden',
        marginBottom: 16,
      }}
    >
      <div
        style={{
          padding: '16px 22px',
          borderBottom: '1px solid #E8F0FA',
          display: 'flex',
          alignItems: 'center',
          gap: 8,
        }}
      >
        <span style={{ color: '#1B74F0', fontSize: 13 }}>{icon}</span>
        <span style={{ fontSize: 13, fontWeight: 700, color: '#192877' }}>{title}</span>
      </div>
      <div style={{ padding: '22px 22px 20px' }}>{children}</div>
    </div>
  );
}

function ProjectSettingsContent() {
  const params = useParams();
  const router = useRouter();
  const projectId = params.id as string;
  const currentProject = useProjectStore((state) => state.currentProject);
  const [form] = Form.useForm();
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  const loadSettings = useCallback(async () => {
    try {
      setLoading(true);
      const [projectRes, stateRes] = await Promise.all([
        projectService.getProject(projectId),
        projectService.getProjectState(projectId).catch(() => null),
      ]);

      if (!projectRes.success) {
        message.error(projectRes.message ?? '加载项目设置失败');
        return;
      }

      form.setFieldsValue({
        name: projectRes.data.name,
        type: projectRes.data.type ?? undefined,
        target_audience: projectRes.data.target_audience ?? '',
        target_chapters: projectRes.data.target_chapters,
        style: projectRes.data.style,
        description: projectRes.data.description ?? '',
        user_notes: stateRes?.success ? (stateRes.data.user_notes ?? '') : '',
      });
    } catch {
      message.error('加载项目设置失败');
    } finally {
      setLoading(false);
    }
  }, [form, projectId]);

  useEffect(() => {
    loadSettings();
  }, [loadSettings]);

  const handleSave = async () => {
    try {
      const values = await form.validateFields();
      setSaving(true);

      const projectPayload: UpdateProjectData = {
        name: values.name,
        type: values.type,
        target_audience: values.target_audience || undefined,
        target_chapters: values.target_chapters,
        style: values.style,
        description: values.description || undefined,
      };

      const [projectRes, stateRes] = await Promise.all([
        projectService.updateProject(projectId, projectPayload),
        projectService.updateProjectState(projectId, { user_notes: values.user_notes || null }),
      ]);

      if (!projectRes.success) {
        message.error(projectRes.message ?? '保存项目设置失败');
        return;
      }

      if (!stateRes.success) {
        message.error(stateRes.message ?? '保存项目备注失败');
        return;
      }

      message.success('项目设置已保存');
      router.push(`/projects/${projectId}`);
    } catch (err: unknown) {
      if (err && typeof err === 'object' && 'errorFields' in err) return;
      message.error('保存项目设置失败');
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <div className="project-page-card" style={{ height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <Spin size="large" />
      </div>
    );
  }

  return (
    <div style={{ height: '100%', overflow: 'auto', paddingBottom: 8 }}>
      <div className="project-page-hero">
        <div>
          <h1>项目设置</h1>
          <p>维护教材基础信息、写作参数与协作备注。</p>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
          <button
            type="button"
            onClick={() => router.push(`/projects/${projectId}`)}
            style={{
              height: 38,
              padding: '0 14px',
              borderRadius: 14,
              border: '1px solid #DCE8F8',
              background: '#FFFFFF',
              color: '#5E7DA6',
              fontSize: 13,
              fontWeight: 700,
              cursor: 'pointer',
            }}
          >
            返回工作台
          </button>
          <span style={{ fontSize: 12, color: '#7F95B2' }}>{currentProject?.name ?? '当前项目'}</span>
        </div>
      </div>

      <div className="project-page-card" style={{ padding: 20 }}>
        <Form form={form} layout="vertical" requiredMark={false}>
          <SectionCard icon={<BookOutlined />} title="基础信息">
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0 20px' }}>
              <Form.Item
                name="name"
                label={<Label>教材名称</Label>}
                rules={[{ required: true, message: '请输入教材名称' }]}
                style={{ marginBottom: 16, gridColumn: '1 / -1' }}
              >
                <Input placeholder="请输入教材名称" style={{ height: 38, borderRadius: 12 }} />
              </Form.Item>

              <Form.Item name="type" label={<Label>教材类型</Label>} style={{ marginBottom: 16 }}>
                <Select options={textbookTypes} placeholder="请选择教材类型" style={{ height: 38 }} />
              </Form.Item>

              <Form.Item name="style" label={<Label>写作风格</Label>} style={{ marginBottom: 16 }}>
                <Select options={writingStyles} placeholder="请选择写作风格" style={{ height: 38 }} />
              </Form.Item>

              <Form.Item name="target_audience" label={<Label hint="可选">面向对象</Label>} style={{ marginBottom: 16 }}>
                <Input placeholder="如：高职计算机专业学生" style={{ height: 38, borderRadius: 12 }} />
              </Form.Item>

              <Form.Item name="target_chapters" label={<Label hint="可选">目标章节数</Label>} style={{ marginBottom: 16 }}>
                <InputNumber min={1} max={50} placeholder="如：10" style={{ width: '100%', height: 38, borderRadius: 12 }} />
              </Form.Item>
            </div>

            <Form.Item name="description" label={<Label hint="可选">项目描述</Label>} style={{ marginBottom: 0 }}>
              <Input.TextArea
                placeholder="简要描述本教材的内容和目标..."
                rows={4}
                style={{ borderRadius: 12, resize: 'none', fontSize: 13 }}
              />
            </Form.Item>
          </SectionCard>

          <SectionCard icon={<EditOutlined />} title="写作备注">
            <Form.Item name="user_notes" style={{ marginBottom: 8 }}>
              <Input.TextArea
                placeholder="记录当前写作约束、待补素材、协作备注等...&#10;AI 生成内容时会参考此备注"
                rows={6}
                style={{ borderRadius: 12, resize: 'vertical', fontSize: 13, lineHeight: 1.6 }}
              />
            </Form.Item>
            <p style={{ fontSize: 12, color: 'var(--text-tertiary)', margin: 0 }}>
              AI 生成内容时会参考此备注，可记录写作约束、待补充素材、特殊要求等。
            </p>
          </SectionCard>
        </Form>

        <div
          style={{
            marginTop: 4,
            paddingTop: 18,
            borderTop: '1px solid #E8F0FA',
            display: 'flex',
            justifyContent: 'flex-end',
            alignItems: 'center',
            gap: 10,
          }}
        >
          <button
            type="button"
            onClick={() => router.push(`/projects/${projectId}`)}
            style={{
              height: 38,
              padding: '0 16px',
              background: '#FFFFFF',
              border: '1px solid #DCE8F8',
              borderRadius: 14,
              fontSize: 13,
              color: '#5E7DA6',
              cursor: 'pointer',
            }}
          >
            取消
          </button>
          <button
            type="button"
            onClick={handleSave}
            disabled={saving}
            className="projects-create-btn"
            style={{ height: 38, opacity: saving ? 0.72 : 1 }}
          >
            <SaveOutlined style={{ fontSize: 12 }} />
            {saving ? '保存中...' : '保存设置'}
          </button>
        </div>
      </div>
    </div>
  );
}

export default function ProjectSettingsPage() {
  return <ProjectSettingsContent />;
}
