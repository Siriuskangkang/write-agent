import ky from 'ky';
import { buildLoginRedirect } from '@/utils/navigation';

const api = ky.create({
  prefixUrl: '/api',
  credentials: 'include',
  hooks: {
    afterResponse: [
      async (_request, _options, response) => {
        if (response.status === 401) {
          try {
            await ky.post('/api/auth/refresh', { credentials: 'include' });
            return ky(_request, _options);
          } catch {
            if (typeof window !== 'undefined') {
              const currentPath = `${window.location.pathname}${window.location.search}${window.location.hash}`;
              window.location.href = buildLoginRedirect(currentPath);
            }
          }
        }
        return response;
      },
    ],
  },
});

export default api;
