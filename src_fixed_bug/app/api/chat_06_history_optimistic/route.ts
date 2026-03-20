/**
 * ===============================================
 * API Route สำหรับ Chat ที่มีการเก็บประวัติและ Optimize
 * ===============================================
 * 
 * ฟีเจอร์หลัก:
 * - เก็บประวัติการสนทนาใน PostgreSQL
 * - ทำ Summary เพื่อประหยัด Token
 * - Trim Messages เพื่อไม่ให้เกิน Token Limit
 * - Streaming Response สำหรับ Real-time Chat
 * - จัดการ Session ID อัตโนมัติ
 */

import { NextRequest } from 'next/server'
import { ChatOpenAI } from '@langchain/openai'
import { ChatPromptTemplate, MessagesPlaceholder } from '@langchain/core/prompts'
import { toUIMessageStream } from '@ai-sdk/langchain'
import { createUIMessageStreamResponse, UIMessage } from 'ai'
import { PostgresChatMessageHistory } from '@langchain/community/stores/message/postgres'
import { BaseMessage, AIMessage, HumanMessage, SystemMessage, MessageContent } from '@langchain/core/messages'
import { trimMessages } from '@langchain/core/messages'
import { StringOutputParser } from '@langchain/core/output_parsers'
import { encodingForModel } from '@langchain/core/utils/tiktoken'
import { getDatabase } from '../../../../src/lib/database'

export const dynamic = 'force-dynamic'
export const maxDuration = 30

// ===============================================
// ใช้ centralized database utility แทน pool ที่สร้างเอง
// ===============================================
const pool = getDatabase()

// ===============================================
// ฟังก์ชันสำหรับนับ Token (Tiktoken)
// ===============================================

/**
 * Type สำหรับ Encoder ที่ใช้นับ Token
 */
type Encoding = {
  encode: (text: string) => number[]
  free?: () => void
}

let encPromise: Promise<Encoding> | undefined

/**
 * ฟังก์ชันสำหรับขอ Encoder
 * Step 1: พยายามใช้ gpt-4o-mini ก่อน
 * Step 2: ถ้าไม่ได้ให้ fallback เป็น gpt-4
 * Step 3: Cache Encoder เพื่อไม่ต้องสร้างใหม่
 */
async function getEncoder(): Promise<Encoding> {
  if (!encPromise) {
    encPromise = encodingForModel("gpt-4o-mini").catch(() =>
      encodingForModel("gpt-4")
    )
  }
  return encPromise
}

/**
 * ฟังก์ชันนับ Token ของข้อความแต่ละอัน
 * Step 1: ตรวจสอบประเภทของ content (string, array, หรืออื่นๆ)
 * Step 2: แปลงเป็น string และนับ token
 * Step 3: คืนค่าจำนวน token
 */
async function strTokenCounter(content: MessageContent): Promise<number> {
  const enc = await getEncoder()
  if (typeof content === 'string') return enc.encode(content).length
  if (Array.isArray(content)) {
    return enc.encode(
      content.map(p => (p.type === 'text' ? p.text : JSON.stringify(p))).join(' ')
    ).length
  }
  return enc.encode(String(content ?? '')).length
}

/**
 * ฟังก์ชันนับ Token ทั้งหมดในอาเรย์ของข้อความ
 * Step 1: วนลูปผ่านข้อความทั้งหมด
 * Step 2: ระบุ role ของแต่ละข้อความ (user, assistant, system)
 * Step 3: นับ token ของ role และ content แล้วรวมกัน
 * Step 4: คืนค่าจำนวน token ทั้งหมด
 * 
 * หมายเหตุ: ไม่ export ฟังก์ชันนี้เพื่อหลีกเลี่ยง Next.js type error
 */
async function tiktokenCounter(messages: BaseMessage[]): Promise<number> {
  let total = 0
  for (const m of messages) {
    const role =
      m instanceof HumanMessage
        ? 'user'
        : m instanceof AIMessage
          ? 'assistant'
          : m instanceof SystemMessage
            ? 'system'
            : 'unknown'
    total += await strTokenCounter(role)
    total += await strTokenCounter(m.content)
  }
  return total
}

