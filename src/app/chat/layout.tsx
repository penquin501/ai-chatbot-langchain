import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";

export default async function ChatLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const supabase = await createClient();

  const { data, error } = await supabase.auth.getUser();
  if (error || !data?.user) {
    redirect("/auth/login");
  }

  return <div className="flex flex-col h-screen">{children}</div>;
}
