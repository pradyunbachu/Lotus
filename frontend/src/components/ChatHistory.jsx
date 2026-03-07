import { useState, useRef, useEffect, useLayoutEffect } from "react";

function timeAgo(ts) {
  const seconds = Math.floor((Date.now() - ts) / 1000);
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  return `${Math.floor(days / 30)}mo ago`;
}

function chatPreview(chat) {
  if (chat.customName) return chat.customName;
  if (chat.profile) {
    const { age, sex, conditions } = chat.profile;
    const parts = [];
    if (age) parts.push(`${age}${sex || ""}`);
    if (conditions?.length) parts.push(conditions.slice(0, 3).join(", "));
    if (parts.length) return parts.join(" - ");
  }
  const firstUser = chat.messages?.find((m) => m.role === "user");
  if (firstUser) {
    const text = firstUser.text;
    return text.length > 60 ? text.slice(0, 57) + "..." : text;
  }
  return "Empty chat";
}

export default function ChatHistory({ chatList, activeChatId, onSelect, onDelete, onRename, onPin }) {
  const [editingId, setEditingId] = useState(null);
  const [editValue, setEditValue] = useState("");
  const inputRef = useRef(null);
  const containerRef = useRef(null);
  const positionsRef = useRef(new Map());

  // Capture positions before React re-renders (FLIP: First)
  useEffect(() => {
    if (!containerRef.current) return;
    const map = new Map();
    for (const child of containerRef.current.children) {
      const id = child.dataset.chatId;
      if (id) map.set(id, child.getBoundingClientRect());
    }
    positionsRef.current = map;
  });

  // After render, animate from old position to new (FLIP: Invert + Play)
  useLayoutEffect(() => {
    if (!containerRef.current || positionsRef.current.size === 0) return;
    const oldPositions = positionsRef.current;

    for (const child of containerRef.current.children) {
      const id = child.dataset.chatId;
      if (!id) continue;
      const oldRect = oldPositions.get(id);
      if (!oldRect) continue;
      const newRect = child.getBoundingClientRect();
      const dy = oldRect.top - newRect.top;
      if (Math.abs(dy) < 1) continue;

      child.animate(
        [
          { transform: `translateY(${dy}px)` },
          { transform: `translateY(0)` },
        ],
        { duration: 250, easing: "ease-out" }
      );
    }
  });

  useEffect(() => {
    if (editingId && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [editingId]);

  const startRename = (chat, e) => {
    e.stopPropagation();
    setEditingId(chat.id);
    setEditValue(chatPreview(chat));
  };

  const commitRename = () => {
    if (editingId && editValue.trim()) {
      onRename(editingId, editValue.trim());
    }
    setEditingId(null);
  };

  const cancelRename = () => {
    setEditingId(null);
  };

  if (chatList.length === 0) {
    return (
      <div className="chat-history-dropdown">
        <div className="chat-history-empty">No past conversations</div>
      </div>
    );
  }

  return (
    <div className="chat-history-dropdown" ref={containerRef}>
      {chatList.map((chat) => (
        <div
          key={chat.id}
          data-chat-id={chat.id}
          className={`chat-history-item${chat.id === activeChatId ? " active" : ""}`}
          onClick={() => editingId !== chat.id && onSelect(chat.id)}
        >
          <button
            className="chat-history-star"
            onClick={(e) => {
              e.stopPropagation();
              onPin(chat.id);
            }}
            title={chat.pinned ? "Unstar" : "Star"}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill={chat.pinned ? "#eab308" : "none"} stroke={chat.pinned ? "#eab308" : "#d1d5db"} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />
            </svg>
          </button>
          <div className="chat-history-preview">
            {editingId === chat.id ? (
              <input
                ref={inputRef}
                className="chat-history-rename-input"
                value={editValue}
                onChange={(e) => setEditValue(e.target.value)}
                onBlur={commitRename}
                onKeyDown={(e) => {
                  if (e.key === "Enter") commitRename();
                  if (e.key === "Escape") cancelRename();
                }}
                onClick={(e) => e.stopPropagation()}
              />
            ) : (
              <>
                <span className="chat-history-text">{chatPreview(chat)}</span>
                <span className="chat-history-time">
                  {timeAgo(chat.updatedAt || chat.createdAt)}
                </span>
              </>
            )}
          </div>
          {editingId !== chat.id && (
            <div className="chat-history-actions">
              <button
                className="chat-history-action-btn"
                onClick={(e) => startRename(chat, e)}
                title="Rename"
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
                  <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
                </svg>
              </button>
              <button
                className="chat-history-action-btn chat-history-action-delete"
                onClick={(e) => {
                  e.stopPropagation();
                  onDelete(chat.id);
                }}
                title="Delete"
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
                </svg>
              </button>
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
