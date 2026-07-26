'use client';

import { useState, useEffect, useMemo } from 'react';
import { useRouter } from 'next/navigation';
import { Form, Input, Button, Checkbox, App } from 'antd';
import { MailOutlined, LockOutlined, GlobalOutlined, ArrowRightOutlined } from '@ant-design/icons';
import { authService } from '@/services/authService';
import { useAuthStore } from '@/stores/authStore';
import { sanitizeRedirectPath } from '@/utils/navigation';

interface LoginForm {
  email: string;
  password: string;
  remember: boolean;
}

const REMEMBER_KEY = 'wa_remember_credentials';

const translations = {
  zh: {
    title: '灵思睿著',
    subtitle: 'AI 驱动的智能教材创作平台',
    description: '上传素材和体例，AI 自动生成目录、大纲和正文内容',
    emailPlaceholder: '邮箱地址',
    passwordPlaceholder: '密码',
    loginButton: '登录',
    rememberMe: '记住密码',
    features: ['智能生成', 'AI 辅助', '高效创作'],
    successMsg: '欢迎回来！🎉',
    errorMsg: '邮箱或密码错误',
    emailRequired: '请输入邮箱',
    emailInvalid: '请输入有效的邮箱地址',
    passwordRequired: '请输入密码',
  },
  en: {
    title: 'Textweaver',
    subtitle: 'AI-Powered Intelligent Content Creation Platform',
    description: 'Upload materials, AI generates outlines and content automatically',
    emailPlaceholder: 'Email address',
    passwordPlaceholder: 'Password',
    loginButton: 'Sign In',
    rememberMe: 'Remember me',
    features: ['Smart Generation', 'AI Assisted', 'Efficient Creation'],
    successMsg: 'Welcome back! 🎉',
    errorMsg: 'Invalid email or password',
    emailRequired: 'Please enter your email',
    emailInvalid: 'Please enter a valid email',
    passwordRequired: 'Please enter your password',
  },
};

export default function LoginPage() {
  const router = useRouter();
  const { message } = App.useApp();
  const setUser = useAuthStore((state) => state.setUser);
  const setBootstrapping = useAuthStore((state) => state.setBootstrapping);
  const [loading, setLoading] = useState(false);
  const [locale, setLocale] = useState<'zh' | 'en'>('zh');
  const [form] = Form.useForm();

  const t = translations[locale];

  const { redirectTarget, registerHref } = useMemo(() => {
    const param = typeof window !== 'undefined'
      ? new URLSearchParams(window.location.search).get('redirect')
      : null;
    return {
      redirectTarget: sanitizeRedirectPath(param),
      registerHref: `/register${param ? `?redirect=${encodeURIComponent(param)}` : ''}`,
    };
  }, []);

  useEffect(() => {
    try {
      const saved = localStorage.getItem(REMEMBER_KEY);
      if (saved) {
        const { email } = JSON.parse(saved);
        form.setFieldsValue({ email, remember: true });
      }
    } catch {
      // ignore malformed data
    }
  }, [form]);

  const onFinish = async (values: LoginForm) => {
    setLoading(true);
    try {
      const user = await authService.login(values);
      if (values.remember) {
        localStorage.setItem(REMEMBER_KEY, JSON.stringify({ email: values.email }));
      } else {
        localStorage.removeItem(REMEMBER_KEY);
      }
      setUser(user);
      setBootstrapping(false);
      message.success(t.successMsg);
      router.replace(redirectTarget);
      window.setTimeout(() => {
        if (window.location.pathname === '/login') {
          window.location.replace(redirectTarget);
        }
      }, 120);
    } catch {
      message.error(t.errorMsg);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="login-container">
      <div className="background-accent accent-1" />
      <div className="background-accent accent-2" />

      <div className="language-switcher">
        <button
          className="language-button"
          onClick={() => setLocale(locale === 'zh' ? 'en' : 'zh')}
        >
          <GlobalOutlined />
          {locale === 'zh' ? 'English' : '中文'}
        </button>
      </div>

      <div className="login-card">
        <div className="login-header">
          <h1 className="login-title">{t.title}</h1>
          <p className="login-subtitle">{t.subtitle}</p>
          <p className="login-description">{t.description}</p>
          <div className="feature-tags">
            {t.features.map((feature, index) => (
              <span key={index} className="feature-tag">{feature}</span>
            ))}
          </div>
        </div>

        <Form name="login" form={form} onFinish={onFinish} autoComplete="off" className="login-form">
          <Form.Item
            name="email"
            rules={[
              { required: true, message: t.emailRequired },
              { type: 'email', message: t.emailInvalid },
            ]}
          >
            <Input
              prefix={<MailOutlined style={{ color: '#94a3b8' }} />}
              placeholder={t.emailPlaceholder}
              size="large"
            />
          </Form.Item>

          <Form.Item
            name="password"
            rules={[{ required: true, message: t.passwordRequired }]}
          >
            <Input.Password
              prefix={<LockOutlined style={{ color: '#94a3b8' }} />}
              placeholder={t.passwordPlaceholder}
              size="large"
            />
          </Form.Item>

          <Form.Item name="remember" valuePropName="checked" style={{ marginBottom: 24 }}>
            <Checkbox style={{ fontSize: 14, color: '#6e6e73' }}>{t.rememberMe}</Checkbox>
          </Form.Item>

          <Form.Item>
            <Button
              type="primary"
              htmlType="submit"
              loading={loading}
              className="login-button"
              icon={<ArrowRightOutlined />}
              iconPosition="end"
            >
              {t.loginButton}
            </Button>
          </Form.Item>
        </Form>

        {/* <div className="login-footer">
          <span className="login-footer-text">
            {t.noAccount}
            <a href={registerHref} className="register-link">{t.register}</a>
          </span>
        </div> */}
      </div>
    </div>
  );
}
