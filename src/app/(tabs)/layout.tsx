import { redirect } from "next/navigation";
import { auth } from "@/auth";
import { TabBar } from "@/components/tab-bar";

export default async function TabsLayout({ children }: { children: React.ReactNode }) {
  const session = await auth();
  if (!session?.user) redirect("/signin");
  return (
    <div className="mx-auto flex min-h-dvh max-w-xl flex-col gap-3.5 px-5 pt-[max(1.5rem,env(safe-area-inset-top))] pb-28">
      {children}
      <TabBar />
    </div>
  );
}
