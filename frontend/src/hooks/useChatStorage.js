import { useState, useEffect, useCallback, useRef } from "react";

const STORAGE_KEY_PREFIX = "lotus_chats_";

function loadStore(userId) {
  try {
    const raw = localStorage.getItem(STORAGE_KEY_PREFIX + userId);
    if (!raw) return { activeChatId: null, chats: {} };
    return JSON.parse(raw);
  } catch {
    return { activeChatId: null, chats: {} };
  }
}

function persistStore(userId, store) {
  try {
    localStorage.setItem(STORAGE_KEY_PREFIX + userId, JSON.stringify(store));
  } catch {
    // localStorage full or unavailable — silently ignore
  }
}

export default function useChatStorage(userId) {
  const [store, setStore] = useState({ activeChatId: null, chats: {} });
  const initialized = useRef(false);

  // Load from localStorage when userId becomes available
  useEffect(() => {
    if (!userId) {
      setStore({ activeChatId: null, chats: {} });
      initialized.current = false;
      return;
    }
    const loaded = loadStore(userId);
    setStore(loaded);
    initialized.current = true;
  }, [userId]);

  // Auto-persist whenever store changes
  useEffect(() => {
    if (!userId || !initialized.current) return;
    persistStore(userId, store);
  }, [userId, store]);

  const saveChat = useCallback((chatState) => {
    if (!chatState?.id) return;
    setStore((prev) => ({
      ...prev,
      activeChatId: chatState.id,
      chats: {
        ...prev.chats,
        [chatState.id]: {
          ...chatState,
          updatedAt: Date.now(),
        },
      },
    }));
  }, []);

  const deleteChat = useCallback((chatId) => {
    setStore((prev) => {
      const { [chatId]: _, ...rest } = prev.chats;
      return {
        ...prev,
        activeChatId: prev.activeChatId === chatId ? null : prev.activeChatId,
        chats: rest,
      };
    });
  }, []);

  const setActiveChatId = useCallback((chatId) => {
    setStore((prev) => ({ ...prev, activeChatId: chatId }));
  }, []);

  // Sorted chat list (most recent first)
  const chatList = Object.values(store.chats).sort(
    (a, b) => (b.updatedAt || b.createdAt) - (a.updatedAt || a.createdAt)
  );

  return {
    store,
    chatList,
    activeChatId: store.activeChatId,
    saveChat,
    deleteChat,
    setActiveChatId,
    getChat: (id) => store.chats[id] || null,
  };
}
