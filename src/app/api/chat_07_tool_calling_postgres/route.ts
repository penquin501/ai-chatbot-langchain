/**
 * ===============================================
 * API Route สำหรับ Chat
 * Manual Tool Calling + Postgres + Streaming + Save DB
 * Fixed version
 * ===============================================
 *
 * จุดที่แก้เพิ่มจากเวอร์ชันก่อน:
 * 1. validate userId ตั้งแต่ต้น request
 * 2. extractTextFromUIMessage รองรับทั้ง message.parts และ message.content
 * 3. เพิ่ม debug log เพื่อเช็ค request body / input
 * 4. คง flow เดิม:
 *    - create/use session
 *    - load summary
 *    - load history
 *    - trim history
 *    - overflow summary
 *    - save user message
 *    - manual tool calling
 *    - stream แบบ text-delta
 *    - save assistant message
 *    - update summary
 */

import { NextRequest } from 'next/server'
import { getDatabase } from '@/lib/database'

import { ChatOpenAI } from '@langchain/openai'
import { ChatPromptTemplate } from '@langchain/core/prompts'
import { PostgresChatMessageHistory } from '@langchain/community/stores/message/postgres'
import {
    BaseMessage,
    AIMessage,
    HumanMessage,
    SystemMessage,
    ToolMessage,
    MessageContent,
} from '@langchain/core/messages'
import { trimMessages } from '@langchain/core/messages'
import { StringOutputParser } from '@langchain/core/output_parsers'
import { encodingForModel } from '@langchain/core/utils/tiktoken'
import { DynamicStructuredTool } from '@langchain/core/tools'

import {
    createUIMessageStream,
    createUIMessageStreamResponse,
    UIMessage,
    generateId,
} from 'ai'

import { z } from 'zod'
import { createClient } from '@supabase/supabase-js'

export const dynamic = 'force-dynamic'
export const maxDuration = 30

const pool = getDatabase()

const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_OR_ANON_KEY!
)

// ===============================================
// Tools
// ===============================================

const getProductInfoTool = new DynamicStructuredTool({
    name: 'get_product_info',
    description:
        'ค้นหาข้อมูลสินค้าจากฐานข้อมูล รวมถึงราคาและจำนวนคงคลัง (stock) โดยรับชื่อสินค้าเป็น input',
    schema: z.object({
        productName: z.string().describe('ชื่อของสินค้าที่ต้องการค้นหา'),
    }),
    func: async ({ productName }) => {
        console.log(`TOOL CALLED: get_product_info with productName="${productName}"`)
        try {
            const { data, error } = await supabase
                .from('products')
                .select('name, price, stock, description')
                .ilike('name', `%${productName}%`)
                .limit(10)

            if (error) {
                console.log('Supabase error:', error.message)
                if (
                    error.message.includes('connection') ||
                    error.message.includes('network') ||
                    error.message.includes('timeout')
                ) {
                    throw new Error('DATABASE_CONNECTION_ERROR')
                }
                throw new Error(error.message)
            }

            if (!data || data.length === 0) {
                return `ไม่พบสินค้าที่ชื่อ '${productName}' ในฐานข้อมูล`
            }

            if (data.length === 1) {
                const product = data[0]
                return `ข้อมูลสินค้า "${product.name}":
- ราคา: ${product.price} บาท
- จำนวนในสต็อก: ${product.stock} ชิ้น
- รายละเอียด: ${product.description}`
            }

            const tableHeader = `| ชื่อสินค้า | ราคา (บาท) | สต็อก (ชิ้น) | รายละเอียด |
|----------|------------|-------------|------------|`

            const tableRows = data
                .map(
                    (product) =>
                        `| ${product.name} | ${Number(product.price).toLocaleString()} | ${product.stock} | ${product.description} |`
                )
                .join('\n')

            return `พบสินค้าที่ตรงกับคำค้นหา "${productName}" ทั้งหมด ${data.length} รายการ:

${tableHeader}
${tableRows}`
        } catch (e: unknown) {
            const errorMessage = e instanceof Error ? e.message : String(e)

            if (
                errorMessage === 'DATABASE_CONNECTION_ERROR' ||
                errorMessage.includes('connection') ||
                errorMessage.includes('network') ||
                errorMessage.includes('timeout')
            ) {
                throw new Error('DATABASE_CONNECTION_ERROR')
            }

            return `เกิดข้อผิดพลาดในการดึงข้อมูลสินค้า: ${errorMessage}`
        }
    },
})

