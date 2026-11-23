import { redirect } from "next/navigation";
import { auth } from "@/auth";
import { TabBar } from "@/components/tab-bar";

export default async function TabsLayout({ children }: { children: React.ReactNode }) {
  const session = await auth();
  if (!session?.user) redirect("/signin");
  return (
    <div className="mx-auto min-h-dvh max-w-xl px-4 pb-24 pt-6">
      {children}
      <TabBar />
    </div>
  );
}
