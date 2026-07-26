import api from './api';
import type { ApiResponse, User } from '@/types';

export interface LoginParams {
  email: string;
  password: string;
}

export interface RegisterParams {
  email: string;
  password: string;
  nickname?: string;
}

export interface UpdateProfileParams {
  nickname?: string;
}

export interface UpdatePasswordParams {
  old_password: string;
  new_password: string;
}

export const authService = {
  async login(params: LoginParams): Promise<User> {
    const res = await api.post('auth/login', { json: params }).json<ApiResponse<User>>();
    return res.data;
  },

  async register(params: RegisterParams): Promise<void> {
    await api.post('auth/register', { json: params }).json<ApiResponse<void>>();
  },

  async logout(): Promise<void> {
    await api.post('auth/logout').json<ApiResponse<void>>();
  },

  async refreshToken(): Promise<void> {
    await api.post('auth/refresh').json<ApiResponse<void>>();
  },

  async getMe(): Promise<User> {
    const res = await api.get('auth/me').json<ApiResponse<User>>();
    return res.data;
  },

  async updateProfile(params: UpdateProfileParams): Promise<User> {
    const res = await api.put('auth/profile', { json: params }).json<ApiResponse<User>>();
    return res.data;
  },

  async updatePassword(params: UpdatePasswordParams): Promise<void> {
    await api.put('auth/password', { json: params }).json<ApiResponse<void>>();
  },
};