const getSalesDataTool = new DynamicStructuredTool({
    name: 'get_sales_data',
    description: 'ใช้ tool นี้เพื่อดูประวัติการขายของสินค้า. รับ input เป็นชื่อสินค้า.',
    schema: z.object({
        productName: z.string().describe('ชื่อของสินค้าที่ต้องการดูข้อมูลการขาย'),
    }),
    func: async ({ productName }) => {
        console.log(`TOOL CALLED: get_sales_data with productName="${productName}"`)
        try {
            const { data: product, error: productError } = await supabase
                .from('products')
                .select('id')
                .ilike('name', `%${productName}%`)
                .single()

            if (productError) {
                if (
                    productError.message.includes('connection') ||
                    productError.message.includes('network') ||
                    productError.message.includes('timeout')
                ) {
                    throw new Error('DATABASE_CONNECTION_ERROR')
                }
                throw new Error(productError.message)
            }

            if (!product) {
                return `ไม่พบสินค้าที่ชื่อ '${productName}'`
            }

            const { data: sales, error: salesError } = await supabase
                .from('sales')
                .select('sale_date, quantity_sold, total_price')
                .eq('product_id', product.id)

            if (salesError) {
                if (
                    salesError.message.includes('connection') ||
                    salesError.message.includes('network') ||
                    salesError.message.includes('timeout')
                ) {
                    throw new Error('DATABASE_CONNECTION_ERROR')
                }
                throw new Error(salesError.message)
            }

            if (!sales || sales.length === 0) {
                return `ยังไม่มีข้อมูลการขายสำหรับสินค้า '${productName}'`
            }

            if (sales.length === 1) {
                const sale = sales[0]
                return `ประวัติการขายของสินค้า "${productName}":
- วันที่ขาย: ${new Date(sale.sale_date).toLocaleDateString('th-TH')}
- จำนวนที่ขาย: ${sale.quantity_sold} ชิ้น
- ยอดขาย: ${Number(sale.total_price).toLocaleString()} บาท`
            }

            const tableHeader = `| วันที่ขาย | จำนวนที่ขาย (ชิ้น) | ยอดขาย (บาท) |
|-----------|-------------------|---------------|`

            const tableRows = sales
                .map(
                    (sale) =>
                        `| ${new Date(sale.sale_date).toLocaleDateString('th-TH')} | ${sale.quantity_sold} | ${Number(sale.total_price).toLocaleString()} |`
                )
                .join('\n')

            const totalQuantity = sales.reduce((sum, sale) => sum + Number(sale.quantity_sold), 0)
            const totalSales = sales.reduce((sum, sale) => sum + Number(sale.total_price), 0)

            return `ประวัติการขายของสินค้า "${productName}" ทั้งหมด ${sales.length} รายการ:

${tableHeader}
${tableRows}

สรุป:
- ขายรวม: ${totalQuantity} ชิ้น
- ยอดขายรวม: ${totalSales.toLocaleString()} บาท`
        } catch (e: unknown) {
            const errorMessage = e instanceof Error ? e.message : String(e)

            if (
                errorMessage === 'DATABASE_CONNECTION_ERROR' ||
                errorMessage.includes('connection') ||
                errorMessage.includes('network') ||
                errorMessage.includes('timeout')
            ) {
                throw new Error('DATABASE_CONNECTION_ERROR')
            }

            return `เกิดข้อผิดพลาดในการดึงข้อมูลการขาย: ${errorMessage}`
        }
    },
})

