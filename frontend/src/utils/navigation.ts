export function sanitizeRedirectPath(value: string | null | undefined, fallback = '/projects') {
  if (!value) {
    return fallback;
  }

  if (!value.startsWith('/') || value.startsWith('//')) {
    return fallback;
  }

  if (
    value === '/login' ||
    value.startsWith('/login?') ||
    value === '/register' ||
    value.startsWith('/register?')
  ) {
    return fallback;
  }

  return value;
}

export function buildLoginRedirect(targetPath: string) {
  return `/login?redirect=${encodeURIComponent(targetPath)}`;
}
