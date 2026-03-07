import { useState, useEffect, useCallback, useRef } from "react";
import { supabase } from "../services/supabase";

export default function useChatStorage(userId) {
  const [chats, setChats] = useState({});
  const [activeChatId, setActiveChatIdState] = useState(null);
  const loaded = useRef(false);
  const saveQueue = useRef(new Map());
  const flushTimer = useRef(null);

  // Load all chats from Supabase on login
  useEffect(() => {
    if (!userId) {
      setChats({});
      setActiveChatIdState(null);
      loaded.current = false;
      return;
    }

    let cancelled = false;

    (async () => {
      const { data, error } = await supabase
        .from("chat_history")
        .select("id, created_at, updated_at, data")
        .eq("user_id", userId)
        .order("updated_at", { ascending: false });

      if (cancelled || error) return;

      const map = {};
      for (const row of data) {
        map[row.id] = {
          ...row.data,
          id: row.id,
          createdAt: row.created_at,
          updatedAt: row.updated_at,
        };
      }
      setChats(map);
      loaded.current = true;
    })();

    return () => { cancelled = true; };
  }, [userId]);

  // Flush queued saves to Supabase (debounced)
  const flush = useCallback(() => {
    if (!userId || saveQueue.current.size === 0) return;

    const pending = Array.from(saveQueue.current.values());
    saveQueue.current.clear();

    for (const chatState of pending) {
      const { id, createdAt, updatedAt, ...rest } = chatState;
      supabase
        .from("chat_history")
        .upsert({
          id,
          user_id: userId,
          created_at: createdAt || Date.now(),
          updated_at: updatedAt || Date.now(),
          data: rest,
        })
        .then(({ error }) => {
          if (error) console.error("Failed to save chat:", error);
        });
    }
  }, [userId]);

  // Flush on unmount
  useEffect(() => {
    return () => {
      clearTimeout(flushTimer.current);
      flush();
    };
  }, [flush]);

  const saveChat = useCallback((chatState) => {
    if (!chatState?.id) return;

    const now = Date.now();
    const enriched = {
      ...chatState,
      updatedAt: now,
      createdAt: chatState.createdAt || chats[chatState.id]?.createdAt || now,
    };

    // Update local state immediately
    setChats((prev) => ({ ...prev, [chatState.id]: enriched }));
    setActiveChatIdState(chatState.id);

    // Queue the save and debounce
    saveQueue.current.set(chatState.id, enriched);
    clearTimeout(flushTimer.current);
    flushTimer.current = setTimeout(flush, 1000);
  }, [flush, chats]);

  const deleteChat = useCallback((chatId) => {
    setChats((prev) => {
      const { [chatId]: _, ...rest } = prev;
      return rest;
    });
    setActiveChatIdState((prev) => (prev === chatId ? null : prev));
    saveQueue.current.delete(chatId);

    if (userId) {
      supabase
        .from("chat_history")
        .delete()
        .eq("id", chatId)
        .then(({ error }) => {
          if (error) console.error("Failed to delete chat:", error);
        });
    }
  }, [userId]);

  const updateChat = useCallback((chatId, updates) => {
    setChats((prev) => {
      const existing = prev[chatId];
      if (!existing) return prev;
      // Don't change updatedAt for metadata-only changes (pin, rename)
      const updated = { ...existing, ...updates };
      // Queue save
      saveQueue.current.set(chatId, updated);
      clearTimeout(flushTimer.current);
      flushTimer.current = setTimeout(flush, 1000);
      return { ...prev, [chatId]: updated };
    });
  }, [flush]);

  const setActiveChatId = useCallback((chatId) => {
    setActiveChatIdState(chatId);
  }, []);

  const chatList = Object.values(chats).sort((a, b) => {
    // Pinned first
    if (a.pinned && !b.pinned) return -1;
    if (!a.pinned && b.pinned) return 1;
    // Then by recency
    return (b.updatedAt || b.createdAt) - (a.updatedAt || a.createdAt);
  });

  return {
    chatList,
    activeChatId,
    saveChat,
    deleteChat,
    updateChat,
    setActiveChatId,
    getChat: (id) => chats[id] || null,
  };
}
