'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Form, Input, Button, App } from 'antd';
import { MailOutlined, LockOutlined, UserOutlined } from '@ant-design/icons';
import AuthShell from '@/components/layout/AuthShell';
import { authService } from '@/services/authService';

interface RegisterForm {
  email: string;
  password: string;
  confirmPassword: string;
  nickname?: string;
}

export default function RegisterPage() {
  const router = useRouter();
  const { message } = App.useApp();
  const [loading, setLoading] = useState(false);

  const redirectParam = typeof window !== 'undefined'
    ? new URLSearchParams(window.location.search).get('redirect')
    : null;
  const loginHref = `/login${redirectParam ? `?redirect=${encodeURIComponent(redirectParam)}` : ''}`;

  const onFinish = async (values: RegisterForm) => {
    setLoading(true);
    try {
      await authService.register({
        email: values.email,
        password: values.password,
        nickname: values.nickname || undefined,
      });
      message.success('注册成功，请登录');
      router.replace(loginHref);
    } catch {
      message.error('注册失败，该邮箱可能已被注册');
    } finally {
      setLoading(false);
    }
  };

  return (
    <AuthShell
      title="教材编写助手"
      subtitle="创建账号，开始使用统一教材工作台。"
      footerPrompt="已有账号？"
      footerHref={loginHref}
      footerLabel="返回登录"
    >
      <Form<RegisterForm> layout="vertical" onFinish={onFinish} autoComplete="off" requiredMark={false}>
        <Form.Item
          name="email"
          label={<span style={{ fontSize: 13, fontWeight: 500, color: 'var(--text-primary)' }}>邮箱</span>}
          rules={[
            { required: true, message: '请输入邮箱' },
            { type: 'email', message: '请输入有效的邮箱地址' },
          ]}
          style={{ marginBottom: 14 }}
        >
          <Input
            prefix={<MailOutlined style={{ color: 'var(--text-tertiary)', fontSize: 14 }} />}
            placeholder="请输入邮箱地址"
            style={{ height: 42, borderRadius: 14, fontSize: 13 }}
          />
        </Form.Item>

        <Form.Item
          name="password"
          label={<span style={{ fontSize: 13, fontWeight: 500, color: 'var(--text-primary)' }}>密码</span>}
          rules={[
            { required: true, message: '请输入密码' },
            { min: 8, message: '密码至少8位' },
          ]}
          style={{ marginBottom: 14 }}
        >
          <Input.Password
            prefix={<LockOutlined style={{ color: 'var(--text-tertiary)', fontSize: 14 }} />}
            placeholder="至少 8 位字符"
            style={{ height: 42, borderRadius: 14, fontSize: 13 }}
          />
        </Form.Item>

        <Form.Item
          name="confirmPassword"
          label={<span style={{ fontSize: 13, fontWeight: 500, color: 'var(--text-primary)' }}>确认密码</span>}
          dependencies={['password']}
          rules={[
            { required: true, message: '请确认密码' },
            ({ getFieldValue }) => ({
              validator(_, value) {
                if (!value || getFieldValue('password') === value) return Promise.resolve();
                return Promise.reject(new Error('两次输入的密码不一致'));
              },
            }),
          ]}
          style={{ marginBottom: 14 }}
        >
          <Input.Password
            prefix={<LockOutlined style={{ color: 'var(--text-tertiary)', fontSize: 14 }} />}
            placeholder="再次输入密码"
            style={{ height: 42, borderRadius: 14, fontSize: 13 }}
          />
        </Form.Item>

        <Form.Item
          name="nickname"
          label={
            <span style={{ fontSize: 13, fontWeight: 500, color: 'var(--text-primary)' }}>
              昵称
              <span style={{ fontSize: 11, color: 'var(--text-tertiary)', fontWeight: 400, marginLeft: 6 }}>可选</span>
            </span>
          }
          style={{ marginBottom: 24 }}
        >
          <Input
            prefix={<UserOutlined style={{ color: 'var(--text-tertiary)', fontSize: 14 }} />}
            placeholder="如何称呼您？"
            style={{ height: 42, borderRadius: 14, fontSize: 13 }}
          />
        </Form.Item>

        <Button
          type="primary"
          htmlType="submit"
          loading={loading}
          block
          style={{
            height: 44,
            borderRadius: 14,
            fontSize: 14,
            fontWeight: 700,
            background: 'var(--brand-primary)',
            border: 'none',
            boxShadow: '0 8px 18px rgba(37,99,235,0.25)',
          }}
        >
          {loading ? '注册中...' : '创建账号'}
        </Button>
      </Form>
    </AuthShell>
  );
}
