import { useState, useCallback, useEffect, useRef } from "react";
import CareGraph from "./components/CareGraph";
import Dashboard from "./components/Dashboard";
import VoiceOrb from "./components/VoiceOrb";
import ChatInput from "./components/ChatInput";
import NodeDetail from "./components/NodeDetail";
import CostSummary from "./components/CostSummary";
import LandingPage from "./components/LandingPage";
import TabBar from "./components/TabBar";
import ComparePlans from "./components/ComparePlans";
import ChatHistory from "./components/ChatHistory";
import { generatePathway, parseProfile, parseScenario, chatAboutHealth } from "./services/api";
import { useAuth } from "./contexts/AuthContext";
import useChatStorage from "./hooks/useChatStorage";
import "./App.css";

function buildGraphSummary(graph) {
  if (!graph) return {};
  return {
    total_5yr_cost: graph.total_5yr_cost,
    total_5yr_oop: graph.total_5yr_oop,
    conditions: graph.nodes
      .filter((n) => n.node_type === "current")
      .map((n) => n.label),
    top_risks: graph.nodes
      .filter((n) => n.node_type === "future" || n.node_type === "high_cost")
      .sort((a, b) => b.probability - a.probability)
      .slice(0, 5)
      .map((n) => ({
        label: n.label,
        probability: n.probability,
        annual_cost: n.annual_cost,
      })),
    interventions: graph.nodes
      .filter((n) => n.node_type === "intervention")
      .map((n) => n.label),
  };
}