const tools = [getProductInfoTool, getSalesDataTool]

// ===============================================
// Token helpers
// ===============================================

type Encoding = {
    encode: (text: string) => number[]
    free?: () => void
}

let encPromise: Promise<Encoding> | undefined

async function getEncoder(): Promise<Encoding> {
    if (!encPromise) {
        encPromise = encodingForModel('gpt-4o-mini').catch(() => encodingForModel('gpt-4'))
    }
    return encPromise
}

async function strTokenCounter(content: MessageContent): Promise<number> {
    const enc = await getEncoder()
    if (typeof content === 'string') return enc.encode(content).length
    if (Array.isArray(content)) {
        return enc.encode(
            content.map((p) => (p.type === 'text' ? p.text : JSON.stringify(p))).join(' ')
        ).length
    }
    return enc.encode(String(content ?? '')).length
}

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
// Helper functions
// ===============================================

function extractTextFromUIMessage(message: UIMessage | undefined): string {
    if (!message) return ''

    if (Array.isArray(message.parts)) {
        const textPart = message.parts.find((p) => p.type === 'text')
        if (textPart && typeof textPart.text === 'string') {
            return textPart.text
        }
    }

    const anyMessage = message as UIMessage & { content?: unknown }
    if (typeof anyMessage.content === 'string') {
        return anyMessage.content
    }

    return ''
}

function messageContentToString(content: unknown): string {
    if (typeof content === 'string') return content

    if (Array.isArray(content)) {
        return content
            .map((part) => {
                if (!part) return ''
                if (typeof part === 'string') return part
                if (typeof part === 'object' && 'text' in part && typeof part.text === 'string') {
                    return part.text
                }
                return ''
            })
            .join('')
    }

    if (content == null) return ''

    try {
        return String(content)
    } catch {
        return ''
    }
}

function buildSystemPrompt(summaryForThisTurn: string): string {
    return `คุณคือผู้ช่วย AI อัจฉริยะที่ตอบเป็นภาษาไทย

คุณมี tools ที่สามารถใช้ค้นหาข้อมูลสินค้าและการขายได้ ได้แก่:
1. get_product_info - สำหรับค้นหาข้อมูลสินค้า ราคา และจำนวนในสต็อก
2. get_sales_data - สำหรับดูประวัติการขาย

เมื่อผู้ใช้ถามเกี่ยวกับสินค้าใดๆ ให้ใช้ tool ที่เหมาะสมเพื่อค้นหาข้อมูลจากฐานข้อมูลก่อนตอบ
ห้ามเดาหรือสร้างข้อมูลขึ้นมาเอง ให้ใช้ข้อมูลจาก tool เท่านั้น

สำหรับการค้นหาสินค้า:
- หากผู้ใช้ใช้คำที่อาจมีความหมายคล้าย ให้ลองค้นหาด้วยคำที่เกี่ยวข้อง
- เช่น "เมาส์" ลองค้นหาด้วย "mouse", "gaming mouse", "เมาส์เกม"
- เช่น "แมคบุ๊ค" ลองค้นหาด้วย "MacBook", "Mac"
- เช่น "กาแฟ" ลองค้นหาด้วย "coffee", "espresso"

หากเกิด DATABASE_CONNECTION_ERROR ให้ตอบว่า "ขออภัยครับ ขณะนี้ไม่สามารถเข้าถึงฐานข้อมูลได้ กรุณาลองใหม่อีกครั้งในภายหลัง"
หากมีสินค้าหลายรายการที่ตรงกับคำค้น ให้แสดงรายการทั้งหมดในรูปแบบตาราง Markdown
หากไม่มีข้อมูลสินค้า ให้ตอบว่า "ไม่พบสินค้าที่ชื่อ 'xxx' ในฐานข้อมูล"

บริบทการสนทนาก่อนหน้านี้โดยสรุปคือ:
${summaryForThisTurn || 'ไม่มีประวัติก่อนหน้า'}`
}

