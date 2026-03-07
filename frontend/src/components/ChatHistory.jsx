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
  // Prefer profile-based preview
  if (chat.profile) {
    const { age, sex, conditions } = chat.profile;
    const parts = [];
    if (age) parts.push(`${age}${sex || ""}`);
    if (conditions?.length) parts.push(conditions.slice(0, 3).join(", "));
    if (parts.length) return parts.join(" - ");
  }
  // Fall back to first user message
  const firstUser = chat.messages?.find((m) => m.role === "user");
  if (firstUser) {
    const text = firstUser.text;
    return text.length > 60 ? text.slice(0, 57) + "..." : text;
  }
  return "Empty chat";
}

export default function ChatHistory({ chatList, activeChatId, onSelect, onDelete }) {
  if (chatList.length === 0) {
    return (
      <div className="chat-history-dropdown">
        <div className="chat-history-empty">No past conversations</div>
      </div>
    );
  }

  return (
    <div className="chat-history-dropdown">
      {chatList.map((chat) => (
        <div
          key={chat.id}
          className={`chat-history-item${chat.id === activeChatId ? " active" : ""}`}
          onClick={() => onSelect(chat.id)}
        >
          <div className="chat-history-preview">
            <span className="chat-history-text">{chatPreview(chat)}</span>
            <span className="chat-history-time">
              {timeAgo(chat.updatedAt || chat.createdAt)}
            </span>
          </div>
          <button
            className="chat-history-delete"
            onClick={(e) => {
              e.stopPropagation();
              onDelete(chat.id);
            }}
            title="Delete chat"
          >
            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>
      ))}
    </div>
  );
}
