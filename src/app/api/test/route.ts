import { NextRequest, NextResponse } from "next/server"

export async function GET(request: NextRequest) {
    // รับข้อมูลแบบ querystring
    const { searchParams } = new URL(request.url);
    const name = searchParams.get("name") || "World";

    return NextResponse.json({
        message: `Hello, ${name}!`
    });
}

export async function POST(request: NextRequest) {
    const data = await request.json();
    const name = data.name || "World";

    return NextResponse.json({
        message: `Hello, ${name}!`
    });
}
