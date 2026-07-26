'use client';

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { App, Form, Input, Spin } from 'antd';
import { LockOutlined, UserOutlined } from '@ant-design/icons';
import AppShell from '@/components/layout/AppShell';
import { authService } from '@/services/authService';
import { useAuthStore } from '@/stores/authStore';

function Label({ children, hint }: { children: React.ReactNode; hint?: string }) {
  return (
    <span style={{ fontSize: 13, fontWeight: 500, color: 'var(--text-primary)' }}>
      {children}
      {hint && <span style={{ fontSize: 11, color: 'var(--text-tertiary)', fontWeight: 400, marginLeft: 6 }}>{hint}</span>}
    </span>
  );
}

function SettingsCard({
  title,
  icon,
  children,
  footer,
}: {
  title: string;
  icon: React.ReactNode;
  children: React.ReactNode;
  footer?: React.ReactNode;
}) {
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

      {footer && (
        <div
          style={{
            padding: '14px 22px',
            borderTop: '1px solid #E8F0FA',
            background: '#F8FBFF',
            display: 'flex',
            justifyContent: 'flex-end',
          }}
        >
          {footer}
        </div>
      )}
    </div>
  );
}

function SettingsContent() {
  const router = useRouter();
  const { message } = App.useApp();
  const { currentUser, setUser } = useAuthStore();
  const [profileForm] = Form.useForm();
  const [passwordForm] = Form.useForm();
  const [loading, setLoading] = useState(true);
  const [savingProfile, setSavingProfile] = useState(false);
  const [savingPassword, setSavingPassword] = useState(false);

  const loadMe = useCallback(async () => {
    try {
      setLoading(true);
      const me = await authService.getMe();
      setUser(me);
      profileForm.setFieldsValue({ email: me.email, nickname: me.nickname ?? '' });
    } catch {
      message.error('加载个人设置失败');
    } finally {
      setLoading(false);
    }
  }, [message, profileForm, setUser]);

  useEffect(() => {
    void loadMe();
  }, [loadMe]);

  const handleSaveProfile = async () => {
    try {
      const values = await profileForm.validateFields();
      setSavingProfile(true);
      const user = await authService.updateProfile({ nickname: values.nickname || undefined });
      setUser(user);
      profileForm.setFieldsValue({ email: user.email, nickname: user.nickname ?? '' });
      message.success('个人资料已保存');
    } catch (err: unknown) {
      if (err && typeof err === 'object' && 'errorFields' in err) return;
      message.error('保存个人资料失败');
    } finally {
      setSavingProfile(false);
    }
  };

  const handleUpdatePassword = async () => {
    try {
      const values = await passwordForm.validateFields();
      setSavingPassword(true);
      await authService.updatePassword({ old_password: values.old_password, new_password: values.new_password });
      passwordForm.resetFields();
      setUser(null);
      message.success('密码已更新，请重新登录');
      router.replace('/login');
    } catch (err: unknown) {
      if (err && typeof err === 'object' && 'errorFields' in err) return;
      message.error('修改密码失败，请确认原密码是否正确');
    } finally {
      setSavingPassword(false);
    }
  };

  const userInitial = (currentUser?.nickname?.slice(0, 1) || currentUser?.email?.slice(0, 1) || '?').toUpperCase();

  return (
    <AppShell
      activeNav="settings"
      title="账户中心"
      subtitle="维护个人资料、安全信息与应用偏好。"
    >
      <div className="project-page-hero">
        <div>
          <h1>个人设置</h1>
          <p>管理您的账号信息与登录密码。</p>
        </div>
      </div>

      {loading ? (
        <div className="project-page-card" style={{ minHeight: 420, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <Spin size="large" />
        </div>
      ) : (
        <div className="project-page-card" style={{ padding: 20, maxWidth: 820 }}>
          <SettingsCard
            title="个人资料"
            icon={<UserOutlined />}
            footer={(
              <button
                type="button"
                onClick={handleSaveProfile}
                disabled={savingProfile}
                className="projects-create-btn"
                style={{ height: 38, opacity: savingProfile ? 0.72 : 1 }}
              >
                {savingProfile ? '保存中...' : '保存资料'}
              </button>
            )}
          >
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 14,
                padding: '16px 18px',
                background: '#F8FBFF',
                borderRadius: 16,
                marginBottom: 22,
                border: '1px solid #E1ECFA',
              }}
            >
              <div
                style={{
                  width: 54,
                  height: 54,
                  borderRadius: 16,
                  flexShrink: 0,
                  background: 'linear-gradient(135deg, var(--brand-primary), var(--brand-accent))',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  fontSize: 20,
                  fontWeight: 700,
                  color: 'var(--text-inverse)',
                  boxShadow: '0 8px 18px rgba(37,99,235,0.20)',
                }}
              >
                {userInitial}
              </div>
              <div>
                <div style={{ fontSize: 16, fontWeight: 700, color: '#192877', lineHeight: 1.3 }}>
                  {currentUser?.nickname || '未设置昵称'}
                </div>
                <div style={{ fontSize: 12, color: '#6F86A7', marginTop: 3 }}>{currentUser?.email}</div>
              </div>
            </div>

            <Form form={profileForm} layout="vertical" requiredMark={false}>
              <Form.Item name="email" label={<Label>邮箱</Label>} style={{ marginBottom: 16 }}>
                <Input
                  prefix={<span style={{ color: 'var(--text-tertiary)', fontSize: 13 }}>@</span>}
                  disabled
                  style={{ height: 38, borderRadius: 12, background: '#F8FBFF', color: 'var(--text-secondary)', cursor: 'not-allowed' }}
                />
              </Form.Item>
              <Form.Item
                name="nickname"
                label={<Label hint="可选">昵称</Label>}
                rules={[{ max: 100, message: '昵称不能超过 100 个字符' }]}
                style={{ marginBottom: 0 }}
              >
                <Input
                  prefix={<UserOutlined style={{ color: 'var(--text-tertiary)' }} />}
                  placeholder="如何称呼您？"
                  style={{ height: 38, borderRadius: 12 }}
                />
              </Form.Item>
            </Form>
          </SettingsCard>

          <SettingsCard
            title="修改密码"
            icon={<LockOutlined />}
            footer={(
              <button
                type="button"
                onClick={handleUpdatePassword}
                disabled={savingPassword}
                className="projects-create-btn"
                style={{ height: 38, opacity: savingPassword ? 0.72 : 1 }}
              >
                {savingPassword ? '更新中...' : '更新密码'}
              </button>
            )}
          >
            <Form form={passwordForm} layout="vertical" requiredMark={false}>
              <Form.Item
                name="old_password"
                label={<Label>当前密码</Label>}
                rules={[{ required: true, message: '请输入当前密码' }]}
                style={{ marginBottom: 16 }}
              >
                <Input.Password
                  prefix={<LockOutlined style={{ color: 'var(--text-tertiary)' }} />}
                  placeholder="请输入当前密码"
                  style={{ height: 38, borderRadius: 12 }}
                />
              </Form.Item>
              <Form.Item
                name="new_password"
                label={<Label>新密码</Label>}
                rules={[
                  { required: true, message: '请输入新密码' },
                  { min: 8, message: '密码至少 8 位' },
                ]}
                style={{ marginBottom: 16 }}
              >
                <Input.Password
                  prefix={<LockOutlined style={{ color: 'var(--text-tertiary)' }} />}
                  placeholder="至少 8 位字符"
                  style={{ height: 38, borderRadius: 12 }}
                />
              </Form.Item>
              <Form.Item
                name="confirm_password"
                label={<Label>确认新密码</Label>}
                dependencies={['new_password']}
                rules={[
                  { required: true, message: '请确认新密码' },
                  ({ getFieldValue }) => ({
                    validator(_, value) {
                      if (!value || getFieldValue('new_password') === value) return Promise.resolve();
                      return Promise.reject(new Error('两次输入的密码不一致'));
                    },
                  }),
                ]}
                style={{ marginBottom: 0 }}
              >
                <Input.Password
                  prefix={<LockOutlined style={{ color: 'var(--text-tertiary)' }} />}
                  placeholder="再次输入新密码"
                  style={{ height: 38, borderRadius: 12 }}
                />
              </Form.Item>
            </Form>
          </SettingsCard>
        </div>
      )}
    </AppShell>
  );
}

export default function SettingsPage() {
  return <SettingsContent />;
}