async function runToolsFromResponse(aiResponse: AIMessage): Promise<ToolMessage[]> {
    const toolCalls = aiResponse.tool_calls ?? []
    const toolObservations: ToolMessage[] = []

    for (const toolCall of toolCalls) {
        const selectedTool = tools.find((t) => t.name === toolCall.name)
        if (!selectedTool) continue

        try {
            const observation = await selectedTool.invoke(toolCall.args as never)
            toolObservations.push(
                new ToolMessage({
                    content:
                        typeof observation === 'string' ? observation : JSON.stringify(observation),
                    tool_call_id: toolCall.id!,
                })
            )
        } catch (e) {
            const errorMessage = e instanceof Error ? e.message : String(e)
            const friendlyMessage =
                errorMessage === 'DATABASE_CONNECTION_ERROR'
                    ? 'ขออภัยครับ ขณะนี้ไม่สามารถเข้าถึงฐานข้อมูลได้ กรุณาลองใหม่อีกครั้งในภายหลัง'
                    : `เกิดข้อผิดพลาดในการเรียกใช้เครื่องมือ: ${errorMessage}`

            toolObservations.push(
                new ToolMessage({
                    content: friendlyMessage,
                    tool_call_id: toolCall.id!,
                })
            )
        }
    }

    return toolObservations
}

async function updateSessionSummary(params: {
    currentSessionId: string
    persistedSummary: string
    overflowSummary: string
    input: string
    assistantText: string
    model: ChatOpenAI
}) {
    const { currentSessionId, persistedSummary, overflowSummary, input, assistantText, model } =
        params

    const summarizerPrompt = ChatPromptTemplate.fromMessages([
        ['system', 'รวมสาระสำคัญให้สั้นที่สุด ภาษาไทย กระชับ'],
        [
            'human',
            'นี่คือสรุปเดิม:\n{old}\n\nนี่คือข้อความใหม่:\n{delta}\n\nช่วยอัปเดตให้สั้นและครบถ้วน',
        ],
    ])
    const summarizer = summarizerPrompt.pipe(model).pipe(new StringOutputParser())

    const updatedSummary = await summarizer.invoke({
        old: persistedSummary || 'ไม่มีประวัติก่อนหน้า',
        delta: [overflowSummary, `ผู้ใช้: ${input}`, `ผู้ช่วย: ${assistantText}`]
            .filter(Boolean)
            .join('\n'),
    })

    const client = await pool.connect()
    try {
        await client.query('UPDATE chat_sessions SET summary = $1 WHERE id = $2', [
            updatedSummary,
            currentSessionId,
        ])
    } finally {
        client.release()
    }
}

// ===============================================
// POST
// ===============================================

