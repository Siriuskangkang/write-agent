'use client';

import { useState } from 'react';
import { Form, Input, Select, InputNumber, message } from 'antd';
import { CloseOutlined, BookOutlined, TeamOutlined, AppstoreOutlined, EditOutlined, AlignLeftOutlined } from '@ant-design/icons';
import { projectService, type CreateProjectData } from '@/services/projectService';

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

interface CreateProjectModalProps {
  open: boolean;
  onClose: () => void;
  onCreated: () => void;
}

export default function CreateProjectModal({ open, onClose, onCreated }: CreateProjectModalProps) {
  const [form] = Form.useForm();
  const [loading, setLoading] = useState(false);

  const handleSubmit = async () => {
    try {
      const values = await form.validateFields();
      setLoading(true);
      const data: CreateProjectData = {
        name: values.name,
        type: values.type,
        target_audience: values.target_audience,
        target_chapters: values.target_chapters,
        style: values.style,
        description: values.description,
      };
      const res = await projectService.createProject(data);
      if (res.success) {
        message.success('教材创建成功');
        form.resetFields();
        onClose();
        onCreated();
      } else {
        message.error(res.message ?? '创建失败');
      }
    } catch (err: unknown) {
      if (err && typeof err === 'object' && 'errorFields' in err) return;
      message.error('创建教材失败，请重试');
    } finally {
      setLoading(false);
    }
  };

  const handleCancel = () => {
    form.resetFields();
    onClose();
  };

  if (!open) return null;

  return (
    <>
      {/* 遮罩 */}
      <div
        onClick={handleCancel}
        style={{
          position: 'fixed', inset: 0, zIndex: 1000,
          background: 'rgba(15,23,42,0.45)',
          backdropFilter: 'blur(4px)',
          animation: 'fadeIn 0.2s ease',
        }}
      />

      {/* 弹窗 */}
      <div style={{
        position: 'fixed', zIndex: 1001,
        top: '50%', left: '50%',
        transform: 'translate(-50%, -50%)',
        width: 520,
        background: '#fff',
        borderRadius: 16,
        overflow: 'hidden',
        animation: 'modalEnter 0.25s cubic-bezier(0.16,1,0.3,1)',
        boxShadow: '0 24px 64px rgba(15,23,42,0.18)',
      }}>
        {/* 顶部彩色横幅 */}
        <div style={{
          height: 72,
          background: 'linear-gradient(135deg, #1E3A8A 0%, #2563EB 55%, #4F46E5 100%)',
          position: 'relative',
          overflow: 'hidden',
          display: 'flex', alignItems: 'center',
          padding: '0 24px',
          gap: 12,
        }}>
          {/* 装饰圆 */}
          <div style={{ position: 'absolute', right: -24, top: -24, width: 100, height: 100, borderRadius: '50%', background: 'rgba(255,255,255,0.08)' }} />
          <div style={{ position: 'absolute', right: 40, bottom: -32, width: 70, height: 70, borderRadius: '50%', background: 'rgba(255,255,255,0.06)' }} />

          {/* 图标 */}
          <div style={{
            width: 36, height: 36, borderRadius: 10,
            background: 'rgba(255,255,255,0.18)',
            border: '1px solid rgba(255,255,255,0.25)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            flexShrink: 0,
          }}>
            <BookOutlined style={{ fontSize: 16, color: '#fff' }} />
          </div>

          <div>
            <div style={{ fontSize: 15, fontWeight: 700, color: '#fff', lineHeight: 1.3 }}>新建教材</div>
            <div style={{ fontSize: 12, color: 'rgba(255,255,255,0.65)', marginTop: 2 }}>填写基本信息，开始 AI 辅助创作</div>
          </div>

          {/* 关闭按钮 */}
          <button
            onClick={handleCancel}
            style={{
              position: 'absolute', right: 16, top: '50%', transform: 'translateY(-50%)',
              width: 28, height: 28, borderRadius: 7,
              background: 'rgba(255,255,255,0.15)',
              border: 'none', cursor: 'pointer',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              color: '#fff', transition: 'background 0.15s',
            }}
            onMouseEnter={e => (e.currentTarget.style.background = 'rgba(255,255,255,0.28)')}
            onMouseLeave={e => (e.currentTarget.style.background = 'rgba(255,255,255,0.15)')}
          >
            <CloseOutlined style={{ fontSize: 12 }} />
          </button>
        </div>

        {/* 表单区 */}
        <div style={{ padding: '24px 24px 20px' }}>
          <Form
            form={form}
            layout="vertical"
            initialValues={{ target_chapters: 10, style: '教材' }}
          >
            {/* 教材名称 */}
            <Form.Item
              name="name"
              label={<FieldLabel icon={<BookOutlined />} text="教材名称" required />}
              rules={[{ required: true, message: '请输入教材名称' }]}
              style={{ marginBottom: 16 }}
            >
              <Input
                placeholder="如：Python Web 开发实战教程"
                maxLength={100}
                style={{ borderRadius: 8, height: 36 }}
              />
            </Form.Item>

            {/* 两列：类型 + 风格 */}
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 16 }}>
              <Form.Item
                name="type"
                label={<FieldLabel icon={<AppstoreOutlined />} text="教材类型" />}
                style={{ marginBottom: 0 }}
              >
                <Select placeholder="请选择" options={textbookTypes} allowClear style={{ borderRadius: 8 }} />
              </Form.Item>
              <Form.Item
                name="style"
                label={<FieldLabel icon={<EditOutlined />} text="写作风格" />}
                style={{ marginBottom: 0 }}
              >
                <Select placeholder="请选择" options={writingStyles} allowClear />
              </Form.Item>
            </div>

            {/* 两列：面向对象 + 章节数 */}
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 16 }}>
              <Form.Item
                name="target_audience"
                label={<FieldLabel icon={<TeamOutlined />} text="面向对象" />}
                style={{ marginBottom: 0 }}
              >
                <Input placeholder="如：大二计算机专业" maxLength={200} style={{ borderRadius: 8, height: 36 }} />
              </Form.Item>
              <Form.Item
                name="target_chapters"
                label={<FieldLabel icon={<AppstoreOutlined />} text="目标章节数" />}
                style={{ marginBottom: 0 }}
              >
                <InputNumber min={1} max={50} style={{ width: '100%', borderRadius: 8 }} />
              </Form.Item>
            </div>

            {/* 描述 */}
            <Form.Item
              name="description"
              label={<FieldLabel icon={<AlignLeftOutlined />} text="描述（可选）" />}
              style={{ marginBottom: 0 }}
            >
              <Input.TextArea
                placeholder="简要描述教材内容和目标"
                rows={3}
                maxLength={500}
                showCount
                style={{ borderRadius: 8, resize: 'none' }}
              />
            </Form.Item>
          </Form>
        </div>

        {/* 底部按钮 */}
        <div style={{
          padding: '12px 24px 20px',
          display: 'flex', justifyContent: 'flex-end', gap: 8,
          borderTop: '1px solid #F1F5F9',
        }}>
          <button
            onClick={handleCancel}
            style={{
              height: 36, padding: '0 16px',
              background: '#F8FAFC', color: '#475569',
              border: '1px solid #E2E8F0', borderRadius: 8,
              fontSize: 13, fontWeight: 500, cursor: 'pointer',
              transition: 'background 0.15s',
            }}
            onMouseEnter={e => (e.currentTarget.style.background = '#F1F5F9')}
            onMouseLeave={e => (e.currentTarget.style.background = '#F8FAFC')}
          >
            取消
          </button>
          <button
            onClick={handleSubmit}
            disabled={loading}
            style={{
              height: 36, padding: '0 20px',
              background: loading ? '#93C5FD' : 'linear-gradient(135deg, #2563EB, #4F46E5)',
              color: '#fff',
              border: 'none', borderRadius: 8,
              fontSize: 13, fontWeight: 600, cursor: loading ? 'not-allowed' : 'pointer',
              transition: 'opacity 0.15s, transform 0.15s',
              position: 'relative', overflow: 'hidden',
            }}
            onMouseEnter={e => { if (!loading) e.currentTarget.style.opacity = '0.9'; }}
            onMouseLeave={e => { e.currentTarget.style.opacity = '1'; }}
          >
            {loading ? '创建中...' : '创建教材'}
          </button>
        </div>
      </div>
    </>
  );
}

function FieldLabel({ icon, text, required }: { icon: React.ReactNode; text: string; required?: boolean }) {
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 13, color: '#374151', fontWeight: 500 }}>
      <span style={{ color: '#94A3B8', fontSize: 12 }}>{icon}</span>
      {text}
      {required && <span style={{ color: '#EF4444', marginLeft: 1 }}>*</span>}
    </span>
  );
}
