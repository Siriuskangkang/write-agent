import { create } from 'zustand';
import { devtools } from 'zustand/middleware';
import type { User } from '@/types';

interface AuthState {
  currentUser: User | null;
  isAuthenticated: boolean;
  isBootstrapping: boolean;
  setUser: (user: User | null) => void;
  setBootstrapping: (v: boolean) => void;
  logout: () => void;
}

export const useAuthStore = create<AuthState>()(
  devtools(
    (set) => ({
      currentUser: null,
      isAuthenticated: false,
      isBootstrapping: true,
      setUser: (user) => set({ currentUser: user, isAuthenticated: !!user }),
      setBootstrapping: (v) => set({ isBootstrapping: v }),
      logout: () => set({ currentUser: null, isAuthenticated: false }),
    }),
    { name: 'AuthStore', enabled: process.env.NODE_ENV === 'development' }
  )
);