export async function POST(req: NextRequest) {
    try {
        const body = await req.json()
        // console.log('REQUEST BODY =', JSON.stringify(body, null, 2))

        const {
            messages,
            sessionId,
            userId,
        }: {
            messages: UIMessage[]
            sessionId?: string
            userId?: string
        } = body

        if (!userId) {
            return new Response(
                JSON.stringify({
                    error: 'User ID is required',
                    debug: { sessionId, userId },
                }),
                { status: 400, headers: { 'Content-Type': 'application/json' } }
            )
        }

        if (!Array.isArray(messages) || messages.length === 0) {
            return new Response(
                JSON.stringify({
                    error: 'Messages are required',
                    debug: { messagesType: typeof messages },
                }),
                { status: 400, headers: { 'Content-Type': 'application/json' } }
            )
        }

        let currentSessionId = sessionId

        // Step 1: สร้าง session ใหม่ถ้ายังไม่มี
        if (!currentSessionId) {
            const client = await pool.connect()
            try {
                const firstMessage = messages.find((m) => m.role === 'user')
                const firstText = extractTextFromUIMessage(firstMessage)
                const title = firstText
                    ? firstText.slice(0, 50) + (firstText.length > 50 ? '...' : '')
                    : 'New Chat'

                const result = await client.query(
                    'INSERT INTO chat_sessions (title, user_id) VALUES ($1, $2) RETURNING id',
                    [title, userId]
                )
                currentSessionId = result.rows[0].id
            } finally {
                client.release()
            }
        }

        // Step 2: โหลด summary เดิม
        let persistedSummary = ''
        {
            const client = await pool.connect()
            try {
                const result = await client.query(
                    'SELECT summary FROM chat_sessions WHERE id = $1 LIMIT 1',
                    [currentSessionId]
                )
                persistedSummary = result.rows?.[0]?.summary ?? ''
            } finally {
                client.release()
            }
        }

        // Step 3: เตรียม model
        const model = new ChatOpenAI({
            model: process.env.OPENAI_API_MODEL ?? process.env.OPENAI_MODEL_NAME ?? 'gpt-4o-mini',
            temperature: 0.1,
            maxTokens: 1000,
            streaming: true,
        })

        const modelWithTools = model.withConfig({
            tools,
        })

        // Step 4: โหลด history จาก DB
        const messageHistory = new PostgresChatMessageHistory({
            sessionId: currentSessionId!,
            tableName: 'chat_messages',
            pool,
        })

        const fullHistory = await messageHistory.getMessages()

        // Step 5: ดึง input ปัจจุบัน
        const lastUserMessage = messages.filter((m) => m.role === 'user').pop()
        const input = extractTextFromUIMessage(lastUserMessage)

        // console.log('DEBUG =', {
        //     sessionId,
        //     currentSessionId,
        //     userId,
        //     messagesLength: messages.length,
        //     input,
        //     lastUserMessage,
        // })

        if (!input) {
            return new Response(
                JSON.stringify({
                    error: 'No valid user input found.',
                    debug: {
                        lastUserMessage,
                        messages,
                    },
                }),
                { status: 400, headers: { 'Content-Type': 'application/json' } }
            )
        }

        // Step 6: trim history + overflow summary
        let recentWindowWithoutCurrentInput: BaseMessage[] = []
        let overflowSummary = ''

        if (sessionId && fullHistory.length > 0) {
            const trimmedWindow = await trimMessages(fullHistory, {
                maxTokens: 1500,
                strategy: 'last',
                tokenCounter: tiktokenCounter,
            })

            recentWindowWithoutCurrentInput = trimmedWindow.filter((msg) => {
                return !(msg instanceof HumanMessage && msg.content === input)
            })

            const windowSet = new Set(trimmedWindow)
            const overflow = fullHistory.filter((m) => !windowSet.has(m))

            if (overflow.length > 0) {
                const summarizerPrompt = ChatPromptTemplate.fromMessages([
                    ['system', 'สรุปบทสนทนาให้สั้นที่สุด เป็นภาษาไทย เก็บเฉพาะสาระสำคัญ'],
                    ['human', 'สรุปข้อความต่อไปนี้:\n\n{history}'],
                ])
                const summarizer = summarizerPrompt.pipe(model).pipe(new StringOutputParser())

                const historyText = overflow
                    .map((m) => {
                        if (m instanceof HumanMessage) return `ผู้ใช้: ${messageContentToString(m.content)}`
                        if (m instanceof AIMessage) return `ผู้ช่วย: ${messageContentToString(m.content)}`
                        return `ระบบ: ${messageContentToString(m.content)}`
                    })
                    .join('\n')

                try {
                    overflowSummary = await summarizer.invoke({ history: historyText })
                } catch (e) {
                    console.warn('overflow summary failed', e)
                }
            }
        }

        const summaryForThisTurn = [persistedSummary, overflowSummary].filter(Boolean).join('\n')

        // Step 7: สร้าง messages สำหรับ model
        const conversationMessages: BaseMessage[] = [
            new SystemMessage(buildSystemPrompt(summaryForThisTurn)),
            ...recentWindowWithoutCurrentInput,
            new HumanMessage(input),
        ]

        // Step 8: บันทึก user message ลง DB
        let canSaveToDatabase = true
        try {
            await messageHistory.addUserMessage(input)
        } catch (e) {
            console.warn(
                'ไม่สามารถบันทึกข้อความ user ลงฐานข้อมูลได้:',
                e instanceof Error ? e.message : String(e)
            )
            canSaveToDatabase = false
        }

        // Step 9: ให้ model ตัดสินใจก่อนว่าจะเรียก tool ไหม
        const aiResponse = await modelWithTools.invoke(conversationMessages)

        let finalMessagesForModel: BaseMessage[] = conversationMessages

        if (aiResponse.tool_calls && aiResponse.tool_calls.length > 0) {
            const toolObservations = await runToolsFromResponse(aiResponse)
            finalMessagesForModel = [...conversationMessages, aiResponse, ...toolObservations]
        }

        // Step 10: stream final answer จาก model โดยตรง
        const finalStream = await model.stream(finalMessagesForModel)

        // Step 11: custom UIMessageStream
        const responseMessageId = generateId()
        let assistantText = ''

        const stream = createUIMessageStream({
            execute: async ({ writer }) => {
                writer.write({
                    type: 'text-start',
                    id: responseMessageId,
                })

                try {
                    for await (const chunk of finalStream) {
                        const text = messageContentToString(chunk.content)
                        if (!text) continue

                        assistantText += text

                        writer.write({
                            type: 'text-delta',
                            id: responseMessageId,
                            delta: text,
                        })
                    }

                    writer.write({
                        type: 'text-end',
                        id: responseMessageId,
                    })

                    if (assistantText && canSaveToDatabase) {
                        try {
                            await messageHistory.addMessage(new AIMessage(assistantText))

                            await updateSessionSummary({
                                currentSessionId: currentSessionId!,
                                persistedSummary,
                                overflowSummary,
                                input,
                                assistantText,
                                model,
                            })
                        } catch (e) {
                            console.warn('save assistant / update summary failed', e)
                        }
                    }
                } catch (error) {
                    console.error('stream execute error', error)
                    throw error
                }
            },
        })

        return createUIMessageStreamResponse({
            stream,
            headers: currentSessionId ? { 'x-session-id': currentSessionId } : undefined,
        })
    } catch (error) {
        console.error('API Error:', error)
        return new Response(
            JSON.stringify({
                error: 'An error occurred while processing your request',
                details: error instanceof Error ? error.message : 'Unknown error',
            }),
            { status: 500, headers: { 'Content-Type': 'application/json' } }
        )
    }
}