function App() {
  const { user, loading, signOut } = useAuth();
  const [currentView, setCurrentView] = useState("landing");
  const [graph, setGraph] = useState(null);
  const [baselineGraph, setBaselineGraph] = useState(null);
  const [selectedNode, setSelectedNode] = useState(null);
  const [profile, setProfile] = useState(null);
  const [interventions, setInterventions] = useState([]);
  const [isProcessing, setIsProcessing] = useState(false);
  const [simulateView, setSimulateView] = useState("tree");
  const [messages, setMessages] = useState([]);
  const [pendingProfile, setPendingProfile] = useState(null);
  const [currentChatId, setCurrentChatId] = useState(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [showLeaveModal, setShowLeaveModal] = useState(false);
  const messagesEndRef = useRef(null);
  const skipAutoSave = useRef(false);

  const { chatList, activeChatId, saveChat, deleteChat, updateChat, setActiveChatId, getChat } =
    useChatStorage(user?.id);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, isProcessing]);

  useEffect(() => {
    if (!loading && !user && currentView !== "landing") {
      setCurrentView("landing");
    }
  }, [user, loading, currentView]);

  // Auto-save current chat to localStorage whenever state changes
  useEffect(() => {
    if (!user?.id || !currentChatId || skipAutoSave.current) return;
    if (messages.length === 0 && !profile) return;
    saveChat({
      id: currentChatId,
      createdAt: getChat(currentChatId)?.createdAt || Date.now(),
      messages,
      profile,
      graph,
      baselineGraph,
      interventions,
      pendingProfile,
    });
  }, [messages, profile, graph, baselineGraph, interventions, pendingProfile, currentChatId, user?.id]);

  // Restore active chat on mount / login
  const restoredRef = useRef(false);
  useEffect(() => {
    if (!user?.id || restoredRef.current) return;
    if (activeChatId) {
      const chat = getChat(activeChatId);
      if (chat) {
        skipAutoSave.current = true;
        setMessages(chat.messages || []);
        setProfile(chat.profile || null);
        setGraph(chat.graph || null);
        setBaselineGraph(chat.baselineGraph || null);
        setInterventions(chat.interventions || []);
        setPendingProfile(chat.pendingProfile || null);
        setCurrentChatId(activeChatId);
        setCurrentView("simulate");
        // Allow auto-save again on next tick
        setTimeout(() => { skipAutoSave.current = false; }, 0);
      }
    }
    restoredRef.current = true;
  }, [user?.id, activeChatId]);

  const addMessage = (role, text) => {
    if (!currentChatId) {
      setCurrentChatId("chat_" + Date.now());
    }
    setMessages((prev) => [...prev, { role, text }]);
  };

  const resetChat = useCallback(() => {
    setGraph(null);
    setBaselineGraph(null);
    setSelectedNode(null);
    setProfile(null);
    setInterventions([]);
    setMessages([]);
    setPendingProfile(null);
    setIsProcessing(false);
    setCurrentChatId(null);
    setActiveChatId(null);
  }, [setActiveChatId]);

  const handleLogoClick = useCallback(() => {
    if (currentView !== "landing" && (profile || messages.length > 0)) {
      setShowLeaveModal(true);
    } else {
      setCurrentView("landing");
    }
  }, [currentView, profile, messages]);

  const handleLeaveConfirm = useCallback(() => {
    setShowLeaveModal(false);
    resetChat();
    setCurrentView("landing");
  }, [resetChat]);

  const restoreChat = useCallback((chatId) => {
    const chat = getChat(chatId);
    if (!chat) return;
    skipAutoSave.current = true;
    setMessages(chat.messages || []);
    setProfile(chat.profile || null);
    setGraph(chat.graph || null);
    setBaselineGraph(chat.baselineGraph || null);
    setInterventions(chat.interventions || []);
    setPendingProfile(chat.pendingProfile || null);
    setCurrentChatId(chatId);
    setActiveChatId(chatId);
    setSelectedNode(null);
    setIsProcessing(false);
    setHistoryOpen(false);
    setTimeout(() => { skipAutoSave.current = false; }, 0);
  }, [getChat, setActiveChatId]);

  const handleDeleteChat = useCallback((chatId) => {
    deleteChat(chatId);
    if (chatId === currentChatId) {
      resetChat();
    }
  }, [deleteChat, currentChatId, resetChat]);

  const handleRenameChat = useCallback((chatId, name) => {
    updateChat(chatId, { customName: name });
  }, [updateChat]);

  const handlePinChat = useCallback((chatId) => {
    const chat = getChat(chatId);
    updateChat(chatId, { pinned: !chat?.pinned });
  }, [updateChat, getChat]);

  const startNewProfile = useCallback(
    async (parsed) => {
      const symptom = parsed.symptom_conditions || [];
      const unmapped = parsed.unmapped_conditions || [];
      const scores = parsed.symptom_scores || {};
      const newProfile = {
        age: parsed.age || 45,
        sex: parsed.sex || "M",
        conditions: parsed.conditions || [],
        insurance_type: parsed.insurance_type || "PPO",
        deductible: 2000,
        coinsurance: 0.2,
        oop_max: 8000,
      };

      setProfile(newProfile);
      setInterventions([]);
      setSelectedNode(null);
      const pathway = await generatePathway(newProfile, [], 5, symptom, unmapped, scores);
      setGraph(pathway);
      setBaselineGraph(pathway);
      if (pathway.nodes.length === 0) {
        addMessage(
          "system",
          "I wasn't able to map specific health states from that description. Could you try naming your conditions more directly? For example: \"I have diabetes and high blood pressure\" or \"I'm a 50-year-old woman with asthma.\""
        );
      } else {
        const hasSuspected = pathway.nodes.some((n) => n.id?.startsWith("suspected_"));
        const hasConfirmed = pathway.nodes.some((n) => n.node_type === "current");
        let msg = `Built your care pathway. ${pathway.nodes.length} health states mapped. 5-year projected out-of-pocket: $${Math.round(pathway.total_5yr_oop).toLocaleString()}.`;
        if (hasSuspected && !hasConfirmed) {
          msg += " Based on your symptoms, I've mapped possible related conditions. You can add more details like your age, other diagnoses, or insurance type to refine the projection.";
        }
        addMessage("system", msg);
      }
    },
    []
  );

  const handleInput = useCallback(
    async (text) => {
      addMessage("user", text);
      setIsProcessing(true);

      try {
        // Handle pending new-profile confirmation
        if (pendingProfile) {
          const lower = text.toLowerCase().trim();
          const isYes = /^(y|yes|yeah|yep|sure|ok|okay|yea|start new)/.test(lower);
          const saved = pendingProfile;
          setPendingProfile(null);

          if (isYes) {
            setMessages([
              { role: "system", text: "Starting a new session..." },
            ]);
            await startNewProfile(saved);
          } else {
            addMessage("system", "Okay, keeping your current profile.");
          }
          setIsProcessing(false);
          return;
        }

        if (!profile) {
          // First message — parse as profile
          const parsed = await parseProfile(text);
          if (parsed.error) {
            addMessage("system", parsed.error);
            setIsProcessing(false);
            return;
          }
          if (parsed.off_topic) {
            addMessage("system", "I didn't catch a health condition in that. You can describe symptoms, diagnoses, or a full profile — for example:\n\n• \"I've been having chest pain and shortness of breath\"\n• \"Type 2 diabetes and high blood pressure\"\n• \"55-year-old female with asthma on a PPO plan\"");
            setIsProcessing(false);
            return;
          }

          await startNewProfile(parsed);
        } else {
          // Profile exists — try scenario first
          const scenario = await parseScenario(text, profile.conditions);

          if (scenario.intent === "add_intervention" && scenario.interventions?.length) {
            const newInterventions = [
              ...new Set([...interventions, ...scenario.interventions]),
            ];
            setInterventions(newInterventions);
            const pathway = await generatePathway(profile, newInterventions, 5);
            setGraph(pathway);
            const savings = baselineGraph
              ? Math.round(baselineGraph.total_5yr_oop - pathway.total_5yr_oop)
              : 0;
            addMessage(
              "system",
              `Updated pathway with ${scenario.interventions.join(", ")}. ${savings > 0 ? `Estimated 5-year savings: $${savings.toLocaleString()}.` : ""}`
            );
          } else {
            // Check if it looks like a new profile
            const parsed = await parseProfile(text);
            if (!parsed.off_topic && !parsed.error && parsed.conditions?.length) {
              setPendingProfile(parsed);
              addMessage(
                "system",
                `It looks like you're describing a new patient (${parsed.age || "unknown age"}, ${parsed.conditions.join(", ")}). Would you like to start a new chat?`
              );
            } else {
              // Conversational catch-all — send to LLM with full context
              const graphSummary = buildGraphSummary(graph);
              const response = await chatAboutHealth(text, profile, graphSummary, messages);
              addMessage("system", response);
            }
          }
        }
      } catch (err) {
        addMessage("system", `Error: ${err.message}`);
      }

      setIsProcessing(false);
    },
    [profile, interventions, baselineGraph, pendingProfile, startNewProfile]
  );

  return (
    <div className="app">
      <header className="app-header">
        <h1
          className="logo-link"
          onClick={handleLogoClick}
        >
          lotus
          <svg className="logo-icon" width="36" height="36" viewBox="0 0 100 100" fill="none">
            {/* center petal */}
            <ellipse cx="50" cy="38" rx="10" ry="28" fill="#e8548e"/>
            {/* inner left/right petals */}
            <ellipse cx="50" cy="38" rx="10" ry="26" fill="#f472b6" transform="rotate(-25 50 55)"/>
            <ellipse cx="50" cy="38" rx="10" ry="26" fill="#f472b6" transform="rotate(25 50 55)"/>
            {/* outer left/right petals */}
            <ellipse cx="50" cy="40" rx="9" ry="24" fill="#f9a8c9" transform="rotate(-50 50 58)"/>
            <ellipse cx="50" cy="40" rx="9" ry="24" fill="#f9a8c9" transform="rotate(50 50 58)"/>
            {/* yellow center */}
            <circle cx="50" cy="52" r="6" fill="#eab308"/>
            <circle cx="50" cy="52" r="3.5" fill="#fde68a"/>
          </svg>
        </h1>
        <div className="header-spacer" />
        {currentView !== "landing" && (
          <TabBar
            activeTab={currentView}
            onTabChange={setCurrentView}
          />
        )}
        {user && (
          <div className="user-menu">
            <img
              className="user-avatar"
              src={user.user_metadata?.avatar_url}
              alt=""
              referrerPolicy="no-referrer"
            />
            <button className="sign-out-btn" onClick={signOut}>
              Sign Out
            </button>
          </div>
        )}
      </header>

      {currentView === "landing" && (
        <LandingPage onGetStarted={() => setCurrentView("simulate")} />
      )}

      {currentView === "simulate" && user && (
        <>
          <main className="app-main">
            <div className="graph-panel">
              {graph && (
                <div className="view-toggle">
                  <button
                    className={`view-toggle-btn${simulateView === "tree" ? " active" : ""}`}
                    onClick={() => setSimulateView("tree")}
                  >
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <circle cx="12" cy="5" r="3" /><line x1="12" y1="8" x2="12" y2="14" /><line x1="12" y1="14" x2="6" y2="20" /><line x1="12" y1="14" x2="18" y2="20" />
                    </svg>
                    Visual
                  </button>
                  <button
                    className={`view-toggle-btn${simulateView === "dashboard" ? " active" : ""}`}
                    onClick={() => setSimulateView("dashboard")}
                  >
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <rect x="3" y="3" width="7" height="7" /><rect x="14" y="3" width="7" height="7" /><rect x="3" y="14" width="7" height="7" /><rect x="14" y="14" width="7" height="7" />
                    </svg>
                    Dashboard
                  </button>
                </div>
              )}
              {simulateView === "tree" ? (
                <CareGraph graph={graph} onNodeSelect={setSelectedNode} />
              ) : (
                <Dashboard
                  graph={graph}
                  comparisonGraph={baselineGraph}
                  onNodeSelect={setSelectedNode}
                />
              )}
              {selectedNode && (
                <NodeDetail node={selectedNode} onClose={() => setSelectedNode(null)} />
              )}
            </div>

            <div className="side-panel">

              {graph && (
                <div className="side-section">
                  <CostSummary graph={graph} comparisonGraph={baselineGraph} selectedNode={selectedNode} />
                </div>
              )}

              <div className="side-section side-section-chat">
                <div className="section-header">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
                  </svg>
                  <span>Conversation</span>
                  {chatList.length > 0 && (
                    <button
                      className={`chat-history-toggle${historyOpen ? " active" : ""}`}
                      onClick={() => setHistoryOpen((o) => !o)}
                      title="Chat history"
                    >
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <circle cx="12" cy="12" r="10" /><polyline points="12 6 12 12 16 14" />
                      </svg>
                      History
                    </button>
                  )}
                  {(profile || messages.length > 0) && (
                    <button className="new-chat-btn" onClick={resetChat} title="New Chat">
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" />
                      </svg>
                      New Chat
                    </button>
                  )}
                </div>
                {historyOpen && (
                  <ChatHistory
                    chatList={chatList}
                    activeChatId={currentChatId}
                    onSelect={restoreChat}
                    onDelete={handleDeleteChat}
                    onRename={handleRenameChat}
                    onPin={handlePinChat}
                  />
                )}
                <div className="messages">
                  {messages.length === 0 && !isProcessing && (
                    <div className="messages-empty">
                      <p>Describe your health profile below to get started.</p>
                      {!profile && (
                        <div className="example-profiles">
                          <span className="example-profiles-label">Try an example:</span>
                          {[
                            "55yo female with Type 2 diabetes and obesity on a PPO plan",
                            "32yo male with asthma and anxiety on an HMO plan",
                            "68yo female with hypertension, high cholesterol, and arthritis",
                          ].map((ex) => (
                            <button
                              key={ex}
                              className="example-profile-btn"
                              onClick={() => handleInput(ex)}
                            >
                              {ex}
                            </button>
                          ))}
                        </div>
                      )}
                    </div>
                  )}
                  {messages.map((msg, i) => (
                    <div key={i} className={`message ${msg.role}`}>
                      <div className="message-avatar">
                        {msg.role === "user" ? (
                          <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><path d="M12 12c2.7 0 4.8-2.1 4.8-4.8S14.7 2.4 12 2.4 7.2 4.5 7.2 7.2 9.3 12 12 12zm0 2.4c-3.2 0-9.6 1.6-9.6 4.8v2.4h19.2v-2.4c0-3.2-6.4-4.8-9.6-4.8z"/></svg>
                        ) : (
                          <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 15l-5-5 1.41-1.41L10 14.17l7.59-7.59L19 8l-9 9z"/></svg>
                        )}
                      </div>
                      <div className="message-content">{msg.text}</div>
                    </div>
                  ))}
                  {isProcessing && (
                    <div className="message system">
                      <div className="message-avatar">
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 15l-5-5 1.41-1.41L10 14.17l7.59-7.59L19 8l-9 9z"/></svg>
                      </div>
                      <div className="message-content">
                        <span className="typing-indicator">
                          <span></span><span></span><span></span>
                        </span>
                      </div>
                    </div>
                  )}
                  <div ref={messagesEndRef} />
                </div>
                <div className="side-input">
                  <VoiceOrb onTranscript={handleInput} isProcessing={isProcessing} />
                  <ChatInput onSubmit={handleInput} isProcessing={isProcessing} />
                </div>
              </div>
            </div>
          </main>
        </>
      )}

      {currentView === "compare" && user && (
        <ComparePlans profile={profile} />
      )}

      {showLeaveModal && (
        <div className="modal-backdrop" onClick={() => setShowLeaveModal(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h3 className="modal-title">Leave this session?</h3>
            <p className="modal-text">
              Your current conversation is saved in history. You can pick it back up anytime from the chat history panel.
            </p>
            <div className="modal-actions">
              <button className="modal-btn modal-btn-secondary" onClick={() => setShowLeaveModal(false)}>
                Cancel
              </button>
              <button className="modal-btn modal-btn-primary" onClick={handleLeaveConfirm}>
                Leave
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default App;
