/**
 * ============================================================================
 * LOGOUT BUTTON COMPONENT - ปุ่ม Logout สำหรับออกจากระบบ
 * ============================================================================
 *
 * Component นี้ใช้สำหรับ:
 * - แสดงปุ่ม logout พร้อม icon และ styling
 * - จัดการกระบวนการ logout ผ่าน Supabase
 * - เคลียร์ localStorage และ navigate ไปหน้า login
 *
 * Features:
 * - Logout ผ่าน Supabase auth
 * - เคลียร์ session data จาก localStorage
 * - Redirect ไปหน้า login หลัง logout
 * - Responsive design และ hover effects
 */

"use client";

import { createClient } from "@/lib/supabase/client"; // Supabase client
import { Button } from "@/components/ui/button"; // UI Button component
import { useRouter } from "next/navigation"; // Next.js router hook
import { LogOut } from "lucide-react"; // Logout icon

/**
 * LogoutButton Component - ปุ่มสำหรับออกจากระบบ
 *
 * รับผิดชอบ:
 * - แสดงปุ่ม logout พร้อม icon และ text
 * - จัดการกระบวนการ logout เมื่อถูกคลิก
 * - เคลียร์ข้อมูล session และ navigate ไปหน้า login
 */
export function LogoutButton() {
  const router = useRouter(); // Next.js router สำหรับ navigation

  /**
   * ฟังก์ชันจัดการการ logout
   *
   * ขั้นตอนการทำงาน:
   * 1. สร้าง Supabase client
   * 2. เคลียร์ currentSessionId จาก localStorage
   * 3. เรียก signOut จาก Supabase auth
   * 4. Navigate ไปหน้า login
   */
  const logout = async () => {
    const supabase = createClient(); // สร้าง Supabase client

    // เคลียร์ currentSessionId จาก localStorage เพื่อลบข้อมูล session ปัจจุบัน
    localStorage.removeItem("currentSessionId");

    // ออกจากระบบผ่าน Supabase authentication
    await supabase.auth.signOut();

    // นำทางไปยังหน้า login หลังจาก logout สำเร็จ
    router.push("/auth/login");
  };

  // Render ปุ่ม logout พร้อม styling และ event handler
  return (
    <Button
      onClick={logout} // เรียกฟังก์ชัน logout เมื่อคลิก
      variant="ghost" // ใช้ ghost variant (โปร่งใส)
      className="w-full justify-start gap-3 h-12 text-left hover:bg-red-50 hover:text-red-600 dark:hover:bg-red-900/20 dark:hover:text-red-400"
      // Styling: เต็มความกว้าง, จัดซ้าย, ช่องว่างระหว่าง icon กับ text,
      // สูง 12, hover effects สีแดงสำหรับ light/dark mode
    >
      <LogOut className="h-4 w-4" /> {/* Logout icon ขนาด 4x4 */}
      Log out {/* ข้อความปุ่ม */}
    </Button>
  );
}
