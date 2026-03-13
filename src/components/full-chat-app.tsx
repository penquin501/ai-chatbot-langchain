"use client";

import {
  ChatContainerContent,
  ChatContainerRoot,
} from "@/components/ui/chat-container";
import {
  Message,
  MessageAction,
  MessageActions,
  MessageContent,
} from "@/components/ui/message";
import {
  PromptInput,
  PromptInputAction,
  PromptInputActions,
  PromptInputTextarea,
} from "@/components/ui/prompt-input";
import { ScrollButton } from "@/components/ui/scroll-button";
import { Button } from "@/components/ui/button";
import { SidebarTrigger } from "@/components/ui/sidebar";
import { cn } from "@/lib/utils";
import {
  ArrowUp,
  Copy,
  Globe,
  Mic,
  MoreHorizontal,
  Pencil,
  Plus,
  ThumbsDown,
  ThumbsUp,
  Trash,
} from "lucide-react";
import { useRef, useState, useEffect } from "react";
import { useChatContext } from "@/contexts/chat-context";
import { ModelSelector } from "@/components/model-selector";
import { DEFAULT_MODEL } from "@/constants/models";
import { useChat } from "@ai-sdk/react";
import { createCustomChatTransport } from "@/lib/custom-chat-transport";
import { createClient } from "@/lib/supabase/client";

interface MessageType {
  id: string; // ID ของข้อความ
  role: string; // บทบาทของผู้ส่ง (user/assistant)
  parts: Array<{ type: string; text: string }>; // เนื้อหาข้อความแบบ parts
}

