/**
 * ===============================================
 * Document Loader, Embedding & PGVector API
 * ===============================================
 * 
 * ฟีเจอร์หลัก:
 * - โหลดและประมวลผลเอกสารจากโฟลเดอร์ data/
 * - แปลงเอกสารเป็น embeddings ด้วย OpenAI
 * - เก็บใน Supabase Vector Store (pgvector)
 * - รองรับไฟล์ .pdf, .txt และ .csv
 * - Text splitting สำหรับ chunk ขนาดเหมาะสม
 * - ป้องกันข้อมูลซ้ำซ้อนด้วยการลบข้อมูลเก่าก่อนโหลดใหม่
 * 
 * API Endpoints:
 * - GET: โหลดเอกสารและสร้าง embeddings (ลบข้อมูลเก่าก่อนโหลดใหม่)
 * - POST: ค้นหาเอกสารที่คล้ายกันด้วย similarity search
 * - PUT: ดูสถิติข้อมูลใน vector store
 * - DELETE: ลบข้อมูลทั้งหมดใน vector store
 */

import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"

// LangChain & AI SDK Imports
import { DirectoryLoader } from "@langchain/classic/document_loaders/fs/directory"
import { TextLoader } from "@langchain/classic/document_loaders/fs/text"
import { CSVLoader } from "@langchain/community/document_loaders/fs/csv"
import { PDFLoader } from "@langchain/community/document_loaders/fs/pdf"
import { RecursiveCharacterTextSplitter } from "@langchain/textsplitters"
import { SupabaseVectorStore } from "@langchain/community/vectorstores/supabase"
import { OpenAIEmbeddings } from "@langchain/openai"
import { CacheBackedEmbeddings } from "@langchain/classic/embeddings/cache_backed"
import { InMemoryStore } from "@langchain/core/stores"

export const dynamic = 'force-dynamic'
export const maxDuration = 60 // เพิ่มเวลาสำหรับการประมวลผล

/**
 * GET API: โหลดเอกสาร สร้าง embeddings และเก็บใน vector ญยstore
 */
