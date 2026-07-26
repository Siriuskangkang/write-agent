'use client';

import { ConfigProvider, App } from 'antd';
import zhCN from 'antd/locale/zh_CN';

export default function AntdProvider({ children }: { children: React.ReactNode }) {
  return (
    <ConfigProvider
      locale={zhCN}
      theme={{
        token: {
          colorPrimary: '#2563EB',
          colorSuccess: '#10B981',
          colorWarning: '#F59E0B',
          colorError: '#EF4444',
          colorInfo: '#2563EB',
          borderRadius: 6,
          borderRadiusSM: 4,
          borderRadiusLG: 8,
          colorBgContainer: '#FFFFFF',
          colorBgLayout: '#F8FAFC',
          colorBorder: '#E2E8F0',
          colorBorderSecondary: '#F1F5F9',
          colorText: '#192877',
          colorTextSecondary: '#64748B',
          colorTextTertiary: '#94A3B8',
          colorTextQuaternary: '#CBD5E1',
          fontFamily: '-apple-system, "PingFang SC", "Microsoft YaHei", "Helvetica Neue", sans-serif',
          fontSize: 13,
          fontSizeSM: 12,
          lineHeight: 1.6,
          controlHeight: 30,
          controlHeightSM: 26,
          controlHeightLG: 36,
          paddingXS: 6,
          paddingSM: 10,
          padding: 14,
          boxShadow: 'none',
          boxShadowSecondary: 'none',
        },
        components: {
          Button: {
            boxShadow: 'none',
            boxShadowSecondary: 'none',
            primaryShadow: 'none',
            defaultShadow: 'none',
            dangerShadow: 'none',
          },
          Input: {
            boxShadow: 'none',
            activeShadow: 'none',
          },
          Select: {
            boxShadow: 'none',
          },
          Layout: {
            headerBg: '#FFFFFF',
            headerHeight: 48,
            headerPadding: '0 20px',
            siderBg: '#FFFFFF',
            bodyBg: '#F8FAFC',
          },
          Tree: {
            nodeHoverBg: 'rgba(255,255,255,0.06)',
            nodeSelectedBg: 'rgba(37,99,235,0.15)',
            titleHeight: 28,
          },
          Tag: {
            borderRadiusSM: 4,
          },
          Card: {
            boxShadow: 'none',
            boxShadowTertiary: 'none',
          },
          Divider: {
            colorSplit: '#E2E8F0',
          },
          Alert: {
            borderRadiusLG: 6,
          },
        },
      }}
    >
      <App>{children}</App>
    </ConfigProvider>
  );
}
