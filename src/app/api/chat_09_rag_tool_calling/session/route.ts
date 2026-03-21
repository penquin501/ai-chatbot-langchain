/**
 * ===============================================
 * API Route สำหรับจัดการ Chat Sessions
 * ===============================================
 * 
 * ฟีเจอร์หลัก:
 * - ดึงรายการ Chat Sessions ทั้งหมดของ User
 * - สร้าง Chat Session ใหม่
 * - อัปเดต Title ของ Chat Session
 * - ลบ Chat Session และข้อความทั้งหมด
 * - รองรับ Transaction เพื่อความปลอดภัยของข้อมูล
 */

import { NextRequest, NextResponse } from "next/server"
import { Pool } from 'pg'

// ===============================================
// การตั้งค่า Runtime และ Configuration
// ===============================================
/**
 * กำหนดให้ API ทำงานแบบ Dynamic เพื่อรองรับการเชื่อมต่อฐานข้อมูล
 * ไม่ใช้ Edge Runtime เพราะ PostgreSQL ต้องการ Node.js APIs
 */
export const dynamic = 'force-dynamic'

// ===============================================
// การตั้งค่า PostgreSQL Connection Pool
// ===============================================
/**
 * สร้าง Connection Pool สำหรับเชื่อมต่อฐานข้อมูล PostgreSQL
 * ใช้ Pool เพื่อจัดการ Connection ได้อย่างมีประสิทธิภาพ
 * รองรับทั้ง Development และ Production Environment
 */
const pool = new Pool({
    host: process.env.PG_HOST,        // ที่อยู่เซิร์ฟเวอร์ฐานข้อมูล
    port: Number(process.env.PG_PORT), // พอร์ตการเชื่อมต่อ
    user: process.env.PG_USER,        // ชื่อผู้ใช้ฐานข้อมูล
    password: process.env.PG_PASSWORD, // รหัสผ่านฐานข้อมูล
    database: process.env.PG_DATABASE, // ชื่อฐานข้อมูล
    ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false, // การตั้งค่า SSL
})

// ===============================================
// GET API: ดึงรายการ Chat Sessions
// ===============================================
/**
 * ฟังก์ชันสำหรับดึงข้อมูล Chat Sessions
 * 
 * รองรับ 2 โหมด:
 * 1. ดึง Session เดียว (ส่ง sessionId)
 * 2. ดึงรายการ Sessions ทั้งหมดของ User (ส่ง userId)
 * 
 * Parameters:
 * - userId: ID ของผู้ใช้ (จำเป็น)
 * - sessionId: ID ของ Session (ไม่จำเป็น)
 */
export async function GET(req: NextRequest) {
    try {
        // ===============================================
        // Step 1: ดึง Parameters จาก URL
        // ===============================================
        const { searchParams } = new URL(req.url)
        const userId = searchParams.get('userId')       // ID ของผู้ใช้
        const sessionId = searchParams.get('sessionId') // ID ของ Session (ไม่จำเป็น)

        // ===============================================
        // Step 2: เชื่อมต่อฐานข้อมูล
        // ===============================================
        const client = await pool.connect()

        try {
            // ===============================================
            // Step 3: ตรวจสอบว่าต้องการ Session เดียวหรือหลาย Session
            // ===============================================
            if (sessionId) {
                // โหมด: ดึง Session เดียว
                const result = await client.query(`
          SELECT 
            id,                    -- ID ของ Session
            title,                 -- ชื่อ Session
            created_at,            -- วันที่สร้าง
            user_id,               -- ID ของผู้ใช้
            (
              SELECT COUNT(*) 
              FROM chat_messages
              WHERE session_id = chat_sessions.id::text
            ) as message_count      -- จำนวนข้อความใน Session
          FROM chat_sessions 
          WHERE id = $1
        `, [sessionId])

                // ตรวจสอบว่าพบ Session หรือไม่
                if (result.rows.length === 0) {
                    return NextResponse.json(
                        { error: "Session not found" },
                        { status: 404 }
                    )
                }

                return NextResponse.json({
                    session: result.rows[0]
                })
            }

            // ===============================================
            // Step 4: โหมดดึงรายการ Sessions ทั้งหมด
            // ===============================================

            // สร้าง Base Query สำหรับดึงรายการ Sessions
            let query = `
        SELECT 
          id,                    -- ID ของ Session
          title,                 -- ชื่อ Session
          created_at,            -- วันที่สร้าง
          user_id,               -- ID ของผู้ใช้
          (
            SELECT COUNT(*) 
            FROM chat_messages
            WHERE session_id = chat_sessions.id::text
          ) as message_count      -- จำนวนข้อความใน Session
        FROM chat_sessions 
      `

            const params: (string | number)[] = [] // อาเรย์สำหรับเก็บ Parameters

            // ===============================================
            // Step 5: ตรวจสอบและเพิ่มเงื่อนไข User ID
            // ===============================================
            if (!userId) {
                return Response.json({ error: 'User ID is required' }, { status: 400 })
            }

            query += ` WHERE user_id = $1 `  // เพิ่มเงื่อนไข User ID
            params.push(userId)

            // เรียงลำดับตามวันที่สร้างล่าสุด และจำกัดจำนวน 50 รายการ
            query += ` ORDER BY created_at DESC LIMIT 50`

            // ===============================================
            // Step 6: Execute Query และส่งผลลัพธ์กลับ
            // ===============================================
            const result = await client.query(query, params)

            return NextResponse.json({
                sessions: result.rows
            })
        } finally {
            // ===============================================
            // Step 7: ปิดการเชื่อมต่อฐานข้อมูล
            // ===============================================
            client.release()
        }
    } catch (error) {
        console.error("Error fetching chat sessions:", error)
        return NextResponse.json(
            { error: "Failed to fetch chat sessions" },
            { status: 500 }
        )
    }
}

