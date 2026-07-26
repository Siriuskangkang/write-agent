'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Dropdown, message } from 'antd';
import {
  HomeOutlined,
  LogoutOutlined,
  SettingOutlined,
} from '@ant-design/icons';
import AuthGuard from '@/components/common/AuthGuard';
import { authService } from '@/services/authService';
import { useAuthStore } from '@/stores/authStore';

type AppNavKey = 'projects' | 'settings';

export default function AppShell({
  activeNav,
  title,
  subtitle,
  children,
}: {
  activeNav: AppNavKey;
  title: string;
  subtitle: string;
  children: React.ReactNode;
}) {
  const router = useRouter();
  const { currentUser, logout: clearAuth } = useAuthStore();

  const handleLogout = async () => {
    try {
      await authService.logout();
    } catch {
      /* ignore logout error */
    }

    clearAuth();
    router.replace('/login');
  };

  const userName = currentUser?.nickname || currentUser?.email || '未登录用户';
  const userInitial = (currentUser?.nickname?.slice(0, 1) || currentUser?.email?.slice(0, 1) || '?').toUpperCase();

  const dropIcon = (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
      <path d="M12 2C12 2 4 10.5 4 15.5a8 8 0 0 0 16 0C20 10.5 12 2 12 2z"/>
    </svg>
  );

  const navItems: Array<{ key: string; icon: React.ReactNode; label: string; href: string | null }> = [
    { key: 'billing', icon: dropIcon, label: '我的账单', href: null },
    { key: 'projects', icon: <HomeOutlined />, label: '我的教材', href: '/projects' },
    { key: 'settings', icon: <SettingOutlined />, label: '个人设置', href: '/settings' },
  ];

  return (
    <AuthGuard>
      <div className="app-shell-page">
        <div className="app-shell-frame">
          <aside className="app-shell-sidebar">
            <nav className="app-shell-sidebar-nav">
              {navItems.map((item) =>
                item.href ? (
                  <Link
                    key={item.key}
                    href={item.href}
                    className={`app-shell-sidebar-item${activeNav === item.key ? ' active' : ''}`}
                  >
                    <span className="app-shell-sidebar-item-icon">{item.icon}</span>
                    <span className="app-shell-sidebar-item-label">{item.label}</span>
                  </Link>
                ) : (
                  <button
                    key={item.key}
                    type="button"
                    className="app-shell-sidebar-item"
                    onClick={() => message.warning('暂无权限，请联系管理员开通')}
                  >
                    <span className="app-shell-sidebar-item-icon">{item.icon}</span>
                    <span className="app-shell-sidebar-item-label">{item.label}</span>
                  </button>
                )
              )}
            </nav>

            <div className="app-shell-sidebar-footer">
              <Dropdown
                placement="bottomRight"
                trigger={['click']}
                menu={{
                  items: [
                    {
                      key: 'settings',
                      icon: <SettingOutlined />,
                      label: '个人设置',
                      onClick: () => router.push('/settings'),
                    },
                    { type: 'divider' as const },
                    {
                      key: 'logout',
                      icon: <LogoutOutlined />,
                      label: '退出登录',
                      danger: true,
                      onClick: handleLogout,
                    },
                  ],
                }}
              >
                <button type="button" className="app-shell-user-trigger app-shell-user-trigger-sidebar">
                  <span className="app-shell-user-avatar">{userInitial}</span>
                  <span className="app-shell-user-meta">
                    <strong>{userName}</strong>
                    <span>应用空间</span>
                  </span>
                </button>
              </Dropdown>
            </div>
          </aside>

          <div className="app-shell-content-shell">
            <div className="app-shell-content">
              <header className="app-shell-topbar">
                <div className="app-shell-topbar-title">
                  <h1>{title}</h1>
                  <p>{subtitle}</p>
                </div>
              </header>

              <main className="app-shell-main">{children}</main>
            </div>
          </div>
        </div>
      </div>
    </AuthGuard>
  );
}
