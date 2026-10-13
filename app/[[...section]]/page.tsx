import Workspace from "@/components/workspace";
import { getOwnerSession } from "@/server/auth/principal";
import { redirect } from "next/navigation";

export const dynamic = "force-dynamic";
export default async function Page() {
  let session;
  try {
    session = await getOwnerSession();
  } catch {
    return (
      <main className="login-page">
        <section className="login-card">
          <h1>فضای شما در حال اتصال است.</h1>
          <p>
            سرویس ورود یا دیتابیس هنوز پیکربندی نشده یا در دسترس نیست. پس از
            تکمیل تنظیمات، این صفحه را تازه کنید.
          </p>
          <p>
            Your workspace is awaiting its secure authentication and database
            connection.
          </p>
        </section>
      </main>
    );
  }
  if (!session) redirect("/login");
  return <Workspace />;
}