export function FullChatApp() {
  const [prompt, setPrompt] = useState("");
  // const [isLoading, setIsLoading] = useState(false); // เปลี่ยนไปใช้ เช็คจาก status แทน
  const [selectedModel, setSelectedModel] = useState(DEFAULT_MODEL);
  // const { chatMessages, setChatMessages, showWelcome, setShowWelcome } = useChatContext();
  const { showWelcome, setShowWelcome } = useChatContext();
  const chatContainerRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const [userId, setUserId] = useState<string>("");
  const [sessionId, setSessionId] = useState<string | undefined>(undefined);
  const [isLoadingHistory, setIsLoadingHistory] = useState(false);
  const [loadedMessages, setLoadedMessages] = useState<MessageType[]>([]); // เก็บข้อความที่โหลดจากประวัติ

  const loadChatHistory = async (sessionIdToLoad: string) => {
    // ตรวจสอบว่ามี sessionId หรือไม่
    if (!sessionIdToLoad) return;

    // เริ่มแสดงสถานะ loading
    setIsLoadingHistory(true);

    try {
      // เรียก API เพื่อดึงประวัติการสนทนา
      const response = await fetch(
        `/api/chat_05_history?sessionId=${sessionIdToLoad}`
      );

      // ตรวจสอบว่า API response สำเร็จหรือไม่
      if (!response.ok) {
        throw new Error("Failed to load chat history");
      }

      // แยกข้อมูล JSON จาก response
      const data = await response.json();
      const loadedMessagesData = data.messages || [];

      /**
       * แปลงข้อความจาก database format เป็น UI format
       *
       * Database Format: { id, role, content/text }
       * UI Format: { id, role, parts: [{ type: 'text', text }] }
       */
      const formattedMessages = loadedMessagesData.map(
        (
          msg: {
            id?: string;
            role?: string;
            content?: string;
            text?: string;
          },
          index: number
        ) => ({
          id: msg.id || `loaded-${index}`, // ใช้ ID จาก DB หรือสร้างใหม่
          role: msg.role || "user", // ใช้ role ที่ได้จาก API โดยตรง
          parts: [{ type: "text", text: msg.content || msg.text || "" }], // แปลงเป็น parts format
        })
      );

      // เก็บข้อความที่โหลดไว้ใน state
      setLoadedMessages(formattedMessages);
      console.log("Loaded messages:", formattedMessages);
    } catch (error) {
      // จัดการข้อผิดพลาดที่เกิดขึ้น
      console.error("Error loading chat history:", error);
    } finally {
      // หยุดแสดงสถานะ loading (ทำงานไม่ว่าจะสำเร็จหรือไม่)
      setIsLoadingHistory(false);
    }
  };

  const { messages, sendMessage, status, setMessages } = useChat({
    transport: createCustomChatTransport({
      api: "/api/chat_05_history", // API endpoint สำหรับส่งข้อความ
      onResponse: (response: Response) => {
        const newSessionId = response.headers.get("x-session-id"); // ดึง session ID จาก header
        if (newSessionId) {
          console.log("Received new session ID:", newSessionId);
          setSessionId(newSessionId); // อัปเดต session ID ใน state
          localStorage.setItem("currentSessionId", newSessionId); // บันทึก sessionId ล่าสุดไว้ใน localStorage
        }
      },
    }),
  });

  // Focus textarea on component mount when on welcome screen
  // useEffect(() => {
  //   if (showWelcome) {
  //     setTimeout(() => {
  //       textareaRef.current?.focus();
  //     }, 100);
  //   }
  // }, [showWelcome]);
  useEffect(() => {
    const supabase = createClient(); // สร้าง Supabase client
    const getUser = async () => {
      const {
        data: { user },
      } = await supabase.auth.getUser(); // ดึงข้อมูล user
      if (user) {
        setUserId(user.id); // เก็บ user ID
        const savedSessionId = localStorage.getItem("currentSessionId");
        if (savedSessionId && showWelcome) {
          setSessionId(savedSessionId); // ตั้งค่า session ID
          setShowWelcome(false); // ซ่อน welcome เพื่อแสดงประวัติ
        }
      }
    };

    getUser(); // เรียกใช้ฟังก์ชัน

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((event, session) => {
      if (session?.user) {
        setUserId(session.user.id); // เก็บ user ID
      } else {
        setUserId(""); // ล้าง user ID
      }
    });

    return () => subscription.unsubscribe();
  }, [setShowWelcome, showWelcome]);

  const handleSubmit = () => {
    if (!prompt.trim()) return;

    const messageToSend = {
      role: "user" as const,
      parts: [{ type: "text" as const, text: prompt.trim() }],
    };

    sendMessage(messageToSend, {
      body: {
        userId: userId, // ส่ง user ID สำหรับการระบุตัวตน
        sessionId: sessionId, // ส่ง session ID สำหรับความต่อเนื่อง
      },
    });
    // รีเซ็ต UI state
    setPrompt(""); // ล้างข้อความใน input
    setShowWelcome(false); // ซ่อนหน้า welcome

    // setPrompt("");
    // setIsLoading(true);
    // setShowWelcome(false);

    // // Add user message immediately
    // const newUserMessage = {
    //   id: chatMessages.length + 1,
    //   role: "user",
    //   content: prompt.trim(),
    // };

    // setChatMessages([...chatMessages, newUserMessage]);

    // // Simulate API response
    // setTimeout(() => {
    //   const assistantResponse = {
    //     id: chatMessages.length + 2,
    //     role: "assistant",
    //     content: `นี่คือการตอบกลับสำหรับคำถาม: "${prompt.trim()}"\n\nขอบคุณที่ถามคำถาม! ฉันพร้อมช่วยเหลือคุณในเรื่องต่างๆ`,
    //   };

    //   setChatMessages((prev) => [...prev, assistantResponse]);
    //   setIsLoading(false);
    // }, 1500);
  };

  const handleSamplePrompt = (samplePrompt: string) => {
    setPrompt(samplePrompt);
  };

  const startNewChat = () => {
    setSessionId(undefined); // ล้าง session ID
    setLoadedMessages([]); // ล้างข้อความที่โหลด
    localStorage.removeItem("currentSessionId"); // ลบจาก localStorage
    // ไม่ต้องเซ็ต setShowWelcome(true) เพราะ context จะจัดการให้
  };

  return (
    <main className="flex h-screen flex-col overflow-hidden">
      <header className="bg-background z-10 flex h-16 w-full shrink-0 items-center gap-2 border-b px-4">
        <SidebarTrigger className="-ml-1" />
        <div className="text-foreground flex-1">New Chat</div>

        {/* Model Selector */}
        <ModelSelector
          selectedModel={selectedModel}
          onModelChange={setSelectedModel}
        />
      </header>

      <div ref={chatContainerRef} className="relative flex-1 overflow-hidden">
        <ChatContainerRoot className="h-full">
          <ChatContainerContent
            className={cn(
              "p-4",
              // แสดง welcome screen ตรงกลางเมื่อไม่มีข้อความ
              showWelcome &&
                messages.length === 0 &&
                loadedMessages.length === 0
                ? "flex items-center justify-center h-full"
                : ""
            )}
          >
            {showWelcome &&
            messages.length === 0 &&
            loadedMessages.length === 0 ? (
              <div className="text-center max-w-2xl mx-auto">
                {/* AI Avatar และ Welcome Message */}
                <div className="mb-8">
                  <div className="h-20 w-20 mx-auto mb-6 rounded-full bg-gradient-to-r from-blue-500 to-purple-600 flex items-center justify-center">
                    <span className="text-white font-bold text-2xl">AI</span>
                  </div>
                  <h1 className="text-4xl font-bold text-slate-900 dark:text-white mb-4">
                    Welcome to Genius AI
                  </h1>
                  <p className="text-lg text-slate-600 dark:text-slate-400 mb-8">
                    Ask me anything, and I&aposll help you with coding,
                    problem-solving, and creative tasks.
                  </p>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-8">
                  <button
                    onClick={() =>
                      handleSamplePrompt(
                        "How do I create a responsive layout with CSS Grid?"
                      )
                    }
                    className="p-4 text-left rounded-lg border border-slate-200 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-800 transition-colors"
                  >
                    <div className="font-medium text-slate-900 dark:text-white mb-1">
                      CSS Grid Layout
                    </div>
                    <div className="text-sm text-slate-600 dark:text-slate-400">
                      Learn how to create responsive layouts
                    </div>
                  </button>
                  <button
                    onClick={() =>
                      handleSamplePrompt(
                        "Explain React hooks and when to use them"
                      )
                    }
                    className="p-4 text-left rounded-lg border border-slate-200 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-800 transition-colors"
                  >
                    <div className="font-medium text-slate-900 dark:text-white mb-1">
                      React Hooks
                    </div>
                    <div className="text-sm text-slate-600 dark:text-slate-400">
                      Understanding hooks and their use cases
                    </div>
                  </button>
                  <button
                    onClick={() =>
                      handleSamplePrompt(
                        "What are the best practices for API design?"
                      )
                    }
                    className="p-4 text-left rounded-lg border border-slate-200 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-800 transition-colors"
                  >
                    <div className="font-medium text-slate-900 dark:text-white mb-1">
                      API Design
                    </div>
                    <div className="text-sm text-slate-600 dark:text-slate-400">
                      Best practices for building APIs
                    </div>
                  </button>
                  <button
                    onClick={() =>
                      handleSamplePrompt("Help me debug this JavaScript error")
                    }
                    className="p-4 text-left rounded-lg border border-slate-200 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-800 transition-colors"
                  >
                    <div className="font-medium text-slate-900 dark:text-white mb-1">
                      Debug JavaScript
                    </div>
                    <div className="text-sm text-slate-600 dark:text-slate-400">
                      Get help with debugging code issues
                    </div>
                  </button>
                </div>
              </div>
            ) : (
              <div className="space-y-3 max-w-3xl mx-auto w-full">
                {[...loadedMessages, ...messages].map((message, index) => {
                  const isAssistant = message.role === "assistant"; // ตรวจสอบว่าเป็นข้อความจาก AI หรือไม่

                  return (
                    <Message
                      key={`${message.id}-${index}`} // unique key สำหรับ React
                      isAssistant={isAssistant} // ระบุประเภทข้อความ
                      bubbleStyle={true} // ใช้ bubble style
                    >
                      {/* Message Content - เนื้อหาข้อความ */}
                      <MessageContent
                        isAssistant={isAssistant}
                        bubbleStyle={true}
                        markdown // แสดงเป็น markdown format
                      >
                        {/* แปลงข้อความจาก parts structure เป็น string */}
                        {typeof message === "object" &&
                        "parts" in message &&
                        message.parts
                          ? message.parts
                              .map((part) => ("text" in part ? part.text : ""))
                              .join("")
                          : String(message)}
                      </MessageContent>

                      {/* Message Actions - ปุ่มสำหรับจัดการข้อความ */}
                      <MessageActions
                        isAssistant={isAssistant}
                        bubbleStyle={true}
                      >
                        {/* Copy Button - ปุ่มสำหรับ copy ข้อความ */}
                        <MessageAction tooltip="Copy" bubbleStyle={true}>
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-7 w-7 p-0 text-gray-500 hover:text-gray-700 rounded-full"
                          >
                            <Copy size={14} />
                          </Button>
                        </MessageAction>

                        {/* Assistant Message Actions - ปุ่มสำหรับข้อความจาก AI */}
                        {isAssistant && (
                          <>
                            {/* Upvote Button */}
                            <MessageAction tooltip="Upvote" bubbleStyle={true}>
                              <Button
                                variant="ghost"
                                size="sm"
                                className="h-7 w-7 p-0 text-gray-500 hover:text-gray-700 rounded-full"
                              >
                                <ThumbsUp size={14} />
                              </Button>
                            </MessageAction>

                            {/* Downvote Button */}
                            <MessageAction
                              tooltip="Downvote"
                              bubbleStyle={true}
                            >
                              <Button
                                variant="ghost"
                                size="sm"
                                className="h-7 w-7 p-0 text-gray-500 hover:text-gray-700 rounded-full"
                              >
                                <ThumbsDown size={14} />
                              </Button>
                            </MessageAction>
                          </>
                        )}

                        {/* User Message Actions - ปุ่มสำหรับข้อความจากผู้ใช้ */}
                        {!isAssistant && (
                          <>
                            {/* Edit Button */}
                            <MessageAction tooltip="Edit" bubbleStyle={true}>
                              <Button
                                variant="ghost"
                                size="sm"
                                className="h-7 w-7 p-0 text-gray-500 hover:text-gray-700 rounded-full"
                              >
                                <Pencil size={14} />
                              </Button>
                            </MessageAction>

                            {/* Delete Button */}
                            <MessageAction tooltip="Delete" bubbleStyle={true}>
                              <Button
                                variant="ghost"
                                size="sm"
                                className="h-7 w-7 p-0 text-gray-500 hover:text-gray-700 rounded-full"
                              >
                                <Trash size={14} />
                              </Button>
                            </MessageAction>
                          </>
                        )}
                      </MessageActions>
                    </Message>
                  );
                })}
              </div>
            )}
          </ChatContainerContent>
          {!(
            showWelcome &&
            messages.length === 0 &&
            loadedMessages.length === 0
          ) && (
            <div className="absolute bottom-4 left-1/2 flex w-full max-w-3xl -translate-x-1/2 justify-end px-5">
              <ScrollButton className="shadow-sm" />{" "}
            </div>
          )}
        </ChatContainerRoot>
      </div>

      <div className="bg-background z-10 shrink-0 px-3 pb-3 md:px-5 md:pb-5">
        <div className="mx-auto max-w-3xl">
          {(status === "submitted" || status === "streaming") && (
            <div className="text-gray-500 italic mb-2 text-sm">
              🤔 AI กำลังคิด...
            </div>
          )}
          {isLoadingHistory && (
            <div className="text-blue-500 italic mb-2 text-sm">
              📚 กำลังโหลดประวัติการสนทนา...
            </div>
          )}
          <PromptInput
            isLoading={status !== "ready"}
            value={prompt}
            onValueChange={setPrompt}
            onSubmit={handleSubmit}
            className="border-input bg-popover relative z-10 w-full rounded-3xl border p-0 pt-1 shadow-xs"
          >
            <div className="flex flex-col">
              <PromptInputTextarea
                ref={textareaRef}
                placeholder="Ask anything to start a new chat..."
                className="min-h-[44px] pt-3 pl-4 text-base leading-[1.3] sm:text-base md:text-base"
              />
              <PromptInputActions className="mt-5 flex w-full items-center justify-between gap-2 px-3 pb-3">
                <div className="flex items-center gap-2">
                  <PromptInputAction tooltip="Add a new action">
                    <Button
                      variant="outline"
                      size="icon"
                      className="size-9 rounded-full"
                    >
                      <Plus size={18} />
                    </Button>
                  </PromptInputAction>
                  <PromptInputAction tooltip="Search">
                    <Button variant="outline" className="rounded-full">
                      <Globe size={18} />
                      Search
                    </Button>
                  </PromptInputAction>
                  <PromptInputAction tooltip="More actions">
                    <Button
                      variant="outline"
                      size="icon"
                      className="size-9 rounded-full"
                    >
                      <MoreHorizontal size={18} />
                    </Button>
                  </PromptInputAction>
                </div>
                <div className="flex items-center gap-2">
                  <PromptInputAction tooltip="Voice input">
                    <Button
                      variant="outline"
                      size="icon"
                      className="size-9 rounded-full"
                    >
                      <Mic size={18} />
                    </Button>
                  </PromptInputAction>

                  <Button
                    size="icon"
                    disabled={!prompt.trim() || status !== "ready" || !userId}
                    onClick={handleSubmit}
                    className="size-9 rounded-full"
                  >
                    {/* แสดง icon ตาม status */}
                    {status === "ready" ? (
                      /* แสดงลูกศรเมื่อพร้อม */
                      <ArrowUp size={18} />
                    ) : (
                      /* แสดง loading indicator */
                      <span className="size-3 rounded-xs bg-white" />
                    )}
                  </Button>
                </div>
              </PromptInputActions>
            </div>
          </PromptInput>
        </div>
      </div>
    </main>
  );
}