export async function GET() {
    try {
        console.log("🔄 เริ่มโหลดเอกสารจากโฟลเดอร์ data/...")

        // ===============================================
        // Step 0: ตรวจสอบและลบข้อมูลเก่า - Clean Existing Data
        // ===============================================
        const supabase = await createClient();

        // ตรวจสอบจำนวนข้อมูลเก่า
        const { count: existingCount } = await supabase
            .from('documents')
            .select('*', { count: 'exact', head: true });

        if (existingCount && existingCount > 0) {
            console.log(`🗑️ พบข้อมูลเก่า ${existingCount} records - ลบข้อมูลเก่าก่อน...`);

            const { error: deleteError } = await supabase
                .from('documents')
                .delete()
                .neq('id', 0); // ลบทุกแถว

            if (deleteError) {
                throw new Error(`ไม่สามารถลบข้อมูลเก่าได้: ${deleteError.message}`);
            }

            console.log(`✅ ลบข้อมูลเก่า ${existingCount} records สำเร็จ`);
        } else {
            console.log("📋 ไม่พบข้อมูลเก่า - เริ่มโหลดเอกสารใหม่");
        }

        // ===============================================
        // Step 1: โหลดเอกสารจากไดเร็กทอรี - Document Loading
        // ===============================================
        const rawDocs = await new DirectoryLoader("./data", {
            ".txt": (path) => new TextLoader(path),
            ".csv": (path) => new CSVLoader(path, {
                column: undefined, // โหลดทุกคอลัมน์
                separator: ",",    // ใช้ comma เป็นตัวแบ่ง
            }),
            ".pdf": (path) => new PDFLoader(path, {
                splitPages: false, // ไม่แยกหน้า ให้เป็น document เดียว
                parsedItemSeparator: "\n" // ใช้ \n เป็นตัวแบ่งระหว่าง parsed items
            }),
        }).load();

        console.log(`📄 โหลดเอกสารสำเร็จ: ${rawDocs.length} ไฟล์`)

        // ===============================================
        // Thai Text Processing สำหรับไฟล์ PDF เท่านั้น - การทำความสะอาดข้อความไทยแบบง่าย
        // ===============================================
        const processedDocs = rawDocs.map(doc => {
            const source = doc.metadata.source || '';
            const isPdfFile = source.toLowerCase().endsWith('.pdf');

            // ใช้การทำความสะอาดข้อความไทยเฉพาะกับไฟล์ PDF
            if (isPdfFile) {
                console.log(`🔧 ทำความสะอาดข้อความภาษาไทยสำหรับ: ${source}`);

                // การทำความสะอาดข้อความไทยแบบง่าย
                let cleanedContent = doc.pageContent;

                // 1. รวมตัวอักษรไทยที่ถูกแยกด้วยช่องว่าง เช่น "แ ล็ ป ท็ อ ป" -> "แล็ปท็อป"
                cleanedContent = cleanedContent.replace(/([ก-๙])\s+([ก-๙])/g, '$1$2');

                // 2. รวมตัวเลขที่ถูกแยกด้วยช่องว่าง เช่น "7 9 9 0 0 1 5" -> "7990015"
                cleanedContent = cleanedContent.replace(/(\d)\s+(\d)/g, '$1$2');

                // 3. รวมตัวอักษรภาษาอังกฤษที่ถูกแยกด้วยช่องว่าง เช่น "C o m p u t e r" -> "Computer"
                cleanedContent = cleanedContent.replace(/([A-Za-z])\s+([A-Za-z])/g, '$1$2');

                // 4. ทำซ้ำอีกครั้งเพื่อจับคำที่ยาวๆ
                for (let i = 0; i < 3; i++) {
                    cleanedContent = cleanedContent.replace(/([ก-๙])\s+([ก-๙])/g, '$1$2');
                    cleanedContent = cleanedContent.replace(/(\d)\s+(\d)/g, '$1$2');
                    cleanedContent = cleanedContent.replace(/([A-Za-z])\s+([A-Za-z])/g, '$1$2');
                }

                // 5. เพิ่มช่องว่างระหว่างคำที่ควรแยก
                // เพิ่มช่องว่างระหว่างตัวเลขกับตัวอักษร
                cleanedContent = cleanedContent.replace(/(\d)([A-Za-zก-๙])/g, '$1 $2');
                cleanedContent = cleanedContent.replace(/([A-Za-zก-๙])(\d)/g, '$1 $2');

                // เพิ่มช่องว่างระหว่างคำภาษาอังกฤษที่ติดกัน (uppercase letters)
                cleanedContent = cleanedContent.replace(/([a-z])([A-Z])/g, '$1 $2');

                // 6. ลบช่องว่างที่ซ้ำซ้อน
                cleanedContent = cleanedContent.replace(/\s+/g, ' ');

                // 7. ลบช่องว่างหน้าและหลังประโยค
                cleanedContent = cleanedContent.trim();

                return {
                    ...doc,
                    pageContent: cleanedContent
                };
            }

            // ไฟล์อื่นๆ ใช้ข้อความต้นฉบับ
            return doc;
        });

        // แสดงตัวอย่างข้อความหลังการแก้ไข
        if (processedDocs.length > 0) {
            const firstDoc = processedDocs[0];
            const preview = firstDoc.pageContent.substring(0, 200);
            const isPdf = (firstDoc.metadata.source || '').toLowerCase().endsWith('.pdf');
            console.log(`📋 ตัวอย่างข้อความ${isPdf ? 'หลังแก้ไข' : ''} (200 ตัวอักษรแรก): ${preview}`);
            console.log(`📁 ไฟล์: ${firstDoc.metadata.source}`);
        }

        if (rawDocs.length === 0) {
            return NextResponse.json({
                error: "ไม่พบเอกสารในโฟลเดอร์ data/",
                message: "กรุณาเพิ่มไฟล์ .txt, .csv หรือ .pdf ในโฟลเดอร์ data/"
            }, { status: 400 })
        }

        // ===============================================
        // Step 2: แยกเอกสารเป็นชิ้นเล็กๆ (Text Splitting) - Chunking
        // ===============================================
        const splitter = new RecursiveCharacterTextSplitter({
            chunkSize: 1000,   // เพิ่มขนาด chunk สำหรับ PDF ที่มีข้อความยาว
            chunkOverlap: 200, // เพิ่ม overlap เพื่อรักษาบริบทของ PDF
            separators: ["\n\n", "\n", ".", "!", "?", ",", " "], // ตัวแบ่งหลายระดับสำหรับ PDF
        });

        const chunks = await splitter.splitDocuments(processedDocs);
        console.log(`✂️ แยกเอกสารเป็น ${chunks.length} ชิ้น`)

        // ===============================================
        // Step 3: เตรียม Embeddings และ Vector Store - Initialization
        // ===============================================
        const baseEmbeddings = new OpenAIEmbeddings({
            model: process.env.OPENAI_EMBEDDING_MODEL_NAME || 'text-embedding-3-small',
            dimensions: 1536 // กำหนดขนาด embedding คือ 1536 หมายถึงจำนวนมิติของเวกเตอร์
        });

        // สร้าง Cache-backed embeddings เพื่อลดต้นทุนและเพิ่มความเร็ว
        const cacheStore = new InMemoryStore();
        const embeddings = CacheBackedEmbeddings.fromBytesStore(
            baseEmbeddings,
            cacheStore,
            {
                namespace: "document_embeddings" // กำหนด namespace สำหรับ cache
            }
        );

        const vectorStore = new SupabaseVectorStore(embeddings, {
            client: supabase,
            tableName: 'documents',
            queryName: 'match_documents' // ชื่อ function ใน Supabase
        });

        // ===============================================
        // Step 4: เพิ่ม metadata ให้กับแต่ละ chunk - Metadata Enrichment
        // ===============================================
        const chunksWithMetadata = chunks.map((chunk, index) => {
            const source = chunk.metadata.source || 'unknown'
            const filename = source.split('/').pop() || source.split('\\').pop() || 'unknown'

            // กำหนด type ตาม file extension
            let fileType = 'text';
            if (filename.endsWith('.csv')) {
                fileType = 'csv';
            } else if (filename.endsWith('.pdf')) {
                fileType = 'pdf';
            } else if (filename.endsWith('.txt')) {
                fileType = 'text';
            }

            return {
                ...chunk,
                metadata: {
                    ...chunk.metadata,
                    filename,
                    chunk_index: index,
                    chunk_size: chunk.pageContent.length,
                    timestamp: new Date().toISOString(),
                    type: fileType
                }
            }
        })

        // ===============================================
        // Step 5: สร้าง embeddings และเก็บใน vector store - Embeddings Creation
        // ===============================================
        console.log("🔮 สร้าง embeddings และเก็บใน vector store...")
        console.log("⚡ ใช้ CacheBackedEmbeddings เพื่อเพิ่มประสิทธิภาพ")

        await vectorStore.addDocuments(chunksWithMetadata);

        console.log("✅ สำเร็จ! เก็บข้อมูลใน vector store แล้ว")

        // ===============================================
        // Step 6: สร้างสถิติสำหรับ response - Statistics Creation
        // ===============================================
        // ตรวจสอบจำนวนข้อมูลใหม่ที่เก็บแล้ว
        const { count: newCount } = await supabase
            .from('documents')
            .select('*', { count: 'exact', head: true });

        const stats = {
            previous_records: existingCount || 0,
            new_records: newCount || 0,
            total_documents: rawDocs.length,
            total_chunks: chunks.length,
            files_processed: [...new Set(chunks.map(c => c.metadata.source))].map(source => {
                const filename = source.split('/').pop() || source.split('\\').pop()
                const fileChunks = chunks.filter(c => c.metadata.source === source)
                return {
                    filename,
                    chunks: fileChunks.length,
                    total_chars: fileChunks.reduce((sum, c) => sum + c.pageContent.length, 0)
                }
            }),
            embedding_model: process.env.OPENAI_EMBEDDING_MODEL_NAME || 'text-embedding-3-small',
            vector_dimensions: 1536,
            timestamp: new Date().toISOString()
        }

        return NextResponse.json({
            message: `สำเร็จ! ${existingCount ? `ลบข้อมูลเก่า ${existingCount} records และ` : ''}สร้างและเก็บ ${chunks.length} chunks จาก ${rawDocs.length} เอกสาร`,
            stats,
            success: true
        })

    } catch (error) {
        console.error('❌ Error ในการประมวลผลเอกสาร:', error)

        return NextResponse.json({
            error: 'เกิดข้อผิดพลาดในการประมวลผลเอกสาร',
            details: error instanceof Error ? error.message : 'Unknown error',
            success: false
        }, { status: 500 })
    }
}

