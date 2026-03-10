"use client";
import { useState } from "react";
import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport } from "ai";

const Chat = () => {
  // ใช้ useChat hook เพื่อจัดการสถานะการสนทนา
  const { messages, sendMessage, status } = useChat({
    transport: new DefaultChatTransport({
      api: "api/chat_04_steam",
    }),
  });

  // ตัวอย่างการใช้ useState เพื่อเก็บข้อความในช่วง input
  // input = ตัวแปร
  // setInput = function ที่เรียก
  // useState(a) = a คือ ค่าของ input
  const [input, setInput] = useState("");

  console.log("input: ", input);

  return (
    <>
      <div className="max-w-3xl mx-auto w-full mt-20">
        <form
          onSubmit={(e) => {
            e.preventDefault(); //ป้องกันการ refresh หน้า
            sendMessage({ text: input }); // ส่งข้อความไปยัง AI
            setInput(""); // clear ช่อง input หลังส่งข้อความ
          }}
        >
          <input
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
          />
          <button type="submit">Send</button>
        </form>
        {(status === "submitted" || status === "streaming") && (
          <div>AI กำลังคิด....</div>
        )}
        {messages.map((m) => (
          <div
            key={m.id}
            className={`flex ${
              m.role === "user" ? "justify-end" : "justify-start"
            }`}
          >
            <div>
              {m.parts.map((part, index) =>
                part.type === "text" ? (
                  <div key={index} className="whitespace-pre-wrap">
                    {part.text}
                  </div>
                ) : null
              )}
            </div>
          </div>
        ))}
      </div>
    </>
  );
};

export default Chat;
