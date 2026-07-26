'use client';

import { useEffect } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { Dropdown, Spin, message } from 'antd';
import {
  BookOutlined,
  FileTextOutlined,
  HomeOutlined,
  LogoutOutlined,
  SettingOutlined,
} from '@ant-design/icons';
import AuthGuard from '@/components/common/AuthGuard';
import { authService } from '@/services/authService';
import { projectService } from '@/services/projectService';
import { useAuthStore } from '@/stores/authStore';
import { useProjectStore } from '@/stores/projectStore';
import { ProjectStatus } from '@/types';

const statusConfig: Record<ProjectStatus, { label: string; color: string; background: string }> = {
  [ProjectStatus.DRAFT]: {
    label: '草稿',
    color: '#2D6FCE',
    background: '#EAF3FF',
  },
  [ProjectStatus.IN_PROGRESS]: {
    label: '编写中',
    color: '#0F8A63',
    background: '#E9FBF4',
  },
  [ProjectStatus.COMPLETED]: {
    label: '已完成',
    color: '#6B37D4',
    background: '#F2EBFF',
  },
};

function BrandMark() {
  return (
    <div className="project-shell-brand-mark">
      <span />
      <span />
      <span />
    </div>
  );
}

export default function ProjectShell({
  projectId,
  children,
}: {
  projectId: string;
  children: React.ReactNode;
}) {
  const pathname = usePathname();
  const router = useRouter();
  const { currentProject, setCurrentProject, setProjectState } = useProjectStore();
  const { currentUser, logout: clearAuth } = useAuthStore();

  useEffect(() => {
    let cancelled = false;

    setCurrentProject(null);
    setProjectState(null);

    projectService
      .getProject(projectId)
      .then((res) => {
        if (cancelled) {
          return;
        }

        if (res.success) {
          setCurrentProject(res.data);
        } else {
          message.error(res.message ?? '加载项目失败');
          router.replace('/projects');
        }
      })
      .catch(() => {
        if (!cancelled) {
          message.error('加载项目失败');
          router.replace('/projects');
        }
      });

    return () => {
      cancelled = true;
    };
  }, [projectId, router, setCurrentProject, setProjectState]);

  const handleLogout = async () => {
    try {
      await authService.logout();
    } catch {
      /* ignore logout error */
    }

    clearAuth();
    router.replace('/login');
  };

  const navItems: Array<{ href: string; label: string; description: string; icon: React.ReactNode; disabled?: boolean }> = [
    {
      href: `/projects/${projectId}`,
      label: '工作台',
      description: '目录、大纲与正文协同编写',
      icon: <HomeOutlined />,
    },
    {
      href: `/projects/${projectId}/materials`,
      label: '素材',
      description: '上传与管理参考资料',
      icon: <FileTextOutlined />,
    },
    {
      href: `/projects/${projectId}/settings`,
      label: '设置',
      description: '调整项目配置与导出参数',
      icon: <SettingOutlined />,
    },
    {
      href: `/projects/${projectId}/style-templates`,
      label: '体例',
      description: '体例规范配置',
      icon: <BookOutlined />,
    },
  ];

  const userName = currentUser?.nickname || currentUser?.email || '未登录用户';
  const userInitial = (currentUser?.nickname?.slice(0, 1) || currentUser?.email?.slice(0, 1) || '?').toUpperCase();
  const status = currentProject ? statusConfig[currentProject.status] : null;

  return (
    <AuthGuard>
      <div className="project-shell-page">
        <div className="project-shell-frame">
          <header className="project-shell-header">
            <div className="project-shell-header-left">
              <Link href="/projects" className="project-shell-brand">
                <BrandMark />
                <span>灵思睿著</span>
              </Link>

              <div className="project-shell-divider" />

              <div className="project-shell-project-meta">
                {currentProject ? (
                  <>
                    <div className="project-shell-project-title">{currentProject.name}</div>
                    {status && (
                      <span
                        className="project-shell-status"
                        style={{ color: status.color, background: status.background }}
                      >
                        <span
                          style={{
                            width: 6,
                            height: 6,
                            borderRadius: '50%',
                            background: status.color,
                            flexShrink: 0,
                          }}
                        />
                        {status.label}
                      </span>
                    )}
                  </>
                ) : (
                  <div className="project-shell-loading">
                    <Spin size="small" />
                    <span>加载项目中...</span>
                  </div>
                )}
              </div>
            </div>

            <div className="project-shell-header-right">
              <Dropdown
                placement="bottomRight"
                trigger={['click']}
                menu={{
                  items: [
                    {
                      key: 'global-settings',
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
                <button type="button" className="project-shell-user-btn">
                  <span className="project-shell-user-avatar">{userInitial}</span>
                  <span className="project-shell-user-text">
                    <strong>{userName}</strong>
                    <span>项目空间</span>
                  </span>
                </button>
              </Dropdown>
            </div>
          </header>

          <div className="project-shell-subnav">
            {navItems.map((item) => {
              const isActive = pathname === item.href;

              if (item.disabled) {
                return (
                  <button
                    key={item.label}
                    type="button"
                    className="project-shell-subnav-item disabled"
                    onClick={() => message.info('未上线，敬请期待')}
                  >
                    <span className="project-shell-subnav-item-icon">{item.icon}</span>
                    <span className="project-shell-subnav-item-text">
                      <span className="project-shell-subnav-item-label">{item.label}</span>
                      <span className="project-shell-subnav-item-description">{item.description}</span>
                    </span>
                  </button>
                );
              }

              return (
                <Link
                  key={item.href}
                  href={item.href!}
                  className={`project-shell-subnav-item${isActive ? ' active' : ''}`}
                >
                  <span className="project-shell-subnav-item-icon">{item.icon}</span>
                  <span className="project-shell-subnav-item-text">
                    <span className="project-shell-subnav-item-label">{item.label}</span>
                    <span className="project-shell-subnav-item-description">{item.description}</span>
                  </span>
                </Link>
              );
            })}
          </div>

          <main className="project-shell-body">{children}</main>
        </div>
      </div>
    </AuthGuard>
  );
}