// ===============================================
// POST API: สร้าง Chat Session ใหม่
// ===============================================
/**
 * ฟังก์ชันสำหรับสร้าง Chat Session ใหม่
 * 
 * Input Parameters:
 * - title: ชื่อของ Session (ไม่จำเป็น, ถ้าไม่ส่งจะใช้ "New Chat")
 * - userId: ID ของผู้ใช้ (จำเป็น)
 * 
 * Output:
 * - session: ข้อมูล Session ที่สร้างใหม่
 */
export async function POST(req: NextRequest) {
    try {
        // ===============================================
        // Step 1: ดึงข้อมูลจาก Request Body
        // ===============================================
        const { title, userId } = await req.json()

        // ===============================================
        // Step 2: ตรวจสอบ User ID (จำเป็น)
        // ===============================================
        if (!userId) {
            return Response.json({ error: 'User ID is required' }, { status: 400 })
        }

        // ===============================================
        // Step 3: เชื่อมต่อฐานข้อมูล
        // ===============================================
        const client = await pool.connect()

        try {
            // ===============================================
            // Step 4: สร้าง Session ใหม่ในฐานข้อมูล
            // ===============================================
            const result = await client.query(`
        INSERT INTO chat_sessions (title, user_id)
        VALUES ($1, $2)
        RETURNING id, title, created_at
      `, [title || 'New Chat', userId]) // ใช้ "New Chat" เป็นค่าเริ่มต้นถ้าไม่มี title

            const newSession = result.rows[0] // ข้อมูล Session ที่สร้างใหม่

            // ===============================================
            // Step 5: ส่งข้อมูล Session ใหม่กลับ
            // ===============================================
            return NextResponse.json({
                session: {
                    id: newSession.id,
                    title: newSession.title,
                    created_at: newSession.created_at,
                    message_count: 0 // Session ใหม่ยังไม่มีข้อความ
                }
            })
        } finally {
            // ===============================================
            // Step 6: ปิดการเชื่อมต่อฐานข้อมูล
            // ===============================================
            client.release()
        }
    } catch (error) {
        console.error("Error creating chat session:", error)
        return NextResponse.json(
            { error: "Failed to create chat session" },
            { status: 500 }
        )
    }
}

// ===============================================
// PUT API: อัปเดต Title ของ Chat Session
// ===============================================
/**
 * ฟังก์ชันสำหรับแก้ไขชื่อของ Chat Session
 * 
 * Input Parameters:
 * - sessionId: ID ของ Session ที่ต้องการแก้ไข (จำเป็น)
 * - title: ชื่อใหม่ของ Session (จำเป็น)
 * 
 * Output:
 * - session: ข้อมูล Session ที่อัปเดตแล้ว
 */
