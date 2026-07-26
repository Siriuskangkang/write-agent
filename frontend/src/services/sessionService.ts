import api from './api';
import type { ApiResponse, Message, PagedData, Session, MessageRole, MessageType } from '@/types';

export interface CreateSessionData {
  title?: string;
}

export interface CreateMessageData {
  role: MessageRole;
  content: string;
  message_type: MessageType;
  metadata?: Record<string, unknown>;
}

export const sessionService = {
  async listSessions(projectId: string): Promise<ApiResponse<Session[]>> {
    return api.get(`projects/${projectId}/sessions`).json();
  },

  async createSession(projectId: string, data: CreateSessionData = {}): Promise<ApiResponse<Session>> {
    return api.post(`projects/${projectId}/sessions`, { json: data }).json();
  },

  async listMessages(
    projectId: string,
    sessionId: string,
    params?: { page?: number; page_size?: number },
  ): Promise<ApiResponse<PagedData<Message>>> {
    return api
      .get(`projects/${projectId}/sessions/${sessionId}/messages`, {
        searchParams: params as Record<string, string | number> | undefined,
      })
      .json();
  },

  async createMessage(
    projectId: string,
    sessionId: string,
    data: CreateMessageData,
  ): Promise<ApiResponse<Message>> {
    return api.post(`projects/${projectId}/sessions/${sessionId}/messages`, { json: data }).json();
  },
};