// ===============================================
// GET
// ===============================================

export async function GET(req: NextRequest) {
    try {
        const { searchParams } = new URL(req.url)
        const sessionId = searchParams.get('sessionId')

        if (!sessionId) {
            return new Response(JSON.stringify({ error: 'Session ID is required' }), {
                status: 400,
                headers: { 'Content-Type': 'application/json' },
            })
        }

        const client = await pool.connect()
        try {
            const result = await client.query(
                `SELECT message, message->>'type' as message_type, created_at
         FROM chat_messages
         WHERE session_id = $1
         ORDER BY created_at ASC`,
                [sessionId]
            )

            const messages = result.rows.map((row, i) => {
                const data = row.message
                let role = 'user'
                if (row.message_type === 'ai') role = 'assistant'
                else if (row.message_type === 'human') role = 'user'

                return {
                    id: `history-${i}`,
                    role,
                    content: data.content || data.text || data.message || '',
                    createdAt: row.created_at,
                }
            })

            return new Response(JSON.stringify({ messages }), {
                status: 200,
                headers: { 'Content-Type': 'application/json' },
            })
        } finally {
            client.release()
        }
    } catch (error) {
        console.error('Error fetching messages:', error)
        return new Response(
            JSON.stringify({
                error: 'Failed to fetch messages',
                details: error instanceof Error ? error.message : 'Unknown error',
            }),
            { status: 500, headers: { 'Content-Type': 'application/json' } }
        )
    }
}