/**
 * POST API: ค้นหาเอกสารที่คล้ายกันใน vector store
 */
export async function POST(req: NextRequest) {
    try {
        const { query, limit = 5 } = await req.json()

        if (!query) {
            return NextResponse.json({
                error: "กรุณาระบุ query สำหรับการค้นหา"
            }, { status: 400 })
        }

        console.log(`🔍 ค้นหา: "${query}"`)
        console.log("⚡ ใช้ CacheBackedEmbeddings สำหรับการค้นหา")

        // ===============================================
        // Setup Vector Store สำหรับการค้นหา
        // ===============================================
        const supabase = await createClient();

        const baseEmbeddings = new OpenAIEmbeddings({
            model: process.env.OPENAI_EMBEDDING_MODEL_NAME || 'text-embedding-3-small',
            dimensions: 1536
        });

        // สร้าง Cache-backed embeddings เพื่อลดต้นทุนในการค้นหา
        const cacheStore = new InMemoryStore();
        const embeddings = CacheBackedEmbeddings.fromBytesStore(
            baseEmbeddings,
            cacheStore,
            {
                namespace: "search_embeddings" // กำหนด namespace แยกสำหรับการค้นหา
            }
        );

        const vectorStore = new SupabaseVectorStore(embeddings, {
            client: supabase,
            tableName: 'documents',
            queryName: 'match_documents'
        });

        // ===============================================
        // ค้นหาเอกสารที่คล้ายกัน
        // ===============================================
        const results = await vectorStore.similaritySearchWithScore(query, limit)

        console.log(`📋 พบผลลัพธ์: ${results.length} รายการ`)

        // ===============================================
        // จัดรูปแบบผลลัพธ์
        // ===============================================
        const formattedResults = results.map(([doc, score], index) => ({
            rank: index + 1,
            content: doc.pageContent,
            metadata: doc.metadata,
            relevance_score: score
        }))

        return NextResponse.json({
            query,
            results_count: results.length,
            results: formattedResults,
            success: true
        })

    } catch (error) {
        console.error('❌ Error ในการค้นหา:', error)

        return NextResponse.json({
            error: 'เกิดข้อผิดพลาดในการค้นหา',
            details: error instanceof Error ? error.message : 'Unknown error',
            success: false
        }, { status: 500 })
    }
}