export async function PUT(req: NextRequest) {
    try {
        // ===============================================
        // Step 1: ดึงข้อมูลจาก Request Body
        // ===============================================
        const { sessionId, title } = await req.json()

        // ===============================================
        // Step 2: ตรวจสอบ Parameters ที่จำเป็น
        // ===============================================
        if (!sessionId || !title) {
            return NextResponse.json(
                { error: "Session ID and title are required" },
                { status: 400 }
            )
        }

        // ===============================================
        // Step 3: เชื่อมต่อฐานข้อมูล
        // ===============================================
        const client = await pool.connect()

        try {
            // ===============================================
            // Step 4: อัปเดต Title ในฐานข้อมูล
            // ===============================================
            const result = await client.query(`
        UPDATE chat_sessions 
        SET title = $1 
        WHERE id = $2
        RETURNING id, title, created_at
      `, [title, sessionId])

            // ===============================================
            // Step 5: ตรวจสอบว่าพบ Session หรือไม่
            // ===============================================
            if (result.rows.length === 0) {
                return NextResponse.json(
                    { error: "Session not found" },
                    { status: 404 }
                )
            }

            // ===============================================
            // Step 6: ส่งข้อมูล Session ที่อัปเดตแล้วกลับ
            // ===============================================
            return NextResponse.json({
                session: result.rows[0]
            })
        } finally {
            // ===============================================
            // Step 7: ปิดการเชื่อมต่อฐานข้อมูล
            // ===============================================
            client.release()
        }
    } catch (error) {
        console.error("Error updating chat session:", error)
        return NextResponse.json(
            { error: "Failed to update chat session" },
            { status: 500 }
        )
    }
}

// ===============================================
// DELETE API: ลบ Chat Session และข้อความทั้งหมด
// ===============================================
/**
 * ฟังก์ชันสำหรับลบ Chat Session และข้อความที่เกี่ยวข้องทั้งหมด
 * ใช้ Database Transaction เพื่อความปลอดภัยของข้อมูล
 * 
 * Input Parameters:
 * - sessionId: ID ของ Session ที่ต้องการลบ (ส่งผ่าน URL Parameter)
 * 
 * Output:
 * - message: ข้อความยืนยันการลบ
 * - sessionId: ID ของ Session ที่ถูกลบ
 */
export async function DELETE(req: NextRequest) {
    try {
        // ===============================================
        // Step 1: ดึง Session ID จาก URL Parameters
        // ===============================================
        const { searchParams } = new URL(req.url)
        const sessionId = searchParams.get('sessionId')

        // ===============================================
        // Step 2: ตรวจสอบ Session ID
        // ===============================================
        if (!sessionId) {
            return NextResponse.json(
                { error: "Session ID is required" },
                { status: 400 }
            )
        }

        // ===============================================
        // Step 3: เชื่อมต่อฐานข้อมูล
        // ===============================================
        const client = await pool.connect()

        try {
            // ===============================================
            // Step 4: เริ่มต้น Database Transaction
            // ===============================================
            await client.query('BEGIN')

            // ===============================================
            // Step 5: ลบข้อความทั้งหมดใน Session นี้ก่อน
            // ===============================================
            await client.query(`
        DELETE FROM chat_messages 
        WHERE session_id = $1
      `, [sessionId])

            // ===============================================
            // Step 6: ลบ Chat Session
            // ===============================================
            const result = await client.query(`
        DELETE FROM chat_sessions 
        WHERE id = $1
        RETURNING id
      `, [sessionId])

            // ===============================================
            // Step 7: ตรวจสอบว่าพบ Session หรือไม่
            // ===============================================
            if (result.rows.length === 0) {
                await client.query('ROLLBACK') // ยกเลิก Transaction
                return NextResponse.json(
                    { error: "Session not found" },
                    { status: 404 }
                )
            }

            // ===============================================
            // Step 8: Commit Transaction (บันทึกการเปลี่ยนแปลง)
            // ===============================================
            await client.query('COMMIT')

            // ===============================================
            // Step 9: ส่งข้อความยืนยันการลบกลับ
            // ===============================================
            return NextResponse.json({
                message: "Session deleted successfully",
                sessionId: sessionId
            })
        } catch (error) {
            // ===============================================
            // Step 10: Rollback Transaction หากเกิดข้อผิดพลาด
            // ===============================================
            await client.query('ROLLBACK')
            throw error
        } finally {
            // ===============================================
            // Step 11: ปิดการเชื่อมต่อฐานข้อมูล
            // ===============================================
            client.release()
        }
    } catch (error) {
        console.error("Error deleting chat session:", error)
        return NextResponse.json(
            { error: "Failed to delete chat session" },
            { status: 500 }
        )
    }
}