// ===============================================
// POST API: ส่งข้อความและรับการตอบกลับแบบ Stream
// ===============================================
export async function POST(req: NextRequest) {
  try {
    const { messages, sessionId, userId }: {
      messages: UIMessage[]
      sessionId?: string
      userId?: string
    } = await req.json()

    const mapUIMessagesToLangChainMessages = (messages: UIMessage[]): BaseMessage[] => {
      return messages.map(msg => {
        const content = msg.parts?.find(p => p.type === 'text')?.text ?? '';
        if (msg.role === 'user') {
          return new HumanMessage(content);
        } else if (msg.role === 'assistant') {
          return new AIMessage(content);
        }
        // สามารถเพิ่มเงื่อนไขสำหรับ role อื่นๆ ได้ตามต้องการ
        return new HumanMessage(content); // fallback
      });
    };

    const isNewSession = !sessionId;
    let currentSessionId = sessionId;

    // ===============================================
    // Step 1: Hybrid Session Management
    // ===============================================
    if (isNewSession) {
      if (!userId) throw new Error('User ID is required for new sessions');
      currentSessionId = await createNewSession(userId, messages);
    }

    if (!currentSessionId) {
      throw new Error("Failed to create or identify session ID");
    }

    // ===============================================
    // Step 2: ดึงข้อมูลที่จำเป็นล่วงหน้า
    // ===============================================
    let persistedSummary = '';
    let fullHistory: BaseMessage[] = [];

    const [summaryResult, historyResult] = await Promise.all([
      pool.query('SELECT summary FROM chat_sessions WHERE id = $1 LIMIT 1', [currentSessionId]),
      new PostgresChatMessageHistory({ sessionId: currentSessionId, tableName: 'chat_messages', pool }).getMessages()
    ]);
    persistedSummary = summaryResult.rows?.[0]?.summary ?? '';
    const dbHistory = historyResult;

    // สำหรับ session ใหม่: ใช้แค่ messages จาก client
    // สำหรับ session เก่า: ใช้ประวัติจากฐานข้อมูล + ข้อความใหม่ล่าสุด
    if (isNewSession) {
      fullHistory = mapUIMessagesToLangChainMessages(messages);
    } else {
      // รวมประวัติจากฐานข้อมูลกับข้อความใหม่จาก client (แค่ข้อความล่าสุด)
      const newMessages = mapUIMessagesToLangChainMessages(messages);
      const latestUserMessage = newMessages.filter(m => m instanceof HumanMessage).pop();

      if (latestUserMessage) {
        fullHistory = [...dbHistory, latestUserMessage];
      } else {
        fullHistory = dbHistory;
      }
    }

    // ===============================================
    // Step 3: ตั้งค่า AI Model และดึง Input จาก User
    // ===============================================
    const model = new ChatOpenAI({
      model: process.env.OPENAI_MODEL || 'gpt-4o-mini',
      temperature: 0.7,
      maxTokens: 5000,
      streaming: true
    });

    // ดึงข้อความล่าสุดของผู้ใช้ออกมาเป็น input และนำข้อความที่เหลือไปเป็น history
    const lastUserMessage = fullHistory.filter(m => m instanceof HumanMessage).pop();
    const input = lastUserMessage?.content.toString() ?? '';
    if (!input) return new Response('No valid user input found.', { status: 400 });

    // นำข้อความสุดท้ายที่ใช้เป็น input ออกจาก fullHistory (ตรวจสอบ undefined ก่อน)
    const historyWithoutLastInput = lastUserMessage
      ? fullHistory.slice(0, fullHistory.lastIndexOf(lastUserMessage))
      : fullHistory;

    // ===============================================
    // Step 4: Trim ประวัติแชท
    // ===============================================
    const recentWindow = historyWithoutLastInput.length > 0
      ? await trimMessages(historyWithoutLastInput, { maxTokens: 1500, strategy: 'last', tokenCounter: tiktokenCounter })
      : [];

    // ===============================================
    // Step 5: สร้าง Prompt และ Chain
    // ===============================================
    const prompt = ChatPromptTemplate.fromMessages([
      ['system', 'คุณคือผู้ช่วยที่ตอบชัดเจน และตอบเป็นภาษาไทยเมื่อผู้ใช้ถามเป็นไทย'],
      ['system', 'สรุปย่อบริบทก่อนหน้า (สั้นที่สุด): {summary}'],
      new MessagesPlaceholder('recent_window'),
      ['human', '{input}']
    ]);
    const chain = prompt.pipe(model).pipe(new StringOutputParser());

    // ===============================================
    // Step 6: สร้าง Stream และบันทึกข้อมูล
    // ===============================================
    let assistantText = '';
    const messageHistory = new PostgresChatMessageHistory({
      sessionId: currentSessionId,
      tableName: 'chat_messages',
      pool: pool,
    });

    // ไม่ต้องบันทึก input ล่วงหน้า เพราะ LangChain จะบันทึกให้ตอนจบ
    const stream = await chain.stream({
      input,
      summary: persistedSummary,
      recent_window: recentWindow
    });

    const responseStream = new ReadableStream<string>({
      async start(controller) {
        try {
          for await (const chunk of stream) {
            assistantText += chunk;
            controller.enqueue(chunk);
          }
          controller.close();

          if (assistantText) {
            try {
              // บันทึก User Input และ AI Response ลง DB
              await messageHistory.addMessages([
                new HumanMessage(input),
                new AIMessage(assistantText)
              ]);

              // อัปเดต Summary เสมอ - ใช้ประวัติทั้งหมดจากฐานข้อมูล
              const allHistoryForSummary = [
                ...dbHistory.map(m => formatMessageForSummary(m)),
                `ผู้ใช้: ${input}`,
                `ผู้ช่วย: ${assistantText}`
              ].join('\n');

              await updateSessionSummary(currentSessionId!, persistedSummary, allHistoryForSummary);

            } catch (bgError) {
              console.error("❌ Background task error:", bgError);
            }
          }
        } catch (error) {
          console.error("❌ Stream error:", error);
          controller.error(error);
        }
      }
    });

    return createUIMessageStreamResponse({
      stream: toUIMessageStream(responseStream),
      headers: { 'x-session-id': currentSessionId },
    });

  } catch (error) {
    console.error('API Error:', error);
    return new Response(JSON.stringify({ error: 'An error occurred' }), { status: 500 });
  }
}

