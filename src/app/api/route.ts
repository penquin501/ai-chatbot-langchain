import { NextResponse } from "next/server"

// http://localhost:3000/api
export async function GET() {
    return NextResponse.json({
        status: "success"
    });
}