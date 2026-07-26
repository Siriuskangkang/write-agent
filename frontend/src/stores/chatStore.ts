import { create } from 'zustand';
import { devtools } from 'zustand/middleware';
import type { Session, Message } from '@/types';

interface ChatState {
  sessions: Session[];
  currentSessionId: string | null;
  messages: Message[];
  isStreaming: boolean;
  streamContent: string;
  setSessions: (sessions: Session[]) => void;
  setCurrentSessionId: (id: string | null) => void;
  setMessages: (messages: Message[]) => void;
  addMessage: (message: Message) => void;
  setIsStreaming: (v: boolean) => void;
  setStreamContent: (v: string) => void;
}

export const useChatStore = create<ChatState>()(
  devtools(
    (set) => ({
      sessions: [],
      currentSessionId: null,
      messages: [],
      isStreaming: false,
      streamContent: '',
      setSessions: (sessions) => set({ sessions }),
      setCurrentSessionId: (id) => set({ currentSessionId: id }),
      setMessages: (messages) => set({ messages }),
      addMessage: (message) => set((s) => ({ messages: [...s.messages, message] })),
      setIsStreaming: (v) => set({ isStreaming: v }),
      setStreamContent: (v) => set({ streamContent: v }),
    }),
    { name: 'ChatStore', enabled: process.env.NODE_ENV === 'development' }
  )
);
