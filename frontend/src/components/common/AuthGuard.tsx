'use client';

import { useEffect } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { Spin } from 'antd';
import { useAuthStore } from '@/stores/authStore';
import { authService } from '@/services/authService';
import { buildLoginRedirect } from '@/utils/navigation';

export default function AuthGuard({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const { isAuthenticated, isBootstrapping, setUser, setBootstrapping } = useAuthStore();

  useEffect(() => {
    if (isAuthenticated) {
      setBootstrapping(false);
      return;
    }

    let cancelled = false;

    authService
      .getMe()
      .then((user) => {
        if (!cancelled) {
          setUser(user);
          setBootstrapping(false);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setBootstrapping(false);
          const search = typeof window !== 'undefined' ? window.location.search : '';
          router.replace(buildLoginRedirect(`${pathname}${search}`));
        }
      });

    return () => {
      cancelled = true;
    };
  }, [isAuthenticated, pathname, router, setUser, setBootstrapping]);

  if (isBootstrapping) {
    return (
      <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', height: '100vh' }}>
        <Spin size="large" />
      </div>
    );
  }

  if (!isAuthenticated) {
    return null;
  }

  return <>{children}</>;
}