/**
 * DELETE API: ลบข้อมูลทั้งหมดใน vector store
 */
export async function DELETE() {
    try {
        const supabase = await createClient();

        // ตรวจสอบจำนวนข้อมูลก่อนลบ
        const { count: existingCount } = await supabase
            .from('documents')
            .select('*', { count: 'exact', head: true });

        if (!existingCount || existingCount === 0) {
            return NextResponse.json({
                message: "ไม่พบข้อมูลในฐานข้อมูล - ไม่มีอะไรให้ลบ",
                deleted_records: 0,
                success: true
            })
        }

        console.log(`🗑️ กำลังลบข้อมูล ${existingCount} records...`);

        // ลบข้อมูลทั้งหมดในตาราง documents
        const { error } = await supabase
            .from('documents')
            .delete()
            .neq('id', 0) // ลบทุกแถวที่ id ไม่เท่ากับ 0 (ซึ่งคือทุกแถว)

        if (error) {
            throw new Error(error.message)
        }

        console.log(`✅ ลบข้อมูล ${existingCount} records สำเร็จ`)

        return NextResponse.json({
            message: `ลบข้อมูลใน vector store สำเร็จ - ลบไป ${existingCount} records`,
            deleted_records: existingCount,
            timestamp: new Date().toISOString(),
            success: true
        })

    } catch (error) {
        console.error('❌ Error ในการลบข้อมูล:', error)

        return NextResponse.json({
            error: 'เกิดข้อผิดพลาดในการลบข้อมูล',
            details: error instanceof Error ? error.message : 'Unknown error',
            success: false
        }, { status: 500 })
    }
}

/**
 * PUT API: ดูสถิติข้อมูลใน vector store
 */
export async function PUT() {
    try {
        const supabase = await createClient();

        // ตรวจสอบจำนวนข้อมูลทั้งหมด
        const { count: totalCount } = await supabase
            .from('documents')
            .select('*', { count: 'exact', head: true });

        if (!totalCount || totalCount === 0) {
            return NextResponse.json({
                message: "ไม่พบข้อมูลในฐานข้อมูล",
                stats: {
                    total_records: 0,
                    files_breakdown: [],
                    timestamp: new Date().toISOString()
                },
                success: true
            })
        }

        // ดึงข้อมูล metadata เพื่อสร้างสถิติ
        const { data: documents } = await supabase
            .from('documents')
            .select('metadata')
            .limit(1000); // จำกัดไม่ให้เยอะเกินไป


        // กำหนด interface สำหรับ file stats
        interface FileStats {
            filename: string;
            type: string;
            chunks: number;
            total_chars: number;
        }

        const fileStats = documents?.reduce((acc: Record<string, FileStats>, doc) => {
            const filename = doc.metadata?.filename || 'unknown';
            const type = doc.metadata?.type || 'unknown';

            if (!acc[filename]) {
                acc[filename] = {
                    filename,
                    type,
                    chunks: 0,
                    total_chars: 0
                };
            }

            acc[filename].chunks += 1;
            acc[filename].total_chars += doc.metadata?.chunk_size || 0;

            return acc;
        }, {}) || {};

        const stats = {
            total_records: totalCount,
            files_breakdown: Object.values(fileStats),
            files_count: Object.keys(fileStats).length,
            timestamp: new Date().toISOString()
        };

        console.log(`📊 สถิติข้อมูล: ${totalCount} records จาก ${Object.keys(fileStats).length} ไฟล์`);

        return NextResponse.json({
            message: `พบข้อมูล ${totalCount} records จาก ${Object.keys(fileStats).length} ไฟล์`,
            stats,
            success: true
        })

    } catch (error) {
        console.error('❌ Error ในการดูสถิติข้อมูล:', error)

        return NextResponse.json({
            error: 'เกิดข้อผิดพลาดในการดูสถิติข้อมูล',
            details: error instanceof Error ? error.message : 'Unknown error',
            success: false
        }, { status: 500 })
    }
}