// ===============================================
// 🚀 Helper Functions
// ===============================================

async function createNewSession(userId: string, messages: UIMessage[]): Promise<string> {
  const client = await pool.connect();
  try {
    const firstMessage = messages.find(m => m.role === 'user');
    let title = 'New Chat';
    if (firstMessage?.parts?.[0]?.type === 'text') {
      title = firstMessage.parts[0].text.slice(0, 50);
    }
    const sessionResult = await client.query(
      'INSERT INTO chat_sessions (title, user_id) VALUES ($1, $2) RETURNING id',
      [title, userId]
    );
    const permanentSessionId = sessionResult.rows[0].id;
    // console.log(`✅ New session created with permanent ID: ${permanentSessionId}`);
    return permanentSessionId;
  } catch (error) {
    console.error("❌ Error in createNewSession:", error);
    throw error;
  } finally {
    client.release();
  }
}

async function updateSessionSummary(sessionId: string, oldSummary: string, allHistory: string) {
  try {
    const model = new ChatOpenAI({ model: process.env.OPENAI_MODEL || 'gpt-4o-mini' });

    // ปรับปรุง: สร้าง summary ใหม่จากประวัติทั้งหมด แทนการอัปเดตเพิ่มเติม
    const summarizerPrompt = ChatPromptTemplate.fromMessages([
      ['system', 'สร้างสรุปสั้นๆ ของการสนทนาทั้งหมด ให้ครอบคลุมหัวข้อหลักและประเด็นสำคัญ ใช้ภาษาไทย กระชับ ไม่เกิน 200 คำ'],
      ['human', 'ประวัติการสนทนาทั้งหมด:\n{history}\n\nช่วยสรุปสาระสำคัญของการสนทนานี้']
    ]);

    const summarizer = summarizerPrompt.pipe(model).pipe(new StringOutputParser());
    const updatedSummary = await summarizer.invoke({
      history: allHistory,
    });

    await pool.query(
      'UPDATE chat_sessions SET summary = $1 WHERE id = $2',
      [updatedSummary, sessionId]
    );

    // console.log(`✅ Updated summary for session ${sessionId}: ${updatedSummary.substring(0, 100)}...`);
  } catch (e) {
    console.error(`❌ Failed to update summary for session ${sessionId}:`, e);
  }
}

function formatMessageForSummary(m: BaseMessage): string {
  if (m instanceof HumanMessage) return `ผู้ใช้: ${m.content}`;
  if (m instanceof AIMessage) return `ผู้ช่วย: ${m.content}`;
  return `ระบบ: ${String(m.content)}`;
}

// ===============================================
// GET API: ดึงประวัติการสนทนาจาก Session ID
// ===============================================
/**
 * ฟังก์ชันสำหรับดึงประวัติการสนทนาทั้งหมดของ Session
 * 
 * Flow การทำงาน:
 * 1. ตรวจสอบ Session ID
 * 2. Query ข้อมูลจากฐานข้อมูล
 * 3. แปลงข้อมูลให้อยู่ในรูปแบบที่ UI ต้องการ
 * 4. ส่งข้อมูลกลับ
 */
export async function GET(req: NextRequest) {
  try {
    // ===============================================
    // Step 1: ตรวจสอบ Session ID จาก URL Parameters
    // ===============================================
    const { searchParams } = new URL(req.url)
    const sessionId = searchParams.get('sessionId')
    if (!sessionId) {
      return new Response(
        JSON.stringify({ error: 'Session ID is required' }),
        { status: 400, headers: { 'Content-Type': 'application/json' } }
      )
    }

    // ===============================================
    // Step 2: Query ข้อมูลประวัติการสนทนาจากฐานข้อมูล
    // ===============================================
    const client = await pool.connect()
    try {
      const result = await client.query(
        `SELECT message, message->>'type' as message_type, created_at
         FROM chat_messages 
         WHERE session_id = $1 
         ORDER BY created_at ASC`,
        [sessionId]
      )

      // ===============================================
      // Step 3: แปลงข้อมูลให้อยู่ในรูปแบบที่ UI ต้องการ
      // ===============================================
      const messages = result.rows.map((row, i) => {
        const data = row.message
        let role = 'user'
        if (row.message_type === 'ai') role = 'assistant'
        else if (row.message_type === 'human') role = 'user'
        return {
          id: `history-${i}`,
          role,
          content: data.content || data.text || data.message || '',
          createdAt: row.created_at
        }
      })

      // ===============================================
      // Step 4: ส่งข้อมูลกลับ
      // ===============================================
      return new Response(JSON.stringify({ messages }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      })
    } finally {
      client.release()
    }
  } catch (error) {
    console.error('Error fetching messages:', error)
    return new Response(
      JSON.stringify({
        error: 'Failed to fetch messages',
        details: error instanceof Error ? error.message : 'Unknown error'
      }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    )
  }